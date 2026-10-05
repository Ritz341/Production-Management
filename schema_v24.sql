-- ============================================================
-- Migration v24 — run AFTER schema_v23.sql
--
-- Clears the Supabase security-advisor warnings that belong to this app:
--
--   * "Public can execute SECURITY DEFINER function": nobody signed-out
--     has any business calling these. EXECUTE is taken from anon/PUBLIC;
--     signed-in users keep it for the ones the app calls or that policies
--     use (bt_is_admin, bt_move_order, bt_units_done …).
--   * Trigger functions are never called by a client at all, so they lose
--     EXECUTE from everyone (triggers still fire — they don't need it).
--   * "Function search_path mutable": every bt_ function gets a fixed
--     search_path.
--
-- Safe to re-run. Functions that don't exist yet are skipped.
-- ============================================================

do $$
declare
  sig text;
  fn  regprocedure;
begin
  -- called by the app or by RLS policies: signed-in only
  foreach sig in array array[
    'public.bt_build_weeks_carry_orders()',
    'public.bt_can_manage_files()',
    'public.bt_close_sent_back()',
    'public.bt_is_admin()',
    'public.bt_is_logistics()',
    'public.bt_move_order(bigint, text)',
    'public.bt_remove_orders(bigint[], boolean, boolean, text)',
    'public.bt_report_quality(bigint, bigint, text, text, boolean, bigint)',
    'public.bt_resolve_quality(bigint, text)',
    'public.bt_set_order_details(bigint, integer, text, text, text, integer)',
    'public.bt_set_paperwork_ready(bigint[], boolean)',
    'public.bt_units_done(timestamptz, text)'
  ] loop
    fn := to_regprocedure(sig);
    if fn is not null then
      execute format('revoke execute on function %s from public, anon', fn);
      execute format('grant execute on function %s to authenticated', fn);
    end if;
  end loop;

  -- trigger / internal helpers: no client calls these
  foreach sig in array array[
    'public.bt_order_status_cut_rows()',
    'public.bt_order_status_log()',
    'public.bt_orders_log()',
    'public.bt_sync_cut_rows(bigint)',
    'public.bt_events_route()',
    'public.bt_log_order_status_changed()'
  ] loop
    fn := to_regprocedure(sig);
    if fn is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    end if;
  end loop;

  -- fixed search_path on every bt_/touch function that lacks one
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'bt\_%' or p.proname = 'touch_updated_at')
      and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public', fn);
  end loop;
end $$;
