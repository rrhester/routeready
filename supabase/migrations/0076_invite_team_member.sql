-- 0076_invite_team_member.sql
--
-- Patches private.on_auth_user_created so a dashboard-driven invite
-- (auth.admin.inviteUserByEmail with metadata.invite_dsp_id + invite_role)
-- bypasses the legacy gorouteready.com-only gate and lands the new user
-- in the inviter's DSP with the chosen role.
--
-- Without this patch:
--   - Every invite gets the "Database error saving new user" wrap
--     because the trigger raises 'signup_domain_not_allowed' on any
--     non-gorouteready.com email.
--   - Even gorouteready.com invites are forced onto the DEMO DSP and
--     the 'driver' role.
--
-- After this patch:
--   - If raw_user_meta_data.invite_dsp_id is set we trust it (the edge
--     function that initiated the invite already verified the inviter
--     has authority over that DSP).
--   - Otherwise the original gorouteready.com → DEMO flow is preserved
--     so existing self-serve sign-ins still work.

create or replace function private.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email      text  := lower(new.email);
  v_meta       jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_invite_dsp uuid  := nullif(v_meta->>'invite_dsp_id', '')::uuid;
  v_invite_role text := nullif(v_meta->>'invite_role', '');
  v_full_name  text  := coalesce(v_meta->>'full_name', v_email);
  v_domain     text;
  v_dsp        public.dsps;
  v_role       public.app_role := 'driver';
  v_pending_owners jsonb;
begin
  if v_email is null then
    return new;
  end if;

  -- Path A: dashboard-initiated invite. Trust the metadata; the edge
  -- function (invite-team-member) already verified the caller belongs
  -- to invite_dsp_id and has owner/ops role.
  if v_invite_dsp is not null then
    insert into public.app_users (id, dsp_id, email, full_name, role)
    values (
      new.id,
      v_invite_dsp,
      v_email,
      v_full_name,
      coalesce(v_invite_role, 'dispatcher')::public.app_role
    )
    on conflict (id) do nothing;
    return new;
  end if;

  -- Path B: original self-serve flow — gorouteready.com → DEMO DSP.
  v_domain := split_part(v_email, '@', 2);
  if v_domain <> 'gorouteready.com' then
    raise exception using
      errcode = '42501',
      message = 'signup_domain_not_allowed: ' || v_domain;
  end if;

  select * into v_dsp from public.dsps where short_code = 'DEMO' limit 1;
  if v_dsp.id is null then
    raise exception 'no_default_dsp_configured';
  end if;

  v_pending_owners := coalesce(v_dsp.metadata->'pending_owners', '[]'::jsonb);
  if v_pending_owners ? v_email then
    v_role := 'owner';
    update public.dsps
       set metadata = jsonb_set(
         metadata,
         '{pending_owners}',
         (select coalesce(jsonb_agg(elem), '[]'::jsonb)
            from jsonb_array_elements_text(v_pending_owners) elem
            where elem <> v_email)
       )
     where id = v_dsp.id;
  end if;

  insert into public.app_users (id, dsp_id, email, full_name, role)
  values (new.id, v_dsp.id, v_email, v_full_name, v_role)
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Trigger definition unchanged; re-declare for idempotency.
drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function private.on_auth_user_created();

-- Refresh the PostgREST schema cache so the new function picks up.
notify pgrst, 'reload schema';
