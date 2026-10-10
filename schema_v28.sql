-- ============================================================
-- Migration v28 — run AFTER schema_v27.sql. Safe to re-run.
--
-- check_setup.sql found ten bt_ functions that signed-out visitors could
-- still run (Postgres hands every new function to everyone, and v24 only
-- revoked the ones it listed by name):
--
--   triggers   bt_build_weeks_retitle, bt_log_column_completed,
--              bt_log_column_started, bt_log_picked_up,
--              bt_log_ship_date_changed, bt_order_status_stamp,
--              bt_orders_place_at_bottom, bt_set_updated_at
--   lookups    bt_depts_of_column, bt_dependents_of_column
--
-- Rather than list them again, this takes EXECUTE from signed-out users
-- (and PUBLIC) on EVERY bt_ function that still has it:
--   * trigger functions lose it from signed-in users too — a client never
--     calls them, and triggers fire without that right;
--   * everything else keeps it for signed-in users only.
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn,
           p.prorettype = 'trigger'::regtype as is_trigger
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname like 'bt\_%'
      and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke execute on function %s from public, anon', r.fn);
    if r.is_trigger then
      execute format('revoke execute on function %s from authenticated', r.fn);
    else
      execute format('grant execute on function %s to authenticated', r.fn);
    end if;
  end loop;
end $$;

-- Check: should return no rows.
select p.proname as still_open_to_signed_out_users
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname like 'bt\_%'
  and has_function_privilege('anon', p.oid, 'execute');
