-- ============================================================
-- Migration v17 — run AFTER schema_v16.sql
--
--   1. A build week's name stops lying about when it ships.
--      The label is the sheet's banner text ('PICK UP 9/15'), written
--      once at import and never touched again — so after admin moved a
--      ship date the tablets still read "Sept 15" at the top even
--      though the date underneath had changed. The date inside the
--      label now moves with ship_date.
--   2. The ship-date alert says what it moved FROM, not just to.
--   3. Walls on an order, alongside mods. From the order confirmation:
--      a wall is made of 2-3 mods (wall 1 = 2 mods, wall 2 = 3 mods,
--      so a 2-wall room is 5 mods). mods_count stays the total, which
--      is what capacity is counted in; walls_count is how that total is
--      split up, which is what the drawing shows and the floor builds.
--
-- Safe to re-run.
-- ============================================================


-- ── 1. Keep the week's name and its ship date in step ──────
--
-- Only the date inside the label is rewritten, and only when it looks
-- like the sheet's 'M/D'. A week someone named by hand ('USA run',
-- 'Dealer open house') has no date in it and is left exactly as typed.
create or replace function bt_build_weeks_retitle()
returns trigger language plpgsql as $$
declare
  v_date text;
begin
  if new.ship_date is distinct from old.ship_date
     and new.ship_date is not null
     and new.label is not distinct from old.label  -- admin renaming it by hand wins
  then
    v_date := to_char(new.ship_date, 'FMMM/FMDD');
    new.label := regexp_replace(new.label, '\d{1,2}/\d{1,2}(/\d{2,4})?', v_date);
  end if;
  return new;
end $$;

drop trigger if exists bt_build_weeks_retitle on bt_build_weeks;
create trigger bt_build_weeks_retitle
  before update on bt_build_weeks
  for each row execute function bt_build_weeks_retitle();


-- ── 2. Say where the date moved from ───────────────────────
-- "PICK UP 9/22 now ships Mon Sep 22 — moved from Mon Sep 15" reads as
-- a change; "ship date changed to Sep 22" reads as a fact someone may
-- well have already known.
create or replace function bt_log_ship_date_changed()
returns trigger language plpgsql as $$
begin
  if new.ship_date is distinct from old.ship_date then
    insert into bt_events (build_week_id, event_type, message)
    values (
      new.id,
      'ship_date_changed',
      new.label || ' now ships ' || coalesce(to_char(new.ship_date, 'Dy Mon FMDD'), 'no date yet')
        || case
             when old.ship_date is null then ''
             else ' — moved from ' || to_char(old.ship_date, 'Dy Mon FMDD')
           end
    );
  end if;
  return new;
end $$;


-- ── 3. Walls on an order ───────────────────────────────────
alter table bt_orders add column if not exists walls_count integer
  check (walls_count is null or (walls_count >= 0 and walls_count <= 50));

comment on column bt_orders.mods_count is
  'Total mods in the room, across every wall — what Mods capacity is counted in.';
comment on column bt_orders.walls_count is
  'How many walls those mods are split across (a wall is 2-3 mods on the order confirmation).';

-- The office sets these through one function so it can edit the
-- estimating fields without write access to the rest of the order.
-- Dropped and recreated rather than replaced because the argument list
-- changes; every caller passes its arguments by name.
drop function if exists bt_set_order_details(bigint, integer, text, text, text);

create or replace function bt_set_order_details(
  p_order_id bigint,
  p_mods_count integer,
  p_room_shape text,
  p_window_type text,
  p_panel_type text,
  p_walls_count integer default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role in ('admin', 'office', 'logistics')) then
    raise exception 'This login cannot edit order details';
  end if;
  update bt_orders
  set mods_count  = p_mods_count,
      walls_count = p_walls_count,
      room_shape  = p_room_shape,
      window_type = p_window_type,
      panel_type  = p_panel_type
  where id = p_order_id;
end $$;


-- ── 4. Panel's three sub-departments ───────────────────────
-- Panel is one tablet covering roof panels, mod filler panels and
-- acrylic — three benches that don't feed each other, so each keeps its
-- own column with its own Start/Done, and (through v16's process list)
-- its own crew and count check-ins. v14 set this mapping up; re-asserted
-- here so a database that skipped straight to v17 still gets it.
insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'Panel' and s.name in ('Roof Panels', 'Roof Extr.', 'Acrylic', 'Mod Filler Panels')
on conflict do nothing;
