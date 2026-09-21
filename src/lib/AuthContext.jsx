import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const userIdRef = useRef(null) // whose profile is loaded / loading

  // Always ends loading, profile or not. A login with no role (a TV PC,
  // or one not set up yet) used to leave the app on "Loading…" forever.
  async function loadProfile(userId) {
    try {
      await fetchProfile(userId)
    } finally {
      setLoading(false)
    }
  }

  async function fetchProfile(userId) {
    const { data, error } = await supabase
      .from('bt_profiles')
      .select('user_id, role, department_id, display_name, bt_departments!bt_profiles_department_id_fkey(name)')
      .eq('user_id', userId)
      .single()
    if (error) {
      // No row is normal for a TV login; anything else is worth a log.
      if (error.code !== 'PGRST116') console.error('Failed to load profile', error)
      setProfile(null)
      return
    }

    // Combined departments this login can act on (usually just the
    // home department, but a tablet can be assigned 2-3 to work as one
    // queue — see bt_profile_departments / schema_v8.sql).
    const { data: deptRows, error: deptError } = await supabase
      .from('bt_profile_departments')
      .select('department_id')
      .eq('user_id', userId)
    if (deptError) console.error('Failed to load combined departments', deptError)

    const combinedDepartmentIds = (deptRows ?? []).map((r) => r.department_id)
    setProfile({
      ...data,
      combinedDepartmentIds: combinedDepartmentIds.length > 0
        ? combinedDepartmentIds
        : data.department_id != null ? [data.department_id] : [],
    })
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      userIdRef.current = session?.user?.id ?? null
      if (session?.user) loadProfile(session.user.id)
      else setLoading(false)
    })

    // Only a different login needs its profile (re)loaded. Token
    // refreshes fire this hourly for the same user; reloading then would
    // blink every TV board back to the loading screen.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      const id = session?.user?.id ?? null
      if (id === userIdRef.current) return
      userIdRef.current = id
      if (id) {
        setLoading(true)
        loadProfile(id)
      } else {
        setProfile(null)
        setLoading(false)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])


  async function signIn(email, password) {
    return supabase.auth.signInWithPassword({ email, password })
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
