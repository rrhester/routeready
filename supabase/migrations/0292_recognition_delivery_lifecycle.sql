-- Migration 0292 · Recognition delivery lifecycle + Welcome-to-the-team
--
-- Builds the wiring needed for the first Recognition Celebration Event:
-- "Welcome to the Team".  When a dispatcher schedules one, the driver
-- sees a full-screen celebration overlay the next time they open the
-- app.  Generalises cleanly to every future event kind because the
-- delivery lifecycle (queued → delivered → opened → dismissed) lives
-- on the row, not the kind.
--
-- Adds to driver_recognitions:
--   delivered_at  — first time the driver app fetched + displayed it
--   opened_at     — driver saw the animation finish (same moment today)
--   dismissed_at  — driver tapped the CTA or closed the overlay
--   metadata      — free-form jsonb (sender note, future event params)
--
-- Adds driver-token RPCs (anon + authenticated, security definer):
--   driver_recognitions_pending(p_token)
--      → oldest sent-but-not-dismissed recognition, decorated with
--        everything CelebrationOverlay needs (title, message, animation,
--        cta_label, footer, kind, metadata).
--   driver_recognition_delivered(p_token, p_id)
--      → marks delivered_at + opened_at (idempotent — won't overwrite
--        an existing value).
--   driver_recognition_dismiss(p_token, p_id)
--      → marks dismissed_at; subsequent opens will not replay the event.
--
-- Extends recognition_send to accept the new 'welcome_to_team' kind and
-- to default sensibly when title/message are blank.
--
-- Safe to re-run: every DDL is guarded; every function is CREATE OR
-- REPLACE.


-- ── 1. driver_recognitions · delivery columns ───────────────────────
alter table public.driver_recognitions
  add column if not exists delivered_at  timestamptz,
  add column if not exists opened_at     timestamptz,
  add column if not exists dismissed_at  timestamptz,
  add column if not exists metadata      jsonb not null default '{}'::jsonb;

-- The driver pending lookup hits the "oldest sent, not dismissed,
-- targeted at this driver" path.  This partial index keeps it cheap
-- even as the table grows.
create index if not exists driver_recognitions_pending_idx
  on public.driver_recognitions (driver_id, sent_at asc)
  where status = 'sent' and dismissed_at is null;


-- ── 2. recognition_send · accepts welcome_to_team ───────────────────
-- Same shape as 0290, with welcome_to_team added to the kind whitelist
-- and slightly nicer defaults for that kind.  We also expose
-- p_metadata so the dashboard can attach a sender note / theme without
-- a schema change.
create or replace function public.recognition_send(
  p_driver_id    uuid,
  p_kind         text default 'custom',
  p_title        text default null,
  p_message      text default null,
  p_animation    text default 'confetti',
  p_occasion_on  date default null,
  p_scheduled_for date default null,
  p_years        int  default null,
  p_milestone_key text default null,
  p_metadata     jsonb default '{}'::jsonb
) returns public.driver_recognitions
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_row   public.driver_recognitions;
  v_title text;
  v_kind  text := coalesce(nullif(trim(p_kind), ''), 'custom');
  v_anim  text := coalesce(nullif(trim(p_animation), ''), 'confetti');
  v_today date := current_date;
  v_status text;
  v_sent_at timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_driver_id is null then
    raise exception 'driver_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_kind not in ('birthday','work_anniversary','safety_milestone','welcome_to_team','custom') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v_anim not in ('confetti','fireworks','balloons','cake','trophy','hearts','sparkle','welcome','custom') then
    raise exception 'bad_animation' using errcode = '22023';
  end if;

  v_title := nullif(trim(coalesce(p_title, '')), '');
  if v_title is null then
    v_title := case v_kind
      when 'birthday'         then 'Happy birthday!'
      when 'work_anniversary' then case when p_years is null then 'Happy work anniversary!'
                                       else p_years || '-year anniversary' end
      when 'safety_milestone' then 'Safety milestone'
      when 'welcome_to_team'  then 'Welcome to the Team'
      else 'A note from your team'
    end;
  end if;

  if p_scheduled_for is null or p_scheduled_for <= v_today then
    v_status  := 'sent';
    v_sent_at := now();
  else
    v_status  := 'scheduled';
    v_sent_at := null;
  end if;

  insert into public.driver_recognitions (
    dsp_id, driver_id, kind, title, message, animation,
    occasion_on, scheduled_for, sent_at, status, years, milestone_key,
    metadata, created_by
  ) values (
    v_dsp, p_driver_id, v_kind, v_title, nullif(trim(p_message), ''),
    v_anim,
    coalesce(p_occasion_on, p_scheduled_for, v_today),
    p_scheduled_for, v_sent_at, v_status, p_years,
    nullif(trim(p_milestone_key), ''),
    coalesce(p_metadata, '{}'::jsonb),
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.recognition_send(uuid, text, text, text, text, date, date, int, text, jsonb) to authenticated;


-- ── 3. driver_recognitions_pending(p_token) ─────────────────────────
-- Returns the OLDEST sent-but-not-dismissed recognition targeted at
-- the driver behind p_token, decorated with everything the
-- CelebrationOverlay needs to render and a per-kind CTA / footer.
-- Returns jsonb null if nothing is pending — the driver app uses that
-- to short-circuit without a second round-trip.
--
-- We never expose a second pending event in a single call: the spec
-- says "show only one per app open/session to avoid overwhelming the
-- driver".  If multiple are queued, the driver gets them on
-- subsequent opens, oldest first.
create or replace function public.driver_recognitions_pending(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.driver_recognitions;
  v_cta text;
  v_footer text;
begin
  v_drv := private.driver_validate_token(p_token);
  if v_drv.role is distinct from 'driver' then
    return null;
  end if;

  select * into v_row
  from public.driver_recognitions
  where driver_id = v_drv.id
    and status = 'sent'
    and sent_at is not null
    and dismissed_at is null
  order by sent_at asc
  limit 1;

  if v_row.id is null then return null; end if;

  -- Per-kind CTA + footer.  Custom kinds fall back to a generic
  -- "Continue" — the dashboard send modal could expose a CTA override
  -- later via metadata.cta_label, which we honour here.
  v_cta := coalesce(
    nullif(trim(v_row.metadata->>'cta_label'), ''),
    case v_row.kind
      when 'welcome_to_team'  then 'Start my day'
      when 'birthday'         then 'Thanks!'
      when 'work_anniversary' then 'Thanks!'
      when 'safety_milestone' then 'Keep it up'
      else 'Continue'
    end
  );
  v_footer := coalesce(
    nullif(trim(v_row.metadata->>'footer'), ''),
    'Sent by your team'
  );

  return jsonb_build_object(
    'id',          v_row.id,
    'kind',        v_row.kind,
    'title',       v_row.title,
    'message',     v_row.message,
    'animation',   v_row.animation,
    'cta_label',   v_cta,
    'footer',      v_footer,
    'years',       v_row.years,
    'metadata',    v_row.metadata,
    'sent_at',     v_row.sent_at,
    'delivered_at',v_row.delivered_at
  );
end;
$$;
grant execute on function public.driver_recognitions_pending(text) to anon, authenticated;


-- ── 4. driver_recognition_delivered(p_token, p_id) ──────────────────
-- Idempotent.  The driver app calls this the moment CelebrationOverlay
-- mounts — sets delivered_at + opened_at if either is null but does
-- NOT overwrite existing values (prevents rapid-reload double-marking).
-- Returns true if the row exists for this driver, false otherwise.
create or replace function public.driver_recognition_delivered(p_token text, p_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_n   int;
begin
  v_drv := private.driver_validate_token(p_token);
  update public.driver_recognitions
     set delivered_at = coalesce(delivered_at, now()),
         opened_at    = coalesce(opened_at,    now()),
         updated_at   = now()
   where id = p_id and driver_id = v_drv.id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
grant execute on function public.driver_recognition_delivered(text, uuid) to anon, authenticated;


-- ── 5. driver_recognition_dismiss(p_token, p_id) ────────────────────
-- Driver tapped the CTA or closed the overlay.  Marks dismissed_at so
-- subsequent app opens skip this event.  Also stamps delivered/opened
-- if the driver dismissed faster than the delivered-mark round trip.
create or replace function public.driver_recognition_dismiss(p_token text, p_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_n   int;
begin
  v_drv := private.driver_validate_token(p_token);
  update public.driver_recognitions
     set dismissed_at = coalesce(dismissed_at, now()),
         delivered_at = coalesce(delivered_at, now()),
         opened_at    = coalesce(opened_at,    now()),
         updated_at   = now()
   where id = p_id and driver_id = v_drv.id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
grant execute on function public.driver_recognition_dismiss(text, uuid) to anon, authenticated;


-- ── 6. recognition_list · expose delivery timestamps ────────────────
-- Tiny refresh so the dashboard History tab can show "opened 5m ago"
-- / "dismissed" rather than only the status enum.  Same shape + an
-- extra `delivered_at` / `opened_at` / `dismissed_at` field per row.
create or replace function public.recognition_list(
  p_status text default null,
  p_limit  int  default 200
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'occurs_at' desc nulls last), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',            r.id,
      'driver_id',     r.driver_id,
      'driver_name',   coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver'),
      'photo_path',    d.photo_path,
      'kind',          r.kind,
      'title',         r.title,
      'message',       r.message,
      'animation',     r.animation,
      'occasion_on',   r.occasion_on,
      'scheduled_for', r.scheduled_for,
      'sent_at',       r.sent_at,
      'delivered_at',  r.delivered_at,
      'opened_at',     r.opened_at,
      'dismissed_at',  r.dismissed_at,
      'read_at',       r.read_at,
      'status',        r.status,
      'years',         r.years,
      'occurs_at',     coalesce(r.sent_at::date, r.scheduled_for, r.occasion_on, r.created_at::date),
      'created_at',    r.created_at
    ) j
    from public.driver_recognitions r
    join public.drivers d on d.id = r.driver_id
    where r.dsp_id = private.current_dsp_id()
      and private.is_staff(r.dsp_id, 'dispatcher')
      and (
        p_status is null
        or p_status = 'all'
        or r.status = p_status
      )
    order by coalesce(r.sent_at, (r.scheduled_for + time '00:00')::timestamptz, r.created_at) desc
    limit greatest(p_limit, 1)
  ) t;
$$;
grant execute on function public.recognition_list(text, int) to authenticated;


notify pgrst, 'reload schema';
