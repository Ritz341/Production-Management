# Sunspace Production Management — Department Build Tracker

A real-time production tracker for the Sunspace Truesdale plant. Every order on the weekly build sheet becomes a live card that each department (Mods, V4T, Track, Roof Panels, Doors, …) moves through its stages on a shop-floor tablet, while admin sees the whole plant on one grid.

Built with **React + Vite + Tailwind** on **Supabase** (Postgres, Auth, Realtime, Storage).

---

## Features

### Shop floor (department tablets)
- **Shared department logins** — each tablet lands on its own queue
- **Combined queues** — one tablet can cover 2–3 departments, or peek read-only at others
- **Stage tracking** — paperwork → started → completed → packaged → shipped, with a quick-advance button
- **Stage filter** — hide finished orders to see only active work
- **Blocked flag (🚧)** — mark a cell as blocked with a reason (Missing Glass, Wrong Cut, Machine Down, Waiting on Parts, Other); it turns red and can't be advanced by accident
- **File view** — open drawings and photos attached to a tag, with inline image previews

### Admin
- **Plant grid** — every order × all 25 status columns, inline editable, searchable by tag or dealer
- **Board view** — per-department progress for each build week
- **New / edit orders** — add orders, edit core fields, add a department an order is missing
- **Visibility control** — hide a single column on a single order from the floor
- **File attach** — upload drawings, photos, and documents to a tag (private storage, signed URLs)

### Weekly import
Three ways to load the build week — all land on the same review screen, so nothing is written until admin confirms:

| Method | How | Accuracy |
|---|---|---|
| **Paste** | Select rows in Excel (start at column A), press `Ctrl+V` | Exact — header row optional |
| **Upload / drag & drop** | Drop the Truesdale `.xlsx` onto the page | Exact |
| **Screenshot** | Upload or paste an image of the sheet | OCR — confidence shown and uncertain cells flagged |

The importer detects each `PICK UP x/x` banner and creates a build week per section (dates marked `?` are flagged for confirmation), and lists orders no longer on the sheet so admin can choose which to remove.

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
3. `import_data.sql` *(optional starting data)*
4. `schema_v2.sql` through `schema_v11.sql`, in order

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
  'crew',                                                -- or 'admin' / 'shipping'
  (select id from bt_departments where name = 'Mods'),   -- NULL for admin
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
Connect the repo to Netlify (or any static host), build command `npm run build`, publish directory `dist`, and set the two `VITE_SUPABASE_*` environment variables in the site settings.

### Moving to self-hosted Supabase
Stand up Supabase via Docker on the plant server, run the same SQL files, recreate the `bt-files` bucket and the auth users/profiles, then point the two env vars at the new instance. No code changes — the client only ever talks to `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

---

## Project structure

```
├── src/
│   ├── pages/
│   │   ├── AdminView.jsx        # plant grid
│   │   ├── AdminBoard.jsx       # per-department progress board
│   │   ├── AdminImport.jsx      # weekly import (paste / file / screenshot)
│   │   ├── DepartmentView.jsx   # tablet queue
│   │   ├── ShippingView.jsx
│   │   └── Login.jsx
│   ├── components/              # FileModal, OrderFormModal, BlockReasonModal, NotificationBanner
│   └── lib/
│       ├── parseSheet.js        # shared sheet parser (file + clipboard)
│       ├── parseScreenshot.js   # OCR table reconstruction
│       ├── AuthContext.jsx
│       ├── ConnectionContext.jsx
│       └── supabaseClient.js
├── schema.sql, schema_v2–v11.sql   # database + migrations
├── seed.sql, import_data.sql
└── .github/workflows/build.yml     # CI build check
```

---

## Roadmap

- [ ] Order confirmation upload — read the tag from the PDF, strip the pricing page, attach the spec sheets
- [ ] Admin UI for assigning departments to tablet logins (currently SQL)
- [ ] Admin UI for adding departments / reassigning columns (currently SQL)
- [ ] Hide fully-complete orders on the admin grid (department queues already have this)
- [ ] Notify tablets when a new file lands on a tag
