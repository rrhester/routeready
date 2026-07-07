-- 0439_driver_forms_server_validation.sql
--
-- Server-side validation for driver form submissions. Until now
-- driver_submit_form inserted whatever answers it was handed — no
-- required-field check, no type/format/range check. The driver app
-- enforces these client-side, but nothing stopped a buggy or malicious
-- client from writing junk. This adds defense-in-depth validation that
-- mirrors the client rules exactly, so a submission that passes the app
-- also passes the server.
--
-- Validation is applied only for role='driver' submissions (preview /
-- dispatcher test submits are exempt). Rules:
--   * required (conditional-aware): a required field that is currently
--     VISIBLE must have a non-empty answer. Visibility is evaluated from
--     the same condition model the app uses, so a hidden conditional
--     field is not required — matching the client.
--   * email / phone: format checks on present values.
--   * number: numeric + optional field.validation.{min,max}.
--   * short_text / long_text: optional field.validation.{minLen,maxLen}.
--   * single_choice / dropdown / multi_choice: answer(s) must be among
--     the field's stored options (skipped when options are injected at
--     fetch time, e.g. the Vehicle Concerns van dropdown, which stores
--     an empty option list).
--   * rating: 1–5.
-- Rules only fire on fields that carry them / on present values, so
-- existing published forms (DVIC, Vehicle Concerns) don't regress.
--
-- Idempotent: create or replace only.


-- ── Helper: is a field visible given the submitted answers? ──────────
-- Mirrors the app's _evalFormConditions: a field with a valid condition
-- on an EARLIER discrete-answer field is visible only when the trigger's
-- answer satisfies the rule. No condition, or a stale/ineligible trigger,
-- fails OPEN (visible) — exactly like the client.
create or replace function private.form_field_visible(p_answers jsonb, p_field jsonb, p_fields jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cond       jsonb := p_field->'condition';
  v_trigger_id text;
  v_op         text;
  v_val        text;
  v_ans        text;
  v_eligible   boolean := false;
  elem         jsonb;
begin
  if v_cond is null or coalesce(v_cond->>'fieldId','') = '' then
    return true;
  end if;
  v_trigger_id := v_cond->>'fieldId';

  -- The trigger must be an eligible discrete field that appears BEFORE
  -- this field. Walk in order; stop when we reach the field itself.
  for elem in select value from jsonb_array_elements(coalesce(p_fields,'[]'::jsonb)) loop
    if (elem->>'id') = (p_field->>'id') then exit; end if;
    if (elem->>'id') = v_trigger_id
       and (elem->>'type') in ('yes_no','single_choice','dropdown','rating') then
      v_eligible := true;
    end if;
  end loop;
  if not v_eligible then return true; end if;

  v_op  := coalesce(v_cond->>'op','eq');
  v_val := coalesce(v_cond->>'value','');
  v_ans := coalesce(p_answers -> v_trigger_id #>> '{}', '');
  if v_op = 'neq' then
    return lower(v_ans) <> lower(v_val);
  else
    return lower(v_ans) = lower(v_val);
  end if;
end;
$$;


-- ── driver_submit_form · adds the validation pass ───────────────────
create or replace function public.driver_submit_form(
  p_token text,
  p_form_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv      public.drivers;
  v_form     public.forms;
  v_row      public.form_submissions;
  v_is_dvic  boolean;
  v_is_concern boolean;
  v_van_id   uuid;
  v_van_typed text;
  v_photo_paths jsonb := '[]'::jsonb;
  v_inspection_id uuid;
  v_issue_id  uuid;
  v_today    date := current_date;
  v_cat_raw  text;
  v_sev_raw  text;
  v_title    text;
  v_desc     text;
  v_category text;
  v_severity text;
  v_failed   int := 0;
  v_result   text := 'passed';
  -- validation locals
  f          jsonb;
  v_id       text;
  v_type     text;
  v_req      boolean;
  v_ans      jsonb;
  v_valr     jsonb;
  v_num      numeric;
  v_len      int;
  v_lbl      text;
  v_opts     jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_form from public.forms
   where id = p_form_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_form.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  -- Assignment gate.
  if v_drv.role = 'driver'
     and exists (select 1 from public.form_assignments fa where fa.form_id = v_form.id)
     and not exists (
       select 1 from public.form_assignments fa
        where fa.form_id = v_form.id and fa.driver_id = v_drv.id
     )
  then
    raise exception 'form_not_found' using errcode = 'P0001';
  end if;

  -- ── Server-side validation (drivers only) ─────────────────────────
  if v_drv.role = 'driver' then
    for f in select value from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) loop
      v_type := f->>'type';
      if v_type in ('section_header','divider','instructions') then continue; end if;
      -- Skip fields hidden by an unmet condition — not required, not checked.
      if not private.form_field_visible(p_answers, f, v_form.fields) then continue; end if;

      v_id  := f->>'id';
      v_lbl := coalesce(nullif(f->>'label',''), 'A required field');
      v_req := coalesce((f->>'required')::boolean, false);
      v_ans := p_answers -> v_id;

      -- Emptiness → required check; nothing else to validate when empty.
      if v_ans is null or v_ans = 'null'::jsonb
         or (jsonb_typeof(v_ans) = 'string' and btrim(v_ans #>> '{}') = '')
         or (jsonb_typeof(v_ans) = 'array'  and jsonb_array_length(v_ans) = 0) then
        if v_req then
          raise exception '% is required', v_lbl using errcode = 'P0002';
        end if;
        continue;
      end if;

      v_valr := f->'validation';

      if v_type = 'email' then
        if (v_ans #>> '{}') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          raise exception '% needs a valid email address', v_lbl using errcode = 'P0002';
        end if;

      elsif v_type = 'phone' then
        if length(regexp_replace(v_ans #>> '{}', '\D', '', 'g')) < 7 then
          raise exception '% needs a valid phone number', v_lbl using errcode = 'P0002';
        end if;

      elsif v_type = 'number' then
        begin
          v_num := (v_ans #>> '{}')::numeric;
        exception when others then
          raise exception '% must be a number', v_lbl using errcode = 'P0002';
        end;
        if v_valr ? 'min' and v_num < (v_valr->>'min')::numeric then
          raise exception '% must be at least %', v_lbl, (v_valr->>'min') using errcode = 'P0002';
        end if;
        if v_valr ? 'max' and v_num > (v_valr->>'max')::numeric then
          raise exception '% must be at most %', v_lbl, (v_valr->>'max') using errcode = 'P0002';
        end if;

      elsif v_type = 'rating' then
        begin
          v_num := (v_ans #>> '{}')::numeric;
        exception when others then
          raise exception '% has an invalid rating', v_lbl using errcode = 'P0002';
        end;
        if v_num < 1 or v_num > 5 then
          raise exception '% has an invalid rating', v_lbl using errcode = 'P0002';
        end if;

      elsif v_type in ('short_text','long_text') then
        v_len := length(v_ans #>> '{}');
        if v_valr ? 'minLen' and v_len < (v_valr->>'minLen')::int then
          raise exception '% is too short', v_lbl using errcode = 'P0002';
        end if;
        if v_valr ? 'maxLen' and v_len > (v_valr->>'maxLen')::int then
          raise exception '% is too long', v_lbl using errcode = 'P0002';
        end if;

      elsif v_type in ('single_choice','dropdown') then
        v_opts := coalesce(f->'options', '[]'::jsonb);
        if jsonb_array_length(v_opts) > 0
           and not exists (
             select 1 from jsonb_array_elements_text(v_opts) o where o = (v_ans #>> '{}')
           ) then
          raise exception '% has an invalid selection', v_lbl using errcode = 'P0002';
        end if;

      elsif v_type = 'multi_choice' then
        v_opts := coalesce(f->'options', '[]'::jsonb);
        if jsonb_array_length(v_opts) > 0
           and jsonb_typeof(v_ans) = 'array'
           and exists (
             select 1 from jsonb_array_elements_text(v_ans) a
              where not exists (select 1 from jsonb_array_elements_text(v_opts) o where o = a)
           ) then
          raise exception '% has an invalid selection', v_lbl using errcode = 'P0002';
        end if;
      end if;
    end loop;
  end if;

  -- Serialise concurrent submits for this (form, driver) pair.
  perform pg_advisory_xact_lock(hashtext(p_form_id::text || ':' || v_drv.id::text));

  if coalesce((v_form.settings->>'once_per_driver')::boolean, false) then
    if exists (
      select 1 from public.form_submissions
       where form_id = p_form_id and driver_id = v_drv.id
    ) then
      raise exception 'already_submitted' using errcode = 'P0001';
    end if;
  end if;

  insert into public.form_submissions (dsp_id, form_id, driver_id, answers)
  values (v_drv.dsp_id, p_form_id, v_drv.id, coalesce(p_answers, '{}'::jsonb))
  returning * into v_row;

  v_is_dvic    := coalesce((v_form.settings->>'is_dvic')::boolean, false);
  v_is_concern := coalesce((v_form.settings->>'is_vehicle_concern')::boolean, false);

  if (v_is_dvic or v_is_concern) and v_drv.role = 'driver' then
    v_van_typed := nullif(trim(coalesce(p_answers->>'concern_van', '')), '');
    if v_is_concern and v_van_typed is not null then
      select id into v_van_id
        from (
          select v.id, count(*) over () as n
          from public.vehicles v
          where v.dsp_id = v_drv.dsp_id
            and v.archived_at is null
            and (
              lower(v.name)             = lower(v_van_typed)
              or lower(coalesce(v.nickname, '')) = lower(v_van_typed)
              or lower(coalesce(v.plate,    '')) = lower(v_van_typed)
              or lower(regexp_replace(v.name, '^[Vv]an\s+', '')) = lower(v_van_typed)
            )
          limit 2
        ) t
       where n = 1
       limit 1;
    end if;

    if v_van_id is null then
      v_van_id := private.driver_resolve_today_van(v_drv.id, v_drv.dsp_id);
    end if;

    select coalesce(jsonb_agg(p), '[]'::jsonb) into v_photo_paths
      from (
        select v_row.answers -> (f2->>'id') ->> 'path' as p
        from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f2
        where (f2->>'type') in ('photo','file')
          and (v_row.answers -> (f2->>'id') ->> 'path') is not null
      ) sub
      where p is not null;
  end if;

  -- DVIC branch · derive pass/fail from per-field flag_on rules
  if v_is_dvic and v_drv.role = 'driver' and v_van_id is not null then
    select count(*) into v_failed
      from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f3
     where f3 ? 'flag_on'
       and private.form_answer_flagged(v_row.answers -> (f3->>'id'), f3->'flag_on');
    v_result := case when v_failed > 0 then 'failed' else 'passed' end;

    insert into public.vehicle_inspections (
      dsp_id, vehicle_id, inspector_driver_id, inspector_name,
      inspected_at, kind, result, defects, photos, form_submission_id
    ) values (
      v_drv.dsp_id, v_van_id, v_drv.id,
      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      v_row.submitted_at,
      'dvic', v_result,
      coalesce(v_row.answers, '{}'::jsonb),
      v_photo_paths,
      v_row.id
    )
    returning id into v_inspection_id;
  end if;

  -- Vehicle Concerns branch
  if v_is_concern and v_drv.role = 'driver' and v_van_id is not null then
    v_cat_raw := lower(trim(coalesce(p_answers->>'concern_category', v_row.answers->>'concern_category', '')));
    v_sev_raw := lower(trim(coalesce(p_answers->>'concern_severity', v_row.answers->>'concern_severity', '')));
    v_title   := nullif(trim(coalesce(p_answers->>'concern_title', v_row.answers->>'concern_title', '')), '');
    v_desc    := nullif(trim(coalesce(p_answers->>'concern_description', v_row.answers->>'concern_description', '')), '');

    v_category := case
      when v_cat_raw in ('damage','dent','scratch','body','collision') then 'body'
      when v_cat_raw in ('mechanical','engine','brakes','tires','transmission') then 'mechanical'
      when v_cat_raw in ('electrical','battery','lights','wiring') then 'electrical'
      when v_cat_raw in ('safety','seatbelt','airbag','hazard') then 'safety'
      when v_cat_raw in ('cleanliness','missing equipment','equipment','interior','other','') then
        case when v_cat_raw = '' then 'self_reported' else 'other' end
      else 'self_reported'
    end;

    v_severity := case
      when v_sev_raw in ('low','minor') then 'low'
      when v_sev_raw in ('medium','moderate','') then 'medium'
      when v_sev_raw in ('high','major','urgent') then 'high'
      when v_sev_raw in ('critical','severe','grounded') then 'critical'
      else 'medium'
    end;

    insert into public.vehicle_issues (
      dsp_id, vehicle_id, reported_at, severity, category,
      title, description, status, source, photos, form_submission_id, created_by
    ) values (
      v_drv.dsp_id, v_van_id, v_row.submitted_at,
      v_severity, v_category,
      coalesce(v_title, 'Driver-reported concern'),
      v_desc,
      'open', 'driver_self_report', v_photo_paths, v_row.id, null
    )
    returning id into v_issue_id;
  end if;

  return jsonb_build_object(
    'id',             v_row.id,
    'submitted_at',   v_row.submitted_at,
    'inspection_id',  v_inspection_id,
    'issue_id',       v_issue_id,
    'vehicle_id',     v_van_id,
    'is_dvic',        v_is_dvic,
    'is_vehicle_concern', v_is_concern,
    'result',         case when v_is_dvic then v_result else null end
  );
end;
$$;
grant execute on function public.driver_submit_form(text, uuid, jsonb) to anon, authenticated;


notify pgrst, 'reload schema';
