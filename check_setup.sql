-- ============================================================
-- Setup check — read-only, changes nothing. Paste into the Supabase
-- SQL editor and run. One table comes back: every row with status
-- PROBLEM needs a look; OK and INFO rows are fine.
-- ============================================================

with
expected(email, role, department) as (
  values
    ('admin@sunspace.local',       'admin',     null),
    ('office@sunspace.local',      'office',    null),
    ('logistics@sunspace.local',   'logistics', null),
    ('quality@sunspace.local',     'quality',   null),
    ('shipping@sunspace.local',    'shipping',  null),
    ('mods-tablet@sunspace.local', 'crew',      'Mods'),
    ('v4t@sunspace.local',         'crew',      'V4T'),
    ('panel@sunspace.local',       'crew',      'Panel'),
    ('track@sunspace.local',       'crew',      'Track'),
    ('door@sunspace.local',        'crew',      'Door'),
    ('sc220@sunspace.local',       'crew',      'SC220'),
    ('ta144@sunspace.local',       'crew',      'TA144'),
    ('manual@sunspace.local',      'crew',      'Manual Cut')
),

-- 1. Each expected login: exists, confirmed, right role, right department
logins as (
  select '1 login' as area, e.email as item,
    case
      when u.id is null                                  then 'PROBLEM'
      when u.email_confirmed_at is null                  then 'PROBLEM'
      when p.user_id is null                             then 'PROBLEM'
      when p.role is distinct from e.role                then 'PROBLEM'
      when e.department is not null and not exists (
             select 1 from bt_profile_departments pd
             join bt_departments d on d.id = pd.department_id
             where pd.user_id = u.id and d.name = e.department) then 'PROBLEM'
      else 'OK' end as status,
    case
      when u.id is null                    then 'no user in Authentication → Users'
      when u.email_confirmed_at is null    then 'user not confirmed (tick Auto Confirm)'
      when p.user_id is null               then 'user has no bt_profiles row — run setup_logins.sql'
      when p.role is distinct from e.role  then 'role is ' || coalesce(p.role, 'blank') || ', expected ' || e.role
      when e.department is not null and not exists (
             select 1 from bt_profile_departments pd
             join bt_departments d on d.id = pd.department_id
             where pd.user_id = u.id and d.name = e.department)
                                           then 'not linked to ' || e.department || ' in bt_profile_departments'
      else p.role || coalesce(' · ' || e.department, '') end as detail
  from expected e
  left join auth.users u on lower(u.email) = lower(e.email)
  left join bt_profiles p on p.user_id = u.id
),

-- 2. Crew tablets must be linked to exactly the department on their profile
crew_links as (
  select '2 crew link', coalesce(p.display_name, p.user_id::text),
    case when p.department_id is null then 'PROBLEM'
         when not exists (select 1 from bt_profile_departments pd
                          where pd.user_id = p.user_id and pd.department_id = p.department_id) then 'PROBLEM'
         when exists (select 1 from bt_profile_departments pd
                      where pd.user_id = p.user_id and pd.department_id <> p.department_id) then 'INFO'
         else 'OK' end,
    case when p.department_id is null then 'crew profile has no department'
         when not exists (select 1 from bt_profile_departments pd
                          where pd.user_id = p.user_id and pd.department_id = p.department_id)
              then 'profile department missing from bt_profile_departments'
         when exists (select 1 from bt_profile_departments pd
                      where pd.user_id = p.user_id and pd.department_id <> p.department_id)
              then 'also linked to other departments (fine if intended)'
         else 'linked' end
  from bt_profiles p where p.role = 'crew'
),

-- 3. Strays
strays as (
  select '3 stray', coalesce(u.email, p.user_id::text), 'PROBLEM',
         'bt_profiles row with no auth user'
  from bt_profiles p left join auth.users u on u.id = p.user_id where u.id is null
  union all
  select '3 stray', u.email, 'INFO',
         'login with no profile (expected only for TV logins like tv-mods@)'
  from auth.users u left join bt_profiles p on p.user_id = u.id where p.user_id is null
  union all
  select '3 stray', u.email, 'PROBLEM', 'login not in the expected list but has a profile'
  from auth.users u join bt_profiles p on p.user_id = u.id
  where lower(u.email) not in (select email from expected)
),

-- 4. Departments: each has status columns
depts as (
  select '4 department', d.name,
         case when count(dc.status_column_id) = 0 then 'PROBLEM' else 'OK' end,
         count(dc.status_column_id) || ' status column(s)'
  from bt_departments d left join bt_department_columns dc on dc.department_id = d.id
  group by d.id, d.name
),

-- 5. Row-level security on every bt_ table, and policies present
rls as (
  select '5 security', c.relname,
         case when not c.relrowsecurity then 'PROBLEM'
              when count(pol.polname) = 0 then 'PROBLEM' else 'OK' end,
         case when not c.relrowsecurity then 'RLS is OFF — anyone with the key can read/write'
              when count(pol.polname) = 0 then 'RLS on but no policy (locked to everyone)'
              else count(pol.polname) || ' polic' || case when count(pol.polname)=1 then 'y' else 'ies' end end
  from pg_class c
  left join pg_policy pol on pol.polrelid = c.oid
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'bt\_%'
  group by c.oid, c.relname, c.relrowsecurity
),

-- 6. Functions: nobody signed-out may run any bt_ function
funcs as (
  select '6 function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         case when has_function_privilege('anon', p.oid, 'execute') then 'PROBLEM'
              when not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') then 'PROBLEM'
              else 'OK' end,
         case when has_function_privilege('anon', p.oid, 'execute') then 'signed-out users can run this'
              when not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') then 'search_path not fixed'
              when has_function_privilege('authenticated', p.oid, 'execute') then 'signed-in only'
              else 'nobody (trigger / internal)' end
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname like 'bt\_%' and p.prokind = 'f'
),

-- 7. Migrations: markers of v23-v28
versions as (
  select '7 migration', m.item,
         case when m.ok then 'OK' else 'PROBLEM' end,
         case when m.ok then 'present' else 'missing — run ' || m.file end
  from (values
    ('v23 bt_files',               to_regclass('public.bt_files') is not null,               'schema_v23.sql'),
    ('v23 bt_order_quantities',    to_regclass('public.bt_order_quantities') is not null,    'schema_v23.sql'),
    ('v25 bt_column_measures',     to_regclass('public.bt_column_measures') is not null,     'schema_v25.sql'),
    ('v26 bt_measure_editors',     to_regclass('public.bt_measure_editors') is not null,     'schema_v26.sql'),
    ('v26 bt_can_edit_measure()',  to_regprocedure('public.bt_can_edit_measure(text)') is not null, 'schema_v26.sql'),
    ('v27 trigger fns locked',
       coalesce(not has_function_privilege('authenticated', to_regprocedure('public.bt_close_sent_back()'), 'execute'), false),
       'schema_v27.sql'),
    ('v28 no bt_ function open to signed-out users',
       not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname like 'bt\_%' and has_function_privilege('anon', p.oid, 'execute')),
       'schema_v28.sql')
  ) as m(item, ok, file)
),

-- 8. Realtime: the live tables the app listens to
rt as (
  select '8 realtime', t.name,
         case when exists (select 1 from pg_publication_tables x
                           where x.pubname = 'supabase_realtime' and x.schemaname = 'public' and x.tablename = t.name)
              then 'OK' else 'PROBLEM' end,
         'in supabase_realtime publication'
  from (values ('bt_order_status'), ('bt_orders'), ('bt_events'), ('bt_order_quantities'), ('bt_quality_issues')) as t(name)
),

-- 9. Leftovers from the inventory app (should be gone from this project)
leftovers as (
  select '9 leftover', c.relname, 'PROBLEM', 'inventory table still in this project'
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and c.relname in ('items', 'people', 'checkouts', 'jobs', 'safety_findings', 'safety_actions',
                      'tools', 'workshops', 'locations')
  union all
  select '9 leftover', 'storage bucket ' || b.name, 'INFO', 'delete once files are confirmed copied'
  from storage.buckets b where b.name = 'safety-photos'
)

select * from (
  select * from logins union all select * from crew_links union all select * from strays
  union all select * from depts union all select * from rls union all select * from funcs
  union all select * from versions union all select * from rt union all select * from leftovers
) r(area, item, status, detail)
order by (status = 'OK'), status, area, item;
