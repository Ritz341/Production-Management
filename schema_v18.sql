-- ============================================================
-- Migration v18 — run AFTER schema_v17.sql
--
-- Skill Matrix & Cross-Department Floating
--
-- Adds employee tracking (separate from auth logins in bt_profiles),
-- a department-level skill system with Cutting/Assembly functional
-- tracks, Lead tier assignments, and a cross-department floater view
-- for supervisors to reallocate qualified leads during bottlenecks.
--
-- Safe to re-run.
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

-- The floater board reads these by employee and by department on every
-- refresh; without indexes each one is a sequential scan.
create index if not exists bt_employee_skills_skill on bt_employee_skills (skill_id);
create index if not exists bt_skills_dept on bt_skills (department_id);
create index if not exists bt_float_active on bt_float_assignments (employee_id) where ended_at is null;

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
  -- Is there an active float right now? Newest first, so two open rows
  -- for one person (a float ended without ended_at being set, say)
  -- report the current one rather than an arbitrary one.
  (select fa.id from bt_float_assignments fa
   where fa.employee_id = e.id and fa.ended_at is null
   order by fa.assigned_at desc
   limit 1)         as active_float_id,
  (select fd.name from bt_float_assignments fa
   join bt_departments fd on fd.id = fa.to_dept_id
   where fa.employee_id = e.id and fa.ended_at is null
   order by fa.assigned_at desc
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

-- A view runs as its OWNER unless told otherwise, which means it reads
-- straight past the row-level security on the tables underneath it.
-- These two carry people's names, badge numbers and skill ratings, and
-- PostgREST will serve any view in the public schema — so without this
-- they are readable by a caller holding nothing but the anon key.
-- security_invoker makes them obey the policies below instead.
alter view v_cross_dept_floaters set (security_invoker = on);
alter view v_employee_versatility set (security_invoker = on);

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

-- Every policy is dropped first so the whole file can be re-run — a
-- bare create policy raises "already exists" on the second pass, which
-- would leave the rest of the migration unapplied.
-- Everyone authenticated can read (tablets need to see the floater board)
drop policy if exists "authenticated read" on bt_employees;
create policy "authenticated read" on bt_employees for select
  using (auth.role() = 'authenticated');
drop policy if exists "authenticated read" on bt_skills;
create policy "authenticated read" on bt_skills for select
  using (auth.role() = 'authenticated');
drop policy if exists "authenticated read" on bt_employee_skills;
create policy "authenticated read" on bt_employee_skills for select
  using (auth.role() = 'authenticated');
drop policy if exists "authenticated read" on bt_float_assignments;
create policy "authenticated read" on bt_float_assignments for select
  using (auth.role() = 'authenticated');

-- Only admin can write employees, skills, and ratings
drop policy if exists "admin write employees" on bt_employees;
create policy "admin write employees" on bt_employees for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
drop policy if exists "admin write skills" on bt_skills;
create policy "admin write skills" on bt_skills for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
drop policy if exists "admin write employee_skills" on bt_employee_skills;
create policy "admin write employee_skills" on bt_employee_skills for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
-- Admin and crew leads can write float assignments (crew needs to
-- end their own float when they return).
--
-- Note what this does and doesn't stop: a crew login can create and
-- edit ANY float row, not only its own — RLS can't compare the old row
-- to the new one, so "only set ended_at" isn't expressible here. It
-- would take a security-definer function to hold that line. Fine for a
-- floor where every tablet is trusted; not if that changes.
drop policy if exists "admin write float_assignments" on bt_float_assignments;
create policy "admin write float_assignments" on bt_float_assignments for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
drop policy if exists "crew insert float_assignments" on bt_float_assignments;
create policy "crew insert float_assignments" on bt_float_assignments for insert with check (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'crew')
);
drop policy if exists "crew update float_assignments" on bt_float_assignments;
create policy "crew update float_assignments" on bt_float_assignments for update using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'crew')
) with check (
  -- Without this a crew login passes the USING check on the old row and
  -- can then write anything at all into the new one.
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
