-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0064 · Driver photo
--
-- Drivers can upload a profile photo from the PWA. The image replaces
-- the initials chip in the header AND the large avatar on the Profile
-- screen. Path on storage is "<driver_id>/avatar.<ext>" in the new
-- `driver-photos` bucket. The bucket is public (so <img src="..."> just
-- works) but uploads go through the upload-driver-photo edge function
-- which validates the driver's session token.
--
-- Surface:
--   drivers.photo_path text             — storage object path
--   driver_me(token)                    — returns {id, name, photo_url}
--   driver_set_photo(token, p_path)     — used by the edge function only
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Schema ──
alter table public.drivers
  add column if not exists photo_path text;


-- ── 2. Storage bucket ──
insert into storage.buckets (id, name, public)
values ('driver-photos', 'driver-photos', true)
on conflict (id) do nothing;

-- Reads are public (bucket is public). Inserts/updates/deletes only
-- happen via the edge function with the service role, so no
-- authenticated-user RLS policy is needed here.


-- ── 3. driver_me — single source of truth for the driver's profile ──
-- Public URL is composed from the project URL + photo_path.
-- We can't rely on env vars in PG, so we store just the path and the
-- server URL is in app config; the function returns both pieces and
-- the client builds the URL.
create or replace function public.driver_me(p_token text)
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
    'id',         v_drv.id,
    'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
    'full_name',  v_drv.full_name,
    'photo_path', v_drv.photo_path
  );
end;
$$;
grant execute on function public.driver_me(text) to anon, authenticated;


-- ── 4. driver_set_photo — used by the edge function ──
-- We constrain the path to start with the driver's id so an attacker
-- can't point photo_path at someone else's object.
create or replace function public.driver_set_photo(p_token text, p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  if p_path is not null and p_path <> '' and not (p_path like v_drv.id::text || '/%') then
    raise exception 'invalid_photo_path' using errcode = '42501';
  end if;
  update public.drivers
     set photo_path = nullif(p_path, '')
   where id = v_drv.id;
  return jsonb_build_object('photo_path', p_path);
end;
$$;
grant execute on function public.driver_set_photo(text, text) to anon, authenticated;


notify pgrst, 'reload schema';
