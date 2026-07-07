-- 0436_driver_forms_p0_hardening.sql
--
-- P0 correctness / security hardening for the driver forms feature.
-- Three fixes, all idempotent (create or replace + guarded index):
--
--   1. Assignment targeting is now ENFORCED, not just displayed.
--      Previously only driver_list_forms honoured form_assignments
--      (0142); driver_get_form (0299) and driver_submit_form (0298)
--      gated solely on dsp_id + status='published', so a driver who
--      knew a form's UUID could fetch and submit a form assigned to a
--      different subset of drivers. Both RPCs now apply the same
--      allowlist gate: a form with no assignments is visible to
--      everyone (unchanged); a form with assignments is reachable only
--      by an assigned driver. Non-driver (preview) tokens bypass the
--      gate so dispatchers can still preview any form. Failing the gate
--      raises form_not_found (not forbidden) so we don't leak existence.
--
--   2. once_per_driver no longer races. The old check-then-insert
--      (0298:305-316) had no unique constraint, so two concurrent
--      submits both passed the existence check and both inserted. We
--      take a per-(form,driver) transaction advisory lock before the
--      check so concurrent submits serialise. (A partial unique index
--      can't express "only when settings.once_per_driver" since the
--      predicate lives on forms, not form_submissions — the advisory
--      lock is the correct tool here.)
--
--   3. DVIC inspections derive a real pass/fail result instead of the
--      hardcoded 'passed' (0223/0289/0298). A form field may now carry
--      a `flag_on` rule (the answer value[s] that constitute a defect).
--      The inspection is 'failed' if any answered field matches its
--      flag_on rule, else 'passed'. Forms with no flag rules yield no
--      failures → 'passed', exactly as before, so existing DVIC forms
--      do not regress. The builder gains a control to set flag_on in a
--      companion frontend change.


-- ── Helper: does an answer match a field's flag_on defect rule? ──────
-- flag_on may be a scalar ("no") or an array (["no","n/a"]). The answer
-- may be a scalar (yes_no / single_choice / dropdown) or an array
-- (multi_choice). Comparison is case-insensitive on the text form.
create or replace function private.form_answer_flagged(p_answer jsonb, p_flag_on jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_answer is null or p_flag_on is null then false
    when jsonb_typeof(p_flag_on) = 'array' then
      case
        when jsonb_typeof(p_answer) = 'array' then exists (
          select 1
            from jsonb_array_elements_text(p_answer) a
            join jsonb_array_elements_text(p_flag_on) t on lower(a) = lower(t)
        )
        else exists (
          select 1 from jsonb_array_elements_text(p_flag_on) t
           where lower(t) = lower(p_answer #>> '{}')
        )
      end
    else
      case
        when jsonb_typeof(p_answer) = 'array' then exists (
          select 1 from jsonb_array_elements_text(p_answer) a
           where lower(a) = lower(p_flag_on #>> '{}')
        )
        else lower(coalesce(p_answer #>> '{}', '')) = lower(coalesce(p_flag_on #>> '{}', ''))
      end
  end;
$$;


-- ── 1 + assignment gate · driver_get_form ───────────────────────────
-- Faithful re-creation of 0299's body with an assignment gate added
-- right after the form lookup. Everything else (live van dropdown +
-- prefill for Vehicle Concerns) is unchanged.
create or replace function public.driver_get_form(p_token text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv         public.drivers;
  v_row         public.forms;
  v_prefill     jsonb := '{}'::jsonb;
  v_van_id      uuid;
  v_van_nm      text;
  v_van_options jsonb;
  v_fields      jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_row from public.forms
   where id = p_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_row.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  -- Assignment gate: a targeted form is reachable only by an assigned
  -- driver. Preview/non-driver tokens bypass so dispatchers can preview.
  if v_drv.role = 'driver'
     and exists (select 1 from public.form_assignments fa where fa.form_id = v_row.id)
     and not exists (
       select 1 from public.form_assignments fa
        where fa.form_id = v_row.id and fa.driver_id = v_drv.id
     )
  then
    raise exception 'form_not_found' using errcode = 'P0001';
  end if;

  v_fields := v_row.fields;

  if coalesce((v_row.settings->>'is_vehicle_concern')::boolean, false)
     and v_drv.role = 'driver' then
    select coalesce(jsonb_agg(v.name order by v.name), '[]'::jsonb)
      into v_van_options
      from public.vehicles v
     where v.dsp_id = v_drv.dsp_id
       and v.archived_at is null
       and v.status <> 'retired';

    select jsonb_agg(
             case when elem->>'id' = 'concern_van'
                  then elem || jsonb_build_object('options', v_van_options)
                  else elem end
             order by ord
           )
      into v_fields
      from jsonb_array_elements(v_row.fields) with ordinality t(elem, ord);

    v_van_id := private.driver_resolve_today_van(v_drv.id, v_drv.dsp_id);
    if v_van_id is not null then
      select name into v_van_nm from public.vehicles where id = v_van_id;
      if v_van_nm is not null then
        v_prefill := v_prefill || jsonb_build_object('concern_van', v_van_nm);
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'id',          v_row.id,
    'title',       v_row.title,
    'description', v_row.description,
    'fields',      v_fields,
    'settings',    v_row.settings,
    'prefill',     v_prefill
  );
end;
$$;
grant execute on function public.driver_get_form(text, uuid) to anon, authenticated;


-- ── 1 + 2 + 3 · driver_submit_form ──────────────────────────────────
-- Faithful re-creation of 0298's body with: the assignment gate (1),
-- the advisory lock closing the once_per_driver race (2), and derived
-- DVIC pass/fail (3). The DVIC and Vehicle Concerns side-effects are
-- otherwise unchanged.
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
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_form from public.forms
   where id = p_form_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_form.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  -- Assignment gate (mirrors driver_get_form).
  if v_drv.role = 'driver'
     and exists (select 1 from public.form_assignments fa where fa.form_id = v_form.id)
     and not exists (
       select 1 from public.form_assignments fa
        where fa.form_id = v_form.id and fa.driver_id = v_drv.id
     )
  then
    raise exception 'form_not_found' using errcode = 'P0001';
  end if;

  -- Serialise concurrent submits for this (form, driver) pair so the
  -- once_per_driver check-then-insert below can't be double-passed.
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
        select v_row.answers -> (f->>'id') ->> 'path' as p
        from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
        where (f->>'type') in ('photo','file')
          and (v_row.answers -> (f->>'id') ->> 'path') is not null
      ) sub
      where p is not null;
  end if;

  -- ── DVIC branch · derive pass/fail from per-field flag_on rules ─────
  if v_is_dvic and v_drv.role = 'driver' and v_van_id is not null then
    select count(*) into v_failed
      from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
     where f ? 'flag_on'
       and private.form_answer_flagged(v_row.answers -> (f->>'id'), f->'flag_on');
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

  -- ── Vehicle Concerns branch (unchanged) ────────────────────────────
  if v_is_concern and v_drv.role = 'driver' and v_van_id is not null then
    v_cat_raw := lower(trim(coalesce(
      p_answers->>'concern_category',
      v_row.answers->>'concern_category', ''
    )));
    v_sev_raw := lower(trim(coalesce(
      p_answers->>'concern_severity',
      v_row.answers->>'concern_severity', ''
    )));
    v_title   := nullif(trim(coalesce(
      p_answers->>'concern_title',
      v_row.answers->>'concern_title', ''
    )), '');
    v_desc    := nullif(trim(coalesce(
      p_answers->>'concern_description',
      v_row.answers->>'concern_description', ''
    )), '');

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
      title, description, status, source, photos, form_submission_id,
      created_by
    ) values (
      v_drv.dsp_id, v_van_id, v_row.submitted_at,
      v_severity, v_category,
      coalesce(v_title, 'Driver-reported concern'),
      v_desc,
      'open', 'driver_self_report', v_photo_paths, v_row.id,
      null
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
