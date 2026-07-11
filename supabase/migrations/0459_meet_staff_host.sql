-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0459 · RouteReady Meet — staff get host controls
--
-- Interviews now mint first-party Meet rooms from the interview-room edge
-- function (system-minted: host_id is null, no single human host). The
-- "End meeting for everyone" button keys off meet_lookup's is_host flag,
-- which previously required host_id = auth.uid() — nobody saw it in a
-- system-minted room. Any signed-in staff member of the owning DSP already
-- HAS end rights server-side (meet_end checks is_staff); this makes
-- meet_lookup report the same truth so the button appears for them.
-- Anon guests (applicants) keep is_host = false.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.meet_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row  public.meetings;
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

  return jsonb_build_object(
    'ok', true,
    'code', v_row.code,
    'title', v_row.title,
    'host_name', v_row.host_name,
    'created_at', v_row.created_at,
    'ended', v_row.ended_at is not null,
    -- Mirrors meet_end's authorization exactly: the personal host OR any
    -- staff of the owning DSP. Guests (anon) get false.
    'is_host', coalesce(v_row.host_id = auth.uid(), false)
               or private.is_staff(v_row.dsp_id, 'dispatcher'));
end; $$;

grant execute on function public.meet_lookup(text) to anon, authenticated;

-- PostgREST: pick up the changed function without a restart.
notify pgrst, 'reload schema';
