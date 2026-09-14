import { useState } from 'react'

const PRESET_REASONS = ['Missing Glass', 'Wrong Cut', 'Machine Down', 'Waiting on Parts']

/** Quick-pick reason chips for marking a cell blocked — faster to tap
 * on a tablet than typing, with an "Other" escape hatch for anything
 * that doesn't fit the presets. */
export default function BlockReasonModal({ onCancel, onConfirm }) {
  const [customReason, setCustomReason] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  return (
    <div className="fixed inset-0 bg-charcoal/60 flex items-end sm:items-center justify-center z-[80]" onClick={onCancel}>
      <div className="bg-paper w-full sm:max-w-sm border-t-4 border-andonRed" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-charcoal">
          <h2 className="font-display text-2xl font-bold text-paper tracking-wide">🚧 What's blocking this?</h2>
        </div>
        <div className="p-5 space-y-2">
          {PRESET_REASONS.map((reason) => (
            <button
              key={reason}
              onClick={() => onConfirm(reason)}
              className="w-full text-left bg-white border border-paperDim rounded-lg px-4 py-3 text-base font-medium text-charcoal hover:bg-andonRedBg hover:border-andonRed"
            >
              {reason}
            </button>
          ))}

          {!showCustom ? (
            <button
              onClick={() => setShowCustom(true)}
              className="w-full text-left bg-white border border-paperDim rounded-lg px-4 py-3 text-base font-medium text-steelLight hover:bg-paper"
            >
              Other…
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                autoFocus
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Describe the issue"
                className="flex-1 border border-paperDim rounded-lg px-3 py-2.5 text-base"
              />
              <button
                onClick={() => onConfirm(customReason.trim() || null)}
                className="bg-andonRed text-paper font-bold px-4 py-2.5 rounded-lg whitespace-nowrap"
              >
                Block
              </button>
            </div>
          )}

          <button onClick={onCancel} className="w-full text-center text-sm text-steelLight py-2 mt-2">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
