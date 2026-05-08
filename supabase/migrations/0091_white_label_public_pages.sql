-- Public-facing pages (screening form, driver coaching record, referral
-- landing) should display the operator's DSP name instead of the
-- "RouteReady" platform brand. Each of these pages already calls a
-- security-definer RPC to load its data — extend each one to include
-- the DSP name in its response so the front-end can swap the brand
-- string at render time. Updates to dsps.name from the dashboard flow
-- through immediately because the lookup is per-call.

-- ─── screening_load ─────────────────────────────────────────────────────

create or replace function public.screening_load(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_app public.applicants;
  v_dsp public.dsps;
  v_questions jsonb;
  v_video jsonb;
begin
  v_app := private.applicant_for_token('screening', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  if v_app.status in ('rejected','auto_declined','hired','no_show','not_hired') then
    raise exception 'screening_closed';
  end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'prompt', q.prompt, 'field_type', q.field_type,
    'options', q.options, 'required', q.required, 'display_order', q.display_order
  ) order by q.display_order), '[]'::jsonb)
  into v_questions
  from public.screening_questions q
  where q.dsp_id = v_app.dsp_id and q.active = true;

  v_video := coalesce(v_dsp.metadata->'video', '{}'::jsonb);

  return jsonb_build_object(
    'dsp', jsonb_build_object(
      'name', v_dsp.name,
      'short_code', v_dsp.short_code
    ),
    'applicant', jsonb_build_object(
      'id', v_app.id,
      'first_name', v_app.first_name,
      'full_name', v_app.full_name,
      'status', v_app.status
    ),
    'questions', v_questions,
    'video', jsonb_build_object(
      'enabled', coalesce((v_video->>'enabled')::boolean, true),
      'prompt',  coalesce(v_video->>'prompt',
                          'Tell us about yourself and why you''d be a great fit for our team.'),
      'max_seconds', coalesce((v_video->>'max_seconds')::int, 60)
    )
  );
end;
$$;

grant execute on function public.screening_load(text) to anon, authenticated;


-- ─── coaching_for_driver_token ──────────────────────────────────────────
-- Add dsp_name to every returned row so the driver-facing coaching page
-- can render the DSP name without a second round-trip.
--
-- Drop first because CREATE OR REPLACE FUNCTION can't change the
-- RETURNS TABLE shape — the function already exists from migration
-- 0038 with one fewer column.

drop function if exists public.coaching_for_driver_token(text);

create or replace function public.coaching_for_driver_token(p_token text)
returns table (
  id                uuid,
  occurred_at       timestamptz,
  topic             text,
  type              text,
  severity          text,
  summary           text,
  notes             text,
  action_taken      jsonb,
  coached_by_name   text,
  acknowledgment    text,
  acknowledged_at   timestamptz,
  driver_full_name  text,
  dsp_name          text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_dsp public.dsps;
begin
  select * into v_drv from public.drivers where coaching_view_token = p_token;
  if not found then raise exception 'invalid token' using errcode = '42501'; end if;

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  return query
  select c.id, c.occurred_at,
         c.topic::text, c.type::text, c.severity::text,
         c.summary, c.notes, c.action_taken,
         c.coached_by_name,
         c.acknowledgment::text, c.acknowledged_at,
         v_drv.full_name,
         v_dsp.name
    from public.coachings c
   where c.driver_id = v_drv.id
     and c.driver_visible = true
     and c.archived_at is null
     and c.privacy_tier = 'standard'
   order by c.occurred_at desc;
end $$;

grant execute on function public.coaching_for_driver_token(text) to anon, authenticated;


-- ─── referrer_lookup ────────────────────────────────────────────────────
-- Public referral landing page needs DSP name + referrer name.

create or replace function public.referrer_lookup(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when d.id is not null
    then jsonb_build_object(
           'full_name',  d.full_name,
           'first_name', d.first_name,
           'dsp_name',   ds.name
         )
    else jsonb_build_object('error', 'invalid_or_expired_token')
  end
  from (select 1) one
  left join public.drivers d on d.referral_token = p_token
  left join public.dsps ds   on ds.id = d.dsp_id
  limit 1;
$$;

grant execute on function public.referrer_lookup(text) to anon, authenticated;
