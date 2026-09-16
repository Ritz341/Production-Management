import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { WORKFLOW_STAGES, workflowStageById, BLOCKED_CHIP_CLASS, BLOCKED_DOT_CLASS } from '../lib/statusColors'
import { nearestBuildWeekId, weekOptionLabel } from '../lib/dates'
import { useConnection } from '../lib/ConnectionContext.jsx'
import FileModal from '../components/FileModal.jsx'
import NotificationBanner from '../components/NotificationBanner.jsx'
import BlockReasonModal from '../components/BlockReasonModal.jsx'

// Which stage comes next (index-based advancement)
const STAGE_IDS = WORKFLOW_STAGES.map((s) => s.id)
function nextStage(current) {
  if (!current) return STAGE_IDS[0] // null -> first stage
  const idx = STAGE_IDS.indexOf(current)
  if (idx < 0 || idx >= STAGE_IDS.length - 1) return null // already at end
  return STAGE_IDS[idx + 1]
}

// Summary progress: how many of this order's departments are at each bucket
function orderProgress(cells, allColumnIds) {
  const relevant = allColumnIds.filter((id) => cells[id] != null)
  if (relevant.length === 0) return null
  let done = 0
  let active = 0
  for (const id of relevant) {
    const s = cells[id]?.stage
    if (s === 'completed' || s === 'packaged' || s === 'shipped') done++
    else if (s === 'started') active++
  }
  return { total: relevant.length, done, active, waiting: relevant.length - done - active }
}

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
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [stageFilter, setStageFilter] = useState('active') // 'active' | 'all' | specific stageId

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
      let orderQuery = supabase.from('bt_orders').select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date')
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
        .select('order_id, status_value, status_column_id, workflow_stage, is_visible, blocked_at, blocked_note')
        .in('order_id', orderIds)
        .eq('is_visible', true)
      // A failed query here (e.g. a schema migration not yet run against
      // this database) used to fail silently and just render an empty
      // queue — say so instead.
      if (statusErr && active) setLoadError(`Couldn't load statuses: ${statusErr.message}`)
      if (!statusErr && !ordersErr && active) setLoadError('')

      if (!active) return

      const ordersById = new Map((orderRows ?? []).map((o) => [o.id, { ...o, cells: {} }]))
      for (const row of statusRows ?? []) {
        const o = ordersById.get(row.order_id)
        if (!o) continue
        o.cells[row.status_column_id] = {
          value: row.status_value,
          stage: row.workflow_stage,
          blocked: !!row.blocked_at,
          blockedNote: row.blocked_note,
        }
      }
      // Only orders that have at least one of this department's columns
      const relevant = Array.from(ordersById.values()).filter((o) =>
        ownColumnIds.some((id) => o.cells[id] != null)
      )
      // Sort: unfinished first (by pickup date), then completed
      relevant.sort((a, b) => {
        const aStage = worstOwnStage(a, ownColumnIds)
        const bStage = worstOwnStage(b, ownColumnIds)
        const aRank = stageRank(aStage)
        const bRank = stageRank(bStage)
        if (aRank !== bRank) return aRank - bRank
        const aDate = a.scheduled_pickup_date || 'zz'
        const bDate = b.scheduled_pickup_date || 'zz'
        return aDate.localeCompare(bDate) || a.tag_name.localeCompare(b.tag_name)
      })
      setOrders(relevant)
      setLoading(false)
    }

    load()

    const channel = supabase
      .channel(`dept-${selectedDeptIds.join('-')}-${selectedWeekId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      // Order edits (dealer, pickup date, moved to another week) too.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
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
    const { error } = await supabase
      .from('bt_order_status')
      .update({ workflow_stage: next })
      .eq('order_id', orderId)
      .eq('status_column_id', columnId)
    if (error) patchCell(orderId, columnId, { stage: currentStage }) // roll back
  }

  // Set a specific stage (for the dropdown override)
  async function setStage(orderId, columnId, stageId, currentStage) {
    if (!live) return
    patchCell(orderId, columnId, { stage: stageId || null }) // optimistic
    const { error } = await supabase
      .from('bt_order_status')
      .update({ workflow_stage: stageId || null })
      .eq('order_id', orderId)
      .eq('status_column_id', columnId)
    if (error) patchCell(orderId, columnId, { stage: currentStage }) // roll back
  }

  // Blocked is a flag layered on top of whatever stage a cell is
  // already at (e.g. Order Started but waiting on a part) — not part
  // of the linear stage sequence, so it's tracked separately.
  // Unblocking needs no reason; blocking opens the reason picker below.
  function requestToggleBlocked(orderId, columnId, currentlyBlocked) {
    if (!live) return
    if (currentlyBlocked) applyBlocked(orderId, columnId, false, null)
    else setBlockTarget({ orderId, columnId })
  }

  async function applyBlocked(orderId, columnId, blocked, note) {
    const prevCell = orders.find((o) => o.id === orderId)?.cells[columnId]
    patchCell(orderId, columnId, { blocked, blockedNote: note }) // optimistic
    const { error } = await supabase
      .from('bt_order_status')
      .update({ blocked_at: blocked ? new Date().toISOString() : null, blocked_note: blocked ? note : null })
      .eq('order_id', orderId)
      .eq('status_column_id', columnId)
    if (error && prevCell) patchCell(orderId, columnId, { blocked: prevCell.blocked, blockedNote: prevCell.blockedNote }) // roll back
  }

  const currentDeptName = useMemo(
    () => departments.filter((d) => selectedDeptIds.includes(d.id)).map((d) => d.name).join(' + ') || 'Loading…',
    [departments, selectedDeptIds]
  )

  function toggleDept(id) {
    setSelectedDeptIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const currentWeek = useMemo(() => buildWeeks.find((w) => w.id === selectedWeekId), [buildWeeks, selectedWeekId])
  const columnById = useMemo(() => Object.fromEntries(allColumns.map((c) => [c.id, c.name])), [allColumns])
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns])

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

  // Filter orders by stage
  const filtered = useMemo(() => {
    if (stageFilter === 'all') return orders
    if (stageFilter === 'active') {
      return orders.filter((o) => {
        const worst = worstOwnStage(o, ownColumnIds)
        return worst !== 'shipped' && worst !== 'completed' && worst !== 'packaged'
      })
    }
    // specific stage
    return orders.filter((o) => {
      return ownColumnIds.some((id) => (o.cells[id]?.stage ?? null) === (stageFilter === 'none' ? null : stageFilter))
    })
  }, [orders, stageFilter, ownColumnIds])

  // Counts per stage for the filter bar
  const stageCounts = useMemo(() => {
    const counts = { none: 0 }
    for (const s of STAGE_IDS) counts[s] = 0
    for (const o of orders) {
      const worst = worstOwnStage(o, ownColumnIds)
      if (worst === null) counts.none++
      else counts[worst] = (counts[worst] ?? 0) + 1
    }
    return counts
  }, [orders, ownColumnIds])

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />

      {/* ── Header ── */}
      <header className="bg-charcoal px-5 py-5 border-b-4 border-safety">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-paper leading-none break-words">{currentDeptName}</h1>
            <p className="text-sm sm:text-base text-steelLight mt-1.5">{filtered.length} of {orders.length} orders</p>
          </div>
          <div className="flex items-center gap-3">
            <details className="relative">
              <summary className="bg-steel text-paper border border-steelLight rounded-lg px-4 py-2.5 text-base font-semibold cursor-pointer select-none list-none">
                Departments ({selectedDeptIds.length})
              </summary>
              <div className="absolute right-0 mt-1 bg-steel border border-steelLight rounded-lg p-2 z-10 min-w-[200px] shadow-lg">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2.5 px-2.5 py-2.5 text-base text-paper hover:bg-charcoal rounded cursor-pointer">
                    <input type="checkbox" className="w-5 h-5" checked={selectedDeptIds.includes(d.id)} onChange={() => toggleDept(d.id)} />
                    {d.name}
                    {d.id === profile?.department_id ? <span className="text-steelLight text-sm">(home)</span> : null}
                  </label>
                ))}
              </div>
            </details>
            <button onClick={signOut} className="text-base text-steelLight px-2 py-2.5 hover:text-paper">
              Sign out
            </button>
          </div>
        </div>

        {/* Build week selector + ship date badge */}
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <select
            value={selectedWeekId ?? ''}
            onChange={(e) => setSelectedWeekId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="bg-charcoal text-safety border border-safety/40 rounded-lg px-3 py-2.5 text-base font-semibold"
          >
            <option value="all">All build weeks</option>
            {buildWeeks.map((w) => (
              <option key={w.id} value={w.id}>
                {weekOptionLabel(w)}
              </option>
            ))}
          </select>
          {currentWeek?.ship_date && (
            <span className="bg-safety text-charcoal font-display font-bold px-4 py-2 rounded-lg text-base tracking-wide">
              SHIPS {new Date(currentWeek.ship_date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>

        {/* ── Stage filter tabs ── */}
        <div className="mt-4 flex items-center gap-1.5 overflow-x-auto pb-1">
          <FilterTab label="Active" count={null} active={stageFilter === 'active'} onClick={() => setStageFilter('active')} />
          <FilterTab label="All" count={orders.length} active={stageFilter === 'all'} onClick={() => setStageFilter('all')} />
          <span className="w-px h-6 bg-steelLight/30 mx-1" />
          {WORKFLOW_STAGES.map((s) => (
            <FilterTab key={s.id} label={s.label} count={stageCounts[s.id]} active={stageFilter === s.id} onClick={() => setStageFilter(s.id)} />
          ))}
          <FilterTab label="Not Set" count={stageCounts.none} active={stageFilter === 'none'} onClick={() => setStageFilter('none')} />
        </div>
      </header>

      {/* ── Order cards ── */}
      <main className="p-4 space-y-3 max-w-3xl mx-auto">
        {loadError && (
          <div className="bg-andonRedBg border border-andonRed text-andonRed text-sm px-4 py-3 rounded">⚠ {loadError}</div>
        )}
        {loading && <p className="text-steelLight text-sm">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <div className="bg-white border border-paperDim rounded p-8 text-center">
            <p className="text-steelLight">No orders match this filter.</p>
          </div>
        )}
        {filtered.map((o) => {
          const ownEntries = ownColumnIds.filter((id) => o.cells[id] != null)
          const otherEntries = Object.keys(o.cells).map(Number).filter((id) => !ownColumnIds.includes(id))
          const progress = orderProgress(o.cells, allColumnIds)
          const pickupDate = o.scheduled_pickup_date
            ? new Date(o.scheduled_pickup_date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : null

          return (
            <div key={o.id} className="bg-white shadow-sm rounded-lg overflow-hidden">
              {/* Card header: tag, dealer, ship date, progress */}
              <div className="px-4 pt-4 pb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-display text-2xl font-bold text-charcoal tracking-wide block truncate">{o.tag_name}</span>
                  <span className="text-sm text-steelLight">{o.dealer}</span>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {pickupDate && (
                    <span className="bg-safety text-charcoal px-2 py-0.5 rounded text-xs font-display font-bold">
                      PICKUP {pickupDate}
                    </span>
                  )}
                  {progress && (
                    <span className="text-xs text-steelLight">
                      {progress.done}/{progress.total} depts done
                    </span>
                  )}
                </div>
              </div>

              {/* Overall progress bar */}
              {progress && progress.total > 1 && (
                <div className="mx-4 mb-2 h-1.5 bg-paperDim rounded-full overflow-hidden flex">
                  <div className="bg-andonGreen h-full transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                  <div className="bg-safety h-full transition-all" style={{ width: `${(progress.active / progress.total) * 100}%` }} />
                </div>
              )}

              {/* ── This department's columns — actionable ── */}
              <div className="px-4 pb-2 space-y-2">
                {ownEntries.map((id) => {
                  const cell = o.cells[id]
                  const stageInfo = cell.stage ? workflowStageById[cell.stage] : null
                  const next = nextStage(cell.stage)
                  const nextInfo = next ? workflowStageById[next] : null
                  // Blocked overrides the stage color — it's more
                  // urgent information than whatever stage it's stuck at.
                  const chipClass = cell.blocked ? BLOCKED_CHIP_CLASS : stageInfo ? stageInfo.chipClass : 'bg-paperDim text-steelLight'
                  const dotClass = cell.blocked ? BLOCKED_DOT_CLASS : stageInfo ? stageInfo.dotClass : 'bg-steelLight'
                  return (
                    <div key={id} className={`rounded-lg px-3 py-2.5 ${chipClass}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`} />
                          <span className="font-semibold text-sm">{columnById[id]}</span>
                          <span className="text-xs opacity-75">
                            {cell.blocked ? `🚫 Blocked${cell.blockedNote ? ` — ${cell.blockedNote}` : ''}` : stageInfo?.label ?? 'Not set'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {/* Quick-advance button — hidden while blocked so
                              nobody advances past a known problem by accident */}
                          {nextInfo && !cell.blocked && (
                            <button
                              onClick={() => advanceStage(o.id, id, cell.stage)}
                              className="bg-charcoal text-paper text-xs font-bold px-3 py-1.5 rounded whitespace-nowrap active:scale-95 transition-transform"
                            >
                              → {nextInfo.label}
                            </button>
                          )}
                          {!nextInfo && cell.stage === 'shipped' && !cell.blocked && (
                            <span className="text-xs font-bold">✓ Done</span>
                          )}
                          <button
                            onClick={() => requestToggleBlocked(o.id, id, cell.blocked)}
                            title={cell.blocked ? 'Unblock' : 'Report blocked / material shortage'}
                            className={`text-xs font-bold px-2 py-1.5 rounded whitespace-nowrap ${cell.blocked ? 'bg-andonRed text-paper' : 'bg-black/10 hover:bg-black/20'}`}
                          >
                            🚫
                          </button>
                          {/* Override dropdown for coordinators */}
                          <select
                            value={cell.stage ?? ''}
                            onChange={(e) => setStage(o.id, id, e.target.value, cell.stage)}
                            className="bg-transparent text-xs opacity-50 hover:opacity-100 w-5 cursor-pointer appearance-none"
                            title="Override stage"
                            style={{ backgroundImage: 'none' }}
                          >
                            <option value="">⋮</option>
                            {WORKFLOW_STAGES.map((s) => (
                              <option key={s.id} value={s.id}>{s.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* ── Cross-department strip (read-only) ── */}
              {otherEntries.length > 0 && (
                <div className="mx-4 mb-3 pt-2 border-t border-paperDim">
                  <p className="text-xs text-steelLight font-medium mb-1.5">Other departments</p>
                  <div className="flex flex-wrap gap-1.5">
                    {otherEntries.map((id) => {
                      const cell = o.cells[id]
                      const si = cell.stage ? workflowStageById[cell.stage] : null
                      const label = deptByColumnId[id] ?? columnById[id]
                      const chip = cell.blocked ? BLOCKED_CHIP_CLASS : si ? si.chipClass : 'bg-paperDim text-steelLight'
                      const dot = cell.blocked ? BLOCKED_DOT_CLASS : si ? si.dotClass : 'bg-steelLight'
                      return (
                        <span key={id} className={`px-2 py-1 rounded text-xs font-semibold flex items-center gap-1 ${chip}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                          {cell.blocked ? `${label} 🚫` : label}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Files link */}
              <div className="px-4 pb-3">
                <button onClick={() => setOpenOrder(o)} className="text-xs text-andonBlue font-medium">
                  View files
                </button>
              </div>
            </div>
          )
        })}
      </main>

      {openOrder && <FileModal order={openOrder} onClose={() => setOpenOrder(null)} />}

      {blockTarget && (
        <BlockReasonModal
          onCancel={() => setBlockTarget(null)}
          onConfirm={(reason) => {
            applyBlocked(blockTarget.orderId, blockTarget.columnId, true, reason)
            setBlockTarget(null)
          }}
        />
      )}
    </div>
  )
}

/* ── Helpers ── */

function FilterTab({ label, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
        active ? 'bg-safety text-charcoal' : 'text-steelLight hover:text-paper hover:bg-steel/50'
      }`}
    >
      {label}
      {count != null && <span className="ml-1.5 opacity-70">{count}</span>}
    </button>
  )
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

function stageRank(stageId) {
  if (!stageId) return 0
  const idx = STAGE_IDS.indexOf(stageId)
  return idx < 0 ? 0 : idx + 1
}
