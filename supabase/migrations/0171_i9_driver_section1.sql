-- Migration 0171 · Form I-9 — slice 2: driver-app Section 1 (token-auth RPCs)
--
-- The employee completes (and e-signs) Section 1 of Form I-9 themselves
-- in the driver PWA. These RPCs mirror the document-signing pattern from
-- 0154: every call validates the per-session token via
-- private.driver_validate_token, the functions are security-definer so
-- they can write the (dispatcher-only) i9_records / i9_events tables, and
-- the consent text the driver agreed to is captured verbatim on the
-- audit chain alongside the signature, IP, and user-agent.
--
--   driver_i9_get            → record (creating it lazily) + prefill + consent
--   driver_i9_save_section1  → save a draft (status unchanged)
--   driver_i9_submit_section1→ finalize: sign, stamp completion metadata,
--                              move status to section1_complete, log it
--
-- section1 jsonb shape (the app owns the richer field-level validation):
--   { last_name, first_name, middle_initial, other_last_names,
--     addr_street, addr_apt, addr_city, addr_state, addr_zip,
--     dob, ssn, email, phone,
--     citizen_status: 'citizen'|'national'|'lpr'|'authorized',
--     lpr_uscis_number,                       -- when citizen_status='lpr'
--     auth_expires,                           -- when 'authorized' (or null/'N/A')
--     auth_doc_kind: 'uscis'|'i94'|'passport',-- when 'authorized'
--     auth_doc_number, auth_passport_country, -- when 'authorized'
--     preparer_used: bool }


-- ── private.i9_ensure_for · internal lazy-create (no current_dsp_id) ───
-- public.i9_ensure (0170) keys off private.current_dsp_id(), which is
-- null in the token-auth path. This variant takes the driver row the
-- token resolved to.
create or replace function private.i9_ensure_for(p_drv public.drivers)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_row public.i9_records;
begin
  select * into v_row from public.i9_records where driver_id = p_drv.id;
  if v_row.id is null then
    insert into public.i9_records (dsp_id, driver_id, first_day_of_employment)
    values (p_drv.dsp_id, p_drv.id, p_drv.hire_date)
    returning * into v_row;
    insert into public.i9_events (i9_record_id, kind, actor_kind, actor_driver_id, actor_name)
    values (v_row.id, 'created', 'driver', p_drv.id,
            coalesce(nullif(trim(p_drv.preferred_name), ''), p_drv.full_name));
  end if;
  return v_row;
end;
$$;


-- ── private.i9_record_json · the slice of a record the driver may see ──
create or replace function private.i9_record_json(v_row public.i9_records)
returns jsonb language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'id',                       v_row.id,
    'status',                   v_row.status,
    'first_day_of_employment',  v_row.first_day_of_employment,
    'section1',                 v_row.section1,
    'section1_completed_at',    v_row.section1_completed_at,
    'section1_completed_via',   v_row.section1_completed_via,
    'section2_completed_at',    v_row.section2_completed_at,
    'needs_correction_note',    v_row.needs_correction_note
  );
$$;


-- ── driver_i9_get ──────────────────────────────────────────────────────
create or replace function public.driver_i9_get(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_drv public.drivers; v_row public.i9_records;
begin
  v_drv := private.driver_validate_token(p_token);
  v_row := private.i9_ensure_for(v_drv);
  return jsonb_build_object(
    'record', private.i9_record_json(v_row),
    'prefill', jsonb_build_object(
      'last_name',  v_drv.last_name,
      'first_name', coalesce(v_drv.first_name, v_drv.full_name),
      'email',      v_drv.email,
      'phone',      v_drv.phone,
      'address_on_file', v_drv.address,
      'dob_on_file',     v_drv.birthday
    ),
    'consent', jsonb_build_object('version', 'i9-s1-v1-2026-05')
  );
end;
$$;
grant execute on function public.driver_i9_get(text) to anon, authenticated;


-- ── driver_i9_save_section1 · draft (status unchanged) ─────────────────
create or replace function public.driver_i9_save_section1(p_token text, p_section1 jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_drv public.drivers; v_row public.i9_records;
begin
  v_drv := private.driver_validate_token(p_token);
  if p_section1 is null or jsonb_typeof(p_section1) <> 'object' then
    raise exception 'section1_must_be_object' using errcode = '22023';
  end if;
  v_row := private.i9_ensure_for(v_drv);
  if v_row.section1_completed_at is not null and v_row.status <> 'needs_correction' then
    raise exception 'section1_already_complete' using errcode = 'P0001';
  end if;
  update public.i9_records set section1 = p_section1, updated_at = now()
   where id = v_row.id returning * into v_row;
  insert into public.i9_events (i9_record_id, kind, actor_kind, actor_driver_id, actor_name)
  values (v_row.id, 'section1_saved', 'driver', v_drv.id,
          coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name));
  return private.i9_record_json(v_row);
end;
$$;
grant execute on function public.driver_i9_save_section1(text, jsonb) to anon, authenticated;


-- ── driver_i9_submit_section1 · finalize + e-sign ─────────────────────
create or replace function public.driver_i9_submit_section1(
  p_token           text,
  p_section1        jsonb,
  p_signature       jsonb,        -- { method:'drawn'|'typed', data, signer_name }
  p_consent_version text,
  p_consent_text    text,
  p_ip              inet default null,
  p_user_agent      text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers; v_row public.i9_records;
  v_cs text := p_section1->>'citizen_status';
  v_name text;
begin
  v_drv := private.driver_validate_token(p_token);
  if p_section1 is null or jsonb_typeof(p_section1) <> 'object' then
    raise exception 'section1_must_be_object' using errcode = '22023';
  end if;
  -- Minimum field set (the app does the full per-status validation).
  if coalesce(trim(p_section1->>'last_name'),'') = ''
     or coalesce(trim(p_section1->>'first_name'),'') = ''
     or coalesce(trim(p_section1->>'addr_street'),'') = ''
     or coalesce(trim(p_section1->>'addr_city'),'') = ''
     or coalesce(trim(p_section1->>'addr_state'),'') = ''
     or coalesce(trim(p_section1->>'addr_zip'),'') = ''
     or coalesce(trim(p_section1->>'dob'),'') = '' then
    raise exception 'section1_incomplete' using errcode = 'P0001';
  end if;
  if v_cs not in ('citizen','national','lpr','authorized') then
    raise exception 'citizen_status_required' using errcode = 'P0001';
  end if;
  if v_cs = 'lpr' and coalesce(trim(p_section1->>'lpr_uscis_number'),'') = '' then
    raise exception 'lpr_number_required' using errcode = 'P0001';
  end if;
  if v_cs = 'authorized' and coalesce(trim(p_section1->>'auth_doc_number'),'') = '' then
    raise exception 'auth_doc_required' using errcode = 'P0001';
  end if;
  if p_signature is null or jsonb_typeof(p_signature) <> 'object'
     or coalesce(trim(p_signature->>'data'),'') = '' then
    raise exception 'signature_required' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_consent_version),'') = '' or coalesce(trim(p_consent_text),'') = '' then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;

  v_row := private.i9_ensure_for(v_drv);
  if v_row.section1_completed_at is not null and v_row.status <> 'needs_correction' then
    raise exception 'section1_already_complete' using errcode = 'P0001';
  end if;
  v_name := coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name);

  -- Consent first, so the chain shows agreement before signing.
  insert into public.i9_events (i9_record_id, kind, actor_kind, actor_driver_id, actor_name, ip, event_data)
  values (v_row.id, 'section1_consent', 'driver', v_drv.id, v_name, host(p_ip),
          jsonb_build_object('consent_version', p_consent_version, 'consent_text', p_consent_text));

  update public.i9_records
     set section1                 = p_section1,
         section1_signature       = p_signature,
         section1_completed_at    = now(),
         section1_completed_via   = 'driver_app',
         section1_signer_ip       = host(p_ip),
         section1_consent_version = p_consent_version,
         section1_consent_text    = p_consent_text,
         needs_correction_note    = case when status = 'needs_correction' then null else needs_correction_note end,
         status = case when status in ('not_started','section1_complete','needs_correction') then 'section1_complete' else status end,
         updated_at = now()
   where id = v_row.id returning * into v_row;

  insert into public.i9_events (i9_record_id, kind, actor_kind, actor_driver_id, actor_name, ip, event_data)
  values (v_row.id, 'section1_completed', 'driver', v_drv.id, v_name, host(p_ip),
          jsonb_build_object('via', 'driver_app',
                             'signature_method', p_signature->>'method',
                             'citizen_status', v_cs));

  return private.i9_record_json(v_row);
end;
$$;
grant execute on function public.driver_i9_submit_section1(text, jsonb, jsonb, text, text, inet, text) to anon, authenticated;


notify pgrst, 'reload schema';
