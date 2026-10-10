import { unitsText, useUnitsToday } from '../lib/unitsDone'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { WORKFLOW_STAGES } from '../lib/statusColors'
import { blockText, defectLabel, isoDate, useSettings, weekPace } from '../lib/catalog'
import { nearestBuildWeekId, weekName, weekOptionLabel } from '../lib/dates'
import { dbErrorText } from '../lib/dbError'
import { DONE_RANK, HEADLINE_TONE_CLASS, buildNumbers, byBuildOrder, daysUntil, nextStageId as nextStage, relativeDay, shortDate, stageLabel, stageRank, wasMovedRecently, weekHeadline } from '../lib/schedule'
import { useConnection } from '../lib/ConnectionContext.jsx'
import OrderSheet from '../components/OrderSheet.jsx'
import { Chip } from '../components/ui.jsx'
import NotificationBanner, { NotificationBell } from '../components/NotificationBanner.jsx'
import BlockReasonModal from '../components/BlockReasonModal.jsx'
import QualityIssueModal, { departmentChoices } from '../components/QualityIssueModal.jsx'
import CountBar from '../components/CountBar.jsx'

const COUNT_WORDS = { mods: 'mod', v4t_frames: 'V4T frame', vents: 'vent', tracks: 'track', roof_panels: 'roof panel', filler_panels: 'filler panel', doors: 'door' }

export default function DepartmentView() {
  const { profile, signOut } = useAuth()
  const { live } = useConnection()
  const [blockTarget, setBlockTarget] = useState(null) // { orderId, columnId } while the reason picker is open
  const [departments, setDepartments] = useState([])
  // A tablet can be assigned 2-3 departments to combine into one
  // actionable queue (see bt_profile_departments). Defaults to
  // whatever this login is assigned; the picker below can still add
  // other departments to peek at (read-only unless also assigned).
  const [selectedDeptIds, setSelectedDeptIds] = useState(
    profile?.combinedDepartmentIds?.length ? profile.combinedDepartmentIds : profile?.department_id != null ? [profile.department_id] : []
  )
  const [buildWeeks, setBuildWeeks] = useState([])
  const [selectedWeekId, setSelectedWeekId] = useState(null)
  const [allColumns, setAllColumns] = useState([])
  const [deptColumnMap, setDeptColumnMap] = useState({}) // deptId -> [columnId,…]
  const [ownColumnIds, setOwnColumnIds] = useState([])
  // Orders still open for this department in a pickup whose date has gone by.
  // A tablet shows one week at a time and starts on the next upcoming one, so
  // without this an order left over from last week is on no screen at all.
  const [earlier, setEarlier] = useState({ count: 0, weekId: null })
  const [orders, setOrders] = useState([])
  const [sheetOrder, setSheetOrder] = useState(null)
  // Counts this tablet's departments may type (tracks on Track …), from
  // bt_measure_editors. Empty until schema_v26 has been run.
  const [typable, setTypable] = useState([])
  useEffect(() => {
    const ids = profile?.combinedDepartmentIds ?? []
    if (!ids.length) return
    supabase
      .from('bt_measure_editors')
      .select('measure')
      .in('department_id', ids)
      .then(({ data }) => setTypable([...new Set((data ?? []).map((r) => r.measure))]))
  }, [profile?.combinedDepartmentIds])
  const [qualityFor, setQualityFor] = useState(null) // order being reported on
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Bootstrap: departments, columns, build weeks, department-column mappings
  useEffect(() => {
    supabase.from('bt_departments').select('id, name').order('sort_order').then(({ data }) => setDepartments(data ?? []))
    supabase.from('bt_status_columns').select('id, name').order('sort_order').then(({ data }) => setAllColumns(data ?? []))
    supabase.from('bt_department_columns').select('department_id, status_column_id').then(({ data }) => {
      const map = {}
      for (const d of data ?? []) {
        if (!map[d.department_id]) map[d.department_id] = []
        map[d.department_id].push(d.status_column_id)
      }
      setDeptColumnMap(map)
    })

    // Newest ship date first in the list — oldest scrolls to the bottom.
    function loadWeeks(initial) {
      return supabase
        .from('bt_build_weeks')
        .select('*')
        .order('ship_date', { ascending: false, nullsFirst: false })
        .then(({ data }) => {
          const weeks = data ?? []
          setBuildWeeks(weeks)
          // Default to the week the floor is actually building next, not
          // everything mixed together. Only on first load — a live refresh
          // must never yank the tablet off the week someone is looking at.
          if (initial) setSelectedWeekId(nearestBuildWeekId(weeks) ?? 'all')
        })
    }
    loadWeeks(true)

    // Admin moving a ship date mid-week has to reach the header on every
    // tablet, not just raise the alert banner.
    //
    // Listened for two ways on purpose. bt_build_weeks is the direct
    // signal, but it only arrives if that table is in the realtime
    // publication (schema_v6) — and a database that missed that
    // migration is exactly the one where the banner fires and the
    // header underneath it stays on the old date. bt_events carries the
    // same change and must be live for the banner to appear at all, so
    // it's the one that can't silently be missing.
    const channel = supabase
      .channel('dept-build-weeks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, () => loadWeeks(false))
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bt_events', filter: 'event_type=eq.ship_date_changed' },
        () => loadWeeks(false)
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  // When the selected department set changes, resolve the union of
  // their columns — this is what makes combining departments actionable
  // instead of just a read-only peek.
  useEffect(() => {
    const union = new Set()
    for (const id of selectedDeptIds) {
      for (const colId of deptColumnMap[id] ?? []) union.add(colId)
    }
    setOwnColumnIds(Array.from(union))
  }, [selectedDeptIds, deptColumnMap])

  // Counts what's still open from earlier pickups (not collected, not done here).
  useEffect(() => {
    const today = isoDate(new Date())
    const pastIds = buildWeeks.filter((w) => w.ship_date && w.ship_date < today && w.id !== selectedWeekId).map((w) => w.id)
    if (ownColumnIds.length === 0 || selectedWeekId === 'all' || pastIds.length === 0) {
      setEarlier({ count: 0, weekId: null })
      return
    }
    let active = true
    ;(async () => {
      const { data: os } = await supabase
        .from('bt_orders')
        .select('id, build_week_id')
        .eq('status', 'active')
        .is('actual_pickup_date', null)
        .in('build_week_id', pastIds)
      const weekOf = new Map((os ?? []).map((o) => [o.id, o.build_week_id]))
      if (weekOf.size === 0) return active && setEarlier({ count: 0, weekId: null })
      const { data: st } = await supabase
        .from('bt_order_status')
        .select('order_id, workflow_stage')
        .in('order_id', [...weekOf.keys()])
        .in('status_column_id', ownColumnIds)
        .eq('is_visible', true)
        .is('removed_at', null)
      const open = new Set((st ?? []).filter((r) => stageRank(r.workflow_stage) < DONE_RANK).map((r) => r.order_id))
      // Jump to the oldest of those pickups first: that's the one most overdue.
      const oldest = buildWeeks
        .filter((w) => [...open].some((id) => weekOf.get(id) === w.id))
        .sort((a, b) => a.ship_date.localeCompare(b.ship_date))[0]
      if (active) setEarlier({ count: open.size, weekId: oldest?.id ?? null })
    })()
    return () => {
      active = false
    }
  }, [buildWeeks, ownColumnIds, selectedWeekId])

  // Load orders + statuses (including workflow_stage)
  useEffect(() => {
    if (selectedDeptIds.length === 0 || selectedWeekId == null || ownColumnIds.length === 0) return
    let active = true
    setLoading(true)

    async function load() {
      let orderQuery = supabase.from('bt_orders').select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date, sequence, moved_at, moved_direction, mods_count, walls_count, bt_build_weeks(ship_date)')
        .eq('status', 'active')
      if (selectedWeekId !== 'all') orderQuery = orderQuery.eq('build_week_id', selectedWeekId)
      const { data: orderRows, error: ordersErr } = await orderQuery
      if (ordersErr && active) setLoadError(dbErrorText(ordersErr, "Couldn't load orders"))
      const orderIds = (orderRows ?? []).map((o) => o.id)
      if (orderIds.length === 0) {
        if (active) { setOrders([]); setLoading(false) }
        return
      }

      const { data: statusRows, error: statusErr } = await supabase
        .from('bt_order_status')
        .select('order_id, status_value, status_column_id, workflow_stage, is_visible, blocked_at, blocked_note, blocked_category')
        .in('order_id', orderIds)
        .eq('is_visible', true)
        // A department taken off the order (e.g. done in Canada) drops off its tablet.
        .is('removed_at', null)
      // A failed query here (e.g. a schema migration not yet run against
      // this database) used to fail silently and just render an empty
      // queue — say so instead.
      if (statusErr && active) setLoadError(dbErrorText(statusErr, "Couldn't load statuses"))
      if (!statusErr && !ordersErr && active) setLoadError('')

      const { data: issueRows } = await supabase
        .from('bt_quality_issues')
        .select('id, order_id, responsible_column_id, reporter_column_id, defect_type, sent_back, created_at')
        .in('order_id', orderIds)
        .is('resolved_at', null)

      // Which counts each of this department's jobs is worked out from, and
      // which orders don't have them yet — a Done on those credits nothing.
      // (Quietly skipped if schema_v23/v25 haven't been run.)
      const [{ data: measureRows }, { data: qtyRows }] = await Promise.all([
        supabase.from('bt_column_measures').select('status_column_id, base_measure').in('status_column_id', ownColumnIds),
        supabase.from('bt_order_quantities').select('order_id, measure').in('order_id', orderIds),
      ])
      const haveQty = new Set((qtyRows ?? []).map((q) => `${q.order_id}:${q.measure}`))
      const basesOf = new Map()
      for (const m of measureRows ?? []) (basesOf.get(m.status_column_id) ?? basesOf.set(m.status_column_id, new Set()).get(m.status_column_id)).add(m.base_measure)

      if (!active) return

      // The build number is the order's place among ALL active orders in
      // its pickup — not just this department's — so #3 is #3 on every
      // tablet and on the admin screen.
      const numbers = buildNumbers(orderRows ?? [])
      const ordersById = new Map((orderRows ?? []).map((o) => [o.id, { ...o, buildNo: numbers.get(o.id), cells: {}, issues: [] }]))
      for (const issue of issueRows ?? []) ordersById.get(issue.order_id)?.issues.push(issue)
      for (const row of statusRows ?? []) {
        const o = ordersById.get(row.order_id)
        if (!o) continue
        o.cells[row.status_column_id] = {
          value: row.status_value,
          stage: row.workflow_stage,
          blocked: !!row.blocked_at,
          blockedNote: row.blocked_note,
          blockedCategory: row.blocked_category,
        }
      }
      // Only orders that have at least one of this department's columns
      const relevant = Array.from(ordersById.values()).filter((o) =>
        ownColumnIds.some((id) => o.cells[id] != null)
      )
      // The floor builds in the order admin set: pickup first, then #1, #2 …
      relevant.sort(byBuildOrder)
      for (const o of relevant) {
        const missing = new Set()
        for (const id of ownColumnIds) {
          if (o.cells[id] == null) continue
          for (const base of basesOf.get(id) ?? []) {
            if (!haveQty.has(`${o.id}:${base}`) && !(base === 'mods' && o.mods_count)) missing.add(base)
          }
        }
        o.missingCounts = [...missing]
      }
      setOrders(relevant)
      setLoading(false)
    }

    load()

    const channel = supabase
      .channel(`dept-${selectedDeptIds.join('-')}-${selectedWeekId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      // Order edits (dealer, pickup date, moved to another week) too.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_quality_issues' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_quantities' }, load)
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [selectedDeptIds, selectedWeekId, ownColumnIds])

  function patchCell(orderId, columnId, patch) {
    setOrders((prev) =>
      prev.map((o) => (o.id !== orderId ? o : { ...o, cells: { ...o.cells, [columnId]: { ...o.cells[columnId], ...patch } } }))
    )
  }

  // Advance a cell's workflow stage
  async function advanceStage(orderId, columnId, currentStage) {
    const next = nextStage(currentStage)
    if (!next) return
    // The connection indicator (NotificationBanner) already tells the
    // user why — just don't fire a write that'll never land.
    if (!live) return
    patchCell(orderId, columnId, { stage: next }) // optimistic
    const saved = await saveCell(orderId, columnId, { workflow_stage: next })
    if (!saved) patchCell(orderId, columnId, { stage: currentStage }) // roll back
  }

  // Writes one cell and reports whether it really saved. Supabase returns
  // no error when a permission rule filters the row out — it just updates
  // nothing — so the only honest check is that a row came back.
  async function saveCell(orderId, columnId, fields) {
    const { data, error } = await supabase
      .from('bt_order_status')
      .update(fields)
      .eq('order_id', orderId)
      .eq('status_column_id', columnId)
      .select('order_id')
    if (error || !data?.length) {
      setToast({
        message: error
          ? `Didn't save: ${error.message}`
          : `Didn't save — this tablet isn't set up for ${columnById[columnId] ?? 'that department'}. Ask admin.`,
        error: true,
      })
      return false
    }
    return true
  }

  // Set a specific stage (for the dropdown override)
  async function setStage(orderId, columnId, stageId, currentStage) {
    if (!live) return
    patchCell(orderId, columnId, { stage: stageId || null }) // optimistic
    const saved = await saveCell(orderId, columnId, { workflow_stage: stageId || null })
    if (!saved) patchCell(orderId, columnId, { stage: currentStage }) // roll back
  }

  // Blocked is a flag layered on top of whatever stage a cell is
  // already at (e.g. Order Started but waiting on a part) — not part
  // of the linear stage sequence, so it's tracked separately.
  // Unblocking needs no reason; blocking opens the reason picker below.
  function requestToggleBlocked(orderId, columnId, currentlyBlocked) {
    if (!live) return
    if (currentlyBlocked) applyBlocked(orderId, columnId, false)
    else setBlockTarget({ orderId, columnId })
  }

  async function applyBlocked(orderId, columnId, blocked, note = null, category = null) {
    const prevCell = orders.find((o) => o.id === orderId)?.cells[columnId]
    patchCell(orderId, columnId, { blocked, blockedNote: note, blockedCategory: category }) // optimistic
    const saved = await saveCell(orderId, columnId, {
      blocked_at: blocked ? new Date().toISOString() : null,
      blocked_note: blocked ? note : null,
      blocked_category: blocked ? category : null,
    })
    if (!saved && prevCell) patchCell(orderId, columnId, { blocked: prevCell.blocked, blockedNote: prevCell.blockedNote, blockedCategory: prevCell.blockedCategory }) // roll back
  }

  // Columns this login is allowed to change: only its assigned
  // departments. Others added through the picker are there to look at —
  // the database refuses their writes, so they get no buttons.
  const writableColumnIds = useMemo(() => {
    const ids = new Set()
    for (const deptId of profile?.combinedDepartmentIds ?? []) for (const c of deptColumnMap[deptId] ?? []) ids.add(c)
    return ids
  }, [profile, deptColumnMap])

  const currentDeptName = useMemo(
    () => departments.filter((d) => selectedDeptIds.includes(d.id)).map((d) => d.name).join(' + ') || 'Loading…',
    [departments, selectedDeptIds]
  )

  const selectedNames = useMemo(() => departments.filter((d) => selectedDeptIds.includes(d.id)).map((d) => d.name), [departments, selectedDeptIds])
  const unitsToday = useUnitsToday(selectedNames.length ? selectedNames : ['—'])

  function toggleDept(id) {
    setSelectedDeptIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const currentWeek = useMemo(() => buildWeeks.find((w) => w.id === selectedWeekId), [buildWeeks, selectedWeekId])
  const columnById = useMemo(() => Object.fromEntries(allColumns.map((c) => [c.id, c.name])), [allColumns])
  const columnOrder = useMemo(() => new Map(allColumns.map((c, i) => [c.id, i])), [allColumns])

  // Department name lookup for the cross-dept strip
  const deptByColumnId = useMemo(() => {
    const map = {}
    for (const [deptId, colIds] of Object.entries(deptColumnMap)) {
      const dept = departments.find((d) => d.id === Number(deptId))
      if (!dept) continue
      for (const cId of colIds) map[cId] = dept.name
    }
    return map
  }, [deptColumnMap, departments])

  // ── Lanes ──
  // Every order sits in exactly one lane, decided by this tablet's own
  // columns: any blocked → Blocked; otherwise its least-advanced column
  // decides. So an order only reaches Done when every job here is done.
  const lanes = useMemo(() => {
    const out = { blocked: [], todo: [], doing: [], done: [] }
    for (const o of orders) out[laneOf(o, ownColumnIds)].push(o)
    for (const l of Object.values(out)) l.sort(byBuildOrder)
    return out
  }, [orders, ownColumnIds])

  // Up next is simply the first job in build order (#1 before #2) that's
  // not blocked and not done — admin's numbering decides, not the app.
  const upNext = useMemo(() => {
    const open = [...lanes.doing, ...lanes.todo].sort(byBuildOrder)
    for (const o of open) {
      const colId = ownColumnIds.find((id) => {
        if (!writableColumnIds.has(id)) return false
        const c = o.cells[id]
        return c && !c.blocked && stageRank(c.stage) < DONE_RANK
      })
      if (colId != null) return { order: o, colId }
    }
    return null
  }, [lanes, ownColumnIds, writableColumnIds])

  // ── Pace ──
  // The week's work spread over the workdays left: 18 orders and 5 days
  // means 4 today. The first few still open are highlighted amber so
  // the floor knows which ones can't wait until tomorrow.
  const settings = useSettings()
  const pace = useMemo(
    () => weekPace(orders.length, lanes.done.length, currentWeek?.ship_date, settings),
    [orders.length, lanes.done.length, currentWeek?.ship_date, settings]
  )
  const dueTodayIds = useMemo(() => {
    if (!pace) return new Set()
    const open = [...lanes.blocked, ...lanes.doing, ...lanes.todo].sort(byBuildOrder)
    return new Set(open.slice(0, pace.dueToday).map((o) => o.id))
  }, [lanes, pace])

  // ── Sub-departments ──
  // A tablet that covers more than one column is really covering
  // several benches: Panel is roof panels, mod filler panels and
  // acrylic. Without this the only way to tell which of the three is
  // behind is to read every card, because the lanes above mix all
  // three together — an order sits in "To do" if ANY bench still has
  // work on it. One row per bench, so a bench that's dragging is
  // visible from across the shop.
  const subDepts = useMemo(() => {
    if (ownColumnIds.length < 2) return []
    return ownColumnIds
      .map((id) => {
        let total = 0
        let done = 0
        let blocked = 0
        for (const o of orders) {
          const c = o.cells[id]
          if (!c) continue
          total++
          if (c.blocked) blocked++
          else if (stageRank(c.stage) >= DONE_RANK) done++
        }
        return { id, name: columnById[id] ?? `Column ${id}`, total, done, blocked, mine: writableColumnIds.has(id) }
      })
      .filter((s) => s.total > 0)
      // The plant's own column order, every time. Sorting by progress
      // moved the benches around as work finished, so nobody could learn
      // where Acrylic lives; the one furthest behind is marked instead.
      .sort((a, b) => (columnOrder.get(a.id) ?? 1e9) - (columnOrder.get(b.id) ?? 1e9))
  }, [orders, ownColumnIds, columnById, writableColumnIds, columnOrder])
  const laggingBenchId = useMemo(() => {
    const open = subDepts.filter((s) => s.done < s.total)
    if (open.length < 2) return null
    return open.reduce((a, b) => (b.done / b.total < a.done / a.total ? b : a)).id
  }, [subDepts])

  const [showAllDone, setShowAllDone] = useState(false)
  const [toast, setToast] = useState(null) // { message, undo }
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  // Tapping advances immediately — no confirm dialog to slow a gloved
  // hand down — and a mistake is one tap on Undo instead of a hunt
  // through the override menu.
  function tapAdvance(order, colId) {
    const cell = order.cells[colId]
    const next = nextStage(cell.stage)
    if (!next || cell.blocked || !live) return
    const prev = cell.stage
    advanceStage(order.id, colId, prev)
    setToast({
      message: `#${order.buildNo} ${order.tag_name} · ${columnById[colId]} → ${stageLabel(next)}`,
      undo: () => setStage(order.id, colId, prev, next),
    })
  }

  function tapUnblock(order, colId) {
    const { blockedNote: note, blockedCategory: category } = order.cells[colId]
    requestToggleBlocked(order.id, colId, true)
    setToast({ message: `Block cleared on ${order.tag_name}`, undo: () => applyBlocked(order.id, colId, true, note, category) })
  }

  const shipDays = daysUntil(currentWeek?.ship_date)
  // This tablet's own work, so ALL BUILT here means this department
  // is finished for the week — not that the order is ready to ship.
  const headline = weekHeadline(currentWeek?.ship_date, { total: orders.length, done: lanes.done.length })

  return (
    <div className="min-h-full bg-floor text-paper">
      <NotificationBanner />

      {/* ── Header: who this tablet is, and how long until the truck ── */}
      <header className="px-4 sm:px-6 pt-4 pb-2 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-xs">
            <span className={`inline-flex items-center gap-1.5 ${live ? 'text-[#7FD49A]' : 'text-andonRed'}`}>
              <span className={`w-2 h-2 rounded-full ${live ? 'bg-[#4CC46F]' : 'bg-andonRed'}`} />
              {live ? 'Live' : 'Offline — taps won’t save'}
            </span>
            <button onClick={signOut} className="text-floorMute hover:text-paper">
              Sign out
            </button>
            <NotificationBell />
          </div>
          <h1 className="font-display font-extrabold uppercase text-5xl sm:text-6xl leading-[0.9] mt-1 break-words">
            {currentDeptName}
          </h1>
          {unitsToday.length > 0 && <p className="text-sm text-floorMute mt-1 tabular-nums">Built today: <span className="text-paper font-semibold">{unitsText(unitsToday)}</span></p>}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <details className="relative">
              <summary className="list-none cursor-pointer select-none border border-floorLine rounded-full px-3 py-1.5 text-sm font-semibold text-floorMute hover:text-paper">
                Departments · {selectedDeptIds.length}
              </summary>
              <div className="absolute left-0 mt-1 bg-floorCard border border-floorLine rounded-xl p-2 z-20 min-w-[220px] shadow-2xl">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2.5 px-2.5 py-2.5 text-base rounded-lg hover:bg-floor cursor-pointer">
                    <input type="checkbox" className="w-5 h-5 accent-safety" checked={selectedDeptIds.includes(d.id)} onChange={() => toggleDept(d.id)} />
                    {d.name}
                    {d.id === profile?.department_id && <span className="text-floorMute text-sm">(home)</span>}
                  </label>
                ))}
              </div>
            </details>
            <select
              value={selectedWeekId ?? ''}
              onChange={(e) => setSelectedWeekId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="bg-floor border border-floorLine rounded-full px-3 py-1.5 text-sm font-semibold text-floorMute"
              aria-label="Build week"
            >
              <option value="all">All build weeks</option>
              {buildWeeks.map((w) => (
                <option key={w.id} value={w.id}>
                  {weekOptionLabel(w)}
                </option>
              ))}
            </select>
          </div>
          <CountBar departments={departments.filter((d) => profile?.combinedDepartmentIds?.includes(d.id))} live={live} />
        </div>

        {/* When the truck comes and how far along this pickup is sit
            together: they answer the same question. The pace used to be a
            full-width card of its own under the header, and with it the
            first job card on a landscape tablet landed below the fold. */}
        {currentWeek?.ship_date && (
          <div className="sm:text-right sm:min-w-[300px]">
            <div className="text-[11px] tracking-[0.14em] uppercase text-floorMute">This week ships</div>
            <div className={`font-display font-extrabold text-5xl leading-none tabular-nums ${HEADLINE_TONE_CLASS[headline.tone]}`}>
              {headline.text}
            </div>
            <div className="text-sm text-floorMute">
              {shortDate(currentWeek.ship_date)}
              {headline.tone === 'done' && ` · ${relativeDay(shipDays)}`}
              {weekName(currentWeek) && ` · ${weekName(currentWeek)}`}
            </div>
            {!loading && pace && (
              <div className="mt-2.5">
                <div className="flex items-baseline sm:justify-end gap-2 text-sm">
                  <span className="font-display font-extrabold text-xl tabular-nums">
                    <span className="text-[#7FD49A]">{pace.done}</span>
                    <span className="text-floorMute"> / {pace.total}</span>
                  </span>
                  <span className="text-floorMute">ready for pickup</span>
                </div>
                <div className="relative h-2 rounded-full bg-floorLine overflow-hidden mt-1">
                  <i className="block h-full bg-[#4CC46F] transition-[width] duration-500" style={{ width: `${pace.pct}%` }} />
                  {/* where today's share should take it */}
                  <span
                    className="absolute top-0 bottom-0 w-[3px] bg-safety"
                    style={{ left: `${Math.min(100, ((pace.done + pace.dueToday) / pace.total) * 100)}%` }}
                    title="Where today should finish"
                  />
                </div>
                <div className="text-sm mt-1">
                  {pace.left === 0 ? (
                    <span className="text-[#7FD49A] font-bold">All prepped for this pickup</span>
                  ) : (
                    <>
                      <span className="text-safety font-bold">{pace.dueToday} to finish today</span>
                      <span className="text-floorMute">
                        {' '}
                        · {pace.left} left over {pace.days} {pace.days === 1 ? 'day' : 'days'}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </header>

      <main className="px-4 sm:px-6 pb-24">
        {loadError && (
          <div className="mt-3 bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {loadError}</div>
        )}
        {earlier.count > 0 && earlier.weekId != null && (
          <button
            onClick={() => setSelectedWeekId(earlier.weekId)}
            className="mt-3 w-full text-left rounded-lg bg-safety/15 border border-safety px-4 py-3 min-h-[48px] flex items-center justify-between gap-3"
          >
            <span className="text-sm font-semibold text-charcoal">
              {earlier.count} {earlier.count === 1 ? 'order' : 'orders'} from an earlier pickup {earlier.count === 1 ? 'is' : 'are'} still open here
            </span>
            <span className="text-sm font-bold text-charcoal whitespace-nowrap">Show →</span>
          </button>
        )}

        {/* ── Each bench on this tablet ── */}
        {!loading && subDepts.length > 1 && (
          <section className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Each bench on this tablet">
            {subDepts.map((s) => {
              const pct = Math.round((s.done / s.total) * 100)
              const lagging = s.id === laggingBenchId
              return (
                <div
                  key={s.id}
                  title={lagging ? 'Furthest behind on this tablet' : undefined}
                  className={`flex-1 min-w-[150px] rounded-xl border px-3 py-2 ${
                    s.blocked
                      ? 'border-andonRed bg-blockedCard'
                      : pct === 100
                        ? 'border-[#4CC46F] bg-[#16301F]'
                        : lagging
                          ? 'border-safety bg-floorCard'
                          : 'border-floorLine bg-floorCard'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="font-display font-bold uppercase tracking-wide text-sm truncate">
                      {s.name}
                      {!s.mine && <span className="ml-1.5 text-[11px] font-normal normal-case text-floorMute">view only</span>}
                    </div>
                    <div className="font-display font-extrabold tabular-nums whitespace-nowrap">
                      <span className={pct === 100 ? 'text-[#4CC46F]' : 'text-paper'}>{s.done}</span>
                      <span className="text-floorMute"> / {s.total}</span>
                    </div>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-floorLine overflow-hidden mt-1.5">
                    <i className="block h-full bg-[#4CC46F] transition-[width] duration-500" style={{ width: `${pct}%` }} />
                  </div>
                  {s.blocked > 0 && <div className="text-[11px] font-bold text-[#FF8A8A] mt-1">{s.blocked} blocked</div>}
                </div>
              )
            })}
          </section>
        )}

        {/* ── Up next ── */}
        {!loading && (
          <section className="mt-4 rounded-2xl border border-floorLine bg-gradient-to-b from-[#22272D] to-[#1B1F24] p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-center">
            {upNext ? (
              <>
                <div className="min-w-0">
                  <div className="text-[11px] tracking-[0.14em] uppercase font-bold text-safety">
                    Up next{ownColumnIds.length > 1 ? ` · ${columnById[upNext.colId]}` : ''}
                  </div>
                  <div className="font-display font-bold text-4xl leading-none mt-1 break-words">
                    <span className="text-safety">#{upNext.order.buildNo}</span> {upNext.order.tag_name}
                  </div>
                  <div className="text-sm text-floorMute mt-1.5">
                    {upNext.order.dealer}
                    {upNext.order.scheduled_pickup_date && ` · picks up ${shortDate(upNext.order.scheduled_pickup_date)}`}
                  </div>
                </div>
                <BigAction cell={upNext.order.cells[upNext.colId]} disabled={!live} onClick={() => tapAdvance(upNext.order, upNext.colId)} />
              </>
            ) : (
              <div>
                <div className="text-[11px] tracking-[0.14em] uppercase font-bold text-[#7FD49A]">All caught up</div>
                <div className="font-display font-bold text-3xl mt-1">
                  {lanes.blocked.length ? `Only blocked jobs left — ${lanes.blocked.length}` : 'Nothing waiting here'}
                </div>
              </div>
            )}
          </section>
        )}

        {loading && <p className="text-floorMute text-sm mt-6">Loading…</p>}

        {/* ── Lanes ── */}
        {!loading && (
          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
            <Lane title="Blocked" tone="red" items={lanes.blocked} empty="No problems reported" render={renderCard} />
            <Lane title="To do" items={lanes.todo} empty="Nothing waiting" render={renderCard} />
            <Lane title="In progress" items={lanes.doing} empty="Nothing started" render={renderCard} />
            <Lane
              title="Done"
              items={showAllDone ? lanes.done : lanes.done.slice(0, 6)}
              count={lanes.done.length}
              empty="Nothing finished yet"
              render={renderCard}
              more={!showAllDone && lanes.done.length > 6 ? () => setShowAllDone(true) : null}
            />
          </div>
        )}
      </main>

      {toast && (
        <div
          role="status"
          className={`fixed left-1/2 -translate-x-1/2 bottom-5 z-50 rounded-xl shadow-2xl pl-4 pr-2 py-2 flex items-center gap-4 max-w-[calc(100vw-32px)] ${
            toast.error ? 'bg-andonRed text-white' : 'bg-paper text-charcoal'
          }`}
        >
          <span className="text-sm font-medium truncate">{toast.message}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo()
                setToast(null)
              }}
              className="bg-charcoal text-paper font-bold text-sm rounded-lg px-4 py-2"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {sheetOrder && <OrderSheet order={sheetOrder} tone="floor" canEdit={typable} onClose={() => setSheetOrder(null)} />}

      {qualityFor && (
        <QualityIssueModal
          order={qualityFor}
          departments={departmentChoices(departments, deptColumnMap, Object.keys(qualityFor.cells))}
          reporterColumnId={
            departmentChoices(departments, deptColumnMap, Object.keys(qualityFor.cells)).find((d) => d.hasJob && writableColumnIds.has(d.columnId))?.columnId ?? null
          }
          onClose={() => setQualityFor(null)}
          onSaved={(message) => setToast({ message: `${message} — #${qualityFor.buildNo} ${qualityFor.tag_name}` })}
        />
      )}

      {blockTarget && (
        <BlockReasonModal
          onCancel={() => setBlockTarget(null)}
          onConfirm={({ category, note }) => {
            applyBlocked(blockTarget.orderId, blockTarget.columnId, true, note, category)
            setBlockTarget(null)
          }}
        />
      )}
    </div>
  )

  function renderCard(o) {
    const own = ownColumnIds.filter((id) => o.cells[id] != null)
    // One chip per other department, not per column. Panel alone has four
    // columns, so a card used to read PANEL PANEL PANEL — three chips that
    // look identical and could each be a different state. A department is
    // shown at its least-finished job: it's only ✓ when all of it is.
    const others = otherDepartments(o, ownColumnIds, deptByColumnId, columnById)
    const isBlocked = own.some((id) => o.cells[id].blocked)
    const isDone = own.length > 0 && own.every((id) => stageRank(o.cells[id].stage) >= DONE_RANK)
    // Amber = this one is part of today's share; leaving it makes
    // tomorrow worse. Blocked and done cards keep their own colour.
    const isDueToday = !isDone && !isBlocked && dueTodayIds.has(o.id)
    const due = daysUntil(o.scheduled_pickup_date)

    // One headline badge, by what matters most; the rest become small
    // marks so a card never turns into a row of shouting labels.
    const sentBack = o.issues.filter((q) => q.sent_back && own.includes(q.responsible_column_id))
    const moved = wasMovedRecently(o)
    const signals = isDone
      ? []
      : [
          sentBack.length && {
            kind: 'warn',
            text: `↩ Sent back${sentBack[0].reporter_column_id ? ` by ${columnById[sentBack[0].reporter_column_id]}` : ''}: ${defectLabel[sentBack[0].defect_type] ?? sentBack[0].defect_type}`,
            short: '↩ sent back',
          },
          isDueToday && { kind: 'warn', text: 'Do today', short: 'do today' },
          moved && {
            kind: o.moved_direction === 'up' ? 'info' : 'neutral',
            text: o.moved_direction === 'up' ? '↑ Moved up by admin' : '↓ Moved down by admin',
            short: o.moved_direction === 'up' ? '↑ moved up' : '↓ moved down',
          },
          o.missingCounts?.length && {
            kind: 'outline',
            text: `No ${o.missingCounts.map((b) => COUNT_WORDS[b] ?? b).join(' / ')} count — ${
              o.missingCounts.every((b) => typable.includes(b)) ? 'tap Details to enter it' : 'tell the office'
            }`,
            short: `no ${o.missingCounts.map((b) => COUNT_WORDS[b] ?? b).join('/')} count`,
          },
        ].filter(Boolean)
    const badge = signals[0]
    const marks = signals.slice(1).map((x) => x.short)

    return (
      <article
        key={o.id}
        className={`rounded-xl border p-3 grid gap-2.5 ${
          isBlocked
            ? 'bg-blockedCard border-andonRed'
            : isDone
              ? 'bg-[#16301F] border-[#4CC46F]'
              : isDueToday
                ? 'bg-[#2E2510] border-safety'
                : 'bg-floorCard border-floorLine'
        }`}
      >
        <div className="flex justify-between gap-2 items-start">
          <button onClick={() => setSheetOrder(o)} className="min-w-0 text-left" aria-label={`Open ${o.tag_name}`}>
            <div className={`font-display font-bold text-xl leading-tight break-words ${isDone ? 'text-[#B7ECC5]' : ''}`}>
              <span className={isDone ? 'text-[#4CC46F]' : 'text-safety'}>#{o.buildNo}</span> {o.tag_name}
            </div>
            <div className={`text-xs mt-0.5 ${isDone ? 'text-[#7FD49A]' : 'text-floorMute'}`}>
              {o.dealer}
              {o.mods_count ? (
                <>
                  {' · '}
                  <span className="font-semibold text-paper tabular-nums">{o.mods_count} mods</span>
                  {o.walls_count ? ` over ${o.walls_count} walls` : ''}
                </>
              ) : null}
            </div>
          </button>
          {due != null && (
            <span
              className={`font-display font-bold text-sm rounded-md px-2 py-0.5 whitespace-nowrap tabular-nums ${
                due < 0 ? 'bg-andonRed text-white' : due <= 3 ? 'bg-safety text-charcoal' : 'bg-floorLine text-paper'
              }`}
              title={`Pickup ${shortDate(o.scheduled_pickup_date)}`}
            >
              {due < 0 ? 'LATE' : due === 0 ? 'TODAY' : `${due}D`}
            </span>
          )}
        </div>

        {(badge || marks.length > 0) && (
          <div className="flex items-center gap-2 flex-wrap -mt-1">
            {badge && <Chip tone="floor" kind={badge.kind} className="uppercase tracking-wide whitespace-normal">{badge.text}</Chip>}
            {marks.map((m) => (
              <span key={m} className="text-[12px] text-floorMute">{m}</span>
            ))}
          </div>
        )}

        {own.map((id, i) => {
          const cell = o.cells[id]
          const rank = stageRank(cell.stage)
          const next = nextStage(cell.stage)
          return (
            <div key={id} className={`grid gap-2 ${i > 0 ? 'border-t border-floorLine pt-2.5' : ''}`}>
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  {own.length > 1 && <span className="font-bold truncate">{columnById[id]}</span>}
                  <span className={cell.blocked ? 'text-[#FF9A9A] font-semibold' : rank >= DONE_RANK ? 'text-[#7FD49A]' : 'text-floorMute'}>
                    {cell.blocked ? 'Blocked' : stageLabel(cell.stage)}
                  </span>
                </div>
                <StageSteps rank={rank} blocked={cell.blocked} />
              </div>
              {cell.blocked && (
                <p className="rounded-lg bg-andonRed/15 px-2.5 py-1.5 text-sm leading-snug text-[#FFB3B3]">{blockText(cell)}</p>
              )}
              {!writableColumnIds.has(id) ? (
                <span className="justify-self-start text-xs text-floorMute border border-floorLine rounded-md px-2 py-1" title="This tablet can see this department but not change it">
                  View only
                </span>
              ) : (
                (cell.blocked || next) && (
                  <div className="flex items-stretch gap-1.5">
                    {cell.blocked ? (
                      <button onClick={() => tapUnblock(o, id)} disabled={!live} className="flex-1 min-h-[48px] rounded-xl border border-floorLine text-paper text-base font-semibold disabled:opacity-40">
                        Clear block
                      </button>
                    ) : (
                      <button
                        onClick={() => tapAdvance(o, id)}
                        disabled={!live}
                        className={`flex-1 min-h-[48px] rounded-xl text-charcoal text-lg font-display font-extrabold uppercase tracking-wide active:scale-[0.98] transition-transform disabled:opacity-40 ${
                          rank === 1 ? 'bg-[#4CC46F]' : 'bg-safety'
                        }`}
                      >
                        {STAGE_VERB[next]}
                      </button>
                    )}
                    {!cell.blocked && (
                      <button
                        onClick={() => requestToggleBlocked(o.id, id, false)}
                        disabled={!live}
                        aria-label={`Report a problem with ${columnById[id]}`}
                        title="Report a problem"
                        className="w-12 rounded-xl border border-floorLine text-floorMute text-lg disabled:opacity-40"
                      >
                        ⚠
                      </button>
                    )}
                    {/* Coordinators can still jump straight to any stage. */}
                    <span className="relative w-10 grid place-items-center rounded-xl border border-floorLine text-floorMute text-lg">
                      ⋮
                      <select
                        value={cell.stage ?? ''}
                        onChange={(e) => setStage(o.id, id, e.target.value, cell.stage)}
                        disabled={!live}
                        aria-label={`Set any stage for ${columnById[id]}`}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      >
                        <option value="">Not started</option>
                        {WORKFLOW_STAGES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
                )
              )}
            </div>
          )
        })}

        <div className="flex justify-between items-center gap-2">
          <div className="flex flex-wrap gap-1" aria-label="Other departments on this order">
            {others.map(({ name, rank, blocked, jobs, doneJobs }) => {
              const done = rank >= DONE_RANK
              return (
                <span
                  key={name}
                  title={`${name}: ${blocked ? 'Blocked' : stageLabel(rank === 1 ? 'started' : done ? 'completed' : null)}${jobs > 1 ? ` (${doneJobs} of ${jobs} done)` : ''}`}
                  className={`rounded px-1.5 py-[1px] text-[11px] font-semibold uppercase tracking-wide leading-tight border ${
                    blocked
                      ? 'bg-andonRed/20 border-andonRed text-[#FF8A8A]'
                      : done
                        ? 'bg-[#16301F] border-[#4CC46F] text-[#7FD49A]'
                        : rank > 0
                          ? 'bg-[#16263A] border-[#5B9BD5] text-[#9CC7EE]'
                          : 'border-[#343A41] text-[#6B747E]'
                  }`}
                >
                  {done ? '✓ ' : blocked ? '⚑ ' : ''}
                  {shortDept(name)}
                </span>
              )
            })}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setQualityFor(o)}
              disabled={!live}
              className={`text-xs py-1 disabled:opacity-40 ${o.issues.length ? 'text-safety font-bold' : 'text-floorMute hover:text-paper'}`}
            >
              ⚑ {o.issues.length ? `${o.issues.length} quality issue${o.issues.length > 1 ? 's' : ''}` : 'Quality'}
            </button>
            <button onClick={() => setSheetOrder(o)} className="text-xs text-floorMute hover:text-paper py-2">
              📎 Details
            </button>
          </div>
        </div>
      </article>
    )
  }
}

/* ── Pieces ── */

const STAGE_VERB = {
  started: 'Start',
  completed: 'Done',
}

/**
 * The departments other than this tablet's on an order, one entry each,
 * at the state of their least-finished job. A column with no department
 * (Glass, Rail — tracked but not yet anyone's tablet) keeps its own name.
 */
function otherDepartments(order, ownColumnIds, deptByColumnId, columnById) {
  const byName = new Map()
  for (const id of Object.keys(order.cells).map(Number)) {
    if (ownColumnIds.includes(id)) continue
    const c = order.cells[id]
    const name = deptByColumnId[id] ?? columnById[id] ?? `Column ${id}`
    const rank = stageRank(c.stage)
    const prev = byName.get(name)
    if (!prev) byName.set(name, { name, rank, blocked: !!c.blocked, jobs: 1, doneJobs: rank >= DONE_RANK ? 1 : 0 })
    else {
      prev.rank = Math.min(prev.rank, rank)
      prev.blocked ||= !!c.blocked
      prev.jobs++
      if (rank >= DONE_RANK) prev.doneJobs++
    }
  }
  return [...byName.values()]
}

// Other departments on the card are named, not just coloured — a colour
// alone doesn't tell the floor WHICH department is done. Long names are
// shortened to initials so the chips still fit two or three to a row.
function shortDept(name) {
  const n = String(name ?? '').trim()
  if (n.length <= 6) return n.toUpperCase()
  const words = n.split(/[\s/&-]+/).filter(Boolean)
  if (words.length > 1) return words.map((w) => w[0]).join('').toUpperCase()
  return n.slice(0, 6).toUpperCase()
}

function BigAction({ cell, disabled, onClick }) {
  const next = nextStage(cell.stage)
  const rank = stageRank(cell.stage)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-2xl text-charcoal font-display font-extrabold uppercase tracking-wide text-3xl px-8 py-4 min-w-[200px] active:scale-[0.97] transition-transform disabled:opacity-40 ${
        rank === 1 ? 'bg-[#4CC46F]' : 'bg-safety'
      }`}
    >
      {STAGE_VERB[next]}
      <span className="block font-body normal-case tracking-normal text-xs font-semibold opacity-70">
        {next === 'started' ? 'Tap when you begin' : 'Tap when it’s finished'}
      </span>
    </button>
  )
}

function StageSteps({ rank, blocked }) {
  const on = blocked ? 'bg-[#FF6B6B]' : rank >= DONE_RANK ? 'bg-[#4CC46F]' : 'bg-safety'
  return (
    <div className="grid grid-cols-5 gap-[3px] mt-1.5" aria-hidden="true">
      {WORKFLOW_STAGES.map((s, i) => (
        <i key={s.id} className={`h-[5px] rounded-sm ${i < rank ? on : 'bg-[#343A41]'}`} />
      ))}
    </div>
  )
}

function Lane({ title, tone, items, count, empty, render, more }) {
  return (
    <section>
      <h2
        className={`font-display font-bold uppercase tracking-wider text-lg mb-2 flex justify-between items-center ${
          tone === 'red' ? 'text-[#FF8A8A]' : 'text-floorMute'
        }`}
      >
        {title}
        <span className={`text-paper rounded-full px-2.5 text-base tabular-nums ${tone === 'red' && items.length ? 'bg-andonRed' : 'bg-floorLine'}`}>
          {count ?? items.length}
        </span>
      </h2>
      <div className="grid gap-2.5">
        {items.length ? items.map(render) : <div className="border border-dashed border-floorLine rounded-xl p-4 text-sm text-[#59616C] text-center">{empty}</div>}
        {more && (
          <button onClick={more} className="text-sm text-floorMute hover:text-paper py-2">
            Show all {count}
          </button>
        )}
      </div>
    </section>
  )
}

function laneOf(order, ownColumnIds) {
  const cells = ownColumnIds.map((id) => order.cells[id]).filter(Boolean)
  if (cells.some((c) => c.blocked)) return 'blocked'
  const worst = Math.min(...cells.map((c) => stageRank(c.stage)))
  if (worst >= DONE_RANK) return 'done'
  if (worst === 1) return 'doing'
  return 'todo'
}
