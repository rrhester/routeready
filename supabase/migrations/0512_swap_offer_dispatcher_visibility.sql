-- 0512_swap_offer_dispatcher_visibility.sql
--
-- Schedule improvement plan Wave 3 items #56/#57 (docs/SCHEDULE-
-- IMPROVEMENT-PLAN.md): give dispatchers first-class visibility and
-- control over the peer-to-peer swap / cover-offer machinery that
-- until now only drivers could see move.
--
--   1. dispatch_swap_cancel(swap_id) — the missing dispatcher cancel
--      for a pending swap (cover offers already had cover_shift_cancel,
--      0198; the swap status enum has had 'cancelled' since 0203 with
--      no code path ever setting it).
--   2. AFTER UPDATE response triggers on shift_offers and
--      shift_swap_requests: when a driver answers (pending →
--      accepted/declined, and for swaps also → blocked), staff get a
--      web push via private.notify_staff_push (0497). Mirrors the 0425
--      driver-side pattern: transition-guarded, best-effort, a
--      notification failure can never block the underlying response.
--      Expiry transitions stay silent (the 0500 sweeper would make
--      them pure noise).
--
-- Idempotent: safe to re-run end to end.

-- ── 1. Dispatcher swap cancel ────────────────────────────────────────
create or replace function public.dispatch_swap_cancel(p_swap_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.shift_swap_requests;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.shift_swap_requests
     set status = 'cancelled', responded_at = now(), updated_at = now()
   where id = p_swap_id and dsp_id = v_dsp and status = 'pending'
   returning * into v_row;
  if v_row.id is null then
    raise exception 'swap_not_found_or_not_pending';
  end if;

  begin
    insert into public.shift_swaps_audit (swap_id, event)
    values (p_swap_id, 'cancelled');
  exception when others then null; end;

  return jsonb_build_object('status', 'cancelled', 'swap_id', p_swap_id);
end;
$$;

grant execute on function public.dispatch_swap_cancel(uuid) to authenticated;

-- ── 2. Staff push on driver responses ────────────────────────────────
create or replace function private.tg_offer_response_notify_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text;
  v_shift public.shifts;
begin
  -- Only genuine driver responses; expiry/cancel transitions are silent.
  if not (old.status = 'pending' and new.status in ('accepted', 'declined')) then
    return new;
  end if;
  begin
    select coalesce(full_name, 'A driver') into v_name
      from public.drivers where id = new.driver_id;
    select * into v_shift from public.shifts where id = new.shift_id;
    perform private.notify_staff_push(
      new.dsp_id,
      case new.status
        when 'accepted' then 'Cover offer accepted'
        else 'Cover offer declined'
      end,
      v_name || ' ' || new.status::text || ' the cover offer'
        || case when v_shift.id is not null
             then ' for ' || v_shift.date::text
                  || coalesce(' · ' || v_shift.route_code, '')
             else '' end,
      '/dashboard/index.html',
      null);
  exception when others then
    raise warning 'offer response staff push failed: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_shift_offers_response_notify on public.shift_offers;
create trigger trg_shift_offers_response_notify
  after update on public.shift_offers
  for each row execute function private.tg_offer_response_notify_staff();

create or replace function private.tg_swap_response_notify_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req  text;
  v_tgt  text;
  v_body text;
begin
  if not (old.status = 'pending'
          and new.status in ('accepted', 'declined', 'blocked')) then
    return new;
  end if;
  begin
    select coalesce(full_name, 'requester') into v_req
      from public.drivers where id = new.requester_driver_id;
    select coalesce(full_name, 'target') into v_tgt
      from public.drivers where id = new.target_driver_id;
    v_body := case new.status
      when 'accepted' then v_tgt || ' accepted the swap with ' || v_req || ' — shifts exchanged'
      when 'declined' then v_tgt || ' declined the swap with ' || v_req
      else 'Swap between ' || v_req || ' and ' || v_tgt
           || ' was blocked by compliance ('
           || coalesce(new.block_reason, 'unknown') || ')'
    end;
    perform private.notify_staff_push(
      new.dsp_id,
      case new.status
        when 'accepted' then 'Shift swap completed'
        when 'declined' then 'Shift swap declined'
        else 'Shift swap blocked'
      end,
      v_body,
      '/dashboard/index.html',
      null);
  exception when others then
    raise warning 'swap response staff push failed: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_shift_swaps_response_notify on public.shift_swap_requests;
create trigger trg_shift_swaps_response_notify
  after update on public.shift_swap_requests
  for each row execute function private.tg_swap_response_notify_staff();

notify pgrst, 'reload schema';
