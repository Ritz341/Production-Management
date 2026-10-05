import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { PIECE_NAMES } from './measuredTimes'

/**
 * What the department finished today, in units — 12 mods, 30 V4T frames,
 * 120 vents — counted from the order quantities when someone presses Done.
 * names: department names (one, or several if a screen merges departments);
 * [] means every department. Returns [{ measure, units, orders }].
 */
export function useUnitsToday(names) {
  const [rows, setRows] = useState([])
  const key = (names ?? []).join('|')

  useEffect(() => {
    let alive = true
    async function load() {
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      const list = key ? key.split('|') : [null]
      const results = await Promise.all(
        list.map((n) => supabase.rpc('bt_units_done', { p_since: since.toISOString(), p_department: n }))
      )
      if (!alive) return
      const sum = new Map()
      for (const { data } of results) {
        if (!Array.isArray(data)) continue
        for (const r of data) {
          const cur = sum.get(r.measure) ?? { measure: r.measure, units: 0, orders: 0 }
          cur.units += Number(r.units)
          cur.orders += Number(r.orders)
          sum.set(r.measure, cur)
        }
      }
      setRows([...sum.values()])
    }
    load()
    const channel = supabase
      .channel(`units-${key}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_status' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bt_order_quantities' }, load)
      .subscribe()
    const t = setInterval(load, 60000)
    return () => {
      alive = false
      clearInterval(t)
      supabase.removeChannel(channel)
    }
  }, [key])

  return rows
}

const UNIT_NAMES = PIECE_NAMES

export function unitsText(rows) {
  return rows.map((r) => `${r.units} ${UNIT_NAMES[r.measure] ?? r.measure}`).join(' · ')
}
