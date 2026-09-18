import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { parseTruesdaleSheet, parseClipboardText, STATUS_COLUMNS } from '../lib/parseSheet'
import { parseScreenshot } from '../lib/parseScreenshot'

export default function AdminImport({ buildWeeks, onCommitted }) {
  const [parsed, setParsed] = useState(null) // { orders, sections }
  const [staleOrders, setStaleOrders] = useState([]) // orders in DB but not in this upload
  const [staleToDelete, setStaleToDelete] = useState({}) // staleOrder.id -> bool
  const [confirmedDelete, setConfirmedDelete] = useState(false)
  const [sectionOverrides, setSectionOverrides] = useState({}) // isoDate -> { label, isoDate }
  const [includedOrders, setIncludedOrders] = useState({}) // tagName -> bool
  // Which pickup-date sections of the sheet to import: isoDate -> bool,
  // plus NO_SECTION for rows above the first PICK UP banner.
  const [pickedSections, setPickedSections] = useState({})
  const [includedColumns, setIncludedColumns] = useState({}) // tagName -> { colName: bool }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [source, setSource] = useState(null) // 'file' | 'paste' | 'ocr'
  const [dragging, setDragging] = useState(false)
  const [ocrProgress, setOcrProgress] = useState(0)

  // Paste is bound to the document so admin can just hit Ctrl+V on arrival
  // without hunting for a box to focus first.
  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  })

  // Only orders under the pickup dates admin picked are part of this
  // import at all — the rest of the sheet is ignored.
  const pickedOrders = useMemo(
    () => (parsed ? parsed.orders.filter((o) => pickedSections[sectionOf(o)]) : []),
    [parsed, pickedSections]
  )
  const ordersToLoad = pickedOrders.filter((o) => includedOrders[o.tagName])
  const pickedLabel = parsed
    ? [
        ...parsed.sections.filter((sec) => pickedSections[sec.isoDate]).map((sec) => sec.label),
        ...(pickedSections[NO_SECTION] ? ['no pickup date'] : []),
      ].join(', ')
    : ''

  const presentColumns = useMemo(() => {
    const seen = new Set()
    pickedOrders.forEach((o) => Object.keys(o.columns).forEach((c) => seen.add(c)))
    return STATUS_COLUMNS.filter((c) => seen.has(c))
  }, [pickedOrders])

  function togglePickedSection(key) {
    setPickedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Every import route — uploaded file, pasted cells, OCR'd screenshot —
  // lands here, so all three get the same review-and-confirm step before
  // anything touches the database.
  async function applyParsed(data, source) {
    try {
      setParsed(data)
      setSource(source)

      const currentTags = new Set(data.orders.map((o) => o.tagName))
      const { data: existing } = await supabase.from('bt_orders').select('id, tag_name')
      const stale = (existing ?? []).filter((o) => !currentTags.has(o.tag_name))
      setStaleOrders(stale)
      setStaleToDelete({})
      setConfirmedDelete(false)

      const overrides = {}
      data.sections.forEach((s) => {
        overrides[s.isoDate] = { label: s.label, isoDate: s.isoDate }
      })
      setSectionOverrides(overrides)

      // Start with just the next pickup that hasn't happened yet — the
      // usual case is importing one week. Rows above the first banner are
      // normally already shipped, so they start unticked.
      const today = new Date().toISOString().slice(0, 10)
      const next = data.sections.find((sec) => sec.isoDate >= today) ?? data.sections[data.sections.length - 1]
      setPickedSections(next ? { [next.isoDate]: true } : { [NO_SECTION]: true })

      const incOrders = {}
      const incCols = {}
      data.orders.forEach((o) => {
        incOrders[o.tagName] = true
        incCols[o.tagName] = {}
        Object.keys(o.columns).forEach((c) => {
          incCols[o.tagName][c] = true
        })
      })
      setIncludedOrders(incOrders)
      setIncludedColumns(incCols)
    } catch (err) {
      setError(err.message)
      setParsed(null)
    }
  }

  async function runImport(fn, source) {
    setError('')
    setResult(null)
    setBusy(true)
    try {
      const data = await fn()
      await applyParsed(data, source)
    } catch (err) {
      setError(err.message)
      setParsed(null)
    }
    setBusy(false)
  }

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type.startsWith('image/')) {
      runImport(() => parseScreenshot(file, setOcrProgress), 'ocr')
    } else {
      runImport(() => parseTruesdaleSheet(file), 'file')
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (/\.xlsx?$/i.test(file.name)) {
      runImport(() => parseTruesdaleSheet(file), 'file')
    } else if (file.type.startsWith('image/')) {
      runImport(() => parseScreenshot(file, setOcrProgress), 'ocr')
    } else {
      setError(`Can't read "${file.name}" — drop an .xlsx sheet or a screenshot image.`)
    }
  }

  // Excel puts real cell text on the clipboard, so a paste is exact data —
  // same speed as screenshotting, none of the OCR guesswork. An image on the
  // clipboard falls through to OCR instead.
  function handlePaste(e) {
    // Don't hijack a paste meant for a field the admin is actually typing in
    // (the build-week date inputs, say).
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

    const imageItem = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
    const text = e.clipboardData?.getData('text/plain')

    if (text && text.includes('\t')) {
      e.preventDefault()
      runImport(() => parseClipboardText(text), 'paste')
    } else if (imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (file) runImport(() => parseScreenshot(file, setOcrProgress), 'ocr')
    }
  }

  function toggleStale(id) {
    setStaleToDelete((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function toggleOrder(tagName) {
    setIncludedOrders((prev) => ({ ...prev, [tagName]: !prev[tagName] }))
  }

  function toggleColumn(tagName, colName) {
    setIncludedColumns((prev) => ({
      ...prev,
      [tagName]: { ...prev[tagName], [colName]: !prev[tagName][colName] },
    }))
  }

  function updateSectionDate(isoDate, newDate) {
    setSectionOverrides((prev) => ({ ...prev, [isoDate]: { ...prev[isoDate], isoDate: newDate } }))
  }

  async function resolveBuildWeekId(isoDate, label) {
    const existing = buildWeeks.find((w) => w.ship_date === isoDate)
    if (existing) return existing.id
    const { data, error } = await supabase
      .from('bt_build_weeks')
      .insert({ label, ship_date: isoDate })
      .select()
      .single()
    if (error) throw error
    return data.id
  }

  async function handleCommit() {
    if (!parsed) return
    setBusy(true)
    setError('')
    try {
      // Full sync: remove any order that's no longer on the sheet at all
      // (shipped/completed and dropped off, or was removed entirely) —
      // but only the ones admin left checked, and only after confirming.
      const idsToDelete = staleOrders.filter((o) => staleToDelete[o.id]).map((o) => o.id)
      if (idsToDelete.length > 0) {
        if (!confirmedDelete) {
          throw new Error(`Confirm removal of ${idsToDelete.length} stale order(s) before loading.`)
        }
        await supabase.from('bt_orders').delete().in('id', idsToDelete)
      }

      // Resolve/create a build week per detected section (using the
      // possibly-edited date from sectionOverrides).
      const weekIdByOriginalDate = {}
      for (const s of parsed.sections) {
        if (!pickedSections[s.isoDate]) continue
        const override = sectionOverrides[s.isoDate]
        weekIdByOriginalDate[s.isoDate] = await resolveBuildWeekId(override.isoDate, override.label)
      }

      const { data: colRows } = await supabase.from('bt_status_columns').select('id, name')
      const colIdByName = Object.fromEntries((colRows ?? []).map((c) => [c.name, c.id]))

      let orderCount = 0
      let statusCount = 0
      let skipped = 0

      for (const o of pickedOrders) {
        if (!includedOrders[o.tagName]) {
          skipped++
          continue
        }
        const buildWeekId = o.scheduledPickupDate ? weekIdByOriginalDate[o.scheduledPickupDate] ?? null : null
        const resolvedScheduledDate = o.scheduledPickupDate
          ? sectionOverrides[o.scheduledPickupDate]?.isoDate ?? o.scheduledPickupDate
          : null

        const { data: orderRow, error: orderErr } = await supabase
          .from('bt_orders')
          .upsert(
            {
              tag_name: o.tagName,
              truck_route: o.truckRoute,
              dealer: o.dealer,
              shipping_status: o.shippingStatus,
              build_week_id: buildWeekId,
              scheduled_pickup_date: resolvedScheduledDate,
            },
            { onConflict: 'tag_name' }
          )
          .select()
          .single()
        if (orderErr) throw orderErr
        orderCount++

        for (const [colName, value] of Object.entries(o.columns)) {
          const colId = colIdByName[colName]
          if (!colId) continue
          const isVisible = includedColumns[o.tagName]?.[colName] ?? true
          const { error: statusErr } = await supabase.from('bt_order_status').upsert(
            { order_id: orderRow.id, status_column_id: colId, status_value: value, is_visible: isVisible },
            { onConflict: 'order_id,status_column_id' }
          )
          if (statusErr) throw statusErr
          statusCount++
        }
      }

      setResult({ orderCount, statusCount, skipped })
      setParsed(null)
      onCommitted?.()
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return (
    <div className="bg-white p-5 space-y-5 max-w-5xl">
      <h2 className="font-display text-2xl font-bold text-charcoal">Weekly Import</h2>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed p-5 space-y-3 ${dragging ? 'border-safety bg-safety/10' : 'border-paperDim'}`}
      >
        <p className="text-sm font-medium text-steel">
          Drop the Truesdale sheet here, or press <kbd className="px-1 border border-paperDim bg-paper">Ctrl</kbd>+
          <kbd className="px-1 border border-paperDim bg-paper">V</kbd> to paste rows copied from Excel.
        </p>
        <p className="text-xs text-steelLight">
          Pasting copied cells is exact — Excel puts the real values on the clipboard. You can select rows from partway
          down the sheet without the header row; just start the selection at column A so the columns line up. A
          screenshot has to be read by OCR, which guesses, so use it only when the file isn't available.
        </p>
        <input type="file" accept=".xlsx,.xls,image/*" onChange={handleFile} className="text-sm" />
      </div>

      {busy && ocrProgress > 0 && (
        <p className="text-sm text-steel">Reading screenshot… {ocrProgress}%</p>
      )}

      {error && <p className="text-andonRed text-sm">{error}</p>}
      {result && (
        <p className="text-andonGreen text-sm font-medium">
          Loaded {result.orderCount} orders, {result.statusCount} status values.
          {result.skipped > 0 && ` (${result.skipped} orders excluded, as selected.)`}
        </p>
      )}

      {parsed && (
        <div className="space-y-5">
          {source === 'ocr' && (
            <div className="bg-safety/10 border border-safety p-3 text-sm space-y-2">
              <p className="text-charcoal">
                ⚠ <strong>Read from a screenshot by OCR — check this before loading.</strong> Values were guessed from
                pixels and can land in the wrong column. Overall confidence {parsed.ocr.confidence}%,{' '}
                {parsed.ocr.columnsFound} columns detected.
              </p>
              {parsed.ocr.lowConfidence.length > 0 && (
                <div>
                  <p className="text-charcoal font-medium">
                    {parsed.ocr.lowConfidence.length} cell(s) the engine was unsure of:
                  </p>
                  <ul className="mt-1 max-h-32 overflow-y-auto text-xs text-steel space-y-0.5">
                    {parsed.ocr.lowConfidence.map((c, i) => (
                      <li key={i}>
                        <span className="font-medium">{c.tagName ?? '(no tag)'}</span> · {c.column}: "{c.text}" (
                        {c.confidence}%)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-steelLight">
                If the sheet file is available, paste or upload it instead — that carries exact values.
              </p>
            </div>
          )}
          {source === 'paste' && !parsed.inferredColumns && (
            <p className="text-sm text-andonGreen">
              Pasted {parsed.orders.length} orders from the clipboard — exact values, no OCR.
            </p>
          )}
          {parsed.inferredColumns && (
            <p className="bg-safety/10 border border-safety p-3 text-sm text-charcoal">
              No header row in this selection, so columns were matched by position against the sheet's normal layout
              (Date, Truck, Dealer, Tag Name, then the status columns). The values themselves are exact — but glance
              down the table below to confirm the statuses line up under the right departments.
            </p>
          )}
          <section>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h3 className="font-display text-xl font-bold text-charcoal">1 · Choose which pickup dates to import</h3>
              <span className="text-sm text-steelLight">
                Only orders listed under a ticked date are imported. The rest of the sheet is ignored.
              </span>
            </div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {parsed.sections.map((s) => {
                const on = !!pickedSections[s.isoDate]
                return (
                  <div
                    key={s.isoDate}
                    className={`rounded-lg border-2 p-3 flex gap-3 items-start ${on ? 'border-charcoal bg-white' : 'border-paperDim bg-paper opacity-70'}`}
                  >
                    <input
                      id={`sec-${s.isoDate}`}
                      type="checkbox"
                      checked={on}
                      onChange={() => togglePickedSection(s.isoDate)}
                      className="w-5 h-5 mt-0.5 accent-charcoal"
                    />
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`sec-${s.isoDate}`} className="block cursor-pointer">
                        <span className="font-display font-bold text-lg text-charcoal">{s.label}</span>
                        <span className="block text-sm text-steelLight">
                          {s.count} {s.count === 1 ? 'order' : 'orders'}
                          {s.ambiguous && <b className="text-safetyDark"> · ⚠ “?” on the sheet — check the date</b>}
                        </span>
                      </label>
                      <label className="flex items-center gap-2 mt-1.5 text-xs text-steelLight">
                        Ships
                        <input
                          type="date"
                          value={sectionOverrides[s.isoDate]?.isoDate ?? s.isoDate}
                          onChange={(e) => updateSectionDate(s.isoDate, e.target.value)}
                          className="border border-paperDim rounded px-1 py-0.5 text-xs"
                        />
                      </label>
                    </div>
                  </div>
                )
              })}
              {parsed.orders.some((o) => !o.scheduledPickupDate) && (
                <label
                  className={`rounded-lg border-2 border-dashed p-3 flex gap-3 items-start cursor-pointer ${
                    pickedSections[NO_SECTION] ? 'border-charcoal bg-white' : 'border-paperDim bg-paper opacity-70'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!!pickedSections[NO_SECTION]}
                    onChange={() => togglePickedSection(NO_SECTION)}
                    className="w-5 h-5 mt-0.5 accent-charcoal"
                  />
                  <span>
                    <span className="font-display font-bold text-lg text-charcoal">
                      {parsed.sections.length ? 'Above the first pickup date' : 'All orders'}
                    </span>
                    <span className="block text-sm text-steelLight">
                      {parsed.orders.filter((o) => !o.scheduledPickupDate).length} orders
                      {parsed.sections.length ? ' — usually already shipped. Imported with no build week.' : ''}
                    </span>
                  </span>
                </label>
              )}
            </div>
            {parsed.sections.length === 0 && (
              <p className="text-sm text-safetyDark mt-2">
                No pickup-date rows found — a row with “PICK UP 9/14” in the Dealer column marks where each pickup starts.
              </p>
            )}
          </section>

          <h3 className="font-display text-xl font-bold text-charcoal">2 · Review the orders</h3>
          <p className="text-sm text-steelLight">
            Uncheck an entire order to exclude it from this import, or uncheck one column on a specific order to hide
            just that column from the floor.
          </p>
          <div className="overflow-x-auto border border-paperDim max-h-[28rem] overflow-y-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-charcoal text-paper sticky top-0">
                <tr>
                  <th className="px-2 py-2 text-left sticky left-0 bg-charcoal">Include</th>
                  <th className="px-2 py-2 text-left">Tag Name</th>
                  <th className="px-2 py-2 text-left">Dealer</th>
                  {presentColumns.map((c) => (
                    <th key={c} className="px-2 py-2 text-left whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pickedOrders.map((o, i) => {
                  const orderIncluded = includedOrders[o.tagName]
                  return (
                    <tr key={o.tagName} className={`${i % 2 === 0 ? 'bg-white' : 'bg-paper'} ${!orderIncluded ? 'opacity-40' : ''}`}>
                      <td className="px-2 py-1 sticky left-0 bg-inherit">
                        <input type="checkbox" checked={orderIncluded} onChange={() => toggleOrder(o.tagName)} />
                      </td>
                      <td className="px-2 py-1 font-medium">{o.tagName}</td>
                      <td className="px-2 py-1 text-steelLight">{o.dealer}</td>
                      {presentColumns.map((c) => {
                        const val = o.columns[c]
                        if (val == null) return <td key={c} className="px-2 py-1" />
                        return (
                          <td key={c} className="px-2 py-1">
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                disabled={!orderIncluded}
                                checked={includedColumns[o.tagName]?.[c] ?? true}
                                onChange={() => toggleColumn(o.tagName, c)}
                              />
                              <span>{val}</span>
                            </label>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {staleOrders.length > 0 && (
            <details className="border border-paperDim bg-white p-3 text-sm">
              <summary className="cursor-pointer font-medium text-steel">
                Optional clean-up: {staleOrders.length} order(s) in the app aren't anywhere on this sheet
              </summary>
              <div className="mt-2 space-y-2 text-andonRed">
                <p>
                  Tick any that are finished and should be removed. Ticked orders are <strong>permanently deleted</strong>,
                  files included. Nothing is removed unless you tick it.
                </p>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {staleOrders.map((o) => (
                    <li key={o.id}>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={!!staleToDelete[o.id]} onChange={() => toggleStale(o.id)} />
                        {o.tag_name}
                      </label>
                    </li>
                  ))}
                </ul>
                {staleOrders.some((o) => staleToDelete[o.id]) && (
                  <label className="flex items-center gap-2 cursor-pointer font-semibold pt-1 border-t border-andonRed/30">
                    <input type="checkbox" checked={confirmedDelete} onChange={(e) => setConfirmedDelete(e.target.checked)} />
                    I confirm deleting {staleOrders.filter((o) => staleToDelete[o.id]).length} order(s) above
                  </label>
                )}
              </div>
            </details>
          )}
          <button
            onClick={handleCommit}
            disabled={busy || ordersToLoad.length === 0 || (staleOrders.some((o) => staleToDelete[o.id]) && !confirmedDelete)}
            className="bg-safety text-charcoal font-display font-bold text-lg px-6 py-2 disabled:opacity-50"
          >
            {busy
              ? 'Importing…'
              : ordersToLoad.length === 0
                ? 'Tick a pickup date above to import'
                : `Import ${ordersToLoad.length} orders — ${pickedLabel}`}
          </button>
        </div>
      )}
    </div>
  )
}

const NO_SECTION = 'none'

function sectionOf(order) {
  return order.scheduledPickupDate ?? NO_SECTION
}
