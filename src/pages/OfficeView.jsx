import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { buildNumbers, byBuildOrder, daysUntil, relativeDay, shortDate } from '../lib/schedule'

/**
 * Office: whoever prints the build paperwork ticks each order off as it's
 * ready, in the same build order the floor works in. This flag is for
 * the office and admin only — it never shows on the floor tablets.
 */
export default function OfficeView() {
  const { signOut } = useAuth()
  const { live } = useConnection()
  const [weeks, setWeeks] = useState([])
  const [orders, setOrders] = useState([])
  const [onlyNotReady, setOnlyNotReady] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    const [{ data: weekRows }, { data: orderRows, error: err }] = await Promise.all([
      supabase.from('bt_build_weeks').select('*').order('ship_date', { ascending: true }),
      supabase
        .from('bt_orders')
        .select('id, tag_name, dealer, build_week_id, scheduled_pickup_date, sequence, status, paperwork_ready_at, actual_pickup_date, bt_build_weeks(ship_date)')
        .eq('status', 'active')
        .is('actual_pickup_date', null),
    ])
    setError(err ? `Couldn't load orders: ${err.message}` : '')
    const numbers = buildNumbers(orderRows ?? [])
    setWeeks(weekRows ?? [])
    setOrders((orderRows ?? []).map((o) => ({ ...o, buildNo: numbers.get(o.id) })).sort(byBuildOrder))
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel('office')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  const groups = useMemo(() => {
    const byWeek = new Map()
    for (const o of orders) {
      const key = o.build_week_id ?? 'none'
      if (!byWeek.has(key)) byWeek.set(key, [])
      byWeek.get(key).push(o)
    }
    const known = weeks.filter((w) => byWeek.has(w.id)).map((w) => ({ week: w, orders: byWeek.get(w.id) }))
    if (byWeek.has('none')) known.push({ week: null, orders: byWeek.get('none') })
    return known
  }, [orders, weeks])

  async function setReady(ids, ready) {
    if (!live || ids.length === 0) return
    setOrders((prev) =>
      prev.map((o) => (ids.includes(o.id) ? { ...o, paperwork_ready_at: ready ? o.paperwork_ready_at ?? new Date().toISOString() : null } : o))
    )
    const { error: err } = await supabase.rpc('bt_set_paperwork_ready', { p_order_ids: ids, p_ready: ready })
    if (err) {
      setError(`Couldn't save: ${err.message}`)
      load()
    }
  }

  const totalOpen = orders.filter((o) => !o.paperwork_ready_at).length

  return (
    <div className="min-h-full bg-paper">
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-3 border-b-4 border-safety flex-wrap">
        <div>
          <h1 className="font-display text-3xl font-bold text-paper leading-none">Paperwork</h1>
          <p className="text-sm text-floorMute mt-1">
            {totalOpen ? `${totalOpen} order${totalOpen === 1 ? '' : 's'} still need paperwork` : 'All paperwork is ready'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-paper cursor-pointer">
            <input type="checkbox" checked={onlyNotReady} onChange={(e) => setOnlyNotReady(e.target.checked)} className="w-4 h-4" />
            Only show not ready
          </label>
          <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">
            Sign out
          </button>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-5 max-w-4xl mx-auto space-y-5">
        {error && <div className="bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {error}</div>}
        {groups.length === 0 && <p className="text-steelLight">No orders waiting.</p>}

        {groups.map(({ week, orders: list }) => {
          const shown = onlyNotReady ? list.filter((o) => !o.paperwork_ready_at) : list
          const open = list.filter((o) => !o.paperwork_ready_at)
          const days = daysUntil(week?.ship_date)
          if (shown.length === 0) return null
          return (
            <section key={week?.id ?? 'none'} className="rounded-2xl bg-white border border-paperDim">
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-paperDim flex-wrap">
                <div>
                  <h2 className="font-display font-bold text-2xl text-charcoal leading-tight">{week?.label ?? 'No pickup date'}</h2>
                  {week?.ship_date && (
                    <p className="text-sm text-steelLight">
                      {shortDate(week.ship_date)} · {relativeDay(days)} · {list.length - open.length}/{list.length} ready
                    </p>
                  )}
                </div>
                {open.length > 0 && (
                  <button
                    onClick={() => setReady(open.map((o) => o.id), true)}
                    disabled={!live}
                    className="rounded-lg bg-charcoal text-paper text-sm font-semibold px-4 py-2 disabled:opacity-40"
                  >
                    Mark all {open.length} ready
                  </button>
                )}
              </div>
              <ul className="divide-y divide-paperDim">
                {shown.map((o) => {
                  const ready = !!o.paperwork_ready_at
                  return (
                    <li key={o.id}>
                      <label className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-paper">
                        <input
                          type="checkbox"
                          checked={ready}
                          disabled={!live}
                          onChange={() => setReady([o.id], !ready)}
                          className="w-6 h-6 accent-andonGreen"
                        />
                        <span className="font-display font-bold text-xl text-steelLight w-8 text-right tabular-nums">{o.buildNo}</span>
                        <span className="min-w-0 flex-1">
                          <span className={`block font-display font-bold text-lg ${ready ? 'text-steelLight' : 'text-charcoal'}`}>{o.tag_name}</span>
                          <span className="block text-sm text-steelLight truncate">{o.dealer}</span>
                        </span>
                        <span className={`text-sm font-semibold ${ready ? 'text-andonGreen' : 'text-steelLight'}`}>{ready ? 'Ready' : 'Not ready'}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </main>
    </div>
  )
}
