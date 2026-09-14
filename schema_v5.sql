-- ============================================================
-- Migration v5 — run AFTER schema.sql, schema_v2/v3/v4.sql
-- Column dependencies: a column can require another column to be
-- COMPLETE before it can itself be marked complete. Crew can still
-- start/stack the dependent work early — this only blocks Complete.
-- ============================================================

create table if not exists bt_column_dependencies (
  id                    bigint generated always as identity primary key,
  column_id             bigint not null references bt_status_columns(id) on delete cascade,
  depends_on_column_id  bigint not null references bt_status_columns(id) on delete cascade,
  unique (column_id, depends_on_column_id)
);

alter table bt_column_dependencies enable row level security;
create policy "authenticated read" on bt_column_dependencies for select using (auth.role() = 'authenticated');
create policy "admin write dependencies" on bt_column_dependencies for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

-- Mods can't be marked Complete until V4T is Complete (Mods can still be
-- started/stacked early, per how the floor actually works today).
insert into bt_column_dependencies (column_id, depends_on_column_id)
select m.id, v.id from bt_status_columns m, bt_status_columns v
where m.name = 'Mods' and v.name = 'V4T'
on conflict do nothing;
