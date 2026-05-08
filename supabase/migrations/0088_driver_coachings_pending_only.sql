-- 0088_driver_coachings_pending_only.sql
--
-- Drivers should only see coachings they still need to act on.
-- Once they tap through and acknowledge / sign / dismiss, the
-- coaching disappears from their view permanently.  The dispatcher
-- still has full history (different queries, RLS-gated direct
-- selects on the coachings table).
--
-- Two changes:
--   1. driver_list_coachings filters acknowledged_at IS NULL so
--      acked rows never reach the driver app — even if they
--      remember a coaching ID and try to navigate back.
--   2. driver_ack_coaching stamps acknowledged_at when delivery
--      requirement is 'none' so a "Got it" tap on a read-only
--      coaching also clears it from the feed.

create or replace function public.driver_list_coachings(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                c.id,
    'occurred_at',       c.occurred_at,
    'topic',             c.topic,
    'severity',          c.severity,
    'summary',           c.summary,
    'notes',             c.notes,
    'coached_by_name',   c.coached_by_name,
    'delivery_required', c.delivery_required,
    'acknowledged_at',   c.acknowledged_at,
    'signed_at',         c.signed_at
  ) order by c.occurred_at desc), '[]'::jsonb)
    into v_rows
  from public.coachings c
  where c.driver_id    = v_drv.id
    and c.driver_visible = true
    and c.archived_at  is null
    and c.acknowledged_at is null;  -- pending only

  return v_rows;
end;
$$;
grant execute on function public.driver_list_coachings(text) to anon, authenticated;


-- driver_ack_coaching · also handle delivery_required = 'none'
create or replace function public.driver_ack_coaching(
  p_token         text,
  p_coaching_id   uuid,
  p_signature_b64 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.coachings;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_row from public.coachings
   where id = p_coaching_id and driver_id = v_drv.id;
  if v_row.id is null then raise exception 'coaching_not_found' using errcode = 'P0001'; end if;

  -- 'none' delivery still gets a stamped acknowledged_at when the
  -- driver actively dismisses it ("Got it" tap).  This is what
  -- removes the coaching from their feed permanently.
  if v_row.delivery_required = 'none' then
    update public.coachings
       set acknowledged_at = coalesce(acknowledged_at, now())
     where id = p_coaching_id;
  end if;
  if v_row.delivery_required in ('ack','ack_and_sign') then
    update public.coachings
       set acknowledged_at = coalesce(acknowledged_at, now())
     where id = p_coaching_id;
  end if;
  if v_row.delivery_required in ('sign','ack_and_sign') then
    if p_signature_b64 is null or p_signature_b64 = '' then
      raise exception 'signature_required' using errcode = '22023';
    end if;
    update public.coachings
       set ack_signature_b64 = p_signature_b64,
           signed_at         = coalesce(signed_at, now()),
           acknowledged_at   = coalesce(acknowledged_at, now())
     where id = p_coaching_id;
  end if;

  select * into v_row from public.coachings where id = p_coaching_id;
  return jsonb_build_object(
    'id',              v_row.id,
    'acknowledged_at', v_row.acknowledged_at,
    'signed_at',       v_row.signed_at
  );
end;
$$;
grant execute on function public.driver_ack_coaching(text, uuid, text) to anon, authenticated;


notify pgrst, 'reload schema';
