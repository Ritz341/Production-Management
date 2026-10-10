// Six weeks of history, then it goes (schema_v31.sql, bt_purge_old).
export const KEEP_WEEKS = 6

// More than this in one go means something is off — the first run on a
// database that was never tidied, or a wrong clock — so a person is asked.
const ASK_ABOVE = 150

/**
 * Clears history older than `keepWeeks`.
 *
 *   1. dry run — what would go, and which paperwork files belong to it
 *   2. delete those files from Storage (SQL can't), and stop if that fails,
 *      so no order is removed while its files are left behind
 *   3. delete the orders and the weeks left empty
 *
 * `db` is the supabase client; `ask(text)` returns true/false (a dialog).
 * Resolves { orders, weeks, skipped }. Throws on a failed step.
 */
export async function purgeOld(db, { keepWeeks = KEEP_WEEKS, bucket = 'bt-files', ask = () => true } = {}) {
  const plan = await call(db, true, keepWeeks)
  if (plan.orders === 0 && plan.weeks === 0) return { orders: 0, weeks: 0, skipped: false }

  if (plan.orders > ASK_ABOVE) {
    const ok = await ask(
      `${plan.orders} orders are older than ${keepWeeks} weeks and would be deleted for good. Go ahead?`
    )
    if (!ok) return { orders: 0, weeks: 0, skipped: true }
  }

  for (let i = 0; i < plan.files.length; i += 100) {
    const { error } = await db.storage.from(bucket).remove(plan.files.slice(i, i + 100))
    if (error) throw new Error(`Couldn't remove old paperwork files: ${error.message}`)
  }

  const done = await call(db, false, keepWeeks)
  return { orders: done.orders, weeks: done.weeks, skipped: false }
}

async function call(db, dry, keepWeeks) {
  const { data, error } = await db.rpc('bt_purge_old', { p_keep_weeks: keepWeeks, p_dry_run: dry })
  if (error) throw error
  return { orders: 0, weeks: 0, files: [], ...data }
}

/** "Cleared 14 orders and 1 week older than 6 weeks." */
export function purgeSummary({ orders, weeks }, keepWeeks = KEEP_WEEKS) {
  const parts = []
  if (orders) parts.push(`${orders} ${orders === 1 ? 'order' : 'orders'}`)
  if (weeks) parts.push(`${weeks} empty ${weeks === 1 ? 'week' : 'weeks'}`)
  return parts.length ? `Cleared ${parts.join(' and ')} older than ${keepWeeks} weeks.` : ''
}
