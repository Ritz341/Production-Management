-- ============================================================
-- Migration v11 — run AFTER schema.sql through schema_v10.sql
-- "Blocked / material shortage" — a flag layered on top of whatever
-- workflow_stage a cell is already at (e.g. "Order Started" but
-- blocked waiting on a part), not a 6th stage in the linear
-- paperwork→started→completed→packaged→shipped sequence. Kept as its
-- own column rather than folded into workflow_stage so the existing
-- quick-advance logic (which walks WORKFLOW_STAGES by index) doesn't
-- need to special-case it.
-- ============================================================

alter table bt_order_status add column if not exists blocked_at timestamptz;
alter table bt_order_status add column if not exists blocked_note text;

-- Extends the schema_v10 trigger to also log block/unblock as an
-- order_status_changed event (same bell-notification path — no new
-- event type needed).
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

  if new.blocked_at is distinct from old.blocked_at then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    if new.blocked_at is not null then
      insert into bt_events (order_id, event_type, message)
      values (new.order_id, 'order_status_changed', '🚫 ' || v_col || ' on ' || v_tag || ' BLOCKED' || coalesce(' — ' || new.blocked_note, ''));
    else
      insert into bt_events (order_id, event_type, message)
      values (new.order_id, 'order_status_changed', v_col || ' on ' || v_tag || ' unblocked');
    end if;
  end if;

  return new;
end;
$$;
