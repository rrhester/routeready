-- Per-teammate page visibility + self-name edits.
--
-- Two related changes to app_users:
--
-- 1. allowed_pages text[]
--    Owner-set list of top-level dashboard views a teammate is allowed
--    to see in their sidebar. NULL = no restriction (sees everything,
--    same as owner). Pages are referenced by their data-view key
--    (dashboard, pipeline, drivers, staffing, fleet, schedule,
--    messages, forms, finances, settings).
--
--    This is *UI hiding only* — every existing RLS policy still gates
--    the underlying data by dsp_id + role. allowed_pages is a quality-
--    of-life filter so a dispatcher who only handles routes doesn't
--    have to scroll past pages they never touch.
--
-- 2. app_users_self_name_update RLS policy
--    Lets a user update their own full_name without needing owner
--    privileges. Previously only owners could write to app_users,
--    which meant a teammate couldn't fix their own display name if
--    it was wrong (e.g. "RouteReady Support" set as a fallback at
--    signup). Role / dsp_id / active still locked behind the owner
--    write policy via WITH CHECK predicate that pins them to current
--    values.

alter table public.app_users
  add column if not exists allowed_pages text[];

comment on column public.app_users.allowed_pages is
  'Top-level dashboard views this user can see in the sidebar. NULL = all pages.';

-- Self-name update.  Only allows changes that keep role/dsp_id/active
-- pinned to their existing values; the owner-write policy still owns
-- those fields.
drop policy if exists "app_users_self_name_update" on public.app_users;
create policy "app_users_self_name_update"
  on public.app_users for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role     = (select role     from public.app_users where id = auth.uid())
    and dsp_id   = (select dsp_id   from public.app_users where id = auth.uid())
    and active   = (select active   from public.app_users where id = auth.uid())
  );
