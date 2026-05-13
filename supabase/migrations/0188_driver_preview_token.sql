-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0188 · Dispatcher "preview as driver" sessions
--
-- Lets a dispatcher open the actual driver PWA inside the dashboard (in a
-- phone-shaped frame) so they can see exactly what a given driver sees, for
-- troubleshooting.  The dashboard mints a short-lived preview token here,
-- then loads /app/index.html?preview=<token> in an iframe — the PWA runs as
-- that driver, with that driver's real data.
--
-- Safety:
--   • Preview tokens are dispatcher-gated and scoped to the dispatcher's own
--     DSP — same authority a dispatcher already has over those drivers.
--   • They auto-expire after 2 hours (the only timed expiry in driver_sessions;
--     normal driver sessions still never expire on a timer).
--   • They're flagged is_preview = true; the PWA detects the ?preview= param
--     and blocks write actions (composer/send, onboarding actions, uploads),
--     so a preview session can look at everything but can't act as the driver.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.driver_sessions
  add column if not exists expires_at timestamptz,
  add column if not exists is_preview boolean not null default false;


-- ── driver_validate_token — now also rejects expired tokens ──
-- (Identical to migration 0052's definition plus the expires_at check.)
create or replace function private.driver_validate_token(p_token text)
returns public.drivers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver_id uuid;
  v_revoked timestamptz;
  v_expires timestamptz;
  v_drv public.drivers;
begin
  select driver_id, revoked_at, expires_at into v_driver_id, v_revoked, v_expires
    from public.driver_sessions where token = p_token;
  if v_driver_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_revoked is not null then
    raise exception 'session_revoked' using errcode = '42501';
  end if;
  if v_expires is not null and v_expires < now() then
    raise exception 'session_expired' using errcode = '42501';
  end if;

  select * into v_drv from public.drivers where id = v_driver_id;
  if v_drv.status not in ('active','onboarding') then
    -- Auto-revoke when the driver becomes inactive.
    update public.driver_sessions set revoked_at = now() where token = p_token;
    raise exception 'driver_inactive' using errcode = '42501';
  end if;

  update public.driver_sessions
     set last_seen_at = now()
   where token = p_token;

  return v_drv;
end;
$$;


-- ── driver_preview_token — dispatcher-only ──
-- Mints a 2-hour, read-only-by-convention session for any driver in the
-- caller's DSP.  Returns the token plus a small driver bag (same shape the
-- PWA's redeem flow returns) so the dashboard can pre-seed the iframe.
create or replace function public.driver_preview_token(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_driver public.drivers;
  v_token text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_driver from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_driver.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_driver.status not in ('active','onboarding') then
    raise exception 'driver_inactive' using errcode = 'P0001';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent, is_preview, expires_at)
  values (v_token, v_dsp, v_driver.id, 'dispatcher-preview', true, now() + interval '2 hours');

  return jsonb_build_object(
    'token', v_token,
    'driver', jsonb_build_object(
      'id',         v_driver.id,
      'dsp_id',     v_driver.dsp_id,
      'full_name',  v_driver.full_name,
      'name',       coalesce(nullif(trim(v_driver.preferred_name), ''), v_driver.full_name),
      'station_id', v_driver.station_id,
      'tier',       v_driver.tier,
      'status',     v_driver.status
    )
  );
end;
$$;
grant execute on function public.driver_preview_token(uuid) to authenticated;


-- ── driver_preview_token_revoke — dispatcher closes a preview ──
-- Best-effort cleanup so closed previews don't sit around for 2h.  Only
-- touches preview tokens in the caller's DSP.
create or replace function public.driver_preview_token_revoke(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.driver_sessions
     set revoked_at = now()
   where token = p_token and is_preview = true and dsp_id = v_dsp and revoked_at is null;
end;
$$;
grant execute on function public.driver_preview_token_revoke(text) to authenticated;

notify pgrst, 'reload schema';
