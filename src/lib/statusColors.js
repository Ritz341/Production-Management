/**
 * Confirmed mapping (per Riz, based on the actual plant Legend tab):
 *   C          -> Completed        -> green
 *   Arrived    -> Material arrived -> blue
 *   number/qty -> In progress/WIP  -> yellow (safety)
 *   X          -> Waiting on something -> red
 *   blank      -> Not started / N/A -> gray
 */
export function statusCategory(value) {
  if (!value || !value.trim()) return 'blank'
  const v = value.trim().toLowerCase()
  if (v === 'c') return 'complete'
  if (v === 'arrived') return 'arrived'
  if (v === 'x') return 'waiting'
  return 'progress' // quantities, 'Parts', dates, anything else
}

export const categoryChipClass = {
  complete: 'bg-andonGreenBg text-andonGreen',
  arrived: 'bg-andonBlueBg text-andonBlue',
  waiting: 'bg-andonRedBg text-andonRed',
  progress: 'bg-safety/20 text-safetyDark',
  blank: 'bg-paperDim text-steelLight',
}

export const categoryEdgeClass = {
  complete: 'bg-andonGreen',
  arrived: 'bg-andonBlue',
  waiting: 'bg-andonRed',
  progress: 'bg-safety',
  blank: 'bg-steelLight',
}

/** Three-stage lifecycle for the Start/Complete workflow. */
export function stage(cell) {
  // cell = { value, started_at } or undefined
  if (!cell) return 'not_started'
  if (cell.value && cell.value.trim().toLowerCase() === 'c') return 'complete'
  if (cell.started_at) return 'in_progress'
  return 'not_started'
}

export const stageLabel = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Completed',
}

export const stageDotClass = {
  not_started: 'bg-steelLight',
  in_progress: 'bg-safety',
  complete: 'bg-andonGreen',
}

export const stageChipClass = {
  not_started: 'bg-paperDim text-steelLight',
  in_progress: 'bg-safety/20 text-safetyDark',
  complete: 'bg-andonGreenBg text-andonGreen',
}

export function overallStatus(statuses, columnIds) {
  const cats = columnIds.map((id) => statusCategory(statuses[id]))
  if (cats.length === 0) return 'blank'
  if (cats.includes('waiting')) return 'waiting'
  if (cats.every((c) => c === 'complete' || c === 'blank') && cats.some((c) => c === 'complete')) return 'complete'
  if (cats.some((c) => c === 'progress' || c === 'arrived')) return 'progress'
  return 'blank'
}

/**
 * Workflow stage — what the floor sets per order/department: not started
 * (null) → Started → Done. Kept deliberately short so a tablet is one tap
 * per job. Paperwork is tracked separately by the office (see
 * bt_orders.paperwork_ready_at), not as a floor stage.
 *
 * Older rows may still hold 'paperwork_ready', 'packaged' or 'shipped'
 * from before this was simplified; stageRank() in lib/schedule.js reads
 * those as not started / done so nothing is lost.
 */
export const WORKFLOW_STAGES = [
  { id: 'started', label: 'Started', chipClass: 'bg-andonBlueBg text-andonBlue', dotClass: 'bg-andonBlue' },
  { id: 'completed', label: 'Done', chipClass: 'bg-andonGreenBg text-andonGreen', dotClass: 'bg-andonGreen' },
]

export const workflowStageById = Object.fromEntries(WORKFLOW_STAGES.map((s) => [s.id, s]))

// "Blocked" is a flag layered on top of whatever stage a cell is
// already at (e.g. Order Started but waiting on a part) — not one of
// the linear WORKFLOW_STAGES above, so it gets its own styling that
// overrides the stage chip's color wherever it's set.
export const BLOCKED_CHIP_CLASS = 'bg-andonRedBg text-andonRed'
export const BLOCKED_DOT_CLASS = 'bg-andonRed'
