import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { parseTruesdaleSheet, STATUS_COLUMNS } from '../lib/parseSheet'

export default function AdminImport({ buildWeeks, onCommitted }) {
  const [parsed, setParsed] = useState(null) // { orders, sections }
  const [staleOrders, setStaleOrders] = useState([]) // orders in DB but not in this upload
  const [staleToDelete, setStaleToDelete] = useState({}) // staleOrder.id -> bool
  const [confirmedDelete, setConfirmedDelete] = useState(false)
  const [sectionOverrides, setSectionOverrides] = useState({}) // isoDate -> { label, isoDate }
  const [includedOrders, setIncludedOrders] = useState({}) // tagName -> bool
  const [includedColumns, setIncludedColumns] = useState({}) // tagName -> { colName: bool }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const presentColumns = useMemo(() => {
    if (!parsed) return []
    const seen = new Set()
    parsed.orders.forEach((o) => Object.keys(o.columns).forEach((c) => seen.add(c)))
    return STATUS_COLUMNS.filter((c) => seen.has(c))
  }, [parsed])

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setResult(null)
    try {
      const data = await parseTruesdaleSheet(file)
      setParsed(data)

      const currentTags = new Set(data.orders.map((o) => o.tagName))
      const { data: existing } = await supabase.from('bt_orders').select('id, tag_name')
      const stale = (existing ?? []).filter((o) => !currentTags.has(o.tag_name))
      setStaleOrders(stale)
      setStaleToDelete(Object.fromEntries(stale.map((o) => [o.id, true])))
      setConfirmedDelete(false)

      const overrides = {}
      data.sections.forEach((s) => {
        overrides[s.isoDate] = { label: s.label, isoDate: s.isoDate }
      })
      setSectionOverrides(overrides)

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
        const override = sectionOverrides[s.isoDate]
        weekIdByOriginalDate[s.isoDate] = await resolveBuildWeekId(override.isoDate, override.label)
      }

      const { data: colRows } = await supabase.from('bt_status_columns').select('id, name')
      const colIdByName = Object.fromEntries((colRows ?? []).map((c) => [c.name, c.id]))

      let orderCount = 0
      let statusCount = 0
      let skipped = 0

      for (const o of parsed.orders) {
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

      <div className="space-y-2">
        <label className="block text-sm font-medium text-steel">Upload Truesdale sheet (.xlsx)</label>
        <input type="file" accept=".xlsx,.xls" onChange={handleFile} className="text-sm" />
      </div>

      {error && <p className="text-andonRed text-sm">{error}</p>}
      {result && (
        <p className="text-andonGreen text-sm font-medium">
          Loaded {result.orderCount} orders, {result.statusCount} status values.
          {result.skipped > 0 && ` (${result.skipped} orders excluded, as selected.)`}
        </p>
      )}

      {parsed && (
        <div className="space-y-5">
          {staleOrders.length > 0 && (
            <div className="bg-andonRedBg border border-andonRed p-3 text-sm text-andonRed space-y-2">
              <p>
                ⚠ {staleOrders.length} order(s) currently in the app are not on this sheet anymore (e.g.
                shipped/completed and dropped off). Uncheck any you want to <strong>keep</strong> — everything left
                checked is <strong>permanently deleted</strong>, files included, when you load this import.
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
              <label className="flex items-center gap-2 cursor-pointer font-semibold pt-1 border-t border-andonRed/30">
                <input type="checkbox" checked={confirmedDelete} onChange={(e) => setConfirmedDelete(e.target.checked)} />
                I confirm deleting {staleOrders.filter((o) => staleToDelete[o.id]).length} order(s) above
              </label>
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-steel mb-2">
              Detected {parsed.sections.length} pickup-date sections in the sheet — each becomes its own build week.
              Confirm the dates below (⚠ flagged ones had a "?" in the sheet, meaning they weren't confirmed there
              either).
            </p>
            <div className="flex flex-wrap gap-3">
              {parsed.sections.map((s) => (
                <div key={s.isoDate} className={`border p-2 text-sm ${s.ambiguous ? 'border-safety bg-safety/10' : 'border-paperDim'}`}>
                  <div className="font-medium text-charcoal">
                    {s.ambiguous && '⚠ '}
                    {s.count} orders
                  </div>
                  <input
                    type="date"
                    value={sectionOverrides[s.isoDate]?.isoDate ?? s.isoDate}
                    onChange={(e) => updateSectionDate(s.isoDate, e.target.value)}
                    className="border border-paperDim rounded px-1 py-0.5 text-xs mt-1"
                  />
                </div>
              ))}
            </div>
            {parsed.orders.some((o) => !o.scheduledPickupDate) && (
              <p className="text-xs text-steelLight mt-2">
                {parsed.orders.filter((o) => !o.scheduledPickupDate).length} orders appear before any pickup-date
                marker (already shipped/historical) — these load without a build week assignment.
              </p>
            )}
          </div>

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
                {parsed.orders.map((o, i) => {
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
          <button
            onClick={handleCommit}
            disabled={busy || (staleOrders.some((o) => staleToDelete[o.id]) && !confirmedDelete)}
            className="bg-safety text-charcoal font-display font-bold text-lg px-6 py-2 disabled:opacity-50"
          >
            {busy ? 'Loading…' : `Load ${parsed.orders.filter((o) => includedOrders[o.tagName]).length} orders`}
          </button>
        </div>
      )}
    </div>
  )
}
