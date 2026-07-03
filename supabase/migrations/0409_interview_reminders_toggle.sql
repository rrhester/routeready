-- ───────────────────────────────────────────────────────────────────────
-- 0409 · Dashboard control for interview reminders
--
-- 0406 added the automatic 24h/1h interview reminder scan plus a per-DSP
-- `interview_config.reminders_enabled` switch, but there was no way to see or
-- flip that switch from the dashboard. This adds a get/set RPC pair the
-- Availability menu uses to surface a "Interview reminders" toggle.
--
-- Idempotent, and self-contained: it re-asserts the `reminders_enabled` column
-- so it is safe to run even if 0406 has not been applied yet (the toggle then
-- controls a setting that begins doing work as soon as 0406's cron is live).
-- ───────────────────────────────────────────────────────────────────────

alter table public.interview_config
  add column if not exists reminders_enabled boolean not null default true;

-- Read the current switch for the caller's DSP (default on when unconfigured).
create or replace function public.interview_reminders_get()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select reminders_enabled from public.interview_config
      where dsp_id = private.current_dsp_id()),
    true);
$$;
grant execute on function public.interview_reminders_get() to authenticated;

-- Flip the switch for the caller's DSP.
create or replace function public.interview_reminders_set(p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config (dsp_id, reminders_enabled, updated_at)
  values (v_dsp, coalesce(p_enabled, true), now())
  on conflict (dsp_id) do update set
    reminders_enabled = excluded.reminders_enabled, updated_at = now();
  return coalesce(p_enabled, true);
end; $$;
grant execute on function public.interview_reminders_set(boolean) to authenticated;
