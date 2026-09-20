import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { buildNumbers, byBuildOrder, daysUntil, relativeDay, shortDate } from '../lib/schedule'
import { PANEL_TYPES, ROOM_SHAPES, WINDOW_TYPES, difficulty, orderPersonDays, pickupLoads, roomSize, useSettings } from '../lib/catalog'
import WeekLoad from '../components/WeekLoad.jsx'

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
  const [modsDone, setModsDone] = useState(new Set()) // order ids whose Mods work is finished
  const [onlyNotReady, setOnlyNotReady] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    const [{ data: weekRows }, { data: orderRows, error: err }, { data: mods }] = await Promise.all([
      supabase.from('bt_build_weeks').select('*').order('ship_date', { ascending: true }),
      supabase
        .from('bt_orders')
        .select(
          'id, tag_name, dealer, build_week_id, scheduled_pickup_date, sequence, status, paperwork_ready_at, actual_pickup_date, mods_count, room_shape, window_type, panel_type, bt_build_weeks(ship_date)'
        )
        .eq('status', 'active')
        .is('actual_pickup_date', null),
      supabase.from('bt_departments').select('id').eq('name', 'Mods').maybeSingle(),
    ])
    setError(err ? `Couldn't load orders: ${err.message}` : '')
    const numbers = buildNumbers(orderRows ?? [])
    setWeeks(weekRows ?? [])
    setOrders((orderRows ?? []).map((o) => ({ ...o, buildNo: numbers.get(o.id) })).sort(byBuildOrder))
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
    })
    if (err) {
      setError(`Couldn't save details for ${order.tag_name}: ${err.message}`)
      load()
    }
  }

  const totalOpen = orders.filter((o) => !o.paperwork_ready_at).length
  const missingDetails = orders.filter((o) => !o.mods_count).length

  return (
    <div className="min-h-full bg-paper">
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-3 border-b-4 border-safety flex-wrap">
        <div>
          <h1 className="font-display text-3xl font-bold text-paper leading-none">Office</h1>
          <p className="text-sm text-floorMute mt-1">
            {totalOpen ? `${totalOpen} still need paperwork` : 'All paperwork is ready'}
            {missingDetails ? ` · ${missingDetails} missing mod counts` : ''}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-paper cursor-pointer">
            <input type="checkbox" checked={onlyNotReady} onChange={(e) => setOnlyNotReady(e.target.checked)} className="w-4 h-4" />
            Only paperwork not ready
          </label>
          <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">
            Sign out
          </button>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-5 max-w-6xl mx-auto space-y-5">
        {error && <div className="bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {error}</div>}
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
                  <h2 className="font-display font-bold text-2xl text-charcoal leading-tight">{week?.label ?? 'No pickup date'}</h2>
                  {week?.ship_date && (
                    <p className="text-sm text-steelLight">
                      {shortDate(week.ship_date)} · {relativeDay(daysUntil(week.ship_date))} · paperwork {list.length - open.length}/
                      {list.length}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {load && <WeekLoad load={load} settings={settings} />}
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

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-steelLight">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Paperwork</th>
                      <th className="px-2 py-2 font-semibold">#</th>
                      <th className="px-2 py-2 font-semibold">Order</th>
                      <th className="px-2 py-2 font-semibold">Mods</th>
                      <th className="px-2 py-2 font-semibold">Room</th>
                      <th className="px-2 py-2 font-semibold">Windows</th>
                      <th className="px-2 py-2 font-semibold">Panels</th>
                      <th className="px-4 py-2 font-semibold text-right">Estimate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-paperDim">
                    {shown.map((o) => {
                      const ready = !!o.paperwork_ready_at
                      const level = difficulty(o)
                      const days = orderPersonDays(o, settings)
                      return (
                        <tr key={o.id} className="align-middle">
                          <td className="px-4 py-2.5">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={ready}
                                disabled={!live}
                                onChange={() => setReady([o.id], !ready)}
                                className="w-6 h-6 accent-andonGreen"
                                aria-label={`Paperwork ready for ${o.tag_name}`}
                              />
                              <span className={`text-xs font-semibold ${ready ? 'text-andonGreen' : 'text-steelLight'}`}>{ready ? 'Ready' : '—'}</span>
                            </label>
                          </td>
                          <td className="px-2 py-2.5 font-display font-bold text-xl text-steelLight tabular-nums">{o.buildNo}</td>
                          <td className="px-2 py-2.5 min-w-[12rem]">
                            <div className="font-display font-bold text-base text-charcoal">{o.tag_name}</div>
                            <div className="text-xs text-steelLight truncate max-w-[16rem]">{o.dealer}</div>
                          </td>
                          <td className="px-2 py-2.5">
                            <input
                              type="number"
                              min="0"
                              max="99"
                              defaultValue={o.mods_count ?? ''}
                              key={`${o.id}-${o.mods_count}`}
                              disabled={!live}
                              onBlur={(e) => {
                                const v = e.target.value === '' ? null : Number(e.target.value)
                                if (v !== (o.mods_count ?? null)) saveDetails(o, { mods_count: v })
                              }}
                              aria-label={`Mods for ${o.tag_name}`}
                              className={`w-16 rounded border px-2 py-1.5 tabular-nums ${o.mods_count ? 'border-paperDim' : 'border-safety bg-safety/10'}`}
                            />
                          </td>
                          <DetailSelect order={o} field="room_shape" options={ROOM_SHAPES} onSave={saveDetails} disabled={!live} />
                          <DetailSelect order={o} field="window_type" options={WINDOW_TYPES} onSave={saveDetails} disabled={!live} />
                          <DetailSelect order={o} field="panel_type" options={PANEL_TYPES} onSave={saveDetails} disabled={!live} />
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            {days == null ? (
                              <span className="text-xs text-steelLight">enter mods</span>
                            ) : (
                              <>
                                <LevelChip level={level} />
                                <div className="text-xs text-steelLight mt-0.5 tabular-nums">
                                  {roomSize(o.mods_count, settings)} · {days.toFixed(1)} person-days
                                </div>
                              </>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )
        })}
      </main>
    </div>
  )
}

function DetailSelect({ order, field, options, onSave, disabled }) {
  return (
    <td className="px-2 py-2.5">
      <select
        value={order[field] ?? ''}
        disabled={disabled}
        onChange={(e) => onSave(order, { [field]: e.target.value || null })}
        aria-label={`${field.replace('_', ' ')} for ${order.tag_name}`}
        className="rounded border border-paperDim bg-white px-2 py-1.5"
      >
        <option value="">—</option>
        {options.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
    </td>
  )
}

export function LevelChip({ level }) {
  if (!level) return <span className="text-xs text-steelLight">details missing</span>
  const style = { easy: 'bg-andonGreenBg text-andonGreen', medium: 'bg-safety/25 text-[#8A6606]', hard: 'bg-andonRedBg text-andonRed' }[level]
  return <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold uppercase ${style}`}>{level}</span>
}
