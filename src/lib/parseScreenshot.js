import { parseRows, STATUS_COLUMNS } from './parseSheet'

// Header labels we expect across the top of the Truesdale sheet. Longest
// first so 'Roof Panels' wins over a bare 'Roof' when matching.
const HEADER_LABELS = ['Tag Name', 'Dealer', 'Truck', 'Date', ...STATUS_COLUMNS].sort(
  (a, b) => b.length - a.length
)

// Below this, a cell is surfaced to admin for eyeballing rather than trusted.
const LOW_CONFIDENCE = 75

function centerY(w) {
  return (w.bbox.y0 + w.bbox.y1) / 2
}

function centerX(w) {
  return (w.bbox.x0 + w.bbox.x1) / 2
}

/**
 * Groups words into visual rows. Tesseract's own line grouping breaks down on
 * wide tables with sparse cells (it often splits one table row into several
 * lines), so rows are re-derived from vertical position instead.
 */
function groupIntoRows(words) {
  const heights = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10
  const tolerance = medianHeight * 0.6

  const sorted = [...words].sort((a, b) => centerY(a) - centerY(b))
  const rows = []
  let current = []
  let anchor = null

  for (const w of sorted) {
    if (anchor == null || Math.abs(centerY(w) - anchor) <= tolerance) {
      current.push(w)
      anchor = anchor == null ? centerY(w) : (anchor * (current.length - 1) + centerY(w)) / current.length
    } else {
      rows.push(current)
      current = [w]
      anchor = centerY(w)
    }
  }
  if (current.length > 0) rows.push(current)

  return rows.map((r) => r.sort((a, b) => centerX(a) - centerX(b)))
}

/**
 * Finds the header row and resolves each expected label to an x-position, by
 * greedily matching label text against consecutive words in the row.
 */
function findColumns(rows) {
  let best = null

  for (const row of rows) {
    const text = row.map((w) => w.text).join(' ')
    if (!/tag\s*name/i.test(text)) continue

    const columns = []
    const used = new Set()

    for (const label of HEADER_LABELS) {
      const wanted = label.toLowerCase().replace(/\s+/g, '')
      for (let i = 0; i < row.length; i++) {
        if (used.has(i)) continue
        let joined = ''
        for (let j = i; j < row.length && j < i + 4; j++) {
          if (used.has(j)) break
          joined += row[j].text.toLowerCase().replace(/\s+/g, '')
          if (joined === wanted) {
            for (let k = i; k <= j; k++) used.add(k)
            const span = row.slice(i, j + 1)
            columns.push({
              label,
              x: (span[0].bbox.x0 + span[span.length - 1].bbox.x1) / 2,
            })
            i = j
            break
          }
          if (!wanted.startsWith(joined)) break
        }
      }
    }

    if (!best || columns.length > best.columns.length) {
      best = { headerRow: row, columns: columns.sort((a, b) => a.x - b.x) }
    }
  }

  return best
}

/**
 * Rebuilds a table grid from positioned words. Exported separately from the
 * OCR call so the reconstruction logic — the part most likely to put a value
 * in the wrong column — can be tested without running the engine.
 */
export function buildGrid(words) {
  if (words.length === 0) throw new Error('No text found in that image.')

  const rows = groupIntoRows(words)
  const found = findColumns(rows)
  if (!found || found.columns.length < 2) {
    throw new Error(
      "Couldn't find the header row in that screenshot. Make sure the row with 'Tag Name' and 'Dealer' is visible in the image."
    )
  }

  const { headerRow, columns } = found

  // Column boundaries sit midway between neighbouring header centres.
  const bounds = columns.map((c, i) => {
    const prev = columns[i - 1]
    const next = columns[i + 1]
    return {
      label: c.label,
      min: prev ? (prev.x + c.x) / 2 : -Infinity,
      max: next ? (c.x + next.x) / 2 : Infinity,
    }
  })

  const headerY = centerY(headerRow[0])
  const grid = [columns.map((c) => c.label)]
  const lowConfidence = []
  const tagIdx = columns.findIndex((c) => c.label === 'Tag Name')

  for (const row of rows) {
    if (centerY(row[0]) <= headerY) continue // header and anything above it

    const cells = columns.map(() => [])
    const cellConfidence = columns.map(() => [])

    for (const w of row) {
      const x = centerX(w)
      const idx = bounds.findIndex((b) => x >= b.min && x < b.max)
      if (idx === -1) continue
      cells[idx].push(w.text)
      cellConfidence[idx].push(w.confidence)
    }

    const values = cells.map((c) => (c.length ? c.join(' ').trim() : null))
    if (values.every((v) => v == null)) continue

    const tagName = tagIdx === -1 ? null : values[tagIdx]
    values.forEach((v, i) => {
      if (v == null) return
      const conf = Math.min(...cellConfidence[i])
      if (conf < LOW_CONFIDENCE) {
        lowConfidence.push({ tagName, column: columns[i].label, text: v, confidence: Math.round(conf) })
      }
    })

    grid.push(values)
  }

  return { grid, lowConfidence, columnsFound: columns.length }
}

/**
 * Reads orders out of a screenshot of the Truesdale sheet.
 *
 * This is the fallback path for when only an image exists. OCR guesses at
 * characters and at which column a value sits in, so nothing here is
 * trusted: the result goes through the same review table as every other
 * import, and anything the engine was unsure of is flagged for checking.
 *
 * Prefer pasting cells straight from Excel — that carries exact text.
 */
export async function parseScreenshot(image, onProgress) {
  // ~15MB of engine and language data, fetched on first use. Kept out of the
  // main bundle so the shop tablets never pay for it.
  const { createWorker } = await import('tesseract.js')

  let worker
  try {
    worker = await createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && onProgress) onProgress(Math.round(m.progress * 100))
      },
    })
  } catch (err) {
    throw new Error(
      `Couldn't load the text-recognition engine (${err.message}). It downloads on first use, so this usually means no internet access. Paste the cells from Excel instead — that works offline.`
    )
  }

  try {
    const { data } = await worker.recognize(image, {}, { blocks: true })

    const words = []
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const w of line.words ?? []) {
            if (w.text && w.text.trim() !== '') words.push(w)
          }
        }
      }
    }
    const { grid, lowConfidence, columnsFound } = buildGrid(words)

    return {
      ...parseRows(grid),
      ocr: { confidence: Math.round(data.confidence), lowConfidence, columnsFound },
    }
  } finally {
    await worker.terminate()
  }
}
