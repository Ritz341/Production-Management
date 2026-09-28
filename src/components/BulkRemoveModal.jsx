import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { dbErrorText } from '../lib/dbError'

/**
 * Take several orders off the build at once (admin only — the database
 * checks the role too, so this screen isn't the only thing stopping it).
 *
 * Two choices, kept separate because they answer different questions:
 *
 *   Reversible or permanent — can this be undone? Cancelling hides the
 *   order and keeps it. Deleting takes its statuses, files, activity
 *   and quality history with it, and they don't come back.
 *
 *   Quiet or announced — does the floor need to know now? A duplicate
 *   from a bad import doesn't. An order someone is part-way through
 *   building does, or they keep building it.
 *
 * The safe combination is the default: reversible, and quiet.
 */
export default function BulkRemoveModal({ orders, onClose, onDone }) {
  const [permanent, setPermanent] = useState(false)
  const [announce, setAnnounce] = useState(false)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const count = orders.length
  // A permanent delete is confirmed by typing the number of orders.
  // Not a flourish: it's the one action here that can't be undone, and
  // the count is the thing most likely to be wrong after a mis-click in
  // a 200-row grid.
  const confirmed = !permanent || typed.trim() === String(count)

  // Only meaningful for a cancel — a deleted order has no state left to
  // have been mid-build.
  const started = orders.filter((o) =>
    Object.values(o.statuses ?? {}).some((c) => c.visible && !c.removed && c.stage)
  )

  async function run() {
    if (!confirmed || busy) return
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase.rpc('bt_remove_orders', {
      p_order_ids: orders.map((o) => o.id),
      p_permanent: permanent,
      p_announce: announce,
      p_reason: reason,
    })
    setBusy(false)
    if (err) return setError(dbErrorText(err, "Couldn't remove those orders"))
    onDone?.({ count: data ?? count, permanent, announce })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-charcoal/60 z-[80] grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-paperDim">
          <h2 className="font-display font-bold text-2xl text-charcoal">
            Remove {count} {count === 1 ? 'order' : 'orders'}
          </h2>
        </div>

        <div className="px-5 py-4 grid gap-4">
          <div className="rounded-lg border border-paperDim bg-paper max-h-40 overflow-y-auto px-3 py-2 text-sm">
            {orders.map((o) => (
              <div key={o.id} className="flex justify-between gap-3 py-0.5">
                <span className="font-semibold text-charcoal truncate">{o.tag_name}</span>
                <span className="text-steelLight truncate">{o.dealer}</span>
              </div>
            ))}
          </div>

          {/* ── Reversible or not ── */}
          <fieldset className="grid gap-2">
            <legend className="font-display font-bold text-charcoal mb-1">How</legend>
            <Choice
              checked={!permanent}
              onChange={() => setPermanent(false)}
              title="Cancel — can be undone"
              detail="Comes off every tablet and stays in the Grid under “Show cancelled”, with its history. Restore it any time."
            />
            <Choice
              checked={permanent}
              onChange={() => setPermanent(true)}
              tone="danger"
              title="Delete permanently"
              detail="The order and everything attached to it — statuses, files, activity log, quality issues — are gone for good. Only a line in the deletion log remains."
            />
          </fieldset>

          {/* ── Quiet or loud ── */}
          <fieldset className="grid gap-2">
            <legend className="font-display font-bold text-charcoal mb-1">Tell the floor?</legend>
            <Choice
              checked={!announce}
              onChange={() => setAnnounce(false)}
              title="Quietly — no notification"
              detail="Nothing appears on any tablet. For duplicates, test rows and import mistakes nobody has started."
            />
            <Choice
              checked={announce}
              onChange={() => setAnnounce(true)}
              tone="loud"
              title="Announce it — red banner on every tablet"
              detail="Stays up until someone taps Acknowledge, like a ship date change. For an order the floor is already building."
            />
            {started.length > 0 && !announce && (
              <p className="text-sm text-safetyDark bg-safety/15 rounded-lg px-3 py-2">
                ⚠ {started.length} of these {started.length === 1 ? 'has' : 'have'} already been started on the floor.
                Removing {started.length === 1 ? 'it' : 'them'} quietly means whoever is building{' '}
                {started.length === 1 ? 'it' : 'them'} won't be told.
              </p>
            )}
          </fieldset>

          <label className="text-sm text-steel">
            Reason {permanent ? <span className="text-steelLight">(kept in the deletion log)</span> : <span className="text-steelLight">(shown beside the cancelled order)</span>}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. duplicate import, dealer cancelled"
              className="mt-1 w-full border border-paperDim rounded px-3 py-2"
            />
          </label>

          {permanent && (
            <label className="text-sm font-semibold text-andonRed">
              Type {count} to confirm you mean to delete {count === 1 ? 'this order' : `all ${count}`} for good
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                className="mt-1 w-24 border-2 border-andonRed rounded px-3 py-2 tabular-nums"
              />
            </label>
          )}

          {error && <div className="bg-andonRedBg text-andonRed text-sm px-3 py-2 rounded">⚠ {error}</div>}
        </div>

        <div className="px-5 py-4 border-t border-paperDim flex justify-end gap-3">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-steel">
            Keep them
          </button>
          <button
            onClick={run}
            disabled={!confirmed || busy}
            className={`rounded-lg font-display font-bold px-5 py-2.5 disabled:opacity-40 ${
              permanent ? 'bg-andonRed text-white' : 'bg-charcoal text-paper'
            }`}
          >
            {busy ? 'Removing…' : permanent ? `Delete ${count} for good` : `Cancel ${count}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function Choice({ checked, onChange, title, detail, tone }) {
  const ring = checked
    ? tone === 'danger'
      ? 'border-andonRed bg-andonRedBg'
      : tone === 'loud'
        ? 'border-safety bg-safety/15'
        : 'border-charcoal bg-paper'
    : 'border-paperDim'
  return (
    <label className={`flex gap-3 items-start rounded-lg border-2 px-3 py-2.5 cursor-pointer ${ring}`}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-1 w-4 h-4 accent-charcoal" />
      <span>
        <span className="block font-semibold text-charcoal">{title}</span>
        <span className="block text-sm text-steelLight">{detail}</span>
      </span>
    </label>
  )
}
