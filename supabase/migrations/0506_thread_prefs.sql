-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0506 · Messages 100-list Batch 3 (#28 archive, #29 mute,
-- #30 mark-unread + snooze, #31 labels) — per-OPERATOR thread preferences.
--
-- Each staff member gets their own archive/mute/snooze/label state per
-- driver conversation (Slack semantics — one operator archiving a thread
-- must not hide it from the rest of the team).
--
-- Surface:
--   dispatch_thread_prefs()                    → { prefs: [...] } (mine)
--   dispatch_thread_pref_set(driver_id, patch) → { pref: {...} }
--     patch keys (all optional): archived bool, muted bool,
--       snooze_until timestamptz|null, mark_unread bool, labels text[]
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.dispatch_thread_prefs (
  user_id        uuid not null references auth.users(id) on delete cascade,
  driver_id      uuid not null references public.drivers(id) on delete cascade,
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  archived_at    timestamptz,
  muted          boolean not null default false,
  snooze_until   timestamptz,
  mark_unread_at timestamptz,
  labels         text[] not null default '{}',
  updated_at     timestamptz not null default now(),
  primary key (user_id, driver_id)
);
create index if not exists dispatch_thread_prefs_user_idx
  on public.dispatch_thread_prefs (user_id, dsp_id);

alter table public.dispatch_thread_prefs enable row level security;
drop policy if exists "dispatch_thread_prefs_own_r" on public.dispatch_thread_prefs;
create policy "dispatch_thread_prefs_own_r"
  on public.dispatch_thread_prefs for select
  using (user_id = auth.uid());
grant select on public.dispatch_thread_prefs to authenticated;

create or replace function public.dispatch_thread_prefs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'driver_id', p.driver_id,
           'archived',  p.archived_at is not null,
           'muted',     p.muted,
           'snooze_until', p.snooze_until,
           'mark_unread', p.mark_unread_at is not null,
           'labels',    to_jsonb(p.labels),
           'updated_at', p.updated_at
         )), '[]'::jsonb)
    into v_out
    from public.dispatch_thread_prefs p
   where p.user_id = v_uid and p.dsp_id = v_dsp;
  return jsonb_build_object('prefs', v_out);
end;
$$;
grant execute on function public.dispatch_thread_prefs() to authenticated;

create or replace function public.dispatch_thread_pref_set(p_driver_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_row public.dispatch_thread_prefs;
  v_labels text[];
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;

  insert into public.dispatch_thread_prefs (user_id, driver_id, dsp_id)
  values (v_uid, p_driver_id, v_dsp)
  on conflict (user_id, driver_id) do nothing;

  select * into v_row from public.dispatch_thread_prefs
   where user_id = v_uid and driver_id = p_driver_id;

  if p_patch ? 'archived' then
    v_row.archived_at := case when (p_patch->>'archived')::boolean then now() else null end;
  end if;
  if p_patch ? 'muted' then
    v_row.muted := coalesce((p_patch->>'muted')::boolean, false);
  end if;
  if p_patch ? 'snooze_until' then
    v_row.snooze_until := nullif(p_patch->>'snooze_until', '')::timestamptz;
  end if;
  if p_patch ? 'mark_unread' then
    v_row.mark_unread_at := case when (p_patch->>'mark_unread')::boolean then now() else null end;
  end if;
  if p_patch ? 'labels' then
    select coalesce(array_agg(x), '{}'::text[])
      into v_labels
      from (
        select distinct trim(value::text, '"') as x
          from jsonb_array_elements(coalesce(p_patch->'labels', '[]'::jsonb))
         where length(trim(value::text, '"')) between 1 and 32
         limit 12
      ) t;
    v_row.labels := v_labels;
  end if;

  update public.dispatch_thread_prefs
     set archived_at = v_row.archived_at,
         muted = v_row.muted,
         snooze_until = v_row.snooze_until,
         mark_unread_at = v_row.mark_unread_at,
         labels = v_row.labels,
         updated_at = now()
   where user_id = v_uid and driver_id = p_driver_id;

  return jsonb_build_object('pref', jsonb_build_object(
    'driver_id', p_driver_id,
    'archived', v_row.archived_at is not null,
    'muted', v_row.muted,
    'snooze_until', v_row.snooze_until,
    'mark_unread', v_row.mark_unread_at is not null,
    'labels', to_jsonb(v_row.labels)
  ));
end;
$$;
grant execute on function public.dispatch_thread_pref_set(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
