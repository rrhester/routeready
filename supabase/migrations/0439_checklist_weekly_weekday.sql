-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0439 · Weekly checklists can target a specific weekday
--
-- "Weekly" checklists were visible every day and counted one submission per
-- week (period_key = the ISO week's Monday). There was no way to say "this
-- one is due every Monday". The builder now writes an optional
-- repeat_rule.weekday (ISO day-of-week: 1=Mon … 7=Sun); when set, the
-- checklist is only in-window on that weekday. Absent/blank keeps the old
-- every-day behavior, so existing weekly assignments are unchanged.
--
-- Only the visibility helper changes: clf_period_key still buckets by ISO
-- week (one submission per week, regardless of weekday), and clf_due_for is
-- unaffected. This is the single authoritative body (0415 original) with the
-- weekly branch extended.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.clf_in_window(a public.checklist_assignments, p_day date)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_type text := coalesce(a.repeat_rule->>'type', 'once');
  v_date date;
  v_wd   int;
begin
  if v_type = 'daily' then return true; end if;
  if v_type = 'weekly' then
    -- Optional weekday pin: only in-window on that ISO weekday when set.
    begin v_wd := nullif(a.repeat_rule->>'weekday','')::int; exception when others then v_wd := null; end;
    if v_wd is null then return true; end if;
    return extract(isodow from p_day)::int = v_wd;
  end if;
  if v_type = 'date' then
    v_date := coalesce(nullif(a.repeat_rule->>'date','')::date, a.route_date);
    if v_date is null then return true; end if;
    return p_day >= v_date and p_day <= v_date + 7;
  end if;
  if a.assignment_scope = 'scheduled_date' and a.route_date is not null then
    return p_day >= a.route_date and p_day <= a.route_date + 7;
  end if;
  return true;  -- one-time: visible until completed (list caps completed age)
end;
$$;

notify pgrst, 'reload schema';
