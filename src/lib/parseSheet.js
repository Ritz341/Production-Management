import * as XLSX from 'xlsx'

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
 * Parses the 'Truesdale' sheet from an uploaded workbook (File object).
 * Walks every row top-to-bottom tracking the most recent 'PICK UP x/x'
 * banner row, so each order gets tagged with the pickup-date section it
 * actually falls under in the sheet — not just a single date for the
 * whole file.
 *
 * Returns:
 *   {
 *     orders: [{ tagName, truckRoute, dealer, shippingStatus, scheduledPickupDate, sectionLabel, columns }],
 *     sections: [{ label, isoDate, ambiguous, count }]   // in sheet order
 *   }
 */
export async function parseTruesdaleSheet(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })

  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'truesdale')
  if (!sheetName) {
    throw new Error(`No 'Truesdale' tab found. Sheets in this file: ${wb.SheetNames.join(', ')}`)
  }
  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })

  const header = rows[0].map((h) => (typeof h === 'string' ? h.trim() : h))
  const colIndex = {}
  header.forEach((h, i) => {
    if (h != null) colIndex[h] = i
  })

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
