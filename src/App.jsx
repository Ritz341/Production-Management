import { useAuth } from './lib/AuthContext.jsx'
import Login from './pages/Login.jsx'
import DepartmentView from './pages/DepartmentView.jsx'
import AdminView from './pages/AdminView.jsx'
import ShippingView from './pages/ShippingView.jsx'
import LogisticsView from './pages/LogisticsView.jsx'
import TVBoard from './pages/TVBoard.jsx'
import NoRoleView from './pages/NoRoleView.jsx'
import { useEffect, useState } from 'react'
import OfficeView from './pages/OfficeView.jsx'
import QualityView from './pages/QualityView.jsx'

export default function App() {
  const { session, profile, loading, signOut } = useAuth()

  if (loading) return <LoadingScreen onSignOut={signOut} />

  if (!session) return <Login />

  // A shop-floor TV: any signed-in login can show a board, because it
  // only reads. Opened as ?tv=Mods on that PC.
  const tvDepartment = new URLSearchParams(window.location.search).get('tv')
  if (tvDepartment) return <TVBoard department={tvDepartment} />

  if (!profile) return <NoRoleView />

  if (profile.role === 'admin') return <AdminView />
  if (profile.role === 'shipping') return <ShippingView />
  if (profile.role === 'logistics') return <LogisticsView />
  if (profile.role === 'office') return <OfficeView />
  if (profile.role === 'quality') return <QualityView />
  return <DepartmentView />
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
