-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0457 · RouteReady Meet — our own instant video meetings
--
-- Replaces the rented meet.jit.si dependency with a first-party, Zoom-style
-- video tool (dashboard/meet.html). Calls are peer-to-peer WebRTC; signaling
-- rides Supabase Realtime broadcast/presence channels (rr-meet:<code>), so
-- the database only has to answer three questions:
--   1. Is this meeting code real (and not ended)?        → meet_lookup
--   2. Can this operator mint a new room?                → meet_create
--   3. Is this caller allowed to end the room for all?   → meet_end
--
-- Guests (applicants, drivers) join by code with NO account: meet_lookup is
-- granted to anon and returns only the room's display metadata. Everything
-- else is staff-gated per the usual dsp_id + private.is_staff() conventions.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── table ───────────────────────────────────────────────────────────────

create table if not exists public.meetings (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id) on delete cascade,
  code        text        not null unique,
  title       text        not null default 'RouteReady meeting',
  host_id     uuid        references public.app_users(id) on delete set null,
  host_name   text,
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create index if not exists meetings_dsp_created_idx
  on public.meetings (dsp_id, created_at desc);

-- ─── RLS · staff of the owning DSP read/write their rooms ────────────────

alter table public.meetings enable row level security;

drop policy if exists meetings_rw on public.meetings;
create policy meetings_rw on public.meetings for all
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- ─── meet_create · mint an instant room (staff only) ─────────────────────
-- Codes are Google-Meet-shaped (xxx-xxxx-xxx) from a 23-letter alphabet
-- with i/l/o removed — 23^10 ≈ 4×10¹³ combos, so codes are unguessable in
-- practice while staying easy to read over the phone.

create or replace function public.meet_create(p_title text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dsp      uuid := private.current_dsp_id();
  v_alphabet text := 'abcdefghjkmnpqrstuvwxyz';
  v_raw      text;
  v_code     text;
  v_row      public.meetings;
  i          int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for i in 1..20 loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * 23)::int, 1), '')
      into v_raw from generate_series(1, 10);
    v_code := substr(v_raw, 1, 3) || '-' || substr(v_raw, 4, 4) || '-' || substr(v_raw, 8, 3);
    begin
      insert into public.meetings (dsp_id, code, title, host_id, host_name)
      values (
        v_dsp,
        v_code,
        coalesce(nullif(trim(p_title), ''), 'RouteReady meeting'),
        auth.uid(),
        coalesce(
          (select nullif(trim(u.full_name), '') from public.app_users u where u.id = auth.uid()),
          'RouteReady host')
      )
      returning * into v_row;

      return jsonb_build_object(
        'id', v_row.id, 'code', v_row.code, 'title', v_row.title,
        'host_name', v_row.host_name, 'created_at', v_row.created_at);
    exception when unique_violation then
      -- astronomically unlikely collision — roll a new code
      null;
    end;
  end loop;

  raise exception 'meet_code_exhausted';
end; $$;

grant execute on function public.meet_create(text) to authenticated;

-- ─── meet_lookup · validate a code before joining (guests welcome) ───────
-- Anonymous-callable by design: an applicant clicking a meeting link has no
-- session. It only confirms a code exists and returns display metadata —
-- never dsp_id, host_id, or anything queryable beyond the code the caller
-- already holds.

create or replace function public.meet_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row  public.meetings;
begin
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select * into v_row
    from public.meetings m
   where replace(m.code, '-', '') = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', v_row.code,
    'title', v_row.title,
    'host_name', v_row.host_name,
    'created_at', v_row.created_at,
    'ended', v_row.ended_at is not null,
    -- lets the host's own client show "End meeting for everyone";
    -- anon callers get false (auth.uid() is null)
    'is_host', coalesce(v_row.host_id = auth.uid(), false));
end; $$;

grant execute on function public.meet_lookup(text) to anon, authenticated;

-- ─── meet_end · end the room for everyone (host or fellow staff) ─────────

create or replace function public.meet_end(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row  public.meetings;
begin
  select * into v_row
    from public.meetings m
   where replace(m.code, '-', '') = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not (v_row.host_id = auth.uid()
          or private.is_staff(v_row.dsp_id, 'dispatcher')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.meetings
     set ended_at = coalesce(ended_at, now())
   where id = v_row.id
   returning * into v_row;

  return jsonb_build_object('ok', true, 'code', v_row.code, 'ended_at', v_row.ended_at);
end; $$;

grant execute on function public.meet_end(text) to authenticated;

-- PostgREST: pick up the new table + functions without a restart.
notify pgrst, 'reload schema';
