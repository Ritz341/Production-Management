-- ============================================================
-- Migration v30 — run AFTER schema_v29.sql. Safe to re-run.
--
-- Fixes the orders' pickup dates when a week's ship date is cleared and
-- set again.
--
-- v20 made orders that copied the week's date follow it when it moves.
-- But clearing the date (old → blank) wrote that blank onto every order
-- that followed it, and setting a new date afterwards (blank → new) did
-- nothing — "old" was blank, so no order matched. Every order was left
-- with no pickup date although the week had one again.
--
-- Now blank → new date gives the week's orders that have no pickup date
-- the new one. An order given its own date on purpose is still left alone.
-- ============================================================

create or replace function bt_build_weeks_carry_orders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.ship_date is distinct from old.ship_date then
    if old.ship_date is not null then
      -- moved (or cleared): the orders still on the old date follow it
      update bt_orders
      set scheduled_pickup_date = new.ship_date
      where build_week_id = new.id
        and scheduled_pickup_date = old.ship_date;
    elsif new.ship_date is not null then
      -- date given to a week that had none: orders with no date of their own take it
      update bt_orders
      set scheduled_pickup_date = new.ship_date
      where build_week_id = new.id
        and scheduled_pickup_date is null;
    end if;
  end if;
  return new;
end $$;

-- A trigger function is never called by a client (see schema_v27/v28).
revoke execute on function bt_build_weeks_carry_orders() from public, anon, authenticated;
