import { useState } from 'react'
import { useAuth } from '../lib/AuthContext.jsx'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const { error } = await signIn(email, password)
    setBusy(false)
    if (error) setError("Login failed. Check the tablet's email/password.")
  }

  return (
    <div className="h-full flex items-center justify-center bg-charcoal">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-paper p-8 space-y-6 border-t-4 border-safety">
        <div>
          <p className="text-xs font-semibold text-steelLight tracking-wide">SUNSPACE TRUESDALE</p>
          <h1 className="font-display text-3xl font-bold text-charcoal leading-tight">Build Tracker</h1>
        </div>
        <div className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-paperDim bg-white rounded px-4 py-3 text-lg"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-paperDim bg-white rounded px-4 py-3 text-lg"
            required
          />
        </div>
        {error && <p className="text-andonRed text-sm">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-safety text-charcoal rounded py-3 text-lg font-display font-bold tracking-wide disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
