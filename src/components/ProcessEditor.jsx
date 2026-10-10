import { Fragment, useState } from 'react'
import { RECOMMENDED_PROCESSES, fmtQty, groupByLine, planLine, processesFor, ratePerHourOf, workingHoursPerDay } from '../lib/catalog'

/**
 * Admin: a department's stations — how long one takes, which line it
 * runs on, how many orders can wait after it, and whether the tablet
 * counts it — with the day's plan worked out underneath: target per
 * station, and the bottleneck that limits the whole line.
 *
 * Lines are grouped rather than shown as one long chain. Whether the
 * slowest station anywhere sets the output, or each line answers only
 * for itself, depends on whether the lines feed each other — V4T's
 * vents and frames both go into assembly; Panel's three benches never
 * meet. See planLine().
 */
/** "mods" and "Mods " are the same unit; "frames" and "mods" aren't. */
function sameUnit(a, b) {
  const norm = (u) => singular(String(u ?? '').trim().toLowerCase())
  return norm(a) !== '' && norm(a) === norm(b)
}

/** "mods" -> "mod", so a hint reads "3 frames = 1 mod". */
function singular(unit) {
  const u = String(unit ?? '')
  return u.endsWith('s') && !u.endsWith('ss') ? u.slice(0, -1) : u
}

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
      {
        id: `step_${Date.now()}`,
        name: 'New step',
        line: line ?? 'Line',
        unit: finishedUnit,
        minutesEach: null,
        perFinished: 1,
        counted: true,
        // Inherit it, or a station added to a department of standalone
        // benches would read as a chain and re-link all of them.
        independent: prev[prev.length - 1]?.independent,
      },
    ])
    setDirty(true)
  }

  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-steelLight">
            <tr className="align-top">
              <Th cls="pr-2" hint="in the order they happen">Station</Th>
              <Th hint="what it makes">Unit</Th>
              <Th hint="one person, making one">Minutes for one</Th>
              <Th hint="e.g. 4 vents → 1 insert; 2.5 is fine">Per finished</Th>
              <Th hint="orders that can wait here">Buffer</Th>
              <Th cls="text-center" hint="tablet asks for a count">Count</Th>
              <Th cls="text-right" hint="from Crew today">People</Th>
              <Th cls="text-right" hint="pieces">Target today</Th>
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
                    <tr key={r.id} className={st.isBottleneck ? 'bg-andonRedBg' : ''}>
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
                          min="0.1"
                          step="0.5"
                          value={r.perFinished ?? 1}
                          onChange={(e) => update(r.id, { perFinished: Number(e.target.value) || 1 })}
                          aria-label="Units per finished unit"
                          className="w-16 rounded border border-paperDim px-2 py-1 tabular-nums"
                        />
                        {sameUnit(r.unit, finishedUnit) && Number(r.perFinished ?? 1) !== 1 ? (
                          // A station that already makes the finished thing
                          // can't take two of it to make one — this is how a
                          // Mods line ended up reporting half its output.
                          <span className="block text-xs font-semibold text-andonRed max-w-[9rem]" title={`This station already makes ${finishedUnit}, so one of them is one finished — Per finished should be 1.`}>
                            ⚠ Should be 1 — already in {finishedUnit}
                          </span>
                        ) : (
                          Number(r.perFinished) > 1 && (
                            <span className="block text-xs text-steelLight">
                              {fmtQty(r.perFinished)} {r.unit} = 1 {singular(finishedUnit)}
                            </span>
                          )
                        )}
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
          plan.independent ? (
            <>
              <b className="text-charcoal">
                {plan.lines.length} benches can finish {fmtQty(plan.capacity)} {finishedUnit} today
              </b>
              <span className="block text-xs text-charcoal mt-1">
                {plan.lines
                  .map(
                    (l) =>
                      `${l.line}: ${fmtQty(l.capacity)}` +
                      (l.steps.length > 1 ? ` (${l.bottleneck.name} is slowest)` : '')
                  )
                  .join(' · ')}
              </span>
              <span className="block text-xs text-steelLight mt-0.5">
                These benches don’t feed each other, so each one’s slowest station holds up only itself — nobody waits on
                the others. Daily target = people × ({fmtQty(workingHoursPerDay(settings))} working hours × 60 ÷ minutes
                for one). People are set on the Overview → Crew today.
              </span>
            </>
          ) : (
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
          )
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

// A column heading with its one-line explanation under it.
function Th({ children, hint, cls = '' }) {
  return (
    <th className={`py-1 px-2 font-semibold ${cls}`}>
      {children}
      <span className="block normal-case tracking-normal font-normal text-[11px] leading-tight text-steelLight/80 mt-0.5 max-w-[7.5rem]">
        {hint}
      </span>
    </th>
  )
}
