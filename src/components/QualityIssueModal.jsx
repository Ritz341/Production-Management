import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { DEFECT_TYPES } from '../lib/catalog'

/**
 * Report a quality problem on an order.
 *
 * Pick the department that made the part and what's wrong. If the
 * reporter's own department is on the order, they can also send it
 * back: that reopens the other department's job and blocks the
 * reporter's own until the rework is marked Done (the database closes
 * the issue and lifts the block then).
 *
 * `departments` is [{ columnId, name }] for the order; `reporterColumnId`
 * is the reporting tablet's own job on this order, if any.
 */
export default function QualityIssueModal({ order, departments, reporterColumnId = null, inspector = false, onClose, onSaved }) {
  const others = departments.filter((d) => d.columnId !== reporterColumnId)
  const [responsible, setResponsible] = useState(others.length === 1 ? others[0].columnId : null)
  const [defect, setDefect] = useState(null)
  const [note, setNote] = useState('')
  const [sendBack, setSendBack] = useState(!inspector)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // A department can send back another department's work (and is held
  // meanwhile). The quality inspector isn't a department, so they can
  // send anything back without holding anyone.
  const canSendBack = responsible != null && (inspector || (reporterColumnId != null && responsible !== reporterColumnId))
  const responsibleName = departments.find((d) => d.columnId === responsible)?.name
  const reporterName = departments.find((d) => d.columnId === reporterColumnId)?.name

  async function submit() {
    setBusy(true)
    setError('')
    const { error: err } = await supabase.rpc('bt_report_quality', {
      p_order_id: order.id,
      p_responsible_column_id: responsible,
      p_defect_type: defect,
      p_note: note,
      p_send_back: canSendBack && sendBack,
      p_reporter_column_id: reporterColumnId,
    })
    setBusy(false)
    if (err) return setError(err.message)
    onSaved?.(canSendBack && sendBack ? `Sent back to ${responsibleName}` : 'Quality issue logged')
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-charcoal/60 flex items-end sm:items-center justify-center z-[80]" onClick={onClose}>
      <div className="bg-paper w-full sm:max-w-lg max-h-[92vh] overflow-y-auto border-t-4 border-safety" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-charcoal">
          <h2 className="font-display text-2xl font-bold text-paper tracking-wide">⚑ Quality problem</h2>
          <p className="text-sm text-steelLight mt-0.5">
            #{order.buildNo} {order.tag_name}
          </p>
        </div>

        <div className="p-5 space-y-4">
          <section>
            <h3 className="text-sm font-semibold text-steel mb-1.5">Which department made it?</h3>
            <div className="flex flex-wrap gap-2">
              {departments.map((d) => (
                <button
                  key={d.columnId}
                  onClick={() => setResponsible(d.columnId)}
                  aria-pressed={responsible === d.columnId}
                  className={`rounded-lg border-2 px-4 py-2.5 font-semibold ${
                    responsible === d.columnId ? 'border-charcoal bg-charcoal text-paper' : 'border-paperDim bg-white text-charcoal'
                  }`}
                >
                  {d.name}
                  {d.columnId === reporterColumnId && <span className="font-normal opacity-70"> (us)</span>}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-steel mb-1.5">What's wrong?</h3>
            <div className="grid grid-cols-2 gap-2">
              {DEFECT_TYPES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setDefect(t.id)}
                  aria-pressed={defect === t.id}
                  className={`text-left rounded-lg border-2 px-3 py-2.5 ${
                    defect === t.id ? 'border-safety bg-safety/20 text-charcoal font-semibold' : 'border-paperDim bg-white text-charcoal'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <input
            id="quality-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Details (optional) e.g. insert 1/4&quot; too wide on wall 2"
            aria-label="Details"
            className="w-full border border-paperDim rounded-lg px-3 py-3"
          />

          {canSendBack && (
            <label className="flex items-start gap-3 rounded-lg border-2 border-andonRed/40 bg-andonRedBg p-3 cursor-pointer">
              <input type="checkbox" checked={sendBack} onChange={(e) => setSendBack(e.target.checked)} className="w-6 h-6 mt-0.5" />
              <span className="text-sm text-charcoal">
                <b>Send it back to {responsibleName}.</b> Their job on this order reopens
                {reporterName ? `, and ${reporterName} is held until they mark it Done again.` : ' until they mark it Done again.'}
              </span>
            </label>
          )}

          {error && <p className="text-sm text-andonRed">{error}</p>}

          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 text-steelLight py-3">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || !defect || responsible == null}
              className="flex-[2] bg-charcoal text-paper font-display font-bold text-xl rounded-lg py-3 disabled:opacity-40"
            >
              {busy ? 'Sending…' : !defect || responsible == null ? 'Pick department and problem' : canSendBack && sendBack ? 'Send back' : 'Log issue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
