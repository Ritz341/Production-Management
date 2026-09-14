import { useAuth } from './lib/AuthContext.jsx'
import Login from './pages/Login.jsx'
import DepartmentView from './pages/DepartmentView.jsx'
import AdminView from './pages/AdminView.jsx'
import ShippingView from './pages/ShippingView.jsx'

export default function App() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return <div className="h-screen flex items-center justify-center text-systemGray-400">Loading…</div>
  }

  if (!session) return <Login />

  if (!profile) {
    return (
      <div className="h-screen flex items-center justify-center text-systemGray-400 text-center px-6">
        This login isn't set up yet — ask admin to add it to bt_profiles with a role and department.
      </div>
    )
  }

  if (profile.role === 'admin') return <AdminView />
  if (profile.role === 'shipping') return <ShippingView />
  return <DepartmentView />
}
