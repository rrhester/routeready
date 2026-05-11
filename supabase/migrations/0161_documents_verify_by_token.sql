-- Migration 0161 · Documents · public chain verification by signing token
--
-- Slice 5 ships a public /verify/<signing_token> page. The page (and
-- its backing edge function, document-verify, which runs with the
-- service role) needs to re-walk an envelope's hash chain without a
-- DSP context — verify_envelope_chain() raises 'forbidden' unless the
-- caller's private.current_dsp_id() matches. The signing token itself
-- is the capability here (32 random bytes, unguessable), so we expose
-- a token-keyed variant that skips the DSP check and just returns the
-- boolean "does the chain still verify".

create or replace function public.document_chain_ok_by_token(p_signing_token text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_env_id   uuid;
  v_prev     text := repeat('0', 64);
  v_row      public.document_events;
  v_payload  jsonb;
  v_computed text;
  v_ok       boolean := true;
begin
  select id into v_env_id
    from public.document_envelopes
   where signing_token = p_signing_token;
  if v_env_id is null then return null; end if;  -- unknown token

  for v_row in
    select * from public.document_events
     where envelope_id = v_env_id
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
    if v_computed <> v_row.event_hash or v_row.prev_event_hash <> v_prev then
      v_ok := false;
    end if;
    v_prev := v_row.event_hash;
  end loop;

  return v_ok;
end;
$$;
grant execute on function public.document_chain_ok_by_token(text) to authenticated, anon;

notify pgrst, 'reload schema';
