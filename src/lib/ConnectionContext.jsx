import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

const ConnectionContext = createContext({ online: true, live: true })

/**
 * One shared realtime channel + navigator.onLine listener for the
 * whole app, so every screen's "is it safe to write" check and the
 * visible indicator in NotificationBanner agree — navigator.onLine
 * alone isn't enough (WiFi can look connected while the websocket
 * itself is dead).
 */
export function ConnectionProvider({ children }) {
  const [online, setOnline] = useState(navigator.onLine)
  const [channelStatus, setChannelStatus] = useState('CONNECTING')

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    const channel = supabase.channel('bt-connection-heartbeat').subscribe((status) => setChannelStatus(status))
    return () => supabase.removeChannel(channel)
  }, [])

  const live = online && channelStatus === 'SUBSCRIBED'

  return <ConnectionContext.Provider value={{ online, live }}>{children}</ConnectionContext.Provider>
}

export function useConnection() {
  return useContext(ConnectionContext)
}
