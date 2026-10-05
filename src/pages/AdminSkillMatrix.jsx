import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabaseClient'
import { dbErrorText } from '../lib/dbError'

const LEAD_LEVELS = [
  { value: 'NONE', label: 'None', color: 'text-steelLight' },
  { value: 'LEAD_1', label: 'Lead 1 — Station', color: 'text-andonBlue' },
  { value: 'LEAD_2', label: 'Lead 2 — Department', color: 'text-andonGreen' },
  { value: 'LEAD_3', label: 'Lead 3 — Plant Supervisor', color: 'text-safety' },
]

const FUNCTION_CATEGORIES = ['CUTTING', 'ASSEMBLY', 'QC', 'STAGING']

const RATING_COLORS = {
  0: 'bg-paperDim text-steelLight',
  1: 'bg-andonRedBg text-andonRed',
  2: 'bg-[#FFF3CD] text-[#856404]',
  3: 'bg-andonGreenBg text-andonGreen',
  4: 'bg-andonGreen text-white',
}

const RATING_LABELS = {
  0: '—',
  1: '1 — Trainee',
  2: '2 — Autonomous',
  3: '3 — Specialist',
  4: '4 — Master',
}

const LEVEL_THRESHOLDS = [
  { min: 0.75, label: 'LEVEL 2', bg: 'bg-andonGreen', text: 'text-white' },
  { min: 0.50, label: 'LEVEL 1', bg: 'bg-andonGreenBg', text: 'text-andonGreen' },
  { min: 0.25, label: 'ENTRY', bg: 'bg-[#FFF3CD]', text: 'text-[#856404]' },
  { min: 0, label: 'TRAINING', bg: 'bg-andonRedBg', text: 'text-andonRed' },
]

function levelBadge(pct) {
  const t = LEVEL_THRESHOLDS.find((l) => pct >= l.min) ?? LEVEL_THRESHOLDS.at(-1)
  return <span className={`text-xs font-bold px-2 py-0.5 rounded ${t.bg} ${t.text}`}>{t.label}</span>
}

export default function AdminSkillMatrix() {
  const [departments, setDepartments] = useState([])
  const [employees, setEmployees] = useState([])
  const [skills, setSkills] = useState([])
  const [ratings, setRatings] = useState({}) // `${empId}-${skillId}` -> rating
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Filters
  const [filterDept, setFilterDept] = useState('all')
  const [filterLead, setFilterLead] = useState('all')
  const [filterSearch, setFilterSearch] = useState('')

  // Employee form
  const [showForm, setShowForm] = useState(false)
  const [editingEmp, setEditingEmp] = useState(null)
  const [empForm, setEmpForm] = useState({ name: '', employee_id: '', primary_dept_id: '', shift: 'Day', lead_level: 'NONE' })

  // Skill form
  const [showSkillForm, setShowSkillForm] = useState(false)
  const [skillForm, setSkillForm] = useState({ department_id: '', name: '', function_category: 'ASSEMBLY', sort_order: 0 })

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const [deptRes, empRes, skillRes, ratingRes] = await Promise.all([
        supabase.from('bt_departments').select('id, name, sort_order').order('sort_order'),
        supabase.from('bt_employees').select('*').eq('is_active', true).order('name'),
        supabase.from('bt_skills').select('*').order('department_id').order('function_category').order('sort_order'),
        supabase.from('bt_employee_skills').select('employee_id, skill_id, rating'),
      ])
      const firstErr = deptRes.error || empRes.error || skillRes.error || ratingRes.error
      if (firstErr) { setError(dbErrorText(firstErr, "Couldn't load skill matrix")); return }

      setDepartments(deptRes.data ?? [])
      setEmployees(empRes.data ?? [])
      setSkills(skillRes.data ?? [])

      const map = {}
      for (const r of ratingRes.data ?? []) map[`${r.employee_id}-${r.skill_id}`] = r.rating
      setRatings(map)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  // ── Derived data ───────────────────────────────────────────
  const skillsByDept = useMemo(() => {
    const map = {}
    for (const s of skills) {
      if (!map[s.department_id]) map[s.department_id] = []
      map[s.department_id].push(s)
    }
    return map
  }, [skills])

  const filteredEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (filterDept !== 'all' && e.primary_dept_id !== Number(filterDept)) return false
      if (filterLead !== 'all' && e.lead_level !== filterLead) return false
      if (filterSearch && !e.name.toLowerCase().includes(filterSearch.toLowerCase()) && !(e.employee_id ?? '').toLowerCase().includes(filterSearch.toLowerCase())) return false
      return true
    })
  }, [employees, filterDept, filterLead, filterSearch])

  // ── Rating update ──────────────────────────────────────────
  async function handleRatingChange(employeeId, skillId, newRating) {
    const key = `${employeeId}-${skillId}`
    const prev = ratings[key]
    setRatings((r) => ({ ...r, [key]: newRating }))

    const { error } = newRating === 0
      ? await supabase.from('bt_employee_skills').delete().eq('employee_id', employeeId).eq('skill_id', skillId)
      : await supabase.from('bt_employee_skills').upsert(
          { employee_id: employeeId, skill_id: skillId, rating: newRating, rated_at: new Date().toISOString() },
          { onConflict: 'employee_id,skill_id' }
        )
    if (error) {
      setRatings((r) => ({ ...r, [key]: prev }))
      setError(`Rating save failed: ${error.message}`)
    }
  }

  // ── Employee CRUD ──────────────────────────────────────────
  function openNewEmployee() {
    setEditingEmp(null)
    setEmpForm({ name: '', employee_id: '', primary_dept_id: departments[0]?.id ?? '', shift: 'Day', lead_level: 'NONE' })
    setShowForm(true)
  }
  function openEditEmployee(emp) {
    setEditingEmp(emp)
    setEmpForm({ name: emp.name, employee_id: emp.employee_id ?? '', primary_dept_id: emp.primary_dept_id ?? '', shift: emp.shift ?? 'Day', lead_level: emp.lead_level })
    setShowForm(true)
  }
  async function saveEmployee() {
    setSaving(true)
    const payload = {
      name: empForm.name.trim(),
      employee_id: empForm.employee_id.trim() || null,
      primary_dept_id: empForm.primary_dept_id ? Number(empForm.primary_dept_id) : null,
      shift: empForm.shift,
      lead_level: empForm.lead_level,
    }
    const { error } = editingEmp
      ? await supabase.from('bt_employees').update(payload).eq('id', editingEmp.id)
      : await supabase.from('bt_employees').insert(payload)
    setSaving(false)
    if (error) { setError(`Save failed: ${error.message}`); return }
    setShowForm(false)
    loadAll()
  }
  async function deactivateEmployee(emp) {
    if (!confirm(`Deactivate ${emp.name}? They'll be hidden from the matrix.`)) return
    await supabase.from('bt_employees').update({ is_active: false }).eq('id', emp.id)
    loadAll()
  }

  // ── Skill CRUD ─────────────────────────────────────────────
  function openNewSkill() {
    setSkillForm({ department_id: departments[0]?.id ?? '', name: '', function_category: 'ASSEMBLY', sort_order: skills.length })
    setShowSkillForm(true)
  }
  async function saveSkill() {
    setSaving(true)
    const { error } = await supabase.from('bt_skills').insert({
      department_id: Number(skillForm.department_id),
      name: skillForm.name.trim(),
      function_category: skillForm.function_category,
      sort_order: skillForm.sort_order,
    })
    setSaving(false)
    if (error) { setError(`Skill save failed: ${error.message}`); return }
    setShowSkillForm(false)
    loadAll()
  }

  // ── Per-employee stats ─────────────────────────────────────
  function empStats(emp) {
    // Versatility index: count of departments where any skill is rated 2+
    const deptMaxes = {}
    for (const s of skills) {
      const r = ratings[`${emp.id}-${s.id}`] ?? 0
      if (r >= 2) deptMaxes[s.department_id] = Math.max(deptMaxes[s.department_id] ?? 0, r)
    }
    const versatility = Object.keys(deptMaxes).length

    // Cross-float depts: departments (not primary) where max rating >= 3
    const crossFloat = []
    for (const [deptId, maxR] of Object.entries(deptMaxes)) {
      if (maxR >= 3 && Number(deptId) !== emp.primary_dept_id) {
        const dept = departments.find((d) => d.id === Number(deptId))
        if (dept) crossFloat.push(dept.name)
      }
    }

    // Overall level: pct of all skills rated 2+
    const totalSkills = skills.length || 1
    const rated2Plus = skills.filter((s) => (ratings[`${emp.id}-${s.id}`] ?? 0) >= 2).length
    const pct = rated2Plus / totalSkills

    return { versatility, crossFloat, pct }
  }

  if (loading) return <p className="text-steelLight text-sm p-6">Loading skill matrix…</p>

  return (
    <div className="p-4">
      {error && (
        <div className="bg-andonRedBg border border-andonRed text-andonRed text-sm px-4 py-3 rounded mb-3">
          ⚠ {error}
          <button onClick={() => setError('')} className="ml-3 underline">Dismiss</button>
        </div>
      )}

      {/* ── Toolbar ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <h2 className="font-display text-xl font-bold text-charcoal">Skill & Lead Matrix</h2>
        <div className="flex items-center gap-2 sm:ml-auto flex-wrap w-full sm:w-auto">
          <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className="border border-paperDim rounded px-2 py-1.5 text-sm">
            <option value="all">All Departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={filterLead} onChange={(e) => setFilterLead(e.target.value)} className="border border-paperDim rounded px-2 py-1.5 text-sm">
            <option value="all">All Lead Levels</option>
            {LEAD_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <input
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            placeholder="Search employee…"
            className="border border-paperDim rounded px-2 py-1.5 text-sm w-full sm:w-48"
          />
        </div>
        <button onClick={openNewEmployee} className="bg-safety text-charcoal font-display font-bold text-sm px-4 py-2 rounded whitespace-nowrap">
          + Employee
        </button>
        <button onClick={openNewSkill} className="bg-charcoal text-paper font-display font-bold text-sm px-4 py-2 rounded whitespace-nowrap">
          + Skill
        </button>
      </div>

      {/* ── Matrix Grid ──────────────────────────────────────── */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs bg-white shadow-sm border border-paperDim">
          <thead>
            {/* Department header row */}
            <tr className="bg-charcoal text-paper">
              <th className="px-2 py-2 text-left sticky left-0 bg-charcoal z-20 min-w-[200px]" rowSpan={2}>Employee</th>
              <th className="px-2 py-1 text-center" rowSpan={2}>Lead</th>
              <th className="px-2 py-1 text-center" rowSpan={2}>Dept</th>
              <th className="px-2 py-1 text-center" rowSpan={2}>Shift</th>
              {departments.map((dept) => {
                const deptSkills = skillsByDept[dept.id] ?? []
                return deptSkills.length > 0 ? (
                  <th key={dept.id} colSpan={deptSkills.length} className="px-2 py-1 text-center border-l border-steelLight font-display text-sm">
                    {dept.name}
                  </th>
                ) : null
              })}
              <th className="px-2 py-1 text-center border-l border-steelLight" rowSpan={2}>Versatility</th>
              <th className="px-2 py-1 text-center" rowSpan={2}>Cross-Float</th>
              <th className="px-2 py-1 text-center" rowSpan={2}>Level</th>
              <th className="px-2 py-1 text-center" rowSpan={2}></th>
            </tr>
            {/* Skill name row */}
            <tr className="bg-steel text-paper">
              {departments.map((dept) => {
                const deptSkills = skillsByDept[dept.id] ?? []
                return deptSkills.map((s, i) => (
                  <th key={s.id} className={`px-1 py-1 text-center font-normal whitespace-nowrap ${i === 0 ? 'border-l border-steelLight' : ''}`}
                    title={`${s.function_category} — ${s.name}`}>
                    <div className="text-[10px] leading-tight">
                      <span className={s.function_category === 'CUTTING' ? 'text-safety' : 'text-andonGreenBg'}>{s.function_category.charAt(0)}</span>
                      {' '}{s.name.length > 12 ? s.name.slice(0, 11) + '…' : s.name}
                    </div>
                  </th>
                ))
              })}
            </tr>
          </thead>
          <tbody>
            {filteredEmployees.length === 0 ? (
              <tr><td colSpan={99} className="text-center py-8 text-steelLight">No employees found. Add one above.</td></tr>
            ) : filteredEmployees.map((emp, idx) => {
              const stats = empStats(emp)
              const leadInfo = LEAD_LEVELS.find((l) => l.value === emp.lead_level)
              const primaryDept = departments.find((d) => d.id === emp.primary_dept_id)
              return (
                <tr key={emp.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-paperDim'}>
                  <td className="px-2 py-1.5 sticky left-0 bg-inherit z-10 font-medium text-charcoal whitespace-nowrap">
                    {emp.name}
                    {emp.employee_id && <span className="text-steelLight ml-1 text-[10px]">({emp.employee_id})</span>}
                  </td>
                  <td className="px-1 py-1 text-center">
                    <span className={`text-[10px] font-bold ${leadInfo?.color ?? ''}`}>{leadInfo?.label?.split('—')[0]?.trim() ?? ''}</span>
                  </td>
                  <td className="px-1 py-1 text-center text-[10px]">{primaryDept?.name ?? '—'}</td>
                  <td className="px-1 py-1 text-center text-[10px]">{emp.shift}</td>
                  {departments.map((dept) => {
                    const deptSkills = skillsByDept[dept.id] ?? []
                    return deptSkills.map((s, i) => {
                      const r = ratings[`${emp.id}-${s.id}`] ?? 0
                      return (
                        <td key={s.id} className={`px-0 py-0 text-center ${i === 0 ? 'border-l border-paperDim' : ''}`}>
                          <select
                            value={r}
                            onChange={(e) => handleRatingChange(emp.id, s.id, Number(e.target.value))}
                            className={`w-full h-full px-1 py-1 text-[11px] font-bold text-center border-0 cursor-pointer ${RATING_COLORS[r]}`}
                          >
                            {[0, 1, 2, 3, 4].map((v) => <option key={v} value={v}>{v === 0 ? '—' : v}</option>)}
                          </select>
                        </td>
                      )
                    })
                  })}
                  <td className="px-2 py-1 text-center font-bold text-charcoal border-l border-paperDim">{stats.versatility}</td>
                  <td className="px-2 py-1 text-center text-[10px] text-andonBlue max-w-[120px] truncate" title={stats.crossFloat.join(', ')}>
                    {stats.crossFloat.length > 0 ? stats.crossFloat.join(', ') : '—'}
                  </td>
                  <td className="px-2 py-1 text-center">{levelBadge(stats.pct)}</td>
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => openEditEmployee(emp)} className="text-andonBlue text-[10px] hover:underline mr-1">Edit</button>
                    <button onClick={() => deactivateEmployee(emp)} className="text-andonRed text-[10px] hover:underline">×</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Summary Stats ────────────────────────────────────── */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Employees" value={employees.length} />
        <StatCard label="Lead 1s" value={employees.filter((e) => e.lead_level === 'LEAD_1').length} color="text-andonBlue" />
        <StatCard label="Lead 2s" value={employees.filter((e) => e.lead_level === 'LEAD_2').length} color="text-andonGreen" />
        <StatCard label="Lead 3s" value={employees.filter((e) => e.lead_level === 'LEAD_3').length} color="text-safety" />
      </div>

      {/* ── Rating Legend ────────────────────────────────────── */}
      <div className="mt-4 flex items-center gap-x-4 gap-y-2 flex-wrap text-xs text-steelLight">
        <span className="font-medium text-charcoal">Rating Scale:</span>
        {[1, 2, 3, 4].map((r) => (
          <span key={r} className={`px-2 py-0.5 rounded font-bold ${RATING_COLORS[r]}`}>{RATING_LABELS[r]}</span>
        ))}
      </div>

      {/* ── Employee Modal ───────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-lg font-bold text-charcoal mb-4">{editingEmp ? 'Edit Employee' : 'New Employee'}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-steel block mb-1">Name *</label>
                <input value={empForm.name} onChange={(e) => setEmpForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium text-steel block mb-1">Badge / Employee ID</label>
                <input value={empForm.employee_id} onChange={(e) => setEmpForm((f) => ({ ...f, employee_id: e.target.value }))}
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium text-steel block mb-1">Primary Department</label>
                <select value={empForm.primary_dept_id} onChange={(e) => setEmpForm((f) => ({ ...f, primary_dept_id: e.target.value }))}
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm">
                  <option value="">— None —</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-steel block mb-1">Shift</label>
                  <select value={empForm.shift} onChange={(e) => setEmpForm((f) => ({ ...f, shift: e.target.value }))}
                    className="w-full border border-paperDim rounded px-3 py-2 text-sm">
                    <option value="Day">Day</option>
                    <option value="Night">Night</option>
                    <option value="Swing">Swing</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium text-steel block mb-1">Lead Level</label>
                  <select value={empForm.lead_level} onChange={(e) => setEmpForm((f) => ({ ...f, lead_level: e.target.value }))}
                    className="w-full border border-paperDim rounded px-3 py-2 text-sm">
                    {LEAD_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-steel">Cancel</button>
              <button onClick={saveEmployee} disabled={saving || !empForm.name.trim()}
                className="bg-safety text-charcoal font-bold text-sm px-6 py-2 rounded disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Skill Modal ──────────────────────────────────────── */}
      {showSkillForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowSkillForm(false)}>
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-lg font-bold text-charcoal mb-4">Add Skill</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-steel block mb-1">Department *</label>
                <select value={skillForm.department_id} onChange={(e) => setSkillForm((f) => ({ ...f, department_id: e.target.value }))}
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm">
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-steel block mb-1">Skill Name *</label>
                <input value={skillForm.name} onChange={(e) => setSkillForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Double-Miter Saw, Frame Welding"
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium text-steel block mb-1">Function Category</label>
                <select value={skillForm.function_category} onChange={(e) => setSkillForm((f) => ({ ...f, function_category: e.target.value }))}
                  className="w-full border border-paperDim rounded px-3 py-2 text-sm">
                  {FUNCTION_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowSkillForm(false)} className="px-4 py-2 text-sm text-steel">Cancel</button>
              <button onClick={saveSkill} disabled={saving || !skillForm.name.trim() || !skillForm.department_id}
                className="bg-safety text-charcoal font-bold text-sm px-6 py-2 rounded disabled:opacity-50">
                {saving ? 'Saving…' : 'Add Skill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color = 'text-charcoal' }) {
  return (
    <div className="bg-white border border-paperDim rounded-lg p-3">
      <p className="text-xs text-steelLight">{label}</p>
      <p className={`font-display text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}
