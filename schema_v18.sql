-- ============================================================
-- Migration v18 — run AFTER schema_v17.sql
--
-- Skill Matrix & Cross-Department Floating
--
-- Adds employee tracking (separate from auth logins in bt_profiles),
-- a department-level skill system with Cutting/Assembly functional
-- tracks, Lead tier assignments, and a cross-department floater view
-- for supervisors to reallocate qualified leads during bottlenecks.
-- ============================================================

-- ── Employees ────────────────────────────────────────────────
-- One row per floor worker. Separate from bt_profiles (auth logins)
-- because one tablet login is shared by multiple people, and an
-- employee may not have their own login at all.
create table if not exists bt_employees (
  id              bigint generated always as identity primary key,
  name            text not null,
  employee_id     text unique,                    -- badge / payroll ID, nullable
  primary_dept_id bigint references bt_departments(id) on delete set null,
  shift           text default 'Day',             -- 'Day', 'Night', 'Swing'
  lead_level      text not null default 'NONE'
                  check (lead_level in ('NONE', 'LEAD_1', 'LEAD_2', 'LEAD_3')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── Skills catalog ───────────────────────────────────────────
-- Each department's teachable skills, split into functional tracks.
create table if not exists bt_skills (
  id                bigint generated always as identity primary key,
  department_id     bigint not null references bt_departments(id) on delete cascade,
  name              text not null,                -- e.g. 'Double-Miter Saw', 'Frame Welding'
  function_category text not null default 'ASSEMBLY'
                    check (function_category in ('CUTTING', 'ASSEMBLY', 'QC', 'STAGING')),
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  unique (department_id, name)
);

-- ── Employee × Skill ratings ─────────────────────────────────
-- Rating 1–4 per the matrix scale:
--   1 = Learning / Trainee
--   2 = Autonomous Operator
--   3 = Specialist / Lead 1 Level
--   4 = Master / Trainer / Lead 2-3 Level
create table if not exists bt_employee_skills (
  id              bigint generated always as identity primary key,
  employee_id     bigint not null references bt_employees(id) on delete cascade,
  skill_id        bigint not null references bt_skills(id) on delete cascade,
  rating          smallint not null default 1
                  check (rating between 1 and 4),
  rated_at        timestamptz not null default now(),
  rated_by        uuid references auth.users(id),
  unique (employee_id, skill_id)
);

-- ── Temporary reassignments ──────────────────────────────────
-- When a supervisor floats someone to another department, this
-- records the active reassignment so the floor knows where they are.
create table if not exists bt_float_assignments (
  id              bigint generated always as identity primary key,
  employee_id     bigint not null references bt_employees(id) on delete cascade,
  from_dept_id    bigint not null references bt_departments(id) on delete cascade,
  to_dept_id      bigint not null references bt_departments(id) on delete cascade,
  assigned_by     uuid references auth.users(id),
  assigned_at     timestamptz not null default now(),
  expected_end    timestamptz,                    -- when the float is meant to end
  ended_at        timestamptz,                    -- null while active
  note            text
);

-- ── Cross-Department Floater View ────────────────────────────
-- Shows employees qualified (rating 3+) in departments outside
-- their primary assignment. Used by the CrossDeptFloatBoard.
create or replace view v_cross_dept_floaters as
select
  e.id              as employee_id,
  e.name            as employee_name,
  e.employee_id     as badge_id,
  e.lead_level,
  e.shift,
  e.is_active,
  pd.name           as primary_dept,
  e.primary_dept_id,
  d.id              as qualified_dept_id,
  d.name            as qualified_dept,
  s.function_category,
  max(es.rating)    as max_rating,
  -- Is there an active float right now?
  (select fa.id from bt_float_assignments fa
   where fa.employee_id = e.id and fa.ended_at is null
   limit 1)         as active_float_id,
  (select fd.name from bt_float_assignments fa
   join bt_departments fd on fd.id = fa.to_dept_id
   where fa.employee_id = e.id and fa.ended_at is null
   limit 1)         as currently_floated_to
from bt_employees e
join bt_employee_skills es on es.employee_id = e.id
join bt_skills s           on s.id = es.skill_id
join bt_departments d      on d.id = s.department_id
left join bt_departments pd on pd.id = e.primary_dept_id
where es.rating >= 3
  and e.is_active = true
  and (e.primary_dept_id is null or s.department_id <> e.primary_dept_id)
group by e.id, e.name, e.employee_id, e.lead_level, e.shift, e.is_active,
         pd.name, e.primary_dept_id, d.id, d.name, s.function_category;

-- ── Versatility summary per employee ─────────────────────────
-- Counts how many departments an employee is rated 2+ in.
create or replace view v_employee_versatility as
select
  e.id              as employee_id,
  e.name,
  e.lead_level,
  e.primary_dept_id,
  pd.name           as primary_dept,
  count(distinct s.department_id) as versatility_index,
  string_agg(distinct d.name, ', ' order by d.name)
    filter (where es.rating >= 3 and s.department_id <> e.primary_dept_id)
    as cross_float_depts
from bt_employees e
join bt_employee_skills es on es.employee_id = e.id
join bt_skills s           on s.id = es.skill_id
join bt_departments d      on d.id = s.department_id
left join bt_departments pd on pd.id = e.primary_dept_id
where es.rating >= 2
  and e.is_active = true
group by e.id, e.name, e.lead_level, e.primary_dept_id, pd.name;

-- ── Triggers ─────────────────────────────────────────────────
drop trigger if exists bt_employees_set_updated_at on bt_employees;
create trigger bt_employees_set_updated_at
  before update on bt_employees
  for each row execute function bt_set_updated_at();

-- ── Row Level Security ───────────────────────────────────────
alter table bt_employees enable row level security;
alter table bt_skills enable row level security;
alter table bt_employee_skills enable row level security;
alter table bt_float_assignments enable row level security;

-- Everyone authenticated can read (tablets need to see the floater board)
create policy "authenticated read" on bt_employees for select
  using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_skills for select
  using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_employee_skills for select
  using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_float_assignments for select
  using (auth.role() = 'authenticated');

-- Only admin can write employees, skills, and ratings
create policy "admin write employees" on bt_employees for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write skills" on bt_skills for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write employee_skills" on bt_employee_skills for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
-- Admin and crew leads can write float assignments (crew needs to
-- end their own float when they return)
create policy "admin write float_assignments" on bt_float_assignments for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "crew insert float_assignments" on bt_float_assignments for insert with check (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'crew')
);
create policy "crew update float_assignments" on bt_float_assignments for update using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'crew')
);

-- ── Realtime ─────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_employees') then
    alter publication supabase_realtime add table bt_employees;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_employee_skills') then
    alter publication supabase_realtime add table bt_employee_skills;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_float_assignments') then
    alter publication supabase_realtime add table bt_float_assignments;
  end if;
end $$;
