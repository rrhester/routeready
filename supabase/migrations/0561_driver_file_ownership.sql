-- ── 0561 · Token-validated file-ownership check for the driver PWA ────────────
--
-- First half of the fix for launch-audit finding B-1 (cross-tenant driver-PII
-- disclosure via Storage). The driver app authenticates as the identity-less
-- `anon` Postgres role, so the three private buckets it reads
-- (driver-documents, driver-photos, driver-chat-attachments) were opened with
-- a bucket-WIDE `anon SELECT` policy — which lets ANY holder of the public
-- anon key sign/enumerate EVERY tenant's files, not just their own.
--
-- The safe pattern already in the repo (driver-document-fetch → the
-- `documents` bucket) is: a service-role edge function validates the driver's
-- session token, confirms OWNERSHIP server-side, then mints a short-lived
-- signed URL. This migration adds the ownership check the new signing edge
-- function (`driver-file-sign`) calls; a SEPARATE migration (0562) then drops
-- the anon read policies once the driver app has been switched over and QA'd.
--
-- Ownership rules (per bucket, mirroring how the app actually stores files):
--   • driver-photos            — path "<driver_id>/…"; a driver may read any
--       photo whose owner is in their OWN DSP (own avatar + teammate avatars,
--       which the app shows), never another tenant's.
--   • driver-documents         — path embeds the driver_id as a segment
--       ("<dsp>/<driver>/…" or "<dsp>/dvic/<driver>/…"); a driver may read
--       only files whose path carries THEIR id (their own DVIC / DL / docs).
--   • driver-chat-attachments  — authoritative: the path must be referenced by
--       a driver_messages row in THIS driver's thread (covers dispatch-sent
--       attachments too).
--
-- Fail-closed: an invalid/revoked token, an unknown bucket, an empty path, or
-- a path-traversal attempt all return false. SECURITY DEFINER + empty
-- search_path. Granted to service_role only (the edge function's role) — never
-- anon/authenticated. Idempotent.

create or replace function public.driver_can_read_file(
  p_token  text,
  p_bucket text,
  p_path   text
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_id  text;
begin
  -- Validate the session token → driver row. driver_validate_token raises
  -- 42501 (insufficient_privilege) on a bad/revoked/inactive token; treat
  -- that as "not authorized" rather than erroring the caller.
  begin
    v_drv := private.driver_validate_token(p_token);
  exception when insufficient_privilege then
    return false;
  end;
  v_id := v_drv.id::text;

  -- Reject empty, absolute, or traversal paths outright.
  if p_path is null or length(p_path) = 0 then return false; end if;
  if left(p_path, 1) = '/' or p_path like '%..%' then return false; end if;

  if p_bucket = 'driver-photos' then
    -- Own or teammate avatar — owner must be a driver in the caller's DSP.
    return exists (
      select 1 from public.drivers d
      where d.id::text = split_part(p_path, '/', 1)
        and d.dsp_id   = v_drv.dsp_id
    );

  elsif p_bucket = 'driver-documents' then
    -- The caller's own documents — their id must appear as a path segment.
    return ('/' || p_path || '/') like ('%/' || v_id || '/%');

  elsif p_bucket = 'driver-chat-attachments' then
    -- A message in the caller's own thread references this attachment.
    return exists (
      select 1 from public.driver_messages m
      where m.driver_id       = v_drv.id
        and m.attachment_path  = p_path
    );

  else
    return false;  -- unknown / non-driver bucket
  end if;
end;
$$;

-- Least privilege: only the signing edge function (service_role) may call
-- this. Guarded so the migration is portable to a role-less local Postgres.
revoke all on function public.driver_can_read_file(text, text, text) from public;
do $$ begin
  revoke execute on function public.driver_can_read_file(text, text, text) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  revoke execute on function public.driver_can_read_file(text, text, text) from authenticated;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function public.driver_can_read_file(text, text, text) to service_role;
exception when undefined_object then null; end $$;

notify pgrst, 'reload schema';
