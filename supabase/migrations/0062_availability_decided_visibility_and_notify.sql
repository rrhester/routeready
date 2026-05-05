-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0062 · Availability request improvements
--
-- 1. availability_request_list now returns ALL requests for the dsp
--    from the last 60 days, not just pending. Decided rows stay
--    visible so the dispatcher has a record.
-- 2. availability_request_decide drops a chat message into
--    driver_messages from sender_kind='dispatch' so the existing push
--    pipeline notifies the driver and the message shows up in their
--    Chat history.
-- ─────────────────────────────────────────────────────────────────────────


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
    -- Pending first (oldest pending up top), then decided rows by
    -- newest decision.
    select jsonb_agg(t order by
      (case when t->>'status' = 'pending' then 0 else 1 end),
      (t->>'submitted_at') asc
    ) from (
      select jsonb_build_object(
        'id',             r.id,
        'driver_id',      r.driver_id,
        'driver_name',    coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'station_code',   s.code,
        'days',           to_jsonb(r.days),
        'current_days',   coalesce(d.metadata -> 'availability' -> 'days', '[]'::jsonb),
        'status',         r.status,
        'submitted_at',   r.submitted_at,
        'decided_at',     r.decided_at,
        'decision_note',  r.decision_note,
        'effective_from', to_jsonb((r.effective_from)::text),
        'effective_until',to_jsonb((r.effective_until)::text)
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


create or replace function public.availability_request_decide(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_req public.driver_availability_requests;
  v_drv public.drivers;
  v_meta jsonb;
  v_eff_from date;
  v_eff_until date;
  v_msg_body text;
  v_dlabel text;
  v_clean_note text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req
    from public.driver_availability_requests
   where id = p_request_id and dsp_id = v_dsp
   for update;
  if v_req.id is null then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request_already_decided' using errcode = 'P0001';
  end if;

  v_clean_note := nullif(trim(coalesce(p_note, '')), '');

  -- Pretty day list for the chat message: "Mon, Tue, Wed".
  select string_agg(initcap(d), ', ' order by array_position(
    array['mon','tue','wed','thu','fri','sat','sun'], d
  )) into v_dlabel from unnest(v_req.days) d;
  if v_dlabel is null or v_dlabel = '' then v_dlabel := '(no days)'; end if;

  if p_approve then
    v_eff_from  := current_date;
    v_eff_until := current_date + 21;

    update public.driver_availability_requests
       set status          = 'approved',
           decided_at      = now(),
           decided_by      = auth.uid(),
           decision_note   = v_clean_note,
           effective_from  = v_eff_from,
           effective_until = v_eff_until
     where id = p_request_id;

    -- Sync the live availability that the auto-assigner reads.
    select * into v_drv from public.drivers where id = v_req.driver_id;
    v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
              || jsonb_build_object(
                'availability',
                jsonb_build_object('days', to_jsonb(v_req.days))
              );
    update public.drivers set metadata = v_meta where id = v_req.driver_id;

    v_msg_body := 'Your availability request has been approved: ' || v_dlabel
                  || '. Effective through '
                  || to_char(v_eff_until, 'Mon DD, YYYY') || '.'
                  || coalesce(' Note: ' || v_clean_note, '');
  else
    update public.driver_availability_requests
       set status        = 'denied',
           decided_at    = now(),
           decided_by    = auth.uid(),
           decision_note = v_clean_note
     where id = p_request_id;

    v_msg_body := 'Your availability request was not approved.'
                  || coalesce(' Reason: ' || v_clean_note, '')
                  || ' Submit a new request from the Availability page.';
  end if;

  -- Drop a dispatch→driver chat message so the existing push pipeline
  -- (trg_driver_messages_fire_push) notifies the driver and the
  -- decision shows up in their Chat history.
  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (v_req.driver_id, v_dsp, 'dispatch', auth.uid(), v_msg_body);

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_req.driver_id, v_dsp, now())
  on conflict (driver_id) do update set last_message_at = now();

  return jsonb_build_object(
    'id',     p_request_id,
    'status', case when p_approve then 'approved' else 'denied' end,
    'effective_from',  case when p_approve then to_jsonb(v_eff_from::text)  else 'null'::jsonb end,
    'effective_until', case when p_approve then to_jsonb(v_eff_until::text) else 'null'::jsonb end
  );
end;
$$;
grant execute on function public.availability_request_decide(uuid, boolean, text) to authenticated;


notify pgrst, 'reload schema';
