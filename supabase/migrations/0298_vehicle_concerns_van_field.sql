-- Migration 0298 · Vehicle Concerns form · van number field
--
-- The Vehicle Concerns form from migration 0289 auto-resolved the van
-- server-side from today's day-assignment / standing chain, but never
-- showed the driver which van they were reporting about — and the
-- driver had no way to identify a different van (e.g., reporting on
-- yesterday's spare).  Dispatchers receiving the concern then couldn't
-- tell from the form alone which vehicle it referenced.
--
-- This migration:
--   1. Extracts the existing van-resolver into a private helper so
--      driver_get_form and driver_submit_form share one definition.
--   2. Updates dsp_install_vehicle_concerns_form() to include a
--      required "Van number" short_text field (id `concern_van`) right
--      after the intro section.
--   3. Backfills existing Vehicle Concerns forms in place: walks every
--      form tagged is_vehicle_concern that's missing the new field and
--      injects it after concern_intro.  Idempotent — re-running is a
--      no-op once the field is present.
--   4. driver_get_form now returns `prefill.concern_van` set to the
--      driver's auto-resolved van for today, so the field shows up
--      pre-populated.  The driver just confirms or corrects.
--   5. driver_submit_form prefers the driver-typed concern_van when it
--      resolves to a real vehicle in the DSP (case-insensitive match on
--      vehicles.name, nickname, plate, or the trailing number after
--      a "Van " prefix).  Falls back to the auto-resolver when the
--      typed value doesn't match or the field is empty.  The raw typed
--      string stays in form_submissions.answers either way so a
--      dispatcher reviewing the submission always sees what the driver
--      actually wrote.


-- ── 1. Shared van resolver ──────────────────────────────────────────
-- Returns the van id for the driver today, matching the existing
-- precedence: day-assignment > standing primary (if no day-override)
-- > standing backup (if the primary isn't driving today).  Pure
-- function — no side effects.
create or replace function private.driver_resolve_today_van(p_drv_id uuid, p_dsp_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select v.id from public.vehicles v
       join public.vehicle_day_assignments oa
         on oa.vehicle_id = v.id and oa.driver_id = p_drv_id and oa.date = current_date
      where v.dsp_id = p_dsp_id and v.archived_at is null
      limit 1),
    (select v.id from public.vehicles v
       join public.vehicle_driver_assignments a
         on a.vehicle_id = v.id and a.driver_id = p_drv_id and a.rank = 0
      where v.dsp_id = p_dsp_id and v.status = 'active' and v.archived_at is null
        and not exists (select 1 from public.vehicle_day_assignments oa
                        where oa.vehicle_id = v.id and oa.date = current_date)
      order by v.name limit 1),
    (select v.id from public.vehicles v
       join public.vehicle_driver_assignments a
         on a.vehicle_id = v.id and a.driver_id = p_drv_id and a.rank > 0
       left join public.vehicle_driver_assignments pri_a
         on pri_a.vehicle_id = v.id and pri_a.rank = 0
      where v.dsp_id = p_dsp_id and v.status = 'active' and v.archived_at is null
        and not exists (select 1 from public.vehicle_day_assignments oa
                        where oa.vehicle_id = v.id and oa.date = current_date)
        and (pri_a.driver_id is null
          or not exists (
            select 1 from public.shifts ps
            where ps.driver_id = pri_a.driver_id
              and ps.date = current_date and ps.dsp_id = p_dsp_id
              and ps.status in ('scheduled','completed','late')
          ))
      order by a.rank, v.name limit 1)
  );
$$;


-- ── 2. dsp_install_vehicle_concerns_form · adds concern_van ─────────
create or replace function public.dsp_install_vehicle_concerns_form()
returns public.forms
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.forms;
  v_fields jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row from public.forms
   where dsp_id = v_dsp
     and coalesce((settings->>'is_vehicle_concern')::boolean, false) = true
   order by created_at asc
   limit 1;
  if v_row.id is not null then
    return v_row;
  end if;

  v_fields := jsonb_build_array(
    jsonb_build_object(
      'id', 'concern_intro',
      'type', 'section_header',
      'label', 'Report a vehicle concern',
      'help', 'See something off about your van? Damage, a noise, lights, cleanliness — let us know and we''ll take it from here.'
    ),
    jsonb_build_object(
      'id', 'concern_van',
      'type', 'short_text',
      'label', 'Van number',
      'required', true,
      'help', 'Which van is this about? Pre-filled from your assignment — change it if you''re reporting about a different van.'
    ),
    jsonb_build_object(
      'id', 'concern_category',
      'type', 'single_choice',
      'label', 'What kind of concern?',
      'required', true,
      'options', jsonb_build_array('Damage','Mechanical','Electrical','Safety','Cleanliness','Missing equipment','Other')
    ),
    jsonb_build_object(
      'id', 'concern_severity',
      'type', 'single_choice',
      'label', 'How urgent is it?',
      'required', true,
      'help', 'Pick "Critical" if the van shouldn''t be driven until it''s looked at.',
      'options', jsonb_build_array('Low','Medium','High','Critical')
    ),
    jsonb_build_object(
      'id', 'concern_title',
      'type', 'short_text',
      'label', 'Short summary',
      'required', true,
      'help', 'One line — e.g. "Scratch on rear bumper" or "Warning light on dashboard".'
    ),
    jsonb_build_object(
      'id', 'concern_description',
      'type', 'long_text',
      'label', 'Describe the concern',
      'required', false,
      'help', 'When did you first notice it? Does it happen at certain speeds, when braking, only when cold, etc.?'
    ),
    jsonb_build_object(
      'id', 'concern_photo_intro',
      'type', 'section_header',
      'label', 'Photos (optional but really helpful)'
    ),
    jsonb_build_object('id', 'concern_photo_1', 'type', 'photo', 'label', 'Photo 1', 'required', false),
    jsonb_build_object('id', 'concern_photo_2', 'type', 'photo', 'label', 'Photo 2', 'required', false),
    jsonb_build_object('id', 'concern_photo_3', 'type', 'photo', 'label', 'Photo 3', 'required', false),
    jsonb_build_object('id', 'concern_photo_4', 'type', 'photo', 'label', 'Photo 4', 'required', false)
  );

  insert into public.forms (
    dsp_id, title, description, category, status, fields, settings,
    created_by, published_at
  ) values (
    v_dsp,
    'Vehicle Concerns',
    'Drivers — use this any time you notice something off about your van so the team can act on it.',
    'vehicle',
    'published',
    v_fields,
    jsonb_build_object('is_vehicle_concern', true),
    auth.uid(),
    now()
  )
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.dsp_install_vehicle_concerns_form() to authenticated;


-- ── 3. Backfill: inject concern_van into already-installed forms ────
-- Idempotent — only touches forms tagged is_vehicle_concern that don't
-- yet have a concern_van field.  Inserts the field right after the
-- concern_intro header so it shows up as the first input.  If the
-- intro is missing (operator removed it), the field is prepended.
do $$
declare
  r        record;
  v_intro  int;
  v_new    jsonb := jsonb_build_object(
    'id', 'concern_van',
    'type', 'short_text',
    'label', 'Van number',
    'required', true,
    'help', 'Which van is this about? Pre-filled from your assignment — change it if you''re reporting about a different van.'
  );
  v_left   jsonb;
  v_right  jsonb;
begin
  for r in
    select id, fields from public.forms
     where coalesce((settings->>'is_vehicle_concern')::boolean, false) = true
       and not exists (
         select 1 from jsonb_array_elements(fields) e
         where e->>'id' = 'concern_van'
       )
  loop
    select min(ord) into v_intro
      from jsonb_array_elements(r.fields) with ordinality t(elem, ord)
     where elem->>'id' = 'concern_intro';

    if v_intro is null then v_intro := 0; end if;

    select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
      into v_left
      from jsonb_array_elements(r.fields) with ordinality t(elem, ord)
     where ord <= v_intro;
    select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
      into v_right
      from jsonb_array_elements(r.fields) with ordinality t(elem, ord)
     where ord > v_intro;

    update public.forms
       set fields = v_left || jsonb_build_array(v_new) || v_right
     where id = r.id;
  end loop;
end;
$$;


-- ── 4. driver_get_form · returns prefill.concern_van ────────────────
create or replace function public.driver_get_form(p_token text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv     public.drivers;
  v_row     public.forms;
  v_prefill jsonb := '{}'::jsonb;
  v_van_id  uuid;
  v_van_nm  text;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_row from public.forms
   where id = p_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_row.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  if coalesce((v_row.settings->>'is_vehicle_concern')::boolean, false)
     and v_drv.role = 'driver' then
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
    'fields',      v_row.fields,
    'settings',    v_row.settings,
    'prefill',     v_prefill
  );
end;
$$;
grant execute on function public.driver_get_form(text, uuid) to anon, authenticated;


-- ── 5. driver_submit_form · honour the driver-typed van ─────────────
-- Same DVIC branch as 0289.  The Vehicle Concerns branch now:
--   * looks up the typed concern_van first; if it resolves to exactly
--     one active vehicle in the DSP, that's the van for this concern.
--   * if the typed value is blank or doesn't resolve, falls back to
--     the auto-resolver (extracted into private.driver_resolve_today_van).
--   * either way, the raw typed string is preserved in the submission
--     answers so dispatchers see exactly what the driver wrote.
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
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_form from public.forms
   where id = p_form_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_form.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

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
    -- Driver-typed override (Vehicle Concerns only).  Matches against
    -- name, nickname, plate, or "47" → "Van 47" by stripping a leading
    -- "Van " prefix.  Only accepts a unique match; ambiguous typed
    -- values fall through to the auto-resolver.
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

    -- Shared photo-path extractor: pulls every photo/file field's `path`.
    select coalesce(jsonb_agg(p), '[]'::jsonb) into v_photo_paths
      from (
        select v_row.answers -> (f->>'id') ->> 'path' as p
        from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
        where (f->>'type') in ('photo','file')
          and (v_row.answers -> (f->>'id') ->> 'path') is not null
      ) sub
      where p is not null;
  end if;

  -- ── DVIC branch (unchanged behaviour from 0223) ────────────────────
  if v_is_dvic and v_drv.role = 'driver' and v_van_id is not null then
    insert into public.vehicle_inspections (
      dsp_id, vehicle_id, inspector_driver_id, inspector_name,
      inspected_at, kind, result, defects, photos, form_submission_id
    ) values (
      v_drv.dsp_id, v_van_id, v_drv.id,
      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      v_row.submitted_at,
      'dvic', 'passed',
      coalesce(v_row.answers, '{}'::jsonb),
      v_photo_paths,
      v_row.id
    )
    returning id into v_inspection_id;
  end if;

  -- ── Vehicle Concerns branch ────────────────────────────────────────
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
    'is_vehicle_concern', v_is_concern
  );
end;
$$;
grant execute on function public.driver_submit_form(text, uuid, jsonb) to anon, authenticated;


notify pgrst, 'reload schema';
