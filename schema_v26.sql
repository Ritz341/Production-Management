-- ============================================================
-- Migration v26 — run AFTER schema_v25.sql
--
-- Counts the paperwork doesn't print yet — tracks, roof panels, mod
-- filler panels, doors — typed by the people who know them.
--
-- 1. bt_measure_editors: besides admin / office / logistics, which
--    department's tablets may type each count. The Track tablet types
--    tracks, Panel types roof panels, Panel and Mods type mod filler
--    panels, Door types doors, V4T may correct V4T frames and vents.
-- 2. bt_order_quantities write rules follow it.
-- 3. A Done on Track / Roof Panels / Mod Filler Panels / Doors now
--    credits those counts in "Built today" and the measured minutes.
--
-- Safe to re-run.
-- ============================================================

create table if not exists bt_measure_editors (
  measure        text   not null,
  department_id  bigint not null references bt_departments(id) on delete cascade,
  primary key (measure, department_id)
);

alter table bt_measure_editors enable row level security;
drop policy if exists "authenticated read" on bt_measure_editors;
create policy "authenticated read" on bt_measure_editors for select using (auth.role() = 'authenticated');
drop policy if exists "admin write measure_editors" on bt_measure_editors;
create policy "admin write measure_editors" on bt_measure_editors for all using (bt_is_admin());

insert into bt_measure_editors (measure, department_id)
select m.measure, d.id
from (values
  ('tracks',        'Track'),
  ('roof_panels',   'Panel'),
  ('filler_panels', 'Panel'),
  ('filler_panels', 'Mods'),
  ('doors',         'Door'),
  ('v4t_frames',    'V4T'),
  ('vents',         'V4T')
) as m(measure, dept)
join bt_departments d on d.name = m.dept
on conflict do nothing;


-- ── Who may type a count ─────────────────────────────────────
create or replace function bt_can_edit_measure(p_measure text) returns boolean
language sql stable security definer set search_path = public as $$
  select bt_can_manage_files()
      or exists (
        select 1
        from bt_profile_departments pd
        join bt_measure_editors me on me.department_id = pd.department_id
        where pd.user_id = auth.uid() and me.measure = p_measure
      )
$$;
revoke execute on function bt_can_edit_measure(text) from public, anon;
grant execute on function bt_can_edit_measure(text) to authenticated;

drop policy if exists "quantities manage insert" on bt_order_quantities;
create policy "quantities manage insert" on bt_order_quantities for insert with check (bt_can_edit_measure(measure));
drop policy if exists "quantities manage update" on bt_order_quantities;
create policy "quantities manage update" on bt_order_quantities for update
  using (bt_can_edit_measure(measure)) with check (bt_can_edit_measure(measure));
drop policy if exists "quantities manage delete" on bt_order_quantities;
create policy "quantities manage delete" on bt_order_quantities for delete using (bt_can_edit_measure(measure));


-- ── What a Done on these jobs counts ─────────────────────────
insert into bt_column_measures (status_column_id, measure, base_measure, factor, is_primary)
select s.id, m.measure, m.measure, 1, true
from (values
  ('Track',             'tracks'),
  ('Roof Panels',       'roof_panels'),
  ('Mod Filler Panels', 'filler_panels'),
  ('Doors',             'doors')
) as m(col, measure)
join bt_status_columns s on s.name = m.col
on conflict (status_column_id, measure) do nothing;

-- ── Live updates ─────────────────────────────────────────────
-- A count typed on one screen shows on the others without a reload.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_order_quantities') then
    alter publication supabase_realtime add table bt_order_quantities;
  end if;
end $$;

-- ── Check ────────────────────────────────────────────────────
-- select me.measure, d.name from bt_measure_editors me join bt_departments d on d.id = me.department_id order by 1, 2;
