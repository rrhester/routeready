-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0209 · Workspace default seeding (Phase 1)
--
-- Phase 1 of the Workspaces expansion. Two parts:
--
-- 1. Updated assignment_templates() catalogue:
--    - NEW van_assignments  — fleet management board with van #, assigned
--      driver, active/inactive, route type, status, maintenance, last
--      inspection, registration expiry, damage notes
--    - EXPANDED device_tracking — adds phone number, condition, last seen
--    - NEW blank_starter — minimal 3-column starting point
--    Existing templates (van_damage, missing_equipment, recovery_actions,
--    safety_followups) keep working — they're still valid templates.
--
-- 2. seed_default_assignment_boards() — idempotent first-time seeding.
--    Creates Van Assignments, Device Tracking, and Blank Board for the
--    caller's DSP, then flips a flag in dsps.metadata so subsequent calls
--    are no-ops. The dashboard calls this on first Workspaces view load
--    so every DSP lands with the three starter boards already in place.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Updated template catalogue ──────────────────────────────────────
create or replace function private.assignment_templates()
returns jsonb
language sql immutable set search_path = ''
as $$
  select $j$[
    { "key":"van_assignments", "name":"Van Assignments", "icon":"vehicle",
      "columns":[
        {"id":"van","name":"Van #","type":"text","width":110},
        {"id":"assignee","name":"Assigned driver","type":"driver","width":180,"role":"assignee"},
        {"id":"active","name":"Active","type":"status","width":110,"options":["Active","Inactive"]},
        {"id":"route","name":"Route type","type":"status","width":140,"options":["Standard","Step Van","XL","Hub","Other"]},
        {"id":"status","name":"Status","type":"status","width":160,"options":["In service","Needs attention","Out of service"],"role":"status"},
        {"id":"maint","name":"Maintenance","type":"status","width":150,"options":["Up to date","Scheduled","Overdue"]},
        {"id":"inspection","name":"Last inspection","type":"date","width":140},
        {"id":"registration","name":"Registration exp.","type":"date","width":150},
        {"id":"damage","name":"Damage notes","type":"note","width":300}
      ] },
    { "key":"device_tracking", "name":"Device Tracking", "icon":"devices",
      "columns":[
        {"id":"item","name":"Device","type":"text","width":200},
        {"id":"kind","name":"Type","type":"status","width":140,"options":["Phone","Tablet","Rabbit","Charger","Battery","Key","Fuel card","Other"]},
        {"id":"assignee","name":"Assigned to","type":"driver","width":170,"role":"assignee"},
        {"id":"phone","name":"Phone number","type":"text","width":150},
        {"id":"status","name":"Status","type":"status","width":140,"options":["Issued","In use","Returned","Lost","Damaged"],"role":"status"},
        {"id":"condition","name":"Condition","type":"status","width":130,"options":["New","Good","Fair","Worn","Damaged"]},
        {"id":"last_seen","name":"Last seen","type":"date","width":130},
        {"id":"note","name":"Notes","type":"note","width":280}
      ] },
    { "key":"blank_starter", "name":"Blank Board", "icon":"generic",
      "columns":[
        {"id":"item","name":"Item","type":"text","width":260},
        {"id":"status","name":"Status","type":"status","width":150,"options":["Open","In progress","Done"],"role":"status"},
        {"id":"note","name":"Note","type":"note","width":300}
      ] },
    { "key":"missing_equipment", "name":"Missing Equipment Tracker", "icon":"equipment",
      "columns":[
        {"id":"item","name":"Item","type":"text","width":220},
        {"id":"status","name":"Status","type":"status","width":160,"options":["Reported missing","Searching","Located","Recovered","Written off"],"role":"status"},
        {"id":"assignee","name":"Owner / last had it","type":"driver","width":190,"role":"assignee"},
        {"id":"due","name":"Resolve by","type":"date","width":120,"role":"due"},
        {"id":"note","name":"Details","type":"note","width":300}
      ] },
    { "key":"recovery_actions", "name":"Driver Recovery Actions", "icon":"recovery",
      "columns":[
        {"id":"item","name":"Action","type":"text","width":260},
        {"id":"assignee","name":"Driver","type":"driver","width":170,"role":"assignee"},
        {"id":"status","name":"Status","type":"status","width":150,"options":["Open","In progress","Done","Waived"],"role":"status"},
        {"id":"due","name":"Due","type":"date","width":120,"role":"due"},
        {"id":"note","name":"Note","type":"note","width":300}
      ] },
    { "key":"van_damage", "name":"Van Damage Assignments", "icon":"vehicle",
      "columns":[
        {"id":"van","name":"Van","type":"text","width":120},
        {"id":"item","name":"Damage / issue","type":"text","width":260},
        {"id":"assignee","name":"Driver responsible","type":"driver","width":180,"role":"assignee"},
        {"id":"status","name":"Status","type":"status","width":160,"options":["Reported","Reviewing","Repair scheduled","Resolved","No fault"],"role":"status"},
        {"id":"due","name":"Follow up by","type":"date","width":130,"role":"due"},
        {"id":"note","name":"Note","type":"note","width":280}
      ] },
    { "key":"safety_followups", "name":"Safety Follow-Ups", "icon":"safety",
      "columns":[
        {"id":"item","name":"Follow-up","type":"text","width":260},
        {"id":"assignee","name":"Driver","type":"driver","width":170,"role":"assignee"},
        {"id":"status","name":"Status","type":"status","width":150,"options":["Open","In progress","Closed"],"role":"status"},
        {"id":"due","name":"Due","type":"date","width":120,"role":"due"},
        {"id":"note","name":"Note","type":"note","width":300}
      ] }
  ]$j$::jsonb;
$$;


-- ── 2. seed_default_assignment_boards ──────────────────────────────────
-- Idempotent first-time seeding. Creates Van Assignments, Device
-- Tracking, and Blank Board for the caller's DSP if they haven't been
-- seeded yet. Flag lives at dsps.metadata.workspaces.defaults_seeded so
-- re-running is a no-op even if the dispatcher later archives or renames
-- the seeded boards (the seeder doesn't second-guess their decisions).
create or replace function public.seed_default_assignment_boards()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_already    boolean;
  v_pos        int;
  v_tpls       jsonb := private.assignment_templates();
  v_keys       text[] := array['van_assignments','device_tracking','blank_starter'];
  v_key        text;
  v_tpl        jsonb;
  v_b          public.assignment_boards;
  v_seeded     int := 0;
  v_board_ids  jsonb := '[]'::jsonb;
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Already seeded? No-op.
  select coalesce((metadata->'workspaces'->>'defaults_seeded')::boolean, false)
    into v_already
    from public.dsps where id = v_dsp;
  if v_already then
    return jsonb_build_object('seeded', 0, 'already_done', true);
  end if;

  -- Next position in the picker
  select coalesce(max(position), -1) + 1 into v_pos
    from public.assignment_boards where dsp_id = v_dsp;

  foreach v_key in array v_keys loop
    select t into v_tpl from jsonb_array_elements(v_tpls) t where t->>'key' = v_key limit 1;
    if v_tpl is null then continue; end if;

    insert into public.assignment_boards (dsp_id, name, icon, columns, position)
    values (v_dsp, v_tpl->>'name', v_tpl->>'icon', coalesce(v_tpl->'columns','[]'::jsonb), v_pos)
    returning * into v_b;

    perform private.assignment_log(v_b.id, v_dsp, 'board_created', null,
      jsonb_build_object('name', v_b.name, 'template', v_key, 'auto_seeded', true));

    v_board_ids := v_board_ids || jsonb_build_array(v_b.id);
    v_pos := v_pos + 1;
    v_seeded := v_seeded + 1;
  end loop;

  -- Mark seeded so this is truly one-time per DSP.
  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb)
         #- '{workspaces}'
         || jsonb_build_object('workspaces', coalesce(metadata->'workspaces', '{}'::jsonb)),
       '{workspaces,defaults_seeded}',
       'true'::jsonb,
       true)
   where id = v_dsp;

  return jsonb_build_object('seeded', v_seeded, 'already_done', false, 'board_ids', v_board_ids);
end;
$$;
grant execute on function public.seed_default_assignment_boards() to authenticated;

notify pgrst, 'reload schema';
