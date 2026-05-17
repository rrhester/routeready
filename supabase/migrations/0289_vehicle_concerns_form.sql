-- Migration 0289 · Vehicle Concerns form
--
-- Drivers need a single, always-on channel to proactively report any
-- vehicle concern — damage, mechanical issue, electrical glitch,
-- safety worry, cleanliness, missing equipment — without having to
-- phone dispatch.  Submissions land as a driver-reported row on the
-- vehicle's record (vehicle_issues) and flag the van on the Fleet
-- roster so leadership immediately sees what needs review.
--
-- Wiring (mirrors the DVIC pattern from migration 0223 / 0226):
--   1. forms.settings.is_vehicle_concern = true tags a form as a
--      Vehicle Concerns form.  driver_submit_form, on submission,
--      resolves the driver's van for today and auto-creates a
--      vehicle_issues row sourced from the answers.
--   2. vehicle_issues gains `photos` (jsonb) + `form_submission_id`
--      so the issue links back to the submission and the dashboard
--      can render the photos the driver attached.
--   3. vehicles_roster() returns `driver_reported_open_count` next
--      to `open_issue_count` so the Fleet roster can render a
--      distinct "⚑ driver-reported" badge for leadership review.
--   4. dsp_install_vehicle_concerns_form() — one-call installer
--      that creates a default Vehicle Concerns form (with the
--      well-known field IDs the RPC reads) and publishes it.  Safe
--      to call repeatedly; returns the existing form if one already
--      exists.
--
-- Field-ID convention the RPC reads (must match the installer):
--   concern_category    single_choice  → vehicle_issues.category
--   concern_severity    single_choice  → vehicle_issues.severity
--   concern_title       short_text     → vehicle_issues.title
--   concern_description long_text      → vehicle_issues.description
--   any field with type='photo' or 'file' → vehicle_issues.photos[]


-- ── 1. vehicle_issues · photos + form_submission_id ─────────────────
alter table public.vehicle_issues
  add column if not exists photos              jsonb not null default '[]'::jsonb,
  add column if not exists form_submission_id  uuid references public.form_submissions(id) on delete set null;

create index if not exists vehicle_issues_submission_idx
  on public.vehicle_issues (form_submission_id);


-- ── 2. vehicles_roster · driver_reported_open_count ─────────────────
-- Adds a second open-issue counter scoped to driver-self-reported
-- issues so the roster row can render a distinct "⚑ N driver-reported"
-- badge.  Existing `open_issue_count` is unchanged so any caller that
-- only reads the original field keeps working.
create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'operational_status', vh.operational_status,
      'year',               vh.year,
      'make',               vh.make,
      'model',              vh.model,
      'trim_level',         vh.trim_level,
      'color',              vh.color,
      'plate',              vh.plate,
      'plate_state',        vh.plate_state,
      'vin',                vh.vin,
      'mileage',            vh.mileage,
      'mileage_updated_at', vh.mileage_updated_at,
      'last_route_completed_at', vh.last_route_completed_at,
      'photo_path',         vh.photo_path,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'last_service_at',    vh.last_service_at,
      'next_service_due_at',vh.next_service_due_at,
      'dot_inspection_at',  vh.dot_inspection_at,
      'registration_expires_on', vh.registration_expires_on,
      'insurance_expires_on',    vh.insurance_expires_on,
      'updated_at',         vh.updated_at,
      'primary_driver_id',  pri.driver_id,
      'primary_driver_name',pri.name,
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0),
      'driver_reported_open_count', coalesce(dri.cnt, 0)
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
    left join lateral (
      select greatest(count(*)::int - 1, 0) as backup_count
      from public.vehicle_driver_assignments
      where vehicle_id = vh.id
    ) ch on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed'
    ) oi on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id
        and status <> 'completed'
        and source = 'driver_self_report'
    ) dri on true
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


-- ── 3. driver_submit_form — adds Vehicle Concerns branch ────────────
-- Keeps the DVIC branch intact from 0223 and adds a parallel branch
-- for forms tagged settings.is_vehicle_concern.  Both branches share
-- the same van-resolver and photo-extractor.
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

  -- Van resolver — shared between DVIC and Vehicle Concerns branches.
  -- Only relevant when the submitter is a driver and the form is one
  -- of the two auto-link types.
  if (v_is_dvic or v_is_concern) and v_drv.role = 'driver' then
    select coalesce(
      (select v.id from public.vehicles v
         join public.vehicle_day_assignments oa
           on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = v_today
        where v.dsp_id = v_drv.dsp_id and v.archived_at is null
        limit 1),
      (select v.id from public.vehicles v
         join public.vehicle_driver_assignments a
           on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
        where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (select 1 from public.vehicle_day_assignments oa
                          where oa.vehicle_id = v.id and oa.date = v_today)
        order by v.name limit 1),
      (select v.id from public.vehicles v
         join public.vehicle_driver_assignments a
           on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank > 0
         left join public.vehicle_driver_assignments pri_a
           on pri_a.vehicle_id = v.id and pri_a.rank = 0
        where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (select 1 from public.vehicle_day_assignments oa
                          where oa.vehicle_id = v.id and oa.date = v_today)
          and (pri_a.driver_id is null
            or not exists (
              select 1 from public.shifts ps
              where ps.driver_id = pri_a.driver_id
                and ps.date = v_today and ps.dsp_id = v_drv.dsp_id
                and ps.status in ('scheduled','completed','late')
            ))
        order by a.rank, v.name limit 1)
    ) into v_van_id;

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
  -- Build a vehicle_issues row from the answers.  Falls back to safe
  -- defaults when fields are missing or unrecognised so a partial
  -- form (e.g. operator removed a field) still produces something
  -- actionable on the roster.
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

    -- Map user-facing labels to the documented vehicle_issues.category
    -- vocabulary (mechanical | electrical | body | safety | other |
    -- self_reported).  Anything unrecognised collapses to
    -- 'self_reported' so the issue still surfaces.
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
      null   -- driver path uses anon token; no auth.uid()
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


-- ── 4. dsp_install_vehicle_concerns_form ────────────────────────────
-- One-shot installer the dashboard calls when a dispatcher clicks
-- "Install Vehicle Concerns form".  Idempotent: if a Vehicle Concerns
-- form already exists for the DSP it is returned untouched.
--
-- The field IDs are stable so the driver_submit_form RPC above can
-- read the answers without relying on the dispatcher to preserve
-- labels exactly.  The dispatcher can still rename / reorder / add
-- fields in the form builder — what matters is the IDs.
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

  -- Idempotent: return the existing form (any status) if one's already
  -- installed.  Dispatchers can then republish or archive as needed
  -- from the standard forms UI.
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


notify pgrst, 'reload schema';
