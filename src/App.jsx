import { useAuth } from './lib/AuthContext.jsx'
import Login from './pages/Login.jsx'
import DepartmentView from './pages/DepartmentView.jsx'
import AdminView from './pages/AdminView.jsx'
import ShippingView from './pages/ShippingView.jsx'
import LogisticsView from './pages/LogisticsView.jsx'
import TVBoard from './pages/TVBoard.jsx'
import NoRoleView from './pages/NoRoleView.jsx'
import OfficeView from './pages/OfficeView.jsx'
import QualityView from './pages/QualityView.jsx'

export default function App() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return <div className="h-screen flex items-center justify-center text-systemGray-400">Loading…</div>
  }

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
