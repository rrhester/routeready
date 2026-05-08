-- Manual "Add applicant" should always create a fresh pipeline entry, even
-- when an applicant with the same email or source_ref already exists. The
-- webhook and bulk-import paths still want dedup, so we gate the bypass
-- behind a payload flag instead of changing the default.

create or replace function public.intake_applicant(p_payload jsonb)
returns public.applicants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp public.dsps;
  v_row public.applicants;
  v_short_code text := coalesce(p_payload->>'dsp_short_code', 'DEMO');
  v_email text := lower(nullif(p_payload->>'email', ''));
  v_phone text := nullif(p_payload->>'phone', '');
  v_source text := coalesce(p_payload->>'source', 'web');
  v_source_ref text := nullif(p_payload->>'source_ref', '');
  v_force_new boolean := coalesce((p_payload->>'force_new')::boolean, false);
  v_full_name text := coalesce(p_payload->>'full_name',
                               trim(coalesce(p_payload->>'first_name','') || ' ' || coalesce(p_payload->>'last_name','')));
begin
  if v_full_name is null or v_full_name = '' then
    raise exception 'full_name_required';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'contact_required';
  end if;

  select * into v_dsp from public.dsps where short_code = v_short_code;
  if v_dsp.id is null then raise exception 'unknown_dsp: %', v_short_code; end if;

  if not v_force_new then
    -- Dedup on source_ref first, then email.
    if v_source_ref is not null then
      select * into v_row from public.applicants
       where dsp_id = v_dsp.id and source_ref = v_source_ref;
    end if;

    if v_row.id is null and v_email is not null then
      select * into v_row from public.applicants
       where dsp_id = v_dsp.id and lower(email) = v_email;
    end if;

    if v_row.id is not null then
      return v_row;  -- idempotent: existing applicant returned unchanged.
    end if;
  end if;

  insert into public.applicants
    (dsp_id, full_name, first_name, last_name, email, phone, source, source_ref, metadata)
  values
    (v_dsp.id, v_full_name,
     p_payload->>'first_name', p_payload->>'last_name',
     v_email, v_phone, v_source, v_source_ref,
     coalesce(p_payload->'metadata', '{}'::jsonb))
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.intake_applicant(jsonb) to anon, authenticated;
