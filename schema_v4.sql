-- ============================================================
-- Migration v4 — run AFTER schema.sql, schema_v2.sql, schema_v3.sql
-- Adds an explicit "started" action, separate from the raw sheet
-- value, so crew can mark work in progress with a tap rather than
-- typing anything — and everyone tracking that tag sees the stage.
-- ============================================================

alter table bt_order_status add column if not exists started_at timestamptz;

alter table bt_events drop constraint if exists bt_events_event_type_check;
alter table bt_events add constraint bt_events_event_type_check
  check (event_type in ('ship_date_changed', 'column_completed', 'order_picked_up', 'column_started'));

create or replace function bt_log_column_started()
returns trigger language plpgsql as $$
declare
  v_tag text;
  v_col text;
begin
  if new.started_at is not null and old.started_at is null then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    insert into bt_events (order_id, event_type, message)
    values (new.order_id, 'column_started', v_col || ' started on ' || v_tag);
  end if;
  return new;
end;
$$;

drop trigger if exists bt_order_status_log_started on bt_order_status;
create trigger bt_order_status_log_started
  after update on bt_order_status
  for each row execute function bt_log_column_started();

-- Crew needs to be able to set started_at / status_value on their own
-- department's rows (previously write access was admin-only).
create policy "crew update own status" on bt_order_status for update using (
  exists (
    select 1 from bt_profiles p
    join bt_department_columns dc on dc.department_id = p.department_id
    where p.user_id = auth.uid() and p.role = 'crew' and dc.status_column_id = bt_order_status.status_column_id
  )
);
