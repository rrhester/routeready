-- Migration 0136 · Hiring targets — the pipeline ↔ schedule bridge
--
-- The Staffing-outlook page can see a structural gap ("short ~2 Saturday
-- drivers over the next month").  This makes that into something the
-- Pipeline page can track: a hiring target — N drivers who can cover a
-- set of days, optionally start by a certain time and hold a service-type
-- cert.  hiring_target_list() also reports which onboarding drivers
-- currently match each target, so the Pipeline page can show progress
-- ("Sat/Sun: 1 of 2 — Devon (onboarding ✓), need 1 more").

create table if not exists public.hiring_targets (
  id                 uuid primary key default gen_random_uuid(),
  dsp_id             uuid not null references public.dsps(id) on delete cascade,
  label              text not null default '',
  needed_count       int  not null default 1 check (needed_count between 1 and 100),
  days               text[] not null default '{}',     -- day-of-week keys the hire must cover (subset of mon..sun)
  earliest_start_max time,                              -- nullable: latest start-of-day time the hire may have
  service_type_id    uuid references public.service_types(id) on delete set null,
  notes              text,
  status             text not null default 'open' check (status in ('open','filled','cancelled')),
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists hiring_targets_dsp_status_idx on public.hiring_targets(dsp_id, status);

drop trigger if exists trg_hiring_targets_updated_at on public.hiring_targets;
create trigger trg_hiring_targets_updated_at
  before update on public.hiring_targets
  for each row execute function private.set_updated_at();

alter table public.hiring_targets enable row level security;
drop policy if exists "hiring_targets_tenant_rw" on public.hiring_targets;
create policy "hiring_targets_tenant_rw" on public.hiring_targets for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.hiring_targets to authenticated;


-- ── hiring_target_upsert(payload) ──────────────────────────────────────
-- payload: { id?, label?, needed_count?, days?[], earliest_start_max?,
--            service_type_id?, notes?, status? }.  id present → update.
create or replace function public.hiring_target_upsert(p_payload jsonb)
returns public.hiring_targets
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_id         uuid := nullif(p_payload->>'id','')::uuid;
  v_status     text := lower(coalesce(nullif(trim(p_payload->>'status'),''),'open'));
  v_valid_keys text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days       text[];
  v_es         time;
  v_st         uuid := nullif(p_payload->>'service_type_id','')::uuid;
  v_row        public.hiring_targets;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode='42501'; end if;
  if v_status not in ('open','filled','cancelled') then v_status := 'open'; end if;

  select coalesce(array_agg(k order by array_position(v_valid_keys, k)), '{}'::text[]) into v_days
    from (select distinct jsonb_array_elements_text(coalesce(p_payload->'days','[]'::jsonb)) k) x
   where k = any(v_valid_keys);

  if coalesce(p_payload->>'earliest_start_max','') ~ '^[0-9]{1,2}:[0-9]{2}$' then
    begin v_es := (p_payload->>'earliest_start_max')::time; exception when others then v_es := null; end;
  end if;

  if v_id is not null then
    update public.hiring_targets
       set label              = coalesce(nullif(trim(p_payload->>'label'),''), label),
           needed_count       = greatest(1, least(100, coalesce((p_payload->>'needed_count')::int, needed_count))),
           days               = v_days,
           earliest_start_max = v_es,
           service_type_id    = v_st,
           notes              = nullif(trim(p_payload->>'notes'),''),
           status             = v_status
     where id = v_id and dsp_id = v_dsp
     returning * into v_row;
    if v_row.id is null then raise exception 'not_found' using errcode='P0002'; end if;
  else
    insert into public.hiring_targets (dsp_id, label, needed_count, days, earliest_start_max, service_type_id, notes, status, created_by)
    values (v_dsp,
            coalesce(nullif(trim(p_payload->>'label'),''), ''),
            greatest(1, least(100, coalesce((p_payload->>'needed_count')::int, 1))),
            v_days, v_es, v_st, nullif(trim(p_payload->>'notes'),''), v_status, auth.uid())
    returning * into v_row;
  end if;
  return v_row;
end;
$$;
grant execute on function public.hiring_target_upsert(jsonb) to authenticated;


-- ── hiring_target_list() ───────────────────────────────────────────────
-- Each target + the onboarding drivers that currently satisfy it (can
-- cover its days, start early enough, hold any required cert).
create or replace function public.hiring_target_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode='42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',                 t.id,
      'label',              t.label,
      'needed_count',       t.needed_count,
      'days',               to_jsonb(t.days),
      'earliest_start_max', case when t.earliest_start_max is null then null else substr(t.earliest_start_max::text, 1, 5) end,
      'service_type_id',    t.service_type_id,
      'service_type_code',  s.code,
      'service_type_label', s.label,
      'notes',              t.notes,
      'status',             t.status,
      'created_at',         t.created_at,
      'matched', coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'name', coalesce(nullif(trim(d.preferred_name), ''), d.full_name)))
          from public.drivers d
         where d.dsp_id = v_dsp and d.status = 'onboarding'
           and (t.days = '{}'::text[] or t.days <@ array(select jsonb_array_elements_text(coalesce(d.metadata -> 'availability' -> 'days', '[]'::jsonb))))
           and (
                 t.earliest_start_max is null
                 -- A driver matches the start-time bar unless they have a
                 -- *valid* earliest_start that is *later* than it.  No (or
                 -- unparseable) earliest_start = "any time" = matches.
                 or coalesce(
                      (case when (d.metadata -> 'availability' ->> 'earliest_start') ~ '^[0-9]{1,2}:[0-9]{2}$'
                            then (d.metadata -> 'availability' ->> 'earliest_start')::time end) <= t.earliest_start_max,
                      true)
               )
           and (
                 t.service_type_id is null
                 or (    (not coalesce(s.requires_dot, false) or coalesce(d.dot_certified, false))
                     and (not coalesce(s.requires_xl,  false) or coalesce(d.xl_certified,  false)))
               )
      ), '[]'::jsonb)
    ) order by (case when t.status = 'open' then 0 else 1 end), t.created_at desc)
    from public.hiring_targets t
    left join public.service_types s on s.id = t.service_type_id
    where t.dsp_id = v_dsp
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.hiring_target_list() to authenticated;

notify pgrst, 'reload schema';
