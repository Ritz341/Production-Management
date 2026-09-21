import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { clockLabel, rateFor, useSettings } from '../lib/catalog'

const ZONES = [
  ['today', 'Finished today', 'The big number, against the day’s target from Crew today.'],
  ['blocks', '2-hour blocks', 'Each count check-in against its target: green met, amber close, red short, flashing red if the update is late.'],
  ['queue', 'Build next', 'The next six orders in build order, with the first one highlighted.'],
  ['problems', 'Problems', 'Blocked jobs with their reason. Shows “All clear” when there are none.'],
]

/**
 * Admin control for the shop-floor TVs: what each board shows and a
 * message across the bottom. Saved in bt_settings, so the boards pick
 * changes up within seconds without touching the PCs.
 */
export default function AdminTVs() {
  const { live } = useConnection()
  const settings = useSettings()
  const [departments, setDepartments] = useState([])
  const [boards, setBoards] = useState({})
  const [status, setStatus] = useState('')

  useEffect(() => {
    supabase.from('bt_departments').select('id, name').order('sort_order').then(({ data }) => setDepartments(data ?? []))
  }, [])
  useEffect(() => setBoards(settings.tv_boards ?? {}), [settings.tv_boards])

  // Any settings key — rates, check-in times, boards — saved the same way.
  async function saveSetting(key, value, message = 'Saved — the TVs update in a few seconds') {
    if (!live) return false
    const { error } = await supabase.from('bt_settings').upsert({ key, value }, { onConflict: 'key' })
    setStatus(error ? `Couldn't save: ${error.message}` : message)
    setTimeout(() => setStatus(''), 4000)
    return !error
  }

  async function saveRate(deptName, patch) {
    const current = settings.rates ?? {}
    const merged = { ...rateFor(settings, deptName), ...(current[deptName] ?? {}), ...patch }
    const next = { ...current, [deptName]: { perPerson: merged.perPerson === '' ? null : merged.perPerson, unit: merged.unit } }
    const ok = await saveSetting('rates', next)
    // The order estimates use mods_per_person_day; keep it in step with the Mods rate.
    if (ok && deptName === 'Mods' && merged.perPerson) await saveSetting('mods_per_person_day', Number(merged.perPerson))
  }

  async function saveCheckins(text) {
    const times = text
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const m = t.match(/^(\d{1,2}):?(\d{2})$/)
        if (!m) return null
        let h = Number(m[1])
        if (h < 7) h += 12 // "1:30" on a shop floor means the afternoon
        return `${String(h).padStart(2, '0')}:${m[2]}`
      })
    if (times.some((t) => t == null) || times.length === 0) {
      setStatus('Check-in times look wrong — use times like 9:30, 11:30, 1:30, 4:00')
      return
    }
    await saveSetting('checkin_times', [...new Set(times)].sort())
  }

  async function save(next) {
    setBoards(next)
    if (!live) return
    const { error } = await supabase.from('bt_settings').upsert({ key: 'tv_boards', value: next }, { onConflict: 'key' })
    setStatus(error ? `Couldn't save: ${error.message}` : 'Saved — the TVs update in a few seconds')
    setTimeout(() => setStatus(''), 4000)
  }

  const boardUrl = (name) => `${window.location.origin}/?tv=${encodeURIComponent(name)}`

  return (
    <div className="px-4 sm:px-6 py-5 max-w-4xl mx-auto space-y-4">
      <section className="rounded-2xl bg-white border border-paperDim p-5">
        <h2 className="font-display font-bold text-3xl uppercase tracking-wide text-charcoal">Shop-floor TVs</h2>
        <p className="text-sm text-steelLight mt-1">
          Each TV shows one department. Set it up once on that PC, then control it from here — it's read-only, so nobody
          can change a job from the TV.
        </p>
        {status && <p className="mt-2 text-sm font-semibold text-andonGreen">{status}</p>}
      </section>

      {departments.map((d) => {
        const b = boards[d.name] ?? {}
        const set = (patch) => save({ ...boards, [d.name]: { ...b, ...patch } })
        return (
          <section key={d.id} className="rounded-2xl bg-white border border-paperDim p-5">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h3 className="font-display font-bold text-2xl text-charcoal">{d.name} TV</h3>
              <code className="text-xs bg-paper border border-paperDim rounded px-2 py-1 text-steel break-all">{boardUrl(d.name)}</code>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-steel">Target:</span>
              <input
                type="number"
                min="0"
                step="0.5"
                defaultValue={rateFor(settings, d.name).perPerson ?? ''}
                key={`rate-${d.name}-${rateFor(settings, d.name).perPerson}`}
                onBlur={(e) => {
                  const v = e.target.value === '' ? '' : Number(e.target.value)
                  if (v !== (rateFor(settings, d.name).perPerson ?? '')) saveRate(d.name, { perPerson: v })
                }}
                aria-label={`${d.name} target per person per day`}
                className="w-20 rounded-lg border border-paperDim px-2 py-1.5 tabular-nums"
              />
              <input
                defaultValue={rateFor(settings, d.name).unit}
                key={`unit-${d.name}-${rateFor(settings, d.name).unit}`}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== rateFor(settings, d.name).unit && saveRate(d.name, { unit: e.target.value.trim() })}
                aria-label={`${d.name} unit`}
                className="w-28 rounded-lg border border-paperDim px-2 py-1.5"
              />
              <span className="text-steelLight">per person per day</span>
              {!rateFor(settings, d.name).perPerson && <span className="text-safetyDark font-semibold">— no target yet</span>}
            </div>

            <div className="mt-3 grid gap-2">
              {ZONES.map(([key, label, what]) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={b[key] !== false}
                    onChange={(e) => set({ [key]: e.target.checked })}
                    className="w-5 h-5 mt-0.5 accent-charcoal"
                  />
                  <span className="text-sm">
                    <b className="text-charcoal">{label}</b>
                    <span className="block text-steelLight">{what}</span>
                  </span>
                </label>
              ))}
            </div>

            <label className="block mt-3">
              <span className="text-sm font-semibold text-steel">Message across the bottom</span>
              <input
                value={b.message ?? ''}
                onChange={(e) => setBoards({ ...boards, [d.name]: { ...b, message: e.target.value } })}
                onBlur={(e) => set({ message: e.target.value.trim() || undefined })}
                placeholder="e.g. Safety meeting 2:15 — or leave blank"
                className="mt-1 w-full rounded-lg border border-paperDim px-3 py-2.5"
              />
            </label>
          </section>
        )
      })}

      <section className="rounded-2xl bg-white border border-paperDim p-5">
        <h3 className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">Count check-ins</h3>
        <p className="text-sm text-steelLight mt-1">
          When each department enters its count on the tablet. The tablet reminds them after each time, and the TV judges each
          block against the target for that time of day (breaks don't count toward the target).
        </p>
        <input
          defaultValue={(settings.checkin_times ?? []).map(clockLabel).join(', ')}
          key={(settings.checkin_times ?? []).join()}
          onBlur={(e) => saveCheckins(e.target.value)}
          aria-label="Check-in times"
          className="mt-2 w-full rounded-lg border border-paperDim px-3 py-2.5 tabular-nums"
        />
        <p className="text-xs text-steelLight mt-1">Separate with commas, e.g. 9:30, 11:30, 1:30, 4:00</p>
      </section>

      <section className="rounded-2xl bg-white border border-paperDim p-5">
        <h3 className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">Setting up a TV PC (Windows)</h3>
        <ol className="mt-2 space-y-2 text-sm text-steel list-decimal pl-5">
          <li>Open Chrome on that PC, go to the site and <b>sign in once</b> with any login (the department's tablet login is fine). It stays signed in.</li>
          <li>
            Go to the address above for that department, e.g. <code className="bg-paper px-1">?tv=Mods</code>, and press <b>F11</b> for full screen.
          </li>
          <li>
            To start it automatically: right-click the desktop → <b>New → Shortcut</b> →
            <code className="block bg-paper border border-paperDim rounded px-2 py-1 my-1 text-xs break-all">
              "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs --disable-session-crashed-bubble "{boardUrl('Mods')}"
            </code>
            then press <b>Win+R</b>, type <code className="bg-paper px-1">shell:startup</code>, and drag the shortcut into that folder.
          </li>
          <li>
            Stop the screen sleeping: <b>Settings → System → Power</b> → screen and sleep both <b>Never</b>.
          </li>
          <li>If the text looks small or large from the floor, press <b>Ctrl</b> and scroll to zoom; Chrome remembers it.</li>
        </ol>
        <p className="text-xs text-steelLight mt-3">
          A board's target is the rate above × the crew you set on the Overview for today. Without a crew entry the board shows
          the count only, with no target. Changing the Mods rate also updates the order estimates.
        </p>
      </section>
    </div>
  )
}
