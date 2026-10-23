-- ADIPEC 2026 spin and win: demo reset tools. They refuse to run unless config.demo_mode is on.

-- Deletes this device's session and entry so the tester can play again.
create function public.spin_demo_reset_session(p_session uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform spin.require_demo();
  delete from spin.sessions where id = p_session and device_token = p_token;
  perform spin.log(null, 'demo_reset_session', jsonb_build_object('session_id', p_session));
  return jsonb_build_object('ok', true);
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

revoke execute on function public.spin_demo_reset_session(uuid, text) from public;
revoke execute on function public.spin_demo_reset_all() from public;
grant execute on function public.spin_demo_reset_session(uuid, text) to anon, authenticated;
grant execute on function public.spin_demo_reset_all() to anon, authenticated;
