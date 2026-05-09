-- Two related fixes for the platform admin surface:
--
-- 1. Auto-generate dsps.short_code so the operator doesn't have to
--    play whack-a-mole with collisions.  Many DSPs operate out of
--    the same Amazon station (DCA1, DBO5, etc.) so a globally-unique
--    short code can't be the operator's mental model.  We keep the
--    UNIQUE constraint (other code paths look DSPs up by short_code)
--    but pick the value server-side from the DSP name + a numeric
--    suffix when needed.
--
-- 2. Fix the "column reference 'created_at' is ambiguous" error in
--    admin_list_dsps.  PL/pgSQL functions with RETURNS TABLE
--    introduce the output column names as OUT-scope variables.  An
--    unqualified `created_at` inside an inner subquery's ORDER BY
--    is then ambiguous between the OUT variable and the joined-from
--    table's column.  Fix by qualifying every column with its table
--    alias inside the function body.

-- ─── 1. Auto short_code helpers + admin_create_dsp ────────────────────────
create or replace function private.dsp_short_code_base(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare v text;
begin
  v := upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]', '', 'g'));
  v := substring(v from 1 for 8);
  if length(v) < 2 then v := 'DSP'; end if;
  return v;
end;
$$;

create or replace function private.dsp_unique_short_code(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base      text := private.dsp_short_code_base(p_name);
  v_candidate text;
  v_n         int := 0;
begin
  v_candidate := v_base;
  while exists (select 1 from public.dsps d where d.short_code = v_candidate) loop
    v_n := v_n + 1;
    if v_n > 99 then
      -- 99 collisions on the same base is improbable; fall back to
      -- a timestamp suffix so we never raise back to the operator.
      v_candidate := substring(v_base from 1 for 4) || to_char(clock_timestamp(), 'MISSMS');
      exit;
    end if;
    v_candidate := substring(v_base from 1 for 6) || lpad(v_n::text, 2, '0');
  end loop;
  return v_candidate;
end;
$$;

-- Re-issue admin_create_dsp.  p_short_code is now optional; when null
-- or empty, server generates a unique code.  When provided, the
-- operator's choice is still respected (and will collide loudly if
-- they pick something already taken — same as before).
create or replace function public.admin_create_dsp(
  p_name              text,
  p_short_code        text    default null,
  p_owner_email       text    default null,
  p_owner_name        text    default null,
  p_phone             text    default null,
  p_address           text    default null,
  p_subscription_plan text    default 'starter',
  p_notes             text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_code text;
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden';
  end if;
  if p_subscription_plan not in ('starter', 'growth', 'enterprise') then
    raise exception 'invalid subscription_plan: %', p_subscription_plan;
  end if;

  v_code := upper(coalesce(nullif(trim(p_short_code), ''), ''));
  if v_code = '' then
    v_code := private.dsp_unique_short_code(p_name);
  end if;

  insert into public.dsps (name, short_code, status, subscription_plan, phone, address, notes)
    values (p_name, v_code, 'pending', p_subscription_plan, p_phone, p_address, p_notes)
    returning id into v_id;

  if p_owner_email is not null and p_owner_email <> '' then
    update public.dsps
       set metadata = metadata || jsonb_build_object(
                        'pending_owner', jsonb_build_object(
                          'email',     p_owner_email,
                          'full_name', coalesce(p_owner_name, '')
                        )
                      )
     where id = v_id;
  end if;

  return v_id;
end;
$$;

grant execute on function public.admin_create_dsp(text, text, text, text, text, text, text, text) to authenticated;

-- ─── 2. Fix ambiguous created_at in admin_list_dsps ───────────────────────
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
        where u.dsp_id = d.id and u.role::text = 'owner' and u.active = true
        order by u.created_at limit 1),
      (select u.full_name    from public.app_users u
        where u.dsp_id = d.id and u.role::text = 'owner' and u.active = true
        order by u.created_at limit 1),
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
