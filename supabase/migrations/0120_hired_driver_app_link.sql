-- When an applicant is marked Hired, the message they receive should
-- get them onto the RouteReady driver app on their first day.  Right
-- now the hired SMS just says "we'll be in touch with onboarding
-- details" — no link, no code, no path forward.
--
-- This migration:
--
-- 1. Auto-issues a driver_invite_code at hire time, alongside the
--    drivers row that record_outcome already creates.
--
-- 2. Updates queue_outcome_message to:
--    a. Look up the freshly-created driver row.
--    b. Mint an invite code for that driver inline (re-using the
--       same alphabet + uniqueness loop as public.issue_driver_invite,
--       which we can't call cleanly from inside a security-definer
--       function without re-checking the staff predicate that
--       record_outcome already enforced).
--    c. Pass {{invite_code}}, {{app_url}}, and {{app_login_url}} into
--       render_template so the templates can drop them in.
--
-- 3. Rewrites the applicant.outcome_hired SMS + email templates to
--    include the personal code, the deep-link URL (?code=… so the
--    app can pre-fill), and short iOS/Android install instructions.
--
-- The {{invite_code}} / {{app_url}} / {{app_login_url}} placeholders
-- are no-ops in any other template that doesn't reference them, so
-- existing copy is unaffected.

create or replace function private.queue_outcome_message(
  p_applicant_id uuid, p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app            public.applicants;
  v_dsp            public.dsps;
  v_key            text;
  v_msg            record;
  v_driver_id      uuid;
  v_invite_code    text;
  v_alphabet       text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_collision      boolean;
  v_attempts       int := 0;
  v_base_url       text;
  v_app_url        text := '';
  v_app_login_url  text := '';
begin
  select * into v_app from public.applicants where id = p_applicant_id;
  if v_app.id is null then return; end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  v_base_url := coalesce(v_dsp.metadata->>'public_base_url', 'https://gorouteready.com');

  -- Honor the no_show opt-in.
  if p_outcome = 'no_show'
     and not coalesce((v_dsp.metadata->'outcomes'->>'send_no_show')::boolean, false) then
    return;
  end if;

  -- For hired applicants, mint a driver_invite_code so the message can
  -- carry a one-tap deep-link to the driver app.
  if p_outcome = 'hired' then
    select id into v_driver_id
      from public.drivers
     where applicant_id = v_app.id and dsp_id = v_app.dsp_id
     limit 1;

    if v_driver_id is not null then
      -- Generate a unique 8-char code from the unambiguous alphabet
      -- (matches public.issue_driver_invite). Capped at 8 attempts so
      -- a wedge in the alphabet/length never blocks the message.
      loop
        v_invite_code := '';
        for i in 1..8 loop
          v_invite_code := v_invite_code
            || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
        end loop;
        select exists(
          select 1 from public.driver_invite_codes where code = v_invite_code
        ) into v_collision;
        v_attempts := v_attempts + 1;
        exit when not v_collision or v_attempts > 8;
      end loop;

      if not v_collision then
        -- Revoke any prior un-consumed code (one active at a time).
        update public.driver_invite_codes
           set expires_at = now()
         where driver_id = v_driver_id
           and consumed_at is null
           and expires_at > now();

        insert into public.driver_invite_codes
          (code, dsp_id, driver_id, created_by)
        values
          (v_invite_code, v_app.dsp_id, v_driver_id, auth.uid());
      else
        v_invite_code := null;
      end if;

      v_app_url := v_base_url || '/app/';
      if v_invite_code is not null then
        v_app_login_url := v_app_url || '?code=' || v_invite_code;
      else
        v_app_login_url := v_app_url;
      end if;
    end if;
  end if;

  v_key := 'applicant.outcome_' || p_outcome;

  if v_app.phone is not null then
    -- SMS path.
    select * into v_msg from private.render_template(
      v_app.dsp_id, 'sms', v_key,
      jsonb_build_object(
        'first_name',     coalesce(v_app.first_name, v_app.full_name),
        'invite_code',    coalesce(v_invite_code, ''),
        'app_url',        v_app_url,
        'app_login_url',  v_app_login_url
      )
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_app.dsp_id, v_app.id, 'outbound', 'queued', v_app.phone, v_msg.body);

  elsif v_app.email is not null then
    -- Email fallback.
    select * into v_msg from private.render_template(
      v_app.dsp_id, 'email', v_key,
      jsonb_build_object(
        'first_name',     coalesce(v_app.first_name, v_app.full_name),
        'invite_code',    coalesce(v_invite_code, ''),
        'app_url',        v_app_url,
        'app_login_url',  v_app_login_url
      )
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_app.dsp_id, v_app.id, 'outbound', 'queued', v_app.email,
       v_msg.subject, v_msg.body);
  end if;
end;
$$;

-- Rewrite the hired templates to include the deep-link, code, and
-- short install hint.  Limited to rows whose body still matches the
-- previously-seeded copy so any operator who customized the message
-- keeps their edits.

update public.message_templates
   set body = E'Welcome to {{dsp_name}}, {{first_name}}! Download the {{dsp_name}} driver app: {{app_login_url}}\n\nOn iPhone: open the link in Safari, tap Share, then "Add to Home Screen". On Android: open in Chrome, tap menu, then "Install app".\n\nYour invite code is {{invite_code}} (it''s pre-filled if you tap the link).',
       updated_at = now()
 where channel = 'sms'
   and key = 'applicant.outcome_hired'
   and body like 'Congrats {{first_name}}! You''ve been hired%';

update public.message_templates
   set subject = 'Welcome to {{dsp_name}} — install your driver app',
       body = E'Hi {{first_name}},\n\nWelcome to the {{dsp_name}} team!  To get set up, install the driver app on your phone:\n\n   {{app_login_url}}\n\nInstall instructions:\n\n   • iPhone — open the link in Safari, tap the Share button, then "Add to Home Screen".\n   • Android — open the link in Chrome, tap the menu (⋮), then "Install app".\n\nYour personal invite code is {{invite_code}}.  If you tap the link above, the code is pre-filled — just tap Sign in.\n\nWe''ll send your first schedule shortly.\n\n— The {{dsp_name}} team',
       updated_at = now()
 where channel = 'email'
   and key = 'applicant.outcome_hired'
   and body like 'Congrats {{first_name}}!%';
