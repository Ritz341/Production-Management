import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { weekOptionLabel } from '../lib/dates'

/**
 * Add or edit an order's core fields, and attach any department/status
 * columns it's missing (e.g. the weekly import didn't include Mods or
 * V4T for this tag because the sheet didn't have it, but it actually
 * needs to be built). Never removes an existing column here — that's
 * what the 👁/🚫 visibility toggle in the Grid is for.
 */
export default function OrderFormModal({ order, columns, buildWeeks, onClose, onSaved, allowPull = false }) {
  const isEdit = !!order
  const existingColumnIds = new Set(order ? Object.keys(order.statuses).map(Number) : [])

  const [tagName, setTagName] = useState(order?.tag_name ?? '')
  const [dealer, setDealer] = useState(order?.dealer ?? '')
  const [truckRoute, setTruckRoute] = useState(order?.truck_route ?? '')
  const [shippingStatus, setShippingStatus] = useState(order?.shipping_status ?? '')
  const [buildWeekId, setBuildWeekId] = useState(order?.build_week_id ?? '')
  const [scheduledPickupDate, setScheduledPickupDate] = useState(order?.scheduled_pickup_date ?? '')
  const [selectedColumnIds, setSelectedColumnIds] = useState(new Set(existingColumnIds))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pullNote, setPullNote] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const columnName = Object.fromEntries(columns.map((c) => [c.id, c.name]))

  // Pulling an order applies immediately (not on Save), so a cancelled
  // order disappears from the floor the moment admin decides.
  async function pull(action, columnId) {
    setBusy(true)
    setError('')
    const note = pullNote.trim() || null
    let result
    if (action === 'cancel') {
      result = await supabase
        .from('bt_orders')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: note })
        .eq('id', order.id)
    } else if (action === 'restore') {
      result = await supabase.from('bt_orders').update({ status: 'active', cancelled_at: null, cancel_reason: null }).eq('id', order.id)
    } else if (action === 'remove-dept') {
      result = await supabase
        .from('bt_order_status')
        .update({ removed_at: new Date().toISOString(), removed_note: note })
        .eq('order_id', order.id)
        .eq('status_column_id', columnId)
    } else if (action === 'restore-dept') {
      result = await supabase
        .from('bt_order_status')
        .update({ removed_at: null, removed_note: null })
        .eq('order_id', order.id)
        .eq('status_column_id', columnId)
    }
    setBusy(false)
    if (result?.error) return setError(result.error.message)
    onSaved?.()
    onClose()
  }

  function toggleColumn(id) {
    setSelectedColumnIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSave() {
    if (!tagName.trim()) {
      setError('Tag Name is required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const fields = {
        tag_name: tagName.trim(),
        dealer: dealer.trim() || null,
        truck_route: truckRoute.trim() || null,
        shipping_status: shippingStatus.trim() || null,
        build_week_id: buildWeekId || null,
        scheduled_pickup_date: scheduledPickupDate || null,
      }

      let orderId
      if (isEdit) {
        const { error: updateErr } = await supabase.from('bt_orders').update(fields).eq('id', order.id)
        if (updateErr) throw updateErr
        orderId = order.id
      } else {
        const { data, error: insertErr } = await supabase.from('bt_orders').insert(fields).select().single()
        if (insertErr) throw insertErr
        orderId = data.id
      }

      // Only ADD columns that aren't already there — never touch ones
      // that exist, so we don't reset a stage someone already set.
      const toAdd = [...selectedColumnIds].filter((id) => !existingColumnIds.has(id))
      for (const columnId of toAdd) {
        const { error: statusErr } = await supabase
          .from('bt_order_status')
          .insert({ order_id: orderId, status_column_id: columnId, is_visible: true })
        if (statusErr) throw statusErr
      }

      onSaved?.()
      onClose()
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 bg-charcoal/60 flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-paper w-full sm:max-w-lg max-h-[85vh] overflow-y-auto border-t-4 border-safety"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 bg-charcoal">
          <h2 className="font-display text-2xl font-bold text-paper tracking-wide">{isEdit ? 'Edit Order' : 'New Order'}</h2>
          <button onClick={onClose} className="text-steelLight text-sm hover:text-paper">
            Close
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && <p className="text-andonRed text-sm">{error}</p>}

          <div>
            <label className="block text-sm font-medium text-steel mb-1">Tag Name</label>
            <input
              value={tagName}
              onChange={(e) => setTagName(e.target.value)}
              className="w-full border border-paperDim rounded px-3 py-2 text-sm"
              placeholder="e.g. SB-PM-BLAIR-100_166168"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-steel mb-1">Dealer</label>
              <input value={dealer} onChange={(e) => setDealer(e.target.value)} className="w-full border border-paperDim rounded px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-steel mb-1">Truck Route</label>
              <input
                value={truckRoute}
                onChange={(e) => setTruckRoute(e.target.value)}
                className="w-full border border-paperDim rounded px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-steel mb-1">
                Pickup {isEdit && <span className="text-steelLight font-normal">(moving it goes to the bottom of that pickup)</span>}
              </label>
              <select
                value={buildWeekId}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : ''
                  setBuildWeekId(id)
                  // Delaying to another pickup moves the pickup date with it.
                  const week = buildWeeks.find((w) => w.id === id)
                  if (week?.ship_date) setScheduledPickupDate(week.ship_date)
                }}
                className="w-full border border-paperDim rounded px-3 py-2 text-sm"
              >
                <option value="">None</option>
                {buildWeeks.map((w) => (
                  <option key={w.id} value={w.id}>
                    {weekOptionLabel(w)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-steel mb-1">Scheduled Pickup</label>
              <input
                type="date"
                value={scheduledPickupDate ?? ''}
                onChange={(e) => setScheduledPickupDate(e.target.value)}
                className="w-full border border-paperDim rounded px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-steel mb-1">Ship Status (raw sheet text)</label>
            <input
              value={shippingStatus}
              onChange={(e) => setShippingStatus(e.target.value)}
              className="w-full border border-paperDim rounded px-3 py-2 text-sm"
              placeholder="e.g. Shipped 8/14, CREDIT HOLD…"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-steel mb-2">
              Departments / columns to build {isEdit && <span className="text-steelLight font-normal">(checking one here only adds it — uncheck nothing here removes it; use the 👁 toggle in the Grid for that)</span>}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto border border-paperDim rounded p-2">
              {columns.map((c) => {
                const already = existingColumnIds.has(c.id)
                return (
                  <label key={c.id} className={`flex items-center gap-1.5 text-sm px-1.5 py-1 rounded ${already ? 'text-steelLight' : 'text-charcoal cursor-pointer hover:bg-paper'}`}>
                    <input
                      type="checkbox"
                      checked={selectedColumnIds.has(c.id)}
                      disabled={already}
                      onChange={() => toggleColumn(c.id)}
                    />
                    {c.name}
                    {already && <span className="text-xs">✓</span>}
                  </label>
                )
              })}
            </div>
          </div>

          {isEdit && allowPull && (
            <div className="border-t-2 border-paperDim pt-4 space-y-3">
              <h3 className="font-display text-xl font-bold text-charcoal">Pull or change this order</h3>
              <div>
                <label htmlFor="pull-note" className="block text-sm font-medium text-steel mb-1">
                  Reason
                </label>
                <input
                  id="pull-note"
                  value={pullNote}
                  onChange={(e) => setPullNote(e.target.value)}
                  placeholder="e.g. Canada will do the V4T, or dealer cancelled"
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm"
                />
              </div>

              <div>
                <p className="text-sm font-medium text-steel mb-1.5">Take one department off (the rest still build it)</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(order.statuses)
                    .filter(([, c]) => c)
                    .map(([colId, c]) =>
                      c.removed ? (
                        <button
                          key={colId}
                          onClick={() => pull('restore-dept', Number(colId))}
                          disabled={busy}
                          title={c.removedNote ?? ''}
                          className="rounded-full border border-dashed border-steelLight px-3 py-1.5 text-sm text-steelLight"
                        >
                          <s>{columnName[colId]}</s> · Restore
                        </button>
                      ) : (
                        <button
                          key={colId}
                          onClick={() => pull('remove-dept', Number(colId))}
                          disabled={busy}
                          className="rounded-full border border-paperDim bg-white px-3 py-1.5 text-sm text-charcoal hover:border-andonRed hover:text-andonRed"
                        >
                          {columnName[colId]} ✕
                        </button>
                      )
                    )}
                </div>
              </div>

              {order.status === 'cancelled' ? (
                <div className="bg-andonRedBg text-andonRed rounded p-3 text-sm flex items-center justify-between gap-3">
                  <span>
                    <b>Cancelled</b>
                    {order.cancel_reason ? ` — ${order.cancel_reason}` : ''}
                  </span>
                  <button onClick={() => pull('restore')} disabled={busy} className="bg-white text-charcoal font-semibold rounded px-3 py-1.5">
                    Restore order
                  </button>
                </div>
              ) : !confirmCancel ? (
                <button onClick={() => setConfirmCancel(true)} className="text-sm font-semibold text-andonRed">
                  Cancel the whole order…
                </button>
              ) : (
                <div className="bg-andonRedBg rounded p-3 text-sm text-andonRed space-y-2">
                  <p>It comes off every tablet. You can restore it later from the Grid (Show cancelled).</p>
                  <div className="flex gap-2">
                    <button onClick={() => pull('cancel')} disabled={busy} className="bg-andonRed text-white font-bold rounded px-3 py-1.5">
                      Cancel order
                    </button>
                    <button onClick={() => setConfirmCancel(false)} className="text-steel px-2">
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="text-sm text-steelLight px-3 py-2">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={busy}
              className="bg-safety text-charcoal font-display font-bold text-lg px-6 py-2 disabled:opacity-50"
            >
              {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Order'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
