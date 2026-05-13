-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0194 · Driver app sees the full ordered onboarding list
--
-- The driver app's onboarding hub now runs one strictly-sequential list:
-- Update profile → Upload license → Update availability → then every step
-- in the DSP's blueprint, in the same order the dashboard shows them. So
-- public.driver_onboarding_steps stops filtering to just the driver-owned
-- video / acknowledgement / document steps — it now returns every enabled
-- blueprint step (background check, drug test, Form I-9, the DSP-recorded
-- "sent" steps, documents, acknowledgements, videos), in order, each with
-- the status computed from wherever it actually lives:
--   * background check / drug test  → drivers.{background,drug}_*_completed_at
--   * training                      → drivers.training_date / training_scheduled_at
--   * Form I-9                      → i9_records (section 1 / section 2)
--   * welcome email / bg instr / drug info / scheduled → onboarding_progress
--   * handbook / job offer / custom documents → the e-signature envelope
--     (or onboarding_progress for the canonical ones)
--   * acknowledgements / videos     → driver_onboarding_state
-- Plus owner ('driver' | 'dsp'), so the app knows which steps the driver
-- acts on vs which ones are "your team is handling this."
--
-- Pure widening of one read RPC — same signature.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.driver_onboarding_steps(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv   public.drivers;
  v_steps jsonb;
  v_state jsonb;
  v_prog  public.onboarding_progress;
  v_i9    public.i9_records;
begin
  v_drv := private.driver_validate_token(p_token);

  select steps into v_steps from public.onboarding_blueprint where dsp_id = v_drv.dsp_id;
  v_steps := coalesce(v_steps, private.onboarding_blueprint_default());

  select steps into v_state from public.driver_onboarding_state where driver_id = v_drv.id;
  v_state := coalesce(v_state, '{}'::jsonb);

  select * into v_prog from public.onboarding_progress where driver_id = v_drv.id;
  select * into v_i9   from public.i9_records       where driver_id = v_drv.id;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'key',           s->>'key',
      'type',          s->>'type',
      'title',         s->>'title',
      'owner',         coalesce(s->>'owner', 'dsp'),
      'video_url',     s->>'video_url',
      'ack_text',      s->>'ack_text',
      'doc_kind',      env.kind,
      'signing_token', env.signing_token,
      'status', case (s->>'key')
        when 'bg_check'  then case when v_drv.background_check_completed_at is not null then 'complete' else 'not_started' end
        when 'drug_test' then case when v_drv.drug_test_completed_at is not null then 'complete' else 'not_started' end
        when 'training'  then case
                                when v_drv.training_date is not null and v_drv.training_date <= current_date then 'complete'
                                when v_drv.training_scheduled_at is not null then 'scheduled'
                                else 'not_started' end
        when 'i9'        then case
                                when v_i9.section2_completed_at is not null then 'complete'
                                when v_i9.section1_completed_at is not null then 'awaiting_review'
                                when coalesce(v_i9.status, 'not_started') = 'needs_correction' then 'needs_correction'
                                when v_i9.id is not null and coalesce(v_i9.status, 'not_started') <> 'not_started' then 'in_progress'
                                else 'not_started' end
        when 'welcome_email'   then case when v_prog.welcome_email_sent_at   is not null then 'complete' else 'not_started' end
        when 'bg_instructions' then case when v_prog.bg_instructions_sent_at is not null then 'complete' else 'not_started' end
        when 'drug_info'       then case when v_prog.drug_info_sent_at       is not null then 'complete' else 'not_started' end
        when 'scheduled'       then case when v_prog.scheduled_at            is not null then 'complete' else 'not_started' end
        when 'handbook'  then coalesce(
                                case when v_prog.handbook_completed_at is not null then 'complete' end,
                                case env.status when 'signed' then 'complete' when 'declined' then 'declined' when 'voided' then 'declined' when 'expired' then 'declined' when 'viewed' then 'viewed' when 'sent' then 'sent' else null end,
                                case when v_prog.handbook_sent_at is not null then 'sent' end,
                                'not_started')
        when 'job_offer' then coalesce(
                                case when v_prog.job_offer_completed_at is not null then 'complete' end,
                                case env.status when 'signed' then 'complete' when 'declined' then 'declined' when 'voided' then 'declined' when 'expired' then 'declined' when 'viewed' then 'viewed' when 'sent' then 'sent' else null end,
                                case when v_prog.job_offer_sent_at is not null then 'sent' end,
                                'not_started')
        else case
          when (v_state #>> array[s->>'key', 'status']) = 'complete' then 'complete'
          when (s->>'type') = 'document' then coalesce(
            case env.status when 'signed' then 'complete' when 'declined' then 'declined' when 'voided' then 'declined' when 'expired' then 'declined' when 'viewed' then 'viewed' when 'sent' then 'sent' else null end,
            v_state #>> array[s->>'key', 'status'], 'not_started')
          else coalesce(v_state #>> array[s->>'key', 'status'], 'not_started')
        end
      end,
      'at', case
        when (s->>'type') = 'document' then coalesce(env.signed_at::text, env.declined_at::text, env.viewed_at::text, env.sent_at::text, v_state #>> array[s->>'key', 'at'])
        when (s->>'key') = 'i9'        then coalesce(v_i9.section2_completed_at::text, v_i9.section1_completed_at::text)
        when (s->>'key') = 'bg_check'  then v_drv.background_check_completed_at::text
        when (s->>'key') = 'drug_test' then v_drv.drug_test_completed_at::text
        when (s->>'key') = 'training'  then coalesce((v_drv.training_date)::text, v_drv.training_scheduled_at::text)
        else v_state #>> array[s->>'key', 'at']
      end
    ) order by ord)
    from jsonb_array_elements(v_steps) with ordinality as t(s, ord)
    left join lateral (
      select e.signing_token,
             e.status::text   as status,
             e.sent_at, e.viewed_at, e.signed_at, e.declined_at,
             tpl.kind
        from public.document_envelopes e
        join public.document_templates tpl on tpl.id = e.template_id
       where (s->>'type') = 'document'
         and e.recipient_driver_id = v_drv.id
         and e.onboarding_step_key = (s->>'key')
       order by e.sent_at desc
       limit 1
    ) env on true
    where coalesce((s->>'enabled')::boolean, false)
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_onboarding_steps(text) to anon, authenticated;

notify pgrst, 'reload schema';
