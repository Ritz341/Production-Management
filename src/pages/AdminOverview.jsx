import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { WORKFLOW_STAGES } from '../lib/statusColors'
import { nearestBuildWeekId } from '../lib/dates'
import { DONE_RANK, ago, daysUntil, relativeDay, shortDate, stageRank } from '../lib/schedule'

// How close a pickup has to be before an unfinished order counts as at risk.
const AT_RISK_DAYS = 3

const STAGE_BAR = {
  paperwork_ready: 'bg-safety',
  started: 'bg-andonBlue',
  completed: 'bg-andonGreen',
  packaged: 'bg-violet-600',
  shipped: 'bg-charcoal',
}

/**
 * The production coordinator's home screen: what ships next, how far
 * along it is, and what needs a decision — blocked jobs, orders that
 * won't make their pickup — with the fix one tap away.
 */
export default function AdminOverview({ buildWeeks, onWeeksChanged, onEditOrder, onNewOrder, onImport, onOpenGrid }) {
  const { live } = useConnection()
  const [weekId, setWeekId] = useState(null)
  const [departments, setDepartments] = useState([])
  const [deptColumns, setDeptColumns] = useState({}) // deptId -> [columnId]
  const [columns, setColumns] = useState([])
  const [orders, setOrders] = useState([]) // active (not picked up) orders, with cells
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [shipDraft, setShipDraft] = useState('')
  const [toast, setToast] = useState('')

  useEffect(() => {
    setWeekId((prev) => prev ?? nearestBuildWeekId(buildWeeks))
  }, [buildWeeks])

  const week = buildWeeks.find((w) => w.id === weekId)
  useEffect(() => setShipDraft(week?.ship_date ?? ''), [week?.ship_date])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    supabase.from('bt_departments').select('id, name').order('sort_order').then(({ data }) => setDepartments(data ?? []))
    supabase.from('bt_status_columns').select('id, name').order('sort_order').then(({ data }) => setColumns(data ?? []))
    supabase.from('bt_department_columns').select('department_id, status_column_id').then(({ data }) => {
      const map = {}
      for (const r of data ?? []) (map[r.department_id] ??= []).push(r.status_column_id)
      setDeptColumns(map)
    })
  }, [])

  useEffect(() => {
    let active = true

    async function load() {
      // Everything still in the building — once shipping marks an order
      // picked up it no longer needs the coordinator's attention.
      const { data: orderRows, error: oErr } = await supabase
        .from('bt_orders')
        .select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date, created_at')
        .is('actual_pickup_date', null)
      const ids = (orderRows ?? []).map((o) => o.id)
      const { data: statusRows, error: sErr } = ids.length
        ? await supabase
            .from('bt_order_status')
            .select('order_id, status_column_id, status_value, is_visible, workflow_stage, blocked_at, blocked_note')
            .in('order_id', ids)
        : { data: [] }
      const { data: eventRows } = await supabase
        .from('bt_events')
        .select('id, event_type, message, created_at')
        .order('created_at', { ascending: false })
        .limit(25)
      if (!active) return

      const err = oErr || sErr
      setLoadError(err ? `Couldn't load the overview: ${err.message}` : '')
      const byId = new Map((orderRows ?? []).map((o) => [o.id, { ...o, statuses: {} }]))
      for (const s of statusRows ?? []) {
        const o = byId.get(s.order_id)
        if (!o) continue
        o.statuses[s.status_column_id] = {
          value: s.status_value,
          visible: s.is_visible,
          stage: s.workflow_stage,
          blocked: !!s.blocked_at,
          blockedAt: s.blocked_at,
          blockedNote: s.blocked_note,
        }
      }
      setOrders([...byId.values()])
      setEvents(eventRows ?? [])
      setLoading(false)
    }

    load()
    const channel = supabase
      .channel('admin-overview')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bt_events' }, load)
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [])

  const columnName = useMemo(() => Object.fromEntries(columns.map((c) => [c.id, c.name])), [columns])
  const weekById = useMemo(() => Object.fromEntries(buildWeeks.map((w) => [w.id, w])), [buildWeeks])

  // An order's pickup: its own date if set, otherwise its build week's.
  const pickupOf = (o) => o.scheduled_pickup_date ?? weekById[o.build_week_id]?.ship_date ?? null
  const cellsOf = (o) => Object.entries(o.statuses).filter(([, c]) => c.visible)

  const weekOrders = useMemo(() => orders.filter((o) => o.build_week_id === weekId), [orders, weekId])

  const weekStats = useMemo(() => {
    const cells = weekOrders.flatMap((o) => cellsOf(o).map(([, c]) => c))
    const byStage = Object.fromEntries(WORKFLOW_STAGES.map((s) => [s.id, 0]))
    let done = 0
    for (const c of cells) {
      if (c.stage) byStage[c.stage]++
      if (stageRank(c.stage) >= DONE_RANK) done++
    }
    const ordersDone = weekOrders.filter((o) => cellsOf(o).every(([, c]) => stageRank(c.stage) >= DONE_RANK)).length
    return { total: cells.length, done, byStage, ordersDone }
  }, [weekOrders])

  const blocked = useMemo(
    () =>
      orders
        .flatMap((o) => cellsOf(o).filter(([, c]) => c.blocked).map(([colId, c]) => ({ o, colId: Number(colId), c })))
        .sort((a, b) => new Date(a.c.blockedAt) - new Date(b.c.blockedAt)),
    [orders]
  )

  // At risk: picking up within a few days (or already past) with a
  // department still not done. Late ones first, then soonest pickup.
  const atRisk = useMemo(
    () =>
      orders
        .map((o) => {
          const days = daysUntil(pickupOf(o))
          const open = cellsOf(o).filter(([, c]) => stageRank(c.stage) < DONE_RANK)
          return { o, days, open }
        })
        .filter((r) => r.days != null && r.days <= AT_RISK_DAYS && r.open.length > 0)
        .sort((a, b) => a.days - b.days || b.open.length - a.open.length),
    [orders, weekById]
  )

  const deptStats = useMemo(
    () =>
      departments.map((d) => {
        const own = new Set(deptColumns[d.id] ?? [])
        let jobs = 0
        let done = 0
        let started = 0
        let blockedN = 0
        for (const o of weekOrders) {
          for (const [colId, c] of cellsOf(o)) {
            if (!own.has(Number(colId))) continue
            jobs++
            const r = stageRank(c.stage)
            if (r >= DONE_RANK) done++
            else if (r === 2) started++
            if (c.blocked) blockedN++
          }
        }
        return { d, jobs, done, started, blocked: blockedN }
      }),
    [departments, deptColumns, weekOrders]
  )

  async function saveShipDate() {
    if (!week || !shipDraft || shipDraft === week.ship_date || !live) return
    const { error } = await supabase.from('bt_build_weeks').update({ ship_date: shipDraft }).eq('id', week.id)
    if (error) {
      setToast(`Couldn't move the ship date: ${error.message}`)
      return
    }
    onWeeksChanged()
    setToast(`${week.label} now ships ${shortDate(shipDraft)} — every tablet has been updated`)
  }

  async function clearBlock(o, colId) {
    if (!live) return
    const { error } = await supabase
      .from('bt_order_status')
      .update({ blocked_at: null, blocked_note: null })
      .eq('order_id', o.id)
      .eq('status_column_id', colId)
    setToast(error ? `Couldn't clear the block: ${error.message}` : `Cleared: ${columnName[colId]} on ${o.tag_name}`)
  }

  const upcoming = useMemo(() => {
    const dated = buildWeeks.filter((w) => w.ship_date && daysUntil(w.ship_date) >= -7)
    return dated.sort((a, b) => a.ship_date.localeCompare(b.ship_date)).slice(0, 5)
  }, [buildWeeks])

  const shipDays = daysUntil(week?.ship_date)
  const pct = weekStats.total ? Math.round((weekStats.done / weekStats.total) * 100) : 0

  return (
    <div className="px-4 sm:px-6 py-5 max-w-7xl mx-auto">
      {/* ── Week picker + actions ── */}
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Build week">
          {upcoming.map((w) => (
            <button
              key={w.id}
              onClick={() => setWeekId(w.id)}
              aria-pressed={w.id === weekId}
              className={`text-left rounded-xl border px-3 py-2 bg-white ${w.id === weekId ? 'border-charcoal ring-1 ring-charcoal' : 'border-paperDim'}`}
            >
              <div className="font-display font-bold text-lg leading-tight text-charcoal">{w.label}</div>
              <div className={`text-xs ${daysUntil(w.ship_date) < 0 ? 'text-andonRed' : 'text-steelLight'}`}>
                {shortDate(w.ship_date)} · {relativeDay(daysUntil(w.ship_date))}
              </div>
            </button>
          ))}
          {buildWeeks.length > upcoming.length && (
            <select
              value={upcoming.some((w) => w.id === weekId) ? '' : weekId ?? ''}
              onChange={(e) => e.target.value && setWeekId(Number(e.target.value))}
              className="rounded-xl border border-paperDim bg-white px-3 text-sm text-steelLight"
              aria-label="Other build weeks"
            >
              <option value="">Other weeks…</option>
              {buildWeeks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                  {w.ship_date ? ` — ${shortDate(w.ship_date)}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={onImport} className="rounded-lg border border-paperDim bg-white px-4 py-2.5 text-sm font-semibold text-charcoal">
            Weekly import
          </button>
          <button onClick={onNewOrder} className="rounded-lg bg-safety px-4 py-2.5 font-display font-bold text-charcoal">
            + New order
          </button>
        </div>
      </div>

      {loadError && <div className="mt-4 bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {loadError}</div>}

      {/* ── KPIs ── */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr] gap-3">
        <div className="rounded-2xl bg-charcoal text-paper p-4">
          <div className="text-[11px] uppercase tracking-[0.12em] text-floorMute font-semibold">{week?.label ?? 'Build week'} ships</div>
          <div className={`font-display font-extrabold text-5xl leading-none mt-1.5 tabular-nums ${shipDays != null && shipDays <= 2 ? 'text-[#FF6B6B]' : 'text-safety'}`}>
            {week?.ship_date ? relativeDay(shipDays).toUpperCase() : 'NO DATE'}
          </div>
          <div className="text-sm text-floorMute mt-1">{week?.ship_date ? shortDate(week.ship_date) : 'Set a ship date below'}</div>
          {week && (
            <div className="flex items-center gap-2 mt-3">
              <input
                id="overview-ship-date"
                type="date"
                value={shipDraft}
                onChange={(e) => setShipDraft(e.target.value)}
                className="bg-floorCard border border-floorLine rounded-lg px-2 py-1.5 text-sm text-paper [color-scheme:dark]"
                aria-label="Ship date"
              />
              {shipDraft && shipDraft !== week.ship_date && (
                <button onClick={saveShipDate} disabled={!live} className="bg-safety text-charcoal text-sm font-bold rounded-lg px-3 py-1.5 disabled:opacity-40">
                  Move &amp; notify floor
                </button>
              )}
            </div>
          )}
        </div>

        <Kpi label="Week complete" value={`${pct}%`}>
          <div className="h-2 rounded-full bg-paperDim overflow-hidden flex mt-3" aria-hidden="true">
            {WORKFLOW_STAGES.map((s) => (
              <i key={s.id} className={STAGE_BAR[s.id]} style={{ width: `${weekStats.total ? (weekStats.byStage[s.id] / weekStats.total) * 100 : 0}%` }} />
            ))}
          </div>
          <div className="text-sm text-steelLight mt-1.5 tabular-nums">
            {weekStats.ordersDone} of {weekOrders.length} orders fully built
          </div>
        </Kpi>

        <Kpi label="At risk" value={atRisk.length} tone={atRisk.length ? 'amber' : null}>
          <div className="text-sm text-steelLight mt-1">
            {atRisk.filter((r) => r.days < 0).length
              ? `${atRisk.filter((r) => r.days < 0).length} already past pickup`
              : `picking up within ${AT_RISK_DAYS} days, not finished`}
          </div>
        </Kpi>

        <Kpi label="Blocked" value={blocked.length} tone={blocked.length ? 'red' : null}>
          <div className="text-sm text-steelLight mt-1 truncate">
            {blocked.length ? `oldest ${ago(blocked[0].c.blockedAt)} — ${blocked[0].c.blockedNote ?? 'no reason given'}` : 'nothing stuck'}
          </div>
        </Kpi>
      </div>

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-3 items-start">
        {/* ── Needs attention ── */}
        <section className="rounded-2xl bg-white border border-paperDim p-4">
          <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Needs attention</h2>
          {loading ? (
            <p className="text-sm text-steelLight mt-2">Loading…</p>
          ) : blocked.length === 0 && atRisk.length === 0 ? (
            <p className="text-sm text-steelLight mt-2">Nothing blocked and nothing at risk. Good week.</p>
          ) : (
            <ul className="mt-2 divide-y divide-paperDim">
              {blocked.map(({ o, colId, c }) => (
                <li key={`b-${o.id}-${colId}`} className="py-2.5 grid grid-cols-[1fr_auto] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="rounded-md bg-andonRedBg text-andonRed text-xs font-bold px-2 py-0.5">BLOCKED {ago(c.blockedAt)}</span>
                      <button onClick={() => onEditOrder(o)} className="font-display font-bold text-lg text-charcoal hover:underline truncate">
                        {o.tag_name}
                      </button>
                    </div>
                    <div className="text-sm text-steelLight">
                      <b className="text-steel">{columnName[colId]}</b> · {c.blockedNote ?? 'no reason given'} · {o.dealer}
                    </div>
                  </div>
                  <button
                    onClick={() => clearBlock(o, colId)}
                    disabled={!live}
                    className="rounded-lg border border-paperDim px-3 py-2 text-sm font-semibold text-andonGreen hover:bg-andonGreenBg disabled:opacity-40"
                  >
                    Clear block
                  </button>
                </li>
              ))}
              {atRisk.map(({ o, days, open }) => (
                <li key={`r-${o.id}`} className="py-2.5 grid grid-cols-[1fr_auto] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`rounded-md text-xs font-bold px-2 py-0.5 ${days < 0 ? 'bg-andonRed text-white' : 'bg-safety/25 text-[#8A6606]'}`}>
                        {days < 0 ? `${-days}D LATE` : days === 0 ? 'PICKUP TODAY' : `PICKUP IN ${days}D`}
                      </span>
                      <span className="font-display font-bold text-lg text-charcoal truncate">{o.tag_name}</span>
                    </div>
                    <div className="text-sm text-steelLight">
                      Waiting on {open.map(([id]) => columnName[id]).join(', ')}
                    </div>
                  </div>
                  <button onClick={() => onEditOrder(o)} className="rounded-lg border border-paperDim px-3 py-2 text-sm font-semibold text-charcoal hover:bg-paper">
                    Reschedule
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-3">
          {/* ── Departments ── */}
          <section className="rounded-2xl bg-white border border-paperDim p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Departments</h2>
              <button onClick={onOpenGrid} className="text-sm text-andonBlue font-medium">
                Open grid →
              </button>
            </div>
            <ul className="mt-2 space-y-3">
              {deptStats.map(({ d, jobs, done, started, blocked: b }) => (
                <li key={d.id}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-display font-bold text-lg text-charcoal">{d.name}</span>
                    <span className="text-steelLight tabular-nums">
                      {jobs ? `${done}/${jobs} done` : 'none this week'}
                      {b > 0 && <b className="text-andonRed"> · {b} blocked</b>}
                    </span>
                  </div>
                  {jobs > 0 && (
                    <div className="h-2 rounded-full bg-paperDim overflow-hidden flex mt-1" aria-hidden="true">
                      <i className="bg-andonGreen" style={{ width: `${(done / jobs) * 100}%` }} />
                      <i className="bg-andonBlue" style={{ width: `${(started / jobs) * 100}%` }} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* ── Activity ── */}
          <section className="rounded-2xl bg-white border border-paperDim p-4">
            <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">On the floor</h2>
            {events.length === 0 ? (
              <p className="text-sm text-steelLight mt-2">No activity yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {events.map((e) => (
                  <li key={e.id} className="grid grid-cols-[2.5rem_1fr] gap-2 text-sm">
                    <span className="text-steelLight tabular-nums text-right">{ago(e.created_at)}</span>
                    <span className={e.message.includes('BLOCKED') ? 'text-andonRed' : 'text-steel'}>{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {toast && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-5 z-50 bg-charcoal text-paper rounded-xl shadow-2xl px-4 py-3 text-sm max-w-[calc(100vw-32px)]">
          {toast}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, tone, children }) {
  const color = tone === 'red' ? 'text-andonRed' : tone === 'amber' ? 'text-safetyDark' : 'text-charcoal'
  return (
    <div className="rounded-2xl bg-white border border-paperDim p-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-steelLight font-semibold">{label}</div>
      <div className={`font-display font-extrabold text-5xl leading-none mt-1.5 tabular-nums ${color}`}>{value}</div>
      {children}
    </div>
  )
}
