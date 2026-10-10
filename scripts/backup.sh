#!/usr/bin/env bash
# Nightly backup of the Sunspace build tracker's Supabase project.
#
#   SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
#   BACKUP_DIR=/srv/backups/sunspace  ./scripts/backup.sh
#
# Use the Session pooler address from Supabase → Connect (the direct
# db.<ref>.supabase.co address is IPv6-only and fails on many networks).
# Needs postgresql-client 15+ (pg_dump). Add it to cron on the in-house
# server, e.g.  15 2 * * *  /srv/sunspace/scripts/backup.sh
#
# Keeps 30 days. Each run makes one folder with:
#   public.dump   all the app's tables and data (restore with pg_restore)
#   auth.sql      logins, with password hashes (data only)
#   storage.sql   the file list for the order paperwork bucket
# The PDFs themselves are copied separately — see docs/disaster-recovery.md.
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
out="$BACKUP_DIR/$(date +%Y-%m-%d_%H%M)"
mkdir -p "$out"

pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
  --schema=public --file="$out/public.dump"

pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges --column-inserts \
  --table=auth.users --table=auth.identities --file="$out/auth.sql"

pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges --column-inserts \
  --table=storage.buckets --table=storage.objects --file="$out/storage.sql"

# A backup that can't be read back is worth nothing: prove it lists.
pg_restore --list "$out/public.dump" > /dev/null
echo "backup ok: $out ($(du -sh "$out" | cut -f1))"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
