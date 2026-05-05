-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0060 · Simplify driver availability
--
-- Drop "preferred days" and "notes" — the driver UX is now a single
-- yes/no toggle per day. The RPCs from 0059 are reshaped to match:
--
--   driver_get_availability(token)        → {days: ['mon',...]}
--   driver_set_availability(token, days)  → {days}
--
-- Existing rows that have `preferred`/`notes` keep them in metadata for
-- now (no destructive cleanup) — they're just ignored by both UIs.
-- ─────────────────────────────────────────────────────────────────────────


-- Drop the old wider signature so it can't be called with stale args.
drop function if exists public.driver_set_availability(text, text[], text[], text);


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
    'days', coalesce(v_avail -> 'days', '[]'::jsonb)
  );
end;
$$;
grant execute on function public.driver_get_availability(text) to anon, authenticated;


create or replace function public.driver_set_availability(
  p_token text,
  p_days  text[]
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
  v_meta       jsonb;
  v_avail      jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Filter to canonical keys, dedupe, preserve canonical order.
  with d as (
    select unnest(coalesce(p_days, '{}'::text[])) k
  )
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days
   from (select distinct k from d where k = any(v_valid_keys)) x;

  v_avail := jsonb_build_object('days', to_jsonb(coalesce(v_days, '{}'::text[])));

  -- Preserve any other metadata keys; replace just availability.
  v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
            || jsonb_build_object('availability', v_avail);

  update public.drivers
     set metadata = v_meta
   where id = v_drv.id;

  return v_avail;
end;
$$;
grant execute on function public.driver_set_availability(text, text[]) to anon, authenticated;


notify pgrst, 'reload schema';
