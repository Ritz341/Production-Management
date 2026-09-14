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
export default function OrderFormModal({ order, columns, buildWeeks, onClose, onSaved }) {
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
              <label className="block text-sm font-medium text-steel mb-1">Build Week</label>
              <select
                value={buildWeekId}
                onChange={(e) => setBuildWeekId(e.target.value ? Number(e.target.value) : '')}
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
