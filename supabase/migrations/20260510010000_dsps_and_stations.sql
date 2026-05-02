-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510010000 · dsps + stations
-- The tenant root + station list. Everything in the platform is FK'd back
-- to a dsp_id; RLS on every other table reads the JWT claim.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── DSPs ────────────────────────────────────────────────────────────────

create table public.dsps (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  slug                text        not null unique
                      check (slug ~ '^[a-z0-9-]{2,40}$'),
  amazon_node         text,
  cycle               int         not null default 1,
  timezone            text        not null default 'America/Chicago',
  status              text        not null default 'active'
                      check (status in ('active','paused','terminated')),
  settings            jsonb       not null default '{}'::jsonb,
  stripe_customer_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger trg_dsps_updated_at
  before update on public.dsps
  for each row execute function moddatetime(updated_at);

comment on table public.dsps is
  'Tenant root. Every other business table FKs back to dsps.id. ' ||
  'RLS on those tables reads the dsp_id claim from the JWT.';

-- RLS: a DSP row is readable to any user whose JWT has the matching
-- dsp_id claim. Only owner role can update DSP-level settings.

alter table public.dsps enable row level security;

create policy "dsps_self_select"
  on public.dsps for select
  using (id = private.current_dsp_id());

create policy "dsps_owner_update"
  on public.dsps for update
  using  (id = private.current_dsp_id() and private.is_staff(id, 'owner'))
  with check (id = private.current_dsp_id() and private.is_staff(id, 'owner'));

-- INSERT and DELETE go through the service role only — not exposed to
-- end users. New DSPs are provisioned by RouteReady ops.

-- ─── Stations ────────────────────────────────────────────────────────────

create table public.stations (
  id                  uuid        primary key default gen_random_uuid(),
  dsp_id              uuid        not null references public.dsps(id) on delete cascade,
  code                text        not null,
  name                text        not null,
  address             text,
  capacity_routes     int,
  active              boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint stations_code_unique_per_dsp unique (dsp_id, code)
);

create index stations_dsp_idx          on public.stations (dsp_id);
create index stations_active_idx       on public.stations (dsp_id) where active = true;

create trigger trg_stations_updated_at
  before update on public.stations
  for each row execute function moddatetime(updated_at);

alter table public.stations enable row level security;

create policy "stations_tenant_select"
  on public.stations for select
  using (dsp_id = private.current_dsp_id());

create policy "stations_staff_insert"
  on public.stations for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

create policy "stations_staff_update"
  on public.stations for update
  using (dsp_id = private.current_dsp_id())
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

create policy "stations_owner_delete"
  on public.stations for delete
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'owner')
  );

-- Permissions: authenticated users can SELECT/INSERT/UPDATE the tables;
-- RLS does the gating. Service role is unrestricted.

grant select               on public.dsps         to authenticated;
grant select, update       on public.dsps         to authenticated;  -- update gated by RLS

grant select, insert, update, delete on public.stations to authenticated;
