import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { byShipDate, nearestBuildWeekId, weekOptionLabel } from '../lib/dates'
import { WORKFLOW_STAGES, workflowStageById, BLOCKED_CHIP_CLASS } from '../lib/statusColors'
import { useConnection } from '../lib/ConnectionContext.jsx'
import FileModal from '../components/FileModal.jsx'
import NotificationBanner from '../components/NotificationBanner.jsx'
import OrderFormModal from '../components/OrderFormModal.jsx'
import BlockReasonModal from '../components/BlockReasonModal.jsx'
import AdminImport from './AdminImport.jsx'
import AdminOverview from './AdminOverview.jsx'
import { DONE_RANK, stageRank } from '../lib/schedule'

// Cycled per row in the Grid tab so long lists are easier to track
// across a wide table (25 columns) than plain white/paper zebra
// striping. Deliberately avoids red — that's reserved for alerts.
const ROW_SHADES = ['bg-white', 'bg-paperDim', 'bg-andonBlueBg', 'bg-andonGreenBg', 'bg-steel/10']

export default function AdminView() {
  const { signOut } = useAuth()
  const { live } = useConnection()
  const [blockTarget, setBlockTarget] = useState(null) // { orderId, columnId } while the reason picker is open
  const [tab, setTab] = useState('overview') // 'overview' | 'grid' | 'import'
  const [hideFinished, setHideFinished] = useState(true)
  const [buildWeeks, setBuildWeeks] = useState([])
  const [selectedWeekId, setSelectedWeekId] = useState('all')
  const [columns, setColumns] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState('')
  const [openOrder, setOpenOrder] = useState(null)
  const [formOrder, setFormOrder] = useState(null) // null = closed, 'new' = create, order object = edit
  const [shipDateDraft, setShipDateDraft] = useState('')

  async function loadBuildWeeks() {
    // Newest ship date first — oldest scrolls to the bottom.
    const { data } = await supabase.from('bt_build_weeks').select('*').order('ship_date', { ascending: false, nullsFirst: false })
    const weeks = data ?? []
    setBuildWeeks(weeks)
    // Default to the week that's actually coming up next, not everything
    // mixed together — but don't clobber an admin's own manual pick
    // (e.g. after a weekly import re-triggers this).
    setSelectedWeekId((prev) => (prev === 'all' ? nearestBuildWeekId(weeks) ?? 'all' : prev))
  }

  async function loadAll() {
    setLoading(true)
    setLoadError('')
    const { data: cols, error: colsErr } = await supabase.from('bt_status_columns').select('id, name').order('sort_order')
    setColumns(cols ?? [])

    let query = supabase.from('bt_orders').select('id, tag_name, dealer, truck_route, shipping_status, build_week_id, scheduled_pickup_date')
    if (selectedWeekId !== 'all') query = query.eq('build_week_id', selectedWeekId)
    const { data: orderRows, error: ordersErr } = await query

    const { data: statusRows, error: statusErr } = await supabase
      .from('bt_order_status')
      .select('order_id, status_column_id, status_value, is_visible, workflow_stage, blocked_at, blocked_note')

    // A failed query here (e.g. a schema migration not yet run against
    // this database) used to fail silently and just render an empty
    // grid — say so instead.
    const firstError = colsErr || ordersErr || statusErr
    if (firstError) setLoadError(`Couldn't load the Grid: ${firstError.message}`)

    const statusMap = new Map()
    for (const s of statusRows ?? []) {
      const key = s.order_id
      if (!statusMap.has(key)) statusMap.set(key, {})
      statusMap.get(key)[s.status_column_id] = {
        value: s.status_value,
        visible: s.is_visible,
        stage: s.workflow_stage,
        blocked: !!s.blocked_at,
        blockedNote: s.blocked_note,
      }
    }

    setOrders((orderRows ?? []).map((o) => ({ ...o, statuses: statusMap.get(o.id) ?? {} })).sort(byShipDate))
    setLoading(false)
  }

  useEffect(() => {
    loadBuildWeeks()
  }, [])

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWeekId])

  // Crew edits (e.g. Mods advancing a stage) land straight in
  // bt_order_status — without this the Grid tab only ever refreshed on
  // mount or when the build-week filter changed, so admin never saw
  // floor updates without a manual reload.
  useEffect(() => {
    const channel = supabase
      .channel('admin-grid-order-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, loadAll)
      .subscribe()
    return () => supabase.removeChannel(channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWeekId])

  useEffect(() => {
    const wk = buildWeeks.find((w) => w.id === selectedWeekId)
    setShipDateDraft(wk?.ship_date ?? '')
  }, [selectedWeekId, buildWeeks])

  function patchLocalCell(orderId, columnId, patch) {
    setOrders((prev) =>
      prev.map((o) => (o.id !== orderId ? o : { ...o, statuses: { ...o.statuses, [columnId]: { ...o.statuses[columnId], ...patch } } }))
    )
  }

  function findCell(orderId, columnId) {
    return orders.find((o) => o.id === orderId)?.statuses[columnId]
  }

  async function handleStageCommit(orderId, columnId, stageId) {
    if (!live) return
    const prev = findCell(orderId, columnId)
    patchLocalCell(orderId, columnId, { stage: stageId || null }) // optimistic
    const { error } = await supabase
      .from('bt_order_status')
      .upsert({ order_id: orderId, status_column_id: columnId, workflow_stage: stageId || null }, { onConflict: 'order_id,status_column_id' })
    if (error && prev) patchLocalCell(orderId, columnId, { stage: prev.stage }) // roll back
  }

  async function toggleVisible(orderId, columnId, current) {
    if (!live) return
    patchLocalCell(orderId, columnId, { visible: !current }) // optimistic
    const { error } = await supabase
      .from('bt_order_status')
      .update({ is_visible: !current })
      .eq('order_id', orderId)
      .eq('status_column_id', columnId)
    if (error) patchLocalCell(orderId, columnId, { visible: current }) // roll back
  }

  // Blocked is a flag layered on top of whatever stage a cell is
  // already at, not part of the linear stage sequence — see schema_v11.
  // Unblocking needs no reason; blocking opens the reason picker below.
  function requestToggleBlocked(orderId, columnId, currentlyBlocked) {
    if (!live) return
    if (currentlyBlocked) applyBlocked(orderId, columnId, false, null)
    else setBlockTarget({ orderId, columnId })
  }

  async function applyBlocked(orderId, columnId, blocked, note) {
    const prev = findCell(orderId, columnId)
    patchLocalCell(orderId, columnId, { blocked, blockedNote: note }) // optimistic
    const { error } = await supabase
      .from('bt_order_status')
      .update({ blocked_at: blocked ? new Date().toISOString() : null, blocked_note: blocked ? note : null })
      .eq('order_id', orderId)
      .eq('status_column_id', columnId)
    if (error && prev) patchLocalCell(orderId, columnId, { blocked: prev.blocked, blockedNote: prev.blockedNote }) // roll back
  }

  async function handleShipDateSave() {
    if (selectedWeekId === 'all') return
    setBuildWeeks((prev) => prev.map((w) => (w.id === selectedWeekId ? { ...w, ship_date: shipDateDraft || null } : w)))
    await supabase.from('bt_build_weeks').update({ ship_date: shipDateDraft || null }).eq('id', selectedWeekId)
  }

  // Finished = every department on the order at Order Completed or
  // later. Hidden by default so the grid shows the work still to do.
  const isFinished = (o) => {
    const cells = Object.values(o.statuses).filter((c) => c.visible)
    return cells.length > 0 && cells.every((c) => stageRank(c.stage) >= DONE_RANK)
  }
  const finishedCount = orders.filter(isFinished).length
  const visibleOrders = orders.filter(
    (o) =>
      !(hideFinished && isFinished(o)) &&
      (!filter ||
        o.tag_name.toLowerCase().includes(filter.toLowerCase()) ||
        (o.dealer ?? '').toLowerCase().includes(filter.toLowerCase()))
  )

  // A column only earns a spot in the grid if at least one visible order
  // actually has a value in it. A blank cell on the sheet means that
  // department never applied to that order at all — not "waiting" or
  // "in progress" — so it shouldn't take up a column here either.
  const presentColumns = columns.filter((c) => visibleOrders.some((o) => o.statuses[c.id] != null))

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-4 border-b-4 border-safety flex-wrap">
        <h1 className="font-display text-2xl font-bold text-paper tracking-wide">Truesdale Build Tracker — Admin</h1>
        <div className="flex items-center gap-2">
          {[
            ['overview', 'Overview'],
            ['grid', 'Grid'],
            ['import', 'Weekly Import'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-sm font-medium rounded ${tab === id ? 'bg-safety text-charcoal' : 'text-paper'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">
          Sign out
        </button>
      </header>

      {tab === 'overview' && (
        <AdminOverview
          buildWeeks={buildWeeks}
          onWeeksChanged={loadBuildWeeks}
          onEditOrder={(o) => setFormOrder(o)}
          onNewOrder={() => setFormOrder('new')}
          onImport={() => setTab('import')}
          onOpenGrid={() => setTab('grid')}
        />
      )}

      {tab === 'import' && (
        <AdminImport
          buildWeeks={buildWeeks}
          onCommitted={() => {
            loadBuildWeeks()
            setTab('grid')
          }}
        />
      )}

      {tab === 'grid' && (
        <>
          <div className="bg-white border-b border-paperDim px-5 py-3 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-steel">Build week</label>
              <select
                value={selectedWeekId}
                onChange={(e) => setSelectedWeekId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                className="border border-paperDim rounded px-3 py-2 text-sm"
              >
                <option value="all">All build weeks</option>
                {buildWeeks.map((w) => (
                  <option key={w.id} value={w.id}>
                    {weekOptionLabel(w)}
                  </option>
                ))}
              </select>
            </div>
            {selectedWeekId !== 'all' && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-steel">Ship date</label>
                <input
                  type="date"
                  value={shipDateDraft}
                  onChange={(e) => setShipDateDraft(e.target.value)}
                  className="border border-paperDim rounded px-2 py-1.5 text-sm"
                />
                <button onClick={handleShipDateSave} className="bg-charcoal text-paper text-sm px-3 py-1.5 rounded">
                  Save (notifies floor)
                </button>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-steel cursor-pointer">
              <input type="checkbox" checked={hideFinished} onChange={(e) => setHideFinished(e.target.checked)} className="w-4 h-4" />
              Hide finished{finishedCount > 0 && ` (${finishedCount})`}
            </label>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search tag or dealer…"
              className="border border-paperDim rounded px-3 py-2 text-sm w-64 ml-auto"
            />
            <button onClick={() => setFormOrder('new')} className="bg-safety text-charcoal font-display font-bold text-sm px-4 py-2 rounded whitespace-nowrap">
              + New Order
            </button>
          </div>

          <main className="p-4 overflow-x-auto">
            {loadError && (
              <div className="bg-andonRedBg border border-andonRed text-andonRed text-sm px-4 py-3 rounded mb-3">
                ⚠ {loadError}
              </div>
            )}
            {loading ? (
              <p className="text-steelLight text-sm">Loading…</p>
            ) : (
              <table className="min-w-full text-sm bg-white shadow-sm">
                <thead className="bg-charcoal text-paper font-display text-base">
                  <tr>
                    <th className="px-3 py-2 text-left sticky left-0 bg-charcoal z-10">Tag Name</th>
                    <th className="px-3 py-2 text-left">Dealer</th>
                    <th className="px-3 py-2 text-left">Ship Status</th>
                    {presentColumns.map((c) => (
                      <th key={c.id} className="px-3 py-2 text-left whitespace-nowrap font-normal text-sm">
                        {c.name}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-left">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((o, i) => (
                    <tr key={o.id} className={ROW_SHADES[i % ROW_SHADES.length]}>
                      <td className="px-3 py-2 font-display text-base font-semibold text-charcoal sticky left-0 bg-inherit">
                        {o.tag_name}
                      </td>
                      <td className="px-3 py-2 text-steelLight">{o.dealer}</td>
                      <td className="px-3 py-2 text-steelLight">{o.shipping_status}</td>
                      {presentColumns.map((c) => {
                        const cell = o.statuses[c.id]
                        // No status row at all means this department never
                        // applied to this order on the sheet — leave the
                        // cell genuinely empty instead of offering a dropdown
                        // for a column that isn't real for this order.
                        if (cell == null)
                          return (
                            <td key={c.id} className="px-1 py-1 text-center">
                              <button
                                onClick={() => setFormOrder(o)}
                                title={`Add ${c.name} to this order — wasn't on the imported sheet`}
                                className="w-full h-full text-paperDim hover:text-andonBlue hover:bg-andonBlueBg rounded text-sm px-2 py-1.5"
                              >
                                + Add
                              </button>
                            </td>
                          )
                        const stageInfo = cell.stage ? workflowStageById[cell.stage] : null
                        // Blocked overrides the stage color — more urgent
                        // than whatever stage it's stuck at.
                        const chipClass = cell.blocked ? BLOCKED_CHIP_CLASS : stageInfo ? stageInfo.chipClass : 'bg-paperDim text-steelLight'
                        return (
                          <td key={c.id} className="px-1 py-1">
                            <div className={`flex items-center gap-1 rounded ${chipClass}`} title={cell.blocked ? `Blocked${cell.blockedNote ? `: ${cell.blockedNote}` : ''}` : undefined}>
                              <select
                                value={cell.stage ?? ''}
                                onChange={(e) => handleStageCommit(o.id, c.id, e.target.value)}
                                className="flex-1 px-1.5 py-1 bg-transparent text-sm"
                              >
                                <option value="">Set status…</option>
                                {WORKFLOW_STAGES.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.label}
                                  </option>
                                ))}
                              </select>
                              <button
                                title={cell.blocked ? 'Unblock' : 'Mark blocked / material shortage'}
                                onClick={() => requestToggleBlocked(o.id, c.id, cell.blocked)}
                                className="text-xs pr-1"
                              >
                                🚧
                              </button>
                              <button
                                title={cell.visible ? 'Visible to floor — click to hide' : 'Hidden from floor — click to show'}
                                onClick={() => toggleVisible(o.id, c.id, cell.visible)}
                                className="text-xs pr-1"
                              >
                                {cell.visible ? '👁' : '🙈'}
                              </button>
                            </div>
                          </td>
                        )
                      })}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button onClick={() => setOpenOrder(o)} className="text-andonBlue font-medium text-sm">
                          Files
                        </button>
                        <span className="text-paperDim mx-1.5">·</span>
                        <button onClick={() => setFormOrder(o)} className="text-andonBlue font-medium text-sm">
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </main>
        </>
      )}

      {openOrder && <FileModal order={openOrder} onClose={() => setOpenOrder(null)} allowUpload />}

      {formOrder && (
        <OrderFormModal
          order={formOrder === 'new' ? null : formOrder}
          columns={columns}
          buildWeeks={buildWeeks}
          onClose={() => setFormOrder(null)}
          onSaved={loadAll}
        />
      )}

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
