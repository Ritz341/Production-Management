import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { isMuted, playAlert, setMuted } from '../lib/alertSound'

/**
 * Notifications.
 *
 * Every event is written with a LEVEL and an AUDIENCE by the database
 * (schema_v22.sql — one place decides, so this file never guesses):
 *
 *   stop     a red banner that stays until THIS login taps "Got it".
 *            A ship date moving, orders taken off the build, a quality
 *            problem. Beeps when it arrives.
 *   headsup  the bell: a block, or a job another department was waiting
 *            on finishing. Cleared one at a time or all at once; gone
 *            after 12 hours either way.
 *   fyi      a toast for a few seconds: a new order, a pickup.
 *   quiet    nothing here — still in the admin activity feed.
 *
 * An event is for a login when its audience has 'all', the login's
 * 'role:<role>', or 'dept:<name>' for any department the login works.
 * Acknowledging is per login (bt_event_acks), so one tablet tapping
 * "Got it" no longer clears the alert off every other tablet unseen.
 */

const STOP_WINDOW_MS = 24 * 3600 * 1000
const HEADSUP_WINDOW_MS = 12 * 3600 * 1000
const TOAST_MS = 6000

// ── One subscription for the whole screen ──
// The banner and the bell are separate components — the bell sits in each
// page's header — but read the same events. Two components joining one
// realtime topic is an error, so one shared channel feeds every caller
// and is dropped with the last.
let state = { stop: [], headsup: [], toasts: [] }
let channel = null
let current = { key: null, me: null }
const listeners = new Set()

function set(patch) {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

const forMe = (e, tokens) => (e.audience ?? []).some((t) => t === 'all' || tokens.includes(t))
const pgArray = (tokens) => `{${tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(',')}}`

async function start(me) {
  const since = (ms) => new Date(Date.now() - ms).toISOString()
  const cols = 'id, message, event_type, kind, level, audience, created_at'

  // Anything still unanswered, so an alert raised while this tablet was
  // asleep or off is waiting when it wakes.
  const { data: acked } = await supabase.from('bt_event_acks').select('event_id').gte('acked_at', since(STOP_WINDOW_MS * 2))
  const ackedIds = new Set((acked ?? []).map((a) => a.event_id))
  const { data: rows } = await supabase
    .from('bt_events')
    .select(cols)
    .in('level', ['stop', 'headsup'])
    .gte('created_at', since(STOP_WINDOW_MS))
    .overlaps('audience', pgArray(['all', ...me.tokens]))
    .order('created_at', { ascending: true })
  if (current.me !== me) return // signed out / switched while loading
  const open = (rows ?? []).filter((e) => !ackedIds.has(e.id))
  set({
    stop: open.filter((e) => e.level === 'stop'),
    headsup: open
      .filter((e) => e.level === 'headsup' && Date.now() - new Date(e.created_at) < HEADSUP_WINDOW_MS)
      .reverse(),
  })

  channel = supabase
    .channel(`bt-alerts-${me.userId ?? 'anon'}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bt_events' }, ({ new: e }) => {
      if (e.level === 'quiet' || !forMe(e, me.tokens)) return
      if (e.level === 'stop') {
        set({ stop: [...state.stop, e] })
        playAlert('stop')
      } else if (e.level === 'headsup') {
        set({ headsup: [e, ...state.headsup] })
        playAlert('headsup')
      } else {
        set({ toasts: [...state.toasts, e] })
        setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== e.id) }), TOAST_MS)
      }
    })
    // The same login on another device answering an alert answers it here.
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bt_event_acks' }, ({ new: a }) => {
      if (a.user_id !== me.userId) return
      set({ stop: state.stop.filter((e) => e.id !== a.event_id), headsup: state.headsup.filter((e) => e.id !== a.event_id) })
    })
    .subscribe()
}

function stop() {
  if (channel) supabase.removeChannel(channel)
  channel = null
  current = { key: null, me: null }
  state = { stop: [], headsup: [], toasts: [] }
}

/** This login's audience tokens: its role and every department it works. */
function useMe() {
  const { session, profile } = useAuth() ?? {}
  const [deptNames, setDeptNames] = useState([])
  const ids = (profile?.combinedDepartmentIds ?? []).join(',')

  useEffect(() => {
    if (!ids) return setDeptNames([])
    let alive = true
    supabase
      .from('bt_departments')
      .select('name')
      .in('id', ids.split(',').map(Number))
      .then(({ data }) => alive && setDeptNames((data ?? []).map((d) => d.name)))
    return () => {
      alive = false
    }
  }, [ids])

  const tokens = [...(profile?.role ? [`role:${profile.role}`] : []), ...deptNames.map((n) => `dept:${n}`)]
  return { userId: session?.user?.id ?? null, tokens, key: `${session?.user?.id}|${tokens.join(',')}` }
}

function useAlerts() {
  const me = useMe()
  const [s, setS] = useState(state)

  useEffect(() => {
    listeners.add(setS)
    setS(state)
    return () => {
      listeners.delete(setS)
      if (listeners.size === 0) stop()
    }
  }, [])

  // (Re)start when the login, or the departments it works, changes.
  useEffect(() => {
    if (!me.userId || current.key === me.key) return
    if (channel) stop()
    const mine = { userId: me.userId, tokens: me.tokens }
    current = { key: me.key, me: mine }
    start(mine)
  }, [me.key])

  // Heads-ups don't pile up for ever: after 12 hours they drop off.
  useEffect(() => {
    const t = setInterval(() => {
      const keep = state.headsup.filter((e) => Date.now() - new Date(e.created_at) < HEADSUP_WINDOW_MS)
      if (keep.length !== state.headsup.length) set({ headsup: keep })
    }, 60000)
    return () => clearInterval(t)
  }, [])

  return s
}

// Gone at once; put back if the write fails, so an alert is never lost
// silently.
async function acknowledge(ids) {
  const list = Array.isArray(ids) ? ids : [ids]
  const before = state
  set({ stop: state.stop.filter((e) => !list.includes(e.id)), headsup: state.headsup.filter((e) => !list.includes(e.id)) })
  const { error } = await supabase
    .from('bt_event_acks')
    .upsert(list.map((event_id) => ({ event_id })), { onConflict: 'event_id,user_id', ignoreDuplicates: true })
  if (error) set({ stop: before.stop, headsup: before.headsup })
}

const ICON = {
  ship_date_changed: '📅',
  orders_removed: '🚫',
  quality_issue: '⚑',
  order_added: '🆕',
  order_picked_up: '🚚',
}
const headsupIcon = (e) => (e.kind === 'blocked' ? '🚫' : e.kind === 'unblocked' ? '▶️' : e.kind === 'done' ? '✅' : '🔔')

// Some messages are written with their own emoji already (⚑ Quality…,
// 🚫 Mods … BLOCKED); don't put a second one in front.
const withIcon = (icon, message) => (/^\p{Extended_Pictographic}/u.test(message) ? message : `${icon} ${message}`)

/** "V4T on TAG → Done" is only news to the department waiting on it. */
const headsupText = (e) => (e.kind === 'done' ? `Ready for you: ${e.message.replace(' → Done', ' is done')}` : e.message)

/**
 * Banners, toasts and the connection warning — everything that has to
 * interrupt. Render once per screen, at the top.
 */
export default function NotificationBanner() {
  const { online, live } = useConnection()
  const { stop: stops, toasts } = useAlerts()

  // The realtime socket takes a moment to connect on every load, which
  // used to flash "Reconnecting…" each time a screen opened. Only say
  // something once it has actually been down for a few seconds.
  const [downLong, setDownLong] = useState(false)
  useEffect(() => {
    if (live) return setDownLong(false)
    const t = setTimeout(() => setDownLong(true), online ? 4000 : 0)
    return () => clearTimeout(t)
  }, [live, online])

  return (
    <>
      {/* ── Connection — shop floor WiFi has dead zones, and WiFi can
          look connected while the realtime socket itself is dead, so
          this checks both. Silent while healthy (the header's own Live
          dot says so); a full-width strip when it isn't, because a tap
          that won't save is worth interrupting for. ── */}
      {downLong && (
        <div
          role="status"
          className={`sticky top-0 z-[71] px-4 py-2 text-sm font-bold text-paper flex items-center gap-2 ${
            online ? 'bg-safetyDark' : 'bg-andonRed'
          }`}
        >
          <span className="w-2.5 h-2.5 rounded-full bg-paper animate-pulse" />
          {online ? 'Reconnecting — changes may not save yet' : 'Offline — changes won’t save until the tablet reconnects'}
        </div>
      )}

      {/* ── Stop alerts — full width, until THIS login taps Got it ── */}
      {stops.length > 0 && (
        <div role="alert" className="sticky top-0 z-[70] space-y-px">
          {stops.map((a) => (
            <div key={a.id} className="px-4 py-3 flex items-center justify-between gap-3 font-medium text-sm text-paper bg-andonRed">
              <span>
                {withIcon(ICON[a.event_type] ?? '⚠', a.message)}
              </span>
              <button
                onClick={() => acknowledge(a.id)}
                className="bg-paper/90 text-charcoal text-xs font-bold px-3 py-1.5 rounded whitespace-nowrap shrink-0"
              >
                Got it
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── FYI toasts — a few seconds, then gone ── */}
      {toasts.length > 0 && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] space-y-2 w-full max-w-md px-3">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-4 py-3 shadow-lg font-medium text-sm border-l-4 bg-white text-charcoal ${
                t.event_type === 'order_picked_up' ? 'border-andonBlue' : 'border-andonGreen'
              }`}
            >
              {withIcon(ICON[t.event_type] ?? '•', t.message)}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The heads-up bell, for a page header beside Sign out.
 *
 * Only what concerns this login: a job it was waiting on finishing, and
 * for the office a block or an unblock. Ordinary Starts and Dones on
 * other departments' tablets never get here.
 */
export function NotificationBell({ tone = 'dark' }) {
  const { headsup } = useAlerts()
  const [open, setOpen] = useState(false)
  const [muted, setMutedState] = useState(isMuted())
  // On a tablet the bell can sit near the left edge; a menu that always
  // opens leftwards then runs off the screen. Open toward the room there is.
  const [alignLeft, setAlignLeft] = useState(false)
  const ref = useRef(null)

  // Tapping anywhere else closes it — a dropdown left open on a shared
  // tablet just sits over the work.
  useEffect(() => {
    if (!open) return
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (!open && ref.current) setAlignLeft(ref.current.getBoundingClientRect().right < 340)
          setOpen((v) => !v)
        }}
        aria-label={`Heads-up${headsup.length ? ` — ${headsup.length} new` : ''}`}
        aria-expanded={open}
        className={`relative w-9 h-9 rounded-full flex items-center justify-center text-base ${
          tone === 'dark' ? 'hover:bg-white/10' : 'hover:bg-charcoal/10'
        }`}
      >
        {muted ? '🔕' : '🔔'}
        {headsup.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-andonRed text-paper text-[11px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center tabular-nums">
            {headsup.length > 99 ? '99+' : headsup.length}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute ${alignLeft ? 'left-0' : 'right-0'} top-full mt-2 w-80 max-w-[90vw] max-h-[70vh] overflow-y-auto bg-white shadow-xl border border-paperDim rounded-lg z-[75]`}>
          <div className="px-3 py-2 bg-charcoal text-paper text-sm font-semibold sticky top-0 rounded-t-lg flex items-center justify-between gap-2">
            <span>Heads-up ({headsup.length})</span>
            <span className="flex items-center gap-3 text-xs font-normal">
              <button
                onClick={() => {
                  setMuted(!muted)
                  setMutedState(!muted)
                }}
                className="underline"
              >
                {muted ? 'Sound off' : 'Sound on'}
              </button>
              {headsup.length > 0 && (
                <button onClick={() => acknowledge(headsup.map((e) => e.id))} className="underline">
                  Clear all
                </button>
              )}
            </span>
          </div>
          {headsup.length === 0 && <p className="p-4 text-sm text-steelLight">Nothing new.</p>}
          <ul>
            {headsup.map((a) => (
              <li key={a.id} className="border-b border-paperDim last:border-0">
                <button
                  onClick={() => acknowledge(a.id)}
                  className="w-full text-left px-3 py-2.5 text-sm text-charcoal hover:bg-paper flex flex-col gap-0.5"
                >
                  <span>
                    {withIcon(headsupIcon(a), headsupText(a))}
                  </span>
                  <span className="text-xs text-steelLight">
                    {new Date(a.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} — tap to clear
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Stop alerts on a TV board. Read-only: a TV has no one to tap Got it, so
 * an alert simply stays up for four hours — long enough for everyone on the
 * floor to have walked past it — then clears itself. Everything shown here
 * is also on the tablets, where it has to be acknowledged.
 */
const TV_WINDOW_MS = 4 * 3600 * 1000
export function TVAlerts({ department }) {
  const [alerts, setAlerts] = useState([])

  useEffect(() => {
    let alive = true
    const tokens = ['all', `dept:${department}`]
    const live = (e) => e.level === 'stop' && forMe(e, tokens) && Date.now() - new Date(e.created_at) < TV_WINDOW_MS

    supabase
      .from('bt_events')
      .select('id, message, event_type, level, audience, created_at')
      .eq('level', 'stop')
      .gte('created_at', new Date(Date.now() - TV_WINDOW_MS).toISOString())
      .overlaps('audience', pgArray(tokens))
      .order('created_at', { ascending: true })
      .then(({ data }) => alive && setAlerts((data ?? []).filter(live)))

    const ch = supabase
      .channel(`tv-alerts-${department}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bt_events' }, ({ new: e }) => {
        if (live(e)) setAlerts((prev) => [...prev, e])
      })
      .subscribe()
    const t = setInterval(() => setAlerts((prev) => prev.filter(live)), 60000)
    return () => {
      alive = false
      clearInterval(t)
      supabase.removeChannel(ch)
    }
  }, [department])

  if (alerts.length === 0) return null
  // One slim strip, however many: the board underneath is laid out to fill
  // the screen, so every row added here is a row taken from it.
  return (
    <div role="alert" className="bg-andonRed text-paper px-8 py-2 font-display font-bold text-[1.6vw] leading-tight flex items-center gap-x-8 gap-y-1 flex-wrap">
      {alerts.map((a) => (
        <span key={a.id}>{withIcon(ICON[a.event_type] ?? '⚠', a.message)}</span>
      ))}
    </div>
  )
}
