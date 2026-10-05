import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { buildNumbers, byBuildOrder, daysUntil, relativeDay, shortDate } from '../lib/schedule'
import { PANEL_TYPES, ROOM_SHAPES, WINDOW_TYPES, difficulty, orderPersonDays, pickupLoads, useSettings } from '../lib/catalog'
import WeekLoad from '../components/WeekLoad.jsx'
import { dbErrorText } from '../lib/dbError'
import OrderPackageUpload from '../components/OrderPackageUpload.jsx'
import OrderSheet from '../components/OrderSheet.jsx'
import { Chip } from '../components/ui.jsx'
import NotificationBanner, { NotificationBell } from '../components/NotificationBanner.jsx'

/**
 * Office: prints the build paperwork and enters each order's details
 * from the order confirmation (mods, room shape, windows, panels). Both
 * are office/admin only — neither shows on the floor.
 *
 * The details drive the estimate: how hard each order is, how many
 * person-days of Mods work it needs, and whether each pickup fits the
 * crew available before it ships.
 */
export default function OfficeView() {
  const { signOut } = useAuth()
  const { live } = useConnection()
  const settings = useSettings()
  const [weeks, setWeeks] = useState([])
  const [orders, setOrders] = useState([])
  const [crewByDate, setCrewByDate] = useState({})
  const [quantities, setQuantities] = useState({}) // order id -> { measure: { qty, source } }
  const [modsDone, setModsDone] = useState(new Set()) // order ids whose Mods work is finished
  const [onlyNotReady, setOnlyNotReady] = useState(false)
  const [sheetId, setSheetId] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    const [{ data: weekRows }, { data: orderRows, error: err }, { data: mods }] = await Promise.all([
      supabase.from('bt_build_weeks').select('*').order('ship_date', { ascending: true }),
      supabase
        .from('bt_orders')
        .select(
          'id, tag_name, dealer, build_week_id, scheduled_pickup_date, sequence, status, paperwork_ready_at, actual_pickup_date, mods_count, walls_count, room_shape, window_type, panel_type, bt_build_weeks(ship_date)'
        )
        .eq('status', 'active')
        .is('actual_pickup_date', null),
      supabase.from('bt_departments').select('id').eq('name', 'Mods').maybeSingle(),
    ])
    setError(dbErrorText(err, "Couldn't load orders"))
    const numbers = buildNumbers(orderRows ?? [])
    setWeeks(weekRows ?? [])
    setOrders((orderRows ?? []).map((o) => ({ ...o, buildNo: numbers.get(o.id) })).sort(byBuildOrder))
    // Counts read from the order's sheets, or typed here. Not fatal if the
    // table isn't there yet (schema_v23 not run): the columns just stay blank.
    const ids = (orderRows ?? []).map((o) => o.id)
    if (ids.length) {
      const { data: qRows } = await supabase.from('bt_order_quantities').select('order_id, measure, qty, source').in('order_id', ids)
      const q = {}
      for (const r of qRows ?? []) (q[r.order_id] ??= {})[r.measure] = { qty: Number(r.qty), source: r.source }
      setQuantities(q)
    }
    if (mods?.id) {
      const [{ data: crew }, { data: modCols }] = await Promise.all([
        supabase.from('bt_crew_days').select('work_date, people').eq('department_id', mods.id),
        supabase.from('bt_department_columns').select('status_column_id').eq('department_id', mods.id),
      ])
      setCrewByDate(Object.fromEntries((crew ?? []).map((c) => [c.work_date, Number(c.people)])))
      // Orders whose Mods job is already done don't need crew time any more.
      const colIds = (modCols ?? []).map((c) => c.status_column_id)
      if (colIds.length) {
        const { data: done } = await supabase
          .from('bt_order_status')
          .select('order_id')
          .in('status_column_id', colIds)
          .in('workflow_stage', ['completed', 'packaged', 'shipped'])
        setModsDone(new Set((done ?? []).map((d) => d.order_id)))
      }
    }
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel('office')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_crew_days' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
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

  const loads = useMemo(
    () =>
      pickupLoads(
        groups.filter((g) => g.week).map((g) => ({ key: g.week.id, shipDate: g.week.ship_date, orders: g.orders.filter((o) => !modsDone.has(o.id)) })),
        settings,
        crewByDate
      ),
    [groups, modsDone, settings, crewByDate]
  )

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

  async function saveDetails(order, patch) {
    if (!live) return
    const next = { ...order, ...patch }
    setOrders((prev) => prev.map((o) => (o.id === order.id ? next : o)))
    const { error: err } = await supabase.rpc('bt_set_order_details', {
      p_order_id: order.id,
      p_mods_count: next.mods_count ?? null,
      p_room_shape: next.room_shape ?? null,
      p_window_type: next.window_type ?? null,
      p_panel_type: next.panel_type ?? null,
      p_walls_count: next.walls_count ?? null,
    })
    if (err) {
      setError(dbErrorText(err, `Couldn't save details for ${order.tag_name}`))
      load()
    }
  }

  const sheetOrder = orders.find((o) => o.id === sheetId) ?? null
  const totalOpen = orders.filter((o) => !o.paperwork_ready_at).length
  const missingDetails = orders.filter((o) => !o.mods_count).length
  const missingV4T = orders.filter((o) => o.window_type === 'v4t' && !(quantities[o.id]?.v4t_frames || quantities[o.id]?.vents)).length

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-3 border-b-4 border-safety flex-wrap">
        <div>
          <h1 className="font-display text-3xl font-bold text-paper leading-none">Office</h1>
          <p className="text-sm text-floorMute mt-1">
            {totalOpen ? `${totalOpen} still need paperwork` : 'All paperwork is ready'}
            {missingDetails ? ` · ${missingDetails} missing mod counts` : ''}
            {missingV4T ? ` · ${missingV4T} V4T orders missing frame / vent counts` : ''}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-paper cursor-pointer">
            <input type="checkbox" checked={onlyNotReady} onChange={(e) => setOnlyNotReady(e.target.checked)} className="w-4 h-4" />
            Only paperwork not ready
          </label>
          <NotificationBell />
          <button onClick={signOut} className="text-sm text-floorMute hover:text-paper">
            Sign out
          </button>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-5 max-w-[90rem] mx-auto space-y-5">
        {error && <div className="bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {error}</div>}
        <OrderPackageUpload />
        {groups.length === 0 && <p className="text-steelLight">No orders waiting.</p>}

        {groups.map(({ week, orders: list }) => {
          const shown = onlyNotReady ? list.filter((o) => !o.paperwork_ready_at) : list
          const open = list.filter((o) => !o.paperwork_ready_at)
          if (shown.length === 0) return null
          const load = week ? loads.get(week.id) : null
          return (
            <section key={week?.id ?? 'none'} className="rounded-2xl bg-white border border-paperDim overflow-hidden">
              <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-paperDim flex-wrap">
                <div>
                  <h2 className="font-display font-bold text-2xl text-charcoal leading-tight">
                    {week?.ship_date ? shortDate(week.ship_date) : week?.label ?? 'No pickup date'}
                  </h2>
                  {week?.ship_date && (
                    <p className="text-sm text-steelLight">
                      {relativeDay(daysUntil(week.ship_date))} · paperwork {list.length - open.length}/
                      {list.length}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Whether the crew can make a pickup only means something
                      before it — a shipped week's "0 of 0 person-days" is noise. */}
                  {load && load.days > 0 && <WeekLoad load={load} settings={settings} />}
                  {open.length > 0 && (
                    <button
                      onClick={() => setReady(open.map((o) => o.id), true)}
                      disabled={!live}
                      className="rounded-lg bg-charcoal text-paper text-sm font-semibold px-4 py-2 disabled:opacity-40"
                    >
                      Mark all {open.length} paperwork ready
                    </button>
                  )}
                </div>
              </div>

              <ul className="divide-y divide-paperDim">
                {shown.map((o) => {
                  const ready = !!o.paperwork_ready_at
                  const level = difficulty(o)
                  const days = orderPersonDays(o, settings)
                  const q = quantities[o.id] ?? {}
                  const needsV4T = o.window_type === 'v4t' && !q.v4t_frames
                  return (
                    <li key={o.id} className="flex items-stretch">
                      <label className="flex items-center px-3 sm:px-4 cursor-pointer" title="Paperwork ready">
                        <input
                          type="checkbox"
                          checked={ready}
                          disabled={!live}
                          onChange={() => setReady([o.id], !ready)}
                          className="w-7 h-7 accent-andonGreen"
                          aria-label={`Paperwork ready for ${o.tag_name}`}
                        />
                      </label>
                      <button
                        onClick={() => setSheetId(o.id)}
                        className="flex-1 min-w-0 text-left py-3 pr-3 sm:pr-4 grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center hover:bg-paper"
                        aria-label={`Open ${o.tag_name}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="font-display font-bold text-lg text-steelLight tabular-nums">#{o.buildNo}</span>
                            <span className="font-display font-bold text-lg text-charcoal truncate">{o.tag_name}</span>
                          </div>
                          <div className="text-xs text-steelLight truncate">{o.dealer}</div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap sm:justify-end">
                          {o.mods_count ? (
                            <Chip>
                              {o.mods_count} mods{o.walls_count ? ` · ${o.walls_count} walls` : ''}
                            </Chip>
                          ) : (
                            <Chip kind="warn">No mod count</Chip>
                          )}
                          {q.v4t_frames ? (
                            <Chip kind="info">
                              V4T {q.v4t_frames.qty}
                              {q.vents ? ` · ${q.vents.qty} vents` : ''}
                            </Chip>
                          ) : needsV4T ? (
                            <Chip kind="warn">No V4T count</Chip>
                          ) : null}
                          {days != null && (
                            <span className="inline-flex items-center gap-1">
                              <LevelChip level={level} />
                              <span className="text-xs text-steelLight tabular-nums">{days.toFixed(1)} p-days</span>
                            </span>
                          )}
                          <span className="text-steelLight text-lg leading-none pl-1" aria-hidden="true">›</span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </main>

      {sheetOrder && (
        <OrderSheet
          order={sheetOrder}
          canEdit
          onClose={() => {
            setSheetId(null)
            load()
          }}
          top={<OrderDetailsEditor order={sheetOrder} onSave={saveDetails} disabled={!live} />}
        />
      )}
    </div>
  )
}

/** The order-confirmation details the office types, inside the order page. */
function OrderDetailsEditor({ order, onSave, disabled }) {
  const num = (field, label, max) => (
    <label className="rounded-xl border border-paperDim bg-white p-3">
      <span className="block text-xs text-steelLight">{label}</span>
      <input
        type="number"
        min="0"
        max={max}
        inputMode="numeric"
        defaultValue={order[field] ?? ''}
        key={`${field}-${order[field] ?? ''}`}
        disabled={disabled}
        onBlur={(e) => {
          const v = e.target.value === '' ? null : Number(e.target.value)
          if (v !== (order[field] ?? null)) onSave(order, { [field]: v })
        }}
        aria-label={label}
        className={`mt-0.5 w-full rounded-lg border px-2 py-2 text-xl font-display font-bold tabular-nums ${order[field] || field !== 'mods_count' ? 'border-paperDim' : 'border-safety bg-safety/10'}`}
      />
    </label>
  )
  const pick = (field, label, options) => (
    <label className="rounded-xl border border-paperDim bg-white p-3">
      <span className="block text-xs text-steelLight">{label}</span>
      <select
        value={order[field] ?? ''}
        disabled={disabled}
        onChange={(e) => onSave(order, { [field]: e.target.value || null })}
        aria-label={label}
        className="mt-0.5 w-full rounded-lg border border-paperDim bg-white px-2 py-2.5 text-sm"
      >
        <option value="">—</option>
        {options.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <section>
      <h3 className="font-display font-bold uppercase tracking-wide text-lg text-charcoal">From the order confirmation</h3>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {num('mods_count', 'Mods', 99)}
        {num('walls_count', 'Walls', 50)}
        {pick('room_shape', 'Room', ROOM_SHAPES)}
        {pick('window_type', 'Windows', WINDOW_TYPES)}
        {pick('panel_type', 'Panels', PANEL_TYPES)}
      </div>
    </section>
  )
}

export function LevelChip({ level }) {
  if (!level) return <span className="text-xs text-steelLight">details missing</span>
  const style = { easy: 'bg-andonGreenBg text-andonGreen', medium: 'bg-safety/25 text-[#8A6606]', hard: 'bg-andonRedBg text-andonRed' }[level]
  return <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold uppercase ${style}`}>{level}</span>
}
