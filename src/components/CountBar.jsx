import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { checkinBlocks, clockLabel, isoDate, rateFor, useSettings } from '../lib/catalog'

/**
 * On the floor tablet: how many this department has finished today, a
 * big button to update it, and a reminder when a check-in is due. The
 * TV board turns each 2-hour block green / amber / red from these.
 *
 * `departments` is [{ id, name }] — the tablet's own departments.
 */
export default function CountBar({ departments, live }) {
  const settings = useSettings()
  const [latest, setLatest] = useState({}) // departmentId -> { count, at }
  const [editing, setEditing] = useState(null) // department being updated
  const [now, setNow] = useState(new Date())
  const today = isoDate(new Date())
  const ids = departments.map((d) => d.id)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!ids.length) return
    let alive = true
    async function load() {
      const { data } = await supabase
        .from('bt_output_counts')
        .select('department_id, count, at')
        .in('department_id', ids)
        .eq('work_date', today)
        .order('at')
      if (!alive) return
      const map = {}
      for (const r of data ?? []) map[r.department_id] = { count: Number(r.count), at: new Date(r.at) }
      setLatest(map)
    }
    load()
    const channel = supabase
      .channel(`counts-${ids.join('-')}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_output_counts' }, load)
      .subscribe()
    return () => {
      alive = false
      supabase.removeChannel(channel)
    }
  }, [ids.join(','), today])

  // A check-in is due once a block has ended and nothing's been entered
  // since shortly before it.
  const dueAt = useMemo(() => {
    const ended = checkinBlocks(settings, null).filter((b) => b.end <= now)
    return ended.length ? ended[ended.length - 1].end : null
  }, [settings, now])

  if (!departments.length) return null

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {departments.map((d) => {
        const last = latest[d.id]
        const unit = rateFor(settings, d.name).unit
        const due = dueAt && (!last || last.at < new Date(dueAt.getTime() - 60 * 60000))
        return (
          <button
            key={d.id}
            onClick={() => setEditing(d)}
            disabled={!live}
            className={`flex items-center gap-3 rounded-xl border-2 px-4 py-2.5 text-left disabled:opacity-40 ${
              due ? 'border-safety bg-safety text-charcoal animate-pulse' : 'border-floorLine bg-floorCard text-paper'
            }`}
          >
            <span className="font-display font-extrabold text-3xl leading-none tabular-nums">{last ? last.count : '—'}</span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">
                {departments.length > 1 ? `${d.name} ` : ''}
                {unit} done today
              </span>
              <span className={`block text-xs ${due ? 'font-bold' : 'text-floorMute'}`}>
                {due
                  ? `Tap to update — was due ${clockLabel(`${String(dueAt.getHours()).padStart(2, '0')}:${String(dueAt.getMinutes()).padStart(2, '0')}`)}`
                  : last
                    ? `Updated ${last.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · tap to update`
                    : 'Tap to enter your count'}
              </span>
            </span>
          </button>
        )
      })}

      {editing && (
        <CountModal
          department={editing}
          unit={rateFor(settings, editing.name).unit}
          current={latest[editing.id]?.count ?? 0}
          today={today}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function CountModal({ department, unit, current, today, onClose }) {
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setBusy(true)
    setError('')
    // The date comes from the tablet, not the server: the database runs
    // on UTC, which rolls over to tomorrow during a late local evening.
    const { error: err } = await supabase.from('bt_output_counts').insert({ department_id: department.id, count: value, work_date: today })
    setBusy(false)
    if (err) return setError(err.message.includes('row-level security') ? `This tablet isn't set up for ${department.name}. Ask admin.` : err.message)
    onClose()
  }

  const step = (n) => setValue((v) => Math.max(0, Math.round((Number(v) + n) * 10) / 10))

  return (
    <div className="fixed inset-0 bg-black/70 grid place-items-center z-[90] p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-floorCard border border-floorLine p-6 text-paper" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display font-extrabold uppercase text-3xl">
          {department.name}: {unit} done today
        </h2>
        <p className="text-floorMute mt-1">The total so far today, not since the last update.</p>

        <div className="mt-5 flex items-center justify-center gap-4">
          <button onClick={() => step(-1)} className="w-16 h-16 rounded-xl bg-floorLine font-display font-extrabold text-4xl" aria-label="One less">
            −
          </button>
          <input
            id="count-value"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.5"
            value={value}
            onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
            aria-label={`${unit} done today`}
            className="w-32 rounded-xl bg-floor border-2 border-floorLine text-center font-display font-extrabold text-6xl py-2 tabular-nums"
          />
          <button onClick={() => step(1)} className="w-16 h-16 rounded-xl bg-floorLine font-display font-extrabold text-4xl" aria-label="One more">
            +
          </button>
        </div>

        {error && <p className="text-[#FF8A8A] text-sm mt-3">{error}</p>}

        <div className="mt-6 flex gap-2">
          <button onClick={onClose} className="flex-1 py-3 text-floorMute">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || value === '' || value < 0}
            className="flex-[2] rounded-xl bg-safety text-charcoal font-display font-extrabold text-2xl uppercase py-3 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save count'}
          </button>
        </div>
      </div>
    </div>
  )
}
