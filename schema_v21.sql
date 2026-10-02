-- ============================================================
-- Migration v21 — run AFTER schema_v20.sql
--
-- The cutting stations get their own tablets:
--
--   SC220       CNC  — Mods frames, V4T uprights
--   TA144       CNC  — vents (cut & drill)
--   Manual Cut  manual saw / punch — V4T framing (cut & punch), traps and
--               vinyl fix (cut to length), corner posts
--
-- Each station is a department like any other: its own login, its own
-- queue in build order, Start / Done on every job, its own TV
-- (?tv=SC220, ?tv=TA144, ?tv=Manual%20Cut). Its jobs are new status
-- columns that are NOT on the build sheet, so each one is created for an
-- order automatically, from the sheet column it feeds:
--
--   SC220 Frames          follows Mods
--   SC220 Uprights        follows V4T
--   TA144 Vents           follows V4T
--   Manual Framing        follows V4T
--   Manual Traps          follows Vin. Trap
--   Manual Vinyl Fix      follows Vin. Fix
--   Manual Corner Posts   follows Mods
--
-- An order gets the cut job when it has the column it follows and that
-- column isn't already C (done). The Mods and V4T TV boards read these
-- rows to show, per order, whether its material has been cut.
--
-- The follows list is a table (bt_cut_follows), so another machine or job
-- later is data, not code.
--
-- Safe to re-run.
-- ============================================================


-- ── 1. The stations ──────────────────────────────────────────
insert into bt_departments (name, sort_order) values
  ('SC220', 6),
  ('TA144', 7),
  ('Manual Cut', 8)
on conflict (name) do nothing;


-- ── 2. Their jobs, as status columns ─────────────────────────
insert into bt_status_columns (name, sort_order) values
  ('SC220 Frames', 27),
  ('SC220 Uprights', 28),
  ('TA144 Vents', 29),
  ('Manual Framing', 30),
  ('Manual Traps', 31),
  ('Manual Vinyl Fix', 32),
  ('Manual Corner Posts', 33)
on conflict (name) do nothing;

insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id
from (values
  ('SC220',      'SC220 Frames'),
  ('SC220',      'SC220 Uprights'),
  ('TA144',      'TA144 Vents'),
  ('Manual Cut', 'Manual Framing'),
  ('Manual Cut', 'Manual Traps'),
  ('Manual Cut', 'Manual Vinyl Fix'),
  ('Manual Cut', 'Manual Corner Posts')
) as m(dept, col)
join bt_departments d on d.name = m.dept
join bt_status_columns s on s.name = m.col
on conflict do nothing;


-- ── 3. Which sheet column each cut job follows ───────────────
create table if not exists bt_cut_follows (
  cut_column_id     bigint not null references bt_status_columns(id) on delete cascade,
  source_column_id  bigint not null references bt_status_columns(id) on delete cascade,
  primary key (cut_column_id, source_column_id),
  check (cut_column_id <> source_column_id)
);

alter table bt_cut_follows enable row level security;
drop policy if exists "authenticated read" on bt_cut_follows;
create policy "authenticated read" on bt_cut_follows for select using (auth.role() = 'authenticated');
drop policy if exists "admin write cut_follows" on bt_cut_follows;
create policy "admin write cut_follows" on bt_cut_follows for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

insert into bt_cut_follows (cut_column_id, source_column_id)
select c.id, s.id
from (values
  ('SC220 Frames',        'Mods'),
  ('SC220 Uprights',      'V4T'),
  ('TA144 Vents',         'V4T'),
  ('Manual Framing',      'V4T'),
  ('Manual Traps',        'Vin. Trap'),
  ('Manual Vinyl Fix',    'Vin. Fix'),
  ('Manual Corner Posts', 'Mods')
) as f(cut, source)
join bt_status_columns c on c.name = f.cut
join bt_status_columns s on s.name = f.source
on conflict do nothing;


-- ── 4. Create an order's cut jobs from the columns it has ────
-- security definer: the row that triggers this may be a crew tablet or a
-- logistics login, neither of which is allowed to insert status rows, and
-- the cut jobs must appear whoever caused them.
--
-- A blank status counts as needed (an order added by hand has no value);
-- only C — already done — means there's nothing left to cut.
create or replace function bt_sync_cut_rows(p_order_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into bt_order_status (order_id, status_column_id, status_value, is_visible)
  select src.order_id, f.cut_column_id, src.status_value, true
  from bt_cut_follows f
  join bt_order_status src
    on src.order_id = p_order_id and src.status_column_id = f.source_column_id
  where src.is_visible
    and src.removed_at is null
    and lower(btrim(coalesce(src.status_value, ''))) <> 'c'
  on conflict (order_id, status_column_id) do nothing;
end $$;

create or replace function bt_order_status_cut_rows()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Only a sheet column that something follows needs a look; the cut
  -- jobs themselves are never followed, so their own inserts stop here.
  if exists (select 1 from bt_cut_follows where source_column_id = new.status_column_id) then
    perform bt_sync_cut_rows(new.order_id);
  end if;
  return null;
end $$;

drop trigger if exists bt_order_status_cut_rows on bt_order_status;
create trigger bt_order_status_cut_rows
  after insert or update of status_value, is_visible, removed_at on bt_order_status
  for each row execute function bt_order_status_cut_rows();


-- ── 5. Orders already on the books ───────────────────────────
-- Every order that exists now gets its cut jobs, so the new tablets and
-- the TVs aren't empty until the next import.
do $$
declare
  o record;
begin
  for o in select id from bt_orders loop
    perform bt_sync_cut_rows(o.id);
  end loop;
end $$;


-- ── 6. Check ─────────────────────────────────────────────────
-- Cut jobs now on orders, by station. Run this to see them.
-- select d.name as station, s.name as job, count(*) as orders
-- from bt_order_status os
-- join bt_status_columns s on s.id = os.status_column_id
-- join bt_department_columns dc on dc.status_column_id = s.id
-- join bt_departments d on d.id = dc.department_id
-- where d.name in ('SC220', 'TA144', 'Manual Cut')
-- group by 1, 2 order by 1, 2;
--
-- The logins are linked in setup_logins.sql (sc220@, ta144@, manual@).
