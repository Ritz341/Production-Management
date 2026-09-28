/**
 * Workflow stage — what the floor sets per order/department: not started
 * (null) → Started → Done. Kept deliberately short so a tablet is one tap
 * per job. Paperwork is tracked separately by the office (see
 * bt_orders.paperwork_ready_at), not as a floor stage.
 *
 * Older rows may still hold 'paperwork_ready', 'packaged' or 'shipped'
 * from before this was simplified; stageRank() in lib/schedule.js reads
 * those as not started / done so nothing is lost.
 *
 * This file used to also carry the colours for the build sheet's own
 * values — 'C', 'Arrived', 'X', a quantity — from when the app mirrored
 * the spreadsheet cell for cell. The floor sets stages now, not sheet
 * text, and nothing had imported those for a while.
 */
export const WORKFLOW_STAGES = [
  { id: 'started', label: 'Started', chipClass: 'bg-andonBlueBg text-andonBlue', dotClass: 'bg-andonBlue' },
  { id: 'completed', label: 'Done', chipClass: 'bg-andonGreenBg text-andonGreen', dotClass: 'bg-andonGreen' },
]

export const workflowStageById = Object.fromEntries(WORKFLOW_STAGES.map((s) => [s.id, s]))

// "Blocked" is a flag layered on top of whatever stage a cell is
// already at (e.g. Order Started but waiting on a part) — not one of
// the linear WORKFLOW_STAGES above, so it gets its own styling that
// overrides the stage chip's color wherever it's set.
export const BLOCKED_CHIP_CLASS = 'bg-andonRedBg text-andonRed'
