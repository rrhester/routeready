-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0210 · Slim the workspace template catalogue
--
-- Drops the legacy templates (missing_equipment, recovery_actions,
-- van_damage, safety_followups) from private.assignment_templates(). The
-- three remaining templates — Van Assignments, Device Tracking, and Blank
-- Board — are the only ones a dispatcher should see in the picker.
--
-- This affects:
--   * public.assignment_board_templates() (which derives from this fn) —
--     the "Create from template" flow now only offers these three.
--   * public.seed_default_assignment_boards() — unchanged in behavior;
--     still seeds the same three boards.
--
-- Existing boards previously created from a removed template are NOT
-- touched. Their column definitions live on the board itself, so the
-- boards remain fully functional. We're just retiring the *templates*.
-- ─────────────────────────────────────────────────────────────────────────

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
      ] }
  ]$j$::jsonb;
$$;

notify pgrst, 'reload schema';
