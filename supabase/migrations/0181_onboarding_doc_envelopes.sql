-- Migration 0181 · Onboarding document steps ⇄ e-signature envelopes
--
-- When a DSP attaches a document template to an onboarding step in the
-- Builder (canonical 'handbook' / 'job_offer', or a custom 'document'
-- step), RouteReady should generate the e-signature envelope for each
-- onboarding driver automatically — the driver sees it in their PWA
-- documents list, and when they sign, the onboarding step flips to
-- complete on its own. No more manually clicking "Send documents".
--
-- Three pieces:
--   1. document_envelopes.onboarding_step_key — the blueprint step an
--      envelope satisfies (null for ad-hoc / manually-sent docs).
--   2. A trigger that mirrors the envelope's status into the per-driver
--      onboarding state — onboarding_progress for the canonical
--      handbook / job_offer steps, driver_onboarding_state otherwise.
--      Advance-only: it never un-completes a step the operator already
--      marked, and never downgrades a signed step.
--   3. onboarding_doc_envelopes_ensure(p_driver_id) — idempotently
--      creates any missing envelopes for the blueprint's enabled
--      document steps. The dashboard calls this when it loads the
--      onboarding page / a driver record.

-- ── 1. Link column ──
alter table public.document_envelopes
  add column if not exists onboarding_step_key text;

create index if not exists document_envelopes_onb_step_idx
  on public.document_envelopes (recipient_driver_id, onboarding_step_key)
  where onboarding_step_key is not null;

-- ── 2. Status mirror trigger ──
create or replace function private.onboarding_mirror_envelope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key  text        := NEW.onboarding_step_key;
  v_drv  uuid        := NEW.recipient_driver_id;
  v_dsp  uuid        := NEW.dsp_id;
  v_cur  jsonb;
  v_step_status text;
  v_at   timestamptz;
begin
  if v_key is null or v_drv is null then return NEW; end if;

  -- Canonical document steps record in onboarding_progress.
  if v_key in ('handbook', 'job_offer') then
    insert into public.onboarding_progress (driver_id, dsp_id) values (v_drv, v_dsp) on conflict (driver_id) do nothing;
    if v_key = 'handbook' then
      update public.onboarding_progress
         set handbook_sent_at      = coalesce(handbook_sent_at, NEW.sent_at, now()),
             handbook_completed_at  = case when NEW.status = 'signed' then coalesce(handbook_completed_at, NEW.signed_at, now()) else handbook_completed_at end
       where driver_id = v_drv;
    else
      update public.onboarding_progress
         set job_offer_sent_at      = coalesce(job_offer_sent_at, NEW.sent_at, now()),
             job_offer_completed_at  = case when NEW.status = 'signed' then coalesce(job_offer_completed_at, NEW.signed_at, now()) else job_offer_completed_at end
       where driver_id = v_drv;
    end if;
    return NEW;
  end if;

  -- Everything else (custom 'document' steps) records in driver_onboarding_state.
  v_step_status := case NEW.status
    when 'signed'   then 'complete'
    when 'declined' then 'declined'
    when 'viewed'   then 'sent'
    when 'sent'     then 'sent'
    else null   -- voided / expired → leave the step untouched
  end;
  if v_step_status is null then return NEW; end if;

  insert into public.driver_onboarding_state (driver_id, dsp_id) values (v_drv, v_dsp) on conflict (driver_id) do nothing;
  select steps into v_cur from public.driver_onboarding_state where driver_id = v_drv;
  v_cur := coalesce(v_cur, '{}'::jsonb);

  if (v_cur #>> array[v_key, 'status']) = 'complete' then return NEW; end if;                                   -- never downgrade a completed step
  if v_step_status = 'sent' and (v_cur #>> array[v_key, 'status']) in ('sent', 'in_progress', 'awaiting_review') then return NEW; end if;

  v_at := coalesce(NEW.signed_at, NEW.declined_at, NEW.viewed_at, NEW.sent_at, now());
  update public.driver_onboarding_state
     set steps = jsonb_set(v_cur, array[v_key], jsonb_build_object('status', v_step_status, 'at', v_at), true),
         updated_at = now()
   where driver_id = v_drv;
  return NEW;
end;
$$;

drop trigger if exists document_envelopes_onb_mirror on public.document_envelopes;
create trigger document_envelopes_onb_mirror
  after insert or update of status on public.document_envelopes
  for each row when (NEW.onboarding_step_key is not null)
  execute function private.onboarding_mirror_envelope();

-- ── 3. documents_envelope_create gains the step-key arg ──
-- (Drop the 3-arg form first so a named-arg call isn't ambiguous.)
drop function if exists public.documents_envelope_create(uuid, uuid, timestamptz);

create or replace function public.documents_envelope_create(
  p_template_id         uuid,
  p_recipient_driver_id uuid,
  p_expires_at          timestamptz default null,
  p_onboarding_step_key text default null
) returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_tpl public.document_templates;
  v_drv public.drivers;
  v_dsp_row public.dsps;
  v_email text;
  v_name text;
  v_step text := nullif(trim(coalesce(p_onboarding_step_key, '')), '');
  v_env public.document_envelopes;
  v_msg record;
  v_app_url text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_tpl from public.document_templates
    where id = p_template_id and dsp_id = v_dsp;
  if v_tpl.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  if v_tpl.archived_at is not null then raise exception 'template_archived' using errcode = 'P0001'; end if;

  select * into v_drv from public.drivers where id = p_recipient_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  v_email := nullif(trim(coalesce(v_drv.email, '')), '');
  v_name  := coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name);
  if v_email is null then raise exception 'driver_has_no_email' using errcode = 'P0001'; end if;

  insert into public.document_envelopes
    (dsp_id, template_id, sender_user_id,
     recipient_driver_id, recipient_email, recipient_name,
     doc_hash_at_send, fields_snapshot, expires_at, status, onboarding_step_key)
  values
    (v_dsp, v_tpl.id, v_uid,
     v_drv.id, v_email, v_name,
     v_tpl.source_hash, v_tpl.fields, p_expires_at, 'sent', v_step)
  returning * into v_env;

  perform private.append_document_event(
    v_env.id, 'envelope_created', 'dispatcher',
    v_uid, null, null, null, null, null,
    jsonb_build_object(
      'template_id',         v_tpl.id,
      'template_title',      v_tpl.title,
      'source_hash',         v_tpl.source_hash,
      'recipient_driver_id', v_drv.id,
      'recipient_email',     v_email,
      'recipient_name',      v_name,
      'expires_at',          p_expires_at,
      'onboarding_step_key', v_step
    )
  );
  perform private.append_document_event(
    v_env.id, 'sent', 'system',
    null, null, null, null, null, null,
    jsonb_build_object('signing_token_issued', true)
  );

  -- Best-effort notification email. A missing template or render error
  -- shouldn't roll back the envelope creation — the driver still sees
  -- the envelope in their PWA Tasks hub regardless.
  begin
    select * into v_dsp_row from public.dsps where id = v_dsp;
    v_app_url := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com') || '/app/';

    select * into v_msg from private.render_template(
      v_dsp,
      'email'::public.message_channel,
      'documents.envelope_sent',
      jsonb_build_object(
        'first_name',     coalesce(nullif(trim(v_drv.first_name), ''), v_drv.full_name, v_name),
        'dsp_name',       coalesce(v_dsp_row.name, 'Dispatch'),
        'document_title', v_tpl.title,
        'app_url',        v_app_url
      )
    );

    insert into public.email_messages
      (dsp_id, direction, status, to_email, subject, body_text)
    values
      (v_dsp, 'outbound', 'queued', v_email, v_msg.subject, v_msg.body);

    perform private.append_document_event(
      v_env.id, 'reminder_sent', 'system',
      null, null, null, null, null, null,
      jsonb_build_object('channel', 'email', 'kind', 'envelope_sent_notification')
    );
  exception when others then
    raise notice 'documents_envelope_create: notification email skipped (%): %', v_env.id, sqlerrm;
  end;

  return v_env;
end;
$$;
grant execute on function public.documents_envelope_create(uuid, uuid, timestamptz, text) to authenticated;

-- ── 4. Idempotent envelope back-fill for the blueprint's document steps ──
create or replace function public.onboarding_doc_envelopes_ensure(p_driver_id uuid default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_steps jsonb;
  v_step  jsonb;
  v_key   text;
  v_tpl   uuid;
  v_drv   record;
  v_made  int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  select steps into v_steps from public.onboarding_blueprint where dsp_id = v_dsp;
  v_steps := coalesce(v_steps, private.onboarding_blueprint_default());

  for v_step in select value from jsonb_array_elements(v_steps) loop
    continue when coalesce((v_step->>'enabled')::boolean, false) is not true;
    continue when (v_step->>'type') <> 'document';
    begin
      v_tpl := nullif(trim(coalesce(v_step->>'document_template_id', '')), '')::uuid;
    exception when others then
      v_tpl := null;
    end;
    continue when v_tpl is null;
    continue when not exists (select 1 from public.document_templates t where t.id = v_tpl and t.dsp_id = v_dsp and t.archived_at is null);
    v_key := v_step->>'key';
    continue when coalesce(trim(v_key), '') = '';

    for v_drv in
      select d.id from public.drivers d
       where d.dsp_id = v_dsp and d.status = 'onboarding'
         and (p_driver_id is null or d.id = p_driver_id)
    loop
      continue when exists (select 1 from public.document_envelopes e where e.recipient_driver_id = v_drv.id and e.onboarding_step_key = v_key);
      begin
        perform public.documents_envelope_create(v_tpl, v_drv.id, null, v_key);
        v_made := v_made + 1;
      exception when others then
        raise notice 'onboarding_doc_envelopes_ensure: skipped driver % step % (%)', v_drv.id, v_key, sqlerrm;
      end;
    end loop;
  end loop;
  return v_made;
end;
$$;
grant execute on function public.onboarding_doc_envelopes_ensure(uuid) to authenticated;

notify pgrst, 'reload schema';
