-- ============================================================
-- Reset to an empty slate — run in the Supabase SQL editor.
--
-- PERMANENTLY DELETES every order and everything attached to it:
--   • all orders                     (bt_orders)
--   • every department status        (bt_order_status)
--   • file records                   (bt_files)
--   • all build weeks / pickup dates (bt_build_weeks)
--   • all alerts and activity        (bt_events)
--
-- KEEPS the setup, so the app works immediately afterwards:
--   • departments, status columns, and which columns belong to which
--     department (bt_departments, bt_status_columns, bt_department_columns)
--   • every login and its role / departments (bt_profiles, bt_profile_departments)
--
-- There is no undo. To keep a copy first: Database → Backups in the
-- Supabase dashboard, or Table Editor → bt_orders → Export to CSV.
-- ============================================================

-- CASCADE also empties the tables that point at these ones
-- (bt_order_status and bt_files). RESTART IDENTITY starts ids at 1 again.
truncate table bt_orders, bt_build_weeks, bt_events restart identity cascade;

-- Check: every count should be 0.
select
  (select count(*) from bt_orders)       as orders,
  (select count(*) from bt_order_status) as statuses,
  (select count(*) from bt_files)        as files,
  (select count(*) from bt_build_weeks)  as build_weeks,
  (select count(*) from bt_events)       as events;

-- The uploaded files themselves live in Storage, not these tables.
-- Supabase doesn't allow deleting them from SQL — empty them in the
-- dashboard: Storage → bt-files → select all → Delete.
