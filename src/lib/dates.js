/**
 * Text for a build-week dropdown option. Always leads with the real
 * ship_date (the authoritative, editable field — see AdminView's ship
 * date save) rather than trusting the stored label, which comes from
 * the sheet's "PICK UP x/x" banner. Migration v17 moves the date inside
 * that label when the ship date moves, but a week rescheduled before
 * v17 was applied still carries the old one — so the real date leads
 * and the label follows in brackets.
 */
export function weekOptionLabel(w) {
  if (!w.ship_date) return w.label
  const nice = new Date(w.ship_date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${nice} (${w.label})`
}

/**
 * What to call a build week on a screen someone makes decisions from.
 *
 * The label is the sheet's banner text ('PICK UP 9/15'), so it carries
 * a date of its own — and that date was right on import day and never
 * again. Printing it beside the real ship date is how a tablet ends up
 * reading "Mon Sep 22 · PICK UP 9/15" after a week gets moved: two
 * dates, one of them wrong, and no way to tell which. So the label is
 * shown only when it says something the date doesn't. Migration v17
 * keeps the stored label in step as well; this covers weeks moved
 * before it was applied.
 */
export function weekName(w) {
  if (!w) return ''
  if (!w.ship_date) return w.label ?? ''
  const own = String(w.label ?? '').replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, '').replace(/\s+/g, ' ').trim()
  // 'PICK UP' on its own adds nothing next to a ship date.
  return /^(pick ?up|pu)?$/i.test(own) ? '' : own
}

/**
 * Which build week the floor should be focused on right now: the one
 * with the nearest ship_date that's today or later. If every week has
 * already shipped, falls back to the most recently shipped one (still
 * more useful than defaulting to "all weeks" mixed together).
 */
export function nearestBuildWeekId(weeks) {
  if (!weeks || weeks.length === 0) return null
  const today = new Date().toISOString().slice(0, 10)
  const dated = weeks.filter((w) => w.ship_date)
  const upcoming = dated.filter((w) => w.ship_date >= today).sort((a, b) => a.ship_date.localeCompare(b.ship_date))
  if (upcoming[0]) return upcoming[0].id
  const past = dated.sort((a, b) => b.ship_date.localeCompare(a.ship_date))
  return (past[0] ?? weeks[0]).id
}
