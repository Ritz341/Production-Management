import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { DONE_RANK, buildNumbers, byBuildOrder, daysUntil, relativeDay, stageRank } from '../lib/schedule'
import { blockText, checkinBlocks, clockLabel, isoDate, productiveMinutesPerDay, rateFor, useSettings, workingMinutesBetween } from '../lib/catalog'

/**
 * The 65" board above a department, on its own PC in full-screen Chrome.
 *
 * Read-only and designed to be read in about three seconds from across
 * the shop: one dominant number (today vs target), the next jobs in
 * build order, and anything stuck in red. Admin chooses what each board
 * shows (Admin → TVs), and changes appear here within seconds.
 *
 * Opened as ?tv=<department name>, e.g. ?tv=Mods.
 */
export default function TVBoard({ department }) {
  const { live } = useConnection()
  const settings = useSettings()
  const [dept, setDept] = useState(null)
  const [columnIds, setColumnIds] = useState([])
  const [columnName, setColumnName] = useState({})
  const [orders, setOrders] = useState([])
  const [doneToday, setDoneToday] = useState({ jobs: 0, mods: 0 })
  const [crew, setCrew] = useState(null)
  const [counts, setCounts] = useState([]) // today's check-ins, oldest first
  const [error, setError] = useState('')
  const [now, setNow] = useState(new Date())

  const config = settings.tv_boards?.[department] ?? {}
  const today = isoDate(new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true

    async function load() {
      const { data: depts } = await supabase.from('bt_departments').select('id, name')
      const mine = (depts ?? []).find((d) => d.name.toLowerCase() === department.toLowerCase())
      if (!mine) {
        if (alive) setError(`No department called "${department}". Check the address on this PC.`)
        return
      }
      const [{ data: links }, { data: cols }] = await Promise.all([
        supabase.from('bt_department_columns').select('status_column_id').eq('department_id', mine.id),
        supabase.from('bt_status_columns').select('id, name'),
      ])
      const ids = (links ?? []).map((l) => l.status_column_id)

      const { data: orderRows, error: oErr } = await supabase
        .from('bt_orders')
        .select('id, tag_name, dealer, build_week_id, scheduled_pickup_date, sequence, mods_count, status, bt_build_weeks(ship_date, label)')
        .eq('status', 'active')
        .is('actual_pickup_date', null)
      const orderIds = (orderRows ?? []).map((o) => o.id)
      const { data: statusRows } = orderIds.length
        ? await supabase
            .from('bt_order_status')
            .select('order_id, status_column_id, workflow_stage, blocked_at, blocked_note, blocked_category')
            .in('order_id', orderIds)
            .eq('is_visible', true)
            .is('removed_at', null)
        : { data: [] }

      // Finished today, from the activity log.
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      const { data: doneRows } = ids.length
        ? await supabase.from('bt_activity').select('order_id, status_column_id').eq('kind', 'done').gte('at', midnight.toISOString()).in('status_column_id', ids)
        : { data: [] }
      const { data: crewRow } = await supabase
        .from('bt_crew_days')
        .select('people')
        .eq('work_date', today)
        .eq('department_id', mine.id)
        .maybeSingle()

      const { data: countRows } = await supabase
        .from('bt_output_counts')
        .select('count, at')
        .eq('department_id', mine.id)
        .eq('work_date', today)
        .order('at')

      if (!alive) return
      setCounts((countRows ?? []).map((c) => ({ count: Number(c.count), at: new Date(c.at) })))
      setError(oErr ? `Can't load orders: ${oErr.message}` : '')
      setDept(mine)
      setColumnIds(ids)
      setColumnName(Object.fromEntries((cols ?? []).map((c) => [c.id, c.name])))

      const numbers = buildNumbers(orderRows ?? [])
      const byId = new Map((orderRows ?? []).map((o) => [o.id, { ...o, buildNo: numbers.get(o.id), cells: {}, others: {} }]))
      for (const s of statusRows ?? []) {
        const o = byId.get(s.order_id)
        if (!o) continue
        const cell = { stage: s.workflow_stage, blocked: !!s.blocked_at, blockedNote: s.blocked_note, blockedCategory: s.blocked_category }
        if (ids.includes(s.status_column_id)) o.cells[s.status_column_id] = cell
        else o.others[s.status_column_id] = cell
      }
      setOrders([...byId.values()].filter((o) => Object.keys(o.cells).length > 0).sort(byBuildOrder))

      const uniqueDone = new Map((doneRows ?? []).map((r) => [`${r.order_id}:${r.status_column_id}`, r]))
      const modsFor = (id) => byId.get(id)?.mods_count ?? 0
      setDoneToday({
        jobs: uniqueDone.size,
        mods: [...new Set([...uniqueDone.values()].map((r) => r.order_id))].reduce((s, id) => s + modsFor(id), 0),
      })
      setCrew(crewRow ? Number(crewRow.people) : null)
    }

    load()
    const channel = supabase
      .channel(`tv-${department}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_build_weeks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_crew_days' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_output_counts' }, load)
      .subscribe()
    // A board runs for weeks; a full reload every 10 minutes keeps it
    // honest even if a realtime message was missed.
    const timer = setInterval(load, 600000)
    return () => {
      alive = false
      clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [department, today])

  const lane = (o) => {
    const cells = columnIds.map((id) => o.cells[id]).filter(Boolean)
    if (cells.some((c) => c.blocked)) return 'blocked'
    const worst = Math.min(...cells.map((c) => stageRank(c.stage)))
    return worst >= DONE_RANK ? 'done' : worst === 1 ? 'doing' : 'todo'
  }
  const queue = useMemo(() => orders.filter((o) => lane(o) !== 'done'), [orders, columnIds])
  const blocked = useMemo(
    () => orders.flatMap((o) => columnIds.filter((id) => o.cells[id]?.blocked).map((id) => ({ o, id, cell: o.cells[id] }))),
    [orders, columnIds]
  )
  const nextWeek = useMemo(() => {
    const dates = orders.map((o) => o.bt_build_weeks?.ship_date).filter(Boolean).sort()
    return dates[0] ?? null
  }, [orders])

  const rate = rateFor(settings, dept?.name ?? department)
  const target = crew != null && rate.perPerson ? Math.round(crew * rate.perPerson) : null
  // What the crew counted beats what the app can infer: orders only
  // finish in lumps, a count every two hours shows the real pace.
  const lastCount = counts.length ? counts[counts.length - 1] : null
  const useMods = orders.some((o) => o.mods_count) // only infer mods if the office entered them
  const doneNum = lastCount ? lastCount.count : useMods ? doneToday.mods : doneToday.jobs
  const unit = lastCount || target != null ? rate.unit : useMods ? 'mods' : 'orders'

  // Judge the day against what's expected BY NOW, not the whole day's
  // target — otherwise every morning looks like a disaster.
  const shiftStart = new Date()
  shiftStart.setHours(Number(settings.shift.start.slice(0, 2)), Number(settings.shift.start.slice(3, 5)), 0, 0)
  const elapsed = Math.max(0, workingMinutesBetween(shiftStart, now, settings.shift) ?? 0)
  const dayFraction = Math.min(1, elapsed / productiveMinutesPerDay(settings.shift))
  const expectedByNow = target != null ? target * dayFraction : null
  const pace = expectedByNow ? doneNum / Math.max(0.25, expectedByNow) : null
  const behind = expectedByNow != null ? Math.round(expectedByNow - doneNum) : null
  // Before the shift starts (and at weekends) there's nothing to be
  // behind on, so the board stays neutral instead of alarming red.
  const paceColor = pace == null ? 'text-paper' : pace >= 1 ? 'text-[#4CC46F]' : pace >= 0.75 ? 'text-safety' : 'text-[#FF6B6B]'
  const paceBar = pace == null ? 'bg-steelLight' : pace >= 1 ? 'bg-[#4CC46F]' : pace >= 0.75 ? 'bg-safety' : 'bg-[#FF6B6B]'
  // The whole panel takes the colour, so the state reads from across the shop.
  const paceCard =
    pace == null
      ? 'bg-floorCard border-floorLine'
      : pace >= 1
        ? 'bg-[#16301F] border-[#4CC46F]'
        : pace >= 0.75
          ? 'bg-[#33290F] border-safety'
          : 'bg-[#3A1719] border-[#FF6B6B]'
  const paceWord = pace == null ? null : pace >= 1 ? 'ON PACE' : pace >= 0.75 ? 'SLIGHTLY BEHIND' : 'BEHIND'

  // ── The 2-hour blocks ──
  // Each block is judged by the last count entered by 45 minutes after
  // it ends (people update around the time, not on the dot).
  const GRACE = 45 * 60000
  const blocks = checkinBlocks(settings, target).map((b, i, all) => {
    const prevEnd = i ? all[i - 1].end : null
    const entry = [...counts].reverse().find((c) => c.at <= new Date(b.end.getTime() + GRACE) && (!prevEnd || c.at > new Date(prevEnd.getTime() - 60 * 60000)))
    const isCurrent = now < b.end && (!prevEnd || now >= prevEnd)
    const overdue = !entry && now > new Date(b.end.getTime() + 15 * 60000) && now < new Date(b.end.getTime() + GRACE * 4)
    let state = 'upcoming'
    if (isCurrent) state = 'current'
    else if (now >= b.end) {
      if (!entry) state = overdue ? 'late' : 'missed'
      else if (b.targetByEnd == null) state = 'counted'
      else state = entry.count >= b.targetByEnd ? 'met' : entry.count >= b.targetByEnd * 0.85 ? 'close' : 'short'
    }
    return { ...b, entry, state }
  })
  const dueBlock = blocks.find((b) => b.state === 'current' || b.state === 'late')
  const shipDays = daysUntil(nextWeek)

  if (error) {
    return (
      <div className="h-full bg-floor text-paper grid place-items-center p-12 text-center">
        <div>
          <div className="font-display text-6xl font-extrabold text-[#FF6B6B]">Board not set up</div>
          <p className="text-3xl text-floorMute mt-4">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full bg-floor text-paper flex flex-col overflow-hidden">
      {/* ── Top strip: who, when it ships, clock ── */}
      <header className="flex items-center justify-between gap-6 px-8 pt-5 pb-3 border-b-4 border-safety">
        <h1 className="font-display font-extrabold uppercase text-[4.5vw] leading-none">{dept?.name ?? department}</h1>
        <div className="flex items-center gap-8">
          {nextWeek && (
            <div className="text-right">
              <div className="text-[1vw] tracking-[0.2em] uppercase text-floorMute">Next pickup</div>
              <div className={`font-display font-extrabold text-[3vw] leading-none ${shipDays <= 2 ? 'text-[#FF6B6B]' : 'text-safety'}`}>
                {relativeDay(shipDays).toUpperCase()}
              </div>
            </div>
          )}
          <div className="text-right">
            <div className="font-display font-bold text-[2.4vw] leading-none tabular-nums">
              {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </div>
            <div className={`text-[1vw] ${live ? 'text-[#7FD49A]' : 'text-[#FF6B6B]'}`}>{live ? '● Live' : '● Offline'}</div>
          </div>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-[1.15fr_1fr] gap-6 px-8 py-5 min-h-0">
        {/* ── Left: today, then problems ── */}
        <div className="flex flex-col gap-5 min-h-0">
          {config.today !== false && (
            <section className={`rounded-3xl border-2 px-8 py-6 ${paceCard}`}>
              <div className="flex items-baseline justify-between gap-4">
                <div className="text-[1.1vw] tracking-[0.2em] uppercase text-floorMute">Finished today</div>
                {paceWord && <div className={`font-display font-extrabold text-[1.8vw] ${paceColor}`}>{paceWord}</div>}
              </div>
              <div className="flex items-end gap-6 mt-1">
                <div className={`font-display font-extrabold leading-[0.85] tabular-nums text-[9vw] ${paceColor}`}>
                  {doneNum}
                </div>
                {target != null && <div className="font-display font-bold text-[3.5vw] text-floorMute leading-none pb-3">/ {target}</div>}
                <div className="text-[1.6vw] text-floorMute pb-4">{unit}</div>
              </div>
              {target != null ? (
                <>
                  <div className="relative h-4 rounded-full bg-floorLine overflow-hidden mt-3">
                    <i
                      className={`block h-full ${paceBar}`}
                      style={{ width: `${Math.min(100, (doneNum / target) * 100)}%` }}
                    />
                    {/* where the day itself has got to */}
                    <span className="absolute top-0 bottom-0 w-1 bg-paper/70" style={{ left: `${dayFraction * 100}%` }} />
                  </div>
                  <div className="text-[1.3vw] text-floorMute mt-2 tabular-nums">
                    {crew} {crew === 1 ? 'person' : 'people'} today ·{' '}
                    {doneNum >= target
                      ? 'target met'
                      : dayFraction === 0
                        ? `${target} to build today`
                        : behind > 0
                          ? `${behind} behind for this time of day · ${target - doneNum} left`
                          : `on pace · ${target - doneNum} left`}
                  </div>
                </>
              ) : (
                <div className="text-[1.2vw] text-floorMute mt-2">
                  {rate.perPerson ? 'No crew set for today — admin can set it on the Overview.' : 'No target set — admin sets the rate per person in Admin → TVs.'}
                </div>
              )}

              {config.blocks !== false && (
                <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: `repeat(${blocks.length}, minmax(0, 1fr))` }}>
                  {blocks.map((b) => (
                    <div key={b.label} className={`rounded-xl px-3 py-2 text-center border-2 ${BLOCK_STYLE[b.state]}`}>
                      <div className="text-[1vw] font-semibold opacity-80">{clockLabel(b.label)}</div>
                      <div className="font-display font-extrabold text-[2vw] leading-none tabular-nums mt-0.5">
                        {b.entry ? b.entry.count : b.state === 'current' ? '…' : b.state === 'late' ? '!' : '—'}
                        {b.targetByEnd != null && <span className="text-[1.1vw] font-bold opacity-70"> / {Math.round(b.targetByEnd)}</span>}
                      </div>
                      <div className="text-[0.85vw] font-semibold uppercase tracking-wider opacity-80">{BLOCK_WORD[b.state]}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[1.1vw] text-floorMute mt-2">
                {lastCount ? `Count updated ${lastCount.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'No count entered yet today'}
                {dueBlock && (
                  <span className={dueBlock.state === 'late' ? 'text-[#FF6B6B] font-bold' : ''}>
                    {' '}· {dueBlock.state === 'late' ? `update was due at ${clockLabel(dueBlock.label)}` : `next update ${clockLabel(dueBlock.label)}`}
                  </span>
                )}
              </div>
            </section>
          )}

          {config.problems !== false && (
            <section className="flex-1 rounded-3xl bg-floorCard border border-floorLine px-8 py-5 min-h-0 flex flex-col">
              <div className="text-[1.1vw] tracking-[0.2em] uppercase text-floorMute">Problems</div>
              {blocked.length === 0 ? (
                <div className="flex-1 grid place-items-center text-[2.2vw] font-display font-bold text-[#4CC46F]">All clear</div>
              ) : (
                <ul className="mt-2 space-y-3 overflow-hidden">
                  {blocked.slice(0, 4).map(({ o, id, cell }) => (
                    <li key={`${o.id}-${id}`} className="rounded-2xl bg-[#2A1C1E] border-2 border-andonRed px-5 py-3">
                      <div className="font-display font-bold text-[2vw] leading-tight">
                        <span className="text-safety">#{o.buildNo}</span> {o.tag_name}
                      </div>
                      <div className="text-[1.3vw] text-[#FF9A9A]">
                        {columnName[id]} — {blockText(cell)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {/* ── Right: what to build next ── */}
        {config.queue !== false && (
          <section className="rounded-3xl bg-floorCard border border-floorLine px-7 py-5 min-h-0 flex flex-col">
            <div className="text-[1.1vw] tracking-[0.2em] uppercase text-floorMute">Build next</div>
            {queue.length === 0 ? (
              <div className="flex-1 grid place-items-center text-[2.2vw] font-display font-bold text-[#4CC46F]">Nothing waiting</div>
            ) : (
              <ol className="mt-2 flex-1 flex flex-col gap-3 overflow-hidden">
                {queue.slice(0, 6).map((o, i) => {
                  const l = lane(o)
                  const due = daysUntil(o.scheduled_pickup_date ?? o.bt_build_weeks?.ship_date)
                  return (
                    <li
                      key={o.id}
                      className={`rounded-2xl px-5 py-3 border-2 flex items-center gap-4 ${
                        l === 'blocked' ? 'bg-[#2A1C1E] border-andonRed' : i === 0 ? 'bg-safety text-charcoal border-safety' : 'bg-floor border-floorLine'
                      }`}
                    >
                      <span className="font-display font-extrabold text-[2.6vw] leading-none tabular-nums w-[3.2vw]">{o.buildNo}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-display font-bold text-[1.9vw] leading-tight truncate">{o.tag_name}</span>
                        <span className={`block text-[1.1vw] truncate ${i === 0 && l !== 'blocked' ? 'text-charcoal/70' : 'text-floorMute'}`}>
                          {l === 'blocked' ? 'BLOCKED' : l === 'doing' ? 'In progress' : 'Not started'} · {o.dealer}
                        </span>
                      </span>
                      {due != null && (
                        <span
                          className={`font-display font-bold text-[1.5vw] rounded-xl px-3 py-1 tabular-nums whitespace-nowrap ${
                            due < 0 ? 'bg-andonRed text-white' : due <= 2 ? 'bg-[#FF6B6B] text-charcoal' : i === 0 ? 'bg-charcoal/15 text-charcoal' : 'bg-floorLine text-paper'
                          }`}
                        >
                          {due < 0 ? 'LATE' : due === 0 ? 'TODAY' : `${due}D`}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        )}
      </div>

      {/* ── Message from admin ── */}
      {config.message && (
        <footer className="bg-safety text-charcoal px-8 py-4 font-display font-bold text-[2.2vw] leading-tight">{config.message}</footer>
      )}
    </div>
  )
}

const BLOCK_STYLE = {
  met: 'bg-[#16301F] border-[#4CC46F] text-[#7FD49A]',
  close: 'bg-[#33290F] border-safety text-safety',
  short: 'bg-[#3A1719] border-[#FF6B6B] text-[#FF8A8A]',
  counted: 'bg-floor border-floorLine text-paper',
  current: 'bg-floor border-paper/60 text-paper',
  late: 'bg-[#3A1719] border-[#FF6B6B] text-[#FF8A8A] animate-pulse',
  missed: 'bg-floor border-floorLine text-floorMute',
  upcoming: 'bg-floor border-floorLine text-floorMute',
}
const BLOCK_WORD = {
  met: 'target met',
  close: 'close',
  short: 'short',
  counted: 'counted',
  current: 'now',
  late: 'update late',
  missed: 'no update',
  upcoming: 'later',
}
