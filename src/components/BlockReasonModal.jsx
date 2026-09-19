import { useState } from 'react'

const PRESET_REASONS = ['Missing Glass', 'Wrong Cut', 'Machine Down', 'Waiting on Parts']

/**
 * Marking a job blocked. The note box is always there so the floor can
 * say what actually happened in their own words; the quick reasons are
 * one tap on their own, or get the typed note added after them.
 */
export default function BlockReasonModal({ onCancel, onConfirm }) {
  const [note, setNote] = useState('')
  const typed = note.trim()

  function confirm(reason) {
    if (reason && typed) onConfirm(`${reason} — ${typed}`)
    else onConfirm(reason || typed || null)
  }

  return (
    <div className="fixed inset-0 bg-charcoal/60 flex items-end sm:items-center justify-center z-[80]" onClick={onCancel}>
      <div className="bg-paper w-full sm:max-w-md border-t-4 border-andonRed" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-charcoal">
          <h2 className="font-display text-2xl font-bold text-paper tracking-wide">🚧 What happened?</h2>
          <p className="text-sm text-steelLight mt-0.5">Admin sees this right away.</p>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex gap-2">
            <input
              id="block-note"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && typed && confirm(null)}
              placeholder="Describe it, e.g. glass cracked on 2 vents"
              aria-label="What happened"
              className="flex-1 border border-paperDim rounded-lg px-3 py-3 text-base"
            />
            <button
              onClick={() => confirm(null)}
              disabled={!typed}
              className="bg-andonRed text-paper font-bold px-4 rounded-lg whitespace-nowrap disabled:opacity-40"
            >
              Block
            </button>
          </div>

          <p className="text-xs font-semibold uppercase tracking-wider text-steelLight pt-1">
            {typed ? 'Or pick a reason — your note is added to it' : 'Or tap a quick reason'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {PRESET_REASONS.map((reason) => (
              <button
                key={reason}
                onClick={() => confirm(reason)}
                className="text-left bg-white border border-paperDim rounded-lg px-3 py-3 text-base font-medium text-charcoal hover:bg-andonRedBg hover:border-andonRed"
              >
                {reason}
              </button>
            ))}
          </div>

          <button onClick={onCancel} className="w-full text-center text-sm text-steelLight py-2">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
