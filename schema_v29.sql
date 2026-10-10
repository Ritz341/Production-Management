-- ============================================================
-- Migration v29 — run AFTER schema_v28.sql. Safe to re-run.
--
-- Setup → Who can cover failed with "Could not find the table
-- 'public.v_cross_dept_floaters' in the schema cache": the two skill
-- views from schema_v18.sql are missing from the database. This puts
-- them back exactly as v18 defined them, then:
--   * makes them obey the row-level security underneath (security_invoker)
--   * lets signed-in users read them, signed-out users not
--   * tells the API (PostgREST) to reload, so the screen sees them at once
-- Needs bt_employees, bt_employee_skills, bt_skills, bt_departments and
-- bt_float_assignments (all from v18, still present).
-- ============================================================

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

alter view v_cross_dept_floaters set (security_invoker = on);
alter view v_employee_versatility set (security_invoker = on);

revoke all on v_cross_dept_floaters, v_employee_versatility from public, anon;
grant select on v_cross_dept_floaters, v_employee_versatility to authenticated;

notify pgrst, 'reload schema';

-- Check: both views listed, security_invoker on, signed-out users locked out.
select c.relname as view,
       coalesce(c.reloptions::text like '%security_invoker=on%', false) as security_invoker,
       has_table_privilege('anon', c.oid, 'select') as signed_out_can_read
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('v_cross_dept_floaters', 'v_employee_versatility')
order by 1;
