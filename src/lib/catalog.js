import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

// Everything the floor picks from — block reasons, defect types, order
// details — lives here, so a plant can rename or extend them in one place.

/** Why a job is blocked. Stored as the id; the floor sees the label. */
export const BLOCK_CATEGORIES = [
  { id: 'material_shortage', label: 'Material shortage' },
  { id: 'machine_down', label: 'Machine down' },
  { id: 'rework', label: 'Rework / wrong cut' },
  { id: 'waiting_dept', label: 'Waiting on another department' },
  { id: 'missing_info', label: 'Missing info / paperwork' },
  { id: 'short_staffed', label: 'Short-staffed' },
  { id: 'order_change', label: 'Order change' },
  { id: 'other', label: 'Other' },
]

/** Quality defects, most common first. */
export const DEFECT_TYPES = [
  { id: 'wrong_size', label: 'Wrong size / doesn’t fit' },
  { id: 'out_of_square', label: 'Out of square' },
  { id: 'glazing', label: 'Glazing problem' },
  { id: 'scratched', label: 'Scratched / damaged' },
  { id: 'wrong_color', label: 'Wrong colour' },
  { id: 'wrong_machined', label: 'Wrong machined part' },
  { id: 'material_shortage', label: 'Material shortage' },
  { id: 'missing_parts', label: 'Missing parts' },
  { id: 'other', label: 'Other' },
]

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x.label]))
export const blockCategoryLabel = byId(BLOCK_CATEGORIES)
export const defectLabel = byId(DEFECT_TYPES)

/** Order details the office enters, each with how hard it makes the room. */
export const ROOM_SHAPES = [
  { id: 'square', label: 'Square', level: 'easy' },
  { id: 'pitched', label: 'Pitched / soffit', level: 'medium' },
  { id: 'gable', label: 'Cathedral / gable', level: 'hard' },
]
export const WINDOW_TYPES = [
  { id: 'v4t', label: 'V4T', level: 'easy' },
  { id: 'vinyl_fix', label: 'Vinyl fix', level: 'medium' },
  { id: 'trap_glass', label: 'Vinyl trap / glass', level: 'hard' },
]
export const PANEL_TYPES = [
  { id: 'insulated_2in', label: '2" insulated', level: 'easy' },
  { id: 'double_foam', label: 'Double foam, protected', level: 'medium' },
  { id: 'full_filler', label: 'Full filler panel', level: 'hard' },
]

const LEVEL_SCORE = { easy: 1, medium: 2, hard: 3 }

/** The process lists we start from; admin can edit or reset to these. */
export const RECOMMENDED_PROCESSES = {
  Mods: [
    { id: 'framing', name: 'Mod frames', unit: 'mods', minutesEach: null, perFinished: 1 },
    { id: 'staging', name: 'Final mod', unit: 'mods', minutesEach: null, perFinished: 1 },
  ],
  V4T: [
    { id: 'vents_cut', name: 'Vents cut', unit: 'vents', minutesEach: null, perFinished: 4 },
    { id: 'vents_glazed', name: 'Vents built & glazed', unit: 'vents', minutesEach: null, perFinished: 4 },
    { id: 'frame_cut', name: 'Frame parts cut (saw)', unit: 'inserts', minutesEach: null, perFinished: 1 },
    { id: 'frame_punch', name: 'Frame parts punched', unit: 'inserts', minutesEach: null, perFinished: 1 },
    { id: 'frames', name: 'Frames assembled & squared', unit: 'inserts', minutesEach: null, perFinished: 1 },
  ],
}

/** Defaults, used until the settings table has loaded (or if it's empty). */
export const DEFAULT_SETTINGS = {
  mods_per_person_day: 3,
  default_mods_crew: 4,
  difficulty_multiplier: { easy: 1.0, medium: 1.25, hard: 1.5 },
  size_bands: { small: 10, medium: 14 },
  // Per-department daily output per person, set in Admin → TVs, e.g.
  // { Mods: { perPerson: 3, unit: 'mods' }, V4T: { perPerson: 12, unit: 'inserts' } }.
  rates: {},
  // When departments enter their count during the day (end of each block).
  checkin_times: ['09:30', '11:30', '13:30', '16:00'],
  // Stations inside a department, in the order work flows through them.
  // minutesEach: minutes for ONE person to make ONE unit (null = not set)
  // — what a time study measures. perFinished: how many of this step's
  // units make one finished unit (4 vents per V4T insert), so the line's
  // output can be compared.
  processes: RECOMMENDED_PROCESSES,
  shift: {
    start: '07:30',
    end: '16:00',
    breaks: [
      { start: '09:00', end: '09:15', paid: true },
      { start: '12:00', end: '12:30', paid: false },
      { start: '14:00', end: '14:15', paid: true },
    ],
    workdays: [1, 2, 3, 4, 5],
  },
}

/** Live settings from bt_settings, merged over the defaults. */
export function useSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  useEffect(() => {
    function load() {
      supabase
        .from('bt_settings')
        .select('key, value')
        .then(({ data }) => {
          if (!data?.length) return
          setSettings({ ...DEFAULT_SETTINGS, ...Object.fromEntries(data.map((r) => [r.key, r.value])) })
        })
    }
    load()
    const channel = supabase
      .channel('settings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_settings' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])
  return settings
}

/** 'small' | 'medium' | 'large' | null, from the number of mods. */
export function roomSize(modsCount, settings = DEFAULT_SETTINGS) {
  if (!modsCount) return null
  if (modsCount <= settings.size_bands.small) return 'small'
  if (modsCount <= settings.size_bands.medium) return 'medium'
  return 'large'
}

/**
 * How hard an order is: the hardest of its room shape, windows and
 * panels decides (one hard feature slows the whole room down). Returns
 * 'easy' | 'medium' | 'hard' | null when nothing's been entered.
 */
export function difficulty(order) {
  const levels = [
    ROOM_SHAPES.find((x) => x.id === order.room_shape)?.level,
    WINDOW_TYPES.find((x) => x.id === order.window_type)?.level,
    PANEL_TYPES.find((x) => x.id === order.panel_type)?.level,
  ].filter(Boolean)
  if (levels.length === 0) return null
  return levels.reduce((a, b) => (LEVEL_SCORE[b] > LEVEL_SCORE[a] ? b : a))
}

/**
 * Person-days of Mods work (framing + staging) an order needs:
 * mods ÷ mods-per-person-day, scaled up by difficulty. Null without a
 * mod count — an estimate from nothing would just be a guess.
 */
export function orderPersonDays(order, settings = DEFAULT_SETTINGS) {
  if (!order.mods_count) return null
  const level = difficulty(order) ?? 'easy'
  return (order.mods_count * settings.difficulty_multiplier[level]) / settings.mods_per_person_day
}

/**
 * Can a pickup's orders be built in time? Compares the person-days
 * needed with the Mods crew available on the workdays before the ship
 * date (from today). Returns { needed, available, missing, load } where
 * load is needed ÷ available (1 = exactly full), and missing counts
 * orders with no mod count yet.
 */
export function weekLoad(orders, shipDate, settings = DEFAULT_SETTINGS, crewByDate = {}) {
  let needed = 0
  let missing = 0
  for (const o of orders) {
    const d = orderPersonDays(o, settings)
    if (d == null) missing++
    else needed += d
  }
  const days = workdaysUntil(shipDate, settings.shift.workdays)
  const available = days.reduce((sum, iso) => sum + (crewByDate[iso] ?? settings.default_mods_crew), 0)
  return { needed, available, days: days.length, missing, load: available > 0 ? needed / available : null }
}

/** ISO dates of workdays from today up to (not including) the ship date. */
export function workdaysUntil(shipDate, workdays = [1, 2, 3, 4, 5]) {
  if (!shipDate) return []
  const out = []
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const end = new Date(shipDate + 'T00:00')
  while (d < end && out.length < 60) {
    if (workdays.includes(d.getDay())) out.push(isoDate(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Working minutes in one shift: span minus every break (paid or not). */
export function productiveMinutesPerDay(shift = DEFAULT_SETTINGS.shift) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const span = m(shift.end) - m(shift.start)
  return span - shift.breaks.reduce((s, b) => s + (m(b.end) - m(b.start)), 0)
}

/**
 * Working minutes between two timestamps: only shift hours on workdays,
 * breaks excluded. So a job started Friday 3pm and finished Monday 8am
 * took 1h30, not 65 hours.
 */
export function workingMinutesBetween(fromTs, toTs, shift = DEFAULT_SETTINGS.shift) {
  if (!fromTs || !toTs) return null
  const from = new Date(fromTs)
  const to = new Date(toTs)
  if (to <= from) return 0
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const windows = [] // productive windows within a day, in minutes from midnight
  let cursor = m(shift.start)
  for (const b of [...shift.breaks].sort((a, c) => m(a.start) - m(c.start))) {
    windows.push([cursor, m(b.start)])
    cursor = m(b.end)
  }
  windows.push([cursor, m(shift.end)])

  let total = 0
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; day <= to && i < 400; i++) {
    if (shift.workdays.includes(day.getDay())) {
      for (const [a, b] of windows) {
        const ws = new Date(day.getTime() + a * 6e4)
        const we = new Date(day.getTime() + b * 6e4)
        const s = Math.max(ws, from)
        const e = Math.min(we, to)
        if (e > s) total += (e - s) / 6e4
      }
    }
    day.setDate(day.getDate() + 1)
  }
  return Math.round(total)
}

/** "Material shortage — glass cracked", for any blocked cell. */
export function blockText(cell) {
  const label = cell.blockedCategory ? blockCategoryLabel[cell.blockedCategory] ?? cell.blockedCategory : null
  return [label, cell.blockedNote].filter(Boolean).join(' — ') || 'no reason given'
}

/**
 * Loads for several pickups at once, cumulatively: each pickup has to
 * fit its own Mods work AND everything shipping before it into the
 * workdays left before its ship date — two pickups can't both use the
 * same days. `pickups` is [{ key, shipDate, orders }]; orders whose Mods
 * work is already done should be left out by the caller. Returns
 * Map(key → load) in the same shape as weekLoad().
 */
export function pickupLoads(pickups, settings = DEFAULT_SETTINGS, crewByDate = {}) {
  const out = new Map()
  let carried = 0
  let carriedMissing = 0
  const dated = pickups.filter((p) => p.shipDate).sort((a, b) => a.shipDate.localeCompare(b.shipDate))
  for (const p of dated) {
    const own = weekLoad(p.orders, p.shipDate, settings, crewByDate)
    carried += own.needed
    carriedMissing += own.missing
    out.set(p.key, {
      ...own,
      needed: carried,
      missing: carriedMissing,
      load: own.available > 0 ? carried / own.available : null,
    })
  }
  return out
}

/**
 * A department's daily output rate per person and what it's counted in.
 * Mods falls back to mods_per_person_day (what the estimates use), so
 * the two can't drift apart. Null perPerson = no target set yet.
 */
export function rateFor(settings, departmentName) {
  const r = settings.rates?.[departmentName]
  if (r?.perPerson) return { perPerson: Number(r.perPerson), unit: r.unit || 'units' }
  if (departmentName === 'Mods') return { perPerson: settings.mods_per_person_day, unit: 'mods' }
  return { perPerson: null, unit: r?.unit || 'units' }
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

/** A Date for today at "HH:MM". */
export function todayAt(hhmm) {
  const d = new Date()
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0)
  return d
}

/**
 * The day's check-in blocks with the cumulative target due at the end
 * of each — the hour-by-hour board. Targets follow working time (breaks
 * don't earn target), so a block with lunch in it asks for less.
 * Returns [{ label, end: Date, targetByEnd }].
 */
export function checkinBlocks(settings, dailyTarget) {
  const shift = settings.shift
  const total = productiveMinutesPerDay(shift)
  const start = todayAt(shift.start)
  const times = [...(settings.checkin_times ?? DEFAULT_SETTINGS.checkin_times)]
    .filter((t) => toMin(t) > toMin(shift.start) && toMin(t) <= toMin(shift.end))
    .sort((a, b) => toMin(a) - toMin(b))
  if (!times.length || times[times.length - 1] !== shift.end) times.push(shift.end)
  return [...new Set(times)].map((t) => {
    const end = todayAt(t)
    const worked = workingMinutesBetween(start, end, shift) ?? 0
    return { label: t, end, targetByEnd: dailyTarget == null ? null : (dailyTarget * worked) / total }
  })
}

/** "9:30" / "1:30" from "09:30" / "13:30". */
export function clockLabel(hhmm) {
  const h = Number(hhmm.slice(0, 2))
  return `${((h + 11) % 12) + 1}:${hhmm.slice(3, 5)}`
}

/** A department's processes, in flow order (empty = department as a whole). */
export function processesFor(settings, departmentName) {
  return settings.processes?.[departmentName] ?? DEFAULT_SETTINGS.processes[departmentName] ?? []
}

/** Working hours in a day (7:30–4:00 minus all breaks = 7.5). */
export function workingHoursPerDay(settings = DEFAULT_SETTINGS) {
  return productiveMinutesPerDay(settings.shift) / 60
}

/**
 * The day's plan for a department's line, from who's on each process:
 * each process's daily target (people × rate per hour × working hours),
 * what that means in finished units, and which process limits the line.
 *
 *   planLine(processes, { framing: 2, staging: 3 }, settings)
 *   → { steps: [{ ...process, people, daily, finished }], capacity, bottleneck }
 *
 * capacity / bottleneck are null until every staffed step has a rate.
 */
/**
 * How many one person makes in a working hour. Entered as minutes for
 * one (easier to time); older settings stored the hourly rate directly.
 */
export function ratePerHourOf(p) {
  if (p.minutesEach) return 60 / Number(p.minutesEach)
  if (p.ratePerHour) return Number(p.ratePerHour)
  return null
}

export function planLine(processes, peopleByProcess, settings = DEFAULT_SETTINGS) {
  const hours = workingHoursPerDay(settings)
  const steps = processes.map((p) => {
    const people = peopleByProcess[p.id] ?? null
    const rate = ratePerHourOf(p)
    const daily = people != null && rate ? people * rate * hours : null
    const finished = daily != null ? daily / (Number(p.perFinished) || 1) : null
    return { ...p, people, daily, finished }
  })
  const known = steps.filter((st) => st.finished != null)
  const complete = known.length === steps.length && steps.length > 0
  const bottleneck = complete ? known.reduce((a, b) => (b.finished < a.finished ? b : a)) : null
  return { steps, capacity: bottleneck ? bottleneck.finished : null, bottleneck, hours }
}

/** Round for display: whole numbers, one decimal under 10. */
export function fmtQty(n) {
  if (n == null) return '—'
  return n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n))
}
