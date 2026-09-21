import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { useSettings } from '../lib/catalog'

const ZONES = [
  ['today', 'Finished today', 'The big number, against the day’s target from Crew today.'],
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
          Targets use {settings.mods_per_person_day} mods per person per day and the crew you set on the Overview. Without a
          crew entry the board shows the count only, with no target.
        </p>
      </section>
    </div>
  )
}
