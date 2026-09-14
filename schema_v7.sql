-- schema_v7.sql
-- Adds the 5-stage workflow dropdown (Paperwork Ready -> Order Started ->
-- Order Completed -> Packaged -> Loaded on Truck) that admins set per
-- order/department cell in the Grid, replacing free-text C/X entry there.
-- The original imported status_value column is untouched — it stays as
-- the raw record of what the weekly Excel import actually said.

alter table bt_order_status
  add column if not exists workflow_stage text
  check (workflow_stage in ('paperwork_ready', 'started', 'completed', 'packaged', 'shipped'));

-- Convenience: any cell the import already marked 'C' starts life as
-- Order Completed instead of blank, so admins aren't re-setting things
-- the sheet already told us were done. Everything else (X, quantities,
-- Arrived, etc.) starts unset and an admin picks the real stage by hand.
update bt_order_status
set workflow_stage = 'completed'
where workflow_stage is null and lower(trim(status_value)) = 'c';
