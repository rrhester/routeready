-- Migration 0141 · New DSPs inherit RouteReady's screening Qs + hiring messages
--
-- A DSP created from the admin screen used to start with no screening
-- questions and no hiring-message templates — a blank pipeline.  Now it's
-- seeded from RouteReady's own DSP (the platform admin's), so a new client
-- launches with the standard funnel config in place and can tweak from
-- there.

create or replace function private.template_dsp_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select u.dsp_id from public.app_users u
       where u.role = 'platform_admin' and u.dsp_id is not null
       order by u.created_at limit 1),
    (select d.id from public.dsps d where d.short_code = 'DEMO' limit 1)
  );
$$;


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
  v_tmpl uuid;
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

  -- Seed the new DSP's screening questions + hiring-message templates from
  -- RouteReady's DSP so it starts configured, not empty.
  v_tmpl := private.template_dsp_id();
  if v_tmpl is not null and v_tmpl <> v_id then
    insert into public.screening_questions
      (dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active)
      select v_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active
        from public.screening_questions where dsp_id = v_tmpl;

    insert into public.message_templates
      (dsp_id, channel, key, name, subject, body, active)
      select v_id, channel, key, name, subject, body, active
        from public.message_templates where dsp_id = v_tmpl
      on conflict (dsp_id, channel, key) do update
        set name = excluded.name, subject = excluded.subject, body = excluded.body, active = excluded.active;
  end if;

  return v_id;
end;
$$;
grant execute on function public.admin_create_dsp(text, text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
