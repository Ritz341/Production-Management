import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  async function loadProfile(userId) {
    const { data, error } = await supabase
      .from('bt_profiles')
      .select('user_id, role, department_id, display_name, bt_departments!bt_profiles_department_id_fkey(name)')
      .eq('user_id', userId)
      .single()
    if (error) {
      console.error('Failed to load profile', error)
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
      if (session?.user) loadProfile(session.user.id)
      else setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session?.user) loadProfile(session.user.id)
      else setProfile(null)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (profile !== null || !session) setLoading(false)
  }, [profile, session])

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
