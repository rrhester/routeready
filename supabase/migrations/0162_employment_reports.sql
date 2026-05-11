-- Migration 0162 · Employment Documentation Reports
--
-- The dashboard can compile a neutral, chronological "Employment
-- Documentation Report" for a driver (overview, attendance, coaching,
-- communications, scheduling history, signed documents, separation
-- summary). v1 rendered it client-side and printed to PDF. v2 lets the
-- operator *archive* a generated report onto the driver's record so the
-- exact packet handed to an adjudicator / HR / counsel is itself a
-- retained, point-in-time record.
--
-- The canonical record here is the immutable JSONB snapshot — the
-- rendered document plus a little metadata. Rows are append-only:
-- RLS grants select + insert to DSP staff, nothing for update/delete.

create table if not exists public.employment_reports (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  driver_id    uuid not null references public.drivers(id) on delete cascade,
  generated_by uuid references auth.users(id) on delete set null,
  generated_by_name text,
  generated_at timestamptz not null default now(),
  summary      text,
  snapshot     jsonb not null,           -- { html, name, generated_label, ... }
  created_at   timestamptz not null default now()
);
create index employment_reports_driver_idx
  on public.employment_reports (driver_id, generated_at desc);

alter table public.employment_reports enable row level security;

-- Read: any staff member of the owning DSP.
create policy "employment_reports_select" on public.employment_reports
  for select using (dsp_id = private.current_dsp_id());
-- Insert: dispatcher+ of the owning DSP, via the RPC below (which sets
-- dsp_id from the session). A direct insert is also allowed as long as
-- it targets the caller's own DSP.
create policy "employment_reports_insert" on public.employment_reports
  for insert with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
  );
-- No update / delete policies — these rows are immutable once written.


-- ── RPC: archive a generated report onto the driver record ──────────────
create or replace function public.employment_report_save(
  p_driver_id uuid,
  p_summary   text,
  p_snapshot  jsonb
) returns public.employment_reports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_drv public.drivers;
  v_name text;
  v_row public.employment_reports;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'snapshot_must_be_object' using errcode = '22023';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  -- Best-effort: capture the generating staff member's display name.
  begin
    select coalesce(nullif(trim(full_name), ''), email) into v_name
      from public.app_users where id = v_uid;
  exception when others then v_name := null;
  end;

  insert into public.employment_reports
    (dsp_id, driver_id, generated_by, generated_by_name, summary, snapshot)
  values
    (v_dsp, v_drv.id, v_uid, v_name, p_summary, p_snapshot)
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.employment_report_save(uuid, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
