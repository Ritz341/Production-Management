import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { workflowBucket } from '../lib/statusColors'
import { nearestBuildWeekId, weekOptionLabel } from '../lib/dates'

export default function AdminBoard({ buildWeeks }) {
  const [selectedWeekId, setSelectedWeekId] = useState('all')

  // Default to the week coming up next once buildWeeks arrives, rather
  // than showing every week's stats blended together — but don't
  // clobber a manual pick once one's been made.
  useEffect(() => {
    setSelectedWeekId((prev) => (prev === 'all' ? nearestBuildWeekId(buildWeeks) ?? 'all' : prev))
  }, [buildWeeks])
  const [departments, setDepartments] = useState([])
  const [deptColumns, setDeptColumns] = useState({}) // departmentId -> [columnId, ...]
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('bt_departments').select('id, name').order('sort_order').then(({ data }) => setDepartments(data ?? []))
    supabase.from('bt_department_columns').select('department_id, status_column_id').then(({ data }) => {
      const map = {}
      for (const d of data ?? []) {
        if (!map[d.department_id]) map[d.department_id] = []
        map[d.department_id].push(d.status_column_id)
      }
      setDeptColumns(map)
    })
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)

    async function load() {
      let orderQuery = supabase.from('bt_orders').select('id, build_week_id')
      if (selectedWeekId !== 'all') orderQuery = orderQuery.eq('build_week_id', selectedWeekId)
      const { data: orderRows } = await orderQuery
      const orderIds = (orderRows ?? []).map((o) => o.id)
      if (orderIds.length === 0) {
        setOrders([])
        setLoading(false)
        return
      }
      const { data: statusRows } = await supabase
        .from('bt_order_status')
        .select('order_id, workflow_stage, status_column_id, is_visible')
        .in('order_id', orderIds)
        .eq('is_visible', true)

      if (!active) return
      const byOrder = new Map(orderIds.map((id) => [id, {}]))
      for (const row of statusRows ?? []) {
        byOrder.get(row.order_id)[row.status_column_id] = { stage: row.workflow_stage }
      }
      setOrders(Array.from(byOrder.values()))
      setLoading(false)
    }

    load()
    const channel = supabase
      .channel(`board-${selectedWeekId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [selectedWeekId])

  const stats = useMemo(() => {
    return departments.map((dept) => {
      const colIds = deptColumns[dept.id] ?? []
      let notStarted = 0
      let inProgress = 0
      let complete = 0
      for (const cells of orders) {
        const relevantIds = colIds.filter((id) => cells[id] !== undefined)
        if (relevantIds.length === 0) continue
        // worst-case stage across this department's columns for this order
        const stages = relevantIds.map((id) => workflowBucket(cells[id]?.stage))
        if (stages.includes('not_started')) notStarted++
        else if (stages.includes('in_progress')) inProgress++
        else complete++
      }
      return { dept, notStarted, inProgress, complete, total: notStarted + inProgress + complete }
    })
  }, [departments, deptColumns, orders])

  return (
    <div className="p-5 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-display text-2xl font-bold text-charcoal">Live Board</h2>
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

      {loading ? (
        <p className="text-steelLight text-sm">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {stats.map(({ dept, notStarted, inProgress, complete, total }) => (
            <div key={dept.id} className="bg-white shadow-sm p-4">
              <h3 className="font-display text-xl font-bold text-charcoal mb-3">{dept.name}</h3>
              {total === 0 ? (
                <p className="text-sm text-steelLight">No orders in this build week.</p>
              ) : (
                <>
                  <div className="w-full h-3 flex overflow-hidden rounded-full mb-3">
                    <div className="bg-andonGreen" style={{ width: `${(complete / total) * 100}%` }} />
                    <div className="bg-safety" style={{ width: `${(inProgress / total) * 100}%` }} />
                    <div className="bg-steelLight" style={{ width: `${(notStarted / total) * 100}%` }} />
                  </div>
                  <div className="flex justify-between text-sm">
                    <div className="text-center">
                      <div className="font-display text-2xl font-bold text-steelLight">{notStarted}</div>
                      <div className="text-xs text-steelLight">Not started</div>
                    </div>
                    <div className="text-center">
                      <div className="font-display text-2xl font-bold text-safetyDark">{inProgress}</div>
                      <div className="text-xs text-steelLight">In progress</div>
                    </div>
                    <div className="text-center">
                      <div className="font-display text-2xl font-bold text-andonGreen">{complete}</div>
                      <div className="text-xs text-steelLight">Complete</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
