-- Migration 0228 · Repair-order workflow + auto grounding-event mirror
--
-- Wires the existing Fleet → Issues surface to the new repair_orders
-- ledger (migration 0227) so the Compliance exceptions table lights up
-- from real operational state.
--
-- Adds:
--
--   · Trigger _fleet_maintain_grounding_event — keeps
--     vehicle_grounding_events in sync with vehicles.operational_status.
--     When a vehicle flips to grounded, an event is opened; when it
--     flips back to operational, any open event is closed.  This is
--     what makes "days_grounded vs Amazon 2 BD / 14 BD" work without
--     anyone manually inserting grounding rows.
--
--   · repair_order_open_from_issue   — open an RO from a vehicle_issue,
--                                      auto-generating an RO code, flipping
--                                      the issue to in_repair, linking the
--                                      RO code into the issue's work_order
--                                      field, and writing an audit event.
--
--   · repair_order_save              — upsert any field on an RO.
--
--   · repair_order_complete          — mark RO completed, close the
--                                      paired grounding event if the
--                                      vehicle is operational again.
--
--   · repair_orders_for_vehicle      — list ROs for a VIN (used by the
--                                      Fleet drawer's RO panel).
--
--   · vendors_for_dsp                — list vendors available for the
--                                      RO drawer's vendor dropdown.
--
--   · vendor_save                    — quick upsert for inline vendor
--                                      creation from the RO drawer.
--
-- Idempotent: safe to re-run.

-- ── 1. Trigger: mirror operational_status into vehicle_grounding_events ──
create or replace function public._fleet_maintain_grounding_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT' and new.operational_status = 'grounded')
     or (tg_op = 'UPDATE' and old.operational_status is distinct from new.operational_status) then
    if new.operational_status = 'grounded' then
      insert into public.vehicle_grounding_events (dsp_id, vehicle_id, grounded_by, reason)
      select new.dsp_id, new.id, auth.uid(), 'operational_status_change'
      where not exists (
        select 1 from public.vehicle_grounding_events
        where vehicle_id = new.id and ungrounded_at is null
      );
    elsif new.operational_status = 'operational' then
      update public.vehicle_grounding_events
         set ungrounded_at = now(), ungrounded_by = auth.uid()
       where vehicle_id = new.id and ungrounded_at is null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists fleet_maintain_grounding_ins on public.vehicles;
create trigger fleet_maintain_grounding_ins
  after insert on public.vehicles
  for each row execute function public._fleet_maintain_grounding_event();

drop trigger if exists fleet_maintain_grounding_upd on public.vehicles;
create trigger fleet_maintain_grounding_upd
  after update of operational_status on public.vehicles
  for each row execute function public._fleet_maintain_grounding_event();

-- Back-fill: open a grounding event for any vehicle that's already in the
-- grounded state but has no open event (e.g., grounded before 0227 shipped).
insert into public.vehicle_grounding_events (dsp_id, vehicle_id, reason)
select v.dsp_id, v.id, 'backfill_at_migration_0228'
from public.vehicles v
where v.operational_status = 'grounded'
  and not exists (
    select 1 from public.vehicle_grounding_events
    where vehicle_id = v.id and ungrounded_at is null
  );


-- ── 2. RO code generator ────────────────────────────────────────────────
create or replace function public._next_ro_code(p_dsp_id uuid)
returns text
language sql
stable
as $$
  select 'RO-' || to_char(now(),'YYYY') || '-' ||
         lpad(((coalesce(max(substring(code from '\d+$')::int), 0)) + 1)::text, 4, '0')
  from public.repair_orders
  where dsp_id = p_dsp_id
    and code is not null
    and code like 'RO-' || to_char(now(),'YYYY') || '-%';
$$;


-- ── 3. repair_order_open_from_issue ────────────────────────────────────
create or replace function public.repair_order_open_from_issue(
  p_issue_id   uuid,
  p_vendor_id  uuid default null,
  p_summary    text default null
) returns public.repair_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_issue public.vehicle_issues;
  v_ro public.repair_orders;
  v_code text;
begin
  select * into v_issue from public.vehicle_issues
   where id = p_issue_id and dsp_id = v_dsp;
  if not found then
    raise exception 'issue_not_found' using errcode = '42704';
  end if;

  v_code := coalesce(public._next_ro_code(v_dsp), 'RO-' || to_char(now(),'YYYY') || '-0001');

  insert into public.repair_orders
    (dsp_id, vehicle_id, vendor_id, code, summary, status, opened_at, created_by)
  values (
    v_dsp,
    v_issue.vehicle_id,
    p_vendor_id,
    v_code,
    coalesce(nullif(btrim(p_summary), ''), v_issue.title),
    case when p_vendor_id is null then 'draft'::ro_status else 'scheduled'::ro_status end,
    now(),
    auth.uid()
  )
  returning * into v_ro;

  -- Link RO code into the issue + flip to in_repair.
  update public.vehicle_issues
     set status     = 'in_repair',
         work_order = v_ro.code,
         updated_at = now()
   where id = p_issue_id;

  -- Auto-ground the vehicle if it isn't already grounded; the
  -- _fleet_maintain_grounding_event trigger will open a grounding event.
  update public.vehicles
     set operational_status = 'grounded'
   where id = v_issue.vehicle_id
     and dsp_id = v_dsp
     and coalesce(operational_status,'operational') <> 'grounded';

  -- Audit
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'ro_opened',
          'Repair order ' || v_ro.code || ' opened',
          'Issue: ' || v_issue.title,
          'repair_order', v_ro.id);

  return v_ro;
end $$;

grant execute on function public.repair_order_open_from_issue(uuid, uuid, text) to authenticated;


-- ── 4. repair_order_save ────────────────────────────────────────────────
create or replace function public.repair_order_save(
  p_id            uuid,
  p_vendor_id     uuid       default null,
  p_status        ro_status  default null,
  p_summary       text       default null,
  p_scheduled_at  timestamptz default null,
  p_eta_at        timestamptz default null,
  p_completed_at  timestamptz default null,
  p_cost_cents    int        default null
) returns public.repair_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ro public.repair_orders;
begin
  update public.repair_orders set
    vendor_id    = coalesce(p_vendor_id,    vendor_id),
    status       = coalesce(p_status,       status),
    summary      = coalesce(nullif(btrim(p_summary),''), summary),
    scheduled_at = coalesce(p_scheduled_at, scheduled_at),
    eta_at       = coalesce(p_eta_at,       eta_at),
    completed_at = coalesce(p_completed_at, completed_at),
    cost_cents   = coalesce(p_cost_cents,   cost_cents),
    updated_at   = now()
  where id = p_id and dsp_id = v_dsp
  returning * into v_ro;
  if not found then
    raise exception 'ro_not_found' using errcode = '42704';
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'ro_updated',
          'Repair order ' || coalesce(v_ro.code, '(no code)') || ' updated',
          'Status: ' || v_ro.status,
          'repair_order', v_ro.id);

  return v_ro;
end $$;

grant execute on function public.repair_order_save(uuid, uuid, ro_status, text, timestamptz, timestamptz, timestamptz, int) to authenticated;


-- ── 5. repair_order_complete ───────────────────────────────────────────
create or replace function public.repair_order_complete(
  p_id uuid,
  p_cost_cents int default null
) returns public.repair_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ro public.repair_orders;
begin
  update public.repair_orders set
    status       = 'completed',
    completed_at = coalesce(completed_at, now()),
    cost_cents   = coalesce(p_cost_cents, cost_cents),
    updated_at   = now()
  where id = p_id and dsp_id = v_dsp
  returning * into v_ro;
  if not found then
    raise exception 'ro_not_found' using errcode = '42704';
  end if;

  -- Flip the linked issue back to completed if its work_order matches.
  update public.vehicle_issues
     set status = 'completed',
         resolved_at = coalesce(resolved_at, now()),
         updated_at = now()
   where dsp_id = v_dsp
     and vehicle_id = v_ro.vehicle_id
     and work_order = v_ro.code
     and status <> 'completed';

  -- Audit
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'ro_completed',
          'Repair order ' || coalesce(v_ro.code, '(no code)') || ' completed',
          null, 'repair_order', v_ro.id);

  return v_ro;
end $$;

grant execute on function public.repair_order_complete(uuid, int) to authenticated;


-- ── 6. repair_orders_for_vehicle ───────────────────────────────────────
create or replace function public.repair_orders_for_vehicle(p_vehicle_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           ro.id,
    'code',         ro.code,
    'summary',      ro.summary,
    'status',       ro.status,
    'opened_at',    ro.opened_at,
    'scheduled_at', ro.scheduled_at,
    'eta_at',       ro.eta_at,
    'completed_at', ro.completed_at,
    'cost_cents',   ro.cost_cents,
    'vendor_id',    ro.vendor_id,
    'vendor_name',  v.name,
    'vendor_score', v.accountability_score
  ) order by ro.opened_at desc), '[]'::jsonb)
  from public.repair_orders ro
  left join public.vendors v on v.id = ro.vendor_id
  where ro.vehicle_id = p_vehicle_id
    and ro.dsp_id = private.current_dsp_id();
$$;

grant execute on function public.repair_orders_for_vehicle(uuid) to authenticated;


-- ── 7. vendors_for_dsp ─────────────────────────────────────────────────
create or replace function public.vendors_for_dsp()
returns setof public.vendors
language sql
stable
as $$
  select * from public.vendors
   where dsp_id = private.current_dsp_id()
     and paused = false
   order by accountability_score desc nulls last, name asc;
$$;

grant execute on function public.vendors_for_dsp() to authenticated;


-- ── 8. vendor_save ─────────────────────────────────────────────────────
create or replace function public.vendor_save(
  p_id            uuid default null,
  p_name          text default null,
  p_kind          text default 'repair',
  p_contact_phone text default null,
  p_contact_email text default null
) returns public.vendors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vendors;
begin
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.vendors (dsp_id, name, kind, contact_phone, contact_email)
    values (v_dsp, btrim(p_name), coalesce(p_kind,'repair'), p_contact_phone, p_contact_email)
    returning * into v_v;
  else
    update public.vendors set
      name          = coalesce(nullif(btrim(p_name),''), name),
      kind          = coalesce(p_kind, kind),
      contact_phone = coalesce(p_contact_phone, contact_phone),
      contact_email = coalesce(p_contact_email, contact_email),
      updated_at    = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if not found then
      raise exception 'vendor_not_found' using errcode = '42704';
    end if;
  end if;
  return v_v;
end $$;

grant execute on function public.vendor_save(uuid, text, text, text, text) to authenticated;
