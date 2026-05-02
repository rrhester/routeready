-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0001 · Foundation
--
-- Multi-tenant scaffolding for RouteReady. Every business entity in this
-- system is scoped by dsp_id (a Delivery Service Partner). This migration
-- creates the tenant root, station list, app users, role enum, and the
-- helpers that every later RLS policy depends on:
--   - private.current_dsp_id()  → caller's DSP from JWT/session
--   - private.current_user_id() → caller's app_users.id
--   - private.is_staff(dsp, role) → role-gated check used in write policies
--
-- Out of scope for this migration: triggers, RPCs, edge functions, business
-- domain tables (those live in 0002+).
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Extensions ──────────────────────────────────────────────────────────

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists citext;

-- ─── Schemas ─────────────────────────────────────────────────────────────

-- private: helpers that should never be reachable from PostgREST.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres;

-- ─── Enums ───────────────────────────────────────────────────────────────

-- Roles, ordered from least to most privileged. is_staff() compares
-- ordinal positions so "owner can do everything a dispatcher can" is
-- expressed as `current_role >= 'dispatcher'`.
create type public.app_role as enum (
  'driver',
  'dispatcher',
  'ops',
  'owner'
);

-- ─── dsps ────────────────────────────────────────────────────────────────

create table public.dsps (
  id          uuid          primary key default gen_random_uuid(),
  name        text          not null,
  short_code  text          not null,
  timezone    text          not null default 'America/New_York',
  active      boolean       not null default true,
  metadata    jsonb         not null default '{}'::jsonb,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint dsps_short_code_unique unique (short_code),
  constraint dsps_short_code_format check (short_code ~ '^[A-Z0-9_-]{2,12}$')
);

comment on table public.dsps is
  'Tenant root. Every other business table FKs to dsps(id) and RLS scopes by dsp_id.';

-- ─── stations ────────────────────────────────────────────────────────────
-- Amazon delivery stations a DSP operates out of (e.g. DCA1, DBO5).

create table public.stations (
  id          uuid          primary key default gen_random_uuid(),
  dsp_id      uuid          not null references public.dsps(id) on delete cascade,
  code        text          not null,                              -- e.g. 'DCA1'
  name        text,                                                -- friendly label
  timezone    text,                                                -- override DSP tz if needed
  active      boolean       not null default true,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint stations_dsp_code_unique unique (dsp_id, code)
);

create index stations_dsp_idx on public.stations (dsp_id) where active = true;

-- ─── app_users ───────────────────────────────────────────────────────────
-- One row per Supabase auth user, joined by id = auth.users.id. Holds the
-- role and dsp binding that every RLS check reads.

create table public.app_users (
  id          uuid          primary key references auth.users(id) on delete cascade,
  dsp_id      uuid          not null references public.dsps(id) on delete cascade,
  email       citext        not null,
  full_name   text,
  role        public.app_role not null default 'driver',
  active      boolean       not null default true,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint app_users_email_dsp_unique unique (dsp_id, email)
);

create index app_users_dsp_role_idx on public.app_users (dsp_id, role) where active = true;
create index app_users_email_idx on public.app_users (email);

-- ─── private helpers ─────────────────────────────────────────────────────
-- These read the JWT/session set by Supabase auth. They are SECURITY
-- DEFINER so RLS policies can call them without recursion, and STABLE so
-- the planner can cache results within a statement.

create or replace function private.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid();
$$;

create or replace function private.current_dsp_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select dsp_id from public.app_users where id = auth.uid() and active = true;
$$;

create or replace function private.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.app_users where id = auth.uid() and active = true;
$$;

-- is_staff(dsp, min_role) → true if caller is in the given DSP and at
-- or above the given role. Use for write policies. Default min_role is
-- 'dispatcher' which covers most operator screens.
create or replace function private.is_staff(p_dsp_id uuid, p_min_role public.app_role default 'dispatcher')
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_users
    where id = auth.uid()
      and active = true
      and dsp_id = p_dsp_id
      and role >= p_min_role
  );
$$;

-- ─── RLS ─────────────────────────────────────────────────────────────────

alter table public.dsps      enable row level security;
alter table public.stations  enable row level security;
alter table public.app_users enable row level security;

-- dsps: a user can only see their own tenant. Writes are owner-only.
create policy "dsps_self_select"
  on public.dsps for select
  using (id = private.current_dsp_id());

create policy "dsps_owner_update"
  on public.dsps for update
  using (id = private.current_dsp_id() and private.is_staff(id, 'owner'))
  with check (id = private.current_dsp_id() and private.is_staff(id, 'owner'));

-- (No insert/delete policies on dsps — provisioning is service-role only.)

-- stations: tenant-scoped read; owner-only write.
create policy "stations_tenant_select"
  on public.stations for select
  using (dsp_id = private.current_dsp_id());

create policy "stations_owner_write"
  on public.stations for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

-- app_users:
--   - Anyone in the DSP can see other users in their DSP (dispatch needs
--     to know the roster).
--   - A user can always read their own row even before dsp binding is
--     fully resolved.
--   - Only owners can change roles or add users.
create policy "app_users_self_select"
  on public.app_users for select
  using (id = auth.uid());

create policy "app_users_tenant_select"
  on public.app_users for select
  using (dsp_id = private.current_dsp_id());

create policy "app_users_owner_write"
  on public.app_users for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

grant select, update                  on public.dsps      to authenticated;
grant select, insert, update, delete  on public.stations  to authenticated;
grant select, insert, update, delete  on public.app_users to authenticated;
