-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0192 · Driver-facing onboarding document steps
--
-- Until now public.driver_onboarding_steps only handed the driver app the
-- video / acknowledgement steps the driver completes themselves; the
-- document steps (the canonical handbook / job_offer steps, plus any
-- custom 'document' steps a DSP added in the Onboarding Builder) only
-- surfaced in the driver's Documents list — which is route-locked while
-- the driver is in onboarding, so they couldn't actually reach them.
--
-- This widens driver_onboarding_steps to also return enabled, driver-owned
-- 'document' steps, each carrying the e-signature envelope that satisfies
-- it (signing_token, status, template kind). The driver app then sends the
-- driver straight into the existing review flow: informational documents go
-- to the lighter "review & acknowledge" path, secure ones to the full
-- signing flow — same screens, no extra DSP action. Envelopes are still
-- created by onboarding_doc_envelopes_ensure / documents_envelope_create,
-- and the mirror trigger from migration 0181 flips the step to complete the
-- moment the driver signs.
--
-- Pure widening of one read RPC — same signature, two extra fields
-- (doc_kind, signing_token) that are null for non-document steps.
-- ─────────────────────────────────────────────────────────────────────────

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
      'key',           s->>'key',
      'type',          s->>'type',
      'title',         s->>'title',
      'video_url',     s->>'video_url',
      'ack_text',      s->>'ack_text',
      'doc_kind',      env.kind,
      'signing_token', env.signing_token,
      'env_status',    env.status,
      'status',        case
                         when (v_state #>> array[s->>'key', 'status']) = 'complete' then 'complete'
                         when (s->>'type') = 'document' then coalesce(
                           case env.status
                             when 'signed'   then 'complete'
                             when 'declined' then 'declined'
                             when 'voided'   then 'declined'
                             when 'expired'  then 'declined'
                             when 'viewed'   then 'viewed'
                             when 'sent'     then 'sent'
                             else null
                           end,
                           v_state #>> array[s->>'key', 'status'],
                           'not_started')
                         else coalesce(v_state #>> array[s->>'key', 'status'], 'not_started')
                       end,
      'at',            case when (s->>'type') = 'document'
                            then coalesce(env.signed_at::text, env.declined_at::text, env.viewed_at::text, env.sent_at::text, v_state #>> array[s->>'key', 'at'])
                            else v_state #>> array[s->>'key', 'at']
                       end
    ) order by ord)
    from jsonb_array_elements(v_steps) with ordinality as t(s, ord)
    left join lateral (
      select e.signing_token,
             e.status::text   as status,
             e.sent_at, e.viewed_at, e.signed_at, e.declined_at,
             t2.kind
        from public.document_envelopes e
        join public.document_templates t2 on t2.id = e.template_id
       where (s->>'type') = 'document'
         and e.recipient_driver_id = v_drv.id
         and e.onboarding_step_key = (s->>'key')
       order by e.sent_at desc
       limit 1
    ) env on true
    where coalesce((s->>'enabled')::boolean, false)
      and coalesce(s->>'owner', 'dsp') = 'driver'
      and (s->>'type') in ('video', 'acknowledgement', 'document')
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_onboarding_steps(text) to anon, authenticated;

notify pgrst, 'reload schema';
