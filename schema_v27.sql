-- ============================================================
-- Migration v27 — run AFTER schema_v26.sql. Safe to re-run.
--
-- Two trigger functions (bt_build_weeks_carry_orders, bt_close_sent_back)
-- were left executable by signed-in users in v24. A client never calls a
-- trigger function and triggers fire without that right, so it comes off
-- everyone. That clears two of the advisor's "Signed-In Users Can Execute
-- SECURITY DEFINER Function" warnings.
--
-- The other eleven stay on purpose:
--   bt_is_admin, bt_is_logistics, bt_can_manage_files, bt_can_edit_measure
--       — row-level-security policies call them as the signed-in user.
--   bt_move_order, bt_remove_orders, bt_report_quality, bt_resolve_quality,
--   bt_set_order_details, bt_set_paperwork_ready
--       — the app calls them, and each one checks the caller's role in
--         bt_profiles before it changes anything.
--   bt_units_done — read-only totals for the TV board.
-- ============================================================

do $$
declare
  sig text;
  fn  regprocedure;
begin
  foreach sig in array array[
    'public.bt_build_weeks_carry_orders()',
    'public.bt_close_sent_back()'
  ] loop
    fn := to_regprocedure(sig);
    if fn is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    end if;
  end loop;
end $$;

-- Check: these two should now show can_signed_in_run = false.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as can_signed_in_run
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('bt_build_weeks_carry_orders', 'bt_close_sent_back');
