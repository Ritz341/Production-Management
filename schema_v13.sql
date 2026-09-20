-- ============================================================
-- Migration v13 — run AFTER schema_v12.sql
--
-- 1. Build order: orders are numbered within their pickup (1, 2, 3 …),
--    in the order they appear on the sheet. Admin moves them up and
--    down; every tablet builds in that order.
-- 2. Paperwork ready: an office-only flag, set by the new 'office'
--    login or admin. Not shown on the floor.
-- 3. Pulled orders: cancel a whole order (with a reason, restorable),
--    or take one department off it (e.g. "V4T done in Canada").
-- ============================================================

-- ── 1. Build order ──────────────────────────────────────────
-- 'sequence' only sets the order; the number people see (#1, #2 …) is
-- the position among the pickup's active orders, so cancelling or
-- moving an order never leaves a gap and never needs a renumber.
alter table bt_orders add column if not exists sequence integer;
alter table bt_orders add column if not exists moved_at timestamptz;
alter table bt_orders add column if not exists moved_direction text check (moved_direction in ('up', 'down'));

-- Existing orders: number them in the order they were entered.
update bt_orders o
set sequence = s.rn
from (
  select id, row_number() over (partition by build_week_id order by id) as rn
  from bt_orders
) s
where o.id = s.id and o.sequence is null;

-- New orders, and orders delayed to another pickup, go to the bottom of
-- that pickup. The import sets sequence itself (sheet order), so this
-- only fills it in when it's missing or the pickup changed.
create or replace function bt_orders_place_at_bottom()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.sequence is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.build_week_id is not distinct from old.build_week_id then
    return new;
  end if;
  -- An update that sets its own position (the import, in sheet order) keeps it.
  if tg_op = 'UPDATE' and new.sequence is distinct from old.sequence then
    return new;
  end if;
  select coalesce(max(sequence), 0) + 1 into new.sequence
  from bt_orders
  where build_week_id is not distinct from new.build_week_id and id is distinct from new.id;
  return new;
end $$;

drop trigger if exists bt_orders_place_at_bottom on bt_orders;
create trigger bt_orders_place_at_bottom
  before insert or update of build_week_id on bt_orders
  for each row execute function bt_orders_place_at_bottom();

-- Move an order one place up or down within its pickup. Admin only.
-- Swaps with the next active (not cancelled) order in that direction.
create or replace function bt_move_order(p_order_id bigint, p_direction text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order bt_orders%rowtype;
  v_other bt_orders%rowtype;
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role = 'admin') then
    raise exception 'Only admin can change the build order';
  end if;
  if p_direction not in ('up', 'down') then
    raise exception 'Direction must be up or down';
  end if;

  select * into v_order from bt_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found';
  end if;

  if p_direction = 'up' then
    select * into v_other from bt_orders
    where build_week_id is not distinct from v_order.build_week_id
      and status = 'active' and sequence < v_order.sequence
    order by sequence desc limit 1 for update;
  else
    select * into v_other from bt_orders
    where build_week_id is not distinct from v_order.build_week_id
      and status = 'active' and sequence > v_order.sequence
    order by sequence asc limit 1 for update;
  end if;
  if not found then
    return; -- already first / last
  end if;

  update bt_orders set sequence = v_other.sequence, moved_at = now(), moved_direction = p_direction where id = v_order.id;
  update bt_orders set sequence = v_order.sequence where id = v_other.id;
end $$;

-- ── 2. Paperwork ready (office + admin only) ───────────────
alter table bt_orders add column if not exists paperwork_ready_at timestamptz;

alter table bt_profiles drop constraint if exists bt_profiles_role_check;
alter table bt_profiles add constraint bt_profiles_role_check
  check (role in ('admin', 'crew', 'shipping', 'logistics', 'office'));

-- A function rather than an update policy, so the office login can flip
-- this one field and nothing else on the order.
create or replace function bt_set_paperwork_ready(p_order_ids bigint[], p_ready boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role in ('admin', 'office')) then
    raise exception 'Only office or admin can mark paperwork';
  end if;
  update bt_orders
  set paperwork_ready_at = case when p_ready then coalesce(paperwork_ready_at, now()) else null end
  where id = any(p_order_ids);
end $$;

-- ── 3. Pulled orders ───────────────────────────────────────
-- Whole order cancelled: hidden from every tablet, kept for admin with
-- the reason, and restorable. Delaying an order is just moving it to
-- another pickup (build_week_id), which the trigger above handles.
alter table bt_orders add column if not exists status text not null default 'active'
  check (status in ('active', 'cancelled'));
alter table bt_orders add column if not exists cancelled_at timestamptz;
alter table bt_orders add column if not exists cancel_reason text;

-- One department taken off an order (e.g. "Canada will do the V4T").
-- The work drops off that department's tablet; admin still sees why.
alter table bt_order_status add column if not exists removed_at timestamptz;
alter table bt_order_status add column if not exists removed_note text;

create index if not exists bt_orders_week_sequence on bt_orders (build_week_id, sequence);
