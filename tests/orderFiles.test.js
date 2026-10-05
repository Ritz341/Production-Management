import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDocument, findTag, labelFor, matchOrder, parseBooklet, parseV4T, quantitiesFrom } from '../src/lib/orderFiles.js'

// Pages shaped like readPdf() returns them: lines top to bottom.
const doc = (...pages) => ({
  scanned: false,
  pages: pages.map((lines, i) => ({ n: i + 1, lines, text: lines.join('\n') })),
})

const V4T_FRAME = [
  'SUNSPACE CUTSHEET',
  'VERTICAL 4 TRACK FRAME CUT & ASSEMBLY',
  'Tag Name: Smith-Jones_123456 Page: 1',
  'W1-1 36.6875 68.8125 Bronze DLO 38.6875 38.6875',
  'Vertical 4 Track 4 Vent',
  'W2-2 30.0000 50.0000 Bronze DLO 32.0000 32.0000',
  'Vertical 4 Track 2 Vent',
]
const V4T_QC = [
  'SUNSPACE CUTSHEET',
  'VERTICAL 4 TRACK QUALITY CONTROL & SCREENING',
  'Tag Name: Smith-Jones_123456 Page: 1',
  'W1-1 36.6875 68.8125 DLO Bronze Clear Clear Clear Clear 4',
  'W2-2 30.0000 50.0000 DLO Bronze Clear Clear 2',
]

test('V4T: frames counted once across pages, vents read per frame from the QC page', () => {
  const v = parseV4T(doc(V4T_FRAME, V4T_QC))
  assert.equal(v.frames, 2)
  assert.equal(v.vents, 6) // 4 + 2, not 2 × 4
  assert.equal(v.ventsFrom, 'qc')
  assert.deepEqual(v.perFrame, { 'W1-1': 4, 'W2-2': 2 })
})

test('V4T: without a QC page, vents fall back to the window type and say so', () => {
  const v = parseV4T(doc(V4T_FRAME))
  assert.equal(v.frames, 2)
  assert.equal(v.vents, 8) // first "N Vent" × frames
  assert.equal(v.ventsFrom, 'window type')
})

test('V4T: sizes like 68.8125 are never taken as a vent quantity', () => {
  const v = parseV4T(doc(V4T_FRAME, ['VERTICAL 4 TRACK QUALITY CONTROL', 'W1-1 36.6875 68.8125 DLO', 'W2-2 30.0000 50.0000 DLO']))
  assert.equal(v.ventsFrom, 'window type')
})

const BOOKLET = [
  ['ORDER CONFIRMATION', 'SUNSPACE MODULAR ENCLOSURES INC.', 'B/N 86669 8061 Order Number', '300 TORONTO ST', '20101201', 'Shipping: Ontario Friday Terms: 5% 15', 'Tag Name: Smith-Jones_123456 Page: 1'],
  ['SUNSPACE SPECIFICATION SHEET', 'Wall: Wall 1', 'W3 W4 W5', 'F6'],
  ['SUNSPACE SPECIFICATION SHEET', 'Wall: Wall 2', 'W10 W11'],
]

test('booklet: order number skips the street address; walls and windows counted', () => {
  const b = parseBooklet(doc(...BOOKLET))
  assert.equal(b.order, '20101201')
  assert.equal(b.ship, 'Ontario Friday')
  assert.equal(b.walls, 2)
  assert.equal(b.windows, 5)
})

test('quantities from a booklet and a V4T sheet', () => {
  assert.deepEqual(quantitiesFrom(doc(...BOOKLET)), { walls: 2, windows: 5 })
  assert.deepEqual(quantitiesFrom(doc(V4T_FRAME, V4T_QC)), { v4t_frames: 2, vents: 6 })
})

test('department labels from sheet titles, file names for scans', () => {
  assert.equal(labelFor('VERTICAL 4 TRACK FRAME CUT'), 'V4T')
  assert.equal(labelFor('ORDER CONFIRMATION'), 'Office')
  assert.equal(labelFor('Roof panel cut list'), 'Roof')
  assert.equal(labelFor('nothing here'), null)
  assert.deepEqual(classifyDocument('Delivery slip.pdf', { scanned: true, pages: [] }), [{ label: 'Shipping', page: 1, scanned: true }])
  // a spec sheet mentions "Window V4T" in its body; only the title decides
  const runs = classifyDocument('booklet.pdf', doc(BOOKLET[0], ['SUNSPACE SPECIFICATION SHEET', 'Window Type: V4T 4 Vent']))
  assert.deepEqual(runs, [{ label: 'Office', page: 1 }])
})

test('tag found on the sheet and matched to the order', () => {
  const d = doc(V4T_FRAME)
  assert.equal(findTag(d), 'Smith-Jones_123456')
  const orders = [{ id: 1, tag_name: 'SMITH-JONES_123456' }, { id: 2, tag_name: 'Other_999999' }]
  assert.equal(matchOrder('Smith-Jones_123456', orders).id, 1)
  assert.equal(matchOrder('smith jones 123456', orders).id, 1)
  // a retyped name with the same order number still matches
  assert.equal(matchOrder('Smyth-Jones_123456', orders).id, 1)
  assert.equal(matchOrder('Nobody_111111', orders), null)
})
