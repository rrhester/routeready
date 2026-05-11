-- Migration 0178 · Onboarding blueprint — the DSP's configured workflow
--
-- One row per DSP: an ordered list of onboarding steps the DSP has
-- enabled / renamed / configured, within RouteReady's guardrails.
-- RouteReady owns the catalogue of step *types*; the DSP chooses which
-- to use, their order, titles, and whether each is blocking / required.
-- (Document attachment, custom steps, videos, messages, and the
-- per-driver driver_onboarding_state cutover land in later slices —
-- the schema has room for them already: extra keys in each step object.)
--
-- steps jsonb shape (array order = display order):
--   [{ key:      text   -- stable id within this blueprint
--      type:     text   -- catalogue type: welcome | task | background_check
--                       --   drug_test | document | i9 | schedule | video | acknowledgement
--      title:    text   -- DSP-renamable label
--      enabled:  bool
--      blocking: bool    -- blocks activation when incomplete
--      required: bool
--      owner:    'driver' | 'dsp'
--      document_template_id: uuid | null
--      video_url:            text | null
--      ack_text:             text | null
--    }, ...]

create table if not exists public.onboarding_blueprint (
  dsp_id     uuid primary key references public.dsps(id) on delete cascade,
  steps      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.onboarding_blueprint enable row level security;
create policy "onboarding_blueprint_rw" on public.onboarding_blueprint
  for all using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- The canonical default blueprint a new DSP starts from — mirrors the
-- step set the Onboarding dashboard already tracks. `key` values are
-- the stable identifiers the dashboard maps to the underlying
-- per-driver fields (onboarding_progress / drivers / i9_records).
create or replace function private.onboarding_blueprint_default()
returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key','welcome_email',  'type','welcome',          'title','Welcome email',                 'enabled',true,  'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','bg_instructions', 'type','task',             'title','Background-check instructions',  'enabled',true,  'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','bg_check',        'type','background_check',  'title','Background check cleared',      'enabled',true,  'blocking',true,  'required',true,  'owner','dsp'),
    jsonb_build_object('key','drug_info',       'type','task',             'title','Drug-testing information',      'enabled',true,  'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','drug_test',       'type','drug_test',        'title','Drug test cleared',            'enabled',true,  'blocking',true,  'required',true,  'owner','dsp'),
    jsonb_build_object('key','handbook',        'type','document',         'title','Employment handbook',          'enabled',true,  'blocking',true,  'required',true,  'owner','driver', 'document_template_id', null),
    jsonb_build_object('key','i9',              'type','i9',               'title','Form I-9',                     'enabled',true,  'blocking',true,  'required',true,  'owner','driver'),
    jsonb_build_object('key','job_offer',       'type','document',         'title','Job offer',                    'enabled',true,  'blocking',true,  'required',true,  'owner','driver', 'document_template_id', null),
    jsonb_build_object('key','training',        'type','task',             'title','Training',                     'enabled',false, 'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','scheduled',       'type','schedule',         'title','Driver scheduled',             'enabled',true,  'blocking',false, 'required',false, 'owner','dsp')
  );
$$;

-- Fetch the DSP's blueprint, lazily seeding the default on first read.
create or replace function public.onboarding_blueprint_get()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_steps jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select steps into v_steps from public.onboarding_blueprint where dsp_id = v_dsp;
  if v_steps is null then
    insert into public.onboarding_blueprint (dsp_id, steps)
    values (v_dsp, private.onboarding_blueprint_default())
    on conflict (dsp_id) do nothing;
    select steps into v_steps from public.onboarding_blueprint where dsp_id = v_dsp;
  end if;
  return coalesce(v_steps, private.onboarding_blueprint_default());
end;
$$;
grant execute on function public.onboarding_blueprint_get() to authenticated;

-- Replace the DSP's blueprint. The dashboard validates the shape; the
-- DB just stores the array (and re-validates it's an array, not, e.g.,
-- a stray object).
create or replace function public.onboarding_blueprint_set(p_steps jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then raise exception 'steps_must_be_array' using errcode = '22023'; end if;
  insert into public.onboarding_blueprint (dsp_id, steps, updated_at, updated_by)
  values (v_dsp, p_steps, now(), auth.uid())
  on conflict (dsp_id) do update set steps = excluded.steps, updated_at = now(), updated_by = auth.uid();
  return p_steps;
end;
$$;
grant execute on function public.onboarding_blueprint_set(jsonb) to authenticated;

notify pgrst, 'reload schema';
