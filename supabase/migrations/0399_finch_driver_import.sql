-- ───────────────────────────────────────────────────────────────────────
-- 0399 · ADP → RouteReady driver import (simple: active employee → driver)
--   Turns synced ADP employees (public.finch_employees, from 0398) into real
--   public.drivers rows. Deliberately simple:
--     • ACTIVE ADP employees become drivers; terminated/inactive are skipped.
--     • New person  → create a driver in 'onboarding' (never 'active', so they
--       still flow through normal onboarding / I-9 before activation).
--     • Already in RouteReady → linked + contact backfilled, never duplicated
--       (matched by Finch id → phone → email).
--   A reviewable step, not an auto-mutation:
--     finch_import_preview() · read-only counts (what WOULD be created)
--     finch_import_apply()   · the only writer (create + link). Idempotent and
--                              per-row resilient. Dispatcher-gated, DSP-scoped.
-- ───────────────────────────────────────────────────────────────────────

-- Phone on the staging table so we can match (and carry it onto the driver).
alter table public.finch_employees
  add column if not exists phone text;

-- ── Shared matcher: best existing driver for a finch_employees row ──
-- Priority via COALESCE (guaranteed left→right): already-linked (Finch id) →
-- phone (non-terminated) → email (non-terminated). NULL = not in RouteReady.
create or replace function private.finch_match_driver(
  p_dsp uuid, p_finch_id text, p_phone text, p_email text
) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select d.id from public.drivers d
      where d.dsp_id = p_dsp and d.metadata->'finch'->>'individual_id' = p_finch_id
      order by d.created_at asc limit 1),
    (select d.id from public.drivers d
      where d.dsp_id = p_dsp and d.status <> 'terminated'
        and private.normalize_phone(p_phone) is not null
        and d.phone_normalized = private.normalize_phone(p_phone)
      order by d.created_at asc limit 1),
    (select d.id from public.drivers d
      where d.dsp_id = p_dsp and d.status <> 'terminated'
        and nullif(trim(lower(p_email)), '') is not null
        and lower(d.email) = lower(p_email)
      order by d.created_at asc limit 1)
  );
$$;

-- ── Preview · read-only counts ──
create or replace function public.finch_import_preview()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_new int := 0; v_link int := 0; v_term int := 0;
  v_names jsonb := '[]'::jsonb;
  e record; v_match uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  for e in select * from public.finch_employees where dsp_id = v_dsp order by last_name, first_name loop
    if e.is_active is false then v_term := v_term + 1; continue; end if;
    v_match := private.finch_match_driver(v_dsp, e.finch_individual_id, e.phone, e.email);
    if v_match is null then
      v_new := v_new + 1;
      if jsonb_array_length(v_names) < 25 then
        v_names := v_names || to_jsonb(coalesce(nullif(trim(coalesce(e.first_name,'')||' '||coalesce(e.last_name,'')),''), e.email, 'ADP employee'));
      end if;
    else v_link := v_link + 1; end if;
  end loop;
  return jsonb_build_object(
    'summary', jsonb_build_object('create', v_new, 'existing', v_link, 'terminated_skipped', v_term,
                                  'total', v_new + v_link + v_term),
    'sample_new', v_names
  );
end;
$$;
grant execute on function public.finch_import_preview() to authenticated;

-- ── Apply · create + link (the only mutation) ──
create or replace function public.finch_import_apply()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_created int := 0; v_linked int := 0; v_skipped int := 0; v_err int := 0;
  e record; v_match uuid; v_drv_id uuid; v_full text; v_meta jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  for e in select * from public.finch_employees where dsp_id = v_dsp loop
   begin
    -- Only active ADP employees become drivers; skip terminated/inactive.
    if e.is_active is false then v_skipped := v_skipped + 1; continue; end if;

    v_match := private.finch_match_driver(v_dsp, e.finch_individual_id, e.phone, e.email);
    v_meta := jsonb_build_object('finch', jsonb_build_object(
      'individual_id', e.finch_individual_id, 'synced_at', now(),
      'department', e.department, 'title', e.title));

    if v_match is null then
      v_full := coalesce(nullif(trim(coalesce(e.first_name,'')||' '||coalesce(e.last_name,'')),''),
                         e.email, 'ADP employee');
      insert into public.drivers (dsp_id, first_name, last_name, full_name, email, phone, status, hire_date, metadata)
      values (v_dsp, e.first_name, e.last_name, v_full, e.email, e.phone, 'onboarding',
              coalesce(e.start_date, current_date), v_meta)
      returning id into v_drv_id;
      v_created := v_created + 1;
    else
      update public.drivers
         set first_name = coalesce(first_name, e.first_name),
             last_name  = coalesce(last_name, e.last_name),
             email      = coalesce(email, e.email),
             phone      = coalesce(phone, e.phone),
             metadata   = coalesce(metadata,'{}'::jsonb) || v_meta,
             updated_at = now()
       where id = v_match;
      v_linked := v_linked + 1;
    end if;
   exception when others then
     v_err := v_err + 1;
     raise notice 'finch_import_apply: row % skipped: %', e.finch_individual_id, sqlerrm;
   end;
  end loop;

  return jsonb_build_object('created', v_created, 'linked', v_linked, 'skipped', v_skipped, 'errors', v_err);
end;
$$;
grant execute on function public.finch_import_apply() to authenticated;

notify pgrst, 'reload schema';
