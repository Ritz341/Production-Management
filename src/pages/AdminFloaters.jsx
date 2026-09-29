import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { dbErrorText } from '../lib/dbError'
import { ago } from '../lib/schedule'

/**
 * Who can cover a department that's short today.
 *
 * The question this answers is asked standing on the floor at 8am with
 * one line stalled: Mods is the bottleneck — who is rated to run Mods
 * who isn't already in Mods? Answering it used to mean knowing the
 * plant well enough to hold it in your head.
 *
 * Reads v_cross_dept_floaters (schema_v18), which is already filtered
 * to rating 3+ — Specialist or Master — outside the person's own
 * department. Someone rated 2 is autonomous at their own bench, not
 * ready to be dropped into another one mid-shift.
 *
 * The view yields one row per function category, so the same person
 * qualified in both Cutting and Assembly comes back twice; they're
 * folded back together here with their categories listed.
 */

const LEAD_LABEL = { NONE: '', LEAD_1: 'Lead 1', LEAD_2: 'Lead 2', LEAD_3: 'Lead 3' }
const RATING_LABEL = { 1: 'Learning', 2: 'Autonomous', 3: 'Specialist', 4: 'Master / Trainer' }

export default function AdminFloaters() {
  const { live } = useConnection()
  const [departments, setDepartments] = useState([])
  const [rows, setRows] = useState([]) // v_cross_dept_floaters
  const [floats, setFloats] = useState([]) // open bt_float_assignments
  const [employeeCount, setEmployeeCount] = useState(null)
  const [needDeptId, setNeedDeptId] = useState(null) // the department that's short
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  async function load() {
    const [deptRes, viewRes, floatRes, empRes] = await Promise.all([
      supabase.from('bt_departments').select('id, name').order('sort_order'),
      supabase.from('v_cross_dept_floaters').select('*'),
      supabase
        .from('bt_float_assignments')
        .select('id, employee_id, from_dept_id, to_dept_id, assigned_at, expected_end, note, bt_employees(name)')
        .is('ended_at', null),
      supabase.from('bt_employees').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ])
    const firstError = deptRes.error || viewRes.error || floatRes.error
    setError(firstError ? dbErrorText(firstError, "Couldn't load the floater board") : '')
    setDepartments(deptRes.data ?? [])
    setRows(viewRes.data ?? [])
    setFloats(floatRes.data ?? [])
    setEmployeeCount(empRes.count ?? 0)
    setLoading(false)
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel('admin-floaters')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_float_assignments' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_employee_skills' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_employees' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Default to wherever the most cover is available, so the board opens
  // on something rather than an empty prompt.
  useEffect(() => {
    if (needDeptId != null || rows.length === 0) return
    const byDept = new Map()
    for (const r of rows) byDept.set(r.qualified_dept_id, (byDept.get(r.qualified_dept_id) ?? 0) + 1)
    setNeedDeptId([...byDept.entries()].sort((a, b) => b[1] - a[1])[0][0])
  }, [rows, needDeptId])

  const floatByEmployee = useMemo(() => new Map(floats.map((f) => [f.employee_id, f])), [floats])
  const deptName = useMemo(() => Object.fromEntries(departments.map((d) => [d.id, d.name])), [departments])

  // How many people each department can call on — shown on the picker,
  // so a department with nobody spare is obvious before it's clicked.
  const coverByDept = useMemo(() => {
    const out = new Map()
    for (const r of rows) {
      if (!out.has(r.qualified_dept_id)) out.set(r.qualified_dept_id, new Set())
      out.get(r.qualified_dept_id).add(r.employee_id)
    }
    return out
  }, [rows])

  // One card per person, not per function category.
  const candidates = useMemo(() => {
    const byEmployee = new Map()
    for (const r of rows) {
      if (r.qualified_dept_id !== needDeptId) continue
      const found = byEmployee.get(r.employee_id)
      if (found) {
        found.categories.add(r.function_category)
        found.max_rating = Math.max(found.max_rating, r.max_rating)
      } else {
        byEmployee.set(r.employee_id, { ...r, categories: new Set([r.function_category]) })
      }
    }
    return [...byEmployee.values()].sort(
      // Best rated first, then leads — the people you'd ask first.
      (a, b) => b.max_rating - a.max_rating || String(b.lead_level).localeCompare(String(a.lead_level)) || a.employee_name.localeCompare(b.employee_name)
    )
  }, [rows, needDeptId])

  async function startFloat(candidate) {
    if (!live) return
    setBusyId(candidate.employee_id)
    const { data: userData } = await supabase.auth.getUser()
    const { error: err } = await supabase.from('bt_float_assignments').insert({
      employee_id: candidate.employee_id,
      from_dept_id: candidate.primary_dept_id,
      to_dept_id: needDeptId,
      assigned_by: userData?.user?.id ?? null,
    })
    setBusyId(null)
    if (err) return setError(dbErrorText(err, `Couldn't float ${candidate.employee_name}`))
    setError('')
    load()
  }

  async function endFloat(floatRow) {
    if (!live) return
    setBusyId(floatRow.employee_id)
    const { error: err } = await supabase
      .from('bt_float_assignments')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', floatRow.id)
    setBusyId(null)
    if (err) return setError(dbErrorText(err, "Couldn't end that float"))
    setError('')
    load()
  }

  return (
    <div className="px-4 sm:px-6 py-5 max-w-7xl mx-auto">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-charcoal">Who can cover today?</h1>
          <p className="text-sm text-steelLight mt-1">
            People rated Specialist or better in a department that isn’t their own. Someone rated Autonomous is solid at
            their own bench — that isn’t the same as being ready to drop into another one mid-shift.
          </p>
        </div>
        <button onClick={() => setAdding(true)} className="rounded-lg bg-charcoal text-paper font-display font-bold text-sm px-4 py-2.5">
          + Add someone
        </button>
      </div>

      {error && <div className="mt-4 bg-andonRedBg border border-andonRed text-andonRed text-sm px-4 py-3 rounded">⚠ {error}</div>}

      {/* ── Out on loan right now ── */}
      {floats.length > 0 && (
        <section className="mt-5 rounded-2xl bg-andonBlueBg border border-andonBlue p-4">
          <h2 className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">Out on loan now</h2>
          <ul className="mt-2 divide-y divide-andonBlue/30">
            {floats.map((f) => (
              <li key={f.id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
                <span>
                  <b className="text-charcoal">{f.bt_employees?.name ?? `Employee ${f.employee_id}`}</b>
                  <span className="text-steel">
                    {' '}
                    — {deptName[f.from_dept_id] ?? '?'} → <b>{deptName[f.to_dept_id] ?? '?'}</b>, {ago(f.assigned_at)} ago
                  </span>
                </span>
                <button
                  onClick={() => endFloat(f)}
                  disabled={!live || busyId === f.employee_id}
                  className="rounded-lg border border-charcoal text-charcoal text-sm font-semibold px-3 py-1.5 disabled:opacity-40"
                >
                  Send back
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Which department is short ── */}
      <div className="mt-5">
        <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-steelLight mb-2">Which department is short?</div>
        <div className="flex flex-wrap gap-2">
          {departments.map((d) => {
            const cover = coverByDept.get(d.id)?.size ?? 0
            return (
              <button
                key={d.id}
                onClick={() => setNeedDeptId(d.id)}
                aria-pressed={d.id === needDeptId}
                className={`rounded-xl border px-3.5 py-2 text-left ${
                  d.id === needDeptId ? 'border-charcoal bg-charcoal text-paper' : 'border-paperDim bg-white text-charcoal'
                }`}
              >
                <div className="font-display font-bold">{d.name}</div>
                <div className={`text-xs tabular-nums ${d.id === needDeptId ? 'text-floorMute' : cover ? 'text-steelLight' : 'text-andonRed'}`}>
                  {cover ? `${cover} can cover` : 'nobody spare'}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Who can cover it ── */}
      <section className="mt-5">
        {loading ? (
          <p className="text-sm text-steelLight">Loading…</p>
        ) : employeeCount === 0 ? (
          <Empty
            title="No people on file yet"
            body="The skill matrix is empty, so there's nobody to call on. Add a few people with “Add someone” — name, their own department, and what they're rated in elsewhere."
          />
        ) : candidates.length === 0 ? (
          <Empty
            title={`Nobody is rated to cover ${deptName[needDeptId] ?? 'that department'}`}
            body="Either no one has been rated Specialist or better here, or everyone who is already works here. Rating someone 3 or 4 in this department puts them on this board."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {candidates.map((c) => {
              const out = floatByEmployee.get(c.employee_id)
              const elsewhere = out && out.to_dept_id !== needDeptId
              return (
                <article
                  key={c.employee_id}
                  className={`rounded-xl border p-4 ${elsewhere ? 'border-paperDim bg-paper' : 'border-paperDim bg-white'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-display font-bold text-lg text-charcoal truncate">{c.employee_name}</div>
                      <div className="text-xs text-steelLight">
                        {c.primary_dept ?? 'no home department'}
                        {c.badge_id ? ` · ${c.badge_id}` : ''}
                        {c.shift ? ` · ${c.shift}` : ''}
                      </div>
                    </div>
                    {LEAD_LABEL[c.lead_level] && (
                      <span className="shrink-0 rounded-md bg-charcoal text-paper text-xs font-bold px-2 py-0.5">
                        {LEAD_LABEL[c.lead_level]}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                        c.max_rating >= 4 ? 'bg-andonGreenBg text-andonGreen' : 'bg-safety/25 text-safetyDark'
                      }`}
                    >
                      {RATING_LABEL[c.max_rating] ?? `Rating ${c.max_rating}`}
                    </span>
                    {[...c.categories].map((cat) => (
                      <span key={cat} className="rounded-md border border-paperDim text-xs text-steel px-2 py-0.5">
                        {cat}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3">
                    {elsewhere ? (
                      <p className="text-sm text-steelLight">
                        Already out in <b className="text-steel">{c.currently_floated_to}</b> — send them back first.
                      </p>
                    ) : out ? (
                      <button
                        onClick={() => endFloat(out)}
                        disabled={!live || busyId === c.employee_id}
                        className="w-full rounded-lg border border-charcoal text-charcoal font-display font-bold px-4 py-2.5 disabled:opacity-40"
                      >
                        Here now — send back
                      </button>
                    ) : (
                      <button
                        onClick={() => startFloat(c)}
                        disabled={!live || busyId === c.employee_id}
                        className="w-full rounded-lg bg-safety text-charcoal font-display font-bold px-4 py-2.5 disabled:opacity-40"
                      >
                        {busyId === c.employee_id ? 'Moving…' : `Float to ${deptName[needDeptId] ?? ''}`}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {adding && (
        <AddPersonModal
          departments={departments}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            load()
          }}
        />
      )}
    </div>
  )
}

function Empty({ title, body }) {
  return (
    <div className="rounded-2xl border border-dashed border-paperDim p-6 text-center">
      <div className="font-display font-bold text-xl text-charcoal">{title}</div>
      <p className="text-sm text-steelLight mt-1 max-w-xl mx-auto">{body}</p>
    </div>
  )
}

/**
 * Enough to get someone onto the board: who they are, where they
 * normally work, and one department they're rated to cover. The full
 * matrix — every skill, every rating — is a screen of its own; this is
 * the short path so the board isn't unusable until that exists.
 *
 * A rating hangs off a skill, not a department, so a department with no
 * skills on file yet gets one created here and named.
 */
function AddPersonModal({ departments, onClose, onSaved }) {
  const [name, setName] = useState('')
  const [badge, setBadge] = useState('')
  const [primaryDeptId, setPrimaryDeptId] = useState('')
  const [leadLevel, setLeadLevel] = useState('NONE')
  const [shift, setShift] = useState('Day')
  const [coverDeptId, setCoverDeptId] = useState('')
  const [skills, setSkills] = useState([])
  const [skillId, setSkillId] = useState('')
  const [newSkill, setNewSkill] = useState('')
  const [category, setCategory] = useState('ASSEMBLY')
  const [rating, setRating] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!coverDeptId) return setSkills([])
    supabase
      .from('bt_skills')
      .select('id, name')
      .eq('department_id', Number(coverDeptId))
      .order('sort_order')
      .then(({ data }) => {
        setSkills(data ?? [])
        setSkillId('')
      })
  }, [coverDeptId])

  async function save() {
    if (!name.trim()) return setError('A name is needed.')
    setBusy(true)
    setError('')
    try {
      const { data: emp, error: empErr } = await supabase
        .from('bt_employees')
        .insert({
          name: name.trim(),
          employee_id: badge.trim() || null,
          primary_dept_id: primaryDeptId ? Number(primaryDeptId) : null,
          lead_level: leadLevel,
          shift,
        })
        .select('id')
        .single()
      if (empErr) throw empErr

      // The rating is optional — someone can be on file before anyone
      // has assessed them.
      if (coverDeptId) {
        let useSkillId = skillId ? Number(skillId) : null
        if (!useSkillId) {
          const skillName = newSkill.trim() || 'General'
          const { data: sk, error: skErr } = await supabase
            .from('bt_skills')
            .upsert(
              { department_id: Number(coverDeptId), name: skillName, function_category: category },
              { onConflict: 'department_id,name' }
            )
            .select('id')
            .single()
          if (skErr) throw skErr
          useSkillId = sk.id
        }
        const { data: userData } = await supabase.auth.getUser()
        const { error: rateErr } = await supabase
          .from('bt_employee_skills')
          .insert({ employee_id: emp.id, skill_id: useSkillId, rating: Number(rating), rated_by: userData?.user?.id ?? null })
        if (rateErr) throw rateErr
      }
      onSaved()
    } catch (err) {
      setError(dbErrorText(err, "Couldn't save"))
    } finally {
      setBusy(false)
    }
  }

  const coversOwnDept = coverDeptId && primaryDeptId && coverDeptId === primaryDeptId

  return (
    <div className="fixed inset-0 bg-charcoal/60 z-[80] grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-paperDim">
          <h2 className="font-display font-bold text-2xl text-charcoal">Add someone</h2>
        </div>
        <div className="px-5 py-4 grid gap-3">
          <label className="text-sm text-steel">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-steel">
              Badge / payroll ID <span className="text-steelLight">(optional)</span>
              <input value={badge} onChange={(e) => setBadge(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2" />
            </label>
            <label className="text-sm text-steel">
              Shift
              <select value={shift} onChange={(e) => setShift(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white">
                {['Day', 'Night', 'Swing'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-steel">
              Their own department
              <select
                value={primaryDeptId}
                onChange={(e) => setPrimaryDeptId(e.target.value)}
                className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white"
              >
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-steel">
              Lead level
              <select value={leadLevel} onChange={(e) => setLeadLevel(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white">
                {Object.entries(LEAD_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label || 'Not a lead'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="rounded-lg border border-paperDim p-3 grid gap-3">
            <legend className="text-sm font-semibold text-steel px-1">Rated to cover <span className="font-normal text-steelLight">(optional)</span></legend>
            <label className="text-sm text-steel">
              Department
              <select value={coverDeptId} onChange={(e) => setCoverDeptId(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white">
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {coversOwnDept && (
              <p className="text-sm text-safetyDark bg-safety/15 rounded px-3 py-2">
                That’s their own department, so it won’t put them on this board — the board is for covering somewhere else.
                Still worth recording.
              </p>
            )}
            {coverDeptId && (
              <>
                <label className="text-sm text-steel">
                  Skill
                  <select value={skillId} onChange={(e) => setSkillId(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white">
                    <option value="">Add a new one…</option>
                    {skills.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!skillId && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-sm text-steel">
                      New skill name
                      <input
                        value={newSkill}
                        onChange={(e) => setNewSkill(e.target.value)}
                        placeholder="e.g. Double-Miter Saw"
                        className="mt-1 w-full border border-paperDim rounded px-3 py-2"
                      />
                    </label>
                    <label className="text-sm text-steel">
                      Track
                      <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white">
                        {['CUTTING', 'ASSEMBLY', 'QC', 'STAGING'].map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                <label className="text-sm text-steel">
                  Rating
                  <select value={rating} onChange={(e) => setRating(e.target.value)} className="mt-1 w-full border border-paperDim rounded px-3 py-2 bg-white">
                    {[1, 2, 3, 4].map((r) => (
                      <option key={r} value={r}>
                        {r} — {RATING_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </label>
                {rating < 3 && !coversOwnDept && (
                  <p className="text-sm text-steelLight">
                    Below Specialist, so they won’t appear on this board — it only lists people ready to work somewhere
                    that isn’t their own bench.
                  </p>
                )}
              </>
            )}
          </fieldset>

          {error && <div className="bg-andonRedBg text-andonRed text-sm px-3 py-2 rounded">⚠ {error}</div>}
        </div>
        <div className="px-5 py-4 border-t border-paperDim flex justify-end gap-3">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-steel">
            Cancel
          </button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-charcoal text-paper font-display font-bold px-5 py-2.5 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
