import { useState } from 'react'
import { BLOCK_CATEGORIES } from '../lib/catalog'

/**
 * Marking a job blocked: pick what kind of problem it is (so the weekly
 * report can count them), and optionally say what happened in your own
 * words. Calls onConfirm({ category, note }).
 */
export default function BlockReasonModal({ onCancel, onConfirm }) {
  const [category, setCategory] = useState(null)
  const [note, setNote] = useState('')

  return (
    <div className="fixed inset-0 bg-charcoal/60 flex items-end sm:items-center justify-center z-[80]" onClick={onCancel}>
      <div className="bg-paper w-full sm:max-w-lg border-t-4 border-andonRed" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-charcoal">
          <h2 className="font-display text-2xl font-bold text-paper tracking-wide">🚧 What's blocking this?</h2>
          <p className="text-sm text-steelLight mt-0.5">Admin sees this right away.</p>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {BLOCK_CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                aria-pressed={category === c.id}
                className={`text-left rounded-lg border-2 px-3 py-3 text-base font-medium ${
                  category === c.id ? 'border-andonRed bg-andonRedBg text-andonRed' : 'border-paperDim bg-white text-charcoal'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          <input
            id="block-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened? (optional) e.g. glass cracked on 2 vents"
            aria-label="What happened"
            className="w-full border border-paperDim rounded-lg px-3 py-3 text-base"
          />

          <div className="flex gap-2">
            <button onClick={onCancel} className="flex-1 text-center text-steelLight py-3">
              Cancel
            </button>
            <button
              onClick={() => onConfirm({ category, note: note.trim() || null })}
              disabled={!category}
              className="flex-[2] bg-andonRed text-paper font-display font-bold text-xl rounded-lg py-3 disabled:opacity-40"
            >
              {category ? 'Mark blocked' : 'Pick a reason'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
