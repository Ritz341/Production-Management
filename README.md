# Sunspace Production Management — Department Build Tracker

A real-time production tracker for the Sunspace Truesdale plant. Every order on the weekly build sheet becomes a live card that each department (Mods, V4T, Track, Roof Panels, Doors, …) moves through its stages on a shop-floor tablet, while admin sees the whole plant on one grid.

Built with **React + Vite + Tailwind** on **Supabase** (Postgres, Auth, Realtime, Storage).

---

## Features

### Shop floor (department tablets)
- **Shared department logins** — each tablet lands on its own queue
- **Combined queues** — one tablet can cover 2–3 departments, or peek read-only at others
- **Build order** — orders are numbered #1, #2 … within each pickup, in sheet order, and every tablet builds in that order; orders admin moves are flagged "↑ Moved up" for 24 hours
- **Up next** — the lowest-numbered job that isn't blocked or done, with one large button
- **Ship countdown** — "IN 3 DAYS" in the header, turning red as the truck gets close
- **Lanes** — Blocked / To do / In progress / Done, with Undo after every tap
- **Simple steps** — Not started → Started → Done
- **Blocked (🚧)** — say what happened in your own words, or tap a quick reason (Missing Glass, Wrong Cut, Machine Down, Waiting on Parts); it turns red and can't be advanced by accident
- **File view** — open drawings and photos attached to a tag, with inline image previews
- **Installable** — add to the tablet home screen; opens full screen like a native app

### Admin (production coordinator)
- **Overview** — what ships next with a live countdown, % of the week built, and a stage breakdown
- **Needs attention** — every blocked job with its reason and how long it's been stuck (clear it in one tap), and every order picking up within 3 days that isn't finished, latest first (open it to reschedule)
- **Move a ship date** from the overview — every tablet's header and alert update instantly
- **Department progress** for the selected week, and a live feed of what the floor is doing
- **Plant grid** — every order × all status columns, inline editable, searchable, finished orders hidden by default
- **Change the build order** — ▲▼ on any order; every tablet re-sorts instantly
- **Pull an order** — cancel it with a reason (restorable), delay it to another pickup (it goes to the bottom there), or take one department off it (e.g. "V4T done in Canada")
- **Paperwork ready** — tick per order (office and admin only; never shown on the floor)
- **New / edit orders** — add orders, edit core fields, add a department an order is missing
- **Visibility control** — hide a single column on a single order from the floor
- **File attach** — upload drawings, photos, and documents to a tag (private storage, signed URLs)

### Shop-floor TVs
- One board per department on its own PC: open `https://<site>/?tv=Mods` in full-screen Chrome, signed in with any login (read-only)
- **Finished today** against the day's target from Crew today, judged against what's expected *by this time of day* — neutral before the shift starts
- **Build next**: the next six orders in build order, first one highlighted, blocked ones in red
- **Problems**: blocked jobs with their reason, or "All clear"
- **2-hour blocks**: each department enters its count on the tablet at set times (default 9:30, 11:30, 1:30, 4:00); each block turns green (target met), amber (close) or red (short), and flashes red if the update is late
- Admin → **TVs**: target per person per day and unit for each department, check-in times, each section on or off per board, and a message across the bottom; the TVs update within seconds

### Reporting and quality
- **Activity log** — every start, finish, block, clear, move and quality event is recorded by the database with its time
- **Block reasons** — material shortage, machine down, rework, waiting on another department, missing info, short-staffed, order change, other — plus a note
- **Quality issues** — any tablet reports a problem against the department that made it; **send it back** to reopen their job and hold yours until it's redone (closes itself when marked Done)
- **Quality login** — open issues, close with a note, log on any order, this week by problem and by department
- **Estimates** — mods, room shape, windows and panels give each order a difficulty and person-days; each pickup shows Doable / Tight / Over against the Mods crew left before it ships
- **Weekly Excel report** (admin → Reports) — output vs target, on-time pickups, blocked hours by reason, quality by problem and department, per-person output, full activity log; all in working hours

### Office
- **Paperwork** screen: every active order by pickup, in build order — tick each as its paperwork is printed, or mark a whole pickup ready at once

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
3. `schema_v2.sql` through `schema_v15.sql`, in order

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
  'crew',                                                -- or 'admin' / 'shipping' / 'logistics' / 'office' / 'quality'
  (select id from bt_departments where name = 'Mods'),   -- NULL for admin / logistics / office
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
│   │   ├── OfficeView.jsx       # paperwork + order details
│   │   ├── QualityView.jsx      # quality inspector
│   │   ├── TVBoard.jsx          # shop-floor TV board (?tv=Mods)
│   │   ├── ShippingView.jsx
│   │   └── Login.jsx
│   ├── components/              # FileModal, OrderFormModal, BlockReasonModal, NotificationBanner
│   └── lib/
│       ├── parseSheet.js        # shared sheet parser (file + clipboard)
│       ├── parseScreenshot.js   # OCR table reconstruction
│       ├── AuthContext.jsx
│       ├── ConnectionContext.jsx
│       └── supabaseClient.js
├── schema.sql, schema_v2–v13.sql   # database + migrations
├── seed.sql, import_data.sql
└── .github/workflows/build.yml     # CI build check
```

---

## Roadmap

- [ ] Order confirmation upload — read the tag from the PDF, strip the pricing page, attach the spec sheets
- [ ] Admin UI for assigning departments to tablet logins (currently SQL)
- [ ] Admin UI for adding departments / reassigning columns (currently SQL)
- [ ] Notify tablets when a new file lands on a tag
