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

/**
 * The big word at the top of a build week — and whether it's an alarm.
 *
 * This used to be the ship date alone, which meant a week read "2D
 * LATE" in red next to "100% complete" in green. Both were true and
 * together they said nothing: the date had passed, and the floor had
 * finished everything. "Late" is a word about fault, so pointing it at
 * a crew who built the lot is worse than useless — they learn to
 * ignore the number, and then it can't warn them when it matters.
 *
 * So the headline answers "is anything still owed here?", and only a
 * week with work left on it can be late. An empty week can't be late
 * either — there's nothing in it to be late with.
 *
 *   weekHeadline('2026-09-25', { total: 1, done: 1 }) → ALL BUILT (done)
 *   weekHeadline('2026-09-25', { total: 4, done: 1 }) → 3D LATE  (late)
 *
 * `total`/`done` are counted in whatever the caller cares about: orders
 * for the week on admin, this department's own jobs on a tablet. A
 * Mods tablet reading ALL BUILT means Mods is finished, not the plant.
 */
export function weekHeadline(shipDate, { total = 0, done = 0 } = {}) {
  if (!shipDate) return { text: 'NO DATE', tone: 'idle', days: null }
  const days = daysUntil(shipDate)
  const text = relativeDay(days).toUpperCase()
  if (total > 0 && done >= total) return { text: 'ALL BUILT', tone: 'done', days }
  if (total === 0) return { text, tone: 'idle', days }
  if (days < 0) return { text, tone: 'late', days }
  return { text, tone: days <= 2 ? 'urgent' : 'ok', days }
}

/** Text colour for a weekHeadline tone, on the dark floor/admin tiles. */
export const HEADLINE_TONE_CLASS = {
  done: 'text-[#4CC46F]',
  late: 'text-[#FF6B6B]',
  urgent: 'text-[#FF6B6B]',
  ok: 'text-safety',
  idle: 'text-floorMute',
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
