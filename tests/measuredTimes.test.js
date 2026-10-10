import { test } from 'node:test'
import assert from 'node:assert/strict'
import { creditFor, jobTime, summarize } from '../src/lib/measuredTimes.js'
import { DEFAULT_SETTINGS, workingMinutesBetween } from '../src/lib/catalog.js'

const SHIFT = DEFAULT_SETTINGS.shift // 07:30–16:00, breaks 9:00–9:15, 12:00–12:30, 14:00–14:15

test('an order with 4 mods credits 4 frames, 4 headers, 4 bottoms, 8 uprights', () => {
  const measures = [
    { measure: 'mod_frames', base_measure: 'mods', factor: 1 },
    { measure: 'frame_headers', base_measure: 'mods', factor: 1 },
    { measure: 'frame_bottoms', base_measure: 'mods', factor: 1 },
    { measure: 'frame_uprights', base_measure: 'mods', factor: 2 },
  ]
  assert.deepEqual(creditFor(measures, { mods_count: 4 }, {}), { mod_frames: 4, frame_headers: 4, frame_bottoms: 4, frame_uprights: 8 })
})

test('a count nobody entered is left out, not counted as zero', () => {
  const measures = [{ measure: 'tracks', base_measure: 'tracks', factor: 1 }]
  assert.deepEqual(creditFor(measures, { mods_count: 4 }, {}), {})
  assert.deepEqual(creditFor(measures, {}, { tracks: 12 }), { tracks: 12 })
})

test('breaks are not working time', () => {
  // Mon 28 Sep 2026, 8:00–10:00 with the 9:00–9:15 break
  assert.equal(workingMinutesBetween('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', SHIFT), 105)
})

test('a job left over the weekend counts only shift hours', () => {
  // Fri 15:00 → Mon 08:30: 45 min Friday (minus 14:00 break? no: after it), 60 Monday
  assert.equal(workingMinutesBetween('2026-09-25T15:00:00Z', '2026-09-28T08:30:00Z', SHIFT), 120)
})

test('person-minutes use each day’s crew; a day without crew is flagged', () => {
  const t = jobTime('2026-09-25T15:00:00Z', '2026-09-28T08:30:00Z', SHIFT, { '2026-09-25': 2, '2026-09-28': 3 })
  assert.equal(t.minutes, 120)
  assert.equal(t.personMinutes, 60 * 2 + 60 * 3)
  assert.equal(t.missingCrew, false)
  assert.equal(jobTime('2026-09-25T15:00:00Z', '2026-09-28T08:30:00Z', SHIFT, { '2026-09-25': 2 }).missingCrew, true)
})

test('minutes per unit = person-minutes ÷ units, skipping jobs it cannot judge', () => {
  const s = summarize([
    { minutes: 105, personMinutes: 210, missingCrew: false, units: 11 },
    { minutes: 60, personMinutes: 120, missingCrew: false, units: 5 },
    { minutes: 30, personMinutes: 0, missingCrew: true, units: 3 },
    { minutes: 30, personMinutes: 60, missingCrew: false, units: null },
  ])
  assert.equal(s.jobs, 4)
  assert.equal(s.used, 2)
  assert.equal(s.noCrew, 1)
  assert.equal(s.noUnits, 1)
  assert.equal(s.units, 16)
  assert.ok(Math.abs(s.minutesPerUnit - 330 / 16) < 1e-9)
})
