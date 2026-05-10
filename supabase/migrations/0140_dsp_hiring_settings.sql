-- Migration 0140 · DSP hiring-planning knobs (drivers-per-route + cushion)
--
-- The route-forecast page sizes the roster as
--   drivers needed = ceil( drivers_per_route × peak_routes × (1 + cushion%) )
-- A route needs ~2 drivers to be reliably staffed (rotation + backup), and
-- cautious DSPs want some headroom on top of that.  Both are per-DSP and
-- editable from the Staffing-outlook page.

create table if not exists public.dsp_hiring_settings (
  dsp_id            uuid        primary key references public.dsps(id) on delete cascade,
  drivers_per_route numeric     not null default 2.0 check (drivers_per_route between 1.0 and 5.0),
  cushion_pct       int         not null default 20  check (cushion_pct between 0 and 200),
  updated_at        timestamptz not null default now()
);
alter table public.dsp_hiring_settings enable row level security;
drop policy if exists "dsp_hiring_settings_tenant_rw" on public.dsp_hiring_settings;
create policy "dsp_hiring_settings_tenant_rw" on public.dsp_hiring_settings for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.dsp_hiring_settings to authenticated;


create or replace function public.hiring_settings_get()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_s public.dsp_hiring_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_s from public.dsp_hiring_settings where dsp_id = v_dsp;
  return jsonb_build_object(
    'drivers_per_route', coalesce(v_s.drivers_per_route, 2.0),
    'cushion_pct',       coalesce(v_s.cushion_pct, 20)
  );
end; $$;
grant execute on function public.hiring_settings_get() to authenticated;


create or replace function public.hiring_settings_set(p_drivers_per_route numeric default null, p_cushion_pct int default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_dpr numeric;
  v_cp  int;
  v_s   public.dsp_hiring_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_s from public.dsp_hiring_settings where dsp_id = v_dsp;
  v_dpr := greatest(1.0, least(5.0, coalesce(p_drivers_per_route, v_s.drivers_per_route, 2.0)));
  v_cp  := greatest(0,   least(200, coalesce(p_cushion_pct,       v_s.cushion_pct,       20)));
  insert into public.dsp_hiring_settings (dsp_id, drivers_per_route, cushion_pct)
  values (v_dsp, v_dpr, v_cp)
  on conflict (dsp_id) do update set drivers_per_route = excluded.drivers_per_route, cushion_pct = excluded.cushion_pct, updated_at = now()
  returning * into v_s;
  return jsonb_build_object('drivers_per_route', v_s.drivers_per_route, 'cushion_pct', v_s.cushion_pct);
end; $$;
grant execute on function public.hiring_settings_set(numeric, int) to authenticated;

notify pgrst, 'reload schema';
