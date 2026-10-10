// Lets `node --test` load the app's own modules without Vite:
//  - fixed time zone, so working-minute sums are the same on every machine
//  - './catalog' (no extension) resolves to './catalog.js', as Vite does
//  - the Supabase client is swapped for a stub (the real one needs the
//    VITE_ env vars and a network), so pure logic can be tested offline
process.env.TZ = 'UTC'
import { register } from 'node:module'
register('./loader.mjs', import.meta.url)
