import { isoDate, workingMinutesBetween } from './catalog'

/**
 * The job (status column) each station's Start / Done times. Only the
 * stations that are a job of their own can be timed from Start to Done:
 * the cut stations. A department whose one column covers several steps
 * (V4T's vents, frames and assembly) can't be split by the clock.
 */
export const STEP_COLUMN = {
  sc220_frames: 'SC220 Frames',
  sc220_uprights: 'SC220 Uprights',
  ta144_vents: 'TA144 Vents',
  manual_framing: 'Manual Framing',
  manual_traps: 'Manual Traps',
  manual_vinyl_fix: 'Manual Vinyl Fix',
  manual_corner_posts: 'Manual Corner Posts',
}

/** Plain names for what a Done counts. */
export const PIECE_NAMES = {
  mods: 'mods',
  v4t_frames: 'V4T frames',
  vents: 'vents',
  mod_frames: 'mod frames',
  frame_headers: 'headers',
  frame_bottoms: 'bottoms',
  frame_uprights: 'uprights',
  v4t_uprights: 'V4T uprights',
  v4t_head_sill: 'V4T heads & sills',
  tracks: 'tracks',
  roof_panels: 'roof panels',
  filler_panels: 'mod filler panels',
  doors: 'doors',
}

/** The order counts a Done is worked out from. */
export const BASE_NAMES = { mods: 'mods', v4t_frames: 'V4T frames', vents: 'vents', tracks: 'tracks', roof_panels: 'roof panels', filler_panels: 'mod filler panels', doors: 'doors' }

/**
 * What one Done on this column credits for this order:
 * { measure: units } = factor × the order's count. A count nobody has
 * entered (no mods yet, no file read) leaves that piece out — it is
 * unknown, not zero.
 * measures: that column's bt_column_measures rows; quantities: { base: qty }.
 */
export function creditFor(measures, order, quantities) {
  const out = {}
  for (const m of measures) {
    const base = quantities?.[m.base_measure] ?? (m.base_measure === 'mods' ? order?.mods_count : null)
    if (base == null) continue
    out[m.measure] = Number(m.factor) * Number(base)
  }
  return out
}

/** The same day in the crew tables' format. */
function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/**
 * One finished job's time, breaks and non-working time left out:
 *   minutes        working minutes between Start and Done
 *   personMinutes  the same, each day multiplied by the people on it
 *   missingCrew    true if a working day of the job has no crew entered
 * crewByDay: { 'YYYY-MM-DD': people }.
 */
export function jobTime(startedAt, completedAt, shift, crewByDay) {
  const from = new Date(startedAt)
  const to = new Date(completedAt)
  const minutes = workingMinutesBetween(from, to, shift)
  let personMinutes = 0
  let missingCrew = false
  const day = startOfDay(from)
  for (let i = 0; day <= to && i < 400; i++) {
    const dayEnd = new Date(day)
    dayEnd.setDate(dayEnd.getDate() + 1)
    const m = workingMinutesBetween(from > day ? from : day, to < dayEnd ? to : dayEnd, shift)
    if (m > 0) {
      const people = crewByDay?.[isoDate(day)]
      if (people == null) missingCrew = true
      else personMinutes += m * people
    }
    day.setDate(day.getDate() + 1)
  }
  return { minutes, personMinutes, missingCrew }
}

/**
 * Minutes one person takes per unit, over the chosen jobs.
 * jobs: [{ minutes, personMinutes, missingCrew, units }] — units is the
 * primary count for that job (null if unknown). windowN: use only the
 * latest N (empty/null = every job given). Jobs without units or crew are
 * counted but can't be averaged; they're reported, not guessed.
 */
export function summarize(jobs) {
  const usable = jobs.filter((j) => j.units > 0 && !j.missingCrew && j.personMinutes > 0)
  const units = usable.reduce((s, j) => s + j.units, 0)
  const personMinutes = usable.reduce((s, j) => s + j.personMinutes, 0)
  return {
    jobs: jobs.length,
    used: usable.length,
    noUnits: jobs.filter((j) => !(j.units > 0)).length,
    noCrew: jobs.filter((j) => j.missingCrew).length,
    units,
    workingMinutes: usable.reduce((s, j) => s + j.minutes, 0),
    minutesPerUnit: units > 0 ? personMinutes / units : null,
  }
}
