-- ============================================================
-- Migration v20 — run AFTER schema_v19.sql
--
-- Fixes a gap in v17's build-week retitling, found by running the
-- migration against a real Postgres rather than reading it.
--
-- v17 rewrites the date inside a week's label when its ship date
-- moves, so the name stops contradicting the date. It only matched the
-- numeric form the sheet banner uses ('PICK UP 9/15'). A label that
-- spells the month out kept its old date:
--
--     'Sept 15 Build Week'  ship_date 2026-10-23  ← still says Sept 15
--
-- which is the exact problem v17 existed to stop, just in a different
-- shape. A separate migration rather than an edit to v17, because v17
-- has already been applied and an edited migration never re-runs for
-- whoever applied the original.
--
-- Also carries each order's own copy of the pickup date along with the
-- week, which had the same problem (section at the bottom).
--
-- Safe to re-run.
-- ============================================================

create or replace function bt_build_weeks_retitle()
returns trigger language plpgsql as $$
declare
  v_numeric text;
  v_written text;
begin
  if new.ship_date is distinct from old.ship_date
     and new.ship_date is not null
     and new.label is not distinct from old.label  -- admin renaming it by hand wins
  then
    v_numeric := to_char(new.ship_date, 'FMMM/FMDD');   -- 10/23
    v_written := to_char(new.ship_date, 'FMMon FMDD');  -- Oct 23

    -- 'PICK UP 9/15', '9/15/2026'
    new.label := regexp_replace(new.label, '\d{1,2}/\d{1,2}(/\d{2,4})?', v_numeric);

    -- 'Sept 15 Build Week', 'Oct. 2 pickup', 'September 15th'. Only
    -- tried when the numeric pass changed nothing, so a label carrying
    -- both forms doesn't get two different rewrites.
    if new.label is not distinct from old.label then
      new.label := regexp_replace(
        new.label,
        '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?',
        v_written,
        'i'
      );
    end if;

    -- Nothing date-like in there at all ('USA run', 'Dealer open
    -- house'): leave the name exactly as the plant wrote it.
  end if;
  return new;
end $$;

drop trigger if exists bt_build_weeks_retitle on bt_build_weeks;
create trigger bt_build_weeks_retitle
  before update on bt_build_weeks
  for each row execute function bt_build_weeks_retitle();


-- ── Orders that copied the week's date move with it ─────────
-- An import or Logistics writes the week's ship date onto each order
-- as scheduled_pickup_date. Moving the week left every one of those
-- copies behind, so Shipping and Logistics went on showing the old
-- pickup — the same stale-date problem as the label, one table over.
--
-- Only orders still on the week's OLD date follow it. One someone gave
-- its own pickup date on purpose has a different date, and keeps it.
create or replace function bt_build_weeks_carry_orders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.ship_date is distinct from old.ship_date and old.ship_date is not null then
    update bt_orders
    set scheduled_pickup_date = new.ship_date
    where build_week_id = new.id
      and scheduled_pickup_date = old.ship_date;
  end if;
  return new;
end $$;

drop trigger if exists bt_build_weeks_carry_orders on bt_build_weeks;
create trigger bt_build_weeks_carry_orders
  after update on bt_build_weeks
  for each row execute function bt_build_weeks_carry_orders();
