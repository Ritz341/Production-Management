-- ============================================================
-- Migration v22 — run AFTER schema_v21.sql
--
-- Notifications, rethought.
--
-- What was wrong
--   * Every event went to every login. A Start on the Mods tablet put a
--     toast AND a bell entry on every other tablet in the building, so
--     the bell filled with other departments' routine work and the
--     things that matter (a block, a quality problem) were lost in it.
--   * Every Start / Done wrote two events (column_started + the status
--     change), and importing a sheet with C cells wrote a "completed"
--     event per cell — a toast storm on every tablet at once.
--   * Acknowledging was global: one tablet tapping Acknowledge removed
--     a ship-date banner from every other tablet, unseen.
--   * Nothing reached the TVs.
--
-- What this does
--   Every event now has a LEVEL and an AUDIENCE, decided here, in one
--   place, when it's written:
--
--     stop     must be seen and acknowledged, per login: a ship date
--              moving, orders taken off the build (everyone, TVs
--              included), a quality problem (the department it points
--              at, plus quality / office / admin)
--     headsup  the bell: a block or unblock (office, admin, logistics),
--              and a job finishing that another department was waiting
--              on (V4T done -> Mods; a cut job done -> the department
--              it feeds)
--     fyi      a toast: a new order (floor + office), a pickup
--              (shipping + office)
--     quiet    log only — every ordinary Start / Done, and the old
--              duplicate event types. Still in the admin activity feed.
--
--   Audience tokens: 'all', 'role:<role>', 'dept:<department name>'.
--   Acknowledgements are per login (bt_event_acks), so one tablet
--   clearing an alert no longer clears it everywhere.
--
-- Existing events become 'quiet', so nothing old resurfaces.
-- Safe to re-run.
-- ============================================================


-- ── 1. Level, audience, and what an event is about ───────────
alter table bt_events add column if not exists level text not null default 'quiet'
  check (level in ('stop', 'headsup', 'fyi', 'quiet'));
alter table bt_events add column if not exists audience text[] not null default '{}';
alter table bt_events add column if not exists status_column_id bigint references bt_status_columns(id) on delete set null;
alter table bt_events add column if not exists kind text;

create index if not exists bt_events_alerts_idx on bt_events (created_at desc) where level <> 'quiet';


-- ── 2. Who an event is for ───────────────────────────────────
-- Departments that own a job.
create or replace function bt_depts_of_column(p_col bigint) returns text[]
language sql stable as $$
  select coalesce(array_agg(distinct 'dept:' || d.name), '{}')
  from bt_department_columns dc
  join bt_departments d on d.id = dc.department_id
  where dc.status_column_id = p_col
$$;

-- Departments waiting on a job: those whose job can't be completed until
-- this one is (bt_column_dependencies), and the department that owns the
-- sheet column a cut job feeds (bt_cut_follows).
create or replace function bt_dependents_of_column(p_col bigint) returns text[]
language sql stable as $$
  select coalesce(array_agg(distinct s.token), '{}')
  from (
    select 'dept:' || d.name as token
    from bt_column_dependencies cd
    join bt_department_columns dc on dc.status_column_id = cd.column_id
    join bt_departments d on d.id = dc.department_id
    where cd.depends_on_column_id = p_col
    union
    select 'dept:' || d.name
    from bt_cut_follows f
    join bt_department_columns dc on dc.status_column_id = f.source_column_id
    join bt_departments d on d.id = dc.department_id
    where f.cut_column_id = p_col
  ) s
$$;

create or replace function bt_events_route() returns trigger
language plpgsql as $$
declare
  v_mgmt text[] := array['role:office', 'role:admin', 'role:logistics'];
  v_dependents text[];
begin
  new.level := 'quiet';
  new.audience := '{}';

  if new.event_type in ('ship_date_changed', 'orders_removed') then
    new.level := 'stop';
    new.audience := array['all'];

  elsif new.event_type = 'quality_issue' then
    new.level := 'stop';
    new.audience := bt_depts_of_column(new.status_column_id) || array['role:quality', 'role:office', 'role:admin'];

  elsif new.event_type = 'order_status_changed' and new.kind in ('blocked', 'unblocked') then
    new.level := 'headsup';
    new.audience := v_mgmt;

  elsif new.event_type = 'order_status_changed' and new.kind = 'done' then
    v_dependents := bt_dependents_of_column(new.status_column_id);
    if coalesce(array_length(v_dependents, 1), 0) > 0 then
      new.level := 'headsup';
      new.audience := v_dependents;
    end if;

  elsif new.event_type = 'order_added' then
    new.level := 'fyi';
    new.audience := array['role:crew', 'role:office', 'role:admin', 'role:logistics'];

  elsif new.event_type = 'order_picked_up' then
    new.level := 'fyi';
    new.audience := array['role:shipping', 'role:office', 'role:admin', 'role:logistics'];
  end if;

  return new;
end $$;

drop trigger if exists bt_events_route on bt_events;
create trigger bt_events_route
  before insert on bt_events
  for each row execute function bt_events_route();


-- ── 3. Per-login acknowledgement ─────────────────────────────
create table if not exists bt_event_acks (
  event_id  bigint not null references bt_events(id) on delete cascade,
  user_id   uuid not null default auth.uid(),
  acked_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table bt_event_acks enable row level security;
drop policy if exists "own acks read" on bt_event_acks;
create policy "own acks read" on bt_event_acks for select using (user_id = auth.uid());
drop policy if exists "own acks write" on bt_event_acks;
create policy "own acks write" on bt_event_acks for insert with check (user_id = auth.uid());
drop policy if exists "own acks delete" on bt_event_acks;
create policy "own acks delete" on bt_event_acks for delete using (user_id = auth.uid());


-- ── 4. The two writers say which job an event is about ───────
-- (copied from schema_v14.sql with the event row made routable; no other
-- change)
create or replace function bt_log_order_status_changed()
returns trigger language plpgsql as $$
declare
  v_tag text;
  v_col text;
begin
  if new.workflow_stage is distinct from old.workflow_stage then
    select tag_name into v_tag from bt_orders where id = new.order_id;
    select name into v_col from bt_status_columns where id = new.status_column_id;
    insert into bt_events (order_id, event_type, status_column_id, kind, message)
    values (new.order_id, 'order_status_changed', new.status_column_id,
      case
        when new.workflow_stage = 'started' then 'started'
        when new.workflow_stage in ('completed', 'packaged', 'shipped') then 'done'
        else 'reset'
      end,
      v_col || ' on ' || v_tag || ' → ' ||
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
      insert into bt_events (order_id, event_type, status_column_id, kind, message)
      values (new.order_id, 'order_status_changed', new.status_column_id,
        -- a block raised by sending work back is already announced by the quality event
        case when new.blocked_category = 'waiting_dept' then 'blocked_by_rework' else 'blocked' end,
        '🚫 ' || v_col || ' on ' || v_tag || ' BLOCKED — ' ||
        coalesce(new.blocked_category, 'other') || coalesce(': ' || new.blocked_note, ''));
    else
      insert into bt_events (order_id, event_type, status_column_id, kind, message)
      values (new.order_id, 'order_status_changed', new.status_column_id, 'unblocked', v_col || ' on ' || v_tag || ' unblocked');
    end if;
  end if;
  return new;
end $$;

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

  insert into bt_events (order_id, event_type, status_column_id, kind, message)
  values (p_order_id, 'quality_issue', p_responsible_column_id, 'quality',
    '⚑ Quality: ' || replace(p_defect_type, '_', ' ') || coalesce(' — ' || v_resp, '') || ' on ' || v_tag ||
    case when p_send_back then ' (sent back)' else '' end);
  return v_id;
end $$;


-- ── 5. Realtime for the acknowledgements ─────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bt_event_acks') then
    alter publication supabase_realtime add table bt_event_acks;
  end if;
end $$;
