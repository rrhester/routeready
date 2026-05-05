-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0059 · Driver self-service availability
--
-- Driver PWA reads/writes its own availability without going through
-- dispatcher staff. Same shape as drivers.metadata.availability that
-- the dispatcher already writes (see live.js renderAvailabilityTab):
--
--   {
--     days:      ['mon','tue','wed','thu','fri','sat','sun'],
--     preferred: ['mon','tue','wed','thu','fri','sat','sun'],
--     notes:     'free-form'
--   }
--
-- Surface:
--   driver_get_availability(token)                 → {days, preferred, notes}
--   driver_set_availability(token, days, preferred, notes) → void
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. driver_get_availability ──
create or replace function public.driver_get_availability(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_avail jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  v_avail := coalesce(v_drv.metadata -> 'availability', '{}'::jsonb);
  return jsonb_build_object(
    'days',      coalesce(v_avail -> 'days',      '[]'::jsonb),
    'preferred', coalesce(v_avail -> 'preferred', '[]'::jsonb),
    'notes',     coalesce(v_avail ->> 'notes', '')
  );
end;
$$;
grant execute on function public.driver_get_availability(text) to anon, authenticated;


-- ── 2. driver_set_availability ──
-- Days/preferred are validated against the canonical 7-day set; anything
-- else is silently dropped. notes is trimmed to 500 chars.
create or replace function public.driver_set_availability(
  p_token     text,
  p_days      text[],
  p_preferred text[],
  p_notes     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_valid_keys text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days       text[];
  v_pref       text[];
  v_notes      text;
  v_meta       jsonb;
  v_avail      jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Filter to canonical day keys, dedupe, preserve canonical order.
  with d as (
    select unnest(coalesce(p_days, '{}'::text[])) k
  )
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days
   from (select distinct k from d where k = any(v_valid_keys)) x;

  with p as (
    select unnest(coalesce(p_preferred, '{}'::text[])) k
  )
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_pref
   from (select distinct k from p where k = any(v_valid_keys)) x;

  -- Preferred days must also be available — quietly intersect.
  if v_days is not null and v_pref is not null then
    select array_agg(k order by array_position(v_valid_keys, k))
      into v_pref
     from unnest(v_pref) k
     where k = any(v_days);
  end if;

  v_notes := substring(coalesce(p_notes, ''), 1, 500);

  v_avail := jsonb_build_object(
    'days',      to_jsonb(coalesce(v_days, '{}'::text[])),
    'preferred', to_jsonb(coalesce(v_pref, '{}'::text[])),
    'notes',     v_notes
  );

  v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
            || jsonb_build_object('availability', v_avail);

  update public.drivers
     set metadata = v_meta
   where id = v_drv.id;

  return v_avail;
end;
$$;
grant execute on function public.driver_set_availability(text, text[], text[], text) to anon, authenticated;


notify pgrst, 'reload schema';
