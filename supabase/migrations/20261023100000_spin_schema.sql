-- ADIPEC 2026 spin and win: tables.
-- Every table lives in the private "spin" schema, which is not exposed through the API.
-- Visitors and staff reach the data only through the SECURITY DEFINER functions in
-- public (all prefixed spin_), defined in the following migrations.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists spin;
revoke all on schema spin from public;
revoke all on schema spin from anon, authenticated;

-- Single row of event settings.
create table spin.config (
  id smallint primary key default 1 check (id = 1),
  event_start date not null default date '2026-11-02',
  event_end date not null default date '2026-11-05',
  tz text not null default 'Asia/Dubai',
  timer_seconds int not null default 45 check (timer_seconds between 5 and 300),
  grace_seconds int not null default 2 check (grace_seconds between 0 and 30),
  feedback_ms int not null default 1500 check (feedback_ms between 0 and 10000),
  hold_minutes int not null default 10 check (hold_minutes between 1 and 120),
  questions_required int not null default 4 check (questions_required between 1 and 10),
  max_wrong int not null default 2 check (max_wrong >= 0),
  try_again_share numeric not null default 0.5 check (try_again_share >= 0 and try_again_share < 1),
  rate_limit_per_min int not null default 60 check (rate_limit_per_min > 0),
  paused boolean not null default false,
  demo_mode boolean not null default false,
  day_override int,
  updated_at timestamptz not null default now()
);
insert into spin.config (id) values (1);

-- Gifts. The fixed chance of a gift is chance_weight x daily_allocation, shared out
-- of the non "try again" part of a spin. It does not change with remaining stock.
create table spin.gifts (
  id text primary key,
  name text not null,
  value_aed int not null,
  total_stock int not null check (total_stock >= 0),
  chance_weight numeric not null check (chance_weight >= 0),
  daily_allocation int not null check (daily_allocation >= 0),
  sort_order int not null
);
insert into spin.gifts (id, name, value_aed, total_stock, chance_weight, daily_allocation, sort_order) values
  ('seleo',         'Seleo Machine',         300, 20, 1,  5, 1),
  ('mall',          'Mall Voucher',          150, 40, 3, 10, 2),
  ('entertainment', 'Entertainment Voucher', 150, 40, 3, 10, 3),
  ('black_kit',     'Black Kit',              50, 20, 6,  5, 4);

-- Stock added during the show from the dashboard. Counts from event_day onwards.
create table spin.stock_adjustments (
  id bigint generated always as identity primary key,
  gift_id text not null references spin.gifts(id),
  event_day int not null,
  qty int not null check (qty > 0),
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table spin.questions (
  id text primary key,
  wall text not null,
  question text not null,
  options jsonb not null,            -- [{"id":"A","text":"..."}, ...] exactly four
  correct_option text not null check (correct_option in ('A','B','C','D')),
  hint text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table spin.sessions (
  id uuid primary key default gen_random_uuid(),
  device_token text not null,
  state text not null default 'ready' check (state in (
    'ready', 'spin_again', 'questions', 'form_gift', 'form_participation',
    'done_gift', 'done_participation', 'already_played')),
  spin_count int not null default 0,
  last_outcome text,
  reserved_gift_id text references spin.gifts(id),
  reservation_status text check (reservation_status in ('active', 'released', 'committed')),
  reservation_expires_at timestamptz,
  question_slot int not null default 0,
  wrong_count int not null default 0,
  end_reason text,
  src text,
  ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sessions_device_uq on spin.sessions (device_token);
create index sessions_active_res_idx on spin.sessions (reserved_gift_id) where reservation_status = 'active';

create table spin.session_questions (
  id bigint generated always as identity primary key,
  session_id uuid not null references spin.sessions(id) on delete cascade,
  question_id text not null references spin.questions(id),
  slot int not null,
  attempt int not null check (attempt in (1, 2)),
  option_order text[] not null,
  issued_at timestamptz not null default now(),
  deadline timestamptz not null,
  answered_at timestamptz,
  chosen_option text,
  result text check (result in ('correct', 'wrong', 'timeout')),
  unique (session_id, question_id)
);
create index session_questions_open_idx on spin.session_questions (session_id) where result is null;

create table spin.entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references spin.sessions(id) on delete cascade,
  type text not null check (type in ('gift', 'participation')),
  gift_id text references spin.gifts(id),
  full_name text not null,
  company text not null,
  job_title text,
  email text not null,
  email_norm text not null,
  phone text not null,
  phone_norm text not null,
  residence text not null,
  consent_contact boolean not null check (consent_contact),
  consent_marketing boolean not null default false,
  claim_code text not null,
  src text,
  committed_at timestamptz not null default now(),
  collected_at timestamptz,
  collected_by uuid,
  collected_by_name text,
  constraint entries_gift_ck check ((type = 'gift') = (gift_id is not null)),
  constraint entries_email_uq unique (email_norm),
  constraint entries_phone_uq unique (phone_norm),
  constraint entries_code_uq unique (claim_code)
);
create index entries_gift_idx on spin.entries (gift_id);

-- Append-only audit log.
create table spin.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  session_id uuid,
  type text not null,
  data jsonb not null default '{}'::jsonb
);
create index events_session_idx on spin.events (session_id);
create index events_type_idx on spin.events (type, at);

create function spin.events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'spin.events is append-only';
end $$;
create trigger events_no_change before update or delete on spin.events
  for each row execute function spin.events_append_only();

-- Stored responses so that a retried call with the same key never acts twice.
create table spin.idem (
  session_id uuid not null references spin.sessions(id) on delete cascade,
  action text not null,
  key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, action, key)
);

-- Representatives and managers allowed into the dashboard (Supabase Auth users).
create table spin.staff (
  user_id uuid primary key,
  name text not null,
  role text not null check (role in ('rep', 'manager')),
  active boolean not null default true
);

-- New session counter per IP and minute.
create table spin.rate_hits (
  ip text not null,
  bucket timestamptz not null,
  n int not null default 1,
  primary key (ip, bucket)
);

-- Row Level Security on every table, with no policies: nothing is readable or
-- writable except through the functions.
alter table spin.config enable row level security;
alter table spin.gifts enable row level security;
alter table spin.stock_adjustments enable row level security;
alter table spin.questions enable row level security;
alter table spin.sessions enable row level security;
alter table spin.session_questions enable row level security;
alter table spin.entries enable row level security;
alter table spin.events enable row level security;
alter table spin.idem enable row level security;
alter table spin.staff enable row level security;
alter table spin.rate_hits enable row level security;

revoke all on all tables in schema spin from public, anon, authenticated;
revoke all on all sequences in schema spin from public, anon, authenticated;
