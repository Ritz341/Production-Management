import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'

// Ship date changes: full-width red banner, stays until Acknowledge is
// tapped directly on it — too important to bury in a dropdown.
const BANNER_TYPE = 'ship_date_changed'
// Order status changes: quieter — a bell icon with a badge count;
// opening the dropdown and clicking an entry is what acknowledges it.
const BELL_TYPE = 'order_status_changed'

export default function NotificationBanner() {
  const { online, live } = useConnection()
  const [bannerAlerts, setBannerAlerts] = useState([])
  const [bellAlerts, setBellAlerts] = useState([])
  const [bellOpen, setBellOpen] = useState(false)
  const [toasts, setToasts] = useState([])

  // On mount: load anything still unacknowledged, so a change that
  // happened while this tablet was off/asleep still shows up.
  useEffect(() => {
    supabase
      .from('bt_events')
      .select('id, message, event_type, created_at')
      .eq('event_type', BANNER_TYPE)
      .is('acknowledged_at', null)
      .order('created_at', { ascending: true })
      .then(({ data }) => setBannerAlerts(data ?? []))

    supabase
      .from('bt_events')
      .select('id, message, event_type, created_at')
      .eq('event_type', BELL_TYPE)
      .is('acknowledged_at', null)
      .order('created_at', { ascending: false })
      .then(({ data }) => setBellAlerts(data ?? []))
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('bt-events-global')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bt_events' }, (payload) => {
        const e = payload.new
        if (e.event_type === BANNER_TYPE) {
          setBannerAlerts((prev) => [...prev, e])
        } else if (e.event_type === BELL_TYPE) {
          setBellAlerts((prev) => [e, ...prev])
        } else {
          setToasts((prev) => [...prev, { id: e.id, message: e.message, type: e.event_type }])
          setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== e.id))
          }, 7000)
        }
      })
      // Another tablet acknowledging the same alert removes it here too.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bt_events' }, (payload) => {
        const e = payload.new
        if (e.acknowledged_at) {
          setBannerAlerts((prev) => prev.filter((a) => a.id !== e.id))
          setBellAlerts((prev) => prev.filter((a) => a.id !== e.id))
        }
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  async function acknowledge(id, { fromBanner }) {
    if (fromBanner) setBannerAlerts((prev) => prev.filter((a) => a.id !== id)) // optimistic
    else setBellAlerts((prev) => prev.filter((a) => a.id !== id))

    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase
      .from('bt_events')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userData?.user?.id })
      .eq('id', id)
    if (error) {
      // Roll back so it isn't silently lost if the write failed.
      supabase
        .from('bt_events')
        .select('id, message, event_type, created_at')
        .eq('id', id)
        .single()
        .then(({ data }) => {
          if (!data) return
          if (fromBanner) setBannerAlerts((prev) => [...prev, data])
          else setBellAlerts((prev) => [data, ...prev])
        })
    }
  }

  return (
    <>
      {/* ── Connection status — bottom-left, beside the bell.
          Shop floor WiFi has dead zones, and WiFi can look "connected"
          while the realtime websocket itself is dead — so this checks
          both, not just navigator.onLine. Quiet green dot when healthy,
          a full pill only when something's actually wrong. ── */}
      {!online ? (
        <div className="fixed bottom-4 left-[4.5rem] z-[70] bg-andonRed text-paper text-sm font-bold px-3 py-2 rounded-full shadow-lg flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-paper animate-pulse" />
          Offline — changes won't save until reconnected
        </div>
      ) : !live ? (
        <div className="fixed bottom-4 left-[4.5rem] z-[70] bg-safetyDark text-paper text-sm font-bold px-3 py-2 rounded-full shadow-lg flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-paper animate-pulse" />
          Reconnecting…
        </div>
      ) : (
        <div className="fixed bottom-[1.6rem] left-[4.5rem] z-[70] w-3 h-3 rounded-full bg-andonGreen shadow" title="Live" />
      )}

      {/* ── Ship date alerts — full-width, stays until Acknowledge ── */}
      {bannerAlerts.length > 0 && (
        <div className="sticky top-0 z-[70] space-y-1">
          {bannerAlerts.map((a) => (
            <div key={a.id} className="px-4 py-3 flex items-center justify-between gap-3 font-medium text-sm text-paper bg-andonRed">
              <span>📅 {a.message}</span>
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

      {/* ── Order status bell — badge count, opens a dropdown ──
          Bottom-LEFT: headers already fill the top-right corner, and the
          host's own badge (Netlify's, on the deployed site) sits in the
          bottom-right. */}
      <div className="fixed bottom-4 left-4 z-[70]">
        <button
          onClick={() => setBellOpen((v) => !v)}
          className="relative bg-charcoal text-paper w-11 h-11 rounded-full shadow-lg flex items-center justify-center text-lg"
          title="Order status notifications"
        >
          🔔
          {bellAlerts.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-andonRed text-paper text-xs font-bold rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center">
              {bellAlerts.length > 99 ? '99+' : bellAlerts.length}
            </span>
          )}
        </button>

        {bellOpen && (
          <div className="absolute left-0 bottom-full mb-2 w-80 max-w-[90vw] max-h-[70vh] overflow-y-auto bg-white shadow-xl border border-paperDim rounded">
            <div className="px-3 py-2 bg-charcoal text-paper text-sm font-semibold sticky top-0">
              Order status changes ({bellAlerts.length})
            </div>
            {bellAlerts.length === 0 && <p className="p-4 text-sm text-steelLight">Nothing new.</p>}
            <ul>
              {bellAlerts.map((a) => (
                <li key={a.id} className="border-b border-paperDim last:border-0">
                  <button
                    onClick={() => acknowledge(a.id, { fromBanner: false })}
                    className="w-full text-left px-3 py-2.5 text-sm text-charcoal hover:bg-paper flex flex-col gap-0.5"
                  >
                    <span>🔔 {a.message}</span>
                    <span className="text-xs text-steelLight">
                      {new Date(a.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} — tap to acknowledge
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Ephemeral toasts — auto-dismiss ── */}
      {toasts.length > 0 && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] space-y-2 w-full max-w-md px-3">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-4 py-3 shadow-lg font-medium text-sm border-l-4 ${
                t.type === 'order_picked_up'
                  ? 'bg-white text-charcoal border-andonBlue'
                  : t.type === 'column_started'
                  ? 'bg-white text-charcoal border-safetyDark'
                  : 'bg-white text-charcoal border-andonGreen'
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
