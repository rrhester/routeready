-- Migration 0246 · DVIC AI safety net.
--
-- Two pieces:
--   1. Inspections with no photos auto-skip — they sit `pending`
--      forever otherwise.  An AFTER INSERT trigger writes
--      ai_review_status = 'skipped' if photos is null / empty.
--      Also retroactively flips any existing photoless `pending`
--      rows so the queue isn't dirty.
--   2. A pg_cron job every 5 minutes that picks up any inspections
--      still `pending` after 2+ minutes with photos and re-fires
--      the AI review.  Backstops the AFTER INSERT trigger so a
--      transient pg_net hiccup doesn't strand a row forever.
--
-- Idempotent.

-- ── pg_cron extension ────────────────────────────────────────────────
create extension if not exists pg_cron with schema cron;


-- ── 1. Auto-skip no-photo inspections ───────────────────────────────
-- Backfill any existing photoless `pending` rows first.
update public.vehicle_inspections
   set ai_review_status = 'skipped',
       ai_review_summary = coalesce(ai_review_summary, 'No photos available for review.'),
       ai_review_at = now(),
       updated_at = now()
 where ai_review_status = 'pending'
   and (photos is null or jsonb_array_length(coalesce(photos, '[]'::jsonb)) = 0);

-- Trigger: flip future no-photo inserts to 'skipped' immediately.
-- We can't piggyback on dvic_after_inspection_insert because it's
-- AFTER INSERT and we'd be mutating NEW too late.  Use a BEFORE
-- INSERT trigger that adjusts ai_review_status when no photos.
create or replace function private.dvic_before_inspection_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.photos is null
     or jsonb_array_length(coalesce(new.photos, '[]'::jsonb)) = 0 then
    if coalesce(new.ai_review_status, 'pending') = 'pending' then
      new.ai_review_status := 'skipped';
      new.ai_review_summary := coalesce(new.ai_review_summary, 'No photos available for review.');
      new.ai_review_at := coalesce(new.ai_review_at, now());
    end if;
  end if;
  return new;
end $$;

drop trigger if exists dvic_before_inspection_insert on public.vehicle_inspections;
create trigger dvic_before_inspection_insert
  before insert on public.vehicle_inspections
  for each row
  execute function private.dvic_before_inspection_insert();


-- ── 2. AI sweep · picks up stuck pending rows ───────────────────────
-- Definition of "stuck":
--   · ai_review_status = 'pending'
--   · photos is non-empty
--   · created > 2 minutes ago (don't race the AFTER INSERT trigger)
-- For each stuck row we re-fire private.dvic_request_ai_review.  The
-- Edge Function itself is idempotent — it just overwrites the row's
-- ai_review_* fields with the latest verdict.
create or replace function private.dvic_ai_sweep()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_row record;
  v_count int := 0;
begin
  for v_row in
    select id
      from public.vehicle_inspections
     where ai_review_status = 'pending'
       and photos is not null
       and jsonb_array_length(photos) > 0
       and created_at < now() - interval '2 minutes'
     order by inspected_at asc
     limit 20
  loop
    perform private.dvic_request_ai_review(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
grant execute on function private.dvic_ai_sweep() to authenticated;

-- Schedule the sweep every 5 minutes.  Drop any existing schedule
-- under the same name first so re-running this migration doesn't
-- duplicate the job.
do $$
begin
  perform cron.unschedule('dvic-ai-sweep');
exception when others then
  null;
end $$;

select cron.schedule(
  'dvic-ai-sweep',
  '*/5 * * * *',
  $cron$ select private.dvic_ai_sweep(); $cron$
);
