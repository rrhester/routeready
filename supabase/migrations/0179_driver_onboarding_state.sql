-- Migration 0179 · Per-driver onboarding state — progress against the blueprint
--
-- One row per driver: a map of step-key → state object. This is the
-- place the Onboarding Builder's custom / document-attached / video /
-- acknowledgement steps record their per-driver progress. The canonical
-- steps still record where they always have for now (onboarding_progress
-- / drivers / i9_records); the dashboard merges both. A later pass folds
-- the canonical steps in here too.
--
-- steps jsonb shape:
--   { "<step_key>": { status: 'not_started' | 'in_progress' | 'sent'
--                             | 'awaiting_review' | 'complete' | 'declined',
--                     at: timestamptz   -- of the last status change
--                   }, ... }
--   A 'not_started' step is simply absent from the map.

create table if not exists public.driver_onboarding_state (
  driver_id  uuid primary key references public.drivers(id) on delete cascade,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  steps      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists driver_onboarding_state_dsp_idx on public.driver_onboarding_state (dsp_id);

alter table public.driver_onboarding_state enable row level security;
create policy "driver_onboarding_state_rw" on public.driver_onboarding_state
  for all using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- Set one step's status. p_status NULL or 'not_started' clears the step
-- (removes it from the map). Any other status sets { status, at: now() }.
create or replace function public.driver_onboarding_step_set(p_driver_id uuid, p_step_key text, p_status text)
returns public.driver_onboarding_state
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_status text := nullif(trim(coalesce(p_status, '')), '');
  v_cur jsonb;
  v_row public.driver_onboarding_state;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_step_key), '') = '' then raise exception 'step_key_required' using errcode = '22023'; end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_status is null then v_status := 'not_started'; end if;
  if v_status not in ('not_started', 'in_progress', 'sent', 'awaiting_review', 'complete', 'declined') then
    raise exception 'bad_status' using errcode = '22023';
  end if;

  insert into public.driver_onboarding_state (driver_id, dsp_id)
  values (p_driver_id, v_dsp)
  on conflict (driver_id) do nothing;

  select steps into v_cur from public.driver_onboarding_state where driver_id = p_driver_id;
  v_cur := coalesce(v_cur, '{}'::jsonb);

  update public.driver_onboarding_state
     set steps = case when v_status = 'not_started'
                   then v_cur - p_step_key
                   else jsonb_set(v_cur, array[p_step_key], jsonb_build_object('status', v_status, 'at', now()), true)
                 end,
         updated_at = now()
   where driver_id = p_driver_id
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.driver_onboarding_step_set(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
