-- Migration 0180 · Driver-facing onboarding steps
--
-- The driver app's onboarding hub (renderOnboarding) shows the steps the
-- DSP configured in the Onboarding Builder that the driver completes
-- themselves — orientation videos to watch, acknowledgements to confirm.
-- (Document steps surface in the driver's documents list once an
-- envelope is sent; canonical steps — I-9, handbook, background check,
-- etc. — already have their own surfaces.) These two RPCs let the driver
-- app list those steps and mark a video / acknowledgement done, writing
-- through to public.driver_onboarding_state (migration 0179).
--
-- The blueprint (public.onboarding_blueprint, migration 0178) is keyed
-- by dsp_id; like onboarding_blueprint_get() these RPCs fall back to the
-- canonical default when the DSP has no row yet (no lazy seeding from the
-- driver side — a dispatcher's first visit to the Builder seeds it).

create or replace function public.driver_onboarding_steps(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv   public.drivers;
  v_steps jsonb;
  v_state jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select steps into v_steps from public.onboarding_blueprint where dsp_id = v_drv.dsp_id;
  v_steps := coalesce(v_steps, private.onboarding_blueprint_default());

  select steps into v_state from public.driver_onboarding_state where driver_id = v_drv.id;
  v_state := coalesce(v_state, '{}'::jsonb);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'key',       s->>'key',
      'type',      s->>'type',
      'title',     s->>'title',
      'video_url', s->>'video_url',
      'ack_text',  s->>'ack_text',
      'status',    coalesce(v_state #>> array[s->>'key', 'status'], 'not_started'),
      'at',        v_state #>> array[s->>'key', 'at']
    ) order by ord)
    from jsonb_array_elements(v_steps) with ordinality as t(s, ord)
    where coalesce((s->>'enabled')::boolean, false)
      and coalesce(s->>'owner', 'dsp') = 'driver'
      and (s->>'type') in ('video', 'acknowledgement')
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_onboarding_steps(text) to anon, authenticated;

-- Mark one video / acknowledgement step complete for the calling driver.
-- Only enabled, driver-owned, video|acknowledgement steps qualify —
-- everything else (document signing, DSP-recorded tasks, canonical
-- steps) is handled elsewhere.
create or replace function public.driver_onboarding_step_ack(p_token text, p_step_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv  public.drivers;
  v_steps jsonb;
  v_step jsonb;
  v_cur  jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  if coalesce(trim(p_step_key), '') = '' then raise exception 'step_key_required' using errcode = '22023'; end if;

  select steps into v_steps from public.onboarding_blueprint where dsp_id = v_drv.dsp_id;
  v_steps := coalesce(v_steps, private.onboarding_blueprint_default());

  select s into v_step
    from jsonb_array_elements(v_steps) as s
   where s->>'key' = p_step_key
   limit 1;

  if v_step is null
     or not coalesce((v_step->>'enabled')::boolean, false)
     or coalesce(v_step->>'owner', 'dsp') <> 'driver'
     or (v_step->>'type') not in ('video', 'acknowledgement') then
    raise exception 'step_not_actionable' using errcode = '22023';
  end if;

  insert into public.driver_onboarding_state (driver_id, dsp_id)
  values (v_drv.id, v_drv.dsp_id)
  on conflict (driver_id) do nothing;

  select steps into v_cur from public.driver_onboarding_state where driver_id = v_drv.id;
  v_cur := coalesce(v_cur, '{}'::jsonb);

  update public.driver_onboarding_state
     set steps = jsonb_set(v_cur, array[p_step_key], jsonb_build_object('status', 'complete', 'at', now()), true),
         updated_at = now()
   where driver_id = v_drv.id;

  return jsonb_build_object('key', p_step_key, 'status', 'complete', 'at', now());
end;
$$;
grant execute on function public.driver_onboarding_step_ack(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
