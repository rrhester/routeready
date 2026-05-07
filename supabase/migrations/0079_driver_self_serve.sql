-- 0079_driver_self_serve.sql
--
-- Driver-app self-serve for the Profile + License sections of the
-- driver record, plus the Onboarding task driven by drivers.status.
--
-- Adds:
--   1. Anon insert/select policies on storage.objects for the
--      driver-documents bucket so the driver app can upload their
--      DL image without going through dispatcher staff.  Mirrors
--      the pattern from migration 0072 for driver-chat-attachments
--      (path validation lives in the RPC, not the policy).
--
--   2. driver_get_profile(p_token) — returns the fields the driver
--      app's Settings + Onboarding screens render: self-serve
--      identity/contact + license + read-only onboarding
--      milestones.
--
--   3. driver_update_profile(p_token, p_payload) — writes ONLY the
--      self-serve fields.  Status, station, hire date, pay, BG
--      check, drug test, training, certs, and the DL expiration are
--      explicitly NOT writeable from the driver app.
--
--   4. driver_set_dl_image(p_token, p_path) — points
--      drivers.dl_image_path at a freshly uploaded file.  Validates
--      the path's <dsp_id>/<driver_id>/ prefix matches the calling
--      token, removes the previous image, and leaves the
--      expiration date untouched (DSP must verify).
--
--   5. driver_clear_dl_image(p_token) — driver removes their own
--      uploaded image (e.g. uploaded the wrong one).


-- 1. Anon storage policies for driver-documents
drop policy if exists "driver_docs_anon_insert" on storage.objects;
create policy "driver_docs_anon_insert"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'driver-documents');

drop policy if exists "driver_docs_anon_select" on storage.objects;
create policy "driver_docs_anon_select"
  on storage.objects for select
  to anon
  using (bucket_id = 'driver-documents');


-- 2. driver_get_profile
create or replace function public.driver_get_profile(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return jsonb_build_object(
    'id',                            v_drv.id,
    -- self-serve
    'full_name',                     v_drv.full_name,
    'preferred_name',                v_drv.preferred_name,
    'pronouns',                      v_drv.pronouns,
    'phone',                         v_drv.phone,
    'email',                         v_drv.email,
    'address',                       v_drv.address,
    'emergency_contact_name',        v_drv.emergency_contact_name,
    'emergency_contact_phone',       v_drv.emergency_contact_phone,
    -- license (driver enters number + image; DSP verifies expiration)
    'dl_number',                     v_drv.dl_number,
    'dl_image_path',                 v_drv.dl_image_path,
    'dl_expires_on',                 v_drv.dl_expires_on,
    'dot_certified',                 v_drv.dot_certified,
    'xl_certified',                  v_drv.xl_certified,
    -- read-only onboarding milestones (DSP records these)
    'status',                        v_drv.status,
    'hire_date',                     v_drv.hire_date,
    'background_check_completed_at', v_drv.background_check_completed_at,
    'drug_test_completed_at',        v_drv.drug_test_completed_at,
    'training_scheduled_at',         v_drv.training_scheduled_at,
    'training_date',                 v_drv.training_date
  );
end;
$$;
grant execute on function public.driver_get_profile(text) to anon, authenticated;


-- 3. driver_update_profile — strictly the self-serve fields
create or replace function public.driver_update_profile(p_token text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);

  update public.drivers
     set full_name               = coalesce(nullif(trim(p_payload->>'full_name'), ''), full_name),
         preferred_name          = coalesce(p_payload->>'preferred_name', preferred_name),
         pronouns                = coalesce(p_payload->>'pronouns', pronouns),
         phone                   = coalesce(p_payload->>'phone', phone),
         email                   = coalesce(p_payload->>'email', email),
         address                 = coalesce(p_payload->>'address', address),
         emergency_contact_name  = coalesce(p_payload->>'emergency_contact_name', emergency_contact_name),
         emergency_contact_phone = coalesce(p_payload->>'emergency_contact_phone', emergency_contact_phone),
         dl_number               = coalesce(p_payload->>'dl_number', dl_number)
   where id = v_drv.id;

  return public.driver_get_profile(p_token);
end;
$$;
grant execute on function public.driver_update_profile(text, jsonb) to anon, authenticated;


-- 4. driver_set_dl_image
create or replace function public.driver_set_dl_image(p_token text, p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_old text;
  v_prefix text;
begin
  v_drv := private.driver_validate_token(p_token);

  -- The driver app uploads to "<dsp_id>/<driver_id>/<filename>".
  -- Reject any path that doesn't carry the calling driver's prefix
  -- so a malicious caller can't swap in someone else's path.
  v_prefix := v_drv.dsp_id::text || '/' || v_drv.id::text || '/';
  if p_path is null or position(v_prefix in p_path) <> 1 then
    raise exception 'invalid_path' using errcode = '22023';
  end if;

  v_old := v_drv.dl_image_path;
  update public.drivers set dl_image_path = p_path where id = v_drv.id;

  -- Best-effort cleanup of the previous file.  Failures here are
  -- tolerable: orphans get reaped by the scheduled cleanup job that
  -- already runs against driver-chat-attachments.
  if v_old is not null and v_old <> p_path then
    begin
      delete from storage.objects
       where bucket_id = 'driver-documents'
         and name = v_old;
    exception when others then null;
    end;
  end if;

  return public.driver_get_profile(p_token);
end;
$$;
grant execute on function public.driver_set_dl_image(text, text) to anon, authenticated;


-- 5. driver_clear_dl_image
create or replace function public.driver_clear_dl_image(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_old text;
begin
  v_drv := private.driver_validate_token(p_token);
  v_old := v_drv.dl_image_path;
  update public.drivers set dl_image_path = null where id = v_drv.id;
  if v_old is not null then
    begin
      delete from storage.objects
       where bucket_id = 'driver-documents'
         and name = v_old;
    exception when others then null;
    end;
  end if;
  return public.driver_get_profile(p_token);
end;
$$;
grant execute on function public.driver_clear_dl_image(text) to anon, authenticated;


notify pgrst, 'reload schema';
