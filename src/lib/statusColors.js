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
 * Workflow stage — the 5-step lifecycle admins set per order/department
 * cell from a dropdown, replacing free-text C/X entry. Independent of the
 * raw imported sheet value (which is kept for reference but is no longer
 * what gets hand-edited).
 */
export const WORKFLOW_STAGES = [
  { id: 'paperwork_ready', label: 'Paperwork Ready', chipClass: 'bg-safety/20 text-safetyDark', dotClass: 'bg-safety' },
  { id: 'started', label: 'Order Started', chipClass: 'bg-andonBlueBg text-andonBlue', dotClass: 'bg-andonBlue' },
  { id: 'completed', label: 'Order Completed', chipClass: 'bg-andonGreenBg text-andonGreen', dotClass: 'bg-andonGreen' },
  { id: 'packaged', label: 'Packaged', chipClass: 'bg-violet-100 text-violet-700', dotClass: 'bg-violet-600' },
  { id: 'shipped', label: 'Loaded on Truck', chipClass: 'bg-charcoal text-paper', dotClass: 'bg-charcoal' },
]

export const workflowStageById = Object.fromEntries(WORKFLOW_STAGES.map((s) => [s.id, s]))

// "Blocked" is a flag layered on top of whatever stage a cell is
// already at (e.g. Order Started but waiting on a part) — not one of
// the linear WORKFLOW_STAGES above, so it gets its own styling that
// overrides the stage chip's color wherever it's set.
export const BLOCKED_CHIP_CLASS = 'bg-andonRedBg text-andonRed'
export const BLOCKED_DOT_CLASS = 'bg-andonRed'

// Rough mapping into the existing 3-bucket not_started/in_progress/complete
// system so the Board tab's counts keep working without a rewrite.
export function workflowBucket(stageId) {
  if (!stageId || stageId === 'paperwork_ready') return 'not_started'
  if (stageId === 'started') return 'in_progress'
  return 'complete' // completed, packaged, shipped
}
