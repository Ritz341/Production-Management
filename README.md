# Sunspace Truesdale — Department Build Tracker

## 1. Database (run once, in order, in Supabase SQL editor)
1. `schema.sql`
2. `seed.sql`
3. `import_data.sql`
4. `schema_v2.sql` through `schema_v11.sql`, in order — **do this before creating the storage bucket in step 2**, since `schema_v9.sql` adds the storage RLS policies that bucket needs

To combine 2–3 departments onto one tablet login (e.g. so one tablet
covers both Roof Panel and Door), insert extra rows into
`bt_profile_departments` for that login's `user_id` — `schema_v8.sql`
seeds each profile with its existing home department already, so this
is additive:

```sql
insert into bt_profile_departments (user_id, department_id)
values (
  '<the tablet's user UUID>',
  (select id from bt_departments where name = 'Door')
);
```

## 2. Storage bucket
In Supabase dashboard: Storage → New bucket → name it `bt-files` → private (not public).
Admin uploads write here; crew get short-lived signed URLs to view/download, so the bucket never needs to be public.

A private bucket denies all access until it has explicit RLS policies on `storage.objects` — `schema_v9.sql` (step 1) adds those (authenticated read, admin-only write). Without it, every upload and every file view fails silently.

## 3. Logins
Each tablet and each admin is a normal Supabase Auth user (Authentication → Users → Add user).
Suggested emails so they're easy to tell apart, e.g.:
- `mods-tablet@sunspace.local`
- `v4t-tablet@sunspace.local`
- `track-tablet@sunspace.local`
- `roofpanel-tablet@sunspace.local`
- `door-tablet@sunspace.local`
- `admin@sunspace.local`

After creating each user, add a matching row in `bt_profiles` (SQL editor):

```sql
insert into bt_profiles (user_id, role, department_id, display_name)
values (
  '<paste the user's UUID from Authentication > Users>',
  'crew',              -- or 'admin'
  (select id from bt_departments where name = 'Mods'),  -- omit/NULL for admin
  'Mods Tablet'
);
```

## 4. Local development
```
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your project's API settings
npm run dev
```

## 5. Deploy
Push to a new GitHub repo, connect it to Netlify (same flow as the SC220 inventory app), and set the two `VITE_SUPABASE_*` env vars in Netlify's site settings.

## 6. Moving to a self-hosted Supabase later
Stand up Supabase via Docker on your server, run the same three SQL files against it, recreate the `bt-files` bucket and the auth users/profiles, then update the two env vars (in `.env` locally or in Netlify) to point at the self-hosted URL and its anon key. No app code changes needed — this is exactly why the client only ever talks to `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

## What's built vs. what's next
**Working now:**
- Shared department logins, each landing on their own queue by default
- Department picker so a tablet can combine 2–3 departments into one actionable queue, or just peek (read-only) at others (`bt_profile_departments`, `schema_v8.sql`)
- Admin grid: every order × every one of the 25 status columns, inline editable
- Admin can add a brand-new order (+ New Order), edit an existing order's core fields (Edit), and add a department/column an order is missing — e.g. the sheet didn't include Mods or V4T for a tag but it actually needs to be built (click "+ Add" on the blank cell, or check it in Edit)
- "Blocked / material shortage" flag (🚧) per department/order cell — layered on top of whatever stage it's at, overrides the chip to red, hides the quick-advance button so nobody advances past a known problem by accident (`bt_order_status.blocked_at`, `schema_v11.sql`)
- Connection indicator — a shared `ConnectionProvider` tracks both `navigator.onLine` AND the actual Supabase Realtime channel status (WiFi can look connected while the websocket itself is dead), shown as a quiet green dot when healthy, amber "Reconnecting…" or red "Offline" pill otherwise. Every stage/visibility/blocked write across Mods and Admin checks this same signal first (skips the write, doesn't queue it) and rolls back its optimistic UI update if the write fails after all
- Blocking a cell opens a quick reason picker (Missing Glass / Wrong Cut / Machine Down / Waiting on Parts / Other) instead of a raw text prompt
- File attach (admin) / file view (crew), private storage with signed URLs
- Live updates — status edits on the admin grid push to tablets instantly (Supabase Realtime)
- Must-acknowledge alerts — ship date changes and any department order status change stay on screen (red/amber banner) on every screen until someone taps Acknowledge; other events (pickup, started) still auto-dismiss as toasts (`bt_events.acknowledged_at`, `schema_v10.sql`)

**Not built yet — flag if you want these next:**
- Admin UI for managing which departments a tablet login is combined onto (currently a SQL insert into `bt_profile_departments`)
- Admin UI for adding new departments/reassigning columns (currently a SQL insert, shown above)
- Filtering the admin grid or department queues to hide fully-complete orders
- Push notifications when a new file lands on a tag
