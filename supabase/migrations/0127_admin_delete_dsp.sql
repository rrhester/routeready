-- Hard-delete a DSP from the admin surface.  Used for test cleanup
-- and (rarely) production de-provisioning.  Suspend should be the
-- default operator action for "stop this customer using RouteReady";
-- delete is for "permanently remove all trace from the database."
--
-- Cascade: dsps(id) is FK'd by drivers, app_users, stations, schedule
-- entries, messages, forms, etc.  Most of those use ON DELETE CASCADE
-- so they go automatically.  auth.users rows for former members
-- survive the cascade — they'll bounce off the no-profile redirect
-- if they ever try to sign in.  A future cleanup-edge-function could
-- garbage-collect orphaned auth users, but that's a separate concern
-- (it requires service-role access, not a SQL RPC).
--
-- Safeguards:
--   - Platform admin role required (re-checked inside the function
--     body even though EXECUTE is granted to authenticated).
--   - Caller cannot delete their own DSP — prevents the platform
--     admin from accidentally locking themselves out of the
--     dashboard by deleting Air Capital Logistics (or whichever DSP
--     their app_users row is attached to).

create or replace function public.admin_delete_dsp(p_dsp_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_dsp uuid;
  v_target     public.dsps;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  v_caller_dsp := private.current_dsp_id();
  if v_caller_dsp = p_dsp_id then
    raise exception 'cannot_delete_own_dsp';
  end if;

  -- Surface a clear error if the DSP doesn't exist (rather than
  -- silently succeeding, which would mask client-side bugs).
  select * into v_target from public.dsps where id = p_dsp_id;
  if v_target.id is null then
    raise exception 'dsp_not_found';
  end if;

  delete from public.dsps where id = p_dsp_id;
end;
$$;

grant execute on function public.admin_delete_dsp(uuid) to authenticated;
