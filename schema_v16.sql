-- ============================================================
-- Migration v16 — run AFTER schema_v15.sql
--
-- Processes inside a department (Mods: framing → staging; V4T: vents
-- cut → vents built & glazed → frames built & squared). Each process
-- gets its own crew per day and its own count check-ins, so targets
-- and the bottleneck can be worked out per station.
--
-- The process list itself (names, units, rate per person per hour)
-- lives in bt_settings under 'processes' and is edited in Admin → TVs.
-- ============================================================

-- People on each process, per day.
create table if not exists bt_process_days (
  work_date      date not null,
  department_id  bigint not null references bt_departments(id) on delete cascade,
  process        text not null,
  people         numeric(4, 1) not null check (people >= 0),
  primary key (work_date, department_id, process)
);
alter table bt_process_days enable row level security;
drop policy if exists "authenticated read" on bt_process_days;
create policy "authenticated read" on bt_process_days for select using (auth.role() = 'authenticated');
drop policy if exists "admin write process days" on bt_process_days;
create policy "admin write process days" on bt_process_days for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

-- Count check-ins can now be for one process (null = the department as a whole).
alter table bt_output_counts add column if not exists process text;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_process_days') then
    alter publication supabase_realtime add table bt_process_days;
  end if;
end $$;
