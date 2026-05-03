-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0024 · Enable Realtime broadcast for the operator dashboard
--
-- Add the tables the dashboard subscribes to so changes (status flips,
-- new applicants, hires, etc.) push to all open dashboards instantly
-- without a refresh.
-- ─────────────────────────────────────────────────────────────────────────

-- The supabase_realtime publication is provisioned by Supabase. We just
-- need to add our tables to it. ALTER PUBLICATION ... ADD is idempotent
-- when wrapped — we use a DO block to swallow "already member" errors.

do $$
declare
  t text;
  tables text[] := array[
    'applicants',
    'cal_events',
    'sms_messages',
    'email_messages',
    'interview_outcomes',
    'interview_days',
    'drivers',
    'coachings',
    'driver_documents'
  ];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      -- Table is already in the publication — ignore.
      null;
    end;
  end loop;
end $$;
