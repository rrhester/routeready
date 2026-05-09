-- Surface platform_admin as the displayed "owner" on the admin DSP
-- table when present.  Today the function only considers role='owner';
-- on the RouteReady-owned corporate DSP that's the dispatcher running
-- the workspace day-to-day, not the brand contact (support@) who
-- actually owns the account from a customer-relationship perspective.
--
-- New behavior · pick the highest-authority active member as the
-- displayed contact:
--   1. platform_admin (if any)
--   2. owner          (if no platform_admin)
--   3. nothing        (DSP has no owner-tier user)
--
-- This is display-only.  RLS, role gates, current_dsp_id() etc. are
-- unaffected — they keep their existing semantics.

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
      (select u.email::text  from public.app_users u
        where u.dsp_id = d.id
          and u.role::text in ('platform_admin', 'owner')
          and u.active = true
        order by case u.role::text when 'platform_admin' then 0 else 1 end,
                 u.created_at
        limit 1),
      (select u.full_name    from public.app_users u
        where u.dsp_id = d.id
          and u.role::text in ('platform_admin', 'owner')
          and u.active = true
        order by case u.role::text when 'platform_admin' then 0 else 1 end,
                 u.created_at
        limit 1),
      (select count(*)::int from public.drivers dr
        where dr.dsp_id = d.id and dr.status::text in ('active','onboarding')),
      0::int,
      (select max(u.created_at) from public.app_users u
        where u.dsp_id = d.id and u.active = true),
      d.created_at
    from public.dsps d
    order by d.created_at desc;
end;
$$;

grant execute on function public.admin_list_dsps() to authenticated;
