-- 0513_okami_demand_audit.sql (renumbered from in-branch 0512 — #3974's
-- concurrent 0503→0512 swap-offer rename took that ordinal first)
--
-- Route-plan edit history for the Targets 13-week planner.
--
-- Plan edits (okami_set_target upserts from typing, paste, copy-forward,
-- percent adjust, seed, snapshot restore) auto-save with no trail — an
-- operator can't answer "who changed W34 from 45 to 55, and when".
--
-- 1) Attach the generic audit trigger (0433's private.log_audit_event)
--    to public.okami_demand, so every insert/update/delete records
--    who / when / before / after in public.audit_events.
-- 2) okami_demand_audit(p_week_start, p_limit) — the week-scoped feed
--    the Targets page reads: one row per audited bucket write whose
--    demand date falls inside [p_week_start, p_week_start+6].
--
-- Idempotent.

drop trigger if exists trg_audit_okami_demand on public.okami_demand;
create trigger trg_audit_okami_demand
  after insert or update or delete on public.okami_demand
  for each row execute function private.log_audit_event();

create or replace function public.okami_demand_audit(
  p_week_start date,
  p_limit      int default 80
) returns table (
  occurred_at   timestamptz,
  actor_email   text,
  action        text,
  demand_date   date,
  wave_index    int,
  target_before int,
  target_after  int,
  station_id    uuid
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  -- Dispatcher+ · plan edits are operational history, not compliance
  -- material, so the gate matches the other OKAMI RPCs rather than the
  -- ops-only audit_feed.
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select e.occurred_at,
         e.actor_email,
         e.action,
         coalesce((e.after->>'date')::date, (e.before->>'date')::date)           as demand_date,
         coalesce((e.after->>'wave_index')::int, (e.before->>'wave_index')::int, 0) as wave_index,
         (e.before->>'target_routes')::int                                       as target_before,
         (e.after->>'target_routes')::int                                        as target_after,
         coalesce((e.after->>'station_id')::uuid, (e.before->>'station_id')::uuid) as station_id
    from public.audit_events e
   where e.dsp_id = v_dsp
     and e.object_type = 'okami_demand'
     and coalesce((e.after->>'date')::date, (e.before->>'date')::date)
         between p_week_start and p_week_start + 6
   order by e.occurred_at desc
   limit greatest(1, least(coalesce(p_limit, 80), 200));
end;
$$;
grant execute on function public.okami_demand_audit(date, int) to authenticated;

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0513_okami_demand_audit.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
