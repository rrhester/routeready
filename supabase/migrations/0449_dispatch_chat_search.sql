-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0449 · Full-text-ish search across driver chat history
--
-- The Messages > Conversations search box filters the loaded inbox rows
-- client-side by driver name + latest-message preview only. This adds a
-- server RPC so an operator can find a conversation by anything ever said
-- in it — not just the last line — including drivers not currently in the
-- loaded list.
--
-- Substring (ILIKE) matching mirrors what operators expect from a chat
-- search ("sched" finds "schedule"); a pg_trgm GIN index on the message
-- body keeps it fast at scale. pg_trgm is already enabled (0001).
--
-- Idempotent: create index if not exists + create or replace function.
-- ─────────────────────────────────────────────────────────────────────────

-- Trigram index accelerates the ILIKE '%…%' scan on message bodies.
-- gin_trgm_ops is left unqualified so it resolves via search_path whether
-- pg_trgm was installed into public or the extensions schema.
create index if not exists driver_messages_body_trgm
  on public.driver_messages using gin (body gin_trgm_ops);

-- dispatch_chat_search(p_query, p_limit)
--   Returns, per matching driver, the MOST RECENT message whose body
--   matches p_query, with a short snippet centred on the hit. Scoped to
--   the caller's DSP and gated to dispatcher+ staff, same as the rest of
--   the dispatch_chat_* family. Soft-deleted messages are excluded.
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

  -- Too-short queries would match almost everything; the client also
  -- gates on length, but guard here too.
  if length(v_q) < 2 then
    return '[]'::jsonb;
  end if;

  -- Escape LIKE wildcards in the user's text so "50%" or "a_b" search
  -- literally instead of acting as patterns.
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with hits as (
    select distinct on (d.id)
      d.id                                                      as driver_id,
      coalesce(nullif(btrim(d.preferred_name), ''), d.full_name) as name,
      s.code                                                    as station_code,
      d.status                                                  as status,
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
      'sender_kind',  sender_kind,
      'message_at',   message_at,
      -- Snippet: whole body if short, otherwise a ~140-char window that
      -- starts a little before the match so the hit is visible in context.
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
