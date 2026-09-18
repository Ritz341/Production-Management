-- ============================================================
-- Migration v12 — run AFTER schema.sql through schema_v11.sql
--
-- Logistics coordinator role: a login that enters new orders one at a
-- time (tag, dealer, pickup week, which departments build it) so they
-- reach the floor as soon as they're confirmed, instead of waiting for
-- the next weekly sheet import.
--
-- Logistics can create and edit orders and attach files (e.g. the order
-- confirmation), and create a build week for a pickup date that doesn't
-- exist yet. It cannot change workflow stages, block/unblock, or touch
-- departments — that stays with the floor and admin.
-- ============================================================

-- 1. The role
alter table bt_profiles drop constraint if exists bt_profiles_role_check;
alter table bt_profiles add constraint bt_profiles_role_check
  check (role in ('admin', 'crew', 'shipping', 'logistics'));

-- 2. Who entered each order (shown on the logistics "added recently" list)
alter table bt_orders add column if not exists created_by uuid default auth.uid();

-- 3. Permissions
create or replace function bt_is_logistics() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'logistics')
$$;

drop policy if exists "logistics insert orders" on bt_orders;
create policy "logistics insert orders" on bt_orders for insert with check (bt_is_logistics());
drop policy if exists "logistics update orders" on bt_orders;
create policy "logistics update orders" on bt_orders for update using (bt_is_logistics());

-- Adding the department rows for a new order. Insert only: logistics
-- says which departments build it, the floor moves the stages.
drop policy if exists "logistics insert status" on bt_order_status;
create policy "logistics insert status" on bt_order_status for insert with check (bt_is_logistics());

drop policy if exists "logistics insert build_weeks" on bt_build_weeks;
create policy "logistics insert build_weeks" on bt_build_weeks for insert with check (bt_is_logistics());

drop policy if exists "logistics write files" on bt_files;
create policy "logistics write files" on bt_files for insert with check (bt_is_logistics());

drop policy if exists "bt-files logistics write" on storage.objects;
create policy "bt-files logistics write"
on storage.objects for insert
to authenticated
with check (bucket_id = 'bt-files' and bt_is_logistics());

-- 4. Tell the floor when logistics adds an order (a toast on every
--    tablet). Only for logistics: the weekly import inserts dozens of
--    orders at once as admin, and announcing each would flood the floor.
alter table bt_events drop constraint if exists bt_events_event_type_check;
alter table bt_events add constraint bt_events_event_type_check
  check (event_type in (
    'ship_date_changed', 'column_completed', 'order_picked_up', 'column_started',
    'order_status_changed', 'order_added'
  ));

create or replace function bt_log_order_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_week text;
begin
  if not bt_is_logistics() then
    return new;
  end if;
  select label into v_week from bt_build_weeks where id = new.build_week_id;
  insert into bt_events (order_id, event_type, message)
  values (new.id, 'order_added', 'New order ' || new.tag_name || coalesce(' — ' || v_week, ''));
  return new;
end $$;

drop trigger if exists bt_orders_log_added on bt_orders;
create trigger bt_orders_log_added
  after insert on bt_orders
  for each row execute function bt_log_order_added();

-- ------------------------------------------------------------
-- Creating the logistics login (after running this file):
--   1. Authentication → Users → Add user, e.g. logistics@sunspace.local
--   2. insert into bt_profiles (user_id, role, display_name)
--      values ('<the new user''s UUID>', 'logistics', 'Logistics');
-- ------------------------------------------------------------
