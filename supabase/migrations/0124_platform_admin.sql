-- Cross-tenant admin surface for RouteReady (the SaaS platform itself,
-- not individual DSP customers).  Adds the 'platform_admin' role and
-- the admin_* RPCs that drive /dashboard/admin.html.
--
-- ─── Scope ───────────────────────────────────────────────────────────────
--   1. New role: 'platform_admin' (highest tier in app_role enum)
--   2. New columns on dsps:  status, subscription_plan, phone, address, notes
--   3. RLS:  platform_admin can SELECT/UPDATE across all tenants
--   4. RPCs (all SECURITY DEFINER, gated on private.is_platform_admin()):
--        admin_kpis, admin_list_dsps, admin_dsp_detail, admin_create_dsp,
--        admin_invite_owner, admin_suspend_dsp, admin_reactivate_dsp,
--        admin_set_user_permissions
--
-- ─── Bootstrap ───────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor AFTER this migration applies, to
-- grant yourself the new role:
--
--    update public.app_users
--       set role = 'platform_admin'
--     where email = 'rangerryan1972@gmail.com';
--
-- Then sign out + back in on the dashboard so the JWT picks up the new
-- role.  After that, you can promote others through the admin UI's
-- Manage-Users panel — no more SQL required.
--
-- Other existing owners (support@gorouteready.com, etc.) remain regular
-- DSP owners; they will NOT see the admin page or the admin_* RPCs.

-- ─── 1. Add the enum value ───────────────────────────────────────────────
-- Postgres 12+ permits ADD VALUE inside a transaction, but the new
-- value cannot be referenced via its enum literal in the SAME
-- transaction.  All comparisons below use `role::text = 'platform_admin'`
-- so the migration applies cleanly in one shot.
alter type public.app_role add value if not exists 'platform_admin' after 'owner';

-- ─── 2. Admin-facing columns on dsps ─────────────────────────────────────
alter table public.dsps
  add column if not exists status text not null default 'active'
    check (status in ('active', 'pending', 'suspended')),
  add column if not exists subscription_plan text not null default 'starter'
    check (subscription_plan in ('starter', 'growth', 'enterprise')),
  add column if not exists phone   text,
  add column if not exists address text,
  add column if not exists notes   text;

comment on column public.dsps.status is
  'Admin-facing status: active (operating), pending (awaiting owner signup), suspended (admin disabled).';
comment on column public.dsps.subscription_plan is
  'starter / growth / enterprise.  Display + filter only today; billing wiring is a separate project.';

-- ─── 3. Helper: is the caller a platform_admin? ──────────────────────────
-- role::text comparison so the migration is transaction-safe (see note
-- above the ALTER TYPE call).
create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.app_users
     where id     = auth.uid()
       and active = true
       and role::text = 'platform_admin'
  );
$$;

-- ─── 4. RLS · platform_admin sees + writes everything ────────────────────
-- The existing tenant-scoped policies on dsps and app_users already work
-- for regular operators.  These ride alongside, granting the platform
-- admin a global view.  Drivers / forms / etc. are only read through
-- SECURITY DEFINER RPCs below, so no extra cross-tenant policies are
-- needed on those tables.
drop policy if exists "dsps_admin_all" on public.dsps;
create policy "dsps_admin_all"
  on public.dsps for all
  using (private.is_platform_admin())
  with check (private.is_platform_admin());

drop policy if exists "app_users_admin_all" on public.app_users;
create policy "app_users_admin_all"
  on public.app_users for all
  using (private.is_platform_admin())
  with check (private.is_platform_admin());

-- ─── 5. Admin RPCs ───────────────────────────────────────────────────────

-- 5a. admin_kpis() — 4 stat cards on the overview header.
create or replace function public.admin_kpis()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total     int;
  v_active    int;
  v_pending   int;
  v_suspended int;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select count(*),
         count(*) filter (where status = 'active'),
         count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'suspended')
    into v_total, v_active, v_pending, v_suspended
    from public.dsps;

  return jsonb_build_object(
    'total',     v_total,
    'active',    v_active,
    'pending',   v_pending,
    'suspended', v_suspended
  );
end;
$$;

-- 5b. admin_list_dsps() — rolled-up rows for the main table.
create or replace function public.admin_list_dsps()
returns table (
  id                uuid,
  name              text,
  short_code        text,
  status            text,
  subscription_plan text,
  phone             text,
  address           text,
  notes             text,
  owner_email       text,
  owner_name        text,
  driver_count      int,
  route_count       int,
  last_active_at    timestamptz,
  created_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  return query
    select
      d.id,
      d.name,
      d.short_code,
      d.status,
      d.subscription_plan,
      d.phone,
      d.address,
      d.notes,
      (select email::text  from public.app_users
        where dsp_id = d.id and role::text = 'owner' and active = true
        order by created_at limit 1),
      (select full_name    from public.app_users
        where dsp_id = d.id and role::text = 'owner' and active = true
        order by created_at limit 1),
      (select count(*)::int from public.drivers
        where dsp_id = d.id and status::text in ('active','onboarding')),
      0::int,                                          -- route count placeholder
      (select max(created_at) from public.app_users
        where dsp_id = d.id and active = true),
      d.created_at
    from public.dsps d
    order by d.created_at desc;
end;
$$;

-- 5c. admin_dsp_detail(p_dsp_id) — full info + user list for one DSP.
create or replace function public.admin_dsp_detail(p_dsp_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select jsonb_build_object(
    'dsp',          to_jsonb(d.*),
    'users',        coalesce(
                      (select jsonb_agg(jsonb_build_object(
                                'id',            u.id,
                                'email',         u.email::text,
                                'full_name',     u.full_name,
                                'role',          u.role::text,
                                'active',        u.active,
                                'allowed_pages', u.allowed_pages,
                                'created_at',    u.created_at
                              ) order by u.role desc, u.full_name)
                         from public.app_users u
                        where u.dsp_id = d.id),
                      '[]'::jsonb
                    ),
    'driver_count', (select count(*)::int from public.drivers
                      where dsp_id = d.id and status::text in ('active','onboarding'))
  )
    into v
    from public.dsps d
   where d.id = p_dsp_id;

  return v;
end;
$$;

-- 5d. admin_create_dsp(...) — provision a new DSP.
-- The pending owner's email is stashed in dsps.metadata.pending_owner so
-- the UI can call the existing invite-team-member edge function in a
-- follow-up to actually send the magic link.  The DSP starts in
-- status='pending'; transitioning to 'active' is the admin's call once
-- the owner has signed in at least once.
create or replace function public.admin_create_dsp(
  p_name              text,
  p_short_code        text,
  p_owner_email       text,
  p_owner_name        text,
  p_phone             text default null,
  p_address           text default null,
  p_subscription_plan text default 'starter',
  p_notes             text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;
  if p_subscription_plan not in ('starter', 'growth', 'enterprise') then
    raise exception 'invalid subscription_plan: %', p_subscription_plan;
  end if;

  insert into public.dsps (name, short_code, status, subscription_plan, phone, address, notes)
    values (p_name, upper(p_short_code), 'pending', p_subscription_plan, p_phone, p_address, p_notes)
    returning id into v_id;

  update public.dsps
     set metadata = metadata || jsonb_build_object(
                      'pending_owner', jsonb_build_object(
                        'email',     p_owner_email,
                        'full_name', p_owner_name
                      )
                    )
   where id = v_id;

  return v_id;
end;
$$;

-- 5e. admin_invite_owner(p_dsp_id, p_email, p_full_name)
-- Stash the pending-owner email on an existing DSP so the invite flow
-- (handled by the existing invite-team-member edge function) can place
-- them as an owner of that DSP when they sign in.
create or replace function public.admin_invite_owner(
  p_dsp_id    uuid,
  p_email     text,
  p_full_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.dsps
     set metadata = metadata || jsonb_build_object(
                      'pending_owner', jsonb_build_object(
                        'email',     p_email,
                        'full_name', p_full_name
                      )
                    )
   where id = p_dsp_id;
end;
$$;

-- 5f. admin_suspend_dsp(p_dsp_id) / admin_reactivate_dsp(p_dsp_id)
-- Suspend = status='suspended' AND every app_user in that DSP gets
-- active=false (so RLS treats them as anon and they can't operate).
-- Platform admins are exempt so the suspending admin doesn't lock
-- themselves out if they happened to also be a tenant owner.
create or replace function public.admin_suspend_dsp(p_dsp_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.dsps
     set status = 'suspended', active = false
   where id = p_dsp_id;

  update public.app_users
     set active = false
   where dsp_id = p_dsp_id
     and role::text <> 'platform_admin';
end;
$$;

create or replace function public.admin_reactivate_dsp(p_dsp_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.dsps
     set status = 'active', active = true
   where id = p_dsp_id;

  update public.app_users
     set active = true
   where dsp_id = p_dsp_id;
end;
$$;

-- 5g. admin_set_user_permissions(p_user_id, p_role, p_allowed_pages, p_active)
-- Single setter that an admin uses from the Manage-Users side panel to
-- change a teammate's role, sidebar visibility, or active flag.  Any
-- argument left null is left untouched.
create or replace function public.admin_set_user_permissions(
  p_user_id        uuid,
  p_role           text    default null,
  p_allowed_pages  text[]  default null,
  p_active         boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if p_role is not null then
    if p_role not in ('driver', 'dispatcher', 'ops', 'owner', 'platform_admin') then
      raise exception 'invalid role: %', p_role;
    end if;
    update public.app_users set role = p_role::public.app_role where id = p_user_id;
  end if;

  if p_allowed_pages is not null then
    update public.app_users set allowed_pages = p_allowed_pages where id = p_user_id;
  end if;

  if p_active is not null then
    update public.app_users set active = p_active where id = p_user_id;
  end if;
end;
$$;

-- ─── 6. Grants ───────────────────────────────────────────────────────────
-- Every admin RPC re-checks is_platform_admin() in its body, so granting
-- EXECUTE to `authenticated` is safe — the role gate is enforced inside
-- the function regardless of who PostgREST hands the call to.
grant execute on function public.admin_kpis()                                                         to authenticated;
grant execute on function public.admin_list_dsps()                                                    to authenticated;
grant execute on function public.admin_dsp_detail(uuid)                                               to authenticated;
grant execute on function public.admin_create_dsp(text, text, text, text, text, text, text, text)     to authenticated;
grant execute on function public.admin_invite_owner(uuid, text, text)                                 to authenticated;
grant execute on function public.admin_suspend_dsp(uuid)                                              to authenticated;
grant execute on function public.admin_reactivate_dsp(uuid)                                           to authenticated;
grant execute on function public.admin_set_user_permissions(uuid, text, text[], boolean)              to authenticated;
