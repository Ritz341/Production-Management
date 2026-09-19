-- ============================================================
-- Migration v14 — run AFTER schema_v13.sql
--
-- The data layer for reporting:
--   1. Activity log — every start / done / block / clear / move / cancel,
--      time-stamped, written by the database itself so nothing is missed.
--   2. Block categories (plus the note).
--   3. Quality issues, including "send back": the department that finds a
--      bad part reopens the job of the department that made it.
--   4. 'quality' login (Andrew).
--   5. Order details for estimating: mods, room shape, windows, panels.
--   6. Who built it (optional names per department per order).
--   7. Settings (rates, shift, difficulty) — editable, not hard-coded.
--   8. Crew per department per day (for daily targets).
--   9. Panel department: Roof Panel renamed, filler/acrylic/extrusions added.
-- ============================================================


-- ── 1. Timestamps on each department job ──────────────────
-- Kept on the row so reports don't have to replay the log for the
-- common questions ("when did V4T start/finish #3?").
alter table bt_order_status add column if not exists started_at timestamptz;
alter table bt_order_status add column if not exists completed_at timestamptz;
alter table bt_order_status add column if not exists blocked_category text;
alter table bt_order_status add column if not exists built_by text;

create table if not exists bt_activity (
  id                bigint generated always as identity primary key,
  at                timestamptz not null default now(),
  order_id          bigint references bt_orders(id) on delete cascade,
  status_column_id  bigint references bt_status_columns(id) on delete set null,
  kind              text not null check (kind in (
                      'started', 'done', 'reopened', 'blocked', 'unblocked',
                      'dept_removed', 'dept_restored', 'moved', 'cancelled', 'restored',
                      'order_added', 'quality_issue', 'quality_resolved', 'sent_back')),
  from_stage        text,
  to_stage          text,
  category          text,
  note              text,
  actor             uuid default auth.uid()
);
create index if not exists bt_activity_at on bt_activity (at);
create index if not exists bt_activity_order on bt_activity (order_id);

alter table bt_activity enable row level security;
drop policy if exists "authenticated read" on bt_activity;
create policy "authenticated read" on bt_activity for select using (auth.role() = 'authenticated');
-- Written only by the triggers and functions below (security definer).

-- Stamp started/completed times on the row itself.
create or replace function bt_order_status_stamp()
returns trigger language plpgsql as $$
begin
  if new.workflow_stage is distinct from old.workflow_stage then
    if new.workflow_stage = 'started' then
      new.started_at := coalesce(old.started_at, now());
      new.completed_at := null;
    elsif new.workflow_stage in ('completed', 'packaged', 'shipped') then
      new.started_at := coalesce(old.started_at, now());
      new.completed_at := now();
    elsif new.workflow_stage is null then
      new.started_at := null;
      new.completed_at := null;
    end if;
  end if;
  if new.blocked_at is null then
    new.blocked_category := null;
  end if;
  return new;
end $$;

drop trigger if exists bt_order_status_stamp on bt_order_status;
create trigger bt_order_status_stamp
  before update on bt_order_status
  for each row execute function bt_order_status_stamp();

-- Log every change to a department job.
create or replace function bt_order_status_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.workflow_stage is distinct from old.workflow_stage then
    insert into bt_activity (order_id, status_column_id, kind, from_stage, to_stage)
    values (new.order_id, new.status_column_id,
      case
        when new.workflow_stage = 'started' and old.workflow_stage is null then 'started'
        when new.workflow_stage in ('completed', 'packaged', 'shipped') then 'done'
        else 'reopened'
      end,
      old.workflow_stage, new.workflow_stage);
  end if;

  if new.blocked_at is distinct from old.blocked_at then
    if new.blocked_at is not null then
      insert into bt_activity (order_id, status_column_id, kind, category, note)
      values (new.order_id, new.status_column_id, 'blocked', new.blocked_category, new.blocked_note);
    else
      insert into bt_activity (order_id, status_column_id, kind, category, note)
      values (new.order_id, new.status_column_id, 'unblocked', old.blocked_category, old.blocked_note);
    end if;
  end if;

  if new.removed_at is distinct from old.removed_at then
    insert into bt_activity (order_id, status_column_id, kind, note)
    values (new.order_id, new.status_column_id,
      case when new.removed_at is not null then 'dept_removed' else 'dept_restored' end,
      coalesce(new.removed_note, old.removed_note));
  end if;
  return new;
end $$;

drop trigger if exists bt_order_status_log on bt_order_status;
create trigger bt_order_status_log
  after update on bt_order_status
  for each row execute function bt_order_status_log();

-- Log order-level changes.
create or replace function bt_orders_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into bt_activity (order_id, kind, note) values (new.id, 'order_added', new.tag_name);
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into bt_activity (order_id, kind, note)
    values (new.id, case when new.status = 'cancelled' then 'cancelled' else 'restored' end, new.cancel_reason);
  end if;
  if new.moved_at is distinct from old.moved_at and new.moved_at is not null then
    insert into bt_activity (order_id, kind, note) values (new.id, 'moved', new.moved_direction);
  end if;
  return new;
end $$;

drop trigger if exists bt_orders_log on bt_orders;
create trigger bt_orders_log
  after insert or update on bt_orders
  for each row execute function bt_orders_log();

-- Floor alert wording to match the simplified steps (Started / Done),
-- with the block category included.
create or replace function bt_log_order_status_changed()
returns trigger language plpgsql as $$
declare
  v_tag text;
  v_col text;
begin
  if new.workflow_stage is distinct from old.workflow_stage then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    insert into bt_events (order_id, event_type, message)
    values (new.order_id, 'order_status_changed', v_col || ' on ' || v_tag || ' → ' ||
      case
        when new.workflow_stage = 'started' then 'Started'
        when new.workflow_stage in ('completed', 'packaged', 'shipped') then 'Done'
        else 'Not started'
      end);
  end if;

  if new.blocked_at is distinct from old.blocked_at then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    if new.blocked_at is not null then
      insert into bt_events (order_id, event_type, message)
      values (new.order_id, 'order_status_changed', '🚫 ' || v_col || ' on ' || v_tag || ' BLOCKED — ' ||
        coalesce(new.blocked_category, 'other') || coalesce(': ' || new.blocked_note, ''));
    else
      insert into bt_events (order_id, event_type, message)
      values (new.order_id, 'order_status_changed', v_col || ' on ' || v_tag || ' unblocked');
    end if;
  end if;
  return new;
end $$;


-- ── 2. Quality issues ──────────────────────────────────────
alter table bt_profiles drop constraint if exists bt_profiles_role_check;
alter table bt_profiles add constraint bt_profiles_role_check
  check (role in ('admin', 'crew', 'shipping', 'logistics', 'office', 'quality'));

create table if not exists bt_quality_issues (
  id                     bigint generated always as identity primary key,
  created_at             timestamptz not null default now(),
  order_id               bigint not null references bt_orders(id) on delete cascade,
  responsible_column_id  bigint references bt_status_columns(id) on delete set null, -- who made it
  reporter_column_id     bigint references bt_status_columns(id) on delete set null, -- who found it (if a department)
  defect_type            text not null,
  note                   text,
  sent_back              boolean not null default false,
  reported_by            uuid default auth.uid(),
  resolved_at            timestamptz,
  resolved_by            uuid,
  resolution_note        text
);
create index if not exists bt_quality_issues_order on bt_quality_issues (order_id);

alter table bt_quality_issues enable row level security;
drop policy if exists "authenticated read" on bt_quality_issues;
create policy "authenticated read" on bt_quality_issues for select using (auth.role() = 'authenticated');
-- Written only through the functions below.

alter table bt_events drop constraint if exists bt_events_event_type_check;
alter table bt_events add constraint bt_events_event_type_check
  check (event_type in (
    'ship_date_changed', 'column_completed', 'order_picked_up', 'column_started',
    'order_status_changed', 'order_added', 'quality_issue'
  ));

-- Report a quality problem. With p_send_back, the responsible
-- department's job is reopened (back to Not started, flagged), and the
-- reporting department's own job is blocked until the rework is done.
create or replace function bt_report_quality(
  p_order_id bigint,
  p_responsible_column_id bigint,
  p_defect_type text,
  p_note text,
  p_send_back boolean default false,
  p_reporter_column_id bigint default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_tag text;
  v_resp text;
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role in ('crew', 'admin', 'quality')) then
    raise exception 'This login cannot report quality issues';
  end if;
  if p_send_back and p_responsible_column_id is null then
    raise exception 'Pick which department to send it back to';
  end if;

  insert into bt_quality_issues (order_id, responsible_column_id, reporter_column_id, defect_type, note, sent_back)
  values (p_order_id, p_responsible_column_id, p_reporter_column_id, p_defect_type, nullif(trim(p_note), ''), p_send_back)
  returning id into v_id;

  insert into bt_activity (order_id, status_column_id, kind, category, note)
  values (p_order_id, p_responsible_column_id, 'quality_issue', p_defect_type, p_note);

  select tag_name into v_tag from bt_orders where id = p_order_id;
  select name into v_resp from bt_status_columns where id = p_responsible_column_id;

  if p_send_back then
    update bt_order_status set workflow_stage = null
    where order_id = p_order_id and status_column_id = p_responsible_column_id;
    insert into bt_activity (order_id, status_column_id, kind, category, note)
    values (p_order_id, p_responsible_column_id, 'sent_back', p_defect_type, p_note);

    if p_reporter_column_id is not null then
      update bt_order_status
      set blocked_at = now(), blocked_category = 'waiting_dept',
          blocked_note = 'Waiting on ' || coalesce(v_resp, 'rework') || ' — ' || replace(p_defect_type, '_', ' ')
      where order_id = p_order_id and status_column_id = p_reporter_column_id and blocked_at is null;
    end if;
  end if;

  insert into bt_events (order_id, event_type, message)
  values (p_order_id, 'quality_issue',
    '⚑ Quality: ' || replace(p_defect_type, '_', ' ') || coalesce(' — ' || v_resp, '') || ' on ' || v_tag ||
    case when p_send_back then ' (sent back)' else '' end);
  return v_id;
end $$;

create or replace function bt_resolve_quality(p_issue_id bigint, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_issue bt_quality_issues%rowtype;
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role in ('admin', 'quality')) then
    raise exception 'Only admin or quality can close issues';
  end if;
  update bt_quality_issues
  set resolved_at = now(), resolved_by = auth.uid(), resolution_note = nullif(trim(p_note), '')
  where id = p_issue_id and resolved_at is null
  returning * into v_issue;
  if found then
    insert into bt_activity (order_id, status_column_id, kind, category, note)
    values (v_issue.order_id, v_issue.responsible_column_id, 'quality_resolved', v_issue.defect_type, p_note);
  end if;
end $$;

-- When a sent-back job is marked Done again, close its issue and lift
-- the block it put on the department that was waiting.
create or replace function bt_close_sent_back()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_issue record;
begin
  if new.workflow_stage in ('completed', 'packaged', 'shipped')
     and old.workflow_stage is distinct from new.workflow_stage then
    for v_issue in
      update bt_quality_issues
      set resolved_at = now(), resolution_note = 'Reworked and marked Done'
      where order_id = new.order_id and responsible_column_id = new.status_column_id
        and sent_back and resolved_at is null
      returning *
    loop
      insert into bt_activity (order_id, status_column_id, kind, category, note)
      values (v_issue.order_id, v_issue.responsible_column_id, 'quality_resolved', v_issue.defect_type, 'Reworked');
      if v_issue.reporter_column_id is not null then
        update bt_order_status set blocked_at = null, blocked_note = null
        where order_id = v_issue.order_id and status_column_id = v_issue.reporter_column_id
          and blocked_category = 'waiting_dept';
      end if;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists bt_close_sent_back on bt_order_status;
create trigger bt_close_sent_back
  after update on bt_order_status
  for each row execute function bt_close_sent_back();


-- ── 3. Order details (for estimating) ──────────────────────
alter table bt_orders add column if not exists mods_count integer check (mods_count is null or mods_count >= 0);
alter table bt_orders add column if not exists room_shape text check (room_shape in ('square', 'pitched', 'gable'));
alter table bt_orders add column if not exists window_type text check (window_type in ('v4t', 'vinyl_fix', 'trap_glass'));
alter table bt_orders add column if not exists panel_type text check (panel_type in ('insulated_2in', 'double_foam', 'full_filler'));

-- Office, logistics and admin fill these in; a function so office can
-- set only these fields.
create or replace function bt_set_order_details(
  p_order_id bigint, p_mods_count integer, p_room_shape text, p_window_type text, p_panel_type text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from bt_profiles where user_id = auth.uid() and role in ('admin', 'office', 'logistics')) then
    raise exception 'This login cannot edit order details';
  end if;
  update bt_orders
  set mods_count = p_mods_count, room_shape = p_room_shape, window_type = p_window_type, panel_type = p_panel_type
  where id = p_order_id;
end $$;


-- ── 4. Settings ────────────────────────────────────────────
create table if not exists bt_settings (
  key    text primary key,
  value  jsonb not null
);
alter table bt_settings enable row level security;
drop policy if exists "authenticated read" on bt_settings;
create policy "authenticated read" on bt_settings for select using (auth.role() = 'authenticated');
drop policy if exists "admin write settings" on bt_settings;
create policy "admin write settings" on bt_settings for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

insert into bt_settings (key, value) values
  -- Complete mods (framing + staging) one person builds in a day.
  -- Placeholder until the time study.
  ('mods_per_person_day', '3'),
  -- Mods crew assumed when a day's headcount hasn't been entered.
  ('default_mods_crew', '4'),
  ('shift', '{"start": "07:30", "end": "16:00", "breaks": [
      {"start": "09:00", "end": "09:15", "paid": true},
      {"start": "12:00", "end": "12:30", "paid": false},
      {"start": "14:00", "end": "14:15", "paid": true}],
    "workdays": [1, 2, 3, 4, 5]}'),
  -- How much harder than an easy mod each level is (1 = easy).
  ('difficulty_multiplier', '{"easy": 1.0, "medium": 1.25, "hard": 1.5}'),
  -- Room size by mods: up to 'small' is small, up to 'medium' is medium, above is large.
  ('size_bands', '{"small": 10, "medium": 14}')
on conflict (key) do nothing;


-- ── 5. Crew per department per day ─────────────────────────
create table if not exists bt_crew_days (
  work_date      date not null,
  department_id  bigint not null references bt_departments(id) on delete cascade,
  people         numeric(4, 1) not null check (people >= 0),
  note           text,
  primary key (work_date, department_id)
);
alter table bt_crew_days enable row level security;
drop policy if exists "authenticated read" on bt_crew_days;
create policy "authenticated read" on bt_crew_days for select using (auth.role() = 'authenticated');
drop policy if exists "admin write crew" on bt_crew_days;
create policy "admin write crew" on bt_crew_days for all using (
  exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);


-- ── 6. Panel department ────────────────────────────────────
update bt_departments set name = 'Panel' where name = 'Roof Panel';

insert into bt_status_columns (name, sort_order) values ('Mod Filler Panels', 26)
on conflict (name) do nothing;

insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'Panel' and s.name in ('Roof Panels', 'Roof Extr.', 'Acrylic', 'Mod Filler Panels')
on conflict do nothing;


-- ── 7. Realtime for the new tables ─────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_quality_issues') then
    alter publication supabase_realtime add table bt_quality_issues;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_settings') then
    alter publication supabase_realtime add table bt_settings;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_crew_days') then
    alter publication supabase_realtime add table bt_crew_days;
  end if;
end $$;
