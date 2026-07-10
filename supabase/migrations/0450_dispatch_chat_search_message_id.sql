-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0450 · dispatch_chat_search returns the matched message id
--
-- 0449 returned the most-recent matching message per driver (snippet +
-- timestamp) but not its id, so the dashboard could open the thread but
-- not jump to the exact message. Add 'message_id' so clicking a search
-- result can scroll to and highlight the matched bubble.
--
-- Pure create-or-replace; the trigram index from 0449 is unchanged.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.dispatch_chat_search(p_query text, p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_q    text := btrim(coalesce(p_query, ''));
  v_like text;
  v_lim  int  := greatest(1, least(50, coalesce(p_limit, 30)));
  v_result jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if length(v_q) < 2 then
    return '[]'::jsonb;
  end if;

  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with hits as (
    select distinct on (d.id)
      d.id                                                      as driver_id,
      coalesce(nullif(btrim(d.preferred_name), ''), d.full_name) as name,
      s.code                                                    as station_code,
      d.status                                                  as status,
      m.id                                                      as message_id,
      m.body                                                    as body,
      m.sender_kind                                             as sender_kind,
      m.created_at                                              as message_at
    from public.driver_messages m
    join public.drivers d on d.id = m.driver_id
    left join public.stations s on s.id = d.station_id
    where m.dsp_id = v_dsp
      and d.dsp_id = v_dsp
      and m.deleted_at is null
      and m.body ilike v_like escape '\'
    order by d.id, m.created_at desc
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'driver_id',    driver_id,
      'name',         name,
      'station_code', station_code,
      'status',       status,
      'message_id',   message_id,
      'sender_kind',  sender_kind,
      'message_at',   message_at,
      'snippet',      case
                        when length(body) <= 140 then body
                        else '…' || substr(
                               body,
                               greatest(1, position(lower(v_q) in lower(body)) - 30),
                               140
                             ) || '…'
                      end
    ) order by message_at desc
  ), '[]'::jsonb)
  into v_result
  from (select * from hits order by message_at desc limit v_lim) ranked;

  return v_result;
end;
$$;

grant execute on function public.dispatch_chat_search(text, int) to authenticated;

notify pgrst, 'reload schema';
