-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0464 · RouteReady Meet — email invites for instant meetings
--
-- Adds meet_invite(code, emails, message): the host of a live room (or
-- fellow staff of the owning DSP) queues a branded "join now" email to
-- each address, matching Google Meet's "Add people → Invite → Send email"
-- flow. Rows land in email_messages as status='queued'; the existing
-- pg_net insert trigger + 1-minute drain cron dispatch them via Resend
-- (send-email edge function), so there's no new mail path to maintain.
--
-- The join URL is built SERVER-SIDE from a fixed base — the RPC never
-- puts a caller-supplied link into an outbound email, so this can't be
-- turned into a phishing relay.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.meet_invite(
  p_code    text,
  p_emails  text[],
  p_message text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_norm    text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row     public.meetings;
  v_url     text;
  v_subject text;
  v_note    text := nullif(btrim(coalesce(p_message, '')), '');
  v_body    text;
  v_email   text;
  v_clean   text;
  v_seen    text[] := '{}';
  v_invited int := 0;
  v_skipped int := 0;
begin
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select * into v_row
    from public.meetings m
   where replace(m.code, '-', '') = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Only the room's host (or staff of the owning DSP) may invite — same
  -- gate as meet_end.
  if not (v_row.host_id = auth.uid()
          or private.is_staff(v_row.dsp_id, 'dispatcher')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_row.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'ended');
  end if;

  -- Short /m/<code> join link on the deployed domain (same shape the
  -- interview-room edge function mints).
  v_url := 'https://gorouteready.com/m/' || v_row.code;

  v_subject := coalesce(nullif(btrim(v_row.host_name), ''), 'RouteReady')
               || ' is inviting you to a video meeting';

  foreach v_email in array coalesce(p_emails, '{}') loop
    v_clean := lower(btrim(coalesce(v_email, '')));
    -- Basic address shape + dedupe. A caller could paste anything; skip
    -- what won't route rather than fail the whole batch.
    if v_clean = ''
       or v_clean !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
       or v_clean = any (v_seen) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    -- Cap the fan-out so a single call can't queue a huge blast.
    if array_length(v_seen, 1) >= 25 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_seen := array_append(v_seen, v_clean);

    v_body :=
      coalesce(nullif(btrim(v_row.host_name), ''), 'A RouteReady host')
      || ' is inviting you to join a video meeting happening now.' || E'\n\n'
      || 'Join here:' || E'\n' || v_url || E'\n'
      || case when v_note is not null then E'\n' || v_note || E'\n' else '' end
      || E'\nNo app or download needed — just open the link on your phone or computer.';

    insert into public.email_messages (dsp_id, direction, status, to_email, subject, body_text)
    values (v_row.dsp_id, 'outbound', 'queued', v_clean, v_subject, v_body);

    v_invited := v_invited + 1;
  end loop;

  return jsonb_build_object('ok', true, 'invited', v_invited, 'skipped', v_skipped);
end; $$;

grant execute on function public.meet_invite(text, text[], text) to authenticated;

-- PostgREST: pick up the new function without a restart.
notify pgrst, 'reload schema';
