// Fixed left-hand columns, then the status columns in sheet order. Used to
// map a paste that starts mid-sheet, where the header row (row 1, frozen) is
// nowhere in the selection.
const LEADING_COLUMNS = ['Date', 'Truck', 'Dealer', 'Tag Name']

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

// Tag names look like 'THOMPSON_164904' or 'F-26072-CAMPEAU-CHANTAL_158037'
// — an underscore followed by the order number. Used to confirm a positional
// column guess actually landed on the Tag Name column.
const TAG_SHAPED = /_\d{4,}\s*$/

function normalizeHeader(v) {
  if (v == null) return ''
  return String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Locates the header row and maps each expected column name to its index.
 *
 * The header is searched for rather than assumed to be row 0, because a paste
 * usually starts partway down the sheet. Failing that, columns are mapped by
 * position from the sheet's fixed layout — but only when the column that
 * lands on 'Tag Name' actually holds tag-shaped values, so a selection that
 * starts on the wrong column fails loudly instead of filing every status
 * under the wrong department.
 */
function findHeader(rows) {
  const wanted = new Map([...LEADING_COLUMNS, ...STATUS_COLUMNS].map((c) => [normalizeHeader(c), c]))

  for (let r = 0; r < rows.length; r++) {
    const norm = (rows[r] ?? []).map(normalizeHeader)
    // 'Tag Name' is the anchor: the section banner rows re-print the status
    // headers ('Mods', 'V4T', …) but never carry a Tag Name cell, so keying
    // on it keeps those from being mistaken for the real header.
    if (!norm.includes('tag name')) continue

    const colIndex = {}
    norm.forEach((h, i) => {
      const canonical = wanted.get(h)
      if (canonical && colIndex[canonical] == null) colIndex[canonical] = i
    })
    return { colIndex, headerIndex: r, inferred: false }
  }

  // No header in the selection — fall back to the sheet's fixed layout.
  const layout = [...LEADING_COLUMNS, ...STATUS_COLUMNS]
  const colIndex = {}
  layout.forEach((name, i) => {
    colIndex[name] = i
  })

  const tagCells = rows.map((row) => cleanCell(row?.[colIndex['Tag Name']])).filter((v) => v != null)
  const tagLike = tagCells.filter((v) => TAG_SHAPED.test(v)).length

  if (tagCells.length === 0 || tagLike / tagCells.length < 0.6) {
    throw new Error(
      "Couldn't tell which column is which. Either include the sheet's header row in what you copy, or start your selection at column A (Date) so the columns line up."
    )
  }

  return { colIndex, headerIndex: -1, inferred: true }
}

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

  const { colIndex, headerIndex, inferred } = findHeader(rows)

  const ordersByTag = new Map()
  const sectionsByDate = new Map() // isoDate -> { label, isoDate, ambiguous, count }
  let currentSection = null // { label, isoDate, ambiguous }

  for (let r = headerIndex + 1; r < rows.length; r++) {
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

  return { orders: Array.from(ordersByTag.values()), sections, inferredColumns: inferred }
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
