import { Component } from 'react'

/**
 * A crash used to leave a white screen with nothing to go on — no use
 * to someone holding a tablet on the floor. Now it says what broke and
 * offers the two things that actually fix it: reload, or clear the
 * cached app (a half-updated service-worker cache looks like a crash).
 */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('App crashed:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="min-h-full bg-floor text-paper grid place-items-center p-8">
        <div className="max-w-xl w-full">
          <h1 className="font-display font-extrabold uppercase text-4xl text-[#FF6B6B]">Something broke</h1>
          <p className="text-floorMute mt-2">
            The screen couldn’t be drawn. Reload first — if it keeps happening, clear the saved app and tell Riz what it says below.
          </p>
          <pre className="mt-4 rounded-xl bg-floorCard border border-floorLine p-4 text-sm whitespace-pre-wrap break-words text-[#FF9A9A]">
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <div className="flex flex-wrap gap-3 mt-5">
            <button onClick={() => window.location.reload()} className="rounded-xl bg-safety text-charcoal font-bold px-5 py-3">
              Reload
            </button>
            <button
              onClick={async () => {
                try {
                  const regs = await navigator.serviceWorker?.getRegistrations?.()
                  await Promise.all((regs ?? []).map((r) => r.unregister()))
                  const keys = await caches?.keys?.()
                  await Promise.all((keys ?? []).map((k) => caches.delete(k)))
                } catch {
                  /* nothing cached to clear */
                }
                window.location.reload()
              }}
              className="rounded-xl border border-floorLine text-paper font-semibold px-5 py-3"
            >
              Clear saved app and reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
