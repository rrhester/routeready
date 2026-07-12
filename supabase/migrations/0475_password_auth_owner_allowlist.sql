-- 0475_password_auth_owner_allowlist.sql
--
-- Two things, both in support of turning on email/password sign-in
-- alongside the existing magic-link flow:
--
--   1. Patch private.on_auth_user_created so a pre-authorized owner email
--      (listed in some DSP's metadata.pending_owners) can complete signup
--      REGARDLESS of email domain. Password signup fires the same
--      auth.users trigger as magic-link, so without this an owner on a
--      non-work domain (e.g. a personal gmail) hits the same
--      "Database error saving new user" wrap the domain gate produces.
--
--      This keeps the self-serve gate closed to the public — only emails
--      an admin has explicitly staged as pending_owners get the bypass.
--
--   2. Stage rangerryan1972@gmail.com as a pending owner of the DEMO DSP
--      so the first password (or magic-link) sign-in lands as 'owner'.
--
-- Idempotent: create-or-replace function, and the pending_owners update
-- de-dups via UNION so re-running won't add the address twice.

create or replace function private.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email       text  := lower(new.email);
  v_meta        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_invite_dsp  uuid  := nullif(v_meta->>'invite_dsp_id', '')::uuid;
  v_invite_role text  := nullif(v_meta->>'invite_role', '');
  v_full_name   text  := coalesce(v_meta->>'full_name', v_email);
  v_domain      text;
  v_dsp         public.dsps;
  v_owner_dsp   public.dsps;
begin
  if v_email is null then
    return new;
  end if;

  -- Path A: dashboard-initiated invite. Trust the metadata; the edge
  -- function (invite-team-member) already verified the caller belongs to
  -- invite_dsp_id and has owner/ops role.
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

  -- Path B: pre-authorized owner allowlist. Any email an admin has staged
  -- in a DSP's metadata.pending_owners may claim ownership on first
  -- sign-in, regardless of email domain. This is how bootstrap owners
  -- (including non-work-domain addresses) get in WITHOUT opening
  -- self-serve signup to the whole internet.
  select d.* into v_owner_dsp
    from public.dsps d
   where d.metadata->'pending_owners' ? v_email
   order by d.created_at
   limit 1;

  if v_owner_dsp.id is not null then
    insert into public.app_users (id, dsp_id, email, full_name, role)
    values (new.id, v_owner_dsp.id, v_email, v_full_name, 'owner')
    on conflict (id) do nothing;

    -- Clear the claimed entry so the seat can't be re-claimed later.
    update public.dsps
       set metadata = jsonb_set(
         metadata,
         '{pending_owners}',
         (select coalesce(jsonb_agg(elem), '[]'::jsonb)
            from jsonb_array_elements_text(v_owner_dsp.metadata->'pending_owners') elem
            where elem <> v_email)
       )
     where id = v_owner_dsp.id;

    return new;
  end if;

  -- Path C: original self-serve flow — gorouteready.com → DEMO DSP as
  -- 'driver'. Any other domain is rejected (aborts signup).
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

  insert into public.app_users (id, dsp_id, email, full_name, role)
  values (new.id, v_dsp.id, v_email, v_full_name, 'driver')
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Trigger definition unchanged; re-declare for idempotency.
drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function private.on_auth_user_created();

-- ─── Stage the owner email on the DEMO DSP ───────────────────────────────
-- De-dups via UNION so re-running is safe.
update public.dsps
   set metadata = jsonb_set(
     coalesce(metadata, '{}'::jsonb),
     '{pending_owners}',
     (
       select coalesce(jsonb_agg(distinct e order by e), '[]'::jsonb)
       from (
         select jsonb_array_elements_text(
                  coalesce(metadata->'pending_owners', '[]'::jsonb)) as e
         union
         select 'rangerryan1972@gmail.com'
       ) s
     ),
     true
   )
 where short_code = 'DEMO';

-- Refresh the PostgREST schema cache.
notify pgrst, 'reload schema';
