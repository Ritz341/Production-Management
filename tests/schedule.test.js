import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNumbers, nextStageId, stageLabel, stageRank } from '../src/lib/schedule.js'

test('stages: old values still read correctly', () => {
  assert.equal(stageRank(null), 0)
  assert.equal(stageRank('started'), 1)
  assert.equal(stageRank('completed'), 2)
  assert.equal(stageRank('shipped'), 2)
  assert.equal(stageRank('paperwork_ready'), 0)
  assert.equal(stageLabel('packaged'), 'Done')
  assert.equal(nextStageId(null), 'started')
  assert.equal(nextStageId('started'), 'completed')
  assert.equal(nextStageId('completed'), null)
})

test('build numbers follow the admin order within each pickup, cancelled ones skipped', () => {
  const n = buildNumbers([
    { id: 1, build_week_id: 7, sequence: 2 },
    { id: 2, build_week_id: 7, sequence: 1 },
    { id: 3, build_week_id: 7, sequence: 3, status: 'cancelled' },
    { id: 4, build_week_id: 8, sequence: 5 },
  ])
  assert.equal(n.get(2), 1)
  assert.equal(n.get(1), 2)
  assert.equal(n.has(3), false)
  assert.equal(n.get(4), 1)
})
