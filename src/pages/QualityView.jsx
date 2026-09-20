import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext.jsx'
import { useConnection } from '../lib/ConnectionContext.jsx'
import { DEFECT_TYPES, defectLabel } from '../lib/catalog'
import { ago, buildNumbers } from '../lib/schedule'
import NotificationBanner from '../components/NotificationBanner.jsx'
import QualityIssueModal from '../components/QualityIssueModal.jsx'

/**
 * Quality inspector's screen: every open issue oldest-first (with the
 * department that made it and who found it), closing issues with a note,
 * logging new ones on any order, and this week's breakdown by defect
 * type and by department — where quality problems actually come from.
 */
export default function QualityView() {
  const { signOut } = useAuth()
  const { live } = useConnection()
  const [issues, setIssues] = useState([])
  const [orders, setOrders] = useState([])
  const [columns, setColumns] = useState([])
  const [search, setSearch] = useState('')
  const [reportFor, setReportFor] = useState(null)
  const [closing, setClosing] = useState(null) // issue id being closed
  const [closeNote, setCloseNote] = useState('')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  async function load() {
    const since = new Date(Date.now() - 35 * 864e5).toISOString()
    const [{ data: issueRows, error: e1 }, { data: orderRows }, { data: statusRows }] = await Promise.all([
      // Open issues of any age, plus everything from the last five weeks for the breakdown.
      supabase
        .from('bt_quality_issues')
        .select('*')
        .or(`resolved_at.is.null,created_at.gte.${since}`)
        .order('created_at', { ascending: true }),
      supabase.from('bt_orders').select('id, tag_name, dealer, build_week_id, sequence, status').eq('status', 'active'),
      supabase.from('bt_order_status').select('order_id, status_column_id').is('removed_at', null),
    ])
    setError(e1 ? `Couldn't load issues: ${e1.message}` : '')
    const numbers = buildNumbers(orderRows ?? [])
    const cellsByOrder = {}
    for (const r of statusRows ?? []) (cellsByOrder[r.order_id] ??= []).push(r.status_column_id)
    setOrders((orderRows ?? []).map((o) => ({ ...o, buildNo: numbers.get(o.id), columnIds: cellsByOrder[o.id] ?? [] })))
    setIssues(issueRows ?? [])
  }

  useEffect(() => {
    load()
    supabase.from('bt_status_columns').select('id, name').order('sort_order').then(({ data }) => setColumns(data ?? []))
    const channel = supabase
      .channel('quality')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_quality_issues' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_orders' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const columnName = useMemo(() => Object.fromEntries(columns.map((c) => [c.id, c.name])), [columns])
  const orderById = useMemo(() => Object.fromEntries(orders.map((o) => [o.id, o])), [orders])
  const open = issues.filter((i) => !i.resolved_at)

  // This week = since Monday.
  const weekStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d
  }, [])
  const thisWeek = issues.filter((i) => new Date(i.created_at) >= weekStart)
  const byType = countBy(thisWeek, (i) => defectLabel[i.defect_type] ?? i.defect_type)
  const byDept = countBy(thisWeek, (i) => columnName[i.responsible_column_id] ?? 'Not assigned')

  const matches = search.trim()
    ? orders.filter((o) => o.tag_name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8)
    : []

  async function closeIssue(id) {
    if (!live) return
    const { error: err } = await supabase.rpc('bt_resolve_quality', { p_issue_id: id, p_note: closeNote })
    if (err) return setError(`Couldn't close it: ${err.message}`)
    setClosing(null)
    setCloseNote('')
    setToast('Issue closed')
    load()
  }

  return (
    <div className="min-h-full bg-paper">
      <NotificationBanner />
      <header className="bg-charcoal px-5 py-4 flex items-center justify-between gap-3 border-b-4 border-safety">
        <div>
          <h1 className="font-display text-3xl font-bold text-paper leading-none">Quality</h1>
          <p className="text-sm text-floorMute mt-1">
            {open.length} open · {thisWeek.length} logged this week
          </p>
        </div>
        <button onClick={signOut} className="text-sm text-steelLight hover:text-paper">
          Sign out
        </button>
      </header>

      <main className="px-4 sm:px-6 py-5 max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4 items-start">
        <div className="grid gap-4">
          {error && <div className="bg-andonRedBg text-andonRed text-sm px-4 py-3 rounded-lg">⚠ {error}</div>}

          {/* ── Log an issue ── */}
          <section className="rounded-2xl bg-white border border-paperDim p-4">
            <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Log an issue</h2>
            <input
              id="quality-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type a tag name, e.g. CASTELLANA"
              aria-label="Find an order"
              className="mt-2 w-full rounded-lg border border-paperDim px-3 py-2.5 font-display text-lg"
            />
            {matches.length > 0 && (
              <ul className="mt-2 divide-y divide-paperDim border border-paperDim rounded-lg">
                {matches.map((o) => (
                  <li key={o.id}>
                    <button onClick={() => setReportFor(o)} className="w-full text-left px-3 py-2.5 hover:bg-paper flex justify-between gap-3">
                      <span className="font-display font-bold text-lg text-charcoal">
                        #{o.buildNo} {o.tag_name}
                      </span>
                      <span className="text-sm text-steelLight truncate">{o.dealer}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Open issues ── */}
          <section className="rounded-2xl bg-white border border-paperDim p-4">
            <h2 className="font-display font-bold text-2xl uppercase tracking-wide text-charcoal">Open issues</h2>
            {open.length === 0 ? (
              <p className="text-sm text-steelLight mt-2">No open issues.</p>
            ) : (
              <ul className="mt-2 divide-y divide-paperDim">
                {open.map((i) => {
                  const o = orderById[i.order_id]
                  return (
                    <li key={i.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-md bg-safety/25 text-[#8A6606] text-xs font-bold px-2 py-0.5">
                              {defectLabel[i.defect_type] ?? i.defect_type}
                            </span>
                            {i.sent_back && <span className="rounded-md bg-andonRedBg text-andonRed text-xs font-bold px-2 py-0.5">SENT BACK</span>}
                            <span className="text-xs text-steelLight">open {ago(i.created_at)}</span>
                          </div>
                          <div className="font-display font-bold text-lg text-charcoal mt-1">
                            {o ? `#${o.buildNo} ${o.tag_name}` : `Order ${i.order_id}`}
                          </div>
                          <div className="text-sm text-steelLight">
                            Made by <b className="text-steel">{columnName[i.responsible_column_id] ?? '—'}</b>
                            {i.reporter_column_id ? ` · found by ${columnName[i.reporter_column_id]}` : ' · found by quality'}
                            {i.note ? ` · ${i.note}` : ''}
                          </div>
                        </div>
                        {closing !== i.id && (
                          <button
                            onClick={() => setClosing(i.id)}
                            className="rounded-lg border border-paperDim px-3 py-2 text-sm font-semibold text-andonGreen hover:bg-andonGreenBg whitespace-nowrap"
                          >
                            Close
                          </button>
                        )}
                      </div>
                      {closing === i.id && (
                        <div className="mt-2 flex gap-2">
                          <input
                            id={`close-${i.id}`}
                            autoFocus
                            value={closeNote}
                            onChange={(e) => setCloseNote(e.target.value)}
                            placeholder="How was it fixed? (optional)"
                            aria-label="How it was fixed"
                            className="flex-1 rounded-lg border border-paperDim px-3 py-2 text-sm"
                          />
                          <button onClick={() => closeIssue(i.id)} disabled={!live} className="rounded-lg bg-andonGreen text-white text-sm font-bold px-4 disabled:opacity-40">
                            Close issue
                          </button>
                          <button onClick={() => setClosing(null)} className="text-sm text-steelLight px-2">
                            Cancel
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        {/* ── This week ── */}
        <div className="grid gap-4">
          <Breakdown title="This week by problem" rows={byType} empty="Nothing logged since Monday." />
          <Breakdown title="This week by department" rows={byDept} empty="Nothing logged since Monday." />
          <p className="text-xs text-steelLight px-1">
            Common problems: {DEFECT_TYPES.slice(0, 4).map((t) => t.label).join(', ')}. Departments send parts back from their
            tablets; issues sent back close themselves when the job is marked Done again.
          </p>
        </div>
      </main>

      {reportFor && (
        <QualityIssueModal
          order={reportFor}
          departments={reportFor.columnIds.map((id) => ({ columnId: id, name: columnName[id] }))}
          inspector
          onClose={() => setReportFor(null)}
          onSaved={(message) => {
            setToast(message)
            setSearch('')
            load()
          }}
        />
      )}

      {toast && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-5 z-50 bg-charcoal text-paper rounded-xl shadow-2xl px-4 py-3 text-sm">
          {toast}
        </div>
      )}
    </div>
  )
}

function Breakdown({ title, rows, empty }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <section className="rounded-2xl bg-white border border-paperDim p-4">
      <h2 className="font-display font-bold text-xl uppercase tracking-wide text-charcoal">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-steelLight mt-2">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex justify-between text-sm">
                <span className="text-charcoal">{r.key}</span>
                <b className="tabular-nums text-charcoal">{r.count}</b>
              </div>
              <div className="h-2 rounded-full bg-paperDim mt-1 overflow-hidden">
                <i className="block h-full bg-safety" style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function countBy(list, keyFn) {
  const map = new Map()
  for (const x of list) map.set(keyFn(x), (map.get(keyFn(x)) ?? 0) + 1)
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}
