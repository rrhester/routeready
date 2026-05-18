-- Migration 0297 · Recognition · pg_cron schedule fix
--
-- 0296's pg_cron install block used
--     exception when undefined_function or undefined_table or undefined_schema then
-- but undefined_schema is not a valid Postgres exception condition
-- (Postgres throws "undefined_object" / SQLSTATE 42704 when the cron
-- schema is missing).  The whole DO block failed to compile, which
-- meant the cron job was never installed on hosts WHERE pg_cron IS
-- available either.
--
-- This migration re-runs the install with the right catch-all
-- (exception when others then) so the job lands on hosts with
-- pg_cron and silently no-ops on hosts without it.
--
-- Idempotent: cron.unschedule of a non-existent job is also swallowed.

do $$
begin
  -- Only attempt schedule if pg_cron extension is installed.
  perform 1 from pg_extension where extname = 'cron';
  if not found then
    raise notice 'pg_cron not installed — schedule public.recognition_autofire(current_date) via your own scheduler';
    return;
  end if;

  -- Unschedule any prior run with this name (idempotent).
  begin
    perform cron.unschedule('recognition-autofire-daily');
  exception when others then null;
  end;

  perform cron.schedule(
    'recognition-autofire-daily',
    '0 13 * * *',  -- 13:00 UTC daily = 9am EDT / 6am PDT
    $cron$ select public.recognition_autofire(current_date); $cron$
  );
  raise notice 'recognition-autofire-daily scheduled (13:00 UTC daily)';
exception when others then
  raise notice 'pg_cron schedule install failed (%): wire your own scheduler', sqlerrm;
end $$;
