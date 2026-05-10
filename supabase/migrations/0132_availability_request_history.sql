-- Add per-driver request history context to availability_request_list,
-- so the dispatcher can see at a glance how often a driver changes
-- their availability and when they last did it.
--
-- New fields on each returned row:
--   request_count    int       — total availability requests this
--                                driver has ever submitted (any status)
--   prev_submitted_at timestamptz — submitted_at of the driver's
--                                PREVIOUS request (the one before this
--                                row), null if this is their first.
--                                Lets the UI show "last change M ago".
--   last_decided_at  timestamptz — when their most recent DECIDED
--                                request (other than this row) was
--                                decided; null if none.
--
-- Pure additive change — existing fields and ordering unchanged.

create or replace function public.availability_request_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(t order by
      (case when t->>'status' = 'pending' then 0 else 1 end),
      (t->>'submitted_at') asc
    ) from (
      select jsonb_build_object(
        'id',              r.id,
        'driver_id',       r.driver_id,
        'driver_name',     coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'station_code',    s.code,
        'days',            to_jsonb(r.days),
        'current_days',    coalesce(d.metadata -> 'availability' -> 'days', '[]'::jsonb),
        'status',          r.status,
        'submitted_at',    r.submitted_at,
        'decided_at',      r.decided_at,
        'decision_note',   r.decision_note,
        'effective_from',  to_jsonb((r.effective_from)::text),
        'effective_until', to_jsonb((r.effective_until)::text),
        -- ── history context ──
        'request_count',   (
          select count(*)::int
            from public.driver_availability_requests rc
           where rc.driver_id = r.driver_id
        ),
        'prev_submitted_at', (
          select rp.submitted_at
            from public.driver_availability_requests rp
           where rp.driver_id = r.driver_id
             and rp.submitted_at < r.submitted_at
           order by rp.submitted_at desc
           limit 1
        ),
        'last_decided_at', (
          select rd.decided_at
            from public.driver_availability_requests rd
           where rd.driver_id = r.driver_id
             and rd.id <> r.id
             and rd.decided_at is not null
           order by rd.decided_at desc
           limit 1
        )
      ) as t
      from public.driver_availability_requests r
      join public.drivers d on d.id = r.driver_id
      left join public.stations s on s.id = d.station_id
      where r.dsp_id = v_dsp
        and (r.status = 'pending' or r.decided_at > now() - interval '60 days')
    ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.availability_request_list() to authenticated;


-- A focused history RPC: every request a single driver has ever
-- submitted, newest first.  Powers the "view all N requests" drill-
-- down on a row.
create or replace function public.availability_request_history(p_driver_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',              r.id,
      'days',            to_jsonb(r.days),
      'status',          r.status,
      'submitted_at',    r.submitted_at,
      'decided_at',      r.decided_at,
      'decision_note',   r.decision_note,
      'effective_from',  to_jsonb((r.effective_from)::text),
      'effective_until', to_jsonb((r.effective_until)::text)
    ) order by r.submitted_at desc)
    from public.driver_availability_requests r
    where r.driver_id = p_driver_id and r.dsp_id = v_dsp
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.availability_request_history(uuid) to authenticated;

notify pgrst, 'reload schema';
