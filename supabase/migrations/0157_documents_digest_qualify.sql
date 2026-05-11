-- Migration 0157 · Documents · qualify digest() with the extensions schema
--
-- private.append_document_event and public.verify_envelope_chain compute
-- the hash chain with `digest(prev || payload, 'sha256')`. Both functions
-- are SECURITY DEFINER with `set search_path = ''` (deliberate — keeps a
-- malicious search_path from hijacking unqualified references), but
-- Supabase installs pgcrypto into the `extensions` schema, so an
-- unqualified `digest` doesn't resolve and INSERTs fail with
--
--   function digest(text, unknown) does not exist
--
-- Replace both function bodies with `extensions.digest(...)`. Nothing
-- else changes — same signature, same semantics.

create or replace function private.append_document_event(
  p_envelope_id     uuid,
  p_kind            public.document_event_kind,
  p_actor_kind      text,
  p_actor_user_id   uuid    default null,
  p_actor_driver_id uuid    default null,
  p_actor_email     text    default null,
  p_actor_name      text    default null,
  p_ip              inet    default null,
  p_user_agent      text    default null,
  p_event_data      jsonb   default '{}'::jsonb
) returns public.document_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
  v_payload jsonb;
  v_hash text;
  v_row public.document_events;
begin
  select event_hash into v_prev
    from public.document_events
   where envelope_id = p_envelope_id
   order by id desc
   limit 1;
  if v_prev is null then
    v_prev := repeat('0', 64);
  end if;

  v_payload := jsonb_build_object(
    'envelope_id',     p_envelope_id,
    'kind',            p_kind,
    'actor_kind',      p_actor_kind,
    'actor_user_id',   p_actor_user_id,
    'actor_driver_id', p_actor_driver_id,
    'actor_email',     p_actor_email,
    'actor_name',      p_actor_name,
    'ip',              p_ip::text,
    'user_agent',      p_user_agent,
    'event_data',      coalesce(p_event_data, '{}'::jsonb),
    'at',              to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  v_hash := encode(extensions.digest(v_prev || v_payload::text, 'sha256'), 'hex');

  insert into public.document_events
    (envelope_id, kind, actor_kind, actor_user_id, actor_driver_id,
     actor_email, actor_name, ip, user_agent, event_data,
     prev_event_hash, event_hash)
  values
    (p_envelope_id, p_kind, p_actor_kind, p_actor_user_id, p_actor_driver_id,
     p_actor_email, p_actor_name, p_ip, p_user_agent, coalesce(p_event_data, '{}'::jsonb),
     v_prev, v_hash)
  returning * into v_row;

  return v_row;
end;
$$;


create or replace function public.verify_envelope_chain(p_envelope_id uuid)
returns table (
  id              bigint,
  kind            public.document_event_kind,
  stored_hash     text,
  computed_hash   text,
  ok              boolean,
  created_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prev text := repeat('0', 64);
  v_row public.document_events;
  v_payload jsonb;
  v_computed text;
begin
  if not exists (
    select 1 from public.document_envelopes e
     where e.id = p_envelope_id and e.dsp_id = private.current_dsp_id()
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for v_row in
    select * from public.document_events
     where envelope_id = p_envelope_id
     order by document_events.id
  loop
    v_payload := jsonb_build_object(
      'envelope_id',     v_row.envelope_id,
      'kind',            v_row.kind,
      'actor_kind',      v_row.actor_kind,
      'actor_user_id',   v_row.actor_user_id,
      'actor_driver_id', v_row.actor_driver_id,
      'actor_email',     v_row.actor_email,
      'actor_name',      v_row.actor_name,
      'ip',              v_row.ip::text,
      'user_agent',      v_row.user_agent,
      'event_data',      v_row.event_data,
      'at',              to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
    v_computed := encode(extensions.digest(v_prev || v_payload::text, 'sha256'), 'hex');
    id            := v_row.id;
    kind          := v_row.kind;
    stored_hash   := v_row.event_hash;
    computed_hash := v_computed;
    ok            := (v_computed = v_row.event_hash and v_row.prev_event_hash = v_prev);
    created_at    := v_row.created_at;
    return next;
    v_prev := v_row.event_hash;
  end loop;
end;
$$;


notify pgrst, 'reload schema';
