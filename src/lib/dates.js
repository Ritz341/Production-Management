/**
 * The sheet's "Date" column doubles as a target ship/pickup date AND a
 * status once it's actioned, e.g. "Shipped 8/14", "Picked up 9/3",
 * "CREDIT HOLD", "Sunspace USA", or blank. This pulls a sortable date
 * out of it where one exists, so orders can be sorted by when they
 * actually ship/pick up, oldest first.
 */
export function parseShipDate(text) {
  if (!text) return null
  const match = text.match(/(\d{1,2})\/(\d{1,2})/)
  if (!match) return null
  const month = parseInt(match[1], 10) - 1
  const day = parseInt(match[2], 10)
  const now = new Date()
  let year = now.getFullYear()
  const candidate = new Date(year, month, day)
  // if the parsed date looks more than ~6 months in the past, assume it
  // rolled over into next year (handles year-end sheets without a year field)
  if (candidate < new Date(now.getTime() - 1000 * 60 * 60 * 24 * 180)) {
    return new Date(year + 1, month, day)
  }
  return candidate
}

export function shipDateLabel(text) {
  const d = parseShipDate(text)
  if (!d) return null
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Sort comparator: dated entries first (earliest first), undated last. */
export function byShipDate(a, b) {
  const da = parseShipDate(a.shipping_status)
  const db = parseShipDate(b.shipping_status)
  if (da && db) return da - db
  if (da && !db) return -1
  if (!da && db) return 1
  return a.tag_name.localeCompare(b.tag_name)
}

/**
 * Which build week the floor should be focused on right now: the one
 * with the nearest ship_date that's today or later. If every week has
 * already shipped, falls back to the most recently shipped one (still
 * more useful than defaulting to "all weeks" mixed together).
 */
/**
 * Text for a build-week dropdown option. Always leads with the real
 * ship_date (the authoritative, editable field — see AdminView's ship
 * date save) rather than trusting the stored label, which is set once
 * at import time from the sheet's "PICK UP x/x" banner and never
 * updated afterward — so it goes stale the moment someone reschedules
 * that week's ship date without also renaming it.
 */
export function weekOptionLabel(w) {
  if (!w.ship_date) return w.label
  const nice = new Date(w.ship_date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${nice} (${w.label})`
}

export function nearestBuildWeekId(weeks) {
  if (!weeks || weeks.length === 0) return null
  const today = new Date().toISOString().slice(0, 10)
  const dated = weeks.filter((w) => w.ship_date)
  const upcoming = dated.filter((w) => w.ship_date >= today).sort((a, b) => a.ship_date.localeCompare(b.ship_date))
  if (upcoming[0]) return upcoming[0].id
  const past = dated.sort((a, b) => b.ship_date.localeCompare(a.ship_date))
  return (past[0] ?? weeks[0]).id
}
