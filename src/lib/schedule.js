import { WORKFLOW_STAGES } from './statusColors'

// Shared by the floor, admin overview and logistics screens so "IN 3
// DAYS", "LATE" and "done" mean exactly the same thing everywhere.

const STAGE_IDS = WORKFLOW_STAGES.map((s) => s.id)

/** 0 = not started, 1 = paperwork ready … 5 = on the truck. */
export function stageRank(stageId) {
  if (!stageId) return 0
  const idx = STAGE_IDS.indexOf(stageId)
  return idx < 0 ? 0 : idx + 1
}

/** Rank at which a department's job counts as done (Order Completed). */
export const DONE_RANK = 3

/** Whole days from today to an ISO date (negative = past), or null. */
export function daysUntil(iso) {
  if (!iso) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(iso + 'T00:00') - today) / 864e5)
}

export function relativeDay(n) {
  if (n == null) return ''
  if (n < 0) return `${-n}d late`
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  return `in ${n} days`
}

export function shortDate(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** '3m', '5h', '2d' — how long ago a timestamp was. */
export function ago(ts) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(ts)) / 6e4))
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`
}
