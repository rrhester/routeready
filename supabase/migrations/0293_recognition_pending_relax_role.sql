-- Migration 0293 · driver_recognitions_pending · relax role gate
--
-- The 0292 version returned null when the drivers row's `role` was
-- anything other than 'driver'.  In practice a DSP owner / dispatcher
-- often has their own row in `drivers` with role='owner' or
-- 'dispatcher' (so they can drive routes, get on the schedule, etc.)
-- — the role gate blocked those rows from seeing their own queued
-- celebrations, even though the row exists and dismissed_at is null.
--
-- Server-side scope is already enforced — driver_id = v_drv.id — so a
-- driver can only ever see celebrations addressed to their own row.
-- Anyone with a valid driver token IS that driver; if a recognition
-- is queued for them, they should see it regardless of the role
-- column.

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
  if v_drv.id is null then return null; end if;

  select * into v_row
  from public.driver_recognitions
  where driver_id = v_drv.id
    and status = 'sent'
    and sent_at is not null
    and dismissed_at is null
  order by sent_at asc
  limit 1;

  if v_row.id is null then return null; end if;

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

notify pgrst, 'reload schema';
