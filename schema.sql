-- ============================================================
-- Department Tablet Tracker — schema
-- Additive to the existing Supabase project (SC220 Inventory).
-- All tables are prefixed "bt_" (Build Tracker) so nothing
-- collides with the existing inventory tables.
-- ============================================================

-- One row per real floor department that gets its own tablet/login.
-- Starts with 5, more get added over time — no schema change needed.
create table if not exists bt_departments (
  id            bigint generated always as identity primary key,
  name          text not null unique,           -- e.g. 'Mods', 'V4T', 'Track'
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

-- One row per column that appears in the build sheet (all 26).
-- These are the actual units of status/progress tracking.
create table if not exists bt_status_columns (
  id            bigint generated always as identity primary key,
  name          text not null unique,           -- e.g. 'Vin. Fix', 'Roof Panels'
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

-- Which status columns feed into which department's tablet view.
-- A column can belong to zero departments (unassigned, admin-only)
-- or, later, to more than one (your "combine departments" idea).
create table if not exists bt_department_columns (
  department_id     bigint not null references bt_departments(id) on delete cascade,
  status_column_id  bigint not null references bt_status_columns(id) on delete cascade,
  primary key (department_id, status_column_id)
);

-- One row per order / build-sheet line item (the "Tag Name").
create table if not exists bt_orders (
  id            bigint generated always as identity primary key,
  tag_name      text not null unique,           -- e.g. 'SB-PM-BLAIR-100_166168'
  truck_route   text,                           -- e.g. 'Pick Up', 'USA#1', 'Ont. Tues'
  dealer        text,
  shipping_status text,                         -- Truesdale tab's first column: 'Shipped', 'Shipped 7/16', 'Picked up 9/3', 'CREDIT HOLD', etc.
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The actual per-department-column status value for each order.
-- status_value stays text because the sheet mixes 'C', quantities
-- ('7'), milestones ('Arrived'), dates, and blanks.
create table if not exists bt_order_status (
  id                bigint generated always as identity primary key,
  order_id          bigint not null references bt_orders(id) on delete cascade,
  status_column_id  bigint not null references bt_status_columns(id) on delete cascade,
  status_value      text,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id),
  unique (order_id, status_column_id)
);

-- Files admin attaches to a specific Tag Name (drawings, cut sheets, POs).
-- Actual bytes live in Supabase Storage; this row just points to them.
create table if not exists bt_files (
  id              bigint generated always as identity primary key,
  order_id        bigint not null references bt_orders(id) on delete cascade,
  filename        text not null,
  storage_path    text not null,                -- path inside the Supabase Storage bucket
  uploaded_by     uuid references auth.users(id),
  uploaded_at     timestamptz not null default now()
);

-- Maps each login (a Supabase auth user) to a role and, for crew
-- logins, a home department. One shared login per tablet = one
-- row here per department, role = 'crew'. Admin accounts have
-- department_id = null.
create table if not exists bt_profiles (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  role            text not null check (role in ('admin', 'crew')),
  department_id   bigint references bt_departments(id),
  display_name    text,
  created_at      timestamptz not null default now()
);

-- Keep updated_at fresh on order edits.
create or replace function bt_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bt_orders_set_updated_at on bt_orders;
create trigger bt_orders_set_updated_at
  before update on bt_orders
  for each row execute function bt_set_updated_at();

-- ============================================================
-- Row Level Security
-- Crew can read everything (simplest for a shared tablet login)
-- but only admin can write. Tighten to department-scoped reads
-- later if you want tablets to not even see other departments'
-- raw rows (right now that's enforced in the app UI, not the DB).
-- ============================================================
alter table bt_departments enable row level security;
alter table bt_status_columns enable row level security;
alter table bt_department_columns enable row level security;
alter table bt_orders enable row level security;
alter table bt_order_status enable row level security;
alter table bt_files enable row level security;
alter table bt_profiles enable row level security;

create policy "authenticated read" on bt_departments for select using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_status_columns for select using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_department_columns for select using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_orders for select using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_order_status for select using (auth.role() = 'authenticated');
create policy "authenticated read" on bt_files for select using (auth.role() = 'authenticated');
create policy "self read" on bt_profiles for select using (auth.uid() = user_id);

create policy "admin write orders" on bt_orders for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write status" on bt_order_status for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write files" on bt_files for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write departments" on bt_departments for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write status_columns" on bt_status_columns for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
create policy "admin write department_columns" on bt_department_columns for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
