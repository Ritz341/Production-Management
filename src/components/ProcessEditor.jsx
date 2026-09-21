import { useState } from 'react'
import { fmtQty, planLine, processesFor, workingHoursPerDay } from '../lib/catalog'

/**
 * Admin: a department's processes (stations) with each one's rate per
 * person per hour, and the day's plan worked out underneath from the
 * crew entered for today — daily target per process, what that means in
 * finished units, and the bottleneck.
 */
export default function ProcessEditor({ department, settings, peopleToday, onSave }) {
  const saved = processesFor(settings, department.name)
  const [rows, setRows] = useState(saved)
  const [dirty, setDirty] = useState(false)
  const plan = planLine(rows, peopleToday, settings)
  const finishedUnit = rows[rows.length - 1]?.unit ?? 'units'

  function update(i, patch) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  function add() {
    setRows((prev) => [...prev, { id: `step_${Date.now()}`, name: 'New step', unit: finishedUnit, ratePerHour: null, perFinished: 1 }])
    setDirty(true)
  }
  function remove(i) {
    setRows((prev) => prev.filter((_, j) => j !== i))
    setDirty(true)
  }
  function move(i, dir) {
    setRows((prev) => {
      const next = [...prev]
      const j = i + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setDirty(true)
  }

  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-steelLight">
            <tr>
              <th className="py-1 pr-2 font-semibold">Process (in order)</th>
              <th className="py-1 px-2 font-semibold">Unit</th>
              <th className="py-1 px-2 font-semibold">Per person / hour</th>
              <th className="py-1 px-2 font-semibold" title="How many of this step's units make one finished unit — e.g. 4 vents per insert">
                Per finished
              </th>
              <th className="py-1 px-2 font-semibold text-right">People today</th>
              <th className="py-1 px-2 font-semibold text-right">Target today</th>
              <th className="py-1 pl-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-paperDim">
            {plan.steps.map((st, i) => (
              <tr key={st.id} className={plan.bottleneck?.id === st.id ? 'bg-andonRedBg' : ''}>
                <td className="py-1.5 pr-2">
                  <input
                    value={st.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    aria-label="Process name"
                    className="w-full min-w-[9rem] rounded border border-paperDim px-2 py-1"
                  />
                </td>
                <td className="py-1.5 px-2">
                  <input value={st.unit} onChange={(e) => update(i, { unit: e.target.value })} aria-label="Unit" className="w-20 rounded border border-paperDim px-2 py-1" />
                </td>
                <td className="py-1.5 px-2">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={st.ratePerHour ?? ''}
                    onChange={(e) => update(i, { ratePerHour: e.target.value === '' ? null : Number(e.target.value) })}
                    placeholder="set"
                    aria-label="Rate per person per hour"
                    className={`w-20 rounded border px-2 py-1 tabular-nums ${st.ratePerHour ? 'border-paperDim' : 'border-safety bg-safety/10'}`}
                  />
                </td>
                <td className="py-1.5 px-2">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={st.perFinished ?? 1}
                    onChange={(e) => update(i, { perFinished: Number(e.target.value) || 1 })}
                    aria-label="Units per finished unit"
                    className="w-16 rounded border border-paperDim px-2 py-1 tabular-nums"
                  />
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{st.people ?? '—'}</td>
                <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                  {st.daily == null ? (
                    <span className="text-steelLight">—</span>
                  ) : (
                    <>
                      <b>{fmtQty(st.daily)}</b> {st.unit}
                      {Number(st.perFinished) > 1 && (
                        <span className="block text-xs text-steelLight">
                          = {fmtQty(st.finished)} {finishedUnit}
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="py-1.5 pl-2 whitespace-nowrap text-right">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-steel disabled:opacity-20" aria-label="Move up">
                    ▲
                  </button>
                  <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="px-1 text-steel disabled:opacity-20" aria-label="Move down">
                    ▼
                  </button>
                  <button onClick={() => remove(i)} className="px-1.5 text-andonRed" aria-label={`Remove ${st.name}`}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <button onClick={add} className="text-sm font-semibold text-andonBlue">
          + Add a process
        </button>
        {dirty && (
          <div className="flex gap-2">
            <button
              onClick={() => {
                setRows(saved)
                setDirty(false)
              }}
              className="text-sm text-steelLight px-3"
            >
              Undo changes
            </button>
            <button
              onClick={async () => {
                if (await onSave(rows)) setDirty(false)
              }}
              className="rounded-lg bg-charcoal text-paper text-sm font-semibold px-4 py-2"
            >
              Save processes
            </button>
          </div>
        )}
      </div>

      {/* ── The day, worked out ── */}
      <div className="mt-3 rounded-lg bg-paper border border-paperDim px-3 py-2 text-sm">
        {plan.capacity != null ? (
          <>
            <b className="text-charcoal">
              Line can finish {fmtQty(plan.capacity)} {finishedUnit} today
            </b>{' '}
            — <span className="text-andonRed font-semibold">{plan.bottleneck.name}</span> is the bottleneck.
            <span className="block text-xs text-steelLight mt-0.5">
              Daily target = people × per person per hour × {fmtQty(workingHoursPerDay(settings))} working hours. Set crew per process
              on the Overview → Crew today.
            </span>
          </>
        ) : (
          <span className="text-steelLight">
            {rows.some((r) => !r.ratePerHour)
              ? 'Set a rate per person per hour for every process to see the day’s target and bottleneck.'
              : 'Enter people per process on the Overview → Crew today to see today’s target and bottleneck.'}
          </span>
        )}
      </div>
    </div>
  )
}
