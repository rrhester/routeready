-- Migration 0294 · driver_recognitions_pending · drop STABLE marker
--
-- The pending lookup was declared STABLE, but it calls
-- private.driver_validate_token which writes to driver_sessions
-- (updates last_seen_at).  Postgres rejects the call at runtime with
-- "cannot execute UPDATE in a read-only transaction" because a
-- STABLE function cannot perform writes — directly or transitively.
--
-- Other driver-token RPCs in the codebase (driver_me, driver_chat_list,
-- driver_list_forms, etc.) use plain `language plpgsql security definer`
-- with no volatility marker (Postgres default: VOLATILE).  Match that.

create or replace function public.driver_recognitions_pending(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
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
