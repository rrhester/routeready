-- Per-DSP page + feature entitlements for the platform-admin control center.
--
-- A platform admin can turn top-level pages (nav modules) and in-app
-- features on/off for an entire DSP.  The choice is stored as two
-- opt-out lists on dsps.metadata:
--
--     metadata.disabled_pages    text[]   -- data-view keys that are OFF
--     metadata.disabled_features text[]   -- feature keys that are OFF
--
-- Absent / empty  =  everything enabled.  Opt-out (store what's OFF)
-- means any page/feature shipped later defaults ON for every DSP until
-- an admin explicitly disables it — no backfill required.
--
-- Enforcement is UI-level (the dashboard hides the nav item / feature
-- button for every user in the DSP).  The underlying data stays gated
-- by the existing dsp_id + role RLS policies regardless, so this is an
-- entitlement / packaging control, not a security boundary.
--
-- Idempotent: drop-then-create for the list RPC (its RETURNS TABLE
-- signature grows two columns, which `create or replace` can't do), and
-- create-or-replace for the setter.

-- ─── 1. Setter · admin_set_dsp_entitlements ──────────────────────────────
-- Overwrites both lists in one shot.  NULL args are treated as "no
-- items disabled" so the caller can send a clean state every save.
create or replace function public.admin_set_dsp_entitlements(
  p_dsp_id            uuid,
  p_disabled_pages    text[] default '{}',
  p_disabled_features text[] default '{}'
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
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'disabled_pages',    coalesce(to_jsonb(p_disabled_pages),    '[]'::jsonb),
                         'disabled_features', coalesce(to_jsonb(p_disabled_features), '[]'::jsonb)
                       )
   where id = p_dsp_id;
end;
$$;

-- ─── 2. admin_list_dsps() — now surfaces the two entitlement lists ────────
-- Same rolled-up rows as migration 0124, plus disabled_pages /
-- disabled_features so the control-center table + drawer can render the
-- module state without a second round-trip.
drop function if exists public.admin_list_dsps();

create function public.admin_list_dsps()
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
  created_at        timestamptz,
  disabled_pages    text[],
  disabled_features text[]
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
      d.created_at,
      coalesce(array(select jsonb_array_elements_text(d.metadata->'disabled_pages')),    '{}'::text[]),
      coalesce(array(select jsonb_array_elements_text(d.metadata->'disabled_features')), '{}'::text[])
    from public.dsps d
    order by d.created_at desc;
end;
$$;

-- ─── 3. Grants ───────────────────────────────────────────────────────────
grant execute on function public.admin_set_dsp_entitlements(uuid, text[], text[]) to authenticated;
grant execute on function public.admin_list_dsps()                                to authenticated;
