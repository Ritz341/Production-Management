// Reading an order's paperwork package.
//
// The office drops the order's PDFs in together. Each is read in the
// browser (pdf.js, vendored — it never leaves the PC): what department it
// is for, which order it belongs to, and — when it's a text PDF from the
// Sunspace system — how many of each thing the order needs.
//
// Scanned sheets (a photo of paper) have no text to read. They are still
// filed, labelled from their file name, they just contribute no counts.

import { supabase } from './supabaseClient'

const BUCKET = 'bt-files'

let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('../vendor/pdfjs/pdf.min.mjs'),
      import('../vendor/pdfjs/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })
  }
  return pdfjsPromise
}

/** Lines of text per page, top to bottom, left to right. */
export async function readPdf(file) {
  const lib = await loadPdfjs()
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const rows = new Map()
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue
      const y = Math.round(it.transform[5] / 3)
      if (!rows.has(y)) rows.set(y, [])
      rows.get(y).push({ x: it.transform[4], s: it.str })
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.s.trim()).join(' ').replace(/\s+/g, ' '))
    pages.push({ n, lines, text: lines.join('\n') })
  }
  return { pages, scanned: pages.every((p) => p.text.replace(/\s/g, '').length < 20) }
}

// ── What department is a page for ────────────────────────────
// Titles on the Sunspace sheets, then file-name hints for scans.
const TITLE_RULES = [
  [/VERTICAL 4 TRACK|V4T/i, 'V4T'],
  [/TRACK (CUT|EXTRUSION)|WALL TRACK/i, 'Track'],
  [/WALL .*PUNCH|MOD(S)? .*(FRAME|CUT)|2["”]? WALL PANEL|WALL PANEL/i, 'Mods'],
  [/ROOF/i, 'Roof'],
  [/BOX|PREP/i, 'Box Prep'],
  [/SC ?220/i, 'SC220'],
  [/TA ?144/i, 'TA144'],
  [/DELIVERY|BILL OF LADING|PACKING|LOADING/i, 'Shipping'],
  [/ORDER CONFIRMATION|SPECIFICATION SHEET/i, 'Office'],
]

export function labelFor(text) {
  for (const [re, label] of TITLE_RULES) if (re.test(text)) return label
  return null
}

function pageLabel(page) {
  // the title is in the first lines; the body of a spec sheet names
  // "Window V4T" and must not make the whole spec sheet a V4T sheet
  return labelFor(page.lines.slice(0, 4).join(' '))
}

/**
 * Split a document into runs of pages with the same department:
 * [{ label, page }] — page is the first page of the run.
 */
export function classifyDocument(filename, doc) {
  const fromName = labelFor(filename.replace(/[_-]+/g, ' '))
  if (doc.scanned) return [{ label: fromName || 'Paperwork', page: 1, scanned: true }]
  const runs = []
  for (const p of doc.pages) {
    const label = pageLabel(p) || runs.at(-1)?.label || fromName || 'Paperwork'
    if (runs.at(-1)?.label !== label) runs.push({ label, page: p.n })
  }
  return runs
}

// ── Reading numbers ──────────────────────────────────────────
export function findTag(doc) {
  for (const p of doc.pages) {
    const m = p.text.match(/Tag Name:?\s*([^\n]*?)(?:\s+Page:|\n|$)/i)
    if (m && m[1].trim()) return m[1].trim()
  }
  return null
}

/** Same order, whatever the capital letters or spacing. */
export function normTag(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function matchOrder(tag, orders) {
  if (!tag) return null
  const n = normTag(tag)
  const exact = orders.filter((o) => normTag(o.tag_name) === n)
  if (exact.length === 1) return exact[0]
  const num = tag.match(/_(\d{4,})\s*$/)?.[1]
  if (num) {
    const hit = orders.filter((o) => (o.tag_name || '').includes(num))
    if (hit.length === 1) return hit[0]
  }
  return null
}

/** Order confirmation + specification sheets. */
export function parseBooklet(doc) {
  const text = doc.pages.map((p) => p.text).join('\n')
  if (!/ORDER CONFIRMATION|SPECIFICATION SHEET/i.test(text)) return null
  const walls = new Set([...text.matchAll(/Wall:\s*Wall\s*(\d+)/gi)].map((m) => m[1]))
  const windows = new Set([...text.matchAll(/(?:^|\s)(W\d{1,3})(?=\s|$)/g)].map((m) => m[1]))
  const order = text.match(/Order Number[\s\S]{0,120}?\b(\d{7,9})\b/i)?.[1] ?? null
  const ship = text.match(/Shipping:\s*([A-Za-z ]+?)(?:\s{2,}|\s+Terms:|\n|$)/)?.[1]?.trim() ?? null
  return { order, ship, walls: walls.size || null, windows: windows.size || null }
}

/**
 * The V4T frame / QC / vent sheets.
 *
 * Vents are read per frame from the QC page's Quantity column (the last
 * number on each frame's row), so an order mixing 2- and 4-vent windows
 * adds up right. Only if the QC page isn't there or a row can't be read
 * does it fall back to "N Vent" in the window type × frames — and says so
 * (ventsFrom), so the upload screen can ask someone to check it.
 */
export function parseV4T(doc) {
  const text = doc.pages.map((p) => p.text).join('\n')
  if (!/VERTICAL 4 TRACK/i.test(text)) return null
  const items = new Set([...text.matchAll(/\b(W\d{1,3}-\d{1,3})\b/g)].map((m) => m[1]))
  if (items.size === 0) return null

  const perFrame = new Map()
  for (const page of doc.pages) {
    if (!/QUALITY CONTROL/i.test(page.lines.slice(0, 4).join(' '))) continue
    for (const line of page.lines) {
      const id = line.match(/\b(W\d{1,3}-\d{1,3})\b/)?.[1]
      if (!id) continue
      // the row's last whole number; sizes are decimals, so they never match
      const nums = [...line.matchAll(/(?:^|\s)(\d{1,2})(?=\s|$)/g)].map((m) => Number(m[1]))
      const q = nums.at(-1)
      if (q >= 1 && q <= 12) perFrame.set(id, q)
    }
  }
  const per = Number(text.match(/Track\s*(\d)\s*Vent|(\d)\s*Vent/i)?.slice(1).find(Boolean)) || null
  const allRead = [...items].every((id) => perFrame.has(id))
  const vents = allRead ? [...perFrame.values()].reduce((a, b) => a + b, 0) : per ? items.size * per : null
  return {
    frames: items.size,
    vents,
    ventsFrom: allRead ? 'qc' : per ? 'window type' : null,
    perFrame: Object.fromEntries(perFrame),
  }
}

/** Counts this document gives the order: { v4t_frames, vents, walls, windows }. */
export function quantitiesFrom(doc) {
  const out = {}
  const v = parseV4T(doc)
  if (v) {
    out.v4t_frames = v.frames
    if (v.vents) out.vents = v.vents
  }
  const b = parseBooklet(doc)
  if (b) {
    if (b.walls) out.walls = b.walls
    if (b.windows) out.windows = b.windows
  }
  return out
}

// ── Reading a whole package ──────────────────────────────────
/**
 * files: File[] → { items: [{ file, doc, runs, tag, quantities, error }],
 *                   tag, quantities }  (counts merged across files)
 */
export async function readPackage(files) {
  const items = []
  for (const file of files) {
    try {
      const doc = await readPdf(file)
      items.push({ file, doc, runs: classifyDocument(file.name, doc), tag: findTag(doc), quantities: doc.scanned ? {} : quantitiesFrom(doc) })
    } catch (e) {
      items.push({ file, doc: null, runs: [], tag: null, quantities: {}, error: e?.message || 'Could not read this PDF' })
    }
  }
  const tag = items.find((i) => i.tag)?.tag ?? null
  const quantities = {}
  for (const i of items) Object.assign(quantities, i.quantities)
  return { items, tag, quantities }
}

// ── Filing it ────────────────────────────────────────────────
function safeName(s) {
  return s.replace(/[^\w.\-]+/g, '_')
}

/**
 * Store a package against an order. Re-uploading a sheet with the same file
 * name replaces the old one. Typed counts are never overwritten.
 * quantities: { measure: qty } to save as 'file' counts.
 */
export async function savePackage(order, items, quantities) {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData?.user?.id
  const packageId = crypto.randomUUID()

  for (const it of items) {
    if (it.error || !it.runs.length) continue
    // replace an earlier copy of the same sheet
    const { data: old } = await supabase.from('bt_files').select('id, storage_path').eq('order_id', order.id).eq('filename', it.file.name)
    if (old?.length) {
      await supabase.storage.from(BUCKET).remove(old.map((o) => o.storage_path))
      await supabase.from('bt_files').delete().in('id', old.map((o) => o.id))
    }
    const path = `${safeName(order.tag_name)}/${Date.now()}_${safeName(it.file.name)}`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, it.file)
    if (upErr) throw new Error(`${it.file.name}: ${upErr.message}`)
    const rows = it.runs.map((r) => ({
      order_id: order.id,
      filename: it.file.name,
      storage_path: path,
      uploaded_by: uid,
      dept_label: r.label,
      kind: r.scanned ? 'scan' : 'text',
      package_id: packageId,
      page: r.page,
    }))
    const { error: rowErr } = await supabase.from('bt_files').insert(rows)
    if (rowErr) throw new Error(`${it.file.name}: ${rowErr.message}`)
  }

  const entries = Object.entries(quantities ?? {})
  if (entries.length) {
    const { data: typed } = await supabase.from('bt_order_quantities').select('measure').eq('order_id', order.id).eq('source', 'typed')
    const keep = new Set((typed ?? []).map((t) => t.measure))
    const rows = entries
      .filter(([m]) => !keep.has(m))
      .map(([measure, qty]) => ({ order_id: order.id, measure, qty, source: 'file', updated_at: new Date().toISOString() }))
    if (rows.length) {
      const { error } = await supabase.from('bt_order_quantities').upsert(rows, { onConflict: 'order_id,measure' })
      if (error) throw new Error(error.message)
    }
  }
  return packageId
}

export const MEASURE_LABELS = {
  mods: 'mods',
  v4t_frames: 'V4T frames',
  vents: 'vents',
  walls: 'walls',
  windows: 'windows',
  tracks: 'tracks',
  roof_panels: 'roof panels',
  filler_panels: 'mod filler panels',
  doors: 'doors',
}
