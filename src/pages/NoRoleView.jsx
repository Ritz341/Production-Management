import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'

/**
 * A signed-in login with no role. That's normal for a TV PC's login
 * (boards only read, so they don't get one) — so offer the boards
 * directly instead of a dead end, and say plainly which login this is
 * in case it's a tablet that hasn't been set up.
 */
export default function NoRoleView() {
  const { session, signOut } = useAuth()
  const [departments, setDepartments] = useState([])

  useEffect(() => {
    supabase.from('bt_departments').select('id, name').order('sort_order').then(({ data }) => setDepartments(data ?? []))
  }, [])

  return (
    <div className="min-h-full bg-floor text-paper grid place-items-center p-6">
      <div className="w-full max-w-xl">
        <p className="text-sm text-floorMute">Signed in as</p>
        <p className="font-display font-bold text-3xl break-all">{session?.user?.email}</p>

        <h1 className="font-display font-extrabold uppercase text-4xl mt-8">Open a TV board</h1>
        <p className="text-floorMute mt-1">This login has no tablet role, which is right for a TV. Pick the board for this screen:</p>
        <div className="grid grid-cols-2 gap-3 mt-4">
          {departments.map((d) => (
            <a
              key={d.id}
              href={`/?tv=${encodeURIComponent(d.name)}`}
              className="rounded-2xl bg-safety text-charcoal font-display font-extrabold text-3xl uppercase text-center py-6"
            >
              {d.name}
            </a>
          ))}
        </div>

        <p className="text-sm text-floorMute mt-8">
          Meant to be a tablet, office or admin login? It hasn't been given a role yet — ask admin to run setup_logins.sql for
          this email.
        </p>
        <button onClick={signOut} className="mt-3 rounded-lg border border-floorLine px-4 py-2.5 text-paper">
          Sign out
        </button>
      </div>
    </div>
  )
}
