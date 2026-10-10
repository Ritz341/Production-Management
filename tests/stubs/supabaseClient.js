// Stand-in for src/lib/supabaseClient.js in unit tests: any query fails
// loudly, because the code under test should be pure.
const fail = () => {
  throw new Error('supabase used in a unit test')
}
export const supabase = new Proxy({}, { get: () => fail })
