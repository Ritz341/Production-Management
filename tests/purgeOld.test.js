import test from 'node:test'
import assert from 'node:assert/strict'
import { purgeOld, purgeSummary } from '../src/lib/purgeOld.js'

function fakeDb({ plan, removeError } = {}) {
  const log = []
  return {
    log,
    rpc: async (name, args) => {
      log.push(['rpc', args.p_dry_run ? 'dry' : 'real'])
      return { data: plan, error: null }
    },
    storage: { from: () => ({ remove: async (paths) => (log.push(['remove', paths.length]), { error: removeError ?? null }) }) },
  }
}

test('nothing old: no files touched, no real delete', async () => {
  const db = fakeDb({ plan: { orders: 0, weeks: 0, files: [] } })
  assert.deepEqual(await purgeOld(db), { orders: 0, weeks: 0, skipped: false })
  assert.deepEqual(db.log, [['rpc', 'dry']])
})

test('files are removed before the real delete, in chunks of 100', async () => {
  const files = Array.from({ length: 230 }, (_, i) => `p/${i}.pdf`)
  const db = fakeDb({ plan: { orders: 12, weeks: 1, files } })
  const r = await purgeOld(db)
  assert.deepEqual(r, { orders: 12, weeks: 1, skipped: false })
  assert.deepEqual(db.log, [['rpc', 'dry'], ['remove', 100], ['remove', 100], ['remove', 30], ['rpc', 'real']])
})

test('a failed file removal stops everything before any order is deleted', async () => {
  const db = fakeDb({ plan: { orders: 3, weeks: 1, files: ['a.pdf'] }, removeError: { message: 'denied' } })
  await assert.rejects(() => purgeOld(db), /denied/)
  assert.deepEqual(db.log, [['rpc', 'dry'], ['remove', 1]]) // no 'real'
})

test('a very large clear-out waits for a yes', async () => {
  const db = fakeDb({ plan: { orders: 400, weeks: 9, files: [] } })
  assert.deepEqual(await purgeOld(db, { ask: () => false }), { orders: 0, weeks: 0, skipped: true })
  assert.deepEqual(db.log, [['rpc', 'dry']])
  const db2 = fakeDb({ plan: { orders: 400, weeks: 9, files: [] } })
  assert.equal((await purgeOld(db2, { ask: () => true })).orders, 400)
})

test('summary wording', () => {
  assert.equal(purgeSummary({ orders: 14, weeks: 1 }), 'Cleared 14 orders and 1 empty week older than 6 weeks.')
  assert.equal(purgeSummary({ orders: 1, weeks: 0 }), 'Cleared 1 order older than 6 weeks.')
  assert.equal(purgeSummary({ orders: 0, weeks: 0 }), '')
})
