import { supabase } from './supabaseClient'
import { blockCategoryLabel, defectLabel, difficulty, orderPersonDays, isoDate, workingMinutesBetween, roomSize } from './catalog'
import { buildNumbers, stageRank, DONE_RANK } from './schedule'

/**
 * The weekly production report, as an Excel workbook.
 *
 * Everything comes from what the floor recorded (bt_activity, the job
 * timestamps, quality issues, crew days) — nothing is typed in for the
 * report. Durations are in WORKING hours (shift hours on workdays, minus
 * breaks), so a job left overnight doesn't look like it took 16 hours.
 *
 * Sheets: Summary · Orders · Department jobs · Blocks · Quality ·
 * People · Crew · Activity log.
 */
export async function downloadWeeklyReport({ start, end, settings }) {
  const data = await loadWeek(start, end)
  const sheets = buildSheets(data, { start, end, settings })

  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (const [name, rows, widths] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    if (widths) ws['!cols'] = widths.map((wch) => ({ wch }))
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  XLSX.writeFile(wb, `Production report ${isoDate(start)} to ${isoDate(addDays(end, -1))}.xlsx`)
}

async function loadWeek(start, end) {
  // Blocks can start before the week and still be running in it, so the
  // log is read a few weeks back and clipped to the week afterwards.
  const logFrom = addDays(start, -28).toISOString()
  const [activity, quality, crew, columns, depts, deptCols, profiles, weeks] = await Promise.all([
    all(supabase.from('bt_activity').select('*').gte('at', logFrom).lt('at', end.toISOString()).order('at')),
    all(supabase.from('bt_quality_issues').select('*').or(`resolved_at.is.null,resolved_at.gte.${start.toISOString()}`).lt('created_at', end.toISOString())),
    all(supabase.from('bt_crew_days').select('*').gte('work_date', isoDate(start)).lt('work_date', isoDate(end))),
    all(supabase.from('bt_status_columns').select('id, name')),
    all(supabase.from('bt_departments').select('id, name').order('sort_order')),
    all(supabase.from('bt_department_columns').select('department_id, status_column_id')),
    all(supabase.from('bt_profiles').select('user_id, display_name, role')),
    all(supabase.from('bt_build_weeks').select('id, label, ship_date')),
  ])

  // Orders that matter this week: anything with activity or a quality
  // issue in the week, or picking up in it.
  const inWeek = (ts) => ts && new Date(ts) >= start && new Date(ts) < end
  const orderIds = new Set([
    ...activity.filter((a) => inWeek(a.at)).map((a) => a.order_id),
    ...quality.map((q) => q.order_id),
  ])
  const pickupOrders = await all(
    supabase.from('bt_orders').select('id').gte('scheduled_pickup_date', isoDate(start)).lt('scheduled_pickup_date', isoDate(end))
  )
  pickupOrders.forEach((o) => orderIds.add(o.id))
  const ids = [...orderIds].filter(Boolean)

  const orders = ids.length ? await all(supabase.from('bt_orders').select('*').in('id', ids)) : []
  const jobs = ids.length ? await all(supabase.from('bt_order_status').select('*').in('order_id', ids)) : []
  // Build numbers are positions among each pickup's active orders.
  const weekIds = [...new Set(orders.map((o) => o.build_week_id).filter(Boolean))]
  const siblings = weekIds.length
    ? await all(supabase.from('bt_orders').select('id, build_week_id, sequence, status').in('build_week_id', weekIds))
    : []

  return { activity, quality, crew, columns, depts, deptCols, profiles, weeks, orders, jobs, siblings }
}

export function buildSheets(d, { start, end, settings }) {
  const shift = settings.shift
  const colName = Object.fromEntries(d.columns.map((c) => [c.id, c.name]))
  const deptName = Object.fromEntries(d.depts.map((x) => [x.id, x.name]))
  const deptOfCol = {}
  for (const r of d.deptCols) deptOfCol[r.status_column_id] ??= deptName[r.department_id]
  const who = Object.fromEntries(d.profiles.map((p) => [p.user_id, p.display_name || p.role]))
  const orderById = Object.fromEntries(d.orders.map((o) => [o.id, o]))
  const weekById = Object.fromEntries(d.weeks.map((w) => [w.id, w]))
  const buildNo = buildNumbers(d.siblings)
  const inWeek = (ts) => ts && new Date(ts) >= start && new Date(ts) < end
  const hours = (min) => (min == null ? '' : Math.round((min / 60) * 10) / 10)
  const dt = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '')
  const tag = (id) => orderById[id]?.tag_name ?? `order ${id}`
  const clip = (a, b) => [new Date(Math.max(new Date(a), start)), new Date(Math.min(new Date(b ?? Date.now()), end))]

  // ── Block episodes: pair each 'blocked' with the next 'unblocked' on the same job.
  const episodes = []
  const openBlock = new Map()
  for (const a of d.activity) {
    const key = `${a.order_id}:${a.status_column_id}`
    if (a.kind === 'blocked') openBlock.set(key, a)
    else if (a.kind === 'unblocked' && openBlock.has(key)) {
      episodes.push({ from: openBlock.get(key), to: a })
      openBlock.delete(key)
    }
  }
  for (const from of openBlock.values()) episodes.push({ from, to: null })
  const weekEpisodes = episodes
    .filter((e) => new Date(e.from.at) < end && (!e.to || new Date(e.to.at) >= start))
    .map((e) => {
      const [a, b] = clip(e.from.at, e.to?.at)
      return { ...e, minutes: workingMinutesBetween(a, b, shift) }
    })

  // ── Department jobs
  const jobRows = d.jobs
    .filter((j) => !j.removed_at)
    .map((j) => {
      const blocked = weekEpisodes.filter((e) => e.from.order_id === j.order_id && e.from.status_column_id === j.status_column_id)
      return {
        j,
        dept: deptOfCol[j.status_column_id] ?? colName[j.status_column_id],
        minutes: j.started_at && j.completed_at ? workingMinutesBetween(j.started_at, j.completed_at, shift) : null,
        blockedMinutes: blocked.reduce((s, e) => s + (e.minutes ?? 0), 0),
        doneThisWeek: inWeek(j.completed_at),
      }
    })

  const quality = d.quality.map((q) => ({
    q,
    openMinutes: workingMinutesBetween(q.created_at, q.resolved_at ?? new Date(), shift),
  }))

  // ── Mods produced and expected
  const modsCols = new Set(Object.entries(deptOfCol).filter(([, n]) => n === 'Mods').map(([c]) => Number(c)))
  const modsJobsDone = jobRows.filter((r) => r.doneThisWeek && modsCols.has(r.j.status_column_id))
  const modsBuilt = modsJobsDone.reduce((s, r) => s + (orderById[r.j.order_id]?.mods_count ?? 0), 0)
  const modsDeptId = d.depts.find((x) => x.name === 'Mods')?.id
  const modsCrewDays = d.crew.filter((c) => c.department_id === modsDeptId)
  const modsExpected = modsCrewDays.reduce((s, c) => s + Number(c.people) * settings.mods_per_person_day, 0)

  // ── Pickups in the week, on time or late
  const pickups = d.orders.filter((o) => o.scheduled_pickup_date && o.scheduled_pickup_date >= isoDate(start) && o.scheduled_pickup_date < isoDate(end))
  const late = pickups.filter((o) => !o.actual_pickup_date || isoDate(new Date(o.actual_pickup_date)) > o.scheduled_pickup_date)

  const count = (list, keyFn) => {
    const m = new Map()
    for (const x of list) m.set(keyFn(x), (m.get(keyFn(x)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const sumBy = (list, keyFn, valFn) => {
    const m = new Map()
    for (const x of list) m.set(keyFn(x), (m.get(keyFn(x)) ?? 0) + valFn(x))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const blockHoursByCat = sumBy(weekEpisodes, (e) => blockCategoryLabel[e.from.category] ?? e.from.category ?? 'Not given', (e) => e.minutes ?? 0)
  const blockHoursByDept = sumBy(weekEpisodes, (e) => deptOfCol[e.from.status_column_id] ?? colName[e.from.status_column_id] ?? '—', (e) => e.minutes ?? 0)
  const weekQuality = quality.filter((x) => inWeek(x.q.created_at))
  const qualityByType = count(weekQuality, (x) => defectLabel[x.q.defect_type] ?? x.q.defect_type)
  const qualityByDept = count(weekQuality, (x) => deptOfCol[x.q.responsible_column_id] ?? colName[x.q.responsible_column_id] ?? 'Not assigned')

  const lastDay = addDays(end, -1)
  const summary = [
    ['Production report'],
    ['Week', `${start.toDateString()} – ${lastDay.toDateString()}`],
    ['Generated', new Date().toLocaleString()],
    [],
    ['OUTPUT'],
    ['Mods built (orders whose Mods job was finished this week)', modsBuilt],
    ['Mods expected from crew entered', modsCrewDays.length ? modsExpected : 'no crew entered'],
    ['Mods: actual vs expected', modsCrewDays.length && modsExpected ? `${Math.round((modsBuilt / modsExpected) * 100)}%` : ''],
    ['Department jobs finished', jobRows.filter((r) => r.doneThisWeek).length],
    ...d.depts.map((x) => [`  ${x.name}`, jobRows.filter((r) => r.doneThisWeek && r.dept === x.name).length]),
    [],
    ['PICKUPS'],
    ['Orders due for pickup this week', pickups.length],
    ['Picked up on time', pickups.length - late.length],
    ['Late or not picked up', late.length],
    [],
    ['BLOCKED TIME (working hours)'],
    ['Total', hours(weekEpisodes.reduce((s, e) => s + (e.minutes ?? 0), 0))],
    ...blockHoursByCat.map(([k, v]) => [`  ${k}`, hours(v)]),
    ['By department'],
    ...blockHoursByDept.map(([k, v]) => [`  ${k}`, hours(v)]),
    [],
    ['QUALITY'],
    ['Issues logged', weekQuality.length],
    ['Sent back for rework', weekQuality.filter((x) => x.q.sent_back).length],
    ['Still open', quality.filter((x) => !x.q.resolved_at).length],
    ['By problem'],
    ...qualityByType.map(([k, v]) => [`  ${k}`, v]),
    ['By department that made it'],
    ...qualityByDept.map(([k, v]) => [`  ${k}`, v]),
    [],
    ['TOP PROBLEMS THIS WEEK'],
    ...topProblems(blockHoursByCat, qualityByType, hours).map((t, i) => [`${i + 1}.`, t]),
  ]

  const orderSheet = [
    ['Pickup', '#', 'Tag', 'Dealer', 'Status', 'Mods', 'Room', 'Windows', 'Panels', 'Size', 'Difficulty', 'Est. person-days',
      ...d.depts.map((x) => `${x.name} hrs`), 'Blocked hrs', 'Quality issues', 'Picked up'],
    ...d.orders
      .sort((a, b) => (a.scheduled_pickup_date ?? '').localeCompare(b.scheduled_pickup_date ?? '') || (buildNo.get(a.id) ?? 0) - (buildNo.get(b.id) ?? 0))
      .map((o) => {
        const mine = jobRows.filter((r) => r.j.order_id === o.id)
        const deptHours = d.depts.map((x) => {
          const js = mine.filter((r) => r.dept === x.name)
          if (!js.length) return ''
          if (js.some((r) => r.minutes == null)) return stageRank(js[0].j.workflow_stage) >= DONE_RANK ? '' : 'not done'
          return hours(js.reduce((s, r) => s + r.minutes, 0))
        })
        return [
          weekById[o.build_week_id]?.label ?? o.scheduled_pickup_date ?? '',
          buildNo.get(o.id) ?? '',
          o.tag_name,
          o.dealer ?? '',
          o.status === 'cancelled' ? `Cancelled${o.cancel_reason ? ` — ${o.cancel_reason}` : ''}` : mine.every((r) => stageRank(r.j.workflow_stage) >= DONE_RANK) ? 'Built' : 'In progress',
          o.mods_count ?? '',
          o.room_shape ?? '',
          o.window_type ?? '',
          o.panel_type ?? '',
          roomSize(o.mods_count, settings) ?? '',
          difficulty(o) ?? '',
          orderPersonDays(o, settings)?.toFixed(1) ?? '',
          ...deptHours,
          hours(mine.reduce((s, r) => s + r.blockedMinutes, 0)),
          quality.filter((x) => x.q.order_id === o.id).length,
          o.actual_pickup_date ? dt(o.actual_pickup_date) : '',
        ]
      }),
  ]

  const jobSheet = [
    ['Tag', 'Department', 'Column', 'Stage', 'Started', 'Finished', 'Working hrs', 'Blocked hrs', 'Built by'],
    ...jobRows.map((r) => [
      tag(r.j.order_id),
      r.dept,
      colName[r.j.status_column_id],
      ['Not started', 'Started', 'Done'][stageRank(r.j.workflow_stage)],
      dt(r.j.started_at),
      dt(r.j.completed_at),
      hours(r.minutes),
      hours(r.blockedMinutes),
      r.j.built_by ?? '',
    ]),
  ]

  const blockSheet = [
    ['Tag', 'Department', 'Reason', 'Note', 'Blocked at', 'Cleared at', 'Working hrs (this week)', 'Reported by'],
    ...weekEpisodes.map((e) => [
      tag(e.from.order_id),
      deptOfCol[e.from.status_column_id] ?? colName[e.from.status_column_id] ?? '',
      blockCategoryLabel[e.from.category] ?? e.from.category ?? '',
      e.from.note ?? '',
      dt(e.from.at),
      e.to ? dt(e.to.at) : 'still blocked',
      hours(e.minutes),
      who[e.from.actor] ?? '',
    ]),
  ]

  const qualitySheet = [
    ['Logged', 'Tag', 'Problem', 'Made by', 'Found by', 'Note', 'Sent back', 'Closed', 'Working hrs open', 'How it was fixed', 'Reported by'],
    ...quality.map(({ q, openMinutes }) => [
      dt(q.created_at),
      tag(q.order_id),
      defectLabel[q.defect_type] ?? q.defect_type,
      deptOfCol[q.responsible_column_id] ?? colName[q.responsible_column_id] ?? '',
      q.reporter_column_id ? deptOfCol[q.reporter_column_id] ?? colName[q.reporter_column_id] : 'Quality',
      q.note ?? '',
      q.sent_back ? 'Yes' : '',
      q.resolved_at ? dt(q.resolved_at) : 'open',
      hours(openMinutes),
      q.resolution_note ?? '',
      who[q.reported_by] ?? '',
    ]),
  ]

  // People: from the optional "who built it" names. Several names on one
  // job share its mods equally.
  const people = new Map()
  for (const r of jobRows.filter((x) => x.doneThisWeek && x.j.built_by)) {
    const names = r.j.built_by.split(/[,&/]| and /).map((n) => n.trim()).filter(Boolean)
    const mods = modsCols.has(r.j.status_column_id) ? orderById[r.j.order_id]?.mods_count ?? 0 : 0
    for (const n of names) {
      const key = `${n}|${r.dept}`
      const p = people.get(key) ?? { name: n, dept: r.dept, jobs: 0, mods: 0, issues: 0 }
      p.jobs++
      p.mods += mods / names.length
      people.set(key, p)
    }
  }
  for (const { q } of quality) {
    const job = d.jobs.find((j) => j.order_id === q.order_id && j.status_column_id === q.responsible_column_id)
    for (const n of (job?.built_by ?? '').split(/[,&/]| and /).map((x) => x.trim()).filter(Boolean)) {
      const p = people.get(`${n}|${deptOfCol[q.responsible_column_id]}`)
      if (p) p.issues++
    }
  }
  const peopleSheet = [
    ['Name', 'Department', 'Jobs finished', 'Mods (shared equally)', 'Quality issues on their jobs'],
    ...[...people.values()].sort((a, b) => b.mods - a.mods).map((p) => [p.name, p.dept, p.jobs, Math.round(p.mods * 10) / 10, p.issues]),
  ]
  if (people.size === 0) peopleSheet.push(['No names entered this week — add them in Grid → Edit → Who built it.'])

  const crewSheet = [
    ['Date', 'Department', 'People', 'Mods target'],
    ...d.crew
      .sort((a, b) => a.work_date.localeCompare(b.work_date))
      .map((c) => [c.work_date, deptName[c.department_id], Number(c.people), c.department_id === modsDeptId ? Number(c.people) * settings.mods_per_person_day : '']),
  ]

  const logSheet = [
    ['Time', 'Tag', 'Department', 'What', 'Detail', 'Note', 'By'],
    ...d.activity
      .filter((a) => inWeek(a.at))
      .map((a) => [
        dt(a.at),
        tag(a.order_id),
        a.status_column_id ? deptOfCol[a.status_column_id] ?? colName[a.status_column_id] : '',
        a.kind.replace('_', ' '),
        a.category ? blockCategoryLabel[a.category] ?? defectLabel[a.category] ?? a.category : a.to_stage ?? '',
        a.note ?? '',
        who[a.actor] ?? '',
      ]),
  ]

  return [
    ['Summary', summary, [52, 28]],
    ['Orders', orderSheet, [14, 5, 32, 30, 16, 6, 10, 10, 13, 8, 10, 10, ...d.depts.map(() => 10), 10, 9, 16]],
    ['Department jobs', jobSheet, [32, 12, 16, 11, 16, 16, 11, 11, 22]],
    ['Blocks', blockSheet, [32, 12, 26, 36, 16, 16, 12, 16]],
    ['Quality', qualitySheet, [16, 32, 24, 14, 12, 36, 9, 16, 12, 30, 16]],
    ['People', peopleSheet, [22, 14, 13, 20, 26]],
    ['Crew', crewSheet, [12, 14, 8, 12]],
    ['Activity log', logSheet, [16, 32, 12, 14, 24, 36, 16]],
  ]
}

function topProblems(blockHoursByCat, qualityByType, hours) {
  const out = []
  for (const [k, v] of blockHoursByCat.slice(0, 2)) if (v > 0) out.push(`${k}: ${hours(v)} blocked hours`)
  for (const [k, v] of qualityByType.slice(0, 2)) out.push(`${k}: ${v} quality issue${v === 1 ? '' : 's'}`)
  return out.length ? out.slice(0, 3) : ['Nothing blocked and no quality issues logged.']
}

/** Supabase caps a response at 1000 rows; page through everything. */
async function all(query) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query.range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

function addDays(d, n) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** Monday 00:00 of the week containing `d`. */
export function weekStart(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}
