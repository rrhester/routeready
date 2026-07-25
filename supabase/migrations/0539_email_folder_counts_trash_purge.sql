-- 0539_email_folder_counts_trash_purge.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · folders batch F (Email review EM#63/66)
--
--   1. email_folder_unread_counts() — one round-trip per-folder unread
--      counts (EM#66). Replaces the client's N sequential HEAD queries
--      per refresh/realtime event; also powers the sidebar nav dot and
--      the honest header counts. Requires 0535's is_read.
--   2. purge-email-trash cron (EM#63) — messages sitting in a Trash
--      folder for 30+ days are permanently deleted nightly. updated_at
--      is bumped by trg_email_messages_updated_at (0003) on the
--      move-to-trash PATCH, so it is a safe entered-trash proxy.
--
-- Graceful pre-migration: the client falls back to the per-folder
-- HEAD-count loop; trash simply never auto-purges.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

create or replace function public.email_folder_unread_counts()
returns table (folder_id uuid, unread int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select m.folder_id, count(*)::int
    from public.email_messages m
   where m.dsp_id = v_dsp
     and m.folder_id is not null
     and m.direction = 'inbound'
     and m.is_read = false
   group by m.folder_id;
end $$;

grant execute on function public.email_folder_unread_counts() to authenticated;

create or replace function private.purge_email_trash()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.email_messages m
   using public.fb_folders f
   where m.folder_id = f.id
     and f.kind = 'trash'
     and m.updated_at < now() - interval '30 days';
$$;

do $$ begin
  perform cron.unschedule('purge-email-trash');
exception when others then null; end $$;
select cron.schedule(
  'purge-email-trash',
  '17 4 * * *',
  $cron$ select private.purge_email_trash(); $cron$
);
