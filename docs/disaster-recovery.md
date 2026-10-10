# If Supabase is ever unavailable

Nothing is lost *in the code*: the app is on GitHub and deploys from Netlify. What lives **only in Supabase** is the data, so that is what needs a second copy.

| Piece | Where it lives | Backed up by |
|---|---|---|
| App code | GitHub (`Ritz341/Production-Management`) | GitHub |
| Website | Netlify, built from `main` | rebuilt from GitHub any time |
| **Orders, statuses, settings, history** | Supabase database, `public` schema | nightly GitHub backup → `public.dump` |
| **Logins** (13 accounts) | Supabase `auth.users` | nightly GitHub backup → `auth.sql` |
| **Order paperwork PDFs** | Supabase Storage bucket `bt-files` | optional rclone copy (1b); the originals also exist as the files your configuration team sends |
| The two secrets the site needs | Netlify → Environment variables | write them in your password manager |

Supabase's free plan gives you **no downloadable automatic backups**, and it **pauses a project after a week with no activity**. So the safety net is yours to run.

## 1. Easiest: let GitHub make the backup (no server, no PC left on)

`.github/workflows/backup.yml` runs every night on GitHub's own machines. It dumps the database and the logins, locks the result with a passphrase (AES-256 — the repo is public, so the file must be unreadable without it), and keeps it for **30 days**.

**Set up once (10 minutes):**
1. Supabase → **Connect** → **Session pooler** → copy the address (`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`, with your database password filled in).
2. GitHub → this repo → **Settings → Secrets and variables → Actions → New repository secret**. Add two:
   - `SUPABASE_DB_URL` — the address from step 1
   - `BACKUP_PASSPHRASE` — a long passphrase you make up. **Save it in your password manager: without it the backups cannot be opened.**
3. **Actions → Nightly backup → Run workflow** once to prove it works. A green tick and a file under **Artifacts** means it's done. A red cross emails you.

**Get a copy onto your computer / OneDrive (once a month, 2 minutes):**
1. Actions → Nightly backup → the newest green run → **Artifacts → sunspace-backup** (downloads a zip).
2. Unzip it and move the `sunspace-backup-<date>.7z` file into a OneDrive folder.
3. To open it later: install the free **7-Zip**, right-click the file → 7-Zip → Extract, enter the passphrase. You get a folder with `public.dump`, `auth.sql` and `storage.sql`.

GitHub only keeps 30 days and can switch scheduled jobs off if the repo is untouched for 60 days, so the monthly copy to OneDrive is what makes this a real second copy.

## 1b. Optional: also run it from your own computer or server

Skip this if the GitHub backup is enough. To run `scripts/backup.sh` yourself (Linux/WSL, or an in-house server):

1. Install the Postgres client (`sudo apt install postgresql-client`, version 15 or newer) and `rclone`.
2. Use the same Session pooler address as above (the "direct" address is IPv6-only and fails on most networks).
3. Add a nightly job (`crontab -e`):
   ```
   15 2 * * *  SUPABASE_DB_URL='postgresql://…' BACKUP_DIR=/srv/backups/sunspace /srv/sunspace/backup.sh >> /srv/backups/backup.log 2>&1
   ```
   It writes one dated folder per night and keeps 30 days.
4. Paperwork PDFs (not in the GitHub backup — they are copies of files your configuration team sends): Supabase → **Project settings → Storage → S3 connection** → create an access key, then
   ```
   rclone config            # new remote "supabase", type s3, provider Other, paste endpoint/region/keys
   rclone sync supabase:bt-files /srv/backups/sunspace/files   # add to the same nightly job
   ```
5. Once a month copy `/srv/backups/sunspace` to a second place (USB drive, OneDrive). A backup on the same machine as the only server isn't a backup.

**Check it works:** the script ends with `backup ok: <folder>`.

## 2. If Supabase is gone: bring it back

Two options. Both use the same backup. **Option A is the quickest.**

**A. A new Supabase project** (15 minutes): create a new project at supabase.com and follow step 3 below.

**B. Your own server** (Supabase is open source and runs on your hardware):
1. A Linux box with Docker and about 4 GB RAM free.
2. `git clone --depth 1 https://github.com/supabase/supabase` → `cd supabase/docker` → `cp .env.example .env`.
3. Set the secrets in `.env` exactly as Supabase's self-hosting guide says (database password, `JWT_SECRET`, and the `ANON_KEY` / `SERVICE_ROLE_KEY` generated from it). `docker compose up -d`.
4. Give it an **https** address (Caddy or nginx with a certificate). This matters: the Netlify site is https, and a browser refuses to let an https page talk to an `http://` server. If the plant's tablets only ever reach the in-house server, host the built site there too (`npm run build`, serve `dist/` from the same proxy) with the same certificate.

### 3. Restore, in this order

Use the newest backup (`$B` below is the folder you extracted from the `.7z`, or the newest dated folder on the server). `$DB` is the new database's connection string.

```
psql  "$DB" -f $B/auth.sql                       # 1. logins first — profiles point at them
pg_restore -d "$DB" --no-owner $B/public.dump    # 2. all app data  (one "schema public already exists" warning is normal)
```

3. **Storage rules and bucket.** These are *not* inside the public dump. In the new project, create a private bucket named `bt-files`, then run `schema_v23.sql` in the SQL editor (safe to re-run), followed by `schema_v24.sql` … `schema_v28.sql`.
4. **Paperwork PDFs:** `rclone sync /srv/backups/sunspace/files newremote:bt-files`.
5. **Check everything:** run `check_setup.sql`. Every row should be OK (the two TV logins show INFO). Fix any PROBLEM it names.
6. **Point the app at it:** Netlify → Site configuration → Environment variables → set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the new project's, then **Deploy → Trigger deploy**. Tablets: reload once. Users sign in with the same email and password as before.

## 3. Rehearse it

A recovery plan nobody has tried is a guess. Every few months, restore the latest backup into a throwaway Supabase project and run `check_setup.sql`. The dump/restore sequence above was tried on a scratch Postgres (auth schema stubbed): orders, profiles and logins all came back, and it showed the two traps now written into step 3 (logins before data; storage rules aren't in the dump). The full self-hosted Docker stack has not been run end to end yet — do that rehearsal before you rely on option B.

## Not covered by any backup

- **Netlify environment values.** Keep `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your password manager.
- **Database password.** The same.
- Live tablet state mid-shift: anything entered after the last backup (up to a day) is gone. Tablets hold no queue of unsent taps.
