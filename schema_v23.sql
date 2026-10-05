-- ============================================================
-- Migration v23 — run AFTER schema_v22.sql
--
-- Order paperwork packages and unit counts.
--
-- 1. Files get a department label ("V4T", "Mods", "Shipping"…) and a
--    package id, so everything uploaded for an order in one go shows
--    together on the order's paperwork, each with its department in front.
-- 2. bt_order_quantities: how many of each thing an order needs — mods,
--    V4T frames, vents. Read from the uploaded sheets, or typed by the
--    office; a typed number always beats a read one.
-- 3. bt_column_measures: which count a department's Done credits
--    (Mods → mods, V4T → V4T frames, TA144 Vents → vents …).
-- 4. bt_units_done(since): units finished since a time, by count —
--    "12 mods, 30 frames today" for the TVs and department screens.
-- 5. The office login may upload and delete paperwork.
--
-- Safe to re-run.
-- ============================================================


-- ── 1. Files ─────────────────────────────────────────────────
alter table bt_files add column if not exists dept_label  text;
alter table bt_files add column if not exists kind        text;
alter table bt_files add column if not exists package_id  uuid;
alter table bt_files add column if not exists note        text;
alter table bt_files add column if not exists page        int;

create index if not exists bt_files_order on bt_files (order_id);


-- ── 2. What an order needs ───────────────────────────────────
create table if not exists bt_order_quantities (
  order_id   bigint not null references bt_orders(id) on delete cascade,
  measure    text   not null,
  qty        numeric not null check (qty >= 0),
  source     text   not null default 'file' check (source in ('file', 'typed')),
  note       text,
  updated_at timestamptz not null default now(),
  primary key (order_id, measure)
);

alter table bt_order_quantities enable row level security;
drop policy if exists "authenticated read" on bt_order_quantities;
create policy "authenticated read" on bt_order_quantities for select using (auth.role() = 'authenticated');


-- ── 3. Who may manage paperwork ──────────────────────────────
create or replace function bt_can_manage_files() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from bt_profiles p
    where p.user_id = auth.uid() and p.role in ('admin', 'office', 'logistics')
  )
$$;

drop policy if exists "files manage insert" on bt_files;
create policy "files manage insert" on bt_files for insert with check (bt_can_manage_files());
drop policy if exists "files manage update" on bt_files;
create policy "files manage update" on bt_files for update using (bt_can_manage_files());
drop policy if exists "files manage delete" on bt_files;
create policy "files manage delete" on bt_files for delete using (bt_can_manage_files());

drop policy if exists "quantities manage insert" on bt_order_quantities;
create policy "quantities manage insert" on bt_order_quantities for insert with check (bt_can_manage_files());
drop policy if exists "quantities manage update" on bt_order_quantities;
create policy "quantities manage update" on bt_order_quantities for update using (bt_can_manage_files());
drop policy if exists "quantities manage delete" on bt_order_quantities;
create policy "quantities manage delete" on bt_order_quantities for delete using (bt_can_manage_files());

drop policy if exists "bt-files manage write" on storage.objects;
create policy "bt-files manage write" on storage.objects for insert to authenticated
  with check (bucket_id = 'bt-files' and bt_can_manage_files());
drop policy if exists "bt-files manage delete" on storage.objects;
create policy "bt-files manage delete" on storage.objects for delete to authenticated
  using (bucket_id = 'bt-files' and bt_can_manage_files());


-- ── 4. Which count a column's Done credits ───────────────────
create table if not exists bt_column_measures (
  status_column_id bigint not null references bt_status_columns(id) on delete cascade,
  measure          text   not null,
  primary key (status_column_id, measure)
);

alter table bt_column_measures enable row level security;
drop policy if exists "authenticated read" on bt_column_measures;
create policy "authenticated read" on bt_column_measures for select using (auth.role() = 'authenticated');
drop policy if exists "admin write column_measures" on bt_column_measures;
create policy "admin write column_measures" on bt_column_measures for all using (bt_is_admin());

insert into bt_column_measures (status_column_id, measure)
select s.id, m.measure
from (values
  ('Mods',           'mods'),
  ('SC220 Frames',   'mods'),
  ('V4T',            'v4t_frames'),
  ('SC220 Uprights', 'v4t_frames'),
  ('Manual Framing', 'v4t_frames'),
  ('TA144 Vents',    'vents')
) as m(col, measure)
join bt_status_columns s on s.name = m.col
on conflict do nothing;


-- ── 5. Units finished since a time ───────────────────────────
-- Each Done on a column credits the order's quantity for that column's
-- measure. A column done twice (re-opened, finished again) counts once
-- per order in the window. security definer so every login sees the
-- totals, not just the rows its own role could read.
create or replace function bt_units_done(p_since timestamptz, p_department text default null)
returns table (measure text, units numeric, orders bigint)
language sql stable security definer set search_path = public as $$
  with done as (
    select distinct a.order_id, a.status_column_id
    from bt_activity a
    where a.kind = 'done' and a.at >= p_since and a.order_id is not null
      and (
        p_department is null
        or exists (
          select 1 from bt_department_columns dc
          join bt_departments d on d.id = dc.department_id
          where dc.status_column_id = a.status_column_id and d.name = p_department
        )
      )
  )
  -- Mods fall back to the count the office already types on the order.
  select cm.measure,
         sum(coalesce(q.qty, case when cm.measure = 'mods' then o.mods_count end))::numeric,
         count(distinct d.order_id)
  from done d
  join bt_column_measures cm on cm.status_column_id = d.status_column_id
  join bt_orders o on o.id = d.order_id
  left join bt_order_quantities q on q.order_id = d.order_id and q.measure = cm.measure
  where coalesce(q.qty, case when cm.measure = 'mods' then o.mods_count end) is not null
  group by cm.measure
$$;

grant execute on function bt_units_done(timestamptz, text) to authenticated;
grant execute on function bt_can_manage_files() to authenticated;


-- ── 6. Check ─────────────────────────────────────────────────
-- select count(*) from bt_column_measures;   -- 6 once the stations exist (v21)
-- select * from bt_units_done(date_trunc('day', now()));
