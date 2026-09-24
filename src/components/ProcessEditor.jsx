import { Fragment, useState } from 'react'
import { RECOMMENDED_PROCESSES, fmtQty, groupByLine, planLine, processesFor, ratePerHourOf, workingHoursPerDay } from '../lib/catalog'

/**
 * Admin: a department's stations — how long one takes, which line it
 * runs on, how many orders can wait after it, and whether the tablet
 * counts it — with the day's plan worked out underneath: target per
 * station, and the bottleneck that limits the whole line.
 *
 * Lines run in parallel (V4T builds vents and frames side by side), so
 * they're grouped rather than shown as one long chain. Everything still
 * has to be done, so the slowest station anywhere sets the output.
 */
export default function ProcessEditor({ department, settings, peopleToday, onSave }) {
  const saved = processesFor(settings, department.name)
  const [rows, setRows] = useState(saved)
  const [dirty, setDirty] = useState(false)
  const plan = planLine(rows, peopleToday, settings)
  const stepById = Object.fromEntries(plan.steps.map((st) => [st.id, st]))
  const finishedUnit = rows[rows.length - 1]?.unit ?? 'units'

  const update = (id, patch) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const remove = (id) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setDirty(true)
  }
  function move(id, dir) {
    setRows((prev) => {
      const i = prev.findIndex((r) => r.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setDirty(true)
  }
  function add(line) {
    setRows((prev) => [
      ...prev,
      { id: `step_${Date.now()}`, name: 'New step', line: line ?? 'Line', unit: finishedUnit, minutesEach: null, perFinished: 1, counted: true },
    ])
    setDirty(true)
  }

  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-steelLight">
            <tr>
              <th className="py-1 pr-2 font-semibold">Station (in order)</th>
              <th className="py-1 px-2 font-semibold">Unit</th>
              <th className="py-1 px-2 font-semibold" title="How long it takes ONE person to make ONE">
                Minutes for one
              </th>
              <th className="py-1 px-2 font-semibold" title="How many of this step's units make one finished unit — 4 vents per insert">
                Per finished
              </th>
              <th className="py-1 px-2 font-semibold" title="How many orders can wait here before the next step — carts, racks or stations">
                Buffer
              </th>
              <th className="py-1 px-2 font-semibold text-center" title="Does the tablet ask for a count here?">
                Count
              </th>
              <th className="py-1 px-2 font-semibold text-right">People</th>
              <th className="py-1 px-2 font-semibold text-right">Target today</th>
              <th className="py-1 pl-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-paperDim">
            {groupByLine(rows).map((group) => (
              <Fragment key={group.line}>
                <tr className="bg-paper">
                  <td colSpan={9} className="py-1.5 pr-2">
                    <input
                      value={group.line}
                      onChange={(e) => group.steps.forEach((st) => update(st.id, { line: e.target.value }))}
                      aria-label="Line name"
                      className="font-display font-bold text-base uppercase tracking-wide bg-transparent border-b border-dashed border-paperDim px-1"
                    />
                    <span className="text-xs text-steelLight ml-2">{group.steps.length} stations</span>
                  </td>
                </tr>
                {group.steps.map((r) => {
                  const st = stepById[r.id] ?? r
                  return (
                    <tr key={r.id} className={plan.bottleneck?.id === r.id ? 'bg-andonRedBg' : ''}>
                      <td className="py-1.5 pr-2">
                        <input
                          value={r.name}
                          onChange={(e) => update(r.id, { name: e.target.value })}
                          aria-label="Station name"
                          className="w-full min-w-[11rem] rounded border border-paperDim px-2 py-1"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input value={r.unit} onChange={(e) => update(r.id, { unit: e.target.value })} aria-label="Unit" className="w-20 rounded border border-paperDim px-2 py-1" />
                      </td>
                      <td className="py-1.5 px-2 whitespace-nowrap">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={r.minutesEach ?? (r.ratePerHour ? Math.round(60 / r.ratePerHour) : '')}
                          onChange={(e) => update(r.id, { minutesEach: e.target.value === '' ? null : Number(e.target.value), ratePerHour: undefined })}
                          placeholder="min"
                          aria-label={`Minutes for one — ${r.name}`}
                          className={`w-[4.5rem] rounded border px-2 py-1 tabular-nums ${ratePerHourOf(r) ? 'border-paperDim' : 'border-safety bg-safety/10'}`}
                        />
                        {ratePerHourOf(r) && <span className="block text-xs text-steelLight tabular-nums">= {fmtQty(ratePerHourOf(r))} / hr</span>}
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={r.perFinished ?? 1}
                          onChange={(e) => update(r.id, { perFinished: Number(e.target.value) || 1 })}
                          aria-label="Units per finished unit"
                          className="w-14 rounded border border-paperDim px-2 py-1 tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={r.buffer ?? ''}
                          onChange={(e) => update(r.id, { buffer: e.target.value === '' ? undefined : Number(e.target.value) })}
                          placeholder="—"
                          aria-label={`Orders that can wait after ${r.name}`}
                          className="w-14 rounded border border-paperDim px-2 py-1 tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        <input
                          type="checkbox"
                          checked={r.counted !== false}
                          onChange={(e) => update(r.id, { counted: e.target.checked })}
                          aria-label={`Count ${r.name} on the tablet`}
                          className="w-4 h-4 accent-charcoal"
                        />
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{st.people ?? '—'}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                        {st.daily == null ? (
                          <span className="text-steelLight">—</span>
                        ) : (
                          <>
                            <b>{fmtQty(st.daily)}</b> {r.unit}
                            {Number(r.perFinished) > 1 && (
                              <span className="block text-xs text-steelLight">= {fmtQty(st.finished)} {finishedUnit}</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-1.5 pl-2 whitespace-nowrap text-right">
                        <button onClick={() => move(r.id, -1)} className="px-1 text-steel" aria-label={`Move ${r.name} earlier`}>
                          ▲
                        </button>
                        <button onClick={() => move(r.id, 1)} className="px-1 text-steel" aria-label={`Move ${r.name} later`}>
                          ▼
                        </button>
                        <button onClick={() => remove(r.id)} className="px-1.5 text-andonRed" aria-label={`Remove ${r.name}`}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-4">
          <button onClick={() => add(rows[rows.length - 1]?.line)} className="text-sm font-semibold text-andonBlue">
            + Add a station
          </button>
          {RECOMMENDED_PROCESSES[department.name] && (
            <button
              onClick={() => {
                // Keep any minutes already entered for stations that survive.
                const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
                setRows(RECOMMENDED_PROCESSES[department.name].map((r) => ({ ...r, minutesEach: byId[r.id]?.minutesEach ?? null })))
                setDirty(true)
              }}
              className="text-sm text-steelLight hover:text-charcoal"
            >
              Use recommended stations
            </button>
          )}
        </div>
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
              Save stations
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
              Every station has to be done, so the slowest one sets the output — whichever line it's on. Daily target = people ×
              ({fmtQty(workingHoursPerDay(settings))} working hours × 60 ÷ minutes for one). People are set on the Overview → Crew today.
            </span>
          </>
        ) : (
          <span className="text-steelLight">
            {rows.some((r) => !ratePerHourOf(r))
              ? 'Enter the minutes for one at every station to see the day’s target and bottleneck.'
              : 'Enter people per station on the Overview → Crew today to see today’s target and bottleneck.'}
          </span>
        )}
      </div>
    </div>
  )
}
