import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { DONE_RANK, buildNumbers, byBuildOrder, daysUntil, relativeDay, stageRank } from '../lib/schedule'
import { blockText, checkinBlocks, clockLabel, countedProcesses, fmtQty, isoDate, planLine, processesFor, productiveMinutesPerDay, rateFor, ratePerHourOf, useSettings, workingMinutesBetween } from '../lib/catalog'

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
  const [finished, setFinished] = useState([]) // orders this department finished today: { id, tag_name, buildNo, mods_count, at }
  const [crew, setCrew] = useState(null)
  const [counts, setCounts] = useState([]) // today's check-ins, oldest first: { process, count, at }
  const [processPeople, setProcessPeople] = useState({}) // processId -> people today
  const [error, setError] = useState('')
  const [now, setNow] = useState(new Date())
  const { session, signOut } = useAuth()
  // Controls stay hidden so the board is clean from across the shop;
  // moving the mouse shows them for a few seconds.
  const [showControls, setShowControls] = useState(false)
  useEffect(() => {
    let t
    const reveal = () => {
      setShowControls(true)
      clearTimeout(t)
      t = setTimeout(() => setShowControls(false), 5000)
    }
    window.addEventListener('mousemove', reveal)
    window.addEventListener('touchstart', reveal)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousemove', reveal)
      window.removeEventListener('touchstart', reveal)
    }
  }, [])

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
        ? await supabase.from('bt_activity').select('order_id, status_column_id, at').eq('kind', 'done').gte('at', midnight.toISOString()).in('status_column_id', ids).order('at')
        : { data: [] }
      const { data: crewRow } = await supabase
        .from('bt_crew_days')
        .select('people')
        .eq('work_date', today)
        .eq('department_id', mine.id)
        .maybeSingle()

      const { data: countRows } = await supabase
        .from('bt_output_counts')
        .select('process, count, at')
        .eq('department_id', mine.id)
        .eq('work_date', today)
        .order('at')
      const { data: procDays } = await supabase
        .from('bt_process_days')
        .select('process, people')
        .eq('department_id', mine.id)
        .eq('work_date', today)

      if (!alive) return
      setCounts((countRows ?? []).map((c) => ({ process: c.process, count: Number(c.count), at: new Date(c.at) })))
      setProcessPeople(Object.fromEntries((procDays ?? []).map((r) => [r.process, Number(r.people)])))
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

      const lastDoneAt = new Map()
      for (const r of doneRows ?? []) lastDoneAt.set(r.order_id, new Date(r.at))
      const missing = [...lastDoneAt.keys()].filter((id) => !byId.has(id))
      const { data: pickedUp } = missing.length
        ? await supabase.from('bt_orders').select('id, tag_name, mods_count').in('id', missing)
        : { data: [] }
      const info = new Map([...byId.values(), ...(pickedUp ?? [])].map((o) => [o.id, o]))
      const done = [...lastDoneAt.entries()]
        .filter(([id]) => {
          // Still in progress here (reopened, or another of its jobs open)? Not finished.
          const o = byId.get(id)
          if (!o) return true
          const own = ids.map((c) => o.cells[c]).filter(Boolean)
          return own.length > 0 && own.every((c) => stageRank(c.stage) >= DONE_RANK)
        })
        .map(([id, at]) => ({ id, at, tag_name: info.get(id)?.tag_name ?? `order ${id}`, buildNo: byId.get(id)?.buildNo, mods_count: info.get(id)?.mods_count ?? null }))
        .sort((a, b) => b.at - a.at)
      if (!alive) return
      setFinished(done)
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_process_days' }, load)
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
  const processes = processesFor(settings, dept?.name ?? department)
  const plan = processes.length ? planLine(processes, processPeople, settings) : null
  const finalStep = plan ? plan.steps[plan.steps.length - 1] : null
  const countsFor = (processId) => counts.filter((c) => (c.process ?? null) === (processId ?? null))

  // With processes, the day's number is the LAST step's count (what the
  // line actually finished) against what the bottleneck allows. Without,
  // it's the department's own count against people × daily rate.
  const target = plan
    ? plan.capacity != null
      ? Math.round(plan.capacity * (Number(finalStep.perFinished) || 1))
      : null
    : crew != null && rate.perPerson
      ? Math.round(crew * rate.perPerson)
      : null
  // What the crew counted beats what the app can infer: orders only
  // finish in lumps, a count every two hours shows the real pace.
  const ownCounts = plan ? countsFor(finalStep.id) : countsFor(null)
  const lastCount = ownCounts.length ? ownCounts[ownCounts.length - 1] : null
  // Count mods only when every finished order has a mod count — one
  // without it would otherwise add nothing and the number would stall.
  // Mod counts only describe Mods' output; every other department counts orders.
  const isMods = (dept?.name ?? department).toLowerCase() === 'mods'
  const useMods = isMods && (finished.length ? finished.every((f) => f.mods_count) : orders.some((o) => o.mods_count))
  const finishedMods = finished.reduce((sum, f) => sum + (f.mods_count ?? 0), 0)
  const doneNum = lastCount ? lastCount.count : useMods ? finishedMods : finished.length
  const unit = lastCount ? (plan ? finalStep.unit : rate.unit) : useMods ? (plan ? finalStep.unit : 'mods') : finished.length === 1 ? 'order' : 'orders'

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
  const blocksFor = (list, dailyTarget) => checkinBlocks(settings, dailyTarget).map((b, i, all) => {
    const prevEnd = i ? all[i - 1].end : null
    const entry = [...list].reverse().find((c) => c.at <= new Date(b.end.getTime() + GRACE) && (!prevEnd || c.at > new Date(prevEnd.getTime() - 60 * 60000)))
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
  const blocks = blocksFor(ownCounts, target)
  const dueBlock = blocks.find((b) => b.state === 'current' || b.state === 'late')
  // One row per process: its own count, target and blocks.
  const processRows = plan
    ? countedProcesses(plan.steps).map((st) => {
        const list = countsFor(st.id)
        return { ...st, last: list.length ? list[list.length - 1] : null, blocks: blocksFor(list, st.daily) }
      })
    : []
  const shipDays = daysUntil(nextWeek)

  if (error) {
    return (
      <div className="h-full bg-floor text-paper grid place-items-center p-12 text-center">
        <div>
          <div className="font-display text-6xl font-extrabold text-[#FF6B6B]">Board not set up</div>
          <p className="text-3xl text-floorMute mt-4">{error}</p>
          <button
            onClick={async () => {
              await signOut()
              window.location.href = '/'
            }}
            className="mt-8 rounded-xl bg-safety px-6 py-3 text-2xl font-bold text-charcoal"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full bg-floor text-paper flex flex-col overflow-hidden">
      {/* ── Top strip: who, when it ships, clock ── */}
      {showControls && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-charcoal/95 border border-floorLine px-4 py-2 shadow-2xl">
          <span className="text-sm text-floorMute">{session?.user?.email}</span>
          <button onClick={() => window.location.reload()} className="rounded-lg border border-floorLine px-3 py-1.5 text-sm text-paper">
            Reload
          </button>
          <button
            onClick={async () => {
              await signOut()
              window.location.href = '/'
            }}
            className="rounded-lg bg-safety px-3 py-1.5 text-sm font-bold text-charcoal"
          >
            Sign out
          </button>
        </div>
      )}
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
                    {plan ? Object.values(processPeople).reduce((a, b) => a + b, 0) : crew}{' '}
                    {(plan ? Object.values(processPeople).reduce((a, b) => a + b, 0) : crew) === 1 ? 'person' : 'people'} today ·{' '}
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
                  {plan
                    ? processes.some((p) => !ratePerHourOf(p))
                      ? 'No target yet — admin sets each process’s minutes in Admin → Targets & TVs.'
                      : 'No crew set for today — admin sets people per process on the Overview.'
                    : rate.perPerson
                      ? 'No crew set for today — admin can set it on the Overview.'
                      : 'No target set — admin sets the rate per person in Admin → Targets & TVs.'}
                </div>
              )}

              {config.blocks !== false && plan && (
                <div className="mt-4 grid gap-2">
                  {processRows.map((st) => (
                    <div key={st.id} className="grid grid-cols-[minmax(0,11vw)_minmax(0,7vw)_1fr] items-center gap-3">
                      <div className={`font-display font-bold text-[1.4vw] leading-tight truncate ${plan.bottleneck?.id === st.id ? 'text-[#FF8A8A]' : ''}`}>
                        {st.name}
                        {plan.bottleneck?.id === st.id && <span className="block text-[0.8vw] tracking-wider uppercase">bottleneck</span>}
                      </div>
                      <div className="font-display font-extrabold text-[1.8vw] tabular-nums leading-none">
                        {st.last ? fmtQty(st.last.count) : '—'}
                        <span className="text-[1vw] text-floorMute"> / {st.daily != null ? fmtQty(st.daily) : '—'}</span>
                      </div>
                      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${st.blocks.length}, minmax(0, 1fr))` }}>
                        {st.blocks.map((b) => (
                          <div key={b.label} className={`rounded-lg px-1 py-1 text-center border-2 ${BLOCK_STYLE[b.state]}`}>
                            <div className="text-[0.8vw] font-semibold opacity-80 leading-none">{clockLabel(b.label)}</div>
                            <div className="font-display font-extrabold text-[1.3vw] leading-none tabular-nums mt-0.5">
                              {b.entry ? fmtQty(b.entry.count) : b.state === 'late' ? '!' : '—'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {config.blocks !== false && !plan && (
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
                {plan?.capacity != null && (
                  <span>
                    Line can finish {fmtQty(plan.capacity)} {finalStep.unit} today · bottleneck {plan.bottleneck.name} ·{' '}
                  </span>
                )}
                {lastCount
                  ? `Showing the crew's count from ${lastCount.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
                  : `Counting orders marked Done${useMods ? ' (in mods)' : ''} — no crew count yet today`}
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
            {finished.length > 0 && (
              <div className="mt-3 pt-3 border-t border-floorLine">
                <div className="text-[1vw] tracking-[0.2em] uppercase text-[#7FD49A]">
                  ✓ Finished today · {finished.length} {finished.length === 1 ? 'order' : 'orders'}
                  {isMods && finishedMods > 0 && ` · ${finishedMods} mods`}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {finished.slice(0, 8).map((f) => (
                    <span key={f.id} className="rounded-lg bg-[#16301F] border border-[#4CC46F] text-[#7FD49A] px-3 py-1 text-[1.1vw] font-semibold">
                      {f.buildNo ? `#${f.buildNo} ` : ''}
                      {f.tag_name} · {f.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  ))}
                  {finished.length > 8 && (
                    <span className="rounded-lg border border-[#4CC46F] text-[#7FD49A] px-3 py-1 text-[1.1vw] font-semibold">+{finished.length - 8} more</span>
                  )}
                </div>
              </div>
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
