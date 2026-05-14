-- Migration 0232 · Van assignments board surfaces operational state read-only.
--
-- The Workspaces → Workflows → Van assignments board's status column
-- becomes a read-only display.  vehicles_list (migration 0186) is
-- extended so the renderer can show:
--
--   · lifecycle status     (active / spare / out_of_service / retired)
--   · operational_status   (operational / grounded)
--   · grounded_since       (when grounded, to show a "Nd" badge)
--
-- The Fleet roster remains the only operator-facing surface that can
-- change either field.  vehicle_upsert was the write path used by this
-- board; this migration removes its status-mutation behavior on UPDATE
-- so even an API client can't flip lifecycle status through this RPC
-- once a van exists.  (Inserts still default to 'active'.)
--
-- Idempotent.

create or replace function public.vehicles_list()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'kind',               vh.kind,
      'status',             vh.status,
      'operational_status', vh.operational_status,
      'grounded_since',     ge.grounded_at,
      'grounded_reason',    ge.reason,
      'notes',              vh.notes,
      'archived_at',        vh.archived_at,
      'drivers', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'driver_id', a.driver_id, 'rank', a.rank,
                 'name', coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver')
               ) order by a.rank)
        from public.vehicle_driver_assignments a
        join public.drivers d on d.id = a.driver_id
        where a.vehicle_id = vh.id
      ), '[]'::jsonb)
    ) v
    from public.vehicles vh
    left join lateral (
      select grounded_at, reason
      from public.vehicle_grounding_events
      where vehicle_id = vh.id and ungrounded_at is null
      order by grounded_at desc
      limit 1
    ) ge on true
    where vh.dsp_id = private.current_dsp_id()
      and private.is_staff(private.current_dsp_id(), 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_list() to authenticated;


-- vehicle_upsert: status/operational_status are owned by the Fleet
-- workspace.  Inserts still pick up p_status default; updates ignore
-- p_status so the Van assignments board can't change it.
create or replace function public.vehicle_upsert(
  p_id     uuid default null,
  p_name   text default null,
  p_kind   text default 'van',
  p_status text default 'active',
  p_notes  text default null
) returns public.vehicles
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vehicles;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if coalesce(p_status, 'active') not in ('active','spare','out_of_service','retired') then
    raise exception 'bad_status' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.vehicles (dsp_id, name, kind, status, notes, created_by)
    values (
      v_dsp, trim(p_name),
      coalesce(nullif(trim(p_kind), ''), 'van'),
      coalesce(p_status, 'active'),
      nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning * into v_v;
  else
    -- status intentionally NOT updated here — the Fleet record drawer is
    -- the only path for lifecycle status changes; the Fleet roster pill
    -- is the only path for operational_status changes.
    update public.vehicles set
      name       = trim(p_name),
      kind       = coalesce(nullif(trim(p_kind), ''), 'van'),
      notes      = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if v_v.id is null then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;
  end if;

  return v_v;
end;
$$;
grant execute on function public.vehicle_upsert(uuid, text, text, text, text) to authenticated;
