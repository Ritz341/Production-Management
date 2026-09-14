export const STATUS_COLUMNS = [
  'Mods', 'V4T', 'Vin. Fix', 'Vin. Trap', 'Alum. Fix', 'Alum. Trap', 'XX',
  'H2/4', 'PVC', 'I-A', 'Doors', 'Roof Panels', 'Roof Extr.', 'Track',
  'Therm a deck', 'Acrylic', 'Deck', 'Valance', 'Rail', 'PATIO Door',
  'Glass', 'Pergola', 'R. Screen', 'Nova Sun', 'Stairs',
]

// Matches banner rows like 'PICK UP 9/4' or 'PIck UP 9/21?' in the Dealer
// column. Anchored so it never matches a real dealer name (e.g. 'Pickens
// Siding & Windows' correctly fails — no date immediately follows 'pick').
const PICKUP_BANNER = /^\s*pick\s*up\D{0,20}(\d{1,2})\/(\d{1,2})/i

function cleanCell(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v).replace(/\u00a0/g, '').trim()
  return s === '' ? null : s
}

function toIsoDate(month, day) {
  const now = new Date()
  let year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  if (candidate < new Date(now.getTime() - 1000 * 60 * 60 * 24 * 180)) year += 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Walks a grid of rows (array of arrays, first row = header) top-to-bottom
 * tracking the most recent 'PICK UP x/x' banner row, so each order gets
 * tagged with the pickup-date section it actually falls under — not just a
 * single date for the whole grid.
 *
 * Shared by every import route: uploaded .xlsx, pasted spreadsheet cells,
 * and OCR'd screenshots all reduce to the same grid before landing here, so
 * they all produce identical output and go through the same review screen.
 *
 * Returns:
 *   {
 *     orders: [{ tagName, truckRoute, dealer, shippingStatus, scheduledPickupDate, sectionLabel, columns }],
 *     sections: [{ label, isoDate, ambiguous, count }]   // in sheet order
 *   }
 */
export function parseRows(rows) {
  if (!rows || rows.length === 0) throw new Error('Nothing to read — no rows found.')

  const header = rows[0].map((h) => (typeof h === 'string' ? h.trim() : h))
  const colIndex = {}
  header.forEach((h, i) => {
    if (h != null) colIndex[h] = i
  })

  // Without a header row there's no way to know which column is which, and
  // guessing would silently file statuses under the wrong department.
  if (colIndex['Tag Name'] == null) {
    throw new Error(
      "No 'Tag Name' column found in the header row. Make sure the first row you copied is the header row from the sheet."
    )
  }

  const ordersByTag = new Map()
  const sectionsByDate = new Map() // isoDate -> { label, isoDate, ambiguous, count }
  let currentSection = null // { label, isoDate, ambiguous }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const dealerRaw = cleanCell(row[colIndex['Dealer']])
    const tagName = cleanCell(row[colIndex['Tag Name']])

    // Section banner row: dealer column matches 'PICK UP x/x'. Checked
    // regardless of what's in the Tag Name slot — some banner rows carry
    // a 'Current as of...' note there instead of being blank.
    if (dealerRaw) {
      const m = dealerRaw.match(PICKUP_BANNER)
      if (m) {
        const month = parseInt(m[1], 10)
        const day = parseInt(m[2], 10)
        const isoDate = toIsoDate(month, day)
        const ambiguous = /\?/.test(dealerRaw)
        currentSection = { label: dealerRaw.replace(/current as of.*/i, '').trim(), isoDate, ambiguous }
        if (!sectionsByDate.has(isoDate)) {
          sectionsByDate.set(isoDate, { ...currentSection, count: 0 })
        }
        continue
      }
    }

    if (!tagName) continue

    const shippingStatus = cleanCell(row[colIndex['Date']])
    const truckRoute = cleanCell(row[colIndex['Truck']] ?? row[colIndex['Truck ']])
    const dealer = dealerRaw

    const columns = {}
    for (const colName of STATUS_COLUMNS) {
      const idx = colIndex[colName]
      if (idx == null) continue
      const val = cleanCell(row[idx])
      if (val != null) columns[colName] = val
    }

    if (currentSection) {
      sectionsByDate.get(currentSection.isoDate).count++
    }

    // last occurrence wins, same as the python script
    ordersByTag.set(tagName, {
      tagName,
      truckRoute,
      dealer,
      shippingStatus,
      scheduledPickupDate: currentSection?.isoDate ?? null,
      sectionLabel: currentSection?.label ?? null,
      columns,
    })
  }

  const sections = Array.from(sectionsByDate.values()).sort((a, b) => a.isoDate.localeCompare(b.isoDate))

  return { orders: Array.from(ordersByTag.values()), sections }
}

/**
 * Parses the 'Truesdale' sheet from an uploaded workbook (File object).
 */
export async function parseTruesdaleSheet(file) {
  // Loaded on demand: xlsx is ~600kB and only admins importing a sheet ever
  // need it. Keeping it out of the main bundle keeps the shop tablets fast.
  const XLSX = await import('xlsx')

  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })

  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'truesdale')
  if (!sheetName) {
    throw new Error(`No 'Truesdale' tab found. Sheets in this file: ${wb.SheetNames.join(', ')}`)
  }
  const ws = wb.Sheets[sheetName]
  return parseRows(XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }))
}

/**
 * Parses spreadsheet cells copied to the clipboard. Excel puts the real cell
 * text on the clipboard as tab-separated values, so this is exact — no OCR,
 * no guessing. Quoted cells may span lines, so rows are assembled by walking
 * characters rather than splitting on newlines.
 */
export function parseClipboardText(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  const trimmed = rows.filter((r) => r.some((c) => c != null && String(c).trim() !== ''))
  if (trimmed.length < 2) {
    throw new Error('That paste had no data rows — select the header row plus the order rows in the sheet, then copy.')
  }
  return parseRows(trimmed)
}
