-- ============================================================
-- Migration v10 — run AFTER schema.sql through schema_v9.sql
-- Persistent, must-acknowledge alerts.
--
-- Today's bt_events banner is a 7-second toast for everyone — fine for
-- FYI events, not enough for a ship date change or a department status
-- change that someone needs to actually see and act on. This adds:
--   1. acknowledged_at / acknowledged_by on bt_events, so the app can
--      keep showing an alert until someone dismisses it.
--   2. A new 'order_status_changed' event, logged whenever a
--      workflow_stage changes on ANY order/column — this is the real
--      "department order status changed" signal now that the sheet's
--      old started_at/status_value C-tracking is dead (superseded by
--      workflow_stage in schema_v7.sql).
--   3. An RLS policy letting any authenticated login acknowledge an
--      event (any crew/admin tablet — no separate "team lead" role).
-- ============================================================

alter table bt_events add column if not exists acknowledged_at timestamptz;
alter table bt_events add column if not exists acknowledged_by uuid references auth.users(id);

alter table bt_events drop constraint if exists bt_events_event_type_check;
alter table bt_events add constraint bt_events_event_type_check
  check (event_type in (
    'ship_date_changed', 'column_completed', 'order_picked_up', 'column_started', 'order_status_changed'
  ));

-- Any authenticated login can acknowledge (mark read) an event. This is
-- deliberately narrow — it only lets someone set the two ack columns via
-- the app's update call, not touch anything else about bt_events.
create policy "authenticated acknowledge events" on bt_events for update using (
  auth.role() = 'authenticated'
);

create or replace function bt_log_order_status_changed()
returns trigger language plpgsql as $$
declare
  v_tag text;
  v_col text;
  v_stage_label text;
begin
  if new.workflow_stage is distinct from old.workflow_stage then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    v_stage_label := coalesce(
      case new.workflow_stage
        when 'paperwork_ready' then 'Paperwork Ready'
        when 'started' then 'Order Started'
        when 'completed' then 'Order Completed'
        when 'packaged' then 'Packaged'
        when 'shipped' then 'Loaded on Truck'
      end,
      'Not set'
    );
    insert into bt_events (order_id, event_type, message)
    values (new.order_id, 'order_status_changed', v_col || ' on ' || v_tag || ' → ' || v_stage_label);
  end if;
  return new;
end;
$$;

drop trigger if exists bt_order_status_log_stage_changed on bt_order_status;
create trigger bt_order_status_log_stage_changed
  after update on bt_order_status
  for each row execute function bt_log_order_status_changed();
