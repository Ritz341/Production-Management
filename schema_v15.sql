-- ============================================================
-- Migration v15 — run AFTER schema_v14.sql
--
-- Count check-ins: every couple of hours a department enters how many
-- it has finished today so far (e.g. "7 mods"). The TV board compares
-- each check-in with the target for that time of day — the classic
-- hour-by-hour board — without waiting for whole orders to be Done.
-- ============================================================

create table if not exists bt_output_counts (
  id             bigint generated always as identity primary key,
  department_id  bigint not null references bt_departments(id) on delete cascade,
  work_date      date not null default current_date,
  at             timestamptz not null default now(),
  count          numeric(6, 1) not null check (count >= 0),
  entered_by     uuid default auth.uid()
);
create index if not exists bt_output_counts_day on bt_output_counts (department_id, work_date, at);

alter table bt_output_counts enable row level security;

drop policy if exists "authenticated read" on bt_output_counts;
create policy "authenticated read" on bt_output_counts for select using (auth.role() = 'authenticated');

-- A tablet can enter counts for its own departments; admin for any.
drop policy if exists "enter own counts" on bt_output_counts;
create policy "enter own counts" on bt_output_counts for insert with check (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
  or exists (
    select 1 from bt_profile_departments pd
    where pd.user_id = auth.uid() and pd.department_id = bt_output_counts.department_id
  )
);

-- Admin can fix a wrong entry.
drop policy if exists "admin edit counts" on bt_output_counts;
create policy "admin edit counts" on bt_output_counts for delete using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_output_counts') then
    alter publication supabase_realtime add table bt_output_counts;
  end if;
end $$;
