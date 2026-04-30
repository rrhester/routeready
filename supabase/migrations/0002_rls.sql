-- ================================================================
-- RouteReady — Row Level Security policies
-- Migration: 0002_rls.sql
--
-- Two access patterns:
--   1. Authenticated DSP user (dashboard): can only see their own DSP.
--   2. Service role (Edge Functions): bypasses RLS entirely, used for
--      public endpoints like record.html where there's no logged-in user.
--      Edge Functions handle their own per-DSP scoping using a token
--      or applicant_id from the request.
--
-- The `anon` key (used directly from the browser) gets no access
-- to anything except question_bank (which is global).
-- ================================================================

-- Enable RLS on every table
alter table public.dsps                    enable row level security;
alter table public.profiles                enable row level security;
alter table public.settings                enable row level security;
alter table public.applicants              enable row level security;
alter table public.applicant_messages      enable row level security;
alter table public.applicant_tokens        enable row level security;
alter table public.question_bank           enable row level security;
alter table public.screening_selections    enable row level security;
alter table public.screening_responses     enable row level security;
alter table public.filtered_applicants     enable row level security;
alter table public.waitlist                enable row level security;
alter table public.message_queue           enable row level security;
alter table public.failures                enable row level security;
alter table public.decisions_log           enable row level security;
alter table public.cycle_history           enable row level security;
alter table public.cycle_archive           enable row level security;
alter table public.dismissals              enable row level security;
alter table public.referral_codes          enable row level security;
alter table public.referrals               enable row level security;
alter table public.video_recordings        enable row level security;
alter table public.message_templates       enable row level security;
alter table public.driver_roster           enable row level security;
alter table public.safety_events           enable row level security;
alter table public.quality_daily           enable row level security;
alter table public.coaching_log            enable row level security;

-- ================================================================
-- DSPS: a user sees only their own DSP row
-- ================================================================

create policy dsps_self_select on public.dsps
  for select to authenticated
  using (id = public.current_dsp_id());

create policy dsps_self_update on public.dsps
  for update to authenticated
  using (id = public.current_dsp_id())
  with check (id = public.current_dsp_id());

-- DSP rows are created by the service role only (during signup/provisioning).

-- ================================================================
-- PROFILES: a user sees only their own profile row
-- ================================================================

create policy profiles_self_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

create policy profiles_self_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ================================================================
-- QUESTION_BANK: read-only, visible to everyone (it's the same
-- shared library for all DSPs).
-- ================================================================

create policy question_bank_read_all on public.question_bank
  for select to authenticated, anon
  using (true);

-- ================================================================
-- All other tables: scoped to current_dsp_id()
-- The same shape repeats for every per-DSP table.
-- ================================================================

-- Helper: a single function that creates the four standard policies
-- per DSP table. Calling once per table keeps this file short and
-- guarantees consistent policy shape.

create or replace function public._dsp_scoped_policies(tbl regclass)
returns void
language plpgsql
as $fn$
declare
  tname text := tbl::text;        -- e.g. 'public.applicants'
begin
  execute format(
    'create policy %I on %s for select to authenticated using (dsp_id = public.current_dsp_id())',
    'dsp_select_' || split_part(tname, '.', 2), tbl
  );
  execute format(
    'create policy %I on %s for insert to authenticated with check (dsp_id = public.current_dsp_id())',
    'dsp_insert_' || split_part(tname, '.', 2), tbl
  );
  execute format(
    'create policy %I on %s for update to authenticated using (dsp_id = public.current_dsp_id()) with check (dsp_id = public.current_dsp_id())',
    'dsp_update_' || split_part(tname, '.', 2), tbl
  );
  execute format(
    'create policy %I on %s for delete to authenticated using (dsp_id = public.current_dsp_id())',
    'dsp_delete_' || split_part(tname, '.', 2), tbl
  );
end
$fn$;

select public._dsp_scoped_policies('public.settings');
select public._dsp_scoped_policies('public.applicants');
select public._dsp_scoped_policies('public.applicant_messages');
select public._dsp_scoped_policies('public.applicant_tokens');
select public._dsp_scoped_policies('public.screening_selections');
select public._dsp_scoped_policies('public.screening_responses');
select public._dsp_scoped_policies('public.filtered_applicants');
select public._dsp_scoped_policies('public.waitlist');
select public._dsp_scoped_policies('public.message_queue');
select public._dsp_scoped_policies('public.failures');
select public._dsp_scoped_policies('public.decisions_log');
select public._dsp_scoped_policies('public.cycle_history');
select public._dsp_scoped_policies('public.cycle_archive');
select public._dsp_scoped_policies('public.dismissals');
select public._dsp_scoped_policies('public.referral_codes');
select public._dsp_scoped_policies('public.referrals');
select public._dsp_scoped_policies('public.video_recordings');
select public._dsp_scoped_policies('public.message_templates');
select public._dsp_scoped_policies('public.driver_roster');
select public._dsp_scoped_policies('public.safety_events');
select public._dsp_scoped_policies('public.quality_daily');
select public._dsp_scoped_policies('public.coaching_log');

-- Tidy up — function is no longer needed at runtime.
drop function public._dsp_scoped_policies(regclass);

-- ================================================================
-- NOTES on the public applicant flow (record.html, sendVideoLink, etc)
-- ================================================================
--
-- Public endpoints don't have an authenticated user. They run as
-- Supabase Edge Functions using the SERVICE_ROLE key (which bypasses
-- RLS) and resolve the DSP from one of:
--
--   - applicant_token (the URL token from the SMS link)
--   - dsp slug in the URL (e.g. /apply/aircapital)
--   - applicant_id passed from the dashboard
--
-- Every Edge Function MUST validate that the resolved dsp_id matches
-- the data being read/written. RLS is the safety net; the function
-- is the gate.
--
-- The anon key (used directly from the browser) can ONLY read
-- question_bank. Everything else goes through Edge Functions.
