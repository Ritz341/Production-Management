import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { DONE_RANK, ago, daysUntil, relativeDay, shortDate, stageRank } from '../lib/schedule'
import NotificationBanner from '../components/NotificationBanner.jsx'
import FileModal from '../components/FileModal.jsx'
import OrderFormModal from '../components/OrderFormModal.jsx'

const LAST_COLUMNS_KEY = 'logistics.lastColumns'

/**
 * Logistics coordinator: enters confirmed orders one at a time so they
 * reach the floor right away instead of waiting for the weekly import.
 *
 * Built for entering several in a row — after each save the tag clears
 * and focus returns to it, while the pickup week and departments stay
 * picked, since consecutive orders usually share them.
 */
export default function LogisticsView() {
  const { profile, signOut } = useAuth()
  const { live } = useConnection()
  const tagRef = useRef(null)

  const [buildWeeks, setBuildWeeks] = useState([])
  const [columns, setColumns] = useState([])
  const [deptByColumn, setDeptByColumn] = useState({}) // columnId -> department name
  const [orders, setOrders] = useState([])

  const [tag, setTag] = useState('')
  const [dealer, setDealer] = useState('')
  const [route, setRoute] = useState('')
  const [notes, setNotes] = useState('')
  const [weekId, setWeekId] = useState(null) // an existing week, or 'new'
  const [newDate, setNewDate] = useState('')
  const [pickedColumns, setPickedColumns] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(LAST_COLUMNS_KEY) ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [filesFor, setFilesFor] = useState(null)
  const [editing, setEditing] = useState(null)

  async function loadWeeks() {
    const { data } = await supabase.from('bt_build_weeks').select('*').order('ship_date', { ascending: true, nullsFirst: false })
    setBuildWeeks(data ?? [])
  }

  async function loadOrders() {
    const { data: rows } = await supabase
      .from('bt_orders')
      .select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date, created_at, created_by, actual_pickup_date')
      .order('created_at', { ascending: false })
      .limit(300)
    const ids = (rows ?? []).map((o) => o.id)
    const { data: statusRows } = ids.length
      ? await supabase.from('bt_order_status').select('order_id, status_column_id, workflow_stage, is_visible, blocked_at').in('order_id', ids)
      : { data: [] }
    const byId = new Map((rows ?? []).map((o) => [o.id, { ...o, statuses: {} }]))
    for (const s of statusRows ?? []) {
      const o = byId.get(s.order_id)
      if (o) o.statuses[s.status_column_id] = { stage: s.workflow_stage, visible: s.is_visible, blocked: !!s.blocked_at }
    }
    setOrders([...byId.values()])
  }

  useEffect(() => {
    loadWeeks()
    loadOrders()
    supabase.from('bt_status_columns').select('id, name').order('sort_order').then(({ data }) => setColumns(data ?? []))
    Promise.all([
      supabase.from('bt_departments').select('id, name'),
      supabase.from('bt_department_columns').select('department_id, status_column_id'),
    ]).then(([{ data: depts }, { data: links }]) => {
      const name = Object.fromEntries((depts ?? []).map((d) => [d.id, d.name]))
      setDeptByColumn(Object.fromEntries((links ?? []).map((l) => [l.status_column_id, name[l.department_id]])))
    })

    const channel = supabase
      .channel('logistics')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, loadOrders)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, loadOrders)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, loadWeeks)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const upcomingWeeks = useMemo(
    () => buildWeeks.filter((w) => w.ship_date && daysUntil(w.ship_date) >= -1).slice(0, 6),
    [buildWeeks]
  )
  // Default the pickup to the next week out, once weeks have loaded.
  useEffect(() => {
    if (weekId == null && upcomingWeeks[0]) setWeekId(upcomingWeeks[0].id)
  }, [upcomingWeeks, weekId])

  const dealers = useMemo(() => [...new Set(orders.map((o) => o.dealer).filter(Boolean))].sort(), [orders])
  const existing = useMemo(() => new Map(orders.map((o) => [o.tag_name.toLowerCase(), o])), [orders])
  const duplicate = existing.get(tag.trim().toLowerCase())

  // Department-owned columns first (that's what the floor acts on), then the rest.
  const sortedColumns = useMemo(
    () => [...columns].sort((a, b) => (deptByColumn[a.id] ? 0 : 1) - (deptByColumn[b.id] ? 0 : 1)),
    [columns, deptByColumn]
  )

  function toggleColumn(id) {
    setPickedColumns((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function resolveWeek() {
    if (weekId !== 'new') return weekId
    const match = buildWeeks.find((w) => w.ship_date === newDate)
    if (match) return match.id
    const [, m, d] = newDate.split('-').map(Number)
    const { data, error: err } = await supabase
      .from('bt_build_weeks')
      .insert({ label: `PICK UP ${m}/${d}`, ship_date: newDate })
      .select()
      .single()
    if (err) throw err
    await loadWeeks()
    return data.id
  }

  async function addOrder(e) {
    e.preventDefault()
    const tagName = tag.trim()
    if (!tagName) return setError('Enter the tag name.')
    if (duplicate) return setError(`${duplicate.tag_name} is already in the tracker.`)
    if (weekId === 'new' && !newDate) return setError('Pick the pickup date.')
    if (pickedColumns.size === 0) return setError('Pick at least one department that builds this order.')
    if (!live) return setError('Offline — reconnect before adding orders.')

    setBusy(true)
    setError('')
    try {
      const buildWeekId = await resolveWeek()
      const pickup = buildWeeks.find((w) => w.id === buildWeekId)?.ship_date ?? (weekId === 'new' ? newDate : null)
      const { data: order, error: orderErr } = await supabase
        .from('bt_orders')
        .insert({
          tag_name: tagName,
          dealer: dealer.trim() || null,
          truck_route: route.trim() || null,
          notes: notes.trim() || null,
          build_week_id: buildWeekId,
          scheduled_pickup_date: pickup,
        })
        .select()
        .single()
      if (orderErr) throw orderErr

      const { error: statusErr } = await supabase
        .from('bt_order_status')
        .insert([...pickedColumns].map((status_column_id) => ({ order_id: order.id, status_column_id, is_visible: true })))
      if (statusErr) throw new Error(`Order saved, but its departments didn't: ${statusErr.message}. Ask admin to add them in the Grid.`)

      try {
        localStorage.setItem(LAST_COLUMNS_KEY, JSON.stringify([...pickedColumns]))
      } catch {
        /* storage unavailable — the defaults just won't be remembered */
      }
      setToast(`Added ${tagName} — it's on the floor now`)
      setTag('')
      setNotes('')
      tagRef.current?.focus()
      loadOrders()
    } catch (err) {
      setError(err.code === '23505' ? `${tagName} is already in the tracker.` : err.message)
    }
    setBusy(false)
  }

  const mine = orders.filter((o) => o.created_by && o.created_by === profile?.user_id).slice(0, 25)
  const recent = mine.length ? mine : orders.slice(0, 25)

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-3 border-b-4 border-safety">
        <div>
          <h1 className="font-display text-3xl font-bold text-paper leading-none">Logistics</h1>
          <p className="text-sm text-floorMute mt-1">Add confirmed orders — they reach the floor as soon as you save.</p>
        </div>
        <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">
          Sign out
        </button>
      </header>

      <main className="px-4 sm:px-6 py-5 max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-5 items-start">
        {/* ── Add order ── */}
        <form onSubmit={addOrder} className="rounded-2xl bg-white border border-paperDim p-5 grid gap-4">
          <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Add an order</h2>

          <div>
            <label htmlFor="lg-tag" className="block text-sm font-semibold text-steel mb-1">
              Tag name
            </label>
            <input
              id="lg-tag"
              ref={tagRef}
              autoFocus
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. ALAN-CLARKE_165665"
              className={`w-full rounded-lg border px-3 py-2.5 font-display text-xl font-bold tracking-wide ${duplicate ? 'border-andonRed' : 'border-paperDim'}`}
              autoComplete="off"
            />
            {duplicate && (
              <p className="text-sm text-andonRed mt-1">
                Already in the tracker ({duplicate.dealer ?? 'no dealer'}).{' '}
                <button type="button" onClick={() => setEditing(duplicate)} className="underline font-semibold">
                  Open it
                </button>
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
            <div>
              <label htmlFor="lg-dealer" className="block text-sm font-semibold text-steel mb-1">
                Dealer
              </label>
              <input
                id="lg-dealer"
                list="lg-dealers"
                value={dealer}
                onChange={(e) => setDealer(e.target.value)}
                placeholder="Start typing — past dealers appear"
                className="w-full rounded-lg border border-paperDim px-3 py-2.5"
              />
              <datalist id="lg-dealers">
                {dealers.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor="lg-route" className="block text-sm font-semibold text-steel mb-1">
                Truck / route
              </label>
              <input id="lg-route" value={route} onChange={(e) => setRoute(e.target.value)} placeholder="optional" className="w-full rounded-lg border border-paperDim px-3 py-2.5" />
            </div>
          </div>

          <fieldset>
            <legend className="text-sm font-semibold text-steel mb-1.5">Pickup</legend>
            <div className="flex flex-wrap gap-2">
              {upcomingWeeks.map((w) => (
                <button
                  type="button"
                  key={w.id}
                  onClick={() => setWeekId(w.id)}
                  aria-pressed={weekId === w.id}
                  className={`rounded-lg border px-3 py-2 text-left ${weekId === w.id ? 'border-charcoal bg-charcoal text-paper' : 'border-paperDim bg-white text-charcoal'}`}
                >
                  <div className="font-display font-bold leading-tight">{w.label}</div>
                  <div className={`text-xs ${weekId === w.id ? 'text-floorMute' : 'text-steelLight'}`}>{shortDate(w.ship_date)}</div>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setWeekId('new')}
                aria-pressed={weekId === 'new'}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold ${weekId === 'new' ? 'border-charcoal bg-charcoal text-paper' : 'border-dashed border-steelLight text-steel'}`}
              >
                Other date…
              </button>
            </div>
            {weekId === 'new' && (
              <input
                id="lg-new-date"
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                aria-label="Pickup date"
                className="mt-2 rounded-lg border border-paperDim px-3 py-2"
              />
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold text-steel mb-1.5">
              Built by <span className="font-normal text-steelLight">— stays picked for the next order</span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {sortedColumns.map((c) => {
                const on = pickedColumns.has(c.id)
                return (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => toggleColumn(c.id)}
                    aria-pressed={on}
                    title={deptByColumn[c.id] ? `${deptByColumn[c.id]} department` : 'No department tablet yet'}
                    className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
                      on ? 'bg-safety border-safety text-charcoal' : deptByColumn[c.id] ? 'border-steelLight text-charcoal bg-white' : 'border-paperDim text-steelLight bg-white'
                    }`}
                  >
                    {c.name}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="lg-notes" className="block text-sm font-semibold text-steel mb-1">
              Notes
            </label>
            <textarea id="lg-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" className="w-full rounded-lg border border-paperDim px-3 py-2" />
          </div>

          {error && <p className="text-sm text-andonRed">{error}</p>}

          <button type="submit" disabled={busy || !live} className="rounded-xl bg-safety py-3.5 font-display font-extrabold text-2xl uppercase tracking-wide text-charcoal disabled:opacity-50">
            {busy ? 'Adding…' : 'Add order'}
          </button>
        </form>

        {/* ── Recently added ── */}
        <section className="rounded-2xl bg-white border border-paperDim p-5">
          <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">{mine.length ? 'Your recent orders' : 'Recent orders'}</h2>
          <ul className="mt-2 divide-y divide-paperDim">
            {recent.map((o) => {
              const cells = Object.values(o.statuses).filter((c) => c.visible)
              const done = cells.filter((c) => stageRank(c.stage) >= DONE_RANK).length
              const blocked = cells.some((c) => c.blocked)
              const days = daysUntil(o.scheduled_pickup_date)
              return (
                <li key={o.id} className="py-3 grid grid-cols-[1fr_auto] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="font-display font-bold text-lg leading-tight text-charcoal break-words">{o.tag_name}</div>
                    <div className="text-sm text-steelLight truncate">
                      {o.dealer ?? 'No dealer'} · added {ago(o.created_at)} ago
                    </div>
                    <div className="text-xs mt-1 flex flex-wrap gap-x-3">
                      <span className={o.actual_pickup_date ? 'text-andonGreen font-semibold' : days != null && days < 0 ? 'text-andonRed font-semibold' : 'text-steel'}>
                        {o.actual_pickup_date ? 'Picked up' : o.scheduled_pickup_date ? `Pickup ${shortDate(o.scheduled_pickup_date)} · ${relativeDay(days)}` : 'No pickup date'}
                      </span>
                      <span className="text-steel tabular-nums">
                        {done}/{cells.length} departments done
                      </span>
                      {blocked && <span className="text-andonRed font-semibold">Blocked</span>}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => setFilesFor(o)} className="rounded-lg border border-paperDim px-3 py-2 text-sm font-semibold text-charcoal" title="Attach the order confirmation or drawings">
                      📎
                    </button>
                    <button onClick={() => setEditing(o)} className="rounded-lg border border-paperDim px-3 py-2 text-sm font-semibold text-charcoal">
                      Edit
                    </button>
                  </div>
                </li>
              )
            })}
            {recent.length === 0 && <li className="py-3 text-sm text-steelLight">No orders yet.</li>}
          </ul>
        </section>
      </main>

      {toast && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-5 z-50 bg-charcoal text-paper rounded-xl shadow-2xl px-4 py-3 text-sm max-w-[calc(100vw-32px)]">
          {toast}
        </div>
      )}
      {filesFor && <FileModal order={filesFor} onClose={() => setFilesFor(null)} allowUpload />}
      {editing && (
        <OrderFormModal
          order={editing}
          columns={columns}
          buildWeeks={buildWeeks}
          onClose={() => setEditing(null)}
          onSaved={loadOrders}
        />
      )}
    </div>
  )
}
