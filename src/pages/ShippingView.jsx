import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import NotificationBanner from '../components/NotificationBanner.jsx'

export default function ShippingView() {
  const { signOut } = useAuth()
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [showPicked, setShowPicked] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('bt_orders')
      .select('id, tag_name, dealer, truck_route, scheduled_pickup_date, actual_pickup_date')
      .not('scheduled_pickup_date', 'is', null)
      .order('scheduled_pickup_date', { ascending: true })
    setOrders(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel('shipping-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function markPickedUp(id) {
    const now = new Date().toISOString()
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, actual_pickup_date: now } : o)))
    await supabase.from('bt_orders').update({ actual_pickup_date: now }).eq('id', id)
  }

  async function undoPickedUp(id) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, actual_pickup_date: null } : o)))
    await supabase.from('bt_orders').update({ actual_pickup_date: null }).eq('id', id)
  }

  const visible = orders.filter((o) => (showPicked ? true : !o.actual_pickup_date))

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between border-b-4 border-safety">
        <h1 className="font-display text-3xl font-bold text-paper leading-none">Shipping</h1>
        <div className="flex items-center gap-3">
          <label className="text-sm text-steelLight flex items-center gap-1">
            <input type="checkbox" checked={showPicked} onChange={(e) => setShowPicked(e.target.checked)} />
            Show picked up
          </label>
          <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">
            Sign out
          </button>
        </div>
      </header>

      <main className="p-4 space-y-3 max-w-2xl mx-auto">
        {loading && <p className="text-steelLight text-sm">Loading…</p>}
        {!loading && visible.length === 0 && (
          <div className="bg-white border border-paperDim rounded p-8 text-center">
            <p className="text-steelLight">Nothing scheduled for pickup right now.</p>
          </div>
        )}
        {visible.map((o) => (
          <div key={o.id} className="bg-white shadow-sm flex overflow-hidden">
            <div className={`w-2 shrink-0 ${o.actual_pickup_date ? 'bg-andonGreen' : 'bg-safety'}`} />
            <div className="flex-1 p-4 flex items-center justify-between gap-3">
              <div>
                <div className="font-display text-2xl font-bold text-charcoal tracking-wide">{o.tag_name}</div>
                <div className="text-sm text-steelLight">{o.dealer}</div>
                <div className="text-xs text-steelLight mt-1">
                  Scheduled: {o.scheduled_pickup_date}
                  {o.actual_pickup_date && ` · Picked up ${new Date(o.actual_pickup_date).toLocaleString()}`}
                </div>
              </div>
              {o.actual_pickup_date ? (
                <button onClick={() => undoPickedUp(o.id)} className="text-xs text-steelLight underline">
                  Undo
                </button>
              ) : (
                <button
                  onClick={() => markPickedUp(o.id)}
                  className="bg-safety text-charcoal font-display font-bold px-4 py-2 whitespace-nowrap"
                >
                  Mark Picked Up
                </button>
              )}
            </div>
          </div>
        ))}
      </main>
    </div>
  )
}
