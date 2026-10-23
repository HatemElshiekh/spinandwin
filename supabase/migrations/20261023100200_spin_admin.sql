-- ADIPEC 2026 spin and win: representative dashboard.

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

-- Access ----------------------------------------------------------------------------

revoke execute on function spin.require_staff(boolean) from public, anon, authenticated;
revoke execute on function spin.entry_json(spin.entries) from public, anon, authenticated;
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
