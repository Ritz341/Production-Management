-- ============================================================
-- Migration v2 — run AFTER schema.sql, seed.sql, import_data.sql
-- Adds: Build Weeks, per-order column visibility, and an events
-- table that powers live banners (ship date changes, completions).
-- ============================================================

create table if not exists bt_build_weeks (
  id            bigint generated always as identity primary key,
  label         text not null,             -- e.g. 'Sept 15 Build Week'
  ship_date     date,                       -- admin-set pickup/ship date, editable mid-week
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function bt_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bt_build_weeks_set_updated_at on bt_build_weeks;
create trigger bt_build_weeks_set_updated_at
  before update on bt_build_weeks
  for each row execute function bt_set_updated_at();

-- Orders now belong to a build week. Nullable so existing 245 rows
-- from the first import keep working; assign them to a week whenever.
alter table bt_orders add column if not exists build_week_id bigint references bt_build_weeks(id);

-- Per-order override: a column can be present in the sheet for a tag
-- but not actually apply at this plant (e.g. sheet shows 'Doors' but
-- Truesdale doesn't cut doors for this order) — admin unchecks it in
-- the import preview, and the floor never sees it for that tag.
alter table bt_order_status add column if not exists is_visible boolean not null default true;

-- Events power the live banner: ship date changes and column
-- completions. Nullable order_id/build_week_id lets one row cover
-- either an order-specific event or a whole-build-week broadcast.
create table if not exists bt_events (
  id              bigint generated always as identity primary key,
  order_id        bigint references bt_orders(id) on delete cascade,
  build_week_id   bigint references bt_build_weeks(id) on delete cascade,
  event_type      text not null check (event_type in ('ship_date_changed', 'column_completed')),
  message         text not null,
  created_at      timestamptz not null default now()
);

alter table bt_build_weeks enable row level security;
alter table bt_events enable row level security;

create policy "authenticated read" on bt_build_weeks for select using (auth.role() = 'authenticated');
create policy "admin write build_weeks" on bt_build_weeks for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

create policy "authenticated read" on bt_events for select using (auth.role() = 'authenticated');
create policy "authenticated insert events" on bt_events for insert with check (auth.role() = 'authenticated');

-- Auto-log an event whenever a column gets marked complete ('C'),
-- so the banner fires no matter which screen made the edit.
create or replace function bt_log_column_completed()
returns trigger language plpgsql as $$
declare
  v_tag text;
  v_col text;
begin
  if new.status_value is not null
     and lower(trim(new.status_value)) = 'c'
     and (old.status_value is null or lower(trim(old.status_value)) <> 'c') then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    insert into bt_events (order_id, event_type, message)
    values (new.order_id, 'column_completed', v_col || ' completed for ' || v_tag);
  end if;
  return new;
end;
$$;

drop trigger if exists bt_order_status_log_completed on bt_order_status;
create trigger bt_order_status_log_completed
  after insert or update on bt_order_status
  for each row execute function bt_log_column_completed();

-- Auto-log an event whenever a build week's ship date changes.
create or replace function bt_log_ship_date_changed()
returns trigger language plpgsql as $$
begin
  if new.ship_date is distinct from old.ship_date then
    insert into bt_events (build_week_id, event_type, message)
    values (
      new.id,
      'ship_date_changed',
      new.label || ' ship date changed to ' || coalesce(to_char(new.ship_date, 'Mon DD'), 'unset')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists bt_build_weeks_log_ship_date on bt_build_weeks;
create trigger bt_build_weeks_log_ship_date
  after update on bt_build_weeks
  for each row execute function bt_log_ship_date_changed();
