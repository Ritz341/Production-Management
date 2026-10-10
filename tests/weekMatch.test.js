import test from 'node:test'
import assert from 'node:assert/strict'
import { keepMovedWeekDates } from '../src/lib/weekMatch.js'
import { nearestBuildWeekId } from '../src/lib/dates.js'

const sections = [{ isoDate: '2026-10-02', label: 'PICK UP 10/2' }]
const orders = ['A_1', 'B_2', 'C_3', 'D_4'].map((t) => ({ tagName: t, scheduledPickupDate: '2026-10-02' }))

test('a week moved in the app keeps its new date when the sheet still has the old one', () => {
  const weeks = [{ id: 7, ship_date: '2026-10-03' }]
  const existing = orders.map((o) => ({ tag_name: o.tagName, build_week_id: 7 }))
  const { overrides, moved } = keepMovedWeekDates(sections, orders, existing, weeks)
  assert.equal(overrides['2026-10-02'].isoDate, '2026-10-03')
  assert.equal(moved['2026-10-02'], '2026-10-03')
})

test('a week that already has the sheet date is left alone', () => {
  const weeks = [{ id: 7, ship_date: '2026-10-02' }]
  const existing = orders.map((o) => ({ tag_name: o.tagName, build_week_id: 7 }))
  const { overrides, moved } = keepMovedWeekDates(sections, orders, existing, weeks)
  assert.equal(overrides['2026-10-02'].isoDate, '2026-10-02')
  assert.deepEqual(moved, {})
})

test('a brand-new week (no orders in the database yet) imports under the sheet date', () => {
  const { overrides, moved } = keepMovedWeekDates(sections, orders, [], [{ id: 7, ship_date: '2026-10-03' }])
  assert.equal(overrides['2026-10-02'].isoDate, '2026-10-02')
  assert.deepEqual(moved, {})
})

test('only a minority of the orders in a moved week: treated as a new week', () => {
  const weeks = [{ id: 7, ship_date: '2026-10-03' }]
  const existing = [{ tag_name: 'A_1', build_week_id: 7 }]
  const { moved } = keepMovedWeekDates(sections, orders, existing, weeks)
  assert.deepEqual(moved, {})
})

test('nearestBuildWeekId counts the local calendar day, not UTC', () => {
  // 8pm in Missouri on Oct 2 is already Oct 3 in UTC.
  const realTZ = process.env.TZ
  process.env.TZ = 'America/Chicago' // the test harness defaults to UTC, which hides this
  const realNow = Date
  const fixed = new realNow(2026, 9, 2, 20, 0, 0) // local 20:00 Oct 2
  globalThis.Date = class extends realNow {
    constructor(...a) { return a.length ? new realNow(...a) : new realNow(fixed) }
    static now() { return fixed.getTime() }
  }
  try {
    const weeks = [
      { id: 1, ship_date: '2026-10-02' },
      { id: 2, ship_date: '2026-10-09' },
    ]
    assert.equal(nearestBuildWeekId(weeks), 1) // still the week shipping today
  } finally {
    globalThis.Date = realNow
    process.env.TZ = realTZ
  }
})
