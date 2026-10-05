import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { DONE_RANK, daysUntil, relativeDay, shortDate, stageLabel, stageRank } from '../lib/schedule'
import { blockText, defectLabel } from '../lib/catalog'
import { dbErrorText } from '../lib/dbError'
import { Chip, Sheet } from './ui.jsx'

const BUCKET = 'bt-files'
const COUNT_FIELDS = [
  ['v4t_frames', 'V4T frames'],
  ['vents', 'Vents'],
  ['walls', 'Walls (sheet)'],
  ['windows', 'Windows'],
]
const KIND_WORDS = {
  started: 'started',
  done: 'done',
  reopened: 'reopened',
  blocked: 'blocked',
  unblocked: 'block cleared',
  dept_removed: 'taken off the order',
  dept_restored: 'put back on the order',
  moved: 'moved in the build order',
  cancelled: 'order cancelled',
  restored: 'order restored',
  order_added: 'order added',
  quality_issue: 'quality issue',
  quality_resolved: 'quality issue resolved',
  sent_back: 'sent back',
}
const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''

/**
 * Everything about one order on one page: where it is in every
 * department, its paperwork, its counts, its quality issues and what
 * happened to it. The same panel from a tablet card, the office list and
 * the admin grid.
 *
 *   order    at least { id, tag_name }
 *   canEdit  office / admin: counts can be changed here
 *   tone     'floor' on the tablets, 'paper' elsewhere
 */
export default function OrderSheet({ order, onClose, canEdit = false, tone = 'paper', top = null }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState('')
  const floor = tone === 'floor'

  async function load() {
    const id = order.id
    const [o, st, depts, dcols, cols, files, qty, issues, acts] = await Promise.all([
      supabase
        .from('bt_orders')
        .select('id, tag_name, dealer, scheduled_pickup_date, truck_route, mods_count, walls_count, paperwork_ready_at, notes, bt_build_weeks(ship_date)')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('bt_order_status')
        .select('status_column_id, workflow_stage, started_at, completed_at, blocked_at, blocked_note, blocked_category, removed_at, is_visible')
        .eq('order_id', id),
      supabase.from('bt_departments').select('id, name, sort_order').order('sort_order'),
      supabase.from('bt_department_columns').select('department_id, status_column_id'),
      supabase.from('bt_status_columns').select('id, name, sort_order'),
      supabase.from('bt_files').select('id, filename, storage_path, uploaded_at, dept_label, page').eq('order_id', id).order('uploaded_at', { ascending: false }),
      supabase.from('bt_order_quantities').select('measure, qty, source').eq('order_id', id),
      supabase.from('bt_quality_issues').select('id, defect_type, note, sent_back, responsible_column_id, created_at, resolved_at').eq('order_id', id).order('created_at', { ascending: false }),
      supabase.from('bt_activity').select('id, at, kind, status_column_id, note, category').eq('order_id', id).order('at', { ascending: false }).limit(40),
    ])
    if (o.error || st.error) setError(dbErrorText(o.error ?? st.error, "Couldn't load this order"))
    setData({
      order: o.data ?? order,
      status: st.data ?? [],
      depts: depts.data ?? [],
      dcols: dcols.data ?? [],
      cols: cols.data ?? [],
      files: files.data ?? [],
      qty: Object.fromEntries((qty.data ?? []).map((q) => [q.measure, { qty: Number(q.qty), source: q.source }])),
      issues: issues.data ?? [],
      acts: acts.data ?? [],
    })
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel(`order-sheet-${order.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status', filter: `order_id=eq.${order.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_files', filter: `order_id=eq.${order.id}` }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id])

  // Every department on the order, its jobs in sheet order.
  const progress = useMemo(() => {
    if (!data) return []
    const colName = Object.fromEntries(data.cols.map((c) => [c.id, c.name]))
    const colSort = Object.fromEntries(data.cols.map((c) => [c.id, c.sort_order ?? 0]))
    const deptOfCol = {}
    for (const dc of data.dcols) deptOfCol[dc.status_column_id] ??= dc.department_id
    const groups = new Map()
    for (const s of data.status) {
      if (s.removed_at || s.is_visible === false) continue
      const d = data.depts.find((x) => x.id === deptOfCol[s.status_column_id])
      const key = d ? d.name : colName[s.status_column_id] ?? 'Other'
      if (!groups.has(key)) groups.set(key, { name: key, sort: d?.sort_order ?? 999, jobs: [] })
      groups.get(key).jobs.push({ ...s, name: colName[s.status_column_id] ?? `Column ${s.status_column_id}`, sort: colSort[s.status_column_id] })
    }
    return [...groups.values()]
      .map((g) => {
        g.jobs.sort((a, b) => a.sort - b.sort)
        g.done = g.jobs.filter((j) => stageRank(j.workflow_stage) >= DONE_RANK).length
        g.blocked = g.jobs.some((j) => j.blocked_at)
        g.started = g.jobs.some((j) => stageRank(j.workflow_stage) === 1)
        return g
      })
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  }, [data])

  const colName = useMemo(() => Object.fromEntries((data?.cols ?? []).map((c) => [c.id, c.name])), [data])

  async function openFile(f) {
    const { data: u, error: e } = await supabase.storage.from(BUCKET).createSignedUrl(f.storage_path, 60)
    if (!e && u?.signedUrl) window.open(f.page > 1 ? `${u.signedUrl}#page=${f.page}` : u.signedUrl, '_blank')
  }

  async function attach(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setSaving('upload')
    const path = `${o.tag_name.replace(/[^\w.-]+/g, '_')}/${Date.now()}_${file.name.replace(/[^\w.-]+/g, '_')}`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file)
    if (upErr) setError(upErr.message)
    else {
      const { data: u } = await supabase.auth.getUser()
      const { error: e2 } = await supabase.from('bt_files').insert({ order_id: order.id, filename: file.name, storage_path: path, uploaded_by: u?.user?.id })
      if (e2) setError(dbErrorText(e2, "Couldn't attach the file"))
    }
    setSaving('')
    load()
  }

  async function removeFile(f) {
    if (!window.confirm(`Remove ${f.filename} from ${o.tag_name}?`)) return
    await supabase.storage.from(BUCKET).remove([f.storage_path])
    await supabase.from('bt_files').delete().eq('id', f.id)
    load()
  }

  async function saveCount(measure, raw) {
    const value = raw === '' ? null : Number(raw)
    const had = data.qty[measure]
    if (value === null && !had) return
    if (value !== null && had?.qty === value && had.source === 'typed') return
    setSaving(measure)
    const { error: e } =
      value === null
        ? await supabase.from('bt_order_quantities').delete().eq('order_id', order.id).eq('measure', measure)
        : await supabase
            .from('bt_order_quantities')
            .upsert({ order_id: order.id, measure, qty: value, source: 'typed', updated_at: new Date().toISOString() }, { onConflict: 'order_id,measure' })
    setSaving('')
    if (e) setError(dbErrorText(e, "Couldn't save the count"))
    load()
  }

  const o = data?.order ?? order
  const pickup = o.scheduled_pickup_date ?? o.bt_build_weeks?.ship_date
  const days = daysUntil(pickup)
  const done = progress.filter((g) => g.done === g.jobs.length).length

  const muted = floor ? 'text-floorMute' : 'text-steelLight'
  const box = floor ? 'bg-floorCard border-floorLine' : 'bg-white border-paperDim'
  const h = `font-display font-bold uppercase tracking-wide text-lg ${floor ? 'text-paper' : 'text-charcoal'}`

  return (
    <Sheet
      open
      onClose={onClose}
      tone={tone}
      title={o.tag_name}
      sub={[o.dealer, pickup ? `picks up ${shortDate(pickup)} · ${relativeDay(days)}` : null].filter(Boolean).join(' · ')}
    >
      <div className="p-4 space-y-5">
        {error && <p className="rounded-lg bg-andonRedBg text-andonRed text-sm px-3 py-2">⚠ {error}</p>}
        {top}
        {!data && <p className={`text-sm ${muted}`}>Loading…</p>}

        {data && (
          <>
            {/* ── Where it is ── */}
            <section>
              <div className="flex items-baseline justify-between">
                <h3 className={h}>Progress</h3>
                <span className={`text-sm tabular-nums ${muted}`}>
                  {done} of {progress.length} departments done
                </span>
              </div>
              <ol className="mt-2 space-y-2">
                {progress.map((g) => {
                  const state = g.blocked ? 'bad' : g.done === g.jobs.length ? 'good' : g.started || g.done > 0 ? 'info' : 'neutral'
                  return (
                    <li key={g.name} className={`rounded-xl border p-3 ${box}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-display font-bold text-lg leading-tight">{g.name}</div>
                        <Chip tone={tone} kind={state}>
                          {g.blocked ? '⚑ Blocked' : g.done === g.jobs.length ? '✓ Done' : g.started || g.done ? 'In progress' : 'Not started'}
                          {g.jobs.length > 1 && ` · ${g.done}/${g.jobs.length}`}
                        </Chip>
                      </div>
                      <ul className="mt-1.5 space-y-1">
                        {g.jobs.map((j) => {
                          const r = stageRank(j.workflow_stage)
                          return (
                            <li key={j.status_column_id} className="text-sm">
                              <div className="flex items-center gap-2">
                                <i
                                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                                    j.blocked_at ? 'bg-andonRed' : r >= DONE_RANK ? 'bg-[#4CC46F]' : r === 1 ? 'bg-[#5B9BD5]' : floor ? 'bg-floorLine' : 'bg-paperDim'
                                  }`}
                                />
                                {g.jobs.length > 1 || j.name !== g.name ? <span className="font-medium">{j.name}</span> : null}
                                <span className={muted}>
                                  {j.blocked_at
                                    ? 'Blocked'
                                    : j.completed_at && stageRank(j.workflow_stage) >= DONE_RANK
                                      ? `Done ${fmtTime(j.completed_at)}`
                                      : j.started_at && stageRank(j.workflow_stage) === 1
                                        ? `Started ${fmtTime(j.started_at)}`
                                        : stageLabel(j.workflow_stage)}
                                </span>
                              </div>
                              {j.blocked_at && (
                                <p className="ml-[18px] mt-0.5 text-sm text-andonRed">
                                  {blockText({ blockedCategory: j.blocked_category, blockedNote: j.blocked_note })}
                                </p>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  )
                })}
                {progress.length === 0 && <li className={`text-sm ${muted}`}>No departments on this order yet.</li>}
              </ol>
            </section>

            {/* ── How many ── */}
            <section>
              <h3 className={h}>Counts</h3>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className={`rounded-xl border p-3 ${box}`}>
                  <div className={`text-xs ${muted}`}>Mods · walls</div>
                  <div className="font-display font-bold text-2xl tabular-nums">
                    {o.mods_count ?? <span className="text-safety">—</span>}
                    <span className={`text-base font-normal ${muted}`}> · {o.walls_count ?? '—'}</span>
                  </div>
                </div>
                {COUNT_FIELDS.map(([m, label]) => {
                  const q = data.qty[m]
                  return (
                    <label key={m} className={`rounded-xl border p-3 ${box}`}>
                      <span className={`block text-xs ${muted}`}>
                        {label}
                        {q && <span> · {q.source === 'file' ? 'from sheet' : 'typed'}</span>}
                      </span>
                      {canEdit ? (
                        <input
                          type="number"
                          min="0"
                          inputMode="numeric"
                          defaultValue={q?.qty ?? ''}
                          key={`${m}-${q?.qty ?? ''}-${q?.source ?? ''}`}
                          onBlur={(e) => saveCount(m, e.target.value)}
                          aria-label={label}
                          disabled={saving === m}
                          className="mt-0.5 w-full rounded-lg border border-paperDim px-2 py-2 text-xl font-display font-bold tabular-nums text-charcoal bg-white"
                        />
                      ) : (
                        <span className="block font-display font-bold text-2xl tabular-nums">{q?.qty ?? '—'}</span>
                      )}
                    </label>
                  )
                })}
              </div>
              {canEdit && <p className={`text-xs mt-1 ${muted}`}>A number typed here stays through re-uploads; clear it to go back to the sheet's.</p>}
            </section>

            {/* ── Paperwork ── */}
            <section>
              <div className="flex items-baseline justify-between">
                <h3 className={h}>Paperwork</h3>
                {o.paperwork_ready_at ? <Chip tone={tone} kind="good">✓ Ready</Chip> : <Chip tone={tone} kind="warn">Not ready</Chip>}
              </div>
              <ul className="mt-2 space-y-1.5">
                {data.files.map((f) => (
                  <li key={f.id} className="flex gap-1.5">
                    <button onClick={() => openFile(f)} className={`flex-1 min-w-0 text-left rounded-xl border px-3 py-2.5 min-h-[44px] flex items-center gap-2 ${box}`}>
                      {f.dept_label && <Chip tone={tone} kind="solid">{f.dept_label}</Chip>}
                      <span className="text-sm font-medium break-all">{f.filename}</span>
                      {f.page > 1 && <span className={`text-xs ${muted}`}>p.{f.page}</span>}
                    </button>
                    {canEdit && (
                      <button onClick={() => removeFile(f)} aria-label={`Remove ${f.filename}`} className="shrink-0 w-11 rounded-xl text-andonRed text-lg">
                        ×
                      </button>
                    )}
                  </li>
                ))}
                {data.files.length === 0 && <li className={`text-sm ${muted}`}>No paperwork uploaded yet.</li>}
              </ul>
              {canEdit && (
                <label className={`mt-2 inline-flex items-center gap-2 text-sm font-semibold cursor-pointer ${floor ? 'text-safety' : 'text-andonBlue'}`}>
                  <input type="file" onChange={attach} disabled={saving === 'upload'} className="hidden" />
                  {saving === 'upload' ? 'Uploading…' : '+ Attach a file or photo'}
                </label>
              )}
            </section>

            {/* ── Quality ── */}
            {data.issues.length > 0 && (
              <section>
                <h3 className={h}>Quality</h3>
                <ul className="mt-2 space-y-1.5">
                  {data.issues.map((q) => (
                    <li key={q.id} className={`rounded-xl border px-3 py-2 text-sm ${box} ${q.resolved_at ? 'opacity-60' : ''}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Chip tone={tone} kind={q.resolved_at ? 'good' : 'bad'}>{q.resolved_at ? 'Resolved' : 'Open'}</Chip>
                        <span className="font-semibold">{defectLabel[q.defect_type] ?? q.defect_type}</span>
                        {q.responsible_column_id && <span className={muted}>· {colName[q.responsible_column_id]}</span>}
                        {q.sent_back && <span className="text-safety font-semibold">↩ sent back</span>}
                      </div>
                      {q.note && <p className="mt-0.5">{q.note}</p>}
                      <p className={`text-xs mt-0.5 ${muted}`}>{fmtTime(q.created_at)}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── What happened ── */}
            <section>
              <h3 className={h}>History</h3>
              <ul className="mt-2 space-y-1">
                {data.acts.map((a) => (
                  <li key={a.id} className="text-sm flex flex-col sm:flex-row sm:gap-2">
                    <span className={`shrink-0 tabular-nums text-xs sm:text-sm sm:w-[11rem] ${muted}`}>{fmtTime(a.at)}</span>
                    <span>
                      {a.status_column_id ? <b>{colName[a.status_column_id]} </b> : null}
                      {KIND_WORDS[a.kind] ?? a.kind}
                      {a.note && a.kind !== 'order_added' ? <span className={muted}> — {a.note}</span> : null}
                    </span>
                  </li>
                ))}
                {data.acts.length === 0 && <li className={`text-sm ${muted}`}>Nothing recorded yet.</li>}
              </ul>
            </section>

            {o.notes && (
              <section>
                <h3 className={h}>Notes</h3>
                <p className="mt-1 text-sm whitespace-pre-wrap">{o.notes}</p>
              </section>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}
