-- ============================================================
-- Migration v6 — run AFTER schema.sql through schema_v5.sql
-- Without this, postgres_changes subscriptions never fire —
-- explains why changes only appeared after a manual refresh.
-- Safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bt_order_status'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bt_order_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bt_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bt_orders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bt_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bt_events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bt_build_weeks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bt_build_weeks;
  END IF;
END $$;
