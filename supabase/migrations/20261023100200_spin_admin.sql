-- ADIPEC 2026 spin and win: representative dashboard, question import and demo tools.

-- Staff check ---------------------------------------------------------------------

create function spin.require_staff(p_manager boolean default false) returns spin.staff
language plpgsql stable set search_path = '' as $$
declare
  st spin.staff;
begin
  select * into st from spin.staff where user_id = auth.uid() and active;
  if not found or (p_manager and st.role <> 'manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return st;
end $$;

create function public.spin_admin_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  st spin.staff;
begin
  select * into st from spin.staff where user_id = auth.uid() and active;
  if not found then return null; end if;
  return jsonb_build_object('name', st.name, 'role', st.role);
end $$;

create function spin.entry_json(e spin.entries) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'claim_code', e.claim_code, 'type', e.type,
    'gift_name', coalesce((select g.name from spin.gifts g where g.id = e.gift_id), 'Participation Gift'),
    'full_name', e.full_name, 'company', e.company, 'committed_at', e.committed_at,
    'collected_at', e.collected_at, 'collected_by_name', e.collected_by_name)
$$;

-- Claim codes ----------------------------------------------------------------------

create function public.spin_admin_lookup(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  e spin.entries;
begin
  perform spin.require_staff();
  select * into e from spin.entries where claim_code = upper(trim(p_code));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'entry', spin.entry_json(e));
end $$;

create function public.spin_admin_redeem(p_code text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st spin.staff := spin.require_staff();
  e spin.entries;
begin
  select * into e from spin.entries where claim_code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if e.collected_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_collected', 'entry', spin.entry_json(e));
  end if;
  update spin.entries set collected_at = now(), collected_by = st.user_id, collected_by_name = st.name
   where id = e.id returning * into e;
  perform spin.log(e.session_id, 'redeem', jsonb_build_object('claim_code', e.claim_code, 'by', st.name));
  return jsonb_build_object('ok', true, 'entry', spin.entry_json(e));
end $$;

-- Overview ---------------------------------------------------------------------------

create function public.spin_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c spin.config := spin.cfg();
begin
  perform spin.require_staff();
  return jsonb_build_object(
    'now', now(),
    'event_day', spin.event_day(c),
    'event_days', spin.event_days(c),
    'live', spin.is_live(c),
    'paused', c.paused,
    'demo', c.demo_mode,
    'timer_seconds', c.timer_seconds,
    'last_event_at', (select max(at) from spin.events),
    'last_error', (select jsonb_build_object('at', at, 'session_id', session_id, 'message', data->>'message')
                     from spin.events where type = 'client_error' order by id desc limit 1),
    'gifts', (select jsonb_agg(jsonb_build_object(
                'id', st.gift_id, 'name', st.name,
                'total', g.total_stock + coalesce((select sum(a.qty) from spin.stock_adjustments a where a.gift_id = g.id), 0),
                'allocation', st.allocation, 'committed', st.committed, 'reserved', st.reserved,
                'collected', (select count(*) from spin.entries e where e.gift_id = g.id and e.collected_at is not null),
                'available', st.available) order by st.sort_order)
              from spin.stock() st join spin.gifts g on g.id = st.gift_id),
    'counters', jsonb_build_object(
      'sessions', (select count(*) from spin.sessions),
      'spins', (select count(*) from spin.events where type = 'spin'),
      'completions', (select count(*) from spin.entries where type = 'gift'),
      'game_overs', (select count(*) from spin.events where type = 'game_over'),
      'participation', (select count(*) from spin.entries where type = 'participation'),
      'already_played', (select count(*) from spin.sessions where state = 'already_played'),
      'collected', (select count(*) from spin.entries where collected_at is not null)));
end $$;

create function public.spin_admin_set_paused(p_paused boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st spin.staff := spin.require_staff();
begin
  update spin.config set paused = coalesce(p_paused, false), updated_at = now() where id = 1;
  perform spin.log(null, case when p_paused then 'paused' else 'resumed' end, jsonb_build_object('by', st.name));
  return jsonb_build_object('ok', true, 'paused', p_paused);
end $$;

-- Adds stock to a gift from today onwards. Stock can only be added, never removed.
create function public.spin_admin_add_stock(p_gift text, p_qty int, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st spin.staff := spin.require_staff(true);
  c spin.config := spin.cfg();
begin
  if not exists (select 1 from spin.gifts where id = p_gift) then
    return jsonb_build_object('ok', false, 'error', 'unknown_gift');
  end if;
  if p_qty is null or p_qty not between 1 and 500 then
    return jsonb_build_object('ok', false, 'error', 'bad_quantity');
  end if;
  perform 1 from spin.gifts order by id for update;
  insert into spin.stock_adjustments (gift_id, event_day, qty, note, created_by)
  values (p_gift, greatest(spin.event_day(c), 1), p_qty, left(p_note, 200), st.user_id);
  perform spin.log(null, 'stock_added', jsonb_build_object('gift_id', p_gift, 'qty', p_qty, 'by', st.name,
    'note', left(p_note, 200)));
  return jsonb_build_object('ok', true);
end $$;

-- Exports (rows as JSON, turned into CSV in the browser) ------------------------------

create function public.spin_admin_export(p_kind text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform spin.require_staff(true);
  if p_kind = 'leads' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'submitted_at_gst', to_char(e.committed_at at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
      'lead_source', 'adipec2026_spin',
      'entry_type', e.type,
      'full_name', e.full_name, 'company', e.company, 'job_title', e.job_title,
      'email', e.email_norm, 'mobile', e.phone_norm, 'residence', e.residence,
      'consent_contact', e.consent_contact, 'consent_marketing', e.consent_marketing,
      'gift', coalesce(g.name, 'Participation Gift'), 'claim_code', e.claim_code,
      'collected', e.collected_at is not null, 'qr_src', e.src) order by e.committed_at)
      from spin.entries e left join spin.gifts g on g.id = e.gift_id), '[]'::jsonb);
  elsif p_kind = 'winners' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'submitted_at_gst', to_char(e.committed_at at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
      'full_name', e.full_name, 'residence', e.residence, 'gift', g.name, 'value_aed', g.value_aed,
      'claim_code', e.claim_code,
      'collected_at_gst', to_char(e.collected_at at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
      'collected_by', e.collected_by_name) order by e.committed_at)
      from spin.entries e join spin.gifts g on g.id = e.gift_id where e.type = 'gift'), '[]'::jsonb);
  elsif p_kind = 'unclaimed' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'submitted_at_gst', to_char(e.committed_at at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
      'full_name', e.full_name, 'residence', e.residence, 'gift', g.name, 'value_aed', g.value_aed,
      'claim_code', e.claim_code) order by e.committed_at)
      from spin.entries e join spin.gifts g on g.id = e.gift_id
      where e.type = 'gift' and e.collected_at is null), '[]'::jsonb);
  end if;
  raise exception 'unknown export %', p_kind;
end $$;

-- Question import (run by the developer with database rights, see README) ------------

create function spin.import_questions(p_rows jsonb) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  r jsonb;
  v_errors text[] := '{}';
  v_ids text[] := '{}';
  v_active int := 0;
  v_opts text[];
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'expected an array of rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if (r->>'id') is null or (r->>'id') !~ '^Q[0-9]{2,3}$' then
      v_errors := v_errors || format('bad question_id %s', r->>'id');
    elsif (r->>'id') = any(v_ids) then
      v_errors := v_errors || format('%s appears twice', r->>'id');
    end if;
    v_ids := v_ids || (r->>'id');
    if coalesce((r->>'active')::boolean, false) then
      v_opts := array[r->>'a', r->>'b', r->>'c', r->>'d'];
      if coalesce(trim(r->>'wall'), '') = '' or coalesce(trim(r->>'question'), '') = ''
         or coalesce(trim(r->>'hint'), '') = '' then
        v_errors := v_errors || format('%s: missing wall, question or hint', r->>'id');
      end if;
      if exists (select 1 from unnest(v_opts) o where coalesce(trim(o), '') = '') then
        v_errors := v_errors || format('%s: every option must be filled', r->>'id');
      elsif (select count(distinct lower(trim(o))) from unnest(v_opts) o) <> 4 then
        v_errors := v_errors || format('%s: duplicate options', r->>'id');
      end if;
      if coalesce(r->>'correct', '') not in ('A', 'B', 'C', 'D') then
        v_errors := v_errors || format('%s: correct_option must be A to D', r->>'id');
      end if;
      if coalesce(r->>'check', '') <> 'OK' then
        v_errors := v_errors || format('%s: check column is not OK', r->>'id');
      end if;
      v_active := v_active + 1;
    end if;
  end loop;
  if array_length(v_errors, 1) > 0 then
    raise exception 'question import rejected: %', array_to_string(v_errors, '; ');
  end if;
  if v_active < 8 then
    raise exception 'question import rejected: at least 8 active questions are needed, found %', v_active;
  end if;

  insert into spin.questions (id, wall, question, options, correct_option, hint, active, updated_at)
  select x->>'id', trim(x->>'wall'), trim(x->>'question'),
         jsonb_build_array(jsonb_build_object('id', 'A', 'text', trim(x->>'a')),
                           jsonb_build_object('id', 'B', 'text', trim(x->>'b')),
                           jsonb_build_object('id', 'C', 'text', trim(x->>'c')),
                           jsonb_build_object('id', 'D', 'text', trim(x->>'d'))),
         x->>'correct', trim(x->>'hint'), true, now()
  from jsonb_array_elements(p_rows) x
  where coalesce((x->>'active')::boolean, false)
  on conflict (id) do update set wall = excluded.wall, question = excluded.question, options = excluded.options,
    correct_option = excluded.correct_option, hint = excluded.hint, active = true, updated_at = now();

  -- Anything not active in the file is switched off. Questions are never deleted.
  update spin.questions set active = false, updated_at = now()
   where active and id not in (select x->>'id' from jsonb_array_elements(p_rows) x
                                where coalesce((x->>'active')::boolean, false));
  perform spin.log(null, 'questions_imported', jsonb_build_object('active', v_active));
  return jsonb_build_object('active', v_active);
end $$;

-- Demo tools. Every one of them refuses to run unless config.demo_mode is on. ----------

create function spin.require_demo() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not (spin.cfg()).demo_mode then
    raise exception 'demo tools are disabled' using errcode = '42501';
  end if;
end $$;

-- Deletes this device's session and entry so the tester can play again.
create function public.spin_demo_reset_session(p_session uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform spin.require_demo();
  delete from spin.sessions where id = p_session and device_token = p_token;
  perform spin.log(null, 'demo_reset_session', jsonb_build_object('session_id', p_session));
  return jsonb_build_object('ok', true);
end $$;

-- p_day: simulated event day (0 = real date). p_timer: seconds per question.
create function public.spin_demo_settings(p_day int default null, p_timer int default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform spin.require_demo();
  update spin.config set
    day_override = case when p_day is null then day_override when p_day = 0 then null else p_day end,
    timer_seconds = coalesce(p_timer, timer_seconds),
    updated_at = now()
  where id = 1;
  perform spin.log(null, 'demo_settings', jsonb_build_object('day', p_day, 'timer', p_timer));
  return jsonb_build_object('ok', true, 'event_day', spin.event_day(spin.cfg()), 'timer_seconds', (spin.cfg()).timer_seconds);
end $$;

-- Sets the stock of one gift, for out of stock and race tests.
create function public.spin_demo_seed_stock(p_gift text, p_total int, p_daily int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform spin.require_demo();
  update spin.gifts set total_stock = greatest(p_total, 0), daily_allocation = greatest(p_daily, 0)
   where id = p_gift;
  perform spin.log(null, 'demo_seed_stock', jsonb_build_object('gift_id', p_gift, 'total', p_total, 'daily', p_daily));
  return jsonb_build_object('ok', true, 'stock', (select jsonb_agg(to_jsonb(s)) from spin.stock() s));
end $$;

-- Restores the locked gift table and removes every test session, entry and stock adjustment.
create function public.spin_demo_reset_all() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform spin.require_demo();
  delete from spin.sessions;
  delete from spin.stock_adjustments;
  delete from spin.rate_hits;
  update spin.gifts g set total_stock = d.total, daily_allocation = d.daily, chance_weight = d.weight
  from (values ('seleo', 20, 5, 1), ('mall', 40, 10, 3), ('entertainment', 40, 10, 3), ('black_kit', 20, 5, 6))
       d(id, total, daily, weight)
  where g.id = d.id;
  update spin.config set day_override = null, timer_seconds = 45, paused = false, updated_at = now() where id = 1;
  perform spin.log(null, 'demo_reset_all');
  return jsonb_build_object('ok', true);
end $$;

-- Access ----------------------------------------------------------------------------

revoke execute on all functions in schema spin from public, anon, authenticated;

revoke execute on function public.spin_admin_me() from public, anon;
revoke execute on function public.spin_admin_lookup(text) from public, anon;
revoke execute on function public.spin_admin_redeem(text) from public, anon;
revoke execute on function public.spin_admin_overview() from public, anon;
revoke execute on function public.spin_admin_set_paused(boolean) from public, anon;
revoke execute on function public.spin_admin_add_stock(text, int, text) from public, anon;
revoke execute on function public.spin_admin_export(text) from public, anon;
grant execute on function public.spin_admin_me() to authenticated;
grant execute on function public.spin_admin_lookup(text) to authenticated;
grant execute on function public.spin_admin_redeem(text) to authenticated;
grant execute on function public.spin_admin_overview() to authenticated;
grant execute on function public.spin_admin_set_paused(boolean) to authenticated;
grant execute on function public.spin_admin_add_stock(text, int, text) to authenticated;
grant execute on function public.spin_admin_export(text) to authenticated;

revoke execute on function public.spin_demo_reset_session(uuid, text) from public;
revoke execute on function public.spin_demo_settings(int, int) from public;
revoke execute on function public.spin_demo_seed_stock(text, int, int) from public;
revoke execute on function public.spin_demo_reset_all() from public;
grant execute on function public.spin_demo_reset_session(uuid, text) to anon, authenticated;
grant execute on function public.spin_demo_settings(int, int) to anon, authenticated;
grant execute on function public.spin_demo_seed_stock(text, int, int) to anon, authenticated;
grant execute on function public.spin_demo_reset_all() to anon, authenticated;
