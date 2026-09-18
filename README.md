# Sunspace Production Management — Department Build Tracker

A real-time production tracker for the Sunspace Truesdale plant. Every order on the weekly build sheet becomes a live card that each department (Mods, V4T, Track, Roof Panels, Doors, …) moves through its stages on a shop-floor tablet, while admin sees the whole plant on one grid.

Built with **React + Vite + Tailwind** on **Supabase** (Postgres, Auth, Realtime, Storage).

---

## Features

### Shop floor (department tablets)
- **Shared department logins** — each tablet lands on its own queue
- **Combined queues** — one tablet can cover 2–3 departments, or peek read-only at others
- **Up next** — the most urgent job (earliest pickup, never a blocked one) with one large button
- **Ship countdown** — "IN 3 DAYS" in the header, turning red as the truck gets close
- **Lanes** — Blocked / To do / In progress / Done, with Undo after every tap
- **Stage tracking** — paperwork → started → completed → packaged → shipped
- **Blocked flag (🚧)** — mark a cell as blocked with a reason (Missing Glass, Wrong Cut, Machine Down, Waiting on Parts, Other); it turns red and can't be advanced by accident
- **File view** — open drawings and photos attached to a tag, with inline image previews
- **Installable** — add to the tablet home screen; opens full screen like a native app

### Admin (production coordinator)
- **Overview** — what ships next with a live countdown, % of the week built, and a stage breakdown
- **Needs attention** — every blocked job with its reason and how long it's been stuck (clear it in one tap), and every order picking up within 3 days that isn't finished, latest first (open it to reschedule)
- **Move a ship date** from the overview — every tablet's header and alert update instantly
- **Department progress** for the selected week, and a live feed of what the floor is doing
- **Plant grid** — every order × all status columns, inline editable, searchable, finished orders hidden by default
- **New / edit orders** — add orders, edit core fields, add a department an order is missing
- **Visibility control** — hide a single column on a single order from the floor
- **File attach** — upload drawings, photos, and documents to a tag (private storage, signed URLs)

### Logistics coordinator
- **Add orders one at a time** as they're confirmed — they reach the floor immediately, with a notice on every tablet
- Pickup week and departments stay picked between entries, so a batch of similar orders is a few taps each
- Catches duplicate tags before saving, suggests dealers already on file, and can create a new pickup week
- **Recent orders** list with each order's progress, plus attaching the order confirmation

### Weekly import
Three ways to load the build week — all land on the same review screen, so nothing is written until admin confirms:

| Method | How | Accuracy |
|---|---|---|
| **Paste** | Select rows in Excel (start at column A), press `Ctrl+V` | Exact — header row optional |
| **Upload / drag & drop** | Drop the Truesdale `.xlsx` onto the page | Exact |
| **Screenshot** | Upload or paste an image of the sheet | OCR — confidence shown and uncertain cells flagged |

**Import only the pickup dates you want.** Every `PICK UP x/x` row on the sheet (in the Dealer column, highlighted or not) starts a section, and everything below it belongs to that pickup. The review screen lists each section with its order count; tick the ones to bring in and the rest of the sheet is ignored. The next upcoming pickup is ticked by default, dates marked `?` are flagged, and each date can be corrected before importing. Orders already in the app but missing from the sheet can optionally be cleaned up, and nothing is deleted unless ticked.

### Live everywhere
- **Realtime updates** — changes push to every tablet instantly
- **Must-acknowledge alerts** — ship-date and status changes stay on screen until someone taps Acknowledge
- **Connection indicator** — tracks both network and the actual Realtime socket; writes are skipped and rolled back when offline rather than silently lost

---

## Tech stack

| Layer | Tool |
|---|---|
| Frontend | React 19, Vite 8, Tailwind CSS 3, React Router |
| Backend | Supabase — Postgres + RLS, Auth, Realtime, Storage |
| Import | SheetJS (`xlsx`), Tesseract.js (OCR) — both loaded on demand |
| CI | GitHub Actions build check on every push / PR to `main` |

---

## Getting started

### 1. Database
In the Supabase SQL editor, run **in order**:

1. `schema.sql`
2. `seed.sql`
3. `schema_v2.sql` through `schema_v12.sql`, in order

Skip `import_data.sql` — it's a snapshot of an old sheet. Start empty and load orders through **Weekly import** or the logistics screen. To wipe orders later but keep departments and logins, run `reset_to_empty.sql`.

> Run the migrations **before** creating the storage bucket — `schema_v9.sql` adds the storage policies the bucket needs.

### 2. Storage bucket
Supabase dashboard → **Storage → New bucket** → name `bt-files` → **private**.

Crew get short-lived signed URLs, so the bucket never needs to be public. Without the `schema_v9.sql` policies, every upload and file view fails silently.

### 3. Logins
Each tablet and admin is a normal Supabase Auth user (**Authentication → Users → Add user**), e.g. `mods-tablet@sunspace.local`, `admin@sunspace.local`.

Then add a matching profile:

```sql
insert into bt_profiles (user_id, role, department_id, display_name)
values (
  '<user UUID from Authentication > Users>',
  'crew',                                                -- or 'admin' / 'shipping' / 'logistics'
  (select id from bt_departments where name = 'Mods'),   -- NULL for admin / logistics
  'Mods Tablet'
);
```

To combine departments onto one tablet (additive — the home department is already seeded):

```sql
insert into bt_profile_departments (user_id, department_id)
values ('<tablet user UUID>', (select id from bt_departments where name = 'Door'));
```

### 4. Run locally

Create a `.env` file in the project root:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Then:

```bash
npm install
npm run dev
```

> `.env` is gitignored — never commit it.
>
> **npm 12+:** the `xlsx` package installs from the SheetJS CDN, which npm 12 blocks by default. Use `npm install --allow-remote=all`.

### 5. Deploy
Connect the repo to **Netlify**. `netlify.toml` already sets the build command and publish folder, so the only setup is adding `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under **Site settings → Environment variables**. Every push to `main` then redeploys, and tablets pick up the new version the next time the app opens.

### 6. Install on the tablets
Open the site in Chrome on each tablet → menu → **Add to Home screen**. It installs as **Build Tracker** with its own icon and opens full screen with no browser bar.

To stop staff leaving the app, use Android **screen pinning** (Settings → Security → App pinning) or a kiosk browser such as Fully Kiosk.

### Moving to self-hosted Supabase
Stand up Supabase via Docker on the plant server, run the same SQL files, recreate the `bt-files` bucket and the auth users/profiles, then point the two env vars at the new instance. No code changes — the client only ever talks to `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

---

## Project structure

```
├── src/
│   ├── pages/
│   │   ├── AdminView.jsx        # plant grid
│   │   ├── AdminOverview.jsx    # coordinator home: at risk, blocked, departments, activity
│   │   ├── AdminImport.jsx      # weekly import (paste / file / screenshot)
│   │   ├── DepartmentView.jsx   # tablet queue
│   │   ├── LogisticsView.jsx    # add orders one at a time
│   │   ├── ShippingView.jsx
│   │   └── Login.jsx
│   ├── components/              # FileModal, OrderFormModal, BlockReasonModal, NotificationBanner
│   └── lib/
│       ├── parseSheet.js        # shared sheet parser (file + clipboard)
│       ├── parseScreenshot.js   # OCR table reconstruction
│       ├── AuthContext.jsx
│       ├── ConnectionContext.jsx
│       └── supabaseClient.js
├── schema.sql, schema_v2–v12.sql   # database + migrations
├── seed.sql, import_data.sql
└── .github/workflows/build.yml     # CI build check
```

---

## Roadmap

- [ ] Order confirmation upload — read the tag from the PDF, strip the pricing page, attach the spec sheets
- [ ] Admin UI for assigning departments to tablet logins (currently SQL)
- [ ] Admin UI for adding departments / reassigning columns (currently SQL)
- [ ] Notify tablets when a new file lands on a tag
