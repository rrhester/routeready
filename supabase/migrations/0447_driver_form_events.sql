-- 0447_driver_form_events.sql
--
-- Production instrumentation for the driver-forms funnel. Until now the
-- driver app emitted no telemetry, so form completion / abandonment /
-- offline-flush outcomes were unobservable. This adds:
--
--   1. public.form_events — an append-only event sink (opened, submitted,
--      submit_rejected, queued_offline, flushed_ok, flushed_dropped).
--   2. public.driver_log_form_event(token, form_id, event, meta) — the
--      token-authed, security-definer write path the driver app calls
--      fire-and-forget (mirrors the never-throw discipline of client_errors).
--   3. private.form_funnel_agg(dsp_id, days) — pure aggregation (no auth), so
--      it is unit-testable, and public.form_funnel_stats(days) — the
--      dispatcher-gated, tenant-scoped roll-up that wraps it.
--
-- Drivers are anon and never touch the table directly; writes go only through
-- the definer RPC, reads are dispatcher-gated by RLS. Idempotent throughout.


-- ── 1. Event sink ────────────────────────────────────────────────────
create table if not exists public.form_events (
  id         uuid primary key default gen_random_uuid(),
  dsp_id     uuid not null references public.dsps(id)    on delete cascade,
  driver_id  uuid          references public.drivers(id) on delete set null,
  form_id    uuid          references public.forms(id)   on delete set null,
  event      text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists form_events_dsp_created_idx on public.form_events (dsp_id, created_at desc);
create index if not exists form_events_dsp_form_idx    on public.form_events (dsp_id, form_id);

do $$ begin
  alter table public.form_events
    add constraint form_events_event_chk
    check (event in ('opened','submitted','submit_rejected','queued_offline','flushed_ok','flushed_dropped'));
exception when duplicate_object then null; end $$;

alter table public.form_events enable row level security;

-- Dispatchers (and up) of the owning DSP may read their tenant's events.
-- No INSERT/UPDATE/DELETE policy: writes go only through the definer RPC.
do $$ begin
  create policy form_events_tenant_read on public.form_events
    for select using (dsp_id = private.current_dsp_id()
                      and private.is_staff(private.current_dsp_id(), 'dispatcher'));
exception when duplicate_object then null; end $$;


-- ── 2. Driver write path (token-authed, fire-and-forget) ─────────────
create or replace function public.driver_log_form_event(
  p_token   text,
  p_form_id uuid,
  p_event   text,
  p_meta    jsonb default '{}'::jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_dsp uuid;
begin
  -- Unknown event names are ignored rather than raised — this is best-effort
  -- telemetry the client calls fire-and-forget; it must never surface an
  -- error into the driver's flow.
  if p_event is null or p_event not in
     ('opened','submitted','submit_rejected','queued_offline','flushed_ok','flushed_dropped') then
    return;
  end if;

  v_drv := private.driver_validate_token(p_token);

  -- Only log against a form in the driver's own DSP; a mismatched/absent
  -- form_id records a null linkage rather than leaking cross-tenant.
  select f.dsp_id into v_dsp from public.forms f
   where f.id = p_form_id and f.dsp_id = v_drv.dsp_id;

  insert into public.form_events (dsp_id, driver_id, form_id, event, meta)
  values (v_drv.dsp_id, v_drv.id,
          case when v_dsp is not null then p_form_id else null end,
          p_event, coalesce(p_meta, '{}'::jsonb));
end;
$$;

grant execute on function public.driver_log_form_event(text, uuid, text, jsonb) to anon, authenticated;


-- ── 3. Aggregation ───────────────────────────────────────────────────
-- Pure roll-up over one DSP's events for the last N days. No auth here so it
-- can be tested directly; public.form_funnel_stats gates access.
create or replace function private.form_funnel_agg(p_dsp_id uuid, p_days int)
returns jsonb
language sql stable set search_path = ''
as $$
  with ev as (
    select * from public.form_events
     where dsp_id = p_dsp_id
       and created_at >= now() - (greatest(p_days, 1) || ' days')::interval
  ),
  totals as (
    select
      count(*) filter (where event = 'opened')          as opened,
      count(*) filter (where event = 'submitted')        as submitted,
      count(*) filter (where event = 'submit_rejected')  as submit_rejected,
      count(*) filter (where event = 'queued_offline')   as queued_offline,
      count(*) filter (where event = 'flushed_ok')       as flushed_ok,
      count(*) filter (where event = 'flushed_dropped')  as flushed_dropped
    from ev
  ),
  by_form as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'form_id', form_id,
             'title',   coalesce(fo.title, '(deleted form)'),
             'opened',    o,
             'completed', c,
             'completion_rate', case when o > 0 then round((c::numeric / o), 3) else null end
           ) order by o desc), '[]'::jsonb) as j
    from (
      select form_id,
             count(*) filter (where event = 'opened')                          as o,
             count(*) filter (where event in ('submitted','flushed_ok'))       as c
      from ev group by form_id
    ) g
    left join public.forms fo on fo.id = g.form_id
  )
  select jsonb_build_object(
    'days', greatest(p_days, 1),
    'totals', (select jsonb_build_object(
        'opened', opened, 'submitted', submitted, 'submit_rejected', submit_rejected,
        'queued_offline', queued_offline, 'flushed_ok', flushed_ok,
        'flushed_dropped', flushed_dropped,
        'completions', submitted + flushed_ok,
        'completion_rate', case when opened > 0
             then round(((submitted + flushed_ok)::numeric / opened), 3) else null end
      ) from totals),
    'by_form', (select j from by_form)
  );
$$;

create or replace function public.form_funnel_stats(p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.form_funnel_agg(v_dsp, p_days);
end;
$$;

grant execute on function public.form_funnel_stats(int) to authenticated;


notify pgrst, 'reload schema';
