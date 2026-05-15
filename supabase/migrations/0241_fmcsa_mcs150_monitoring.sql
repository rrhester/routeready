-- Migration 0241 · Focused FMCSA MCS-150 monitoring.
--
-- Adds the data + logic to drive the Compliance workspace's FMCSA
-- monitoring rules.  Scope is intentionally narrow: only MCS-150 +
-- SAFER operational risk.  No legal-counsel positioning.
--
-- New schema (additive on the existing fmcsa_records):
--   · legal_name                 — DSP-stated legal name
--   · expected_fleet_count       — DSP-stated count for comparison
--   · public_operating_status    — raw operating status from SAFER
--   · public_cmv_count           — CMV count from SAFER
--   · public_non_cmv_count       — Non-CMV count from SAFER
--   · public_fleet_total         — total vehicles from SAFER
--   · public_mcs150_last_update_at — last update date from SAFER
--   · last_checked_at            — when RouteReady last pulled SAFER
--
-- Idempotent.

alter table public.fmcsa_records
  add column if not exists legal_name                 text,
  add column if not exists expected_fleet_count       int,
  add column if not exists public_operating_status    text,
  add column if not exists public_cmv_count           int,
  add column if not exists public_non_cmv_count       int,
  add column if not exists public_fleet_total         int,
  add column if not exists public_mcs150_last_update_at date,
  add column if not exists last_checked_at            timestamptz;


-- ── Biennial deadline calculator ─────────────────────────────────────
-- USDOT-based MCS-150 biennial filing schedule:
--   · Last digit  → filing month  (1=Jan … 9=Sep, 0=Oct)
--   · 2nd-to-last → odd / even-year pattern
--      odd  digit → file in odd-numbered years
--      even digit → file in even-numbered years
-- Returns the next-applicable filing date based on today.
create or replace function public.fmcsa_biennial_due(p_usdot text)
returns date
language plpgsql
stable
as $$
declare
  v_clean text := regexp_replace(coalesce(p_usdot, ''), '\D', '', 'g');
  v_n     int  := length(v_clean);
  v_last  int;
  v_prev  int;
  v_month int;
  v_year  int := extract(year from current_date)::int;
  v_due   date;
begin
  if v_n < 2 then return null; end if;
  v_last := substring(v_clean from v_n     for 1)::int;
  v_prev := substring(v_clean from v_n - 1 for 1)::int;

  -- 0 → October; otherwise the digit itself is the month.
  v_month := case when v_last = 0 then 10 else v_last end;

  -- Align year to the odd / even pattern.
  if (v_prev % 2) <> (v_year % 2) then
    v_year := v_year + 1;
  end if;
  v_due := make_date(v_year, v_month, 1);

  -- If the candidate falls in the past relative to today, jump 2y.
  if v_due < current_date then
    v_due := make_date(v_year + 2, v_month, 1);
  end if;

  return v_due;
end $$;
grant execute on function public.fmcsa_biennial_due(text) to authenticated;


-- ── fmcsa_record_get ─────────────────────────────────────────────────
-- Returns the FMCSA record for the current DSP plus a derived next-due
-- date when the row doesn't have one stored.
create or replace function public.fmcsa_record_get()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_build_object(
    'dsp_id',                       f.dsp_id,
    'legal_name',                   f.legal_name,
    'usdot',                        f.usdot,
    'mc_number',                    f.mc_number,
    'expected_fleet_count',         f.expected_fleet_count,
    'public_operating_status',      f.public_operating_status,
    'public_cmv_count',             f.public_cmv_count,
    'public_non_cmv_count',         f.public_non_cmv_count,
    'public_fleet_total',           f.public_fleet_total,
    'public_mcs150_last_update_at', f.public_mcs150_last_update_at,
    'mcs150_filed_at',              f.mcs150_filed_at,
    'mcs150_next_due_at',           coalesce(f.mcs150_next_due_at, public.fmcsa_biennial_due(f.usdot)),
    'computed_next_due_at',         public.fmcsa_biennial_due(f.usdot),
    'last_checked_at',              f.last_checked_at,
    'safer_last_sync_at',           f.safer_last_sync_at,
    'updated_at',                   f.updated_at
  ), '{}'::jsonb)
  from public.fmcsa_records f
  where f.dsp_id = private.current_dsp_id();
$$;
grant execute on function public.fmcsa_record_get() to authenticated;


-- ── fmcsa_record_save ────────────────────────────────────────────────
-- Upserts the DSP-entered fields (legal name, USDOT, MC, expected
-- fleet count) and recomputes the biennial due date from USDOT.
create or replace function public.fmcsa_record_save(
  p_legal_name           text default null,
  p_usdot                text default null,
  p_mc_number            text default null,
  p_expected_fleet_count int  default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_due date;
begin
  -- Auto-recompute the next-due date when USDOT is present.
  v_due := public.fmcsa_biennial_due(p_usdot);

  insert into public.fmcsa_records (dsp_id, legal_name, usdot, mc_number,
                                    expected_fleet_count, mcs150_next_due_at, updated_at)
  values (v_dsp,
          nullif(btrim(p_legal_name), ''),
          nullif(btrim(p_usdot), ''),
          nullif(btrim(p_mc_number), ''),
          p_expected_fleet_count,
          v_due,
          now())
  on conflict (dsp_id) do update set
    legal_name           = coalesce(nullif(btrim(excluded.legal_name), ''),    public.fmcsa_records.legal_name),
    usdot                = coalesce(nullif(btrim(excluded.usdot), ''),         public.fmcsa_records.usdot),
    mc_number            = coalesce(nullif(btrim(excluded.mc_number), ''),     public.fmcsa_records.mc_number),
    expected_fleet_count = coalesce(excluded.expected_fleet_count,             public.fmcsa_records.expected_fleet_count),
    mcs150_next_due_at   = coalesce(excluded.mcs150_next_due_at,               public.fmcsa_records.mcs150_next_due_at),
    updated_at           = now();

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'fmcsa_record_updated',
          'FMCSA record saved · USDOT ' || coalesce(p_usdot, '(none)'),
          null, 'fmcsa', v_dsp);

  return public.fmcsa_record_get();
end $$;
grant execute on function public.fmcsa_record_save(text, text, text, int) to authenticated;


-- ── fmcsa_safer_record_observation ──────────────────────────────────
-- Slot for the future "auto-review" worker.  Accepts the observed
-- public values from SAFER and stores them on fmcsa_records.  Until
-- a real scraper exists, this RPC can be called manually with the
-- values an operator looked up themselves.  Auto-fetcher (Supabase
-- Edge Function on pg_cron) is the next ship — it will call this
-- same RPC.
create or replace function public.fmcsa_safer_record_observation(
  p_operating_status    text default null,
  p_cmv_count           int  default null,
  p_non_cmv_count       int  default null,
  p_fleet_total         int  default null,
  p_mcs150_last_update  date default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  insert into public.fmcsa_records (dsp_id, public_operating_status, public_cmv_count,
                                    public_non_cmv_count, public_fleet_total,
                                    public_mcs150_last_update_at,
                                    safer_last_sync_at, last_checked_at, updated_at)
  values (v_dsp, p_operating_status, p_cmv_count, p_non_cmv_count, p_fleet_total,
          p_mcs150_last_update, now(), now(), now())
  on conflict (dsp_id) do update set
    public_operating_status     = coalesce(excluded.public_operating_status,     public.fmcsa_records.public_operating_status),
    public_cmv_count            = coalesce(excluded.public_cmv_count,            public.fmcsa_records.public_cmv_count),
    public_non_cmv_count        = coalesce(excluded.public_non_cmv_count,        public.fmcsa_records.public_non_cmv_count),
    public_fleet_total          = coalesce(excluded.public_fleet_total,          public.fmcsa_records.public_fleet_total),
    public_mcs150_last_update_at= coalesce(excluded.public_mcs150_last_update_at,public.fmcsa_records.public_mcs150_last_update_at),
    safer_last_sync_at          = now(),
    last_checked_at             = now(),
    updated_at                  = now();

  return public.fmcsa_record_get();
end $$;
grant execute on function public.fmcsa_safer_record_observation(text, int, int, int, date) to authenticated;


-- ── Risk emission helper · used by the bundle ───────────────────────
-- Returns the JSONB array of FMCSA risks for the current DSP.  Kept
-- separate so the bundle can splice it in without re-issuing the
-- entire function body.
create or replace function public.fmcsa_risks_for_dsp(p_dsp_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_now  timestamptz := now();
  v_dsp  uuid := coalesce(p_dsp_id, private.current_dsp_id());
  v_f    public.fmcsa_records;
  v_due  date;
  v_days int;
  v_rr_fleet int;
  v_risks jsonb := '[]'::jsonb;
begin
  if v_dsp is null or v_dsp <> private.current_dsp_id() then return '[]'::jsonb; end if;
  select * into v_f from public.fmcsa_records where dsp_id = v_dsp;
  if not found then return '[]'::jsonb; end if;

  v_due := coalesce(v_f.mcs150_next_due_at, public.fmcsa_biennial_due(v_f.usdot));
  v_days := case when v_due is null then null else (v_due - current_date) end;

  -- Rule 1 · MCS-150 overdue
  if v_due is not null and v_due < current_date then
    v_risks := v_risks || jsonb_build_array(jsonb_build_object(
      'kind', 'fmcsa_mcs150_overdue',
      'severity', 'critical',
      'cite', 'fmcsa',
      'title', 'MCS-150 biennial filing overdue',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl', 'USDOT', 'val', coalesce(v_f.usdot, '—'))
      ),
      'meta', jsonb_build_object(
        'usdot', v_f.usdot,
        'next_due_at', v_due,
        'days_until_due', v_days,
        'detected_at', v_now,
        'source', 'FMCSA SAFER / MCS-150',
        'context', 'RouteReady detected that this DSP''s MCS-150 biennial filing deadline has passed without a recorded update.',
        'recommended', 'Review the MCS-150 filing on the FMCSA portal and confirm the most recent update is reflected on the SAFER public record.'
      ),
      'object_type', 'fmcsa',
      'object_id',   v_dsp
    ));
  end if;

  -- Rule 2 · MCS-150 due within 60 days (and not overdue)
  if v_due is not null and v_due >= current_date and v_days <= 60 then
    v_risks := v_risks || jsonb_build_array(jsonb_build_object(
      'kind', 'fmcsa_mcs150_upcoming',
      'severity', 'high',
      'cite', 'fmcsa',
      'title', 'MCS-150 biennial filing approaching',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl', 'USDOT', 'val', coalesce(v_f.usdot, '—'))
      ),
      'meta', jsonb_build_object(
        'usdot', v_f.usdot,
        'next_due_at', v_due,
        'days_until_due', v_days,
        'detected_at', v_now,
        'source', 'FMCSA SAFER / MCS-150',
        'context', 'RouteReady calculated that this DSP''s next MCS-150 biennial filing falls within the next 60 days based on the USDOT-driven schedule.',
        'recommended', 'Review and submit the MCS-150 update before the deadline to keep the FMCSA SAFER record current.'
      ),
      'object_type', 'fmcsa',
      'object_id',   v_dsp
    ));
  end if;

  -- Rule 3 · CMV count > 0 (Amazon-DSP vehicle classification mismatch risk)
  if coalesce(v_f.public_cmv_count, 0) > 0 then
    v_risks := v_risks || jsonb_build_array(jsonb_build_object(
      'kind', 'fmcsa_cmv_classification',
      'severity', 'high',
      'cite', 'fmcsa',
      'title', 'FMCSA vehicle classification risk',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl', 'USDOT', 'val', coalesce(v_f.usdot, '—'))
      ),
      'meta', jsonb_build_object(
        'usdot', v_f.usdot,
        'public_cmv_count', v_f.public_cmv_count,
        'detected_at', v_now,
        'source', 'FMCSA SAFER / MCS-150',
        'context', 'RouteReady detected that this DSP''s public FMCSA registration currently lists '
                   || v_f.public_cmv_count || ' commercial motor vehicle' || case when v_f.public_cmv_count = 1 then '' else 's' end || '. Amazon-DSP operations typically run Non-CMV cargo vans.',
        'recommended', 'Review the MCS-150 filing and confirm vehicle classification accuracy against official FMCSA records.'
      ),
      'object_type', 'fmcsa',
      'object_id',   v_dsp
    ));
  end if;

  -- Rule 4 · Operating status not "active"
  if v_f.public_operating_status is not null
     and lower(v_f.public_operating_status) <> 'active' then
    v_risks := v_risks || jsonb_build_array(jsonb_build_object(
      'kind', 'fmcsa_operating_status',
      'severity', 'critical',
      'cite', 'fmcsa',
      'title', 'FMCSA operating status not active',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl', 'USDOT', 'val', coalesce(v_f.usdot, '—'))
      ),
      'meta', jsonb_build_object(
        'usdot', v_f.usdot,
        'public_operating_status', v_f.public_operating_status,
        'detected_at', v_now,
        'source', 'FMCSA SAFER',
        'context', 'RouteReady observed that this DSP''s public FMCSA operating status is currently "' ||
                   v_f.public_operating_status || '".',
        'recommended', 'Review the SAFER record on the FMCSA portal and address any out-of-service or de-authorization actions before continuing operations.'
      ),
      'object_type', 'fmcsa',
      'object_id',   v_dsp
    ));
  end if;

  -- Rule 5 · Significant fleet-count mismatch (vs RouteReady roster)
  -- Pick the larger of expected_fleet_count and live vehicles count as
  -- the "RouteReady-side" anchor.
  select count(*) into v_rr_fleet
  from public.vehicles
  where dsp_id = v_dsp and archived_at is null;

  if coalesce(v_f.public_fleet_total, 0) > 0
     and coalesce(v_rr_fleet, v_f.expected_fleet_count, 0) > 0 then
    declare
      v_anchor int := coalesce(v_f.expected_fleet_count, v_rr_fleet);
      v_delta  int := abs(v_f.public_fleet_total - v_anchor);
      v_pct    numeric := case when v_anchor = 0 then 0
                               else (v_delta::numeric / v_anchor::numeric) * 100 end;
    begin
      if v_pct >= 20 then
        v_risks := v_risks || jsonb_build_array(jsonb_build_object(
          'kind', 'fmcsa_fleet_count_mismatch',
          'severity', case when v_pct >= 40 then 'high' else 'medium' end,
          'cite', 'fmcsa',
          'title', 'Possible fleet-count mismatch · FMCSA vs RouteReady',
          'subjects', jsonb_build_array(
            jsonb_build_object('lbl', 'USDOT', 'val', coalesce(v_f.usdot, '—'))
          ),
          'meta', jsonb_build_object(
            'usdot', v_f.usdot,
            'public_fleet_total', v_f.public_fleet_total,
            'expected_fleet_count', v_f.expected_fleet_count,
            'routeready_fleet_count', v_rr_fleet,
            'pct_delta', round(v_pct, 1),
            'detected_at', v_now,
            'source', 'FMCSA SAFER · RouteReady fleet roster',
            'context', 'RouteReady detected that the public FMCSA fleet count of ' || v_f.public_fleet_total ||
                       ' differs from the DSP''s RouteReady roster (' || v_anchor || ' vehicles) by ' ||
                       round(v_pct, 0) || '%.',
            'recommended', 'Review FMCSA records and the RouteReady fleet roster for a possible mismatch; the MCS-150 filing may need to be updated.'
          ),
          'object_type', 'fmcsa',
          'object_id',   v_dsp
        ));
      end if;
    end;
  end if;

  return v_risks;
end $$;
grant execute on function public.fmcsa_risks_for_dsp(uuid) to authenticated;


-- ── Bundle splice ────────────────────────────────────────────────────
-- Re-issue compliance_workspace_bundle so the response carries:
--   · v_fmcsa with the full record (including the new public_* fields
--     and the derived next_due_at)
--   · a `fmcsa_monitors` JSON array describing the five FMCSA monitor
--     rows (check / status / current vs expected / next due / last
--     checked / automation)
--   · the FMCSA risks from fmcsa_risks_for_dsp appended to v_risks
--
-- Everything else in the bundle is unchanged from migration 0240.
create or replace function public.compliance_workspace_bundle(p_dsp_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_now timestamptz := now();
  v_dsp_id uuid := coalesce(p_dsp_id, private.current_dsp_id());
  v_posture jsonb; v_grounded jsonb; v_vendors jsonb; v_cures jsonb;
  v_fmcsa jsonb; v_fmcsa_monitors jsonb;
  v_docs jsonb; v_audit jsonb; v_monitors jsonb;
  v_fleet jsonb; v_risks jsonb; v_gaps jsonb; v_fmcsa_risks jsonb;
  v_g_count int; v_over_amazon int; v_open_cures int;
  v_repair_overdue int; v_vendor_stalls int;
  v_total_v int; v_op_v int;
begin
  if v_dsp_id is null then return jsonb_build_object('error','no_dsp'); end if;
  if v_dsp_id <> private.current_dsp_id() then return jsonb_build_object('error','forbidden'); end if;

  with g as (
    select v.id, coalesce(v.nickname, v.name) as label, v.vin,
           v.operational_status, ge.grounded_at, ge.reason,
           ro.id as ro_id, ro.code as ro_code, ro.status as ro_status,
           ro.eta_at as ro_eta_at, ro.scheduled_at as ro_scheduled_at,
           ven.id as vendor_id, ven.name as vendor_name,
           ven.accountability_score as vendor_score,
           ven.last_message_at as vendor_last_msg,
           public.business_days_between(ge.grounded_at, v_now) as bd_grounded,
           extract(epoch from (v_now - ge.grounded_at)) / 86400.0 as days_grounded
    from public.vehicles v
    join lateral (select * from public.vehicle_grounding_events
                  where vehicle_id = v.id and ungrounded_at is null
                  order by grounded_at desc limit 1) ge on true
    left join lateral (select * from public.repair_orders
                       where vehicle_id = v.id and status not in ('completed','cancelled')
                       order by opened_at desc limit 1) ro on true
    left join public.vendors ven on ven.id = ro.vendor_id
    where v.dsp_id = v_dsp_id
  )
  select jsonb_agg(jsonb_build_object(
      'vehicle_id', id, 'label', label, 'vin', vin,
      'grounded_at', grounded_at,
      'days_grounded', round(days_grounded, 1),
      'bd_grounded', round(bd_grounded, 1),
      'reason', reason,
      'ro_id', ro_id, 'ro_code', ro_code, 'ro_status', ro_status,
      'ro_eta_at', ro_eta_at, 'ro_scheduled_at', ro_scheduled_at,
      'vendor_id', vendor_id, 'vendor_name', vendor_name,
      'vendor_score', vendor_score, 'vendor_last_msg', vendor_last_msg,
      'over_amazon_threshold', bd_grounded > 14,
      'in_amazon_warn', bd_grounded > 7
    ) order by days_grounded desc),
    count(*),
    count(*) filter (where bd_grounded > 14)
  into v_grounded, v_g_count, v_over_amazon from g;
  v_grounded := coalesce(v_grounded, '[]'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'name', v.name, 'kind', v.kind,
    'accountability_score', v.accountability_score,
    'open_ros', coalesce(r.open_ros, 0),
    'on_time_pct', v.on_time_pct,
    'avg_eta_confirm_days', v.avg_eta_confirm_days,
    'last_message_at', v.last_message_at,
    'reassignment_threshold', v.reassignment_threshold,
    'paused', v.paused, 'distance_mi', v.distance_mi
  ) order by v.accountability_score asc), '[]'::jsonb) into v_vendors
  from public.vendors v
  left join (select vendor_id, count(*) as open_ros from public.repair_orders
             where dsp_id = v_dsp_id and status not in ('completed','cancelled')
             group by vendor_id) r on r.vendor_id = v.id
  where v.dsp_id = v_dsp_id;

  select count(*) into v_vendor_stalls from public.vendors
  where dsp_id = v_dsp_id and accountability_score < reassignment_threshold;

  with c as (
    select cu.id, cu.code, cu.source, cu.title, cu.description, cu.status,
           cu.deadline_at, cu.opened_at, cu.submitted_at, cu.closed_at,
           extract(epoch from (cu.deadline_at - v_now)) / 86400.0 as days_to_deadline,
           (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'ord', s.ord,
                    'title', s.title, 'sub', s.sub, 'done', s.done_at is not null,
                    'done_at', s.done_at) order by s.ord), '[]'::jsonb)
            from public.compliance_cure_steps s where s.cure_id = cu.id) as steps,
           (select coalesce(jsonb_agg(jsonb_build_object('object_type', l.object_type,
                    'object_id', l.object_id, 'label', l.label)), '[]'::jsonb)
            from public.compliance_cure_links l where l.cure_id = cu.id) as links,
           (select au.full_name from public.app_users au where au.id = cu.owner_id) as owner_name,
           (select count(*) from public.compliance_cure_steps s where s.cure_id = cu.id) as step_total,
           (select count(*) from public.compliance_cure_steps s
            where s.cure_id = cu.id and s.done_at is not null) as step_done
    from public.compliance_cures cu
    where cu.dsp_id = v_dsp_id and cu.status <> 'closed'
    order by cu.deadline_at nulls last
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'code', c.code, 'source', c.source, 'title', c.title,
    'description', c.description, 'status', c.status,
    'deadline_at', c.deadline_at,
    'days_to_deadline', round(c.days_to_deadline, 1),
    'opened_at', c.opened_at, 'owner_name', c.owner_name,
    'steps', c.steps, 'links', c.links,
    'step_total', c.step_total, 'step_done', c.step_done
  )), '[]'::jsonb) into v_cures from c;

  select count(*) into v_open_cures from public.compliance_cures
  where dsp_id = v_dsp_id and status <> 'closed';

  v_fmcsa := public.fmcsa_record_get();

  -- Build the FMCSA monitor table rows.
  declare
    v_due date := nullif(v_fmcsa->>'mcs150_next_due_at','')::date;
    v_days int := case when v_due is null then null else (v_due - current_date) end;
    v_rr_fleet int;
  begin
    select count(*) into v_rr_fleet from public.vehicles
      where dsp_id = v_dsp_id and archived_at is null;

    v_fmcsa_monitors := jsonb_build_array(
      jsonb_build_object(
        'check', 'MCS-150 biennial deadline',
        'current_value', case when v_due is null then 'Unknown'
                              when v_days < 0 then 'Overdue by ' || abs(v_days) || 'd'
                              else v_days || 'd remaining' end,
        'expected_value', coalesce(v_due::text, '—'),
        'next_due_at',    v_due,
        'status',         case when v_due is null then 'unknown'
                               when v_days < 0 then 'crit'
                               when v_days <= 60 then 'alerting'
                               else 'healthy' end,
        'last_checked_at', v_fmcsa->>'last_checked_at',
        'automation', 'auto-review'
      ),
      jsonb_build_object(
        'check', 'FMCSA operating status',
        'current_value', coalesce(v_fmcsa->>'public_operating_status', '—'),
        'expected_value', 'Active',
        'status', case when v_fmcsa->>'public_operating_status' is null then 'unknown'
                       when lower(v_fmcsa->>'public_operating_status') = 'active' then 'healthy'
                       else 'crit' end,
        'last_checked_at', v_fmcsa->>'last_checked_at',
        'automation', 'auto-review'
      ),
      jsonb_build_object(
        'check', 'CMV count',
        'current_value', coalesce(v_fmcsa->>'public_cmv_count', '—'),
        'expected_value', '0',
        'status', case when v_fmcsa->>'public_cmv_count' is null then 'unknown'
                       when (v_fmcsa->>'public_cmv_count')::int > 0 then 'alerting'
                       else 'healthy' end,
        'last_checked_at', v_fmcsa->>'last_checked_at',
        'automation', 'auto-review'
      ),
      jsonb_build_object(
        'check', 'Non-CMV count',
        'current_value', coalesce(v_fmcsa->>'public_non_cmv_count', '—'),
        'expected_value', coalesce((v_fmcsa->>'expected_fleet_count')::text, v_rr_fleet::text),
        'status', case when v_fmcsa->>'public_non_cmv_count' is null then 'unknown' else 'watching' end,
        'last_checked_at', v_fmcsa->>'last_checked_at',
        'automation', 'auto-review'
      ),
      jsonb_build_object(
        'check', 'Fleet count comparison',
        'current_value', coalesce(v_fmcsa->>'public_fleet_total', '—'),
        'expected_value', coalesce((v_fmcsa->>'expected_fleet_count')::text, v_rr_fleet::text),
        'status', case when v_fmcsa->>'public_fleet_total' is null then 'unknown' else 'watching' end,
        'last_checked_at', v_fmcsa->>'last_checked_at',
        'automation', 'auto-review'
      )
    );
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'name', d.name,
    'attached_object_type', d.attached_object_type,
    'attached_object_id', d.attached_object_id,
    'uploaded_at', d.uploaded_at,
    'uploaded_by_name', (select full_name from public.app_users where id = d.uploaded_by),
    'verified', d.verified, 'size_bytes', d.size_bytes
  ) order by d.uploaded_at desc), '[]'::jsonb) into v_docs
  from (select * from public.compliance_documents
        where dsp_id = v_dsp_id order by uploaded_at desc limit 24) d;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'occurred_at', e.occurred_at,
    'actor_type', e.actor_type, 'actor_label', e.actor_label,
    'kind', e.kind, 'summary', e.summary, 'sub', e.sub,
    'object_type', e.object_type, 'object_id', e.object_id
  ) order by e.occurred_at desc), '[]'::jsonb) into v_audit
  from (select * from public.compliance_audit_events
        where dsp_id = v_dsp_id order by occurred_at desc limit 40) e;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'code', m.code, 'name', m.name,
    'description', m.description, 'category', m.category,
    'state', m.state, 'severity_reach', m.severity_reach,
    'data_source', m.data_source, 'rule_expr', m.rule_expr,
    'automation', m.automation, 'escalation', m.escalation,
    'last_check_at', m.last_check_at, 'paused', m.paused
  ) order by m.severity_reach desc, m.name), '[]'::jsonb) into v_monitors
  from public.compliance_monitors m where m.dsp_id = v_dsp_id;

  select count(*), count(*) filter (where operational_status = 'operational')
  into v_total_v, v_op_v from public.vehicles where dsp_id = v_dsp_id;

  select jsonb_build_object(
    'total', v_total_v, 'operational', v_op_v, 'grounded', v_g_count,
    'in_repair', greatest(0, (
      select count(distinct ro.vehicle_id) from public.repair_orders ro
      where ro.dsp_id = v_dsp_id and ro.status not in ('completed','cancelled')
        and ro.vehicle_id is not null
        and not exists (select 1 from public.vehicle_grounding_events ge
                        where ge.vehicle_id = ro.vehicle_id and ge.ungrounded_at is null)
    ))
  ) into v_fleet;

  with horizon as (select current_date as d0, current_date + 14 as d1),
  candidate_shifts as (
    select s.id as shift_id, s.driver_id, s.date, s.starts_at, s.route_code,
           s.station_id, s.status,
           coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver') as driver_name,
           extract(epoch from (s.starts_at - v_now)) / 3600.0 as hrs_until,
           st.code as station_code
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    left join public.stations st on st.id = s.station_id
    where s.dsp_id = v_dsp_id
      and s.date >= (select d0 from horizon) and s.date <= (select d1 from horizon)
      and s.status in ('scheduled','late') and d.role = 'driver'
  ),
  resolved_van as (
    select cs.shift_id,
      exists (select 1 from public.vehicle_day_assignments oa
              join public.vehicles v on v.id = oa.vehicle_id
              where oa.driver_id = cs.driver_id and oa.date = cs.date
                and v.dsp_id = v_dsp_id and v.archived_at is null)
      or exists (select 1 from public.vehicle_driver_assignments a
                 join public.vehicles v on v.id = a.vehicle_id
                 where a.driver_id = cs.driver_id and a.rank = 0
                   and v.dsp_id = v_dsp_id and v.status = 'active'
                   and v.archived_at is null
                   and coalesce(v.operational_status,'operational') <> 'grounded'
                   and not exists (select 1 from public.vehicle_day_assignments oa
                                   where oa.vehicle_id = v.id and oa.date = cs.date))
      or exists (select 1 from public.vehicle_driver_assignments a
                 join public.vehicles v on v.id = a.vehicle_id
                 left join public.vehicle_driver_assignments pri on pri.vehicle_id = v.id and pri.rank = 0
                 where a.driver_id = cs.driver_id and a.rank > 0
                   and v.dsp_id = v_dsp_id and v.status = 'active'
                   and v.archived_at is null
                   and coalesce(v.operational_status,'operational') <> 'grounded'
                   and not exists (select 1 from public.vehicle_day_assignments oa
                                   where oa.vehicle_id = v.id and oa.date = cs.date)
                   and (pri.driver_id is null
                        or not exists (select 1 from public.shifts ps
                                       where ps.driver_id = pri.driver_id and ps.date = cs.date
                                         and ps.dsp_id = v_dsp_id
                                         and ps.status in ('scheduled','completed','late')))) as has_van
    from candidate_shifts cs
  ),
  unresolved as (
    select cs.* from candidate_shifts cs
    join resolved_van rv on rv.shift_id = cs.shift_id
    where rv.has_van = false
  ),
  per_date_pool as (
    select u.date,
      (select count(*) from public.vehicles v
       where v.dsp_id = v_dsp_id and v.status in ('active','spare')
         and v.archived_at is null
         and coalesce(v.operational_status,'operational') <> 'grounded'
         and not exists (select 1 from public.vehicle_day_assignments oa
                         where oa.vehicle_id = v.id and oa.date = u.date)
         and not exists (select 1 from public.vehicle_driver_assignments a
                         join public.shifts s on s.driver_id = a.driver_id
                         where a.vehicle_id = v.id and s.date = u.date
                           and s.dsp_id = v_dsp_id
                           and s.status in ('scheduled','completed','late'))
      ) as pool_size
    from (select distinct date from unresolved) u
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id', u.shift_id, 'driver_id', u.driver_id,
    'driver_name', u.driver_name, 'date', u.date,
    'starts_at', u.starts_at, 'station_code', u.station_code,
    'route_code', u.route_code, 'hrs_until', round(u.hrs_until, 1),
    'pool_size', p.pool_size
  ) order by u.starts_at), '[]'::jsonb) into v_gaps
  from unresolved u join per_date_pool p on p.date = u.date
  where p.pool_size = 0;

  -- Risk synthesis.
  v_risks := '[]'::jsonb;
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','grounded_no_ro',
      'severity', case when (g->>'bd_grounded')::numeric > 2 then 'critical' else 'high' end,
      'cite','amazon',
      'title', 'No active repair order · ' || coalesce(g->>'label','vehicle')
               || ' · grounded ' || round((g->>'days_grounded')::numeric)::text || 'd',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VIN','val', coalesce(g->>'vin','—')),
        jsonb_build_object('lbl','UNIT','val', coalesce(g->>'label','—'))),
      'meta', jsonb_build_object(
        'days_grounded', (g->>'days_grounded')::numeric,
        'bd_grounded', (g->>'bd_grounded')::numeric,
        'over_2bd',  (g->>'bd_grounded')::numeric > 2,
        'grounded_at', g->>'grounded_at',
        'vendor', g->>'vendor_name'),
      'object_type','vehicle','object_id', g->>'vehicle_id'
    )) from jsonb_array_elements(v_grounded) g where (g->>'ro_id') is null
  ), '[]'::jsonb);
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','repair_14bd_overdue',
      'severity','critical', 'cite','amazon',
      'title','Repair past 14-BD completion threshold · ' || coalesce(g->>'label','vehicle'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VIN','val', coalesce(g->>'vin','—')),
        jsonb_build_object('lbl','UNIT','val', coalesce(g->>'label','—'))),
      'meta', jsonb_build_object(
        'days_grounded', (g->>'days_grounded')::numeric,
        'bd_grounded', (g->>'bd_grounded')::numeric,
        'grounded_at', g->>'grounded_at',
        'ro_code', g->>'ro_code', 'ro_id', g->>'ro_id',
        'ro_status', g->>'ro_status',
        'vendor', g->>'vendor_name',
        'vendor_score', g->>'vendor_score'),
      'object_type','vehicle','object_id', g->>'vehicle_id'
    )) from jsonb_array_elements(v_grounded) g where (g->>'bd_grounded')::numeric > 14
  ), '[]'::jsonb);
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','cure_deadline',
      'severity', case when (c->>'days_to_deadline')::numeric < 3 then 'critical'
                       when (c->>'days_to_deadline')::numeric < 14 then 'high'
                       else 'medium' end,
      'cite', c->>'source',
      'title', 'Cure deadline · ' || coalesce(c->>'title','(no title)'),
      'subjects', jsonb_build_array(jsonb_build_object('lbl','CURE','val', coalesce(c->>'code',''))),
      'meta', jsonb_build_object(
        'days_to_deadline', (c->>'days_to_deadline')::numeric,
        'deadline_at', c->>'deadline_at',
        'step_done', (c->>'step_done')::int,
        'step_total', (c->>'step_total')::int),
      'object_type','cure', 'object_id', c->>'id'
    )) from jsonb_array_elements(v_cures) c
  ), '[]'::jsonb);
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','vendor_stall',
      'severity', case when (v->>'accountability_score')::int < 60 then 'high' else 'medium' end,
      'cite','internal',
      'title','Vendor accountability below reassignment threshold · ' || (v->>'name'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VENDOR','val', v->>'name'),
        jsonb_build_object('lbl','OPEN ROs','val', coalesce(v->>'open_ros','0'))),
      'meta', jsonb_build_object(
        'score', (v->>'accountability_score')::int,
        'threshold', (v->>'reassignment_threshold')::int,
        'open_ros', (v->>'open_ros')::int),
      'object_type','vendor', 'object_id', v->>'id'
    )) from jsonb_array_elements(v_vendors) v
    where (v->>'accountability_score')::int < (v->>'reassignment_threshold')::int
  ), '[]'::jsonb);

  -- NEW · FMCSA risks (Rules 1-5) come from fmcsa_risks_for_dsp.
  v_fmcsa_risks := public.fmcsa_risks_for_dsp(v_dsp_id);
  v_risks := v_risks || coalesce(v_fmcsa_risks, '[]'::jsonb);

  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','driver_no_van',
      'severity', case when (g->>'hrs_until')::numeric <= 48 then 'critical' else 'high' end,
      'cite','internal',
      'title','Scheduled driver has no van · ' || (g->>'driver_name'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','DRIVER','val', g->>'driver_name'),
        jsonb_build_object('lbl','DATE','val', g->>'date')),
      'meta', jsonb_build_object(
        'hrs_until', (g->>'hrs_until')::numeric,
        'shift_id', g->>'shift_id', 'starts_at', g->>'starts_at',
        'station_code', g->>'station_code', 'route_code', g->>'route_code',
        'pool_size', (g->>'pool_size')::int),
      'object_type','shift', 'object_id', g->>'shift_id'
    )) from jsonb_array_elements(v_gaps) g
  ), '[]'::jsonb);

  -- Filter out dismissed (kind, object_id) pairs.
  v_risks := coalesce((
    select jsonb_agg(r) from jsonb_array_elements(v_risks) r
    where not exists (
      select 1 from public.compliance_dismissals d
      where d.dsp_id = v_dsp_id
        and d.exception_kind = (r->>'kind')
        and coalesce(d.object_id, '') = coalesce(r->>'object_id', '')
        and d.expires_at > v_now
    )
  ), '[]'::jsonb);

  v_repair_overdue := 0;
  select count(*) into v_repair_overdue from (
    select g->>'ro_id' as ro,
           (g->>'days_grounded')::numeric as dg,
           (g->>'bd_grounded')::numeric as bd
    from jsonb_array_elements(v_grounded) g
  ) x where x.bd > 14 or (x.ro is null and x.bd > 2);

  v_posture := jsonb_build_object(
    'readiness_score', greatest(0, least(100, 100
                            - coalesce(v_over_amazon,0)*15
                            - coalesce(v_open_cures,0)*8
                            - greatest(0, coalesce(v_vendor_stalls,0))*6
                            - greatest(0, coalesce(v_g_count,0))*3
                            - greatest(0, jsonb_array_length(v_gaps))*4)),
    'grounded_count', coalesce(v_g_count, 0),
    'over_amazon_threshold', coalesce(v_over_amazon, 0),
    'repairs_overdue', coalesce(v_repair_overdue, 0),
    'vendor_stalls', coalesce(v_vendor_stalls, 0),
    'open_cures', coalesce(v_open_cures, 0),
    'no_van_count', jsonb_array_length(v_gaps),
    'last_sweep_at', v_now,
    'fleet', v_fleet);

  return jsonb_build_object(
    'posture', v_posture, 'risks', v_risks, 'cures', v_cures,
    'grounded_vehicles', v_grounded, 'vendors', v_vendors,
    'fmcsa', v_fmcsa, 'fmcsa_monitors', v_fmcsa_monitors,
    'documents', v_docs, 'audit_events', v_audit,
    'monitors', v_monitors, 'fleet', v_fleet,
    'driver_no_van', v_gaps, 'generated_at', v_now);
end $$;
grant execute on function public.compliance_workspace_bundle(uuid) to authenticated;
