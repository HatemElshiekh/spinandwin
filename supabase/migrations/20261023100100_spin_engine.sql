-- ADIPEC 2026 spin and win: prize engine and visitor functions.
-- Internal helpers live in the private spin schema. Visitor entry points are the
-- public.spin_* functions at the end of this file.

-- Helpers ----------------------------------------------------------------------

create function spin.cfg() returns spin.config
language sql stable set search_path = '' as $$
  select * from spin.config where id = 1
$$;

-- Event day number: 1 on the first day of the show, Gulf Standard Time.
create function spin.event_day(c spin.config) returns int
language sql stable set search_path = '' as $$
  select coalesce(c.day_override, ((now() at time zone c.tz)::date - c.event_start) + 1)
$$;

create function spin.event_days(c spin.config) returns int
language sql immutable set search_path = '' as $$
  select (c.event_end - c.event_start) + 1
$$;

create function spin.is_live(c spin.config) returns boolean
language sql stable set search_path = '' as $$
  select not c.paused and spin.event_day(c) between 1 and spin.event_days(c)
$$;

-- Uniform random number in [0, 1) from a cryptographically secure source.
create function spin.rand() returns double precision
language sql volatile set search_path = '' as $$
  select ('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint / 281474976710656.0
$$;

-- Cumulative allocation for a gift on a given event day, including stock added later.
create function spin.allocation(g spin.gifts, p_day int) returns int
language sql stable set search_path = '' as $$
  select case when p_day < 1 then 0 else
    least(g.daily_allocation * p_day, g.total_stock)
    + coalesce((select sum(a.qty)::int from spin.stock_adjustments a
                where a.gift_id = g.id and a.event_day <= p_day), 0)
  end
$$;

-- Live stock per gift. Expired reservations are treated as released here,
-- whether or not their session has been touched since.
create function spin.stock()
returns table (gift_id text, name text, sort_order int, share numeric,
               allocation int, committed int, reserved int, available int)
language sql stable set search_path = '' as $$
  with c as (select * from spin.config where id = 1),
  base as (
    select g.id, g.name, g.sort_order,
           g.chance_weight * g.daily_allocation as share,
           spin.allocation(g, spin.event_day(c)) as allocation,
           (select count(*)::int from spin.entries e where e.gift_id = g.id) as committed,
           (select count(*)::int from spin.sessions s
              where s.reserved_gift_id = g.id and s.reservation_status = 'active'
                and s.reservation_expires_at > now()) as reserved
    from spin.gifts g, c
  )
  select id, name, sort_order, share, allocation, committed, reserved,
         greatest(allocation - committed - reserved, 0)
  from base order by sort_order
$$;

create function spin.log(p_session uuid, p_type text, p_data jsonb default '{}'::jsonb) returns void
language sql volatile set search_path = '' as $$
  insert into spin.events (session_id, type, data) values (p_session, p_type, coalesce(p_data, '{}'::jsonb))
$$;

create function spin.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare
  h json;
begin
  h := nullif(current_setting('request.headers', true), '')::json;
  if h is null then return null; end if;
  return coalesce(h->>'cf-connecting-ip', trim(split_part(h->>'x-forwarded-for', ',', 1)));
exception when others then
  return null;
end $$;

-- Releases the reservation of a session (if still held) and ends the challenge.
create function spin.game_over(p_session uuid, p_reason text) returns void
language plpgsql volatile set search_path = '' as $$
declare
  s spin.sessions;
begin
  select * into s from spin.sessions where id = p_session;
  if s.reservation_status = 'active' then
    perform spin.log(p_session, 'release', jsonb_build_object('gift_id', s.reserved_gift_id, 'reason', p_reason));
  end if;
  update spin.sessions set
    reservation_status = case when reservation_status = 'active' then 'released' else reservation_status end,
    state = 'form_participation', end_reason = p_reason, updated_at = now()
  where id = p_session;
  perform spin.log(p_session, 'game_over', jsonb_build_object('reason', p_reason));
end $$;

-- Applies timeouts and reservation expiry to a locked session. Returns true if changed.
create function spin.apply_deadlines(p_session uuid) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  s spin.sessions;
  q spin.session_questions;
begin
  select * into s from spin.sessions where id = p_session;
  if s.state <> 'questions' then return false; end if;

  select * into q from spin.session_questions
   where session_id = p_session and result is null order by id desc limit 1;
  if found and now() > q.deadline + make_interval(secs => c.grace_seconds) then
    update spin.session_questions set result = 'timeout' where id = q.id;
    perform spin.log(p_session, 'answer', jsonb_build_object('question_id', q.question_id, 'slot', q.slot,
      'attempt', q.attempt, 'result', 'timeout'));
    perform spin.game_over(p_session, 'timeout');
    return true;
  end if;

  if s.reservation_status = 'active' and s.reservation_expires_at < now() then
    perform spin.game_over(p_session, 'expired');
    return true;
  end if;
  return false;
end $$;

-- Issues the next question for a slot. Prefers a wall different from the previous one.
create function spin.issue_question(p_session uuid, p_slot int, p_attempt int, p_delay_ms int)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  v_last_wall text;
  v_qid text;
begin
  select q.wall into v_last_wall
    from spin.session_questions sq join spin.questions q on q.id = sq.question_id
   where sq.session_id = p_session order by sq.id desc limit 1;

  select q.id into v_qid from spin.questions q
   where q.active
     and not exists (select 1 from spin.session_questions sq
                      where sq.session_id = p_session and sq.question_id = q.id)
   order by (q.wall is not distinct from v_last_wall), random()
   limit 1;
  if v_qid is null then
    raise exception 'question bank exhausted';
  end if;

  insert into spin.session_questions (session_id, question_id, slot, attempt, option_order, deadline)
  values (p_session, v_qid, p_slot, p_attempt,
          (select array_agg(x order by random()) from unnest(array['A','B','C','D']) x),
          now() + make_interval(secs => c.timer_seconds + p_delay_ms / 1000.0));
  perform spin.log(p_session, 'question', jsonb_build_object('question_id', v_qid, 'slot', p_slot, 'attempt', p_attempt));
end $$;

-- One draw with the fixed probabilities. Spin 1: "try again" takes try_again_share and the
-- rest is shared between gifts by chance_weight x daily_allocation. Spin 2: no "try again".
-- Stock is not considered here: spin_spin checks the drawn gift's stock afterwards.
create function spin.draw(p_spin_no int, out outcome text, out r double precision)
language plpgsql volatile set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  v_total numeric;
  v_u double precision;
  v_acc numeric := 0;
  g record;
begin
  r := spin.rand();
  if p_spin_no = 1 and r < c.try_again_share then
    outcome := 'try_again';
    return;
  end if;
  select sum(chance_weight * daily_allocation) into v_total from spin.gifts where chance_weight * daily_allocation > 0;
  if coalesce(v_total, 0) = 0 then
    outcome := null;
    return;
  end if;
  v_u := case when p_spin_no = 1 then (r - c.try_again_share) / (1 - c.try_again_share) else r end;
  for g in select id, chance_weight * daily_allocation as share from spin.gifts
            where chance_weight * daily_allocation > 0 order by sort_order loop
    v_acc := v_acc + g.share / v_total;
    outcome := g.id;
    exit when v_u < v_acc;
  end loop;
end $$;

create function spin.new_claim_code() returns text
language sql volatile set search_path = '' as $$
  -- 32 characters without 0, O, 1, I so codes are easy to read aloud. 256 / 32 is exact,
  -- so every character is equally likely.
  select string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (get_byte(b, i) % 32) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(6) as b) r, generate_series(0, 5) i
$$;

-- Everything the visitor app needs to draw the current screen. Never includes answers.
create function spin.state_json(p_session uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  s spin.sessions;
  q spin.session_questions;
  qq spin.questions;
  e spin.entries;
  v_question jsonb;
  v_entry jsonb;
  v_gift jsonb;
  v_available int;
begin
  select * into s from spin.sessions where id = p_session;

  if s.reserved_gift_id is not null then
    select jsonb_build_object('id', g.id, 'name', g.name) into v_gift from spin.gifts g where g.id = s.reserved_gift_id;
  end if;

  if s.state = 'questions' then
    select * into q from spin.session_questions
     where session_id = p_session and result is null order by id desc limit 1;
    if found then
      select * into qq from spin.questions where id = q.question_id;
      v_question := jsonb_build_object(
        'id', qq.id, 'text', qq.question, 'hint', qq.hint, 'slot', q.slot, 'attempt', q.attempt,
        'remaining_ms', greatest(0, floor(extract(epoch from (q.deadline - now())) * 1000))::bigint,
        'options', (select jsonb_agg(jsonb_build_object('id', o.x, 'text',
                       (select el->>'text' from jsonb_array_elements(qq.options) el where el->>'id' = o.x))
                       order by o.n)
                    from unnest(q.option_order) with ordinality o(x, n)));
    end if;
  end if;

  if s.state in ('done_gift', 'done_participation') then
    select * into e from spin.entries where session_id = p_session;
    v_entry := jsonb_build_object('type', e.type, 'claim_code', e.claim_code, 'full_name', e.full_name,
      'gift_name', (select g.name from spin.gifts g where g.id = e.gift_id));
  end if;

  if s.state in ('ready', 'spin_again') then
    select coalesce(sum(st.available), 0) into v_available from spin.stock() st;
  end if;

  return jsonb_build_object(
    'session_id', s.id,
    'state', s.state,
    'spin_count', s.spin_count,
    'last_outcome', s.last_outcome,
    'gift', v_gift,
    'reservation_expires_at', s.reservation_expires_at,
    'slot', s.question_slot,
    'questions_required', c.questions_required,
    'wrong_count', s.wrong_count,
    'max_wrong', c.max_wrong,
    'timer_seconds', c.timer_seconds,
    'question', v_question,
    'end_reason', s.end_reason,
    'entry', v_entry,
    'all_claimed', case when s.state = 'ready' then v_available = 0 else false end,
    'paused', s.state = 'ready' and not spin.is_live(c),
    'demo', c.demo_mode,
    'server_time', now());
end $$;

-- Locks a session that belongs to the given device. Returns null if there is none.
create function spin.lock_session(p_session uuid, p_token text) returns spin.sessions
language plpgsql volatile set search_path = '' as $$
declare
  s spin.sessions;
begin
  select * into s from spin.sessions where id = p_session and device_token = p_token for update;
  if not found then return null; end if;
  return s;
end $$;

create function spin.idem_get(p_session uuid, p_action text, p_key text) returns jsonb
language sql stable set search_path = '' as $$
  select response from spin.idem where session_id = p_session and action = p_action and key = p_key
$$;

create function spin.idem_put(p_session uuid, p_action text, p_key text, p_response jsonb) returns jsonb
language sql volatile set search_path = '' as $$
  insert into spin.idem (session_id, action, key, response) values (p_session, p_action, p_key, p_response)
  on conflict do nothing;
  select p_response;
$$;

create function spin.err(p_code text, p_session uuid default null) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'error', p_code,
    'state', case when p_session is null then null else spin.state_json(p_session) end)
$$;

-- Visitor functions --------------------------------------------------------------

-- Creates or resumes the session of a device.
create function public.spin_start(p_device_token text, p_src text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  s spin.sessions;
  v_ip text;
  v_n int;
begin
  if p_device_token is null or length(p_device_token) not between 16 and 100 then
    return spin.err('bad_request');
  end if;

  select * into s from spin.sessions where device_token = p_device_token for update;
  if found then
    perform spin.apply_deadlines(s.id);
    return jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
  end if;

  if not spin.is_live(c) then
    return jsonb_build_object('ok', true, 'state', jsonb_build_object('state', 'paused', 'demo', c.demo_mode));
  end if;

  v_ip := spin.client_ip();
  if v_ip is not null then
    insert into spin.rate_hits (ip, bucket) values (v_ip, date_trunc('minute', now()))
    on conflict (ip, bucket) do update set n = spin.rate_hits.n + 1
    returning n into v_n;
    if v_n > c.rate_limit_per_min then
      return spin.err('rate_limited');
    end if;
    if random() < 0.01 then
      delete from spin.rate_hits where bucket < now() - interval '1 hour';
    end if;
  end if;

  insert into spin.sessions (device_token, src, ip)
  values (p_device_token, left(nullif(trim(p_src), ''), 60), v_ip)
  on conflict (device_token) do nothing
  returning * into s;
  if s.id is null then
    -- The same device opened two tabs at once: return the session the other call created.
    select * into s from spin.sessions where device_token = p_device_token;
    return jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
  end if;
  perform spin.log(s.id, 'session_started', jsonb_build_object('src', s.src));
  return jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
end $$;

-- Draws and, for a gift, reserves one unit. All spins are serialised on the gift rows.
create function public.spin_spin(p_session uuid, p_token text, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  s spin.sessions;
  v_prev jsonb;
  v_spin_no int;
  v_r double precision;
  v_outcome text;
  v_gift_name text;
  v_available int;
  v_total_available int;
  v_snapshot jsonb;
  v_resp jsonb;
begin
  s := spin.lock_session(p_session, p_token);
  if s.id is null then return spin.err('no_session'); end if;
  if p_key is null or length(p_key) > 100 then return spin.err('bad_request', s.id); end if;
  v_prev := spin.idem_get(s.id, 'spin', p_key);
  if v_prev is not null then return v_prev; end if;

  if s.state not in ('ready', 'spin_again') then
    return spin.err('invalid_state', s.id);
  end if;
  if s.state = 'ready' and not spin.is_live(c) then
    return spin.err('paused', s.id);
  end if;

  -- Serialise every spin on the gift rows so two visitors can never take the same last unit.
  perform 1 from spin.gifts order by id for update;

  select coalesce(sum(available), 0), jsonb_object_agg(gift_id, available)
    into v_total_available, v_snapshot
    from spin.stock();

  if s.state = 'ready' and v_total_available = 0 then
    update spin.sessions set state = 'form_participation', end_reason = 'all_claimed', updated_at = now()
     where id = s.id;
    perform spin.log(s.id, 'all_claimed', jsonb_build_object('stock', v_snapshot));
    return spin.idem_put(s.id, 'spin', p_key, jsonb_build_object('ok', true,
      'result', jsonb_build_object('outcome', 'all_claimed'), 'state', spin.state_json(s.id)));
  end if;

  v_spin_no := s.spin_count + 1;
  select d.outcome, d.r into v_outcome, v_r from spin.draw(v_spin_no) d;

  if v_outcome = 'try_again' then
    update spin.sessions set state = 'spin_again', spin_count = v_spin_no, last_outcome = 'try_again',
           updated_at = now() where id = s.id;
  else
    select available into v_available from spin.stock() where gift_id = v_outcome;
    if coalesce(v_available, 0) > 0 then
      update spin.sessions set state = 'questions', spin_count = v_spin_no, last_outcome = v_outcome,
             reserved_gift_id = v_outcome, reservation_status = 'active',
             reservation_expires_at = now() + make_interval(mins => c.hold_minutes),
             question_slot = 1, updated_at = now()
       where id = s.id;
      perform spin.log(s.id, 'reserve', jsonb_build_object('gift_id', v_outcome));
    else
      -- The drawn gift has no stock left today: the visitor goes to the participation gift.
      update spin.sessions set state = 'form_participation', spin_count = v_spin_no, last_outcome = v_outcome,
             end_reason = 'no_stock', updated_at = now()
       where id = s.id;
    end if;
  end if;

  select name into v_gift_name from spin.gifts where id = v_outcome;
  perform spin.log(s.id, 'spin', jsonb_build_object('spin_no', v_spin_no, 'r', v_r, 'outcome', v_outcome,
    'stock', v_snapshot));

  v_resp := jsonb_build_object('ok', true,
    'result', jsonb_build_object('outcome', case when v_outcome = 'try_again' then 'try_again'
                                                 when coalesce(v_available, 0) > 0 then 'gift'
                                                 else 'no_stock' end,
                                 'gift_id', case when v_outcome = 'try_again' then null else v_outcome end,
                                 'gift_name', v_gift_name, 'spin_no', v_spin_no),
    'state', spin.state_json(s.id));
  return spin.idem_put(s.id, 'spin', p_key, v_resp);
end $$;

-- Starts the questions after the gift reveal, or returns the question already running.
create function public.spin_question(p_session uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s spin.sessions;
begin
  s := spin.lock_session(p_session, p_token);
  if s.id is null then return spin.err('no_session'); end if;
  perform spin.apply_deadlines(s.id);
  select * into s from spin.sessions where id = s.id;
  if s.state = 'questions' and not exists (
       select 1 from spin.session_questions where session_id = s.id and result is null) then
    perform spin.issue_question(s.id, s.question_slot, 1, 0);
  end if;
  return jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
end $$;

-- Re-reads the state (resume, or confirming a timeout after the countdown ends).
create function public.spin_state(p_session uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s spin.sessions;
begin
  s := spin.lock_session(p_session, p_token);
  if s.id is null then return spin.err('no_session'); end if;
  perform spin.apply_deadlines(s.id);
  return jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
end $$;

create function public.spin_answer(p_session uuid, p_token text, p_question text, p_option text, p_key text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c spin.config := spin.cfg();
  s spin.sessions;
  q spin.session_questions;
  v_prev jsonb;
  v_correct boolean;
  v_verdict text;
  v_resp jsonb;
begin
  s := spin.lock_session(p_session, p_token);
  if s.id is null then return spin.err('no_session'); end if;
  if p_key is null or length(p_key) > 100 then return spin.err('bad_request', s.id); end if;
  v_prev := spin.idem_get(s.id, 'answer', p_key);
  if v_prev is not null then return v_prev; end if;

  perform spin.apply_deadlines(s.id);
  select * into s from spin.sessions where id = s.id;

  if s.state <> 'questions' then
    -- A late answer: the server already ended the game on time out.
    if exists (select 1 from spin.session_questions where session_id = s.id and question_id = p_question
                and result = 'timeout') then
      return spin.idem_put(s.id, 'answer', p_key, jsonb_build_object('ok', true,
        'result', jsonb_build_object('verdict', 'timeout', 'question_id', p_question, 'option_id', p_option),
        'state', spin.state_json(s.id)));
    end if;
    return spin.err('invalid_state', s.id);
  end if;

  select * into q from spin.session_questions
   where session_id = s.id and result is null order by id desc limit 1 for update;
  if not found or q.question_id is distinct from p_question then
    return spin.err('stale_question', s.id);
  end if;
  if p_option is null or p_option not in ('A', 'B', 'C', 'D') then
    return spin.err('bad_request', s.id);
  end if;

  select (correct_option = p_option) into v_correct from spin.questions where id = q.question_id;
  v_verdict := case when v_correct then 'correct' else 'wrong' end;
  update spin.session_questions set result = v_verdict, chosen_option = p_option, answered_at = now()
   where id = q.id;
  perform spin.log(s.id, 'answer', jsonb_build_object('question_id', q.question_id, 'slot', q.slot,
    'attempt', q.attempt, 'option_id', p_option, 'result', v_verdict));

  if v_correct then
    if q.slot >= c.questions_required then
      update spin.sessions set state = 'form_gift', question_slot = q.slot, updated_at = now() where id = s.id;
      perform spin.log(s.id, 'challenge_complete');
    else
      update spin.sessions set question_slot = q.slot + 1, updated_at = now() where id = s.id;
      perform spin.issue_question(s.id, q.slot + 1, 1, c.feedback_ms);
    end if;
  else
    update spin.sessions set wrong_count = wrong_count + 1, updated_at = now() where id = s.id
    returning * into s;
    if q.attempt >= 2 then
      perform spin.game_over(s.id, 'wrong_twice');
    elsif s.wrong_count > c.max_wrong then
      perform spin.game_over(s.id, 'too_many_wrong');
    else
      perform spin.issue_question(s.id, q.slot, 2, c.feedback_ms);
    end if;
  end if;

  v_resp := jsonb_build_object('ok', true,
    'result', jsonb_build_object('verdict', v_verdict, 'question_id', q.question_id, 'option_id', p_option),
    'state', spin.state_json(s.id));
  return spin.idem_put(s.id, 'answer', p_key, v_resp);
end $$;

-- Visitor lands on "all gifts claimed" and chooses to register for the participation gift.
create function public.spin_participate(p_session uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s spin.sessions;
begin
  s := spin.lock_session(p_session, p_token);
  if s.id is null then return spin.err('no_session'); end if;
  if s.state = 'ready' and not exists (select 1 from spin.stock() where available > 0) then
    update spin.sessions set state = 'form_participation', end_reason = 'all_claimed', updated_at = now()
     where id = s.id;
    perform spin.log(s.id, 'all_claimed');
  end if;
  return jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
end $$;

create function public.spin_submit(p_session uuid, p_token text, p_payload jsonb, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s spin.sessions;
  v_prev jsonb;
  v_name text := trim(coalesce(p_payload->>'full_name', ''));
  v_company text := trim(coalesce(p_payload->>'company', ''));
  v_job text := nullif(trim(coalesce(p_payload->>'job_title', '')), '');
  v_email text := trim(coalesce(p_payload->>'email', ''));
  v_phone text := regexp_replace(coalesce(p_payload->>'phone', ''), '[\s\-().]', '', 'g');
  v_res text := trim(coalesce(p_payload->>'residence', ''));
  v_consent boolean := coalesce((p_payload->>'consent_contact')::boolean, false);
  v_marketing boolean := coalesce((p_payload->>'consent_marketing')::boolean, false);
  v_errors jsonb := '{}'::jsonb;
  v_email_norm text;
  v_type text;
  v_gift text;
  v_code text;
  v_constraint text;
  v_tries int := 0;
  v_resp jsonb;
begin
  s := spin.lock_session(p_session, p_token);
  if s.id is null then return spin.err('no_session'); end if;
  if p_key is null or length(p_key) > 100 then return spin.err('bad_request', s.id); end if;
  v_prev := spin.idem_get(s.id, 'submit', p_key);
  if v_prev is not null then return v_prev; end if;

  if s.state not in ('form_gift', 'form_participation') then
    return spin.err('invalid_state', s.id);
  end if;

  if v_phone like '00%' then v_phone := '+' || substr(v_phone, 3); end if;
  v_email_norm := lower(v_email);

  if length(v_name) not between 2 and 120 then v_errors := v_errors || '{"full_name":"required"}'; end if;
  if length(v_company) not between 1 and 120 then v_errors := v_errors || '{"company":"required"}'; end if;
  if length(coalesce(v_job, '')) > 120 then v_errors := v_errors || '{"job_title":"too_long"}'; end if;
  if length(v_email) > 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then
    v_errors := v_errors || '{"email":"invalid"}';
  end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then v_errors := v_errors || '{"phone":"invalid"}'; end if;
  if length(v_res) not between 2 and 80 then v_errors := v_errors || '{"residence":"required"}'; end if;
  if not v_consent then v_errors := v_errors || '{"consent_contact":"required"}'; end if;
  if v_errors <> '{}'::jsonb then
    return jsonb_build_object('ok', false, 'error', 'invalid', 'fields', v_errors, 'state', spin.state_json(s.id));
  end if;

  if exists (select 1 from spin.entries where email_norm = v_email_norm or phone_norm = v_phone) then
    perform spin.log(s.id, 'already_played', jsonb_build_object('gift_id', s.reserved_gift_id));
    if s.reservation_status = 'active' then
      perform spin.log(s.id, 'release', jsonb_build_object('gift_id', s.reserved_gift_id, 'reason', 'duplicate'));
    end if;
    update spin.sessions set state = 'already_played', end_reason = 'duplicate',
           reservation_status = case when reservation_status = 'active' then 'released' else reservation_status end,
           updated_at = now()
     where id = s.id;
    return spin.idem_put(s.id, 'submit', p_key, jsonb_build_object('ok', true, 'state', spin.state_json(s.id)));
  end if;

  v_type := 'participation';
  if s.state = 'form_gift' then
    if s.reservation_status = 'active' and s.reservation_expires_at >= now() then
      v_type := 'gift';
    else
      -- The hold ran out before the form was sent. Keep the gift if a unit is still free.
      perform 1 from spin.gifts order by id for update;
      if exists (select 1 from spin.stock() where gift_id = s.reserved_gift_id and available > 0) then
        v_type := 'gift';
      else
        perform spin.log(s.id, 'release', jsonb_build_object('gift_id', s.reserved_gift_id, 'reason', 'expired'));
        update spin.sessions set end_reason = 'expired' where id = s.id;
      end if;
    end if;
  end if;
  v_gift := case when v_type = 'gift' then s.reserved_gift_id end;

  loop
    v_tries := v_tries + 1;
    v_code := spin.new_claim_code();
    begin
      insert into spin.entries (session_id, type, gift_id, full_name, company, job_title, email, email_norm,
                                phone, phone_norm, residence, consent_contact, consent_marketing, claim_code, src)
      values (s.id, v_type, v_gift, v_name, v_company, v_job, v_email, v_email_norm,
              v_phone, v_phone, v_res, v_consent, v_marketing, v_code, s.src);
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'entries_code_uq' and v_tries < 10 then
        continue;
      end if;
      if v_constraint in ('entries_email_uq', 'entries_phone_uq') then
        -- Same person submitted from another session at the same moment.
        update spin.sessions set state = 'already_played', end_reason = 'duplicate',
               reservation_status = case when reservation_status = 'active' then 'released' else reservation_status end,
               updated_at = now()
         where id = s.id;
        perform spin.log(s.id, 'already_played', jsonb_build_object('race', true));
        return spin.idem_put(s.id, 'submit', p_key, jsonb_build_object('ok', true, 'state', spin.state_json(s.id)));
      end if;
      raise;
    end;
  end loop;

  update spin.sessions set
    state = case when v_type = 'gift' then 'done_gift' else 'done_participation' end,
    reservation_status = case when v_type = 'gift' then 'committed'
                              when reservation_status = 'active' then 'released'
                              else reservation_status end,
    updated_at = now()
  where id = s.id;
  perform spin.log(s.id, 'commit', jsonb_build_object('type', v_type, 'gift_id', v_gift, 'claim_code', v_code));

  v_resp := jsonb_build_object('ok', true, 'state', spin.state_json(s.id));
  return spin.idem_put(s.id, 'submit', p_key, v_resp);
end $$;

-- Client side errors, for monitoring. Only accepted for a real session.
create function public.spin_log_client_error(p_session uuid, p_token text, p_message text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from spin.sessions where id = p_session and device_token = p_token) then
    perform spin.log(p_session, 'client_error', jsonb_build_object('message', left(coalesce(p_message, ''), 500)));
  end if;
end $$;

-- Access ------------------------------------------------------------------------

revoke execute on all functions in schema spin from public, anon, authenticated;

revoke execute on function public.spin_start(text, text) from public;
revoke execute on function public.spin_spin(uuid, text, text) from public;
revoke execute on function public.spin_question(uuid, text) from public;
revoke execute on function public.spin_state(uuid, text) from public;
revoke execute on function public.spin_answer(uuid, text, text, text, text) from public;
revoke execute on function public.spin_participate(uuid, text) from public;
revoke execute on function public.spin_submit(uuid, text, jsonb, text) from public;
revoke execute on function public.spin_log_client_error(uuid, text, text) from public;

grant execute on function public.spin_start(text, text) to anon, authenticated;
grant execute on function public.spin_spin(uuid, text, text) to anon, authenticated;
grant execute on function public.spin_question(uuid, text) to anon, authenticated;
grant execute on function public.spin_state(uuid, text) to anon, authenticated;
grant execute on function public.spin_answer(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.spin_participate(uuid, text) to anon, authenticated;
grant execute on function public.spin_submit(uuid, text, jsonb, text) to anon, authenticated;
grant execute on function public.spin_log_client_error(uuid, text, text) to anon, authenticated;
