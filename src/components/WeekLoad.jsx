/**
 * "Is this pickup doable?" — person-days of Mods work the orders need vs
 * the crew available on the workdays left before it ships. Green under
 * 90%, amber up to 100%, red over. `load` comes from weekLoad().
 */
export default function WeekLoad({ load, settings, dark = false }) {
  const { needed, available, days, missing } = load
  const pct = load.load == null ? null : Math.round(load.load * 100)
  const tone =
    pct == null ? 'neutral' : pct > 100 ? 'over' : pct >= 90 ? 'tight' : 'ok'
  const styles = {
    ok: dark ? 'bg-[#1F3A28] text-[#7FD49A]' : 'bg-andonGreenBg text-andonGreen',
    tight: dark ? 'bg-[#3A3320] text-safety' : 'bg-safety/20 text-[#8A6606]',
    over: dark ? 'bg-[#3A1F21] text-[#FF8A8A]' : 'bg-andonRedBg text-andonRed',
    neutral: dark ? 'bg-floorLine text-floorMute' : 'bg-paperDim text-steelLight',
  }[tone]
  const verdict = { ok: 'Doable', tight: 'Tight', over: 'Over capacity', neutral: 'No workdays left' }[tone]

  return (
    <div className={`rounded-lg px-3 py-2 ${styles}`} title={`At ${settings.mods_per_person_day} mods per person per day, scaled by difficulty`}>
      <div className="font-display font-bold text-lg leading-tight">
        {verdict}
        {pct != null && <span className="tabular-nums"> · {pct}%</span>}
      </div>
      <div className="text-xs opacity-90 tabular-nums">
        {needed.toFixed(1)} of {available.toFixed(0)} person-days ({days} workday{days === 1 ? '' : 's'} left)
        {missing > 0 && ` · ${missing} order${missing === 1 ? '' : 's'} missing mods`}
      </div>
    </div>
  )
}
