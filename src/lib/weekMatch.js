/**
 * Which date each pasted pickup section should import under.
 *
 * Normally the sheet's own date. But a week admin has moved in the app
 * (10/2 → 10/3) still reads "PICK UP 10/2" on the sheet. Matching on the
 * sheet's date alone finds no week, makes a second one, and pulls every
 * order into it — silently undoing the move. So when no week carries the
 * sheet's date and at least half of the section's orders already live in
 * one week that doesn't, that week's date is kept.
 *
 *   sections  [{ isoDate, label }]
 *   orders    parsed rows [{ tagName, scheduledPickupDate }]
 *   existing  orders already in the database [{ tag_name, build_week_id }]
 *   weeks     build weeks [{ id, ship_date }]
 *
 * Returns { overrides: { [sheetDate]: { label, isoDate } }, moved: { [sheetDate]: movedToDate } }
 */
export function keepMovedWeekDates(sections, orders, existing, weeks) {
  const overrides = {}
  const moved = {}
  for (const s of sections) {
    overrides[s.isoDate] = { label: s.label, isoDate: s.isoDate }
    if (weeks.some((w) => w.ship_date === s.isoDate)) continue
    const tags = new Set(orders.filter((o) => o.scheduledPickupDate === s.isoDate).map((o) => o.tagName))
    if (tags.size === 0) continue
    const perWeek = {}
    for (const o of existing ?? []) {
      if (tags.has(o.tag_name) && o.build_week_id) perWeek[o.build_week_id] = (perWeek[o.build_week_id] ?? 0) + 1
    }
    const [bestId, n] = Object.entries(perWeek).sort((a, b) => b[1] - a[1])[0] ?? []
    const week = bestId && weeks.find((w) => w.id === Number(bestId))
    if (week?.ship_date && n * 2 >= tags.size) {
      overrides[s.isoDate].isoDate = week.ship_date
      moved[s.isoDate] = week.ship_date
    }
  }
  return { overrides, moved }
}
