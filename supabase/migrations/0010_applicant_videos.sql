-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0010 · Applicant video intro
--
-- Restores the video-recording leg of the applicant-facing screening flow
-- that lived in the old record.html + finalize-application edge function.
-- After this migration:
--
--   • applicants.video_url  — public URL of the latest uploaded video.
--   • applicant-videos      — Storage bucket (private). Files keyed by
--                             "<dsp_id>/<applicant_id>/<timestamp>.webm".
--   • Storage RLS:
--       - service role can read / write everything (the edge function
--         that handles the upload runs with service role).
--       - authenticated DSP staff can read files in their tenant
--         (dashboard inline player works without signed URLs).
--       - anon has no direct storage access; uploads MUST go through
--         the upload-applicant-video edge function which verifies the
--         applicant's screening token before persisting the file.
-- ─────────────────────────────────────────────────────────────────────────

-- Add the column to applicants. metadata.video_url could've worked but a
-- top-level column is cheaper to query for the dashboard's "show video"
-- branch + lets us add an index later if we surface a "has video" filter.
alter table public.applicants
  add column if not exists video_url text;


-- Bucket
insert into storage.buckets (id, name, public)
values ('applicant-videos', 'applicant-videos', false)
on conflict (id) do nothing;


-- Storage object policies. We rely on the file-name convention that the
-- upload function enforces: "<dsp_id>/<applicant_id>/<filename>". The
-- (storage.foldername(name))[1] expression yields the dsp_id segment.

-- Tenant staff can read videos in their DSP. (Dashboard player works
-- via signed URLs from the browser.)
create policy "applicant_videos_tenant_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'applicant-videos'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

-- Service role bypasses RLS automatically — no policy needed for write,
-- the edge function uses the service-role client.
