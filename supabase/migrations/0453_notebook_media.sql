-- Migration 0453 · Notebook media storage ───────────────────────────────────
--
-- Moves notebook pictures + file attachments out of the page HTML (where they
-- lived as base64 data-URLs, bloating every load/save/search) into a private
-- Supabase Storage bucket. The editor uploads to
--
--     notebook-media/<dsp_id>/<page_id>/<uuid>-<filename>
--
-- stores only `data-media-path` in the page, and renders through short-lived
-- signed URLs. Access is dsp-scoped + staff-gated exactly like the notebook
-- tables (0451): the first path segment must equal the caller's dsp_id.
--
-- The base64 path remains the client's fallback when storage is unreachable,
-- and existing base64 content keeps rendering untouched.
--
-- Idempotent: bucket insert is on-conflict-do-nothing; policies are dropped
-- before create; everything storage-related is wrapped in exception-guarded
-- do-blocks so a stack without the storage schema (bare CI postgres) skips
-- cleanly instead of failing the whole migration run.
-- ───────────────────────────────────────────────────────────────────────────

-- ── bucket (private, 25 MB per object) ──────────────────────────────────────
do $$ begin
  insert into storage.buckets (id, name, public, file_size_limit)
  values ('notebook-media', 'notebook-media', false, 26214400)
  on conflict (id) do update set file_size_limit = excluded.file_size_limit;
exception
  when undefined_table then null;       -- storage.buckets absent
  when invalid_schema_name then null;   -- storage schema absent entirely (bare stack)
end $$;

-- ── dsp-scoped object access ────────────────────────────────────────────────
-- Path convention: <dsp_id>/<page_id>/<file>. A staff member may only touch
-- objects whose first folder is their own dsp_id.
do $$ begin
  execute 'drop policy if exists notebook_media_rw on storage.objects';
  execute $pol$
    create policy notebook_media_rw on storage.objects
      for all to authenticated
      using (
        bucket_id = 'notebook-media'
        and private.is_staff(private.current_dsp_id(), 'dispatcher')
        and (storage.foldername(name))[1] = private.current_dsp_id()::text
      )
      with check (
        bucket_id = 'notebook-media'
        and private.is_staff(private.current_dsp_id(), 'dispatcher')
        and (storage.foldername(name))[1] = private.current_dsp_id()::text
      )
  $pol$;
exception
  when undefined_table then null;        -- storage.objects absent
  when invalid_schema_name then null;    -- storage schema absent entirely
  when undefined_function then null;     -- storage.foldername absent
  when insufficient_privilege then null; -- storage.objects owned elsewhere; policy ships via dashboard
end $$;

notify pgrst, 'reload schema';
