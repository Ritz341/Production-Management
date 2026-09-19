import { WORKFLOW_STAGES } from './statusColors'

// Shared by the floor, admin overview and logistics screens so "IN 3
// DAYS", "LATE" and "done" mean exactly the same thing everywhere.

/** 0 = not started, 1 = started, 2 = done. */
export function stageRank(stageId) {
  if (stageId === 'started') return 1
  // 'packaged' / 'shipped' are from before the floor steps were simplified.
  if (stageId === 'completed' || stageId === 'packaged' || stageId === 'shipped') return 2
  return 0 // null, or the old 'paperwork_ready'
}

/** Rank at which a department's job counts as done. */
export const DONE_RANK = 2

/** The stage one tap moves a job to, or null once it's done. */
export function nextStageId(stageId) {
  return WORKFLOW_STAGES[stageRank(stageId)]?.id ?? null
}

/** Label for any stored stage, including the older ones. */
export function stageLabel(stageId) {
  return ['Not started', 'Started', 'Done'][stageRank(stageId)]
}

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

/**
 * Build numbers (#1, #2 …) per pickup: each active order's position
 * among its build week's active orders, by `sequence`. Pass every active
 * order in the week(s), not a department's subset, so the number is the
 * same on every screen. Returns Map(orderId → number).
 */
export function buildNumbers(orders) {
  const byWeek = new Map()
  for (const o of orders) {
    if (o.status && o.status !== 'active') continue
    const key = o.build_week_id ?? 'none'
    if (!byWeek.has(key)) byWeek.set(key, [])
    byWeek.get(key).push(o)
  }
  const out = new Map()
  for (const list of byWeek.values()) {
    list.sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.id - b.id)
    list.forEach((o, i) => out.set(o.id, i + 1))
  }
  return out
}

/**
 * Sort: earliest pickup week first, then build number within it. Goes by
 * the order's build week, not its own pickup date, so inside a pickup
 * admin's numbering is the only thing that decides — an order with an
 * odd individual date can't jump the queue. Expects the week's ship date
 * embedded as `bt_build_weeks` (select '…, bt_build_weeks(ship_date)').
 */
export function byBuildOrder(a, b) {
  const ad = a.bt_build_weeks?.ship_date || a.scheduled_pickup_date || '9999'
  const bd = b.bt_build_weeks?.ship_date || b.scheduled_pickup_date || '9999'
  return (
    ad.localeCompare(bd) ||
    String(a.build_week_id).localeCompare(String(b.build_week_id)) ||
    (a.buildNo ?? 1e9) - (b.buildNo ?? 1e9) ||
    a.tag_name.localeCompare(b.tag_name)
  )
}

/** An order admin moved in the last 24 hours — flagged on every tablet. */
export function wasMovedRecently(order) {
  return !!order.moved_at && Date.now() - new Date(order.moved_at) < 24 * 36e5
}
