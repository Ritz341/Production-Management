import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { DONE_RANK, daysUntil, relativeDay, shortDate, stageRank } from '../lib/schedule'
import { dbErrorText } from '../lib/dbError'
import NotificationBanner, { NotificationBell } from '../components/NotificationBanner.jsx'

/**
 * The loading dock. The question at the dock is "what can go on this
 * truck?", and this used to be a flat list of every active order with a
 * Mark Picked Up button on each and no word on whether any of them was
 * built — an order nobody had started looked exactly like one ready to
 * load. Now: grouped by pickup, soonest first, each order saying how far
 * along it is, the ready ones first in their group.
 */
export default function ShippingView() {
  const { signOut } = useAuth()
  const { live } = useConnection()
  const [orders, setOrders] = useState([])
  const [weeks, setWeeks] = useState([])
  const [jobs, setJobs] = useState({}) // orderId -> [{ rank, blocked }]
  const [loading, setLoading] = useState(true)
  const [showPicked, setShowPicked] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    const [oRes, wRes] = await Promise.all([
      supabase
        .from('bt_orders')
        .select('id, tag_name, dealer, truck_route, build_week_id, scheduled_pickup_date, actual_pickup_date, sequence')
        .eq('status', 'active'),
      supabase.from('bt_build_weeks').select('id, ship_date'),
    ])
    const rows = oRes.data ?? []
    const ids = rows.map((o) => o.id)
    const sRes = ids.length
      ? await supabase
          .from('bt_order_status')
          .select('order_id, workflow_stage, blocked_at')
          .in('order_id', ids)
          .eq('is_visible', true)
          .is('removed_at', null)
      : { data: [] }
    const byOrder = {}
    for (const s of sRes.data ?? []) (byOrder[s.order_id] ??= []).push({ rank: stageRank(s.workflow_stage), blocked: !!s.blocked_at })
    setOrders(rows)
    setWeeks(wRes.data ?? [])
    setJobs(byOrder)
    const firstError = oRes.error || wRes.error || sRes.error
    setError(firstError ? dbErrorText(firstError, "Couldn't load pickups") : '')
    setLoading(false)
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel('shipping-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      // Readiness changes as the floor finishes jobs, and a moved week
      // moves its pickups.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  const shipDateOf = useMemo(() => {
    const byWeek = new Map(weeks.map((w) => [w.id, w.ship_date]))
    // The order's own date if it was given one, otherwise its week's. The
    // old query took only orders with their own date, so anything that
    // just belonged to a week never reached the dock at all.
    return (o) => o.scheduled_pickup_date ?? byWeek.get(o.build_week_id) ?? null
  }, [weeks])

  const readiness = (o) => {
    const list = jobs[o.id] ?? []
    const done = list.filter((j) => j.rank >= DONE_RANK).length
    return { total: list.length, done, blocked: list.some((j) => j.blocked), ready: list.length > 0 && done === list.length }
  }

  const groups = useMemo(() => {
    const byDate = new Map()
    for (const o of orders) {
      if (!showPicked && o.actual_pickup_date) continue
      const d = shipDateOf(o) ?? 'none'
      if (!byDate.has(d)) byDate.set(d, [])
      byDate.get(d).push(o)
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => (a === 'none' ? 1 : b === 'none' ? -1 : a.localeCompare(b)))
      .map(([date, list]) => {
        const r = new Map(list.map((o) => [o.id, readiness(o)]))
        list.sort((a, b) => {
          const ra = r.get(a.id)
          const rb = r.get(b.id)
          return (
            !!a.actual_pickup_date - !!b.actual_pickup_date || // still to go first
            rb.ready - ra.ready || // then what can be loaded now
            rb.done / (rb.total || 1) - ra.done / (ra.total || 1) ||
            (a.sequence ?? 1e9) - (b.sequence ?? 1e9)
          )
        })
        const waiting = list.filter((o) => !o.actual_pickup_date)
        return { date, list, readiness: r, waiting: waiting.length, ready: waiting.filter((o) => r.get(o.id).ready).length }
      })
  }, [orders, jobs, shipDateOf, showPicked])

  // Checks the write actually landed. It used to flip the card and move
  // on — offline, or with a permission rule filtering the row, the dock
  // saw "picked up" and nothing was recorded.
  async function setPicked(o, pickedUp) {
    if (!live) return
    const r = readiness(o)
    if (
      pickedUp &&
      !r.ready &&
      !window.confirm(`${o.tag_name} isn't fully built — ${r.done} of ${r.total} departments are done. Mark it picked up anyway?`)
    )
      return
    const value = pickedUp ? new Date().toISOString() : null
    const before = o.actual_pickup_date
    setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, actual_pickup_date: value } : x)))
    const { data, error: err } = await supabase.from('bt_orders').update({ actual_pickup_date: value }).eq('id', o.id).select('id')
    if (err || !data?.length) {
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, actual_pickup_date: before } : x)))
      setError(err ? dbErrorText(err, `Didn't save ${o.tag_name}`) : `Didn't save ${o.tag_name} — this login can't mark pickups. Ask admin.`)
    } else setError('')
  }

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between border-b-4 border-safety">
        <h1 className="font-display text-3xl font-bold text-paper leading-none">Shipping</h1>
        <div className="flex items-center gap-3">
          <label className="text-sm text-floorMute flex items-center gap-1.5">
            <input type="checkbox" checked={showPicked} onChange={(e) => setShowPicked(e.target.checked)} />
            Show picked up
          </label>
          <NotificationBell />
          <button onClick={signOut} className="text-sm text-floorMute hover:text-paper">
            Sign out
          </button>
        </div>
      </header>

      <main className="p-4 space-y-6 max-w-3xl mx-auto">
        {error && <div className="bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {error}</div>}
        {loading && <p className="text-steelLight text-sm">Loading…</p>}
        {!loading && groups.length === 0 && (
          <div className="bg-white border border-paperDim rounded-xl p-8 text-center text-steelLight">Nothing waiting to go out.</div>
        )}

        {groups.map((g) => {
          const days = g.date === 'none' ? null : daysUntil(g.date)
          return (
            <section key={g.date}>
              <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
                <h2 className="font-display font-bold text-2xl text-charcoal">
                  {g.date === 'none' ? 'No pickup date' : shortDate(g.date)}
                  {days != null && (
                    <span className={`ml-2 text-base ${days < 0 && g.waiting ? 'text-andonRed' : 'text-steelLight'}`}>
                      {days < 0 ? `${-days}d past` : relativeDay(days).toLowerCase()}
                    </span>
                  )}
                </h2>
                {g.waiting > 0 && (
                  <div className="text-sm font-semibold tabular-nums">
                    <span className={g.ready === g.waiting ? 'text-andonGreen' : 'text-charcoal'}>{g.ready}</span>
                    <span className="text-steelLight"> of {g.waiting} ready to load</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                {g.list.map((o) => {
                  const r = g.readiness.get(o.id)
                  const picked = !!o.actual_pickup_date
                  return (
                    <article
                      key={o.id}
                      className={`bg-white rounded-xl border overflow-hidden flex ${picked ? 'border-paperDim opacity-70' : 'border-paperDim'}`}
                    >
                      <div
                        className={`w-1.5 shrink-0 ${
                          picked ? 'bg-steelLight' : r.blocked ? 'bg-andonRed' : r.ready ? 'bg-andonGreen' : 'bg-safety'
                        }`}
                      />
                      <div className="flex-1 min-w-0 px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-display text-xl font-bold text-charcoal truncate">{o.tag_name}</div>
                          <div className="text-sm text-steelLight truncate">
                            {o.dealer}
                            {o.truck_route ? ` · ${o.truck_route}` : ''}
                          </div>
                          <div className="text-sm mt-0.5">
                            {picked ? (
                              <span className="text-steelLight">
                                Picked up {new Date(o.actual_pickup_date).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                              </span>
                            ) : r.ready ? (
                              <span className="font-semibold text-andonGreen">✓ Ready to load</span>
                            ) : (
                              <span className={r.blocked ? 'font-semibold text-andonRed' : 'text-steel'}>
                                {r.blocked ? 'Blocked · ' : ''}
                                {r.total ? `${r.done} of ${r.total} departments done` : 'No departments on this order'}
                              </span>
                            )}
                          </div>
                        </div>
                        {picked ? (
                          <button onClick={() => setPicked(o, false)} disabled={!live} className="text-sm text-steelLight underline disabled:opacity-40">
                            Undo
                          </button>
                        ) : (
                          <button
                            onClick={() => setPicked(o, true)}
                            disabled={!live}
                            className={`shrink-0 rounded-lg font-display font-bold px-4 py-2.5 whitespace-nowrap disabled:opacity-40 ${
                              r.ready ? 'bg-safety text-charcoal' : 'border border-paperDim text-steel'
                            }`}
                          >
                            {r.ready ? 'Picked up' : 'Picked up anyway…'}
                          </button>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}
      </main>
    </div>
  )
}
