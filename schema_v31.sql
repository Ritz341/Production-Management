-- ============================================================
-- Migration v31 — run AFTER schema_v30.sql. Safe to re-run.
--
-- Keeps six weeks of history, then clears it out.
--
--   bt_purge_old(p_keep_weeks => 6, p_dry_run => false)
--
-- A pickup week is OLD once its ship date is more than p_keep_weeks
-- weeks ago. In an old week, every order that has been collected or
-- cancelled is deleted (with its statuses, files list, quality history
-- and activity — the same cascade as "Delete permanently"), and the week
-- itself goes once nothing is left in it. Also removed: collected or
-- cancelled orders with no week at all that are that old, and activity
-- alerts older than that.
--
-- Never touched:
--   * an order still open (not collected, not cancelled), however old —
--     it is late work, not history; its week stays with it
--   * a week with no ship date yet, and an empty week that is still ahead
--
-- Returns what it did (or, with p_dry_run, what it WOULD do) as json:
--   { orders, weeks, files: [storage paths], still_open }
-- Each deleted order leaves a line in bt_deletions ("older than N weeks").
--
-- The paperwork PDFs live in Storage, which SQL can't clear. The app asks
-- for a dry run first, removes those files through the Storage API, and
-- only then runs the real delete — so no orphaned files are left behind.
--
-- Admin only. Called by the app once a day when admin opens it.
-- ============================================================

create or replace function bt_purge_old(p_keep_weeks integer default 6, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cutoff     date := current_date - (greatest(p_keep_weeks, 1) * 7);
  v_orders     bigint[];
  v_files      text[];
  v_weeks      bigint[];
  v_open       integer;
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role = 'admin') then
    raise exception 'Only an admin can clear old history';
  end if;

  select coalesce(array_agg(o.id), '{}') into v_orders
  from bt_orders o
  left join bt_build_weeks w on w.id = o.build_week_id
  where (o.actual_pickup_date is not null or o.status = 'cancelled')
    and (
      case
        when w.id is not null then w.ship_date < v_cutoff
        else coalesce(o.actual_pickup_date::date, o.cancelled_at::date, o.created_at::date) < v_cutoff
      end
    );

  select coalesce(array_agg(f.storage_path), '{}') into v_files
  from bt_files f where f.order_id = any (v_orders) and f.storage_path is not null;

  -- Old weeks that will hold nothing once those orders are gone.
  select coalesce(array_agg(w.id), '{}') into v_weeks
  from bt_build_weeks w
  where w.ship_date < v_cutoff
    and not exists (
      select 1 from bt_orders o where o.build_week_id = w.id and not (o.id = any (v_orders))
    );

  select count(*) into v_open
  from bt_orders o join bt_build_weeks w on w.id = o.build_week_id
  where w.ship_date < v_cutoff and o.actual_pickup_date is null and o.status <> 'cancelled';

  if not p_dry_run then
    insert into bt_deletions (order_id, tag_name, dealer, build_week_label, ship_date, removed_by, reason, announced)
    select o.id, o.tag_name, o.dealer, w.label, w.ship_date, auth.uid(),
           'Auto-removed: older than ' || p_keep_weeks || ' weeks', false
    from bt_orders o left join bt_build_weeks w on w.id = o.build_week_id
    where o.id = any (v_orders);

    delete from bt_orders where id = any (v_orders);
    delete from bt_build_weeks where id = any (v_weeks);
    delete from bt_events where created_at < (v_cutoff::timestamptz);
  end if;

  return jsonb_build_object(
    'orders', coalesce(array_length(v_orders, 1), 0),
    'weeks', coalesce(array_length(v_weeks, 1), 0),
    'files', to_jsonb(v_files),
    'still_open', v_open
  );
end $$;

revoke execute on function bt_purge_old(integer, boolean) from public, anon;
grant execute on function bt_purge_old(integer, boolean) to authenticated;

-- Check: a dry run needs an admin login, so from the SQL editor this says so.
-- (In the app: admin → Today runs it once a day.)
select 'installed' as bt_purge_old,
       has_function_privilege('anon', 'bt_purge_old(integer, boolean)', 'execute') as signed_out_can_run;
