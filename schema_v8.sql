-- ============================================================
-- Migration v8 — run AFTER schema.sql through schema_v7.sql
-- Lets one tablet login combine 2-3 departments into a single
-- actionable queue (previously a tablet could only switch between
-- departments one at a time; other departments showed read-only).
--
-- bt_profiles.department_id is kept as-is — it's still the tablet's
-- "home" department (used for defaults / the "(home)" label). This
-- migration adds a many-to-many table for every department a tablet
-- is allowed to act on, and seeds it with each profile's existing
-- home department so nothing changes until an admin explicitly adds
-- more departments to a login.
-- ============================================================

create table if not exists bt_profile_departments (
  user_id         uuid not null references bt_profiles(user_id) on delete cascade,
  department_id   bigint not null references bt_departments(id) on delete cascade,
  primary key (user_id, department_id)
);

-- Seed: every crew profile's current home department becomes its
-- first (and initially only) combined department.
insert into bt_profile_departments (user_id, department_id)
select user_id, department_id from bt_profiles
where department_id is not null
on conflict do nothing;

alter table bt_profile_departments enable row level security;

create policy "self read" on bt_profile_departments for select using (auth.uid() = user_id);
create policy "admin read all" on bt_profile_departments for select using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write profile_departments" on bt_profile_departments for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

-- Replace the single-department write policy from schema_v4 with one
-- that checks the combined set of departments for this login.
drop policy if exists "crew update own status" on bt_order_status;
create policy "crew update own status" on bt_order_status for update using (
  exists (
    select 1 from bt_profiles p
    join bt_profile_departments pd on pd.user_id = p.user_id
    join bt_department_columns dc on dc.department_id = pd.department_id
    where p.user_id = auth.uid() and p.role = 'crew' and dc.status_column_id = bt_order_status.status_column_id
  )
);
