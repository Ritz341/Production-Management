# Workshop Tools & Inventory app: status, history and plan

*Written 10 Oct 2026 as a handover, so a new chat can pick this up without the history. The inventory app is a different project from the Sunspace Build Tracker.*

| | |
|---|---|
| **What it is** | Tool crib, parts inventory and OSHA safety findings for the maintenance workshop. Tablet first, also works on a PC or phone. |
| **Code** | GitHub `Ritz341/Machine-Inventory-System`, branch `main` |
| **Website** | Netlify site `sunspaceinventory` (builds from the repo; env vars below) |
| **Database** | Supabase project `ycjrihqwplonhetrozpw` (its own project, since 10 Oct 2026) |
| **Stack** | React 18 + Vite + Tailwind, installable web app, `@supabase/postgrest-js` + realtime only (no login library) |
| **Plants** | USA (primary), Newcastle, Lindsay |
| **Owner** | Rizwan Khanjara |

## 1. What the app does today

- **Check out / return:** who has what, when it is due back, and the condition it came back in (Good / Damaged / Lost). Consumables are issued and come straight off the shelf.
- **People:** everyone who takes tools, what they hold now, what is overdue, and their history.
- **Job kits:** a list of what a job needs (blade change, weekly PM). Each kit shows Ready or Short, and **Pull kit** loads it into a check-out in one tap.
- **Safety (OSHA) findings:** photo of a hazard, OSHA 29 CFR 1910 category and severity, an assignee. Closing one takes an "after" photo, and a slider wipes between before and after. There are 12-week trend charts and average time to fix.
- **Inventory:** 173 original items (63 tools across 7 machines, 110 sensors, mechanical and reference parts) plus a USA workshop starter set of about 48 tools and consumables. Each has a category, bin location, unit and cost, so the dashboard shows total stock value.
- **Low stock that makes sense:** a tool out on a job still counts as owned. There is an amber state for a part that is low but already on order.
- **Live sync** between everyone with it open, barcode scanning with the camera, search, dark mode, and a change history. It installs to a home screen and keeps working when Wi-Fi drops.
- Buttons are at least 48 px tall for work gloves.

**Code map:** `src/components/*View.jsx` are the screens (Crib, Inventory, People, Jobs, Safety, Dashboard). `src/hooks/use*.js` hold the data hooks. `src/lib/dataSource.js` is the one data layer, with Supabase behind it and a browser-only demo mode when no keys are set.

**Database tables:** `items`, `change_log`, `suppliers`, `strategy_notes` (from `supabase-setup.sql`), `people`, `checkouts`, `jobs` (from `workshop-setup.sql`), `safety_findings` plus a `safety-photos` storage bucket (from `safety-setup.sql`). `add-on-order-column.sql` and `allow-item-deletes.sql` are small add-ons.

## 2. What we did (10 Oct 2026)

1. **Found the mix-up.** The inventory app had been sharing the Sunspace Build Tracker's Supabase project (`juifiqgdvgqjmioayvyz`). Two unrelated apps in one database made every security warning, backup and schema review harder.
2. **Separated them.** Took a full backup, created a new project (`ycjrihqwplonhetrozpw`), copied the inventory data across, pointed the Netlify site at the new project (`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`), then dropped the inventory tables, policies and storage rules from the old project.
3. **Verified the old project.** The Supabase security advisor now shows only the build tracker's own intentional warnings. All inventory-related ones (open "always true" rules, public photo listing) are gone.
4. **Merged the code** (PR #1, safety findings with before/after photos) into `main`.
5. **Decided not to simply re-run the old setup SQL** in the new project, and to design a better inventory system instead (section 5).

## 3. Open clean-up (not done yet)

| Item | Why it matters |
|---|---|
| **Copy the `safety-photos` bucket** from the old project to the new one, then delete the old bucket | Photos live in storage, not in the tables, so the data copy did not include them. Old photo links may break. |
| **Check Netlify's production branch is `main`** | The live deploy was running from a feature branch (`claude/fervent-babbage-l4cpuv`) before the merge. |
| **Remove the build tracker's files from this repo** | `schema.sql`, `schema_v2` to `schema_v14`, `seed.sql`, `import_data.sql`, `reset_to_empty.sql` are the build tracker's `bt_*` tables, committed here by mistake. They are dead weight and a risk if someone runs them in the wrong project. |
| **Stop committing `.env`** | `.env` is tracked in git despite `.gitignore`. It holds the project URL and the public key. It is not the secret key, but it should not be in the repo. Run `git rm --cached .env` and keep `.env.example`. |
| **Run a restore test on the new project's data** | Nothing backs the new project up yet. See section 6. |

## 4. Security gaps in the current app

The app has **no login**. It uses the public key, and every table has a rule that says "anyone can use". That was a fast way to get a tool crib working. Today, anyone who finds the site address (or the key in the page source) can:

- read, edit or delete every item, person, check-out and safety finding
- add photos to the public `safety-photos` bucket, and see every photo in it

For a workshop with named people, tool check-outs and safety records, this should be fixed before the app grows or leaves the plant network.

## 5. The plan: rebuild from the ground up

You want a fresh idea, GUI and ease of use rather than patching the old app. Questions still to answer before any design work:

1. What actually goes wrong day to day with the current app? What do people complain about?
2. Who uses it (crib attendant, maintenance techs, supervisors, safety lead) and on which devices?
3. The top three actions someone does a hundred times a week. They should take one or two taps.
4. What must be kept (the 173 items, barcode scanning, job kits, the safety before/after slider)?
5. Logins: shared passcode per plant, or individual logins? Who may delete or edit stock?
6. Which plants are in scope now (USA only, or Newcastle and Lindsay too)?
7. Which screens do people hate or avoid?

**Proposed design principles** (to confirm): gloves-friendly big targets, a tablet in landscape as the main screen, scan-first (point at a barcode and act), one screen per job, and everything works offline and syncs later.

**Proposed build order:**

1. **Foundation.** New schema in the new project. Real logins with roles. Private photo bucket with signed links. Nightly encrypted backup, the same way as the build tracker. Proper RLS (row-level security) rules.
2. **Core loop.** Scan → check out / return, with the person known from the login.
3. **Stock.** Low stock, reorders, on-order tracking, suppliers.
4. **Safety.** Findings with photos and the before/after slider, carried over.
5. **Reports.** Overdue tools, stock value, safety trend, exportable.
6. **Later.** Multi-plant, and mapping items to the company's ERP/SAP material master if that comes.

## 6. Backups and recovery for the new project

The build tracker has an encrypted nightly GitHub backup workflow (`.github/workflows/backup.yml` and `scripts/backup.sh` in Production-Management). The same approach works here with this project's own `SUPABASE_DB_URL` and passphrase secrets. Photos in the `safety-photos` bucket need a separate copy (rclone over Supabase's S3 connection). The recovery plan is in Production-Management `docs/disaster-recovery.md`.

## 7. How to run it

- **Locally:** `npm install`, then copy `.env.example` to `.env` and fill in the URL and public key, then `npm run dev`. With no keys it runs in demo mode.
- **Live:** push to `main`. Netlify builds with `npm run build` and publishes `dist`. Environment variables are set in Netlify, not in the repo.
- **New database from scratch:** in the Supabase SQL editor, run `supabase-setup.sql`, then `workshop-setup.sql`, then `safety-setup.sql`. **Warning:** `supabase-setup.sql` drops and recreates its tables, so never run it on a database that holds real data.
- Never put the `service_role` / secret key in the app.

## 8. To start the next chat

Tell Claude: "Continue the Workshop Inventory app (`Ritz341/Machine-Inventory-System`). Read `docs/inventory-app-README.md` from the Production-Management repo (or this file). Production-Management stays in its own chat. Next: answer the section 5 questions, then do the section 3 clean-up."
