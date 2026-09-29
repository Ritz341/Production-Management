import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'

// Full-width red banner, stays until Acknowledge is tapped directly on
// it — too important to bury in a dropdown. A ship date moving, and an
// order being taken off the build while someone may be part-way
// through building it, both qualify: carrying on is the wrong thing to
// do and the floor has to be stopped, not merely informed.
const BANNER_TYPES = ['ship_date_changed', 'orders_removed']
// Order status changes: quieter — a bell icon with a badge count;
// opening the dropdown and clicking an entry is what acknowledges it.
const BELL_TYPE = 'order_status_changed'

// ── One subscription for the whole screen ──
// The banner and the bell are separate components now — the bell sits
// in each page's header — but they read the same events. Two components
// joining the same realtime topic is an error, so, as with useSettings,
// one shared channel feeds every caller and is dropped with the last.
let state = { banner: [], bell: [], toasts: [] }
let channel = null
const listeners = new Set()

function set(patch) {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

function start() {
  // Anything still unacknowledged, so a change that happened while this
  // tablet was off or asleep still shows up.
  supabase
    .from('bt_events')
    .select('id, message, event_type, created_at')
    .in('event_type', BANNER_TYPES)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: true })
    .then(({ data }) => set({ banner: data ?? [] }))
  supabase
    .from('bt_events')
    .select('id, message, event_type, created_at')
    .eq('event_type', BELL_TYPE)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: false })
    .then(({ data }) => set({ bell: data ?? [] }))

  channel = supabase
    .channel('bt-events-global')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bt_events' }, ({ new: e }) => {
      if (BANNER_TYPES.includes(e.event_type)) set({ banner: [...state.banner, e] })
      else if (e.event_type === BELL_TYPE) set({ bell: [e, ...state.bell] })
      else {
        set({ toasts: [...state.toasts, { id: e.id, message: e.message, type: e.event_type }] })
        setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== e.id) }), 7000)
      }
    })
    // Another tablet acknowledging the same alert removes it here too.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bt_events' }, ({ new: e }) => {
      if (!e.acknowledged_at) return
      set({ banner: state.banner.filter((a) => a.id !== e.id), bell: state.bell.filter((a) => a.id !== e.id) })
    })
    .subscribe()
}

function useAlerts() {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    setS(state)
    if (!channel) start()
    return () => {
      listeners.delete(setS)
      if (listeners.size === 0 && channel) {
        supabase.removeChannel(channel)
        channel = null
        state = { banner: [], bell: [], toasts: [] }
      }
    }
  }, [])
  return s
}

async function acknowledge(id, { fromBanner }) {
  const before = state
  // Optimistic: gone at once, put back if the write fails so an alert
  // is never silently lost.
  if (fromBanner) set({ banner: state.banner.filter((a) => a.id !== id) })
  else set({ bell: state.bell.filter((a) => a.id !== id) })
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('bt_events')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userData?.user?.id })
    .eq('id', id)
  if (error) set({ banner: before.banner, bell: before.bell })
}

/**
 * Banners, toasts and the connection warning — everything that has to
 * interrupt. Render once per screen, at the top.
 */
export default function NotificationBanner() {
  const { online, live } = useConnection()
  const { banner, toasts } = useAlerts()

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
          that won't save is worth interrupting for. It used to be a
          dot pinned bottom-left, over whatever card was there. ── */}
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

      {/* ── Ship date / removed orders — full width, until Acknowledge ── */}
      {banner.length > 0 && (
        <div className="sticky top-0 z-[70] space-y-px">
          {banner.map((a) => (
            <div key={a.id} className="px-4 py-3 flex items-center justify-between gap-3 font-medium text-sm text-paper bg-andonRed">
              <span>
                {a.event_type === 'orders_removed' ? '🚫' : '📅'} {a.message}
              </span>
              <button
                onClick={() => acknowledge(a.id, { fromBanner: true })}
                className="bg-paper/90 text-charcoal text-xs font-bold px-3 py-1.5 rounded whitespace-nowrap shrink-0"
              >
                Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Ephemeral toasts — auto-dismiss ── */}
      {toasts.length > 0 && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] space-y-2 w-full max-w-md px-3">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-4 py-3 shadow-lg font-medium text-sm border-l-4 bg-white text-charcoal ${
                t.type === 'order_picked_up' ? 'border-andonBlue' : t.type === 'column_started' ? 'border-safetyDark' : 'border-andonGreen'
              }`}
            >
              {t.type === 'order_picked_up' ? '🚚 ' : t.type === 'column_started' ? '▶️ ' : '✅ '}
              {t.message}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The order-status bell, for a page header beside Sign out.
 *
 * It used to float in the bottom-left corner of every screen, which is
 * where the Blocked lane starts on a tablet, where the Grid's selection
 * boxes are, and on a phone, on top of the big Done button. A header
 * has room for it and nothing underneath it.
 */
export function NotificationBell({ tone = 'dark' }) {
  const { bell } = useAlerts()
  const [open, setOpen] = useState(false)
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
        onClick={() => setOpen((v) => !v)}
        aria-label={`Order status changes${bell.length ? ` — ${bell.length} new` : ''}`}
        aria-expanded={open}
        className={`relative w-9 h-9 rounded-full flex items-center justify-center text-base ${
          tone === 'dark' ? 'hover:bg-white/10' : 'hover:bg-charcoal/10'
        }`}
      >
        🔔
        {bell.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-andonRed text-paper text-[11px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center tabular-nums">
            {bell.length > 99 ? '99+' : bell.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[90vw] max-h-[70vh] overflow-y-auto bg-white shadow-xl border border-paperDim rounded-lg z-[75]">
          <div className="px-3 py-2 bg-charcoal text-paper text-sm font-semibold sticky top-0 rounded-t-lg">
            Order status changes ({bell.length})
          </div>
          {bell.length === 0 && <p className="p-4 text-sm text-steelLight">Nothing new.</p>}
          <ul>
            {bell.map((a) => (
              <li key={a.id} className="border-b border-paperDim last:border-0">
                <button
                  onClick={() => acknowledge(a.id, { fromBanner: false })}
                  className="w-full text-left px-3 py-2.5 text-sm text-charcoal hover:bg-paper flex flex-col gap-0.5"
                >
                  <span>{a.message}</span>
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
