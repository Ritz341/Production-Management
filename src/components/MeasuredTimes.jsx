import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { isoDate, processesFor } from '../lib/catalog'
import { BASE_NAMES, PIECE_NAMES, STEP_COLUMN, creditFor, jobTime, summarize } from '../lib/measuredTimes'

const fmtMin = (m) => (m == null ? '—' : (Math.round(m * 10) / 10).toString())
const fmtDay = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * Admin: minutes per unit measured from the clock — Start to Done on a
 * station's job, breaks and out-of-hours left out, divided by the people
 * on it that day and by what the job made (an order's 4 mods = 4 frames,
 * 8 uprights). You choose how many of the latest jobs to use, skip any
 * job that was left open by mistake, and press Use to put the figure in
 * the station's "minutes each". Nothing changes until you do.
 *
 * Also edits what a Done counts (pieces per mod / per V4T frame).
 */
export default function MeasuredTimes({ settings, departments, saveSetting, saveProcesses }) {
  const [data, setData] = useState(null) // { columns, measures, jobs, orders, quantities, crew }
  const [windowN, setWindowN] = useState('')
  const [skipped, setSkipped] = useState(new Set())
  const [open, setOpen] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => setWindowN(settings.measure_window ? String(settings.measure_window) : ''), [settings.measure_window])

  async function load() {
    const [{ data: cols }, { data: measures }] = await Promise.all([
      supabase.from('bt_status_columns').select('id, name'),
      supabase.from('bt_column_measures').select('status_column_id, measure, base_measure, factor, is_primary'),
    ])
    const columnId = Object.fromEntries((cols ?? []).map((c) => [c.name, c.id]))
    const ids = Object.values(STEP_COLUMN).map((n) => columnId[n]).filter(Boolean)
    const { data: jobs, error: jErr } = ids.length
      ? await supabase
          .from('bt_order_status')
          .select('order_id, status_column_id, started_at, completed_at')
          .in('status_column_id', ids)
          .not('started_at', 'is', null)
          .not('completed_at', 'is', null)
          .order('completed_at', { ascending: false })
          .limit(1000)
      : { data: [] }
    if (jErr) {
      setError(jErr.message)
      return
    }
    const orderIds = [...new Set((jobs ?? []).map((j) => j.order_id))]
    const [{ data: orders }, { data: quantities }] = orderIds.length
      ? await Promise.all([
          supabase.from('bt_orders').select('id, tag_name, mods_count').in('id', orderIds),
          supabase.from('bt_order_quantities').select('order_id, measure, qty').in('order_id', orderIds),
        ])
      : [{ data: [] }, { data: [] }]
    const first = (jobs ?? []).reduce((a, j) => (!a || j.started_at < a ? j.started_at : a), null)
    const since = first ? isoDate(new Date(first)) : isoDate(new Date())
    const [{ data: procDays }, { data: crewDays }] = await Promise.all([
      supabase.from('bt_process_days').select('work_date, department_id, process, people').gte('work_date', since),
      supabase.from('bt_crew_days').select('work_date, department_id, people').gte('work_date', since),
    ])
    setData({ columnId, measures: measures ?? [], jobs: jobs ?? [], orders: orders ?? [], quantities: quantities ?? [], procDays: procDays ?? [], crewDays: crewDays ?? [] })
  }
  useEffect(() => {
    load()
  }, [])

  const rows = useMemo(() => {
    if (!data) return []
    const orderById = Object.fromEntries(data.orders.map((o) => [o.id, o]))
    const qtyByOrder = {}
    for (const q of data.quantities) (qtyByOrder[q.order_id] ??= {})[q.measure] = Number(q.qty)
    const out = []
    for (const d of departments) {
      const steps = processesFor(settings, d.name).filter((s) => STEP_COLUMN[s.id])
      for (const step of steps) {
        const colId = data.columnId[STEP_COLUMN[step.id]]
        const colMeasures = data.measures.filter((m) => m.status_column_id === colId)
        const primary = colMeasures.find((m) => m.is_primary)
        // the crew on this step each day; a department with only one step
        // may also use its whole-department crew
        const crewByDay = {}
        if (steps.length === 1) for (const c of data.crewDays) if (c.department_id === d.id) crewByDay[c.work_date] = Number(c.people)
        for (const p of data.procDays) if (p.department_id === d.id && p.process === step.id) crewByDay[p.work_date] = Number(p.people)

        const all = data.jobs
          .filter((j) => j.status_column_id === colId)
          .map((j) => {
            const o = orderById[j.order_id]
            const credit = creditFor(colMeasures, o, qtyByOrder[j.order_id])
            const t = jobTime(j.started_at, j.completed_at, settings.shift, crewByDay)
            return {
              key: `${j.order_id}:${colId}`,
              tag: o?.tag_name ?? `order ${j.order_id}`,
              started: j.started_at,
              done: j.completed_at,
              ...t,
              credit,
              units: primary ? credit[primary.measure] ?? null : null,
            }
          })
        const n = Number(windowN)
        const chosen = (n > 0 ? all.slice(0, n) : all).map((j) => ({ ...j, skipped: skipped.has(j.key) }))
        out.push({ dept: d, step, primary, colMeasures, jobs: chosen, total: all.length, sum: summarize(chosen.filter((j) => !j.skipped)) })
      }
    }
    return out
  }, [data, departments, settings, windowN, skipped])

  async function use(r) {
    const value = Math.round(r.sum.minutesPerUnit * 10) / 10
    const saved = processesFor(settings, r.dept.name)
    await saveProcesses(r.dept.name, saved.map((s) => (s.id === r.step.id ? { ...s, minutesEach: value, ratePerHour: undefined } : s)))
  }

  async function saveFactor(m, value) {
    const f = Number(value)
    if (!(f >= 0) || f === Number(m.factor)) return
    const { error: e } = await supabase.from('bt_column_measures').update({ factor: f }).eq('status_column_id', m.status_column_id).eq('measure', m.measure)
    if (e) setError(e.message)
    else load()
  }

  const nameOfColumn = (id) => Object.entries(data?.columnId ?? {}).find(([, v]) => v === id)?.[0] ?? id

  return (
    <section className="rounded-2xl bg-white border border-paperDim p-5">
      <h3 className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">Measured minutes per unit</h3>
      <p className="text-sm text-steelLight mt-1">
        From the real Start and Done on each cutting job — breaks and time outside shift hours are left out, and it's divided by the
        people on that job's days (Overview → people per process) and by what the job made. Press <b>Use</b> to set a station's
        “minutes each”; nothing changes until you do.
      </p>
      {error && <p className="mt-2 text-sm text-andonRed">⚠ {error}</p>}

      <label className="flex items-center gap-2 mt-3 text-sm text-steel">
        Use the latest
        <input
          type="number"
          min="1"
          value={windowN}
          onChange={(e) => setWindowN(e.target.value)}
          onBlur={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            if (v !== (settings.measure_window ?? null)) saveSetting('measure_window', v, 'Saved')
          }}
          placeholder="all"
          aria-label="Jobs to use"
          className="w-20 rounded-lg border border-paperDim px-2 py-1.5 tabular-nums"
        />
        finished jobs per station <span className="text-steelLight">(blank = every one)</span>
      </label>

      {!data && <p className="mt-3 text-sm text-steelLight">Loading…</p>}
      {data && rows.length === 0 && <p className="mt-3 text-sm text-steelLight">No cutting stations found.</p>}

      <div className="mt-3 space-y-3">
        {rows.map((r) => {
          const key = r.step.id
          const s = r.sum
          return (
            <div key={key} className="border border-paperDim rounded-xl p-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="min-w-[11rem]">
                  <div className="font-semibold text-charcoal">{r.dept.name} · {r.step.name}</div>
                  <div className="text-xs text-steelLight">
                    {s.jobs} job{s.jobs === 1 ? '' : 's'} of {r.total}
                    {r.primary ? ` · per ${(PIECE_NAMES[r.primary.measure] ?? r.primary.measure).replace(/s$/, '')}` : ' · no unit count set'}
                  </div>
                </div>
                <div className="text-2xl font-display font-bold tabular-nums text-charcoal">
                  {s.minutesPerUnit != null ? `${fmtMin(s.minutesPerUnit)} min` : '—'}
                </div>
                <div className="text-xs text-steelLight">
                  now: {r.step.minutesEach ? `${r.step.minutesEach} min` : 'not set'}
                </div>
                <button
                  onClick={() => use(r)}
                  disabled={s.minutesPerUnit == null}
                  className="ml-auto px-3 py-1.5 rounded-lg bg-safety text-charcoal text-sm font-semibold disabled:opacity-40"
                >
                  Use {s.minutesPerUnit != null ? fmtMin(s.minutesPerUnit) : ''}
                </button>
                <button onClick={() => setOpen(open === key ? null : key)} className="text-sm text-andonBlue font-semibold">
                  {open === key ? 'Hide jobs' : 'Jobs'}
                </button>
              </div>
              {(s.noUnits > 0 || s.noCrew > 0) && (
                <p className="text-xs text-safetyDark mt-1">
                  {s.noUnits > 0 && `${s.noUnits} without a count (no mods / V4T frames on the order). `}
                  {s.noCrew > 0 && `${s.noCrew} on days with no people entered. `}
                  Those aren't in the average.
                </p>
              )}
              {open === key && (
                <table className="w-full text-sm mt-2">
                  <thead>
                    <tr className="text-left text-xs text-steelLight">
                      <th className="py-1">Use</th><th>Order</th><th>Started</th><th>Done</th><th className="text-right">Work min</th><th className="text-right">People-min</th><th className="text-right">Made</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.jobs.map((j) => (
                      <tr key={j.key} className={`border-t border-paperDim ${j.skipped ? 'opacity-40' : ''}`}>
                        <td className="py-1">
                          <input
                            type="checkbox"
                            checked={!j.skipped}
                            aria-label={`Use ${j.tag}`}
                            onChange={() => setSkipped((p) => { const n = new Set(p); n.has(j.key) ? n.delete(j.key) : n.add(j.key); return n })}
                          />
                        </td>
                        <td className="font-medium">{j.tag}</td>
                        <td>{fmtDay(j.started)}</td>
                        <td>{fmtDay(j.done)}</td>
                        <td className="text-right tabular-nums">{j.minutes}</td>
                        <td className="text-right tabular-nums">{j.missingCrew ? 'no crew' : Math.round(j.personMinutes)}</td>
                        <td className="text-right tabular-nums">{j.units ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>

      {data && (
        <div className="mt-5">
          <h4 className="font-display font-bold text-lg uppercase tracking-wide text-charcoal">What Done counts</h4>
          <p className="text-sm text-steelLight mt-1">
            When a job is Done, these pieces are added to the day's count: the number here × the order's count. An order with 4
            mods and “uprights × 2” credits 8 uprights.
          </p>
          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="text-left text-xs text-steelLight"><th className="py-1">Job</th><th>Counts</th><th className="text-right">× per</th><th></th></tr>
            </thead>
            <tbody>
              {[...data.measures]
                .sort((a, b) => nameOfColumn(a.status_column_id).localeCompare(nameOfColumn(b.status_column_id)) || (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0))
                .map((m) => (
                  <tr key={`${m.status_column_id}:${m.measure}`} className="border-t border-paperDim">
                    <td className="py-1.5">{nameOfColumn(m.status_column_id)}</td>
                    <td>{PIECE_NAMES[m.measure] ?? m.measure}{m.is_primary ? <span className="text-xs text-steelLight"> · minutes are per this</span> : ''}</td>
                    <td className="text-right">
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        defaultValue={m.factor}
                        key={`${m.measure}-${m.factor}`}
                        aria-label={`${nameOfColumn(m.status_column_id)} ${PIECE_NAMES[m.measure] ?? m.measure} per`}
                        onBlur={(e) => saveFactor(m, e.target.value)}
                        className="w-16 rounded-lg border border-paperDim px-2 py-1 tabular-nums text-right"
                      />
                    </td>
                    <td className="text-steelLight pl-2">per {BASE_NAMES[m.base_measure] ?? m.base_measure}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
