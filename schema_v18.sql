-- ============================================================
-- Migration v18 — run AFTER schema_v17.sql
--
-- Taking several orders off the build in one go, which until now meant
-- opening each one and cancelling it, or a SQL delete.
--
-- Admin picks two things independently:
--
--   Reversible or permanent. Cancelling hides the order from every
--   tablet and keeps it (restorable, with its history). Deleting is
--   forever: bt_order_status, bt_files, bt_activity, bt_quality_issues
--   and bt_events all cascade off bt_orders, so an order's entire
--   record goes with it.
--
--   Quiet or announced. A duplicate row from a bad import should go
--   without a word. An order a crew is part-way through building must
--   not — they need to stop, so it raises the same red banner a ship
--   date change does, and stays until someone acknowledges it.
--
-- Safe to re-run.
-- ============================================================


-- ── 1. The floor alert ─────────────────────────────────────
alter table bt_events drop constraint if exists bt_events_event_type_check;
alter table bt_events add constraint bt_events_event_type_check
  check (event_type in (
    'ship_date_changed', 'column_completed', 'order_picked_up', 'column_started',
    'order_status_changed', 'order_added', 'quality_issue', 'orders_removed'
  ));


-- ── 2. What survives a permanent delete ────────────────────
-- Deliberately no foreign key to bt_orders: the whole point is that
-- this row outlives the order. Without it a bulk delete leaves nothing
-- at all behind — no way to answer "where did that tag go?" a week
-- later, which is exactly when it gets asked.
create table if not exists bt_deletions (
  id                bigint generated always as identity primary key,
  at                timestamptz not null default now(),
  order_id          bigint,
  tag_name          text not null,
  dealer            text,
  build_week_label  text,
  ship_date         date,
  removed_by        uuid references auth.users(id),
  reason            text,
  announced         boolean not null default false
);

alter table bt_deletions enable row level security;
drop policy if exists "admin read deletions" on bt_deletions;
create policy "admin read deletions" on bt_deletions for select using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
-- Written only through bt_remove_orders() below, which is security definer.

create index if not exists bt_deletions_at on bt_deletions (at desc);


-- ── 3. Remove a batch of orders ────────────────────────────
-- One function rather than the app firing a delete and an insert
-- separately, so the record and the alert can't survive a removal that
-- failed, or go missing from one that worked.
create or replace function bt_remove_orders(
  p_order_ids  bigint[],
  p_permanent  boolean default false,
  p_announce   boolean default false,
  p_reason     text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_names   text[];
  v_reason  text := nullif(btrim(p_reason), '');
  v_count   integer;
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role = 'admin') then
    raise exception 'Only an admin can remove orders';
  end if;

  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    return 0;
  end if;

  -- Names are read up front: after a permanent delete there is nothing
  -- left to name the order by.
  select array_agg(tag_name order by tag_name) into v_names
  from bt_orders
  where id = any (p_order_ids)
    and (p_permanent or status <> 'cancelled');  -- cancelling an already-cancelled order is a no-op

  v_count := coalesce(array_length(v_names, 1), 0);
  if v_count = 0 then
    return 0;
  end if;

  -- Written before the delete, or the cascade takes the alert with the
  -- order. order_id stays null on purpose: one row covers the whole
  -- batch, and nothing cascades from it.
  if p_announce then
    insert into bt_events (event_type, message)
    values (
      'orders_removed',
      case
        when v_count = 1 then v_names[1] || ' has been taken off the build'
        else v_count || ' orders have been taken off the build: ' || array_to_string(v_names, ', ')
      end
      || coalesce(' — ' || v_reason, '')
    );
  end if;

  if p_permanent then
    insert into bt_deletions (order_id, tag_name, dealer, build_week_label, ship_date, removed_by, reason, announced)
    select o.id, o.tag_name, o.dealer, w.label, w.ship_date, auth.uid(), v_reason, p_announce
    from bt_orders o
    left join bt_build_weeks w on w.id = o.build_week_id
    where o.id = any (p_order_ids);

    delete from bt_orders where id = any (p_order_ids);
  else
    update bt_orders
    set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
    where id = any (p_order_ids) and status <> 'cancelled';
  end if;

  return v_count;
end $$;
