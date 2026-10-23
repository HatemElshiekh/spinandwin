-- ADIPEC 2026 spin and win: question import and the demo tools that do not delete data.

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

-- Access ----------------------------------------------------------------------------

revoke execute on function spin.import_questions(jsonb) from public, anon, authenticated;
revoke execute on function spin.require_demo() from public, anon, authenticated;
revoke execute on function public.spin_demo_settings(int, int) from public;
revoke execute on function public.spin_demo_seed_stock(text, int, int) from public;
grant execute on function public.spin_demo_settings(int, int) to anon, authenticated;
grant execute on function public.spin_demo_seed_stock(text, int, int) to anon, authenticated;
