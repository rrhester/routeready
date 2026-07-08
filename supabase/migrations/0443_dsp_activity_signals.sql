-- Control-center data integrity + signals.
--
-- Backs four upgrades to the platform-admin DSP console:
--   1. Real operator activity   → dsps.last_seen_at + touch_dsp_activity()
--   2. Honest route count       → distinct scheduled route_code this week
--   3. Per-DSP error signal      → client_errors count (7d)
--   4. Richer drill-down detail  → admin_dsp_detail() gains the above +
--                                  a support-thread summary + recent errors
--
-- Idempotent throughout (add column if not exists, create index if not
-- exists, create-or-replace / drop-then-create for the RPCs).

-- ─── 1. Real operator last-seen ──────────────────────────────────────────
-- Until now the admin table's "last active" was a proxy: max(app_users
-- .created_at) — the newest teammate's *signup* time, not real usage.
-- Add a true last_seen stamp that the dashboard bumps on boot.
alter table public.dsps
  add column if not exists last_seen_at timestamptz;

comment on column public.dsps.last_seen_at is
  'Real operator activity — bumped by touch_dsp_activity() when a dashboard user loads the app. Distinct from activated_at (one-time) and the app_users.created_at proxy.';

-- touch_dsp_activity() — the caller stamps their OWN dsp as seen now.
-- current_dsp_id() already requires an active membership, so a signed-out
-- / anon caller resolves to null and no row is touched.  Cheap enough to
-- call fire-and-forget on every boot (the dashboard throttles to ~1/hr).
create or replace function public.touch_dsp_activity()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then
    return;
  end if;
  update public.dsps set last_seen_at = now() where id = v_dsp;
end;
$$;

grant execute on function public.touch_dsp_activity() to authenticated;

-- ─── 2. Index for the per-DSP error signal ───────────────────────────────
-- client_errors only had a (created_at) index; the admin roll-ups below
-- filter by dsp_id, so add the composite.
create index if not exists client_errors_dsp_created_idx
  on public.client_errors (dsp_id, created_at desc);

-- ─── 3. admin_list_dsps() — real routes, real last-active, error count ────
-- Drop-then-create: the RETURNS TABLE signature grows two columns
-- (route_count is now real, error_count_7d is new).  Owner/email keeps the
-- 0129 highest-authority pick; entitlement lists (0442) are preserved.
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
  error_count_7d    int,
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
      -- Real route count: distinct route codes on scheduled shifts in the
      -- coming week.  There is no dedicated routes entity; a scheduled
      -- shift's route_code is the closest real signal of route activity.
      (select count(distinct s.route_code)::int
         from public.shifts s
        where s.dsp_id = d.id
          and s.status = 'scheduled'
          and s.route_code is not null
          and s.date >= current_date
          and s.date <  current_date + 7),
      -- Client errors captured for this DSP in the last 7 days.
      (select count(*)::int from public.client_errors ce
        where ce.dsp_id = d.id
          and ce.created_at > now() - interval '7 days'),
      -- Real last-active: the operator last-seen stamp, falling back to the
      -- newest-teammate proxy for DSPs that haven't loaded since this shipped.
      coalesce(
        d.last_seen_at,
        (select max(u.created_at) from public.app_users u
          where u.dsp_id = d.id and u.active = true)
      ),
      d.created_at,
      coalesce(array(select jsonb_array_elements_text(d.metadata->'disabled_pages')),    '{}'::text[]),
      coalesce(array(select jsonb_array_elements_text(d.metadata->'disabled_features')), '{}'::text[])
    from public.dsps d
    order by d.created_at desc;
end;
$$;

grant execute on function public.admin_list_dsps() to authenticated;

-- ─── 4. admin_dsp_detail() — drill-down profile payload ───────────────────
-- Same three original keys (dsp / users / driver_count) plus the signals
-- the profile drawer needs: route_count, error_count_7d, recent_errors,
-- last_seen_at, and a support-thread summary (unread + latest message).
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
                      where dsp_id = d.id and status::text in ('active','onboarding')),
    'route_count',  (select count(distinct s.route_code)::int
                       from public.shifts s
                      where s.dsp_id = d.id
                        and s.status = 'scheduled'
                        and s.route_code is not null
                        and s.date >= current_date
                        and s.date <  current_date + 7),
    'error_count_7d', (select count(*)::int from public.client_errors ce
                        where ce.dsp_id = d.id
                          and ce.created_at > now() - interval '7 days'),
    'recent_errors', coalesce(
                      (select jsonb_agg(e) from (
                         select jsonb_build_object(
                                  'created_at', ce.created_at,
                                  'page',       ce.page,
                                  'message',    ce.message,
                                  'source',     ce.source
                                ) e
                           from public.client_errors ce
                          where ce.dsp_id = d.id
                          order by ce.created_at desc
                          limit 8
                       ) sub),
                      '[]'::jsonb
                    ),
    'last_seen_at', d.last_seen_at,
    'support',      (select jsonb_build_object(
                              'unread',          coalesce((
                                select count(*) from public.support_messages m
                                 where m.dsp_id = d.id
                                   and m.sender_kind = 'dsp'
                                   and (sc.admin_last_read_at is null or m.created_at > sc.admin_last_read_at)
                              ), 0),
                              'last_message_at', sc.last_message_at,
                              'last_message',    (select m.body from public.support_messages m
                                                   where m.dsp_id = d.id
                                                   order by m.created_at desc limit 1)
                            )
                       from public.support_conversations sc
                      where sc.dsp_id = d.id)
  )
    into v
    from public.dsps d
   where d.id = p_dsp_id;

  return v;
end;
$$;

grant execute on function public.admin_dsp_detail(uuid) to authenticated;
