import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { WORKFLOW_STAGES } from '../lib/statusColors'
import { blockText, defectLabel } from '../lib/catalog'
import { nearestBuildWeekId, weekOptionLabel } from '../lib/dates'
import { DONE_RANK, buildNumbers, byBuildOrder, daysUntil, nextStageId as nextStage, relativeDay, shortDate, stageLabel, stageRank, wasMovedRecently } from '../lib/schedule'
import { useConnection } from '../lib/ConnectionContext.jsx'
import FileModal from '../components/FileModal.jsx'
import NotificationBanner from '../components/NotificationBanner.jsx'
import BlockReasonModal from '../components/BlockReasonModal.jsx'
import QualityIssueModal, { departmentChoices } from '../components/QualityIssueModal.jsx'
import CountBar from '../components/CountBar.jsx'

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
  const [orders, setOrders] = useState([])
  const [openOrder, setOpenOrder] = useState(null)
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
    const channel = supabase
      .channel('dept-build-weeks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, () => loadWeeks(false))
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

  // Load orders + statuses (including workflow_stage)
  useEffect(() => {
    if (selectedDeptIds.length === 0 || selectedWeekId == null || ownColumnIds.length === 0) return
    let active = true
    setLoading(true)

    async function load() {
      let orderQuery = supabase.from('bt_orders').select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date, sequence, moved_at, moved_direction, bt_build_weeks(ship_date)')
        .eq('status', 'active')
      if (selectedWeekId !== 'all') orderQuery = orderQuery.eq('build_week_id', selectedWeekId)
      const { data: orderRows, error: ordersErr } = await orderQuery
      if (ordersErr && active) setLoadError(`Couldn't load orders: ${ordersErr.message}`)
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
      if (statusErr && active) setLoadError(`Couldn't load statuses: ${statusErr.message}`)
      if (!statusErr && !ordersErr && active) setLoadError('')

      const { data: issueRows } = await supabase
        .from('bt_quality_issues')
        .select('id, order_id, responsible_column_id, reporter_column_id, defect_type, sent_back, created_at')
        .in('order_id', orderIds)
        .is('resolved_at', null)

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

  function toggleDept(id) {
    setSelectedDeptIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const currentWeek = useMemo(() => buildWeeks.find((w) => w.id === selectedWeekId), [buildWeeks, selectedWeekId])
  const columnById = useMemo(() => Object.fromEntries(allColumns.map((c) => [c.id, c.name])), [allColumns])

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
          </div>
          <h1 className="font-display font-extrabold uppercase text-5xl sm:text-6xl leading-[0.9] mt-1 break-words">
            {currentDeptName}
          </h1>
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

        {currentWeek?.ship_date && (
          <div className="sm:text-right">
            <div className="text-[11px] tracking-[0.14em] uppercase text-floorMute">This week ships</div>
            <div className={`font-display font-extrabold text-5xl leading-none tabular-nums ${shipDays <= 2 ? 'text-[#FF6B6B]' : 'text-safety'}`}>
              {relativeDay(shipDays).toUpperCase()}
            </div>
            <div className="text-sm text-floorMute">
              {shortDate(currentWeek.ship_date)} · {currentWeek.label}
            </div>
          </div>
        )}
      </header>

      <main className="px-4 sm:px-6 pb-24">
        {loadError && (
          <div className="mt-3 bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {loadError}</div>
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

      {openOrder && <FileModal order={openOrder} onClose={() => setOpenOrder(null)} />}

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
    const others = Object.keys(o.cells).map(Number).filter((id) => !ownColumnIds.includes(id))
    const isBlocked = own.some((id) => o.cells[id].blocked)
    const due = daysUntil(o.scheduled_pickup_date)

    return (
      <article key={o.id} className={`rounded-xl border p-3 grid gap-2.5 ${isBlocked ? 'bg-blockedCard border-andonRed' : 'bg-floorCard border-floorLine'}`}>
        <div className="flex justify-between gap-2 items-start">
          <div className="min-w-0">
            <div className="font-display font-bold text-xl leading-tight break-words">
              <span className="text-safety">#{o.buildNo}</span> {o.tag_name}
            </div>
            <div className="text-xs text-floorMute mt-0.5">{o.dealer}</div>
            {wasMovedRecently(o) && (
              <div className={`inline-block mt-1.5 rounded-md px-2 py-0.5 text-xs font-bold ${o.moved_direction === 'up' ? 'bg-[#5B9BD5] text-charcoal' : 'bg-floorLine text-paper'}`}>
                {o.moved_direction === 'up' ? '↑ Moved up' : '↓ Moved down'} by admin
              </div>
            )}
          </div>
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

        {own.map((id, i) => {
          const cell = o.cells[id]
          const rank = stageRank(cell.stage)
          const next = nextStage(cell.stage)
          return (
            <div key={id} className={`grid grid-cols-[1fr_auto] gap-2 items-center ${i > 0 ? 'border-t border-floorLine pt-2.5' : ''}`}>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 text-sm">
                  {own.length > 1 && <span className="font-bold">{columnById[id]}</span>}
                  <span className={cell.blocked ? 'text-[#FF9A9A]' : 'text-floorMute'}>
                    {cell.blocked ? `Blocked — ${blockText(cell)}` : stageLabel(cell.stage)}
                  </span>
                </div>
                <StageSteps rank={rank} blocked={cell.blocked} />
                {o.issues
                  .filter((q) => q.sent_back && q.responsible_column_id === id)
                  .map((q) => (
                    <div key={q.id} className="mt-1.5 inline-block rounded-md bg-safety text-charcoal text-xs font-bold px-2 py-0.5">
                      ↩ Sent back{q.reporter_column_id ? ` by ${columnById[q.reporter_column_id]}` : ''}: {defectLabel[q.defect_type] ?? q.defect_type}
                    </div>
                  ))}
              </div>
              {!writableColumnIds.has(id) ? (
                <span className="text-xs text-floorMute border border-floorLine rounded-md px-2 py-1" title="This tablet can see this department but not change it">
                  View only
                </span>
              ) : (
              <div className="flex items-center gap-1.5">
                {cell.blocked ? (
                  <button onClick={() => tapUnblock(o, id)} disabled={!live} className="rounded-lg border border-floorLine text-floorMute text-sm font-semibold px-3 py-2.5 disabled:opacity-40">
                    Clear block
                  </button>
                ) : next ? (
                  <button
                    onClick={() => tapAdvance(o, id)}
                    disabled={!live}
                    className={`rounded-lg text-charcoal text-sm font-bold px-4 py-2.5 active:scale-95 transition-transform disabled:opacity-40 ${
                      rank === 1 ? 'bg-[#4CC46F]' : 'bg-safety'
                    }`}
                  >
                    {STAGE_VERB[next]}
                  </button>
                ) : (
                  <span className="text-sm font-bold text-[#7FD49A] px-1">✓ Done</span>
                )}
                {!cell.blocked && next && (
                  <button
                    onClick={() => requestToggleBlocked(o.id, id, false)}
                    disabled={!live}
                    aria-label={`Report a problem with ${columnById[id]}`}
                    title="Report a problem"
                    className="rounded-lg border border-floorLine text-floorMute px-2.5 py-2.5 text-sm disabled:opacity-40"
                  >
                    ⚠
                  </button>
                )}
                {/* Coordinators can still jump straight to any stage. The
                    select sits invisibly over the ⋮ so the icon, not the
                    current stage's name, is what shows. */}
                <span className="relative w-6 text-center text-floorMute text-lg leading-none">
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
              )}
            </div>
          )
        })}

        <div className="flex justify-between items-center gap-2">
          <div className="flex flex-wrap gap-1" aria-label="Other departments on this order">
            {others.map((id) => {
              const c = o.cells[id]
              return (
                <span
                  key={id}
                  title={`${deptByColumnId[id] ?? columnById[id]}: ${c.blocked ? 'Blocked' : stageLabel(c.stage)}`}
                  className={`w-2.5 h-2.5 rounded-sm ${c.blocked ? 'bg-andonRed' : STAGE_SWATCH[stageRank(c.stage)]}`}
                />
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
            <button onClick={() => setOpenOrder(o)} className="text-xs text-floorMute hover:text-paper py-1">
              📎 Files
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

// Other departments' dots, by rank: not started / started / done.
const STAGE_SWATCH = ['bg-[#3A4047]', 'bg-[#5B9BD5]', 'bg-[#4CC46F]']

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

// The "worst" (earliest) stage across this department's columns for an order
function worstOwnStage(order, ownColumnIds) {
  let worst = null
  for (const id of ownColumnIds) {
    const cell = order.cells[id]
    if (!cell) continue
    const s = cell.stage
    const rank = stageRank(s)
    if (worst === null || rank < stageRank(worst)) worst = s
  }
  return worst
}
