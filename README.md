# Sunspace Truesdale — Department Build Tracker

## 1. Database (run once, in order, in Supabase SQL editor)
1. `schema.sql`
2. `seed.sql`
3. `import_data.sql`

## 2. Storage bucket
In Supabase dashboard: Storage → New bucket → name it `bt-files` → private (not public).
Admin uploads write here; crew get short-lived signed URLs to view/download, so the bucket never needs to be public.

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
- Department switcher so a tablet can peek at any other department
- Admin grid: every order × every one of the 25 status columns, inline editable
- File attach (admin) / file view (crew), private storage with signed URLs
- Live updates — status edits on the admin grid push to tablets instantly (Supabase Realtime)

**Not built yet — flag if you want these next:**
- Combining 2–3 departments onto one tablet view (the schema already supports it — `bt_department_columns` lets one column belong to multiple departments — just needs a UI for managing it)
- Admin UI for adding new departments/reassigning columns (currently a SQL insert, shown above)
- Filtering the admin grid or department queues to hide fully-complete orders
- Push notifications when a new file lands on a tag
