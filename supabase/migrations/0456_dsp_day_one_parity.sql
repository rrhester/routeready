-- 0456_dsp_day_one_parity.sql
--
-- A brand-new DSP gets the exact same functional surface as a long-lived one
-- the moment its dsps row exists. Operator request: "I want new DSPs to have
-- the exact same function that I have the moment they create an account."
--
-- An audit of 0001–0455 found that new DSPs are already covered for
-- service_types (trigger, 0349), fb_folders + slug (triggers, 0318), the
-- starter notebook (trigger, 0455), and lazily-created onboarding_blueprint
-- (0178) / interview_config (0369+). Three things were still missing:
--
--   1. compliance_monitors — the 12 canonical monitors (0227) were backfilled
--      once for the DSPs that existed then; every DSP created since starts
--      with an empty Compliance workspace.
--   2. attendance policy blocks — the default policy (0086) was a one-time
--      backfill into dsps.metadata. Worse, 0086 wrote through
--      jsonb_set(…, '{attendance,policy,blocks}', …), which silently no-ops
--      when the intermediate 'attendance' key is absent — so even some DSPs
--      alive at 0086 never actually received blocks.
--   3. screening_questions + message_templates — copied from the template DSP
--      (the platform admin's) only inside admin_create_dsp (0141); a dsps row
--      created any other way skips both.
--
-- One consolidated seeder + one after-insert trigger closes all three for
-- every future DSP however it's created, and a guarded backfill brings every
-- existing DSP up to parity. Each piece seeds only when the DSP has nothing
-- there yet, so re-runs never clobber an operator's tuned monitors, policy,
-- questions, or templates. admin_create_dsp is re-issued without its inline
-- copy step: the trigger now covers it, and screening_questions has no
-- natural unique key, so letting both run would duplicate every question.
--
-- Idempotent throughout (create or replace / drop trigger if exists /
-- has-rows guards), like 0451–0455.

-- ── 1. default attendance policy blocks ─────────────────────────────────────
-- Same translation as the 0086 backfill (window / event / four ladder rungs /
-- optional auto-escalations, reading any legacy policy fields with the same
-- defaults), but building the attendance→policy path explicitly so the write
-- lands even when metadata is empty.
create or replace function private.dsp_seed_attendance_policy(p_dsp_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_meta     jsonb;
  v_policy   jsonb;
  v_blocks   jsonb := '[]'::jsonb;
  v_decay    int;
  v_warn     int;
  v_count_t  bool;
  v_count_c  bool;
  v_count_n  bool;
  v_ncns     bool;
  v_first30  bool;
  v_first30d int;
begin
  select coalesce(metadata, '{}'::jsonb) into v_meta from public.dsps where id = p_dsp_id;
  if v_meta is null then return; end if;               -- no such dsp
  v_policy := coalesce(v_meta->'attendance'->'policy', '{}'::jsonb);

  -- already has a block-based policy → leave it alone
  if jsonb_typeof(v_policy->'blocks') = 'array' then return; end if;

  v_decay    := coalesce((v_policy->>'decay_days')::int, 90);
  v_warn     := coalesce((v_policy->>'threshold_warn')::int, 3);
  v_count_t  := coalesce((v_policy->>'count_tardy')::bool, false);
  v_count_c  := coalesce((v_policy->>'count_callout')::bool, true);
  v_count_n  := coalesce((v_policy->>'count_noshow')::bool, true);
  v_ncns     := coalesce((v_policy->>'ncns_terminates')::bool, false);
  v_first30  := coalesce((v_policy->>'first_30_strict')::bool, false);
  v_first30d := coalesce((v_policy->>'first_30_window_days')::int, 30);

  v_blocks := jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text, 'type', 'window', 'days', v_decay));
  if v_count_c then
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'type', 'event', 'kind', 'callout', 'points', 1));
  end if;
  if v_count_n then
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'type', 'event', 'kind', 'no_show', 'points', 1));
  end if;
  if v_count_t then
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'type', 'event', 'kind', 'late', 'points', 1));
  end if;
  v_blocks := v_blocks || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'type', 'ladder_rung',
      'severity', 'verbal',      'threshold', v_warn,
      'delivery', coalesce(v_policy->>'delivery_verbal', 'ack'),
      'auto_fire', coalesce((v_policy->>'auto_verbal')::bool, false)),
    jsonb_build_object('id', gen_random_uuid()::text, 'type', 'ladder_rung',
      'severity', 'written',     'threshold', v_warn + 1,
      'delivery', coalesce(v_policy->>'delivery_written', 'ack_and_sign'),
      'auto_fire', coalesce((v_policy->>'auto_written')::bool, false)),
    jsonb_build_object('id', gen_random_uuid()::text, 'type', 'ladder_rung',
      'severity', 'final',       'threshold', v_warn + 2,
      'delivery', coalesce(v_policy->>'delivery_final', 'ack_and_sign'),
      'auto_fire', coalesce((v_policy->>'auto_final')::bool, false)),
    jsonb_build_object('id', gen_random_uuid()::text, 'type', 'ladder_rung',
      'severity', 'termination', 'threshold', v_warn + 3,
      'delivery', coalesce(v_policy->>'delivery_termination', 'ack_and_sign'),
      'auto_fire', false));
  if v_ncns then
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'type', 'auto_escalation', 'kind', 'ncns_terminates'));
  end if;
  if v_first30 then
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'type', 'auto_escalation', 'kind', 'first_30_strict',
      'days', v_first30d));
  end if;

  -- build each intermediate object so jsonb_set can't silently no-op (0086's bug)
  update public.dsps
     set metadata = jsonb_set(
           jsonb_set(
             jsonb_set(coalesce(metadata, '{}'::jsonb),
               '{attendance}', coalesce(metadata->'attendance', '{}'::jsonb), true),
             '{attendance,policy}',
             coalesce(metadata->'attendance'->'policy', '{}'::jsonb), true),
           '{attendance,policy,blocks}', v_blocks, true)
   where id = p_dsp_id;
end; $$;

-- ── 2. template config: screening questions + hiring message templates ──────
-- Copies from private.template_dsp_id() (the platform admin's DSP, else DEMO),
-- exactly like admin_create_dsp did since 0141 — but only into a DSP that has
-- ZERO rows in the given table, so it can never overwrite or top-up a tenant
-- that has configured (or deliberately emptied) its own funnel.
create or replace function private.dsp_seed_from_template(p_dsp_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tmpl uuid := private.template_dsp_id();
begin
  if v_tmpl is null or v_tmpl = p_dsp_id then return; end if;

  if not exists (select 1 from public.screening_questions where dsp_id = p_dsp_id) then
    insert into public.screening_questions
      (dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active)
    select p_dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active
      from public.screening_questions where dsp_id = v_tmpl;
  end if;

  if not exists (select 1 from public.message_templates where dsp_id = p_dsp_id) then
    insert into public.message_templates
      (dsp_id, channel, key, name, subject, body, active)
    select p_dsp_id, channel, key, name, subject, body, active
      from public.message_templates where dsp_id = v_tmpl
    on conflict (dsp_id, channel, key) do nothing;
  end if;
end; $$;

-- ── 3. the consolidated day-one seeder ───────────────────────────────────────
-- service_types / fb_folders / starter notebook keep their own triggers
-- (0349 / 0318 / 0455); this covers everything the audit found missing.
create or replace function private.dsp_seed_day_one(p_dsp_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- canonical compliance monitors (0227) — only when the DSP has none, so a
  -- re-run never resets monitors an operator has tuned
  if not exists (select 1 from public.compliance_monitors where dsp_id = p_dsp_id) then
    perform public.compliance_seed_monitors(p_dsp_id);
  end if;
  perform private.dsp_seed_attendance_policy(p_dsp_id);
  perform private.dsp_seed_from_template(p_dsp_id);
end; $$;

-- ── 4. backfill: bring every existing DSP up to day-one parity ───────────────
do $$
declare d record;
begin
  for d in select id from public.dsps loop
    perform private.dsp_seed_day_one(d.id);
  end loop;
end $$;

-- ── 5. future DSPs: seed at provisioning time, however the row is created ────
create or replace function private.tg_dsp_seed_day_one()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- defaults are a nicety — they must never block DSP provisioning
  begin
    perform private.dsp_seed_day_one(NEW.id);
  exception when others then null;
  end;
  return NEW;
end; $$;

drop trigger if exists trg_dsp_seed_day_one on public.dsps;
create trigger trg_dsp_seed_day_one
  after insert on public.dsps
  for each row execute function private.tg_dsp_seed_day_one();

-- ── 6. admin_create_dsp: drop the inline copy step ───────────────────────────
-- The trg_dsp_seed_day_one trigger now seeds template config during the
-- insert itself. screening_questions has no unique key, so keeping the inline
-- copy as well would double every question. Otherwise identical to 0141.
create or replace function public.admin_create_dsp(
  p_name              text,
  p_short_code        text    default null,
  p_owner_email       text    default null,
  p_owner_name        text    default null,
  p_phone             text    default null,
  p_address           text    default null,
  p_subscription_plan text    default 'starter',
  p_notes             text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_code text;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;
  if p_subscription_plan not in ('starter', 'growth', 'enterprise') then
    raise exception 'invalid subscription_plan: %', p_subscription_plan;
  end if;

  v_code := upper(coalesce(nullif(trim(p_short_code), ''), ''));
  if v_code = '' then
    v_code := private.dsp_unique_short_code(p_name);
  end if;

  -- day-one defaults (service types, folders, notebook, compliance monitors,
  -- attendance policy, template screening Qs + message templates) are seeded
  -- by the after-insert triggers on public.dsps
  insert into public.dsps (name, short_code, status, subscription_plan, phone, address, notes)
    values (p_name, v_code, 'pending', p_subscription_plan, p_phone, p_address, p_notes)
    returning id into v_id;

  if p_owner_email is not null and p_owner_email <> '' then
    update public.dsps
       set metadata = metadata || jsonb_build_object(
                        'pending_owner', jsonb_build_object(
                          'email',     p_owner_email,
                          'full_name', coalesce(p_owner_name, '')
                        )
                      )
     where id = v_id;
  end if;

  return v_id;
end;
$$;
grant execute on function public.admin_create_dsp(text, text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
