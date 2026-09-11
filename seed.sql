-- ============================================================
-- Seed: status columns (all 25, straight from the build sheet),
-- initial departments, and which columns feed which department.
-- Run this once, after schema.sql.
-- ============================================================

insert into bt_status_columns (name, sort_order) values
  ('Mods', 1),
  ('V4T', 2),
  ('Vin. Fix', 3),
  ('Vin. Trap', 4),
  ('Alum. Fix', 5),
  ('Alum. Trap', 6),
  ('XX', 7),
  ('H2/4', 8),
  ('PVC', 9),
  ('I-A', 10),
  ('Doors', 11),
  ('Roof Panels', 12),
  ('Roof Extr.', 13),
  ('Track', 14),
  ('Therm a deck', 15),
  ('Acrylic', 16),
  ('Deck', 17),
  ('Valance', 18),
  ('Rail', 19),
  ('PATIO Door', 20),
  ('Glass', 21),
  ('Pergola', 22),
  ('R. Screen', 23),
  ('Nova Sun', 24),
  ('Stairs', 25)
on conflict (name) do nothing;

insert into bt_departments (name, sort_order) values
  ('Mods', 1),
  ('V4T', 2),
  ('Track', 3),
  ('Roof Panel', 4),
  ('Door', 5)
on conflict (name) do nothing;

-- Mods department -> Mods column
insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'Mods' and s.name = 'Mods'
on conflict do nothing;

-- V4T department -> V4T, Vin. Fix, Vin. Trap
insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'V4T' and s.name in ('V4T', 'Vin. Fix', 'Vin. Trap')
on conflict do nothing;

-- Track department -> Track column
insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'Track' and s.name = 'Track'
on conflict do nothing;

-- Roof Panel department -> Roof Panels column
insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'Roof Panel' and s.name = 'Roof Panels'
on conflict do nothing;

-- Door department -> Doors column
insert into bt_department_columns (department_id, status_column_id)
select d.id, s.id from bt_departments d, bt_status_columns s
where d.name = 'Door' and s.name = 'Doors'
on conflict do nothing;

-- Everything else (Alum. Fix, Alum. Trap, XX, H2/4, PVC, I-A, Roof Extr.,
-- Therm a deck, Acrylic, Deck, Valance, Rail, PATIO Door, Glass, Pergola,
-- R. Screen, Nova Sun, Stairs) is intentionally left unassigned to any
-- department for now — still tracked, visible to admin, ready to attach
-- to a new department whenever you stand one up.
