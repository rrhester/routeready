-- Migration 0299 · Vehicle Concerns form · van dropdown
--
-- Follow-up to 0298. Drivers asked for a scroll picker of every van
-- in the fleet instead of a free-text field — so they can confirm the
-- pre-filled van or pick a different one without typing.
--
-- Changes:
--   1. dsp_install_vehicle_concerns_form() installs concern_van as a
--      'dropdown' field. Options stay empty in storage — they're
--      injected by driver_get_form at fetch time so the list is
--      always live (newly-added vans show up immediately, archived
--      ones disappear).
--   2. Backfill flips any existing concern_van field from short_text
--      to dropdown and clears its options. Idempotent.
--   3. driver_get_form populates concern_van.options with the active
--      fleet (status <> 'retired', not archived) ordered by name, and
--      sets prefill.concern_van to the resolved van so the select
--      lands on the right option.
--
-- driver_submit_form is unchanged from 0298: the matching logic
-- already resolves the chosen option's text against vehicles.name /
-- nickname / plate, which is exactly what the dropdown will hand back.


-- ── 1. Installer · concern_van is now a dropdown ────────────────────
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
      'type', 'dropdown',
      'label', 'Van number',
      'required', true,
      'help', 'Which van is this about? Pre-selected from your assignment — pick a different one if needed.',
      'options', jsonb_build_array()
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


-- ── 2. Backfill: flip existing concern_van fields to dropdown ───────
-- Walks every Vehicle Concerns form and rewrites the concern_van
-- field in place to type=dropdown with empty options. Idempotent —
-- forms already on dropdown are left alone. Help text is also
-- refreshed so drivers see the updated copy ("pick" instead of
-- "change") that matches the new UI.
do $$
declare
  r        record;
  v_new_fields jsonb;
begin
  for r in
    select id, fields from public.forms
     where coalesce((settings->>'is_vehicle_concern')::boolean, false) = true
       and exists (
         select 1 from jsonb_array_elements(fields) e
         where e->>'id' = 'concern_van' and e->>'type' <> 'dropdown'
       )
  loop
    select jsonb_agg(
             case
               when elem->>'id' = 'concern_van' then
                 elem
                   || jsonb_build_object('type', 'dropdown')
                   || jsonb_build_object('options', jsonb_build_array())
                   || jsonb_build_object(
                        'help',
                        'Which van is this about? Pre-selected from your assignment — pick a different one if needed.'
                      )
               else elem
             end
             order by ord
           )
      into v_new_fields
      from jsonb_array_elements(r.fields) with ordinality t(elem, ord);

    update public.forms set fields = v_new_fields where id = r.id;
  end loop;
end;
$$;


-- ── 3. driver_get_form · inject live van options + prefill ──────────
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

  v_fields := v_row.fields;

  if coalesce((v_row.settings->>'is_vehicle_concern')::boolean, false)
     and v_drv.role = 'driver' then
    -- Live list of pickable vans for the dropdown. Skip retired so the
    -- list doesn't grow forever; keep spare/out_of_service so drivers
    -- can flag concerns on vans that are currently parked.
    select coalesce(jsonb_agg(v.name order by v.name), '[]'::jsonb)
      into v_van_options
      from public.vehicles v
     where v.dsp_id = v_drv.dsp_id
       and v.archived_at is null
       and v.status <> 'retired';

    -- Replace concern_van.options with the live list.
    select jsonb_agg(
             case when elem->>'id' = 'concern_van'
                  then elem || jsonb_build_object('options', v_van_options)
                  else elem end
             order by ord
           )
      into v_fields
      from jsonb_array_elements(v_row.fields) with ordinality t(elem, ord);

    -- Prefill with the driver's resolved van for today.
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


notify pgrst, 'reload schema';
