-- ============================================================
-- Logins — run in the Supabase SQL editor. Safe to run again.
--
--   1. Creates any login in the list below that doesn't exist yet in
--      Authentication → Users (email + password, already confirmed).
--      Logins that exist are left alone — their passwords are NOT touched.
--   2. Links every login to its role and department (bt_profiles and
--      bt_profile_departments), updating existing ones.
--   3. Shows a check of every login.
--
-- Change the password on the next line first, and change it again from
-- Authentication → Users once people are using the logins.
--
-- TV logins (tv-mods@…, tv-v4t@…) are deliberately NOT linked to a role:
-- the TV board works with no role, and without one the login can't
-- change anything if someone opens it without ?tv= in the address.
-- They are created here if missing.
-- ============================================================

-- ── 1. Create the missing logins ─────────────────────────────
create extension if not exists pgcrypto;

with new_users as (
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  select
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    e.email, crypt('ChangeMe-2026!', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(),
    '', '', '', ''
  from (values
    ('admin@sunspace.local'), ('office@sunspace.local'), ('logistics@sunspace.local'),
    ('quality@sunspace.local'), ('shipping@sunspace.local'), ('mods-tablet@sunspace.local'),
    ('v4t@sunspace.local'), ('panel@sunspace.local'), ('track@sunspace.local'), ('door@sunspace.local'),
    ('sc220@sunspace.local'), ('ta144@sunspace.local'), ('manual@sunspace.local'),
    ('tv-mods@sunspace.local'), ('tv-v4t@sunspace.local')
  ) as e(email)
  where not exists (select 1 from auth.users u where lower(u.email) = e.email)
  returning id, email
)
insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), n.id, n.id::text, 'email',
       jsonb_build_object('sub', n.id::text, 'email', n.email, 'email_verified', true),
       now(), now(), now()
from new_users n;


-- ── 2. Link roles and departments ────────────────────────────
with wanted(email, role, department, display_name) as (
  values
    ('admin@sunspace.local',     'admin',     null,    'Admin'),
    ('office@sunspace.local',    'office',    null,    'Office'),
    ('logistics@sunspace.local', 'logistics', null,    'Logistics'),
    ('quality@sunspace.local',   'quality',   null,    'Andrew (Quality)'),
    ('shipping@sunspace.local',  'shipping',  null,    'Shipping'),
    ('mods-tablet@sunspace.local', 'crew',    'Mods',  'Mods Tablet'),
    ('v4t@sunspace.local',       'crew',      'V4T',   'V4T Tablet'),
    ('panel@sunspace.local',     'crew',      'Panel', 'Panel Tablet'),
    ('track@sunspace.local',     'crew',      'Track', 'Track Tablet'),
    ('door@sunspace.local',      'crew',      'Door',  'Door Tablet'),
    -- Cutting stations (schema_v21.sql): each CNC / saw station opens the
    -- site on its own screen and marks its jobs Start / Done.
    ('sc220@sunspace.local',     'crew',      'SC220',      'SC220 CNC'),
    ('ta144@sunspace.local',     'crew',      'TA144',      'TA144 CNC'),
    ('manual@sunspace.local',    'crew',      'Manual Cut', 'Manual Cut')
),
linked as (
  insert into bt_profiles (user_id, role, department_id, display_name)
  select u.id, w.role, d.id, w.display_name
  from wanted w
  join auth.users u on lower(u.email) = lower(w.email)
  left join bt_departments d on d.name = w.department
  on conflict (user_id) do update
    set role = excluded.role,
        department_id = excluded.department_id,
        display_name = excluded.display_name
  returning user_id, department_id
)
-- A crew tablet can only change its own department's jobs; that
-- permission comes from this table, so every tablet needs its row.
insert into bt_profile_departments (user_id, department_id)
select user_id, department_id from linked where department_id is not null
on conflict do nothing;


-- ── 3. Check ─────────────────────────────────────────────────
-- Every login and what it can do. A blank role means the email
-- above has no matching user in Authentication → Users yet.
select w.email, u.id is not null as user_exists, p.role, p.display_name,
       string_agg(d.name, ', ') as departments
from (values
    ('admin@sunspace.local'), ('office@sunspace.local'), ('logistics@sunspace.local'),
    ('quality@sunspace.local'), ('shipping@sunspace.local'), ('mods-tablet@sunspace.local'),
    ('v4t@sunspace.local'), ('panel@sunspace.local'), ('track@sunspace.local'), ('door@sunspace.local'),
    ('sc220@sunspace.local'), ('ta144@sunspace.local'), ('manual@sunspace.local'),
    ('tv-mods@sunspace.local'), ('tv-v4t@sunspace.local')
  ) as w(email)
left join auth.users u on lower(u.email) = lower(w.email)
left join bt_profiles p on p.user_id = u.id
left join bt_profile_departments pd on pd.user_id = u.id
left join bt_departments d on d.id = pd.department_id
group by w.email, u.id, p.role, p.display_name
order by w.email;
