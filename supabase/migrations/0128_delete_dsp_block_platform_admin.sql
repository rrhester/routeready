-- Hardening for admin_delete_dsp · refuse to delete a DSP if any
-- platform_admin is currently a member of it.
--
-- Background: 0127 already blocks deletion of the CALLER'S OWN DSP
-- (the one their app_users.dsp_id points to).  But that doesn't
-- protect against the case where another platform_admin (or the
-- caller themselves earlier, before account moved) is in the
-- target DSP.  When the cascade fires, ALL app_users for the
-- target DSP go — including any platform admins.  That admin is
-- then locked out of the dashboard until their app_users row is
-- recreated by hand (the failure mode that just bit Ryan).
--
-- This migration adds a second guard: count platform_admin members
-- of the target DSP and refuse with 'platform_admin_in_target_dsp'
-- if any exist.  The frontend maps this error to a clear "transfer
-- the admin's account first" message.

create or replace function public.admin_delete_dsp(p_dsp_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_dsp uuid;
  v_admin_count int;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  v_caller_dsp := private.current_dsp_id();
  if v_caller_dsp = p_dsp_id then
    raise exception 'cannot_delete_own_dsp';
  end if;

  -- New guard · refuse if any platform admin is in the target DSP.
  select count(*)
    into v_admin_count
    from public.app_users
   where dsp_id = p_dsp_id
     and role::text = 'platform_admin';
  if v_admin_count > 0 then
    raise exception 'platform_admin_in_target_dsp';
  end if;

  if not exists (select 1 from public.dsps where id = p_dsp_id) then
    raise exception 'dsp_not_found';
  end if;

  delete from public.dsps where id = p_dsp_id;
end;
$$;

grant execute on function public.admin_delete_dsp(uuid) to authenticated;
