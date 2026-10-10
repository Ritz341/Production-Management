import { Suspense, lazy, useEffect, useState } from 'react'
import { useAuth } from './lib/AuthContext.jsx'
import Login from './pages/Login.jsx'
import NoRoleView from './pages/NoRoleView.jsx'

// Each login only ever opens its own screen, so each screen is its own
// download: a floor phone fetches the tablet view, not Admin, Reports and
// the spreadsheet importer it will never open.
//
// After a deploy, a phone that kept the page open still points at the old
// file names; loading one then fails. Reload once to pick up the new ones
// instead of showing an error.
function screen(load) {
  return lazy(() =>
    load().catch((err) => {
      const KEY = 'app:reloaded-for-update'
      try {
        if (!sessionStorage.getItem(KEY)) {
          sessionStorage.setItem(KEY, '1')
          window.location.reload()
          return new Promise(() => {})
        }
      } catch {
        /* storage blocked: fall through to the error */
      }
      throw err
    })
  )
}

const DepartmentView = screen(() => import('./pages/DepartmentView.jsx'))
const AdminView = screen(() => import('./pages/AdminView.jsx'))
const ShippingView = screen(() => import('./pages/ShippingView.jsx'))
const LogisticsView = screen(() => import('./pages/LogisticsView.jsx'))
const TVBoard = screen(() => import('./pages/TVBoard.jsx'))
const OfficeView = screen(() => import('./pages/OfficeView.jsx'))
const QualityView = screen(() => import('./pages/QualityView.jsx'))
const CrossDeptFloatBoard = screen(() => import('./pages/CrossDeptFloatBoard.jsx'))

export default function App() {
  const { signOut } = useAuth()
  return (
    <Suspense fallback={<LoadingScreen onSignOut={signOut} />}>
      <Screen />
    </Suspense>
  )
}

function Screen() {
  const { session, profile, loading, signOut } = useAuth()

  if (loading) return <LoadingScreen onSignOut={signOut} />

  if (!session) return <Login />

  // A shop-floor TV: any signed-in login can show a board, because it
  // only reads. Opened as ?tv=Mods on that PC.
  const params = new URLSearchParams(window.location.search)
  const tvDepartment = params.get('tv')
  if (tvDepartment) return <TVBoard department={tvDepartment} />

  // Cross-department float board: opened as ?float=1 on a supervisor tablet.
  if (params.get('float')) return <CrossDeptFloatBoard />

  if (!profile) return <NoRoleView />

  if (profile.role === 'admin') return <AdminView />
  if (profile.role === 'shipping') return <ShippingView />
  if (profile.role === 'logistics') return <LogisticsView />
  if (profile.role === 'office') return <OfficeView />
  if (profile.role === 'quality') return <QualityView />
  return <DepartmentView />
}

// A screen that loaded fine clears the one-reload guard for next deploy.
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    try {
      sessionStorage.removeItem('app:reloaded-for-update')
    } catch {
      /* ignore */
    }
  })
}

// If loading ever hangs (no network, say), offer a way out after a few
// seconds instead of a blank screen.
function LoadingScreen({ onSignOut }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 6000)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 bg-paper text-steelLight text-center px-6">
      <p>Loading…</p>
      {slow && (
        <>
          <p className="text-sm">Taking longer than usual — check this device's internet connection.</p>
          <div className="flex gap-3">
            <button onClick={() => window.location.reload()} className="rounded-lg border border-paperDim bg-white px-4 py-2 text-charcoal">
              Try again
            </button>
            <button onClick={onSignOut} className="rounded-lg border border-paperDim bg-white px-4 py-2 text-charcoal">
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
