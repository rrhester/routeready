-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0005 · Seed + auth hook
--
-- Three things:
--   1. Seed a demo DSP, station, screening questions, and SMS templates.
--   2. Reserve an app_users row for support@gorouteready.com so the first
--      magic-link sign-in lands as 'owner' on the demo DSP.
--   3. on_auth_user_created trigger that auto-binds any new auth.users row
--      with an @gorouteready.com email to the demo DSP as a 'driver' (the
--      owner can promote them later). Non-allowed domains are rejected.
--
-- The seed is idempotent: re-running the migration won't duplicate rows.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── 1. Demo DSP + station ───────────────────────────────────────────────

insert into public.dsps (id, name, short_code, timezone, metadata)
values (
  '00000000-0000-0000-0000-00000000d000',
  'RouteReady Demo',
  'DEMO',
  'America/New_York',
  jsonb_build_object(
    'public_base_url', 'https://gorouteready.com',
    'cal', jsonb_build_object(
      'username', 'routeready',
      'interview_slug', 'interview',
      'orientation_slug', 'orientation-day'
    ),
    'sms', jsonb_build_object(
      'quiet_hours_start', '21:00',
      'quiet_hours_end',   '08:00',
      'auto_send_screening', true
    )
  )
)
on conflict (short_code) do update
  set metadata = excluded.metadata;

insert into public.stations (id, dsp_id, code, name)
values (
  '00000000-0000-0000-0000-0000000051a1',
  '00000000-0000-0000-0000-00000000d000',
  'DCA1',
  'Capitol Heights'
)
on conflict (dsp_id, code) do nothing;


-- ─── 2. Pre-bind support@gorouteready.com as owner ───────────────────────
--
-- We can't insert into public.app_users yet because the FK requires a row
-- in auth.users. Instead, we INSERT into a staging table that the auth
-- hook drains on first sign-in. Simpler: stash the binding in dsps.metadata
-- as 'pending_owners' and have the hook check that list.

update public.dsps
   set metadata = jsonb_set(
     metadata,
     '{pending_owners}',
     '["support@gorouteready.com"]'::jsonb,
     true
   )
 where short_code = 'DEMO';


-- ─── 3. Default screening questions ──────────────────────────────────────

insert into public.screening_questions (dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order)
values
  ('00000000-0000-0000-0000-00000000d000',
   'Are you at least 21 years old?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":1,"No":0}'::jsonb, 1),

  ('00000000-0000-0000-0000-00000000d000',
   'Do you have a valid U.S. driver''s license?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":1,"No":0}'::jsonb, 2),

  ('00000000-0000-0000-0000-00000000d000',
   'Are you legally authorized to work in the U.S.?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":1,"No":0}'::jsonb, 3),

  ('00000000-0000-0000-0000-00000000d000',
   'Can you lift and carry packages up to 50 lbs throughout the day?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":2,"No":0}'::jsonb, 4),

  ('00000000-0000-0000-0000-00000000d000',
   'How many years of driving experience do you have?',
   'single', '["Less than 1","1-2 years","3-5 years","5+ years"]'::jsonb, true,
   null,
   '{"Less than 1":0,"1-2 years":1,"3-5 years":2,"5+ years":3}'::jsonb, 5),

  ('00000000-0000-0000-0000-00000000d000',
   'Are you available to work weekends?',
   'single', '["Yes, both days","Saturdays only","Sundays only","Neither"]'::jsonb, true,
   null,
   '{"Yes, both days":3,"Saturdays only":2,"Sundays only":2,"Neither":0}'::jsonb, 6),

  ('00000000-0000-0000-0000-00000000d000',
   'Have you been convicted of a felony in the last 7 years?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"Yes"}'::jsonb,
   '{"Yes":0,"No":1}'::jsonb, 7),

  ('00000000-0000-0000-0000-00000000d000',
   'Do you have reliable transportation to the delivery station?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   null,
   '{"Yes":1,"No":0}'::jsonb, 8)
on conflict do nothing;


-- ─── 4. Default SMS templates ────────────────────────────────────────────

insert into public.message_templates (dsp_id, channel, key, name, body)
values
  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.invite_screening',
   'Screening invite',
   'Hi {{first_name}}, this is RouteReady. Thanks for applying! Please complete this 2-min screening: {{link}}  Reply STOP to opt out.'),

  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.invite_interview',
   'Interview invite',
   'Hi {{first_name}}, you''re cleared for an interview! Pick a time that works for you: {{link}}  Reply STOP to opt out.'),

  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.invite_orientation',
   'Orientation invite',
   'Hi {{first_name}}, congrats — please book your paid orientation day: {{link}}  Reply STOP to opt out.'),

  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.decline',
   'Decline notice',
   'Hi {{first_name}}, thanks for your interest in RouteReady. We won''t be moving forward at this time. Best of luck!')
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, updated_at = now();


-- ─── 5. Default email templates ──────────────────────────────────────────

insert into public.message_templates (dsp_id, channel, key, name, subject, body)
values
  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.invite_screening',
   'Screening invite (email)',
   'Quick screening for your driver application',
   E'Hi {{first_name}},\n\nThanks for applying with RouteReady. Please complete a short screening here:\n\n{{link}}\n\nIt takes about 2 minutes.\n\n— The RouteReady team'),

  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.invite_interview',
   'Interview invite (email)',
   'You''re cleared for an interview',
   E'Hi {{first_name}},\n\nGreat news — you passed screening. Pick an interview slot:\n\n{{link}}\n\n— The RouteReady team')
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, subject = excluded.subject, updated_at = now();


-- ─── 6. Auth hook: bind new auth.users to a DSP ──────────────────────────
--
-- Fires after a new row lands in auth.users. The hook:
--   • Looks up the email's domain.
--   • Rejects if not in the allowed list (raises, which aborts signup).
--   • If the email matches a DSP's pending_owners, creates an app_users
--     row with role='owner' and clears the pending entry.
--   • Otherwise, binds to a default DSP as 'driver'.
--
-- We hard-code 'gorouteready.com' as the default-domain → demo-DSP rule.
-- For production this becomes a config-table lookup; that lives in 0006+.

create or replace function private.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text;
  v_email  text := lower(new.email);
  v_dsp    public.dsps;
  v_role   public.app_role := 'driver';
  v_pending_owners jsonb;
begin
  if v_email is null then
    return new;
  end if;

  v_domain := split_part(v_email, '@', 2);

  if v_domain <> 'gorouteready.com' then
    raise exception using
      errcode = '42501',
      message = 'signup_domain_not_allowed: ' || v_domain;
  end if;

  select * into v_dsp from public.dsps where short_code = 'DEMO' limit 1;
  if v_dsp.id is null then
    raise exception 'no_default_dsp_configured';
  end if;

  v_pending_owners := coalesce(v_dsp.metadata->'pending_owners', '[]'::jsonb);
  if v_pending_owners ? v_email then
    v_role := 'owner';
    update public.dsps
       set metadata = jsonb_set(
         metadata,
         '{pending_owners}',
         (select coalesce(jsonb_agg(elem), '[]'::jsonb)
            from jsonb_array_elements_text(v_pending_owners) elem
            where elem <> v_email)
       )
     where id = v_dsp.id;
  end if;

  insert into public.app_users (id, dsp_id, email, full_name, role)
  values (new.id, v_dsp.id, v_email, coalesce(new.raw_user_meta_data->>'full_name', v_email), v_role)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function private.on_auth_user_created();


-- ─── 7. Public intake (apply form) ───────────────────────────────────────
--
-- Anon-callable. Used by /apply and by the webhook-apply edge function.
-- Dedups by (dsp_short_code, source, source_ref) and (dsp_id, lower(email)).

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
