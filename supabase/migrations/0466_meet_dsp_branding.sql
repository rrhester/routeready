-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0466 · RouteReady Meet — brand invites with the DSP's name
--
-- Operators asked for invites to carry their own brand (e.g. "Ozarks Last
-- Mile") instead of "RouteReady". The email From line is already DSP-
-- branded by send-email (brandedFrom); this brands the two remaining
-- RouteReady-worded surfaces:
--   • meet_invite  — email subject + body lead with the DSP name.
--   • meet_create  — a new room's title defaults to "<DSP> meeting", so the
--                    guest's lobby/room header shows the operator's brand.
-- Both read dsps.name for the room's owning DSP; the "RouteReady" strings
-- remain only as the last-ditch fallback when a DSP somehow has no name.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── meet_create · brand the default room title ──────────────────────────

create or replace function public.meet_create(p_title text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dsp      uuid := private.current_dsp_id();
  v_dsp_name text := (select nullif(btrim(d.name), '') from public.dsps d where d.id = v_dsp);
  v_alphabet text := 'abcdefghjkmnpqrstuvwxyz';
  v_raw      text;
  v_code     text;
  v_row      public.meetings;
  i          int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for i in 1..20 loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * 23)::int, 1), '')
      into v_raw from generate_series(1, 10);
    v_code := substr(v_raw, 1, 3) || '-' || substr(v_raw, 4, 4) || '-' || substr(v_raw, 8, 3);
    begin
      insert into public.meetings (dsp_id, code, title, host_id, host_name)
      values (
        v_dsp,
        v_code,
        -- Explicit title wins; otherwise "<DSP> meeting", e.g.
        -- "Ozarks Last Mile meeting"; RouteReady only if the DSP is nameless.
        coalesce(
          nullif(btrim(p_title), ''),
          v_dsp_name || ' meeting',
          'RouteReady meeting'),
        auth.uid(),
        coalesce(
          (select nullif(btrim(u.full_name), '') from public.app_users u where u.id = auth.uid()),
          v_dsp_name,
          'RouteReady host')
      )
      returning * into v_row;

      return jsonb_build_object(
        'id', v_row.id, 'code', v_row.code, 'title', v_row.title,
        'host_name', v_row.host_name, 'created_at', v_row.created_at);
    exception when unique_violation then
      null; -- astronomically unlikely collision — roll a new code
    end;
  end loop;

  raise exception 'meet_code_exhausted';
end; $$;

grant execute on function public.meet_create(text) to authenticated;

-- ─── meet_invite · brand the email subject + body ────────────────────────

create or replace function public.meet_invite(
  p_code    text,
  p_emails  text[],
  p_message text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_norm    text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row     public.meetings;
  v_brand   text;
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

  -- Brand: the owning DSP's name, e.g. "Ozarks Last Mile". Falls back to the
  -- host's name, then "RouteReady" only if neither is set.
  v_brand := coalesce(
    (select nullif(btrim(d.name), '') from public.dsps d where d.id = v_row.dsp_id),
    nullif(btrim(v_row.host_name), ''),
    'RouteReady');

  -- Short /m/<code> join link on the deployed domain (same shape the
  -- interview-room edge function mints).
  v_url := 'https://gorouteready.com/m/' || v_row.code;

  v_subject := v_brand || ' — you''re invited to a video meeting';

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
      v_brand || ' is inviting you to join a video meeting happening now.' || E'\n\n'
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

-- PostgREST: pick up the changed functions without a restart.
notify pgrst, 'reload schema';
