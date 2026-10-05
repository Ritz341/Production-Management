import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { MEASURE_LABELS, matchOrder, readPackage, savePackage } from '../lib/orderFiles'
import { dbErrorText } from '../lib/dbError'

const EXTRA_LABELS = ['Office', 'Shipping', 'Paperwork']
const COUNT_ORDER = ['v4t_frames', 'vents', 'walls', 'windows']

/**
 * Drop an order's whole paperwork package here (the office PC). Every PDF
 * is read in the browser: which order it is, which department each sheet
 * is for, and how many V4T frames / vents the order needs. Check it,
 * correct anything, Save — the sheets then show on the order's paperwork
 * for everyone with the department in front, and the counts feed the
 * "built today" numbers on the boards.
 */
export default function OrderPackageUpload() {
  const input = useRef(null)
  const [orders, setOrders] = useState([])
  const [depts, setDepts] = useState([])
  const [pkg, setPkg] = useState(null) // { items, tag }
  const [labels, setLabels] = useState({}) // `${file index}:${run index}` -> label
  const [orderId, setOrderId] = useState('')
  const [counts, setCounts] = useState({}) // measure -> string
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('bt_orders')
      .select('id, tag_name')
      .eq('status', 'active')
      .is('actual_pickup_date', null)
      .order('tag_name')
      .then(({ data }) => setOrders(data ?? []))
    supabase
      .from('bt_departments')
      .select('name, sort_order')
      .order('sort_order')
      .then(({ data }) => setDepts((data ?? []).map((d) => d.name)))
  }, [])

  async function pick(e) {
    const files = [...(e.target.files ?? [])].filter((f) => /\.pdf$/i.test(f.name))
    e.target.value = ''
    if (!files.length) return
    setError('')
    setMessage('')
    setReading(true)
    try {
      const read = await readPackage(files)
      const found = matchOrder(read.tag, orders)
      const l = {}
      read.items.forEach((it, i) => it.runs.forEach((r, j) => (l[`${i}:${j}`] = r.label)))
      setLabels(l)
      setOrderId(found ? String(found.id) : '')
      setCounts(Object.fromEntries(Object.entries(read.quantities).map(([k, v]) => [k, String(v)])))
      setPkg(read)
    } catch (err) {
      setError(err.message || 'Could not read those files.')
    }
    setReading(false)
  }

  function cancel() {
    setPkg(null)
    setMessage('')
    setError('')
  }

  async function save() {
    const order = orders.find((o) => String(o.id) === orderId)
    if (!order) return
    setSaving(true)
    setError('')
    try {
      const items = pkg.items.map((it, i) => ({ ...it, runs: it.runs.map((r, j) => ({ ...r, label: labels[`${i}:${j}`] || r.label })) }))
      // a number the office changed is theirs: it stays through re-uploads
      const read = pkg.quantities
      const fileQty = {}
      const typedQty = {}
      for (const [m, v] of Object.entries(counts)) {
        if (v === '' || Number.isNaN(Number(v))) continue
        if (read[m] != null && Number(v) === read[m]) fileQty[m] = Number(v)
        else typedQty[m] = Number(v)
      }
      await savePackage(order, items, fileQty)
      const typedRows = Object.entries(typedQty).map(([measure, qty]) => ({
        order_id: order.id, measure, qty, source: 'typed', updated_at: new Date().toISOString(),
      }))
      if (typedRows.length) {
        const { error: e } = await supabase.from('bt_order_quantities').upsert(typedRows, { onConflict: 'order_id,measure' })
        if (e) throw new Error(e.message)
      }
      const n = pkg.items.filter((i) => !i.error).length
      setMessage(`Saved ${n} file${n === 1 ? '' : 's'} to ${order.tag_name}.`)
      setPkg(null)
    } catch (err) {
      setError(dbErrorText(err) || err.message || 'Could not save.')
    }
    setSaving(false)
  }

  const labelChoices = [...new Set([...depts, ...EXTRA_LABELS])]
  const countKeys = pkg ? [...new Set([...COUNT_ORDER, ...Object.keys(counts)])].filter((k) => k !== 'mods') : []

  return (
    <div className="rounded-2xl bg-white border border-paperDim overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-paperDim flex-wrap">
        <div>
          <h2 className="font-display font-bold text-xl text-charcoal leading-tight">Order paperwork</h2>
          <p className="text-sm text-steelLight">Drop an order's PDFs together. Each is filed under its department; counts are read from the text sheets.</p>
        </div>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple onChange={pick} className="hidden" />
        {!pkg && (
          <button
            onClick={() => input.current?.click()}
            disabled={reading}
            className="px-4 py-2 rounded-lg bg-safety text-charcoal font-semibold text-sm"
          >
            {reading ? 'Reading…' : 'Choose PDFs'}
          </button>
        )}
      </div>

      {message && <p className="px-4 py-3 text-sm text-andonGreen bg-andonGreenBg">✓ {message}</p>}
      {error && <p className="px-4 py-3 text-sm text-andonRed bg-andonRedBg">⚠ {error}</p>}

      {pkg && (
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-steelLight uppercase tracking-wide mb-1">Order</label>
            <select
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              aria-label="Order"
              className="w-full sm:w-96 border border-paperDim rounded-lg px-3 py-2 text-sm bg-white"
            >
              <option value="">{pkg.tag ? `No match for "${pkg.tag}" — pick the order` : 'Pick the order'}</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>{o.tag_name}</option>
              ))}
            </select>
            {pkg.tag && orderId && <p className="text-xs text-steelLight mt-1">Matched from "{pkg.tag}" on the sheets.</p>}
          </div>

          <ul className="divide-y divide-paperDim border border-paperDim rounded-lg">
            {pkg.items.map((it, i) => (
              <li key={i} className="px-3 py-2 text-sm flex items-center gap-3 flex-wrap">
                <span className="font-medium text-charcoal break-all flex-1 min-w-[12rem]">{it.file.name}</span>
                {it.error && <span className="text-andonRed text-xs">{it.error}</span>}
                {it.doc?.scanned && <span className="text-xs text-steelLight">scanned — no counts</span>}
                {it.runs.map((r, j) => (
                  <label key={j} className="flex items-center gap-1 text-xs text-steelLight">
                    {it.runs.length > 1 ? `p.${r.page}+` : 'Dept'}
                    <select
                      value={labels[`${i}:${j}`] ?? r.label}
                      onChange={(e) => setLabels((l) => ({ ...l, [`${i}:${j}`]: e.target.value }))}
                      aria-label={`Department for ${it.file.name}`}
                      className="border border-paperDim rounded px-2 py-1 text-sm text-charcoal bg-white"
                    >
                      {[...new Set([...labelChoices, r.label])].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </li>
            ))}
          </ul>

          <div>
            <p className="text-xs font-semibold text-steelLight uppercase tracking-wide mb-1">How many (read from the sheets — fix any that are wrong)</p>
            <div className="flex gap-3 flex-wrap">
              {countKeys.map((k) => (
                <label key={k} className="text-sm text-charcoal">
                  <span className="block text-xs text-steelLight">{MEASURE_LABELS[k] ?? k}</span>
                  <input
                    type="number"
                    min="0"
                    value={counts[k] ?? ''}
                    onChange={(e) => setCounts((c) => ({ ...c, [k]: e.target.value }))}
                    aria-label={MEASURE_LABELS[k] ?? k}
                    className="w-24 border border-paperDim rounded-lg px-3 py-2 text-sm tabular-nums"
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-steelLight mt-1">Mods are counted from the mod count on the order itself.</p>
            {pkg.items.some((i) => i.runs.some((r) => r.label === 'V4T')) && !counts.v4t_frames && (
              <p className="text-xs text-safetyDark font-semibold mt-1">⚠ A V4T sheet is in this package but no frame count was read — enter it, or V4T’s Done won’t be counted.</p>
            )}
            {pkg.items.some((i) => i.doc?.scanned) && (
              <p className="text-xs text-safetyDark mt-1">⚠ Scanned sheets can’t be read for counts — upload the text PDF version for the counts to come through.</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={!orderId || saving}
              className="px-4 py-2 rounded-lg bg-safety text-charcoal font-semibold text-sm disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save to order'}
            </button>
            <button onClick={cancel} className="px-4 py-2 rounded-lg text-sm text-steelLight">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
