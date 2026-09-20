import { useState } from 'react'
import { useSettings, isoDate } from '../lib/catalog'
import { downloadWeeklyReport, weekStart } from '../lib/weeklyReport'

const SHEETS = [
  ['Summary', 'Mods built vs expected, jobs finished per department, pickups on time vs late, blocked hours by reason and department, quality issues by problem and department, and the top problems.'],
  ['Orders', 'Every order touched this week: details, difficulty and estimate, working hours per department, blocked hours, quality issues.'],
  ['Department jobs', 'Each department’s job on each order: started, finished, working hours, blocked hours, who built it.'],
  ['Blocks', 'Every block: reason, note, when it started and cleared, working hours lost.'],
  ['Quality', 'Every issue: problem, department that made it, who found it, sent back or not, how long it stayed open, how it was fixed.'],
  ['People', 'From the optional “who built it” names: jobs and mods per person, and quality issues on their work.'],
  ['Crew', 'People per department per day, with the Mods target.'],
  ['Activity log', 'Every recorded action in the week, in order.'],
]

/** Admin only: pick a week and download the production report. */
export default function AdminReports() {
  const settings = useSettings()
  const thisMonday = weekStart()
  const [monday, setMonday] = useState(() => {
    const d = new Date(thisMonday)
    d.setDate(d.getDate() - 7)
    return d
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const end = new Date(monday)
  end.setDate(end.getDate() + 7)
  const sunday = new Date(end)
  sunday.setDate(sunday.getDate() - 1)
  const fmt = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

  function shift(weeks) {
    const d = new Date(monday)
    d.setDate(d.getDate() + weeks * 7)
    setMonday(d)
  }

  async function download() {
    setBusy(true)
    setError('')
    try {
      await downloadWeeklyReport({ start: monday, end, settings })
    } catch (err) {
      setError(`Couldn't build the report: ${err.message}`)
    }
    setBusy(false)
  }

  return (
    <div className="px-4 sm:px-6 py-5 max-w-4xl mx-auto space-y-4">
      <section className="rounded-2xl bg-white border border-paperDim p-5">
        <h2 className="font-display font-bold text-3xl uppercase tracking-wide text-charcoal">Weekly report</h2>
        <p className="text-sm text-steelLight mt-1">
          An Excel file built from what the floor recorded. Hours are working hours ({settings.shift.start}–{settings.shift.end},
          breaks excluded, weekdays only).
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={() => shift(-1)} className="rounded-lg border border-paperDim px-3 py-2 text-charcoal" aria-label="Previous week">
            ←
          </button>
          <div className="font-display font-bold text-xl text-charcoal tabular-nums">
            {fmt(monday)} – {fmt(sunday)}
          </div>
          <button
            onClick={() => shift(1)}
            disabled={monday >= thisMonday}
            className="rounded-lg border border-paperDim px-3 py-2 text-charcoal disabled:opacity-30"
            aria-label="Next week"
          >
            →
          </button>
          <input
            id="report-week"
            type="date"
            value={isoDate(monday)}
            onChange={(e) => e.target.value && setMonday(weekStart(new Date(e.target.value + 'T12:00')))}
            aria-label="Pick any day in the week"
            className="rounded-lg border border-paperDim px-3 py-2 text-sm"
          />
          {monday.getTime() === thisMonday.getTime() && <span className="text-xs text-safetyDark font-semibold">This week so far</span>}
        </div>

        <button
          onClick={download}
          disabled={busy}
          className="mt-4 rounded-xl bg-safety px-6 py-3 font-display font-extrabold text-2xl uppercase tracking-wide text-charcoal disabled:opacity-50"
        >
          {busy ? 'Building…' : 'Download Excel'}
        </button>
        {error && <p className="mt-3 text-sm text-andonRed">{error}</p>}
      </section>

      <section className="rounded-2xl bg-white border border-paperDim p-5">
        <h3 className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">What's in it</h3>
        <dl className="mt-2 divide-y divide-paperDim">
          {SHEETS.map(([name, what]) => (
            <div key={name} className="py-2 grid grid-cols-[9rem_1fr] gap-3 text-sm">
              <dt className="font-semibold text-charcoal">{name}</dt>
              <dd className="text-steelLight">{what}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-steelLight mt-3">
          Admin only. Estimates use {settings.mods_per_person_day} mods per person per day until the time study numbers are in.
        </p>
      </section>
    </div>
  )
}
