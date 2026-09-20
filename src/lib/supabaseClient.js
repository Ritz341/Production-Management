import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Loud failure on purpose — a tablet silently pointed at nothing is worse
  // than one that visibly won't start.
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your project values (cloud or self-hosted).'
  )
}

export const supabase = createClient(url, anonKey)
