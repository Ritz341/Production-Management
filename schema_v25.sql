-- ============================================================
-- Migration v25 — run AFTER schema_v24.sql
--
-- What pressing Done on a job counts.
--
-- A cut job's Done now credits the pieces it produced, worked out from the
-- order: an order with 4 mods needs, from SC220 Frames,
--   4 mod frames + 4 headers + 4 bottoms + 8 uprights.
--
-- Each credit is   factor × (a count on the order)
--   base_measure  the order count it is taken from: mods, v4t_frames, vents
--   factor        pieces per one of those (uprights: 2 per mod)
--   is_primary    the count one job's minutes are divided by when working
--                 out minutes per unit (mod frames, vents …)
--
-- The factors are data — Admin → Targets & TVs → "What Done counts" edits
-- them, so a different frame design is a number, not a code change.
--
-- Safe to re-run (it leaves factors you have already edited alone).
-- ============================================================

alter table bt_column_measures add column if not exists base_measure text;
alter table bt_column_measures add column if not exists factor       numeric not null default 1 check (factor >= 0);
alter table bt_column_measures add column if not exists is_primary   boolean not null default false;

-- the six rows v23 made were measure = base count, factor 1
update bt_column_measures set base_measure = measure where base_measure is null;

-- SC220 Frames used to credit "mods"; it now credits the pieces
delete from bt_column_measures cm
using bt_status_columns s
where s.id = cm.status_column_id and s.name = 'SC220 Frames' and cm.measure = 'mods';

insert into bt_column_measures (status_column_id, measure, base_measure, factor, is_primary)
select s.id, m.measure, m.base, m.factor, m.is_primary
from (values
  ('SC220 Frames',        'mod_frames',      'mods',       1, true),
  ('SC220 Frames',        'frame_headers',   'mods',       1, false),
  ('SC220 Frames',        'frame_bottoms',   'mods',       1, false),
  ('SC220 Frames',        'frame_uprights',  'mods',       2, false),
  ('SC220 Uprights',      'v4t_uprights',    'v4t_frames', 2, true),
  ('Manual Framing',      'v4t_head_sill',   'v4t_frames', 2, true),
  ('TA144 Vents',         'vents',           'vents',      1, true),
  ('Mods',                'mods',            'mods',       1, true),
  ('V4T',                 'v4t_frames',      'v4t_frames', 1, true)
) as m(col, measure, base, factor, is_primary)
join bt_status_columns s on s.name = m.col
on conflict (status_column_id, measure) do nothing;

-- the old SC220 Uprights / Manual Framing rows (measure v4t_frames)
-- would double-credit next to the new piece rows
delete from bt_column_measures cm
using bt_status_columns s
where s.id = cm.status_column_id
  and ((s.name = 'SC220 Uprights' and cm.measure = 'v4t_frames')
    or (s.name = 'Manual Framing' and cm.measure = 'v4t_frames'));

-- every column keeps one primary
update bt_column_measures cm set is_primary = true
where not exists (select 1 from bt_column_measures o where o.status_column_id = cm.status_column_id and o.is_primary)
  and cm.measure = (select min(x.measure) from bt_column_measures x where x.status_column_id = cm.status_column_id);


-- ── Units finished since a time ──────────────────────────────
-- Now factor × the order's base count. Mods fall back to the count the
-- office already types on the order.
create or replace function bt_units_done(p_since timestamptz, p_department text default null)
returns table (measure text, units numeric, orders bigint)
language sql stable security definer set search_path = public as $$
  with done as (
    select distinct a.order_id, a.status_column_id
    from bt_activity a
    where a.kind = 'done' and a.at >= p_since and a.order_id is not null
      and (
        p_department is null
        or exists (
          select 1 from bt_department_columns dc
          join bt_departments d on d.id = dc.department_id
          where dc.status_column_id = a.status_column_id and d.name = p_department
        )
      )
  ),
  credited as (
    select cm.measure, d.order_id,
           cm.factor * coalesce(q.qty, case when cm.base_measure = 'mods' then o.mods_count end) as units
    from done d
    join bt_column_measures cm on cm.status_column_id = d.status_column_id
    join bt_orders o on o.id = d.order_id
    left join bt_order_quantities q on q.order_id = d.order_id and q.measure = cm.base_measure
  )
  select c.measure, sum(c.units)::numeric, count(distinct c.order_id)
  from credited c
  where c.units is not null
  group by c.measure
$$;

revoke execute on function bt_units_done(timestamptz, text) from public, anon;
grant execute on function bt_units_done(timestamptz, text) to authenticated;

-- ── Check ────────────────────────────────────────────────────
-- select s.name, cm.measure, cm.base_measure, cm.factor, cm.is_primary
-- from bt_column_measures cm join bt_status_columns s on s.id = cm.status_column_id
-- order by s.name, cm.is_primary desc;
