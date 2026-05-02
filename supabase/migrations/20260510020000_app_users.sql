-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510020000 · app_users + custom_access_token_hook
-- Mirrors auth.users with business-level fields and gates which DSP a
-- user belongs to + their role. The auth hook reads from this table to
-- inject dsp_id / role / driver_id claims into the JWT.
-- ─────────────────────────────────────────────────────────────────────────

-- Note: drivers table is created in migration 20260510030000_drivers.sql.
-- The driver_id FK is added there to break the cycle.

create table public.app_users (
  id           uuid        primary key references auth.users(id) on delete cascade,
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  role         text        not null
               check (role in ('owner','ops','dispatcher','driver')),
  driver_id    uuid,                                -- FK added in migration 030000
  email        text,
  phone        text,
  full_name    text,
  status       text        not null default 'active'
               check (status in ('active','disabled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index app_users_dsp_role_idx on public.app_users (dsp_id, role);
create index app_users_driver_idx   on public.app_users (driver_id) where driver_id is not null;

create trigger trg_app_users_updated_at
  before update on public.app_users
  for each row execute function moddatetime(updated_at);

comment on table public.app_users is
  'Mirror of auth.users with business fields. Source of truth for the ' ||
  'JWT custom claims (dsp_id, role, driver_id).';

-- ─── RLS on app_users ────────────────────────────────────────────────────

alter table public.app_users enable row level security;

-- Authenticated users can SELECT their own row + any row in their DSP.
create policy "app_users_self_select"
  on public.app_users for select
  using (
    id = auth.uid()
    or dsp_id = private.current_dsp_id()
  );

-- Only owners can INSERT (invite a new staff member) or UPDATE other
-- users in the same DSP. Each user can update their own row's name/phone.
create policy "app_users_owner_insert"
  on public.app_users for insert
  with check (
    private.is_staff(dsp_id, 'owner')
  );

create policy "app_users_self_update"
  on public.app_users for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "app_users_owner_update"
  on public.app_users for update
  using  (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

create policy "app_users_owner_delete"
  on public.app_users for delete
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'owner')
    and id <> auth.uid()                    -- can't delete yourself
  );

grant select, insert, update, delete on public.app_users to authenticated;

-- ─── Custom Access Token hook ────────────────────────────────────────────
-- Supabase calls this on every JWT issuance. We inject dsp_id / role /
-- driver_id into the claims so RLS can read them via the helpers in
-- private. Reference: https://supabase.com/docs/guides/auth/auth-hooks
--
-- The function MUST live in `public` (Supabase requirement). Permissions
-- are tightened so only the auth admin role can call it.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  claims    jsonb;
  v_user_id uuid;
  v_dsp     uuid;
  v_role    text;
  v_driver  uuid;
  v_status  text;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  if v_user_id is null then
    return event;
  end if;

  select dsp_id, role, driver_id, status
    into v_dsp, v_role, v_driver, v_status
    from public.app_users
   where id = v_user_id;

  -- User has no app_users row yet (still in onboarding) — return event unchanged
  if v_dsp is null then
    return event;
  end if;

  -- Disabled accounts get an empty role claim (RLS will deny everything)
  if v_status = 'disabled' then
    v_role := null;
  end if;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  claims := jsonb_set(claims, '{dsp_id}', to_jsonb(v_dsp));

  if v_role is not null then
    claims := jsonb_set(claims, '{role}', to_jsonb(v_role));
  end if;

  if v_driver is not null then
    claims := jsonb_set(claims, '{driver_id}', to_jsonb(v_driver));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Auth hook: reads dsp_id/role/driver_id from app_users into the JWT claims. ' ||
  'Configured in supabase/config.toml under [auth.hook.custom_access_token].';

-- The hook function is callable only by the supabase_auth_admin role.
revoke execute on function public.custom_access_token_hook(jsonb)
  from public, anon, authenticated;
grant  execute on function public.custom_access_token_hook(jsonb)
  to    supabase_auth_admin;

-- The hook needs to read app_users with elevated privileges.
grant select on public.app_users to supabase_auth_admin;
