-- ============================================================
-- Migration v9 — run AFTER schema.sql through schema_v8.sql
-- Storage RLS. The `bt-files` bucket is private, which means Supabase
-- Storage denies every read/write on it by default — the bt_files
-- TABLE has RLS policies (schema.sql), but storage.objects is a
-- separate permission layer that nothing so far has granted access to.
-- Without this, every upload and every createSignedUrl() call in
-- FileModal.jsx fails silently.
--
-- Prerequisite: the `bt-files` bucket must already exist (Storage ->
-- New bucket -> name it `bt-files` -> private), per the README.
-- ============================================================

-- Any authenticated login (crew, shipping, admin) can read objects in
-- this bucket — matches "authenticated read" on the bt_files table.
-- Signed URLs still expire in 60s (FileModal.jsx), so this only grants
-- the ability to mint one, not a standing public link.
create policy "bt-files authenticated read"
on storage.objects for select
to authenticated
using (bucket_id = 'bt-files');

-- Only admins can upload/replace/delete — matches "admin write files"
-- on the bt_files table. FileModal.jsx only shows the upload control
-- when allowUpload is true, which AdminView passes and DepartmentView
-- does not, but this is the actual enforcement.
create policy "bt-files admin write"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'bt-files'
  and exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

create policy "bt-files admin update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'bt-files'
  and exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);

create policy "bt-files admin delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'bt-files'
  and exists (select 1 from bt_profiles p where p.user_id = auth.uid() and p.role = 'admin')
);
