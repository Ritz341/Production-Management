import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { dbErrorText } from '../lib/dbError'
import NotificationBanner from '../components/NotificationBanner.jsx'

const LEAD_BADGE = {
  NONE: { label: '', bg: '' },
  LEAD_1: { label: 'L1', bg: 'bg-andonBlueBg text-andonBlue' },
  LEAD_2: { label: 'L2', bg: 'bg-andonGreenBg text-andonGreen' },
  LEAD_3: { label: 'L3', bg: 'bg-[#FFF3CD] text-[#856404]' },
}

const RATING_DOT = {
  3: 'bg-andonGreenBg border-andonGreen',
  4: 'bg-andonGreen border-andonGreen',
}

export default function CrossDeptFloatBoard() {
  const { profile, signOut } = useAuth()
  const { live } = useConnection()
  const [departments, setDepartments] = useState([])
  const [floaters, setFloaters] = useState([])
  const [activeFloats, setActiveFloats] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedDept, setSelectedDept] = useState(null) // dept needing help
  const [filterFunc, setFilterFunc] = useState('all') // CUTTING | ASSEMBLY | all
  const [showConfirm, setShowConfirm] = useState(null) // { employee, dept, funcCat, maxRating }
  const [floatHours, setFloatHours] = useState(2)

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const [deptRes, floaterRes, floatRes] = await Promise.all([
        supabase.from('bt_departments').select('id, name, sort_order').order('sort_order'),
        supabase.from('v_cross_dept_floaters').select('*'),
        supabase.from('bt_float_assignments').select('*, bt_employees(name), from_dept:bt_departments!bt_float_assignments_from_dept_id_fkey(name), to_dept:bt_departments!bt_float_assignments_to_dept_id_fkey(name)').is('ended_at', null),
      ])
      const firstErr = deptRes.error || floaterRes.error || floatRes.error
      if (firstErr) { setError(dbErrorText(firstErr, "Couldn't load floater board")); return }

      setDepartments(deptRes.data ?? [])
      setFloaters(floaterRes.data ?? [])
      setActiveFloats(floatRes.data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  // Realtime: float assignments change
  useEffect(() => {
    const channel = supabase
      .channel('float-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_float_assignments' }, loadAll)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  // ── Filtered floaters for the selected bottleneck dept ─────
  const available = useMemo(() => {
    if (!selectedDept) return []
    return floaters.filter((f) => {
      if (f.qualified_dept_id !== selectedDept.id) return false
      if (filterFunc !== 'all' && f.function_category !== filterFunc) return false
      // Already floated somewhere? Still show but flagged
      return true
    }).sort((a, b) => b.max_rating - a.max_rating || a.employee_name.localeCompare(b.employee_name))
  }, [floaters, selectedDept, filterFunc])

  // Deduplicate by employee (they may appear multiple times for different function categories)
  const uniqueAvailable = useMemo(() => {
    const seen = new Map()
    for (const f of available) {
      const key = f.employee_id
      if (!seen.has(key) || f.max_rating > seen.get(key).max_rating) seen.set(key, f)
    }
    return [...seen.values()]
  }, [available])

  // ── Assign float ───────────────────────────────────────────
  async function assignFloat() {
    if (!showConfirm || !live) return
    const { employee } = showConfirm
    const expectedEnd = new Date()
    expectedEnd.setHours(expectedEnd.getHours() + floatHours)

    const { error } = await supabase.from('bt_float_assignments').insert({
      employee_id: employee.employee_id,
      from_dept_id: employee.primary_dept_id,
      to_dept_id: selectedDept.id,
      expected_end: expectedEnd.toISOString(),
      note: `Floated to ${selectedDept.name} for ${floatHours}h`,
    })
    if (error) { setError(`Assignment failed: ${error.message}`); return }
    setShowConfirm(null)
    loadAll()
  }

  // ── End float ──────────────────────────────────────────────
  async function endFloat(floatId) {
    const { error } = await supabase.from('bt_float_assignments').update({ ended_at: new Date().toISOString() }).eq('id', floatId)
    if (error) setError(`Couldn't end float: ${error.message}`)
    else loadAll()
  }

  if (loading) return <div className="h-screen flex items-center justify-center bg-floor"><p className="text-floorMute">Loading floater board…</p></div>

  return (
    <div className="min-h-screen bg-floor text-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-4 border-b-4 border-safety">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-wide">Cross-Department Float Board</h1>
          <p className="text-floorMute text-sm">Tap a department with a bottleneck to find qualified leads</p>
        </div>
        <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">Sign out</button>
      </header>

      {error && (
        <div className="bg-andonRedBg border border-andonRed text-andonRed text-sm px-4 py-3 mx-4 mt-3 rounded">
          ⚠ {error}
          <button onClick={() => setError('')} className="ml-3 underline">Dismiss</button>
        </div>
      )}

      {/* ── Active Float Assignments Banner ───────────────────── */}
      {activeFloats.length > 0 && (
        <div className="mx-4 mt-3 space-y-2">
          <p className="text-xs text-floorMute font-bold uppercase tracking-wider">Active Floats</p>
          {activeFloats.map((af) => (
            <div key={af.id} className="bg-floorCard border border-floorLine rounded-lg px-4 py-3 flex items-center justify-between">
              <div>
                <span className="font-display font-bold text-base">{af.bt_employees?.name}</span>
                <span className="text-floorMute text-sm ml-2">
                  {af.from_dept?.name} → <span className="text-safety font-bold">{af.to_dept?.name}</span>
                </span>
                {af.expected_end && (
                  <span className="text-floorMute text-xs ml-2">
                    (until {new Date(af.expected_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                  </span>
                )}
              </div>
              <button onClick={() => endFloat(af.id)} disabled={!live}
                className="bg-andonRed text-white text-sm font-bold px-4 py-2 rounded active:scale-95 disabled:opacity-50">
                End Float
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Department Grid: "Where's the bottleneck?" ────────── */}
      <div className="p-4">
        <p className="text-sm text-floorMute mb-3 font-medium">Which department needs help?</p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {departments.map((dept) => {
            const qualifiedCount = new Set(floaters.filter((f) => f.qualified_dept_id === dept.id).map((f) => f.employee_id)).size
            const isSelected = selectedDept?.id === dept.id
            return (
              <button
                key={dept.id}
                onClick={() => setSelectedDept(isSelected ? null : dept)}
                className={`rounded-xl p-4 text-left transition-all active:scale-95 ${
                  isSelected
                    ? 'bg-safety text-charcoal ring-2 ring-safety'
                    : 'bg-floorCard border border-floorLine hover:border-steelLight'
                }`}
              >
                <p className="font-display text-lg font-bold">{dept.name}</p>
                <p className={`text-sm ${isSelected ? 'text-charcoal/70' : 'text-floorMute'}`}>
                  {qualifiedCount} qualified floater{qualifiedCount !== 1 ? 's' : ''}
                </p>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Available Floaters for Selected Dept ──────────────── */}
      {selectedDept && (
        <div className="px-4 pb-6">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-display text-xl font-bold">
              Available for <span className="text-safety">{selectedDept.name}</span>
            </h2>
            <div className="flex gap-1 ml-auto">
              {['all', 'CUTTING', 'ASSEMBLY'].map((f) => (
                <button key={f} onClick={() => setFilterFunc(f)}
                  className={`px-3 py-1 text-sm rounded ${filterFunc === f ? 'bg-safety text-charcoal font-bold' : 'bg-floorCard text-floorMute border border-floorLine'}`}>
                  {f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {uniqueAvailable.length === 0 ? (
            <p className="text-floorMute text-sm py-8 text-center">No qualified floaters available for {selectedDept.name}.</p>
          ) : (
            <div className="space-y-2">
              {uniqueAvailable.map((f) => {
                const badge = LEAD_BADGE[f.lead_level] ?? LEAD_BADGE.NONE
                const isFloating = !!f.currently_floated_to
                return (
                  <div key={`${f.employee_id}-${f.function_category}`}
                    className={`rounded-xl p-4 flex items-center justify-between gap-4 ${
                      isFloating ? 'bg-blockedCard border border-andonRed/30' : 'bg-floorCard border border-floorLine'
                    }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full border-2 ${RATING_DOT[f.max_rating] ?? 'bg-paperDim border-steelLight'}`} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-display font-bold text-base">{f.employee_name}</span>
                          {badge.label && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badge.bg}`}>{badge.label}</span>}
                          <span className="text-floorMute text-xs">from {f.primary_dept}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-floorMute">
                            Rating: <span className="font-bold text-paper">{f.max_rating}</span> in {f.function_category.toLowerCase()}
                          </span>
                          {isFloating && (
                            <span className="text-xs text-andonRed font-bold">
                              Currently at {f.currently_floated_to}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowConfirm({ employee: f, dept: selectedDept })}
                      disabled={!live || isFloating}
                      className="bg-safety text-charcoal font-display font-bold text-sm px-5 py-3 rounded-lg active:scale-95 disabled:opacity-30 whitespace-nowrap">
                      Float Here
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Confirm Float Modal ───────────────────────────────── */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowConfirm(null)}>
          <div className="bg-floorCard rounded-2xl shadow-2xl p-6 w-full max-w-sm border border-floorLine" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-xl font-bold text-paper mb-2">Confirm Float</h3>
            <p className="text-floorMute text-sm mb-4">
              Move <span className="text-paper font-bold">{showConfirm.employee.employee_name}</span> from{' '}
              <span className="text-paper">{showConfirm.employee.primary_dept}</span> to{' '}
              <span className="text-safety font-bold">{selectedDept.name}</span>?
            </p>
            <div className="mb-4">
              <label className="text-sm text-floorMute block mb-1">Duration</label>
              <div className="flex gap-2">
                {[1, 2, 3, 4].map((h) => (
                  <button key={h} onClick={() => setFloatHours(h)}
                    className={`flex-1 py-2 rounded text-sm font-bold ${floatHours === h ? 'bg-safety text-charcoal' : 'bg-floor text-floorMute border border-floorLine'}`}>
                    {h}h
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowConfirm(null)} className="flex-1 py-3 text-sm text-floorMute border border-floorLine rounded-lg">
                Cancel
              </button>
              <button onClick={assignFloat} disabled={!live}
                className="flex-1 bg-safety text-charcoal font-display font-bold py-3 rounded-lg active:scale-95 disabled:opacity-50">
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
