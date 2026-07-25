-- supabase/tests/mfa_gate_test.sql
--
-- Regression test for migration 0544 (server-side MFA primitive + opt-in
-- enforcement on the DSP settings mutators). Runs against a fully-migrated DB.
--
-- The safety-critical properties this locks in:
--   • a user with NO verified factor is NEVER blocked (mfa_ok true), even when
--     the DSP has require_mfa on — enabling MFA can't lock out the un-enrolled;
--   • with require_mfa OFF (default), nothing changes;
--   • with require_mfa ON, an enrolled user at aal1 is refused (mfa_required),
--     and the same user at aal2 succeeds.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/mfa_gate_test.sql

\set ON_ERROR_STOP on

begin;

set local session_replication_role = replica;

insert into public.dsps (id, name, short_code, slug) values
  ('facef00d-0000-4000-8000-000000000001', 'MFA DSP', 'MFAG', 'mfag');
insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('facef00d-0000-4000-8000-00000000000e', 'facef00d-0000-4000-8000-000000000001', 'owner@mfag.test', 'Owner', 'owner', true);
-- No auth.users row needed: session_replication_role=replica skips the
-- auth.mfa_factors FK, and nothing here reads auth.users (auth.uid() comes
-- from the jwt claim we set below).

-- helper to set the session identity + assurance level
create or replace function pg_temp.act(p_uid text, p_aal text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_uid, true),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'aal', p_aal)::text, true);
  select null::void;
$$;

do $$
begin
  -- ── No verified factor ────────────────────────────────────────────────
  -- mfa_ok is true regardless of aal, and settings work even with require_mfa ON.
  perform pg_temp.act('facef00d-0000-4000-8000-00000000000e', 'aal1');
  assert private.mfa_ok() = true, 'no-factor aal1 must be mfa_ok';

  -- turn require_mfa ON for this DSP
  update public.dsps set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{security}',
    '{"require_mfa": true}'::jsonb, true)
   where id = 'facef00d-0000-4000-8000-000000000001';

  -- still no factor → must NOT be blocked (the critical fail-safe)
  perform public.set_pickup_settings(true);
  raise notice 'mfa: no-factor user NOT blocked with require_mfa ON (correct)';

  -- ── Enrolled (verified factor) ────────────────────────────────────────
  -- auth.mfa_factors requires id/factor_type/status/created_at/updated_at
  -- (all NOT NULL, no defaults on the real Supabase auth schema).
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
    (gen_random_uuid(), 'facef00d-0000-4000-8000-00000000000e', 'Test Authenticator',
     'totp', 'verified', now(), now());

  -- aal1 + require_mfa ON → mfa_ok false, settings refused
  perform pg_temp.act('facef00d-0000-4000-8000-00000000000e', 'aal1');
  assert private.mfa_ok() = false, 'enrolled aal1 must NOT be mfa_ok';
  declare
    blocked boolean := false;
  begin
    begin
      perform public.set_pickup_settings(true);
    exception when insufficient_privilege then blocked := true;
      when others then if sqlstate = '42501' then blocked := true; end if;
    end;
    assert blocked, 'enrolled aal1 must be refused when require_mfa is ON';
  end;
  raise notice 'mfa: enrolled aal1 REFUSED when require_mfa ON (correct)';

  -- aal2 → mfa_ok true, settings succeed
  perform pg_temp.act('facef00d-0000-4000-8000-00000000000e', 'aal2');
  assert private.mfa_ok() = true, 'enrolled aal2 must be mfa_ok';
  perform public.set_pickup_settings(true);
  raise notice 'mfa: enrolled aal2 PASSES (correct)';

  -- ── require_mfa OFF (default) → enrolled aal1 still works ──────────────
  update public.dsps set metadata = jsonb_set(metadata, '{security,require_mfa}', 'false'::jsonb, true)
   where id = 'facef00d-0000-4000-8000-000000000001';
  perform pg_temp.act('facef00d-0000-4000-8000-00000000000e', 'aal1');
  perform public.set_pickup_settings(true);
  raise notice 'mfa: require_mfa OFF → no enforcement (correct)';
end $$;

rollback;
