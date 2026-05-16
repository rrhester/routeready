-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0254 · Resolve pre-existing driver phone duplicates
--
-- 0253 added a partial unique index on (dsp_id, phone_normalized) for
-- non-terminated drivers, but production already has at least one
-- (dsp_id, phone) collision (demo DSP, phone 417-597-6776), so the
-- index creation in 0253 raises 23505 and the whole migration may
-- abort.  This patch:
--
--   1. Idempotently re-establishes the columns/trigger from 0253 in
--      case the failed run rolled them back.
--   2. Picks a canonical "owner" per duplicate phone within each DSP,
--      NULLs phone_normalized on the losers (the trigger only fires
--      on changes to drivers.phone, not on phone_normalized, so this
--      write sticks).
--   3. Creates the unique index.
--
-- Selection rule (best row wins; loser's phone_normalized becomes NULL):
--   • Prefer non-terminated over terminated
--   • Prefer active > onboarding > leave > inactive > terminated
--   • Prefer the row with an applicant_id (came from hire pipeline)
--   • Prefer most-recent updated_at
--   • Final tiebreak: lower id (deterministic)
--
-- Losers keep their drivers.phone string — only the normalized lookup
-- key is nulled — so historical reports still show the phone they had.
-- A dispatcher who later wants the loser row to "own" that phone can
-- re-save the phone field through the dashboard; the trigger will
-- re-populate phone_normalized, and (if no current owner exists for
-- that pair) the unique index will accept it.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Re-establish columns + trigger (idempotent — no-op if 0253 stuck)

alter table public.drivers
  add column if not exists phone_normalized   text,
  add column if not exists pin_hash           text,
  add column if not exists pin_set_at         timestamptz,
  add column if not exists activated_at       timestamptz,
  add column if not exists applicant_snapshot jsonb not null default '{}'::jsonb;

create or replace function private.normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  with d as (
    select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when length(digits) < 10 then null
    when length(digits) = 11 and left(digits, 1) = '1' then right(digits, 10)
    else right(digits, 10)
  end
  from d;
$$;

create or replace function private.drivers_normalize_phone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.phone_normalized := private.normalize_phone(new.phone);
  return new;
end;
$$;

drop trigger if exists trg_drivers_normalize_phone on public.drivers;
create trigger trg_drivers_normalize_phone
  before insert or update of phone on public.drivers
  for each row execute function private.drivers_normalize_phone();

update public.drivers
   set phone_normalized = private.normalize_phone(phone)
 where phone is not null and phone_normalized is null;


-- ── 2. Demote losers in each duplicate group ─────────────────────────

do $$
declare
  v_index_exists boolean;
  v_demoted int;
begin
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'drivers_dsp_phone_unique'
  ) into v_index_exists;

  if v_index_exists then
    raise notice '0254: unique index already in place — no duplicates to resolve';
    return;
  end if;

  with ranked as (
    select id,
           dsp_id,
           phone_normalized,
           row_number() over (
             partition by dsp_id, phone_normalized
             order by
               (status = 'terminated')::int asc,
               case status
                 when 'active'      then 0
                 when 'onboarding'  then 1
                 when 'leave'       then 2
                 when 'inactive'    then 3
                 when 'terminated'  then 4
                 else 5
               end asc,
               (applicant_id is null)::int asc,
               updated_at desc,
               id asc
           ) as rn,
           count(*) over (partition by dsp_id, phone_normalized) as group_size
    from public.drivers
    where phone_normalized is not null
      and status <> 'terminated'
  ),
  losers as (
    select id from ranked where group_size > 1 and rn > 1
  )
  update public.drivers d
     set phone_normalized = null,
         updated_at = now()
   from losers l
   where d.id = l.id;

  get diagnostics v_demoted = row_count;
  raise notice '0254: demoted % loser row(s); creating unique index now', v_demoted;
end $$;


-- ── 3. Create the unique index ───────────────────────────────────────

create unique index if not exists drivers_dsp_phone_unique
  on public.drivers (dsp_id, phone_normalized)
  where phone_normalized is not null and status <> 'terminated';

notify pgrst, 'reload schema';
