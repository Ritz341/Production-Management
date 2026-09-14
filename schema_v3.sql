-- ============================================================
-- Migration v3 — run AFTER schema.sql, seed.sql, schema_v2.sql
-- ============================================================

-- Clean up two bogus "orders" that got imported from banner rows in the
-- sheet ('Current as of 9/3 AM' / 'Current as of 9/10 AM') before the
-- import script knew to treat those as section markers, not real tags.
delete from bt_orders where tag_name in ('Current as of 9/3 AM', 'Current as of 9/10 AM');

-- Per-order pickup tracking: when it's SUPPOSED to go out (admin/sheet-set,
-- can differ order to order even within the same build week) vs when it
-- ACTUALLY went out (set by the shipping login).
alter table bt_orders add column if not exists scheduled_pickup_date date;
alter table bt_orders add column if not exists actual_pickup_date timestamptz;

-- New role for whoever loads the truck.
alter table bt_profiles drop constraint if exists bt_profiles_role_check;
alter table bt_profiles add constraint bt_profiles_role_check check (role in ('admin', 'crew', 'shipping'));

-- Shipping logins need to update pickup status on orders (but nothing else
-- admin-only, like column edits or file uploads).
create policy "shipping update pickup" on bt_orders for update using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'shipping')
);

-- Add a distinct event type for pickups, separate from column completions.
alter table bt_events drop constraint if exists bt_events_event_type_check;
alter table bt_events add constraint bt_events_event_type_check
  check (event_type in ('ship_date_changed', 'column_completed', 'order_picked_up'));

-- Log an event (drives the live banner) whenever an order actually gets picked up.
create or replace function bt_log_picked_up()
returns trigger language plpgsql as $$
begin
  if new.actual_pickup_date is not null and old.actual_pickup_date is null then
    insert into bt_events (order_id, event_type, message)
    values (new.id, 'order_picked_up', new.tag_name || ' picked up by shipping');
  end if;
  return new;
end;
$$;

drop trigger if exists bt_orders_log_picked_up on bt_orders;
create trigger bt_orders_log_picked_up
  after update on bt_orders
  for each row execute function bt_log_picked_up();
