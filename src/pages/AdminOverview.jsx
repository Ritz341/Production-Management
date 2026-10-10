import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { WORKFLOW_STAGES } from '../lib/statusColors'
import { blockText, fmtQty, isoDate, pickupLoads, planLine, processesFor, ratePerHourOf, rateFor, useSettings } from '../lib/catalog'
import WeekLoad from '../components/WeekLoad.jsx'
import { purgeOld, purgeSummary } from '../lib/purgeOld'
import { nearestBuildWeekId, weekName, weekOptionLabel } from '../lib/dates'
import { dbErrorText } from '../lib/dbError'
import { DONE_RANK, HEADLINE_TONE_CLASS, ago, buildNumbers, daysUntil, relativeDay, shortDate, stageRank, weekHeadline } from '../lib/schedule'

// How close a pickup has to be before an unfinished order counts as at risk.
const AT_RISK_DAYS = 3

const STAGE_BAR = {
  started: 'bg-andonBlue',
  completed: 'bg-andonGreen',
}

/**
 * The production coordinator's home screen: what ships next, how far
 * along it is, and what needs a decision — blocked jobs, orders that
 * won't make their pickup — with the fix one tap away.
 */
export default function AdminOverview({ buildWeeks, onWeeksChanged, onEditOrder, onNewOrder, onImport, onOpenGrid, onOpenOrder, onOpenTvs }) {
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
  const [crewOpen, setCrewOpen] = useState(false)
  const [showAllReady, setShowAllReady] = useState(false)
  const [showAllAttention, setShowAllAttention] = useState(false)
  const settings = useSettings()
  const [crewRows, setCrewRows] = useState([]) // bt_crew_days rows
  const [qtyKeys, setQtyKeys] = useState(new Set()) // 'orderId:measure' with a count
  const [processDays, setProcessDays] = useState([]) // today's bt_process_days rows
  const today = isoDate(new Date())

  useEffect(() => {
    setWeekId((prev) => prev ?? nearestBuildWeekId(buildWeeks))
  }, [buildWeeks])

  // Six weeks of history, then it clears itself — once a day, the first
  // time admin opens the app (schema_v31). Quiet if there's nothing to do,
  // and quiet if it can't (migration not run, not an admin): it just tries
  // again on the next visit.
  useEffect(() => {
    if (!live) return
    let last = null
    try {
      last = localStorage.getItem('purge:last')
    } catch {}
    if (last === today) return
    let active = true
    purgeOld(supabase, { ask: (text) => window.confirm(text) })
      .then((r) => {
        if (r.skipped) return
        try {
          localStorage.setItem('purge:last', today)
        } catch {}
        const msg = purgeSummary(r)
        if (msg && active) {
          setToast(msg)
          onWeeksChanged?.()
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

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
        .select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date, created_at, notes, sequence, status, cancel_reason, paperwork_ready_at, mods_count, walls_count, room_shape, window_type, panel_type')
        .is('actual_pickup_date', null)
        .eq('status', 'active')
      const ids = (orderRows ?? []).map((o) => o.id)
      const { data: statusRows, error: sErr } = ids.length
        ? await supabase
            .from('bt_order_status')
            .select('order_id, status_column_id, status_value, is_visible, workflow_stage, blocked_at, blocked_note, blocked_category')
            .in('order_id', ids)
            .is('removed_at', null)
        : { data: [] }
      const { data: eventRows } = await supabase
        .from('bt_events')
        .select('id, event_type, message, created_at')
        // Every Start / Done also wrote a second, older event type; the
        // feed shows the one that carries the detail.
        .not('event_type', 'in', '(column_started,column_completed)')
        .order('created_at', { ascending: false })
        .limit(25)
      const { data: qtyRows } = ids.length
        ? await supabase.from('bt_order_quantities').select('order_id, measure').in('order_id', ids)
        : { data: [] }
      if (active) setQtyKeys(new Set((qtyRows ?? []).map((q) => `${q.order_id}:${q.measure}`)))
      const { data: crew } = await supabase.from('bt_crew_days').select('work_date, department_id, people')
      const { data: procDays } = await supabase
        .from('bt_process_days')
        .select('department_id, process, people')
        .eq('work_date', isoDate(new Date()))
      if (!active) return
      setCrewRows(crew ?? [])
      setProcessDays(procDays ?? [])

      const err = oErr || sErr
      setLoadError(dbErrorText(err, "Couldn't load the overview"))
      const numbers = buildNumbers(orderRows ?? [])
      const byId = new Map((orderRows ?? []).map((o) => [o.id, { ...o, buildNo: numbers.get(o.id), statuses: {} }]))
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
          blockedCategory: s.blocked_category,
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_crew_days' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_process_days' }, load)
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
      const r = stageRank(c.stage)
      if (r === 1) byStage.started++
      if (r >= DONE_RANK) {
        byStage.completed++
        done++
      }
    }
    const ordersDone = weekOrders.filter((o) => cellsOf(o).every(([, c]) => stageRank(c.stage) >= DONE_RANK)).length
    return { total: cells.length, done, byStage, ordersDone }
  }, [weekOrders])

  // Orders fully built, per week — for the week picker.
  const weekBuilt = useMemo(() => {
    const out = new Map()
    for (const o of orders) {
      if (o.status === 'cancelled') continue
      const cells = cellsOf(o)
      const entry = out.get(o.build_week_id) ?? { total: 0, done: 0 }
      entry.total++
      if (cells.length && cells.every(([, c]) => stageRank(c.stage) >= DONE_RANK)) entry.done++
      out.set(o.build_week_id, entry)
    }
    return out
  }, [orders])

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
            else if (r === 1) started++
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
    setToast(
      `Now ships ${shortDate(shipDraft)}${week.ship_date ? `, moved from ${shortDate(week.ship_date)}` : ''} — every tablet has been updated`
    )
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

  const modsDept = departments.find((d) => d.name === 'Mods')
  const modsCrewByDate = useMemo(
    () => Object.fromEntries(crewRows.filter((r) => r.department_id === modsDept?.id).map((r) => [r.work_date, Number(r.people)])),
    [crewRows, modsDept]
  )
  const crewToday = useMemo(
    () => Object.fromEntries(crewRows.filter((r) => r.work_date === today).map((r) => [r.department_id, Number(r.people)])),
    [crewRows, today]
  )

  // Is each pickup doable? Cumulative across pickups (see pickupLoads),
  // counting only orders whose Mods work isn't done yet.
  const loads = useMemo(() => {
    const modCols = new Set(deptColumns[modsDept?.id] ?? [])
    const modsFinished = (o) => {
      const cells = cellsOf(o).filter(([id]) => modCols.has(Number(id)))
      return cells.length > 0 && cells.every(([, c]) => stageRank(c.stage) >= DONE_RANK)
    }
    return pickupLoads(
      buildWeeks
        .filter((w) => w.ship_date && daysUntil(w.ship_date) >= 0)
        .map((w) => ({ key: w.id, shipDate: w.ship_date, orders: orders.filter((o) => o.build_week_id === w.id && !modsFinished(o)) })),
      settings,
      modsCrewByDate
    )
  }, [buildWeeks, orders, deptColumns, modsDept, settings, modsCrewByDate])

  const peopleByProcess = (deptId) =>
    Object.fromEntries(processDays.filter((r) => r.department_id === deptId).map((r) => [r.process, Number(r.people)]))

  // People on one process today. The department's total in bt_crew_days
  // is kept equal to the sum, so estimates and anything reading the
  // department crew still add up.
  async function saveProcessCrew(dept, processId, value) {
    if (!live) return
    const people = value === '' ? null : Number(value)
    const res =
      people == null
        ? await supabase.from('bt_process_days').delete().eq('work_date', today).eq('department_id', dept.id).eq('process', processId)
        : await supabase
            .from('bt_process_days')
            .upsert({ work_date: today, department_id: dept.id, process: processId, people }, { onConflict: 'work_date,department_id,process' })
    if (res.error) return setToast(`Couldn't save crew: ${res.error.message}`)
    const next = { ...peopleByProcess(dept.id), [processId]: people }
    const total = Object.values(next).reduce((sum, n) => sum + (n ?? 0), 0)
    await saveCrew(dept.id, total ? String(total) : '')
  }

  async function saveCrew(departmentId, value) {
    if (!live) return
    const people = value === '' ? null : Number(value)
    const { error } =
      people == null
        ? await supabase.from('bt_crew_days').delete().eq('work_date', today).eq('department_id', departmentId)
        : await supabase.from('bt_crew_days').upsert({ work_date: today, department_id: departmentId, people }, { onConflict: 'work_date,department_id' })
    setToast(error ? `Couldn't save crew: ${error.message}` : 'Crew for today saved')
  }

  const upcoming = useMemo(() => {
    const dated = buildWeeks.filter((w) => w.ship_date && daysUntil(w.ship_date) >= -7)
    return dated.sort((a, b) => a.ship_date.localeCompare(b.ship_date)).slice(0, 5)
  }, [buildWeeks])

  // ── Ready for the day? One checklist instead of notes scattered
  // across every screen. Each line is green when nothing's needed.
  const readiness = useMemo(() => {
    const crewToday = new Set(crewRows.filter((c) => c.work_date === today && Number(c.people) > 0).map((c) => c.department_id))
    const noCrew = departments.filter((d) => !crewToday.has(d.id))
    const noTarget = departments.filter((d) => !rateFor(settings, d.name).perPerson && !processesFor(settings, d.name).some((p) => ratePerHourOf(p)))
    const noMods = weekOrders.filter((o) => !o.mods_count)
    const noV4T = weekOrders.filter((o) => o.window_type === 'v4t' && !qtyKeys.has(`${o.id}:v4t_frames`))
    const noPaper = weekOrders.filter((o) => !o.paperwork_ready_at)
    const names = (list, f) => list.slice(0, 3).map(f).join(', ') + (list.length > 3 ? ` +${list.length - 3} more` : '')
    return [
      {
        id: 'crew',
        ok: noCrew.length === 0,
        title: noCrew.length ? `No people entered today for ${noCrew.length} department${noCrew.length === 1 ? '' : 's'}` : 'Crew entered for every department',
        detail: noCrew.length ? `${names(noCrew, (d) => d.name)} — their TVs show no target` : null,
        action: noCrew.length ? ['Enter crew', () => { setCrewOpen(true); setTimeout(() => document.getElementById('crew-today')?.scrollIntoView({ behavior: 'smooth' }), 50) }] : null,
      },
      {
        id: 'targets',
        ok: noTarget.length === 0,
        title: noTarget.length ? `${noTarget.length} department${noTarget.length === 1 ? ' has' : 's have'} no target rate` : 'Every department has a target',
        detail: noTarget.length ? names(noTarget, (d) => d.name) : null,
        action: noTarget.length && onOpenTvs ? ['Set targets', onOpenTvs] : null,
      },
      {
        id: 'counts',
        ok: noMods.length + noV4T.length === 0,
        title:
          noMods.length + noV4T.length
            ? [noMods.length && `${noMods.length} missing mod counts`, noV4T.length && `${noV4T.length} V4T orders missing frame counts`].filter(Boolean).join(' · ')
            : 'Counts in for this week',
        detail: noMods.length + noV4T.length ? `${names([...noMods, ...noV4T], (o) => `#${o.buildNo} ${o.tag_name}`)} — their Done won't be counted` : null,
        orders: [...new Map([...noMods, ...noV4T].map((o) => [o.id, o])).values()],
      },
      {
        id: 'paper',
        ok: noPaper.length === 0,
        title: noPaper.length ? `Paperwork not ready for ${noPaper.length} of ${weekOrders.length} orders this week` : 'Paperwork ready for this week',
        detail: noPaper.length ? names(noPaper, (o) => `#${o.buildNo} ${o.tag_name}`) : null,
        orders: noPaper,
      },
    ]
  }, [crewRows, departments, settings, weekOrders, qtyKeys, today, onOpenTvs])
  const readyCount = readiness.filter((r) => r.ok).length

  const shipDays = daysUntil(week?.ship_date)
  // Counted in orders, not department jobs: the tile is about whether
  // this week still owes the yard anything.
  const headline = weekHeadline(week?.ship_date, { total: weekOrders.length, done: weekStats.ordersDone })
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
              {/* The ship date is the week's name. The stored label is
                  the sheet's banner and carries a date of its own, so
                  leading with it puts a second, staler date on screen. */}
              <div className="font-display font-bold text-lg leading-tight text-charcoal">{shortDate(w.ship_date)}</div>
              {(() => {
                // Same rule as the big tile: a week that's fully built
                // isn't late, it's waiting on a truck.
                const h = weekHeadline(w.ship_date, weekBuilt.get(w.id) ?? {})
                return (
                  <div className={`text-xs ${h.tone === 'done' ? 'text-andonGreen font-semibold' : h.tone === 'late' ? 'text-andonRed' : 'text-steelLight'}`}>
                    {h.tone === 'done' ? 'All built' : relativeDay(daysUntil(w.ship_date))}
                    {weekName(w) && ` · ${weekName(w)}`}
                  </div>
                )
              })()}
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
                  {weekOptionLabel(w)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={onImport} className="rounded-lg border border-paperDim bg-white px-4 py-2.5 text-sm font-semibold text-charcoal">
            Add the week
          </button>
          <button onClick={onNewOrder} className="rounded-lg bg-safety px-4 py-2.5 font-display font-bold text-charcoal">
            + New order
          </button>
        </div>
      </div>

      {loadError && <div className="mt-4 bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {loadError}</div>}

      {/* ── KPIs ── */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-2xl bg-charcoal text-paper p-4">
          <div className="text-[11px] uppercase tracking-[0.12em] text-floorMute font-semibold">
            {weekName(week) || 'This build week'} ships
          </div>
          <div className={`font-display font-extrabold text-5xl leading-none mt-1.5 tabular-nums ${HEADLINE_TONE_CLASS[headline.tone]}`}>
            {headline.text}
          </div>
          <div className="text-sm text-floorMute mt-1">
            {week?.ship_date ? shortDate(week.ship_date) : 'Set a ship date below'}
            {/* Still say where the date sits — finished early and finished
                late are different facts, they're just not alarms. */}
            {headline.tone === 'done' && shipDays != null && ` · ${relativeDay(shipDays)}`}
          </div>
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

      </div>

      {/* ── Before the day starts ──
          Only what's still open. When everything's in place it is one
          green line, not a checklist to read. */}
      {readyCount === readiness.length ? (
        <div className="mt-3 rounded-2xl bg-andonGreenBg text-andonGreen font-semibold px-4 py-3 text-sm">
          ✓ Ready for today — crew, targets and paperwork are all in.
        </div>
      ) : (
        <section className="mt-3 rounded-2xl bg-white border border-paperDim p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Before the day starts</h2>
            <span className="text-sm text-steelLight tabular-nums">{readiness.length - readyCount} to do</span>
          </div>
          <ul className="mt-2 grid gap-2">
            {readiness.filter((r) => !r.ok).slice(0, showAllReady ? undefined : 2).map((r) => (
              <li key={r.id} className="rounded-xl border border-safety bg-safety/10 px-3 py-2.5 flex gap-3 items-center">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-charcoal">{r.title}</div>
                  {r.detail && <div className="text-xs text-steelLight mt-0.5">{r.detail}</div>}
                  {r.orders?.length > 0 && onOpenOrder && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {r.orders.slice(0, 4).map((o) => (
                        <button key={o.id} onClick={() => onOpenOrder(o)} className="rounded-md border border-paperDim bg-white px-2 py-1 text-xs font-semibold text-andonBlue">
                          #{o.buildNo} open
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {r.action && (
                  <button onClick={r.action[1]} className="shrink-0 rounded-lg bg-charcoal text-paper text-sm font-semibold px-3 min-h-[40px]">
                    {r.action[0]}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {readiness.filter((r) => !r.ok).length > 2 && (
            <button onClick={() => setShowAllReady((v) => !v)} className="mt-2 text-sm text-andonBlue font-medium">
              {showAllReady ? 'Show less' : `Show ${readiness.filter((r) => !r.ok).length - 2} more`}
            </button>
          )}
        </section>
      )}

      {/* Two stacks of about the same height: what's happening on the
          left, planning on the right. The left used to hold Needs
          attention alone — two lines on a good day, then a screen of
          empty space beside a right column four panels deep. */}
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-3 items-start">
        <div className="grid gap-3">
        {/* ── Needs attention ── */}
        <section className="rounded-2xl bg-white border border-paperDim p-4">
          <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Needs attention</h2>
          {loading ? (
            <p className="text-sm text-steelLight mt-2">Loading…</p>
          ) : blocked.length === 0 && atRisk.length === 0 ? (
            <p className="text-sm text-steelLight mt-2">Nothing blocked and nothing at risk. Good week.</p>
          ) : (
            <ul className="mt-2 divide-y divide-paperDim">
              {blocked.slice(0, showAllAttention ? undefined : 3).map(({ o, colId, c }) => (
                <li key={`b-${o.id}-${colId}`} className="py-2.5 grid grid-cols-[1fr_auto] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="rounded-md bg-andonRedBg text-andonRed text-xs font-bold px-2 py-0.5">BLOCKED {ago(c.blockedAt)}</span>
                      <button onClick={() => onEditOrder(o)} className="font-display font-bold text-lg text-charcoal hover:underline truncate">
                        #{o.buildNo} {o.tag_name}
                      </button>
                    </div>
                    <div className="text-sm text-steelLight">
                      <b className="text-steel">{columnName[colId]}</b> · {blockText(c)} · {o.dealer}
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
              {atRisk.slice(0, showAllAttention ? undefined : Math.max(0, 3 - blocked.length)).map(({ o, days, open }) => (
                <li key={`r-${o.id}`} className="py-2.5 grid grid-cols-[1fr_auto] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`rounded-md text-xs font-bold px-2 py-0.5 ${days < 0 ? 'bg-andonRed text-white' : 'bg-safety/25 text-[#8A6606]'}`}>
                        {days < 0 ? `${-days}D LATE` : days === 0 ? 'PICKUP TODAY' : `PICKUP IN ${days}D`}
                      </span>
                      <span className="font-display font-bold text-lg text-charcoal truncate">#{o.buildNo} {o.tag_name}</span>
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
          {blocked.length + atRisk.length > 3 && (
            <button onClick={() => setShowAllAttention((v) => !v)} className="mt-2 text-sm text-andonBlue font-medium">
              {showAllAttention ? 'Show less' : `Show all ${blocked.length + atRisk.length}`}
            </button>
          )}
        </section>

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
        </div>

        <div className="grid gap-3">
          {/* ── Can we make it? ── */}
          {loads.get(weekId) && (
            <Fold title="Can we make it?" hint="mods work vs. crew">
              <p className="text-sm text-steelLight mb-2">
                Mods work left for {week?.ship_date ? shortDate(week.ship_date) : 'this week'} and every pickup before it,
                against the crew until it ships.
              </p>
              <WeekLoad load={loads.get(weekId)} settings={settings} />
            </Fold>
          )}

          {/* ── Crew today ── */}
          <Fold id="crew-today" title="Crew today" hint="people on each department" open={crewOpen} onToggle={setCrewOpen}>
            <p className="text-sm text-steelLight">
              People on each department today. Leave blank to assume {settings.default_mods_crew} on Mods.
            </p>
            <ul className="mt-2 space-y-3">
              {departments.map((d) =>
                processesFor(settings, d.name).length > 0 ? (
                  <ProcessCrew
                    key={d.id}
                    dept={d}
                    processes={processesFor(settings, d.name)}
                    people={peopleByProcess(d.id)}
                    settings={settings}
                    live={live}
                    onSave={(processId, v) => saveProcessCrew(d, processId, v)}
                  />
                ) : (
                <li key={d.id} className="flex items-center justify-between gap-3">
                  <label htmlFor={`crew-${d.id}`} className="font-display font-bold text-lg text-charcoal">
                    {d.name}
                  </label>
                  <span className="flex items-center gap-2 text-sm text-steelLight">
                    {d.id === modsDept?.id && crewToday[d.id] != null && (
                      <span className="tabular-nums">target {Math.round(crewToday[d.id] * settings.mods_per_person_day)} mods</span>
                    )}
                    <input
                      id={`crew-${d.id}`}
                      type="number"
                      min="0"
                      step="0.5"
                      defaultValue={crewToday[d.id] ?? ''}
                      key={`${d.id}-${crewToday[d.id] ?? ''}`}
                      onBlur={(e) => e.target.value !== String(crewToday[d.id] ?? '') && saveCrew(d.id, e.target.value)}
                      disabled={!live}
                      className="w-16 rounded border border-paperDim px-2 py-1.5 text-charcoal tabular-nums"
                    />
                    people
                  </span>
                </li>
                )
              )}
            </ul>
          </Fold>

          {/* ── Activity ── */}
          <Fold title="On the floor" hint="latest activity">
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
          </Fold>
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

// A panel that stays shut until it's wanted: one tap on the header.
function Fold({ id, title, hint, open, onToggle, children }) {
  const [own, setOwn] = useState(false)
  const isOpen = open ?? own
  const toggle = () => (onToggle ? onToggle(!isOpen) : setOwn(!isOpen))
  return (
    <section id={id} className="rounded-2xl bg-white border border-paperDim scroll-mt-4">
      <button
        onClick={toggle}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between gap-3 px-4 min-h-[52px] text-left"
      >
        <span className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">
          {title}
          {hint && <span className="ml-2 font-sans normal-case tracking-normal text-sm font-normal text-steelLight">{hint}</span>}
        </span>
        <span className="text-steelLight text-lg" aria-hidden="true">{isOpen ? '−' : '+'}</span>
      </button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </section>
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

/** One department's people per process today, with the line worked out. */
function ProcessCrew({ dept, processes, people, settings, live, onSave }) {
  const plan = planLine(processes, people, settings)
  const unit = processes[processes.length - 1]?.unit ?? 'units'
  return (
    <li className="rounded-xl border border-paperDim p-3">
      <div className="font-display font-bold text-lg text-charcoal">{dept.name}</div>
      <div className="mt-1 grid gap-1.5">
        {plan.steps.map((st) => (
          <div key={st.id} className={`flex items-center justify-between gap-3 text-sm ${st.isBottleneck ? 'text-andonRed font-semibold' : 'text-steel'}`}>
            <label htmlFor={`pc-${dept.id}-${st.id}`} className="truncate">
              {st.name}
            </label>
            <span className="flex items-center gap-2">
              <span className="tabular-nums text-xs text-steelLight">
                {st.daily != null ? `${fmtQty(st.daily)} ${st.unit}` : ratePerHourOf(st) ? '' : 'no time set'}
              </span>
              <input
                id={`pc-${dept.id}-${st.id}`}
                type="number"
                min="0"
                step="0.5"
                defaultValue={people[st.id] ?? ''}
                key={`${st.id}-${people[st.id] ?? ''}`}
                onBlur={(e) => e.target.value !== String(people[st.id] ?? '') && onSave(st.id, e.target.value)}
                disabled={!live}
                className="w-14 rounded border border-paperDim px-2 py-1 text-charcoal tabular-nums"
              />
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-steelLight">
        {plan.capacity != null ? (
          <>
            <b className="text-charcoal">
              {plan.independent ? 'Benches' : 'Line'}: {fmtQty(plan.capacity)} {unit} today
            </b>{' '}
            {plan.independent ? (
              // Each bench stands on its own, so naming one "the"
              // bottleneck would point the crew at the wrong problem.
              <>· {plan.lines.map((l) => `${l.line} ${fmtQty(l.capacity)}`).join(' · ')}</>
            ) : (
              <>
                · bottleneck <b className="text-andonRed">{plan.bottleneck.name}</b>
              </>
            )}
          </>
        ) : (
          'Enter people per process (and minutes for one in Setup → Targets & TVs) to see the line output.'
        )}
      </p>
    </li>
  )
}
