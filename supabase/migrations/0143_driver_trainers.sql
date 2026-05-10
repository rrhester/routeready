-- Migration 0143 · Driver trainers + training shifts
--
-- A DSP can flag a driver as a trainer (drivers.is_trainer).  A trainer
-- can be attached to a shift as a ride-along — shifts.trainer_driver_id
-- points at the trainer; the shift's driver_id is the trainee running
-- the route.  shift_set_trainer wires it up with the obvious guards.

alter table public.drivers add column if not exists is_trainer boolean not null default false;
alter table public.shifts  add column if not exists trainer_driver_id uuid references public.drivers(id) on delete set null;
create index if not exists shifts_trainer_idx on public.shifts(trainer_driver_id) where trainer_driver_id is not null;


-- Attach a ride-along trainer to a shift (p_trainer_id null → detach).
-- The trainer must be flagged is_trainer in this DSP, can't be the same
-- person as the route driver, and can't already be on another scheduled
-- shift (driving or training) that day.
create or replace function public.shift_set_trainer(p_shift_id uuid, p_trainer_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_shift public.shifts;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_shift from public.shifts where id = p_shift_id and dsp_id = v_dsp;
  if v_shift.id is null then raise exception 'shift_not_found' using errcode = 'P0002'; end if;

  if p_trainer_id is null then
    update public.shifts set trainer_driver_id = null where id = p_shift_id;
    return;
  end if;

  if not exists (select 1 from public.drivers d where d.id = p_trainer_id and d.dsp_id = v_dsp and d.is_trainer) then
    raise exception 'not_a_trainer: that driver isn''t marked as a trainer' using errcode = 'P0001';
  end if;
  if p_trainer_id = v_shift.driver_id then
    raise exception 'trainer_is_driver: the trainer can''t also be the route driver on the same shift' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.shifts s
     where s.dsp_id = v_dsp and s.date = v_shift.date and s.id <> p_shift_id and s.status = 'scheduled'
       and (s.driver_id = p_trainer_id or s.trainer_driver_id = p_trainer_id)
  ) then
    raise exception 'trainer_busy: that trainer is already scheduled on %', v_shift.date using errcode = 'P0001';
  end if;

  update public.shifts set trainer_driver_id = p_trainer_id where id = p_shift_id;
end;
$$;
grant execute on function public.shift_set_trainer(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
