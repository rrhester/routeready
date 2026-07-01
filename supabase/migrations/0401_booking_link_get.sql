-- ───────────────────────────────────────────────────────────────────────
-- 0401 · booking_link_get(applicant) — return a candidate's /b/<token>
--        booking link for copy/paste, WITHOUT sending SMS/email or changing
--        the applicant's status.
--
-- The calendar sidebar's "Awaiting scheduling" rows get a copy-link button.
-- This reuses the exact same 'booking' token the native booking page reads
-- (metadata.tokens.booking), minting one only if the applicant doesn't have
-- one yet — so copying never invalidates a link already sent to the candidate.
--
-- Idempotent — safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.booking_link_get(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_app   public.applicants;
  v_token text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_app from public.applicants where id = p_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  v_token := v_app.metadata #>> array['tokens', 'booking'];
  if v_token is null then
    v_token := private.upsert_token(p_id, 'booking');
  end if;

  return jsonb_build_object(
    'token', v_token,
    'link', 'https://gorouteready.com/b/' || v_token
  );
end;
$$;
grant execute on function public.booking_link_get(uuid) to authenticated;
