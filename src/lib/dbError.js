/**
 * The newest migration in the repo. Bump it whenever a schema_vN.sql is
 * added, so a database that's behind gets told which file to run rather
 * than being left to work it out from a column name.
 */
export const LATEST_MIGRATION = 'schema_v22.sql'

/**
 * 'bt_orders.walls_count' when an error is a missing column, else null.
 *
 * 42703 is Postgres's undefined_column; PGRST204 is PostgREST's own
 * "column not found", which comes back on a write.
 */
export function missingColumn(error) {
  const match = String(error?.message ?? '').match(/column ([\w.]+) does not exist/i)
  if (match) return match[1]
  if (error?.code === '42703' || error?.code === 'PGRST204') return error.message
  return null
}

/**
 * A Supabase error said in a way someone can act on.
 *
 * The case worth catching by hand is a missing column. The app deploys
 * the moment a branch merges, but its migration is run by hand — so
 * there's a window where the code asks for a column the database hasn't
 * got. PostgREST rejects the whole query for it, which means one unused
 * new field takes out an entire screen: "column bt_orders.walls_count
 * does not exist" is true, and no use at all to whoever is standing in
 * front of it. Name the file to run instead.
 */
export function dbErrorText(error, context = 'Something went wrong') {
  if (!error) return ''
  const missing = missingColumn(error)
  if (missing) {
    return `The database is behind the app — it has no ${missing}. Run ${LATEST_MIGRATION} (plus any earlier schema_v*.sql not yet applied) in Supabase → SQL Editor, then reload.`
  }
  return `${context}: ${error.message}`
}
