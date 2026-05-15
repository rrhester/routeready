-- Migration 0242 · DVIC AI damage review + human comparison workflow.
--
-- Layers on top of vehicle_inspections (introduced in 0213, hooked to
-- DVIC form submissions in 0223 / 0226):
--
--   · AI review columns (status / summary / findings / model / confidence
--     / compared_to_id) so an Edge Function can score each DVIC against
--     the prior inspection's photos.
--   · Human reviewer columns (reviewer_id / reviewed_at / disposition /
--     notes) so the daily side-by-side compare modal records who looked.
--   · Compliance bundle splice — when AI flags damage and a human hasn't
--     dispositioned the inspection yet, surface a `dvic_ai_damage` risk.
--   · vehicles_roster splice — small camera indicator per van based on
--     the latest inspection's review state.
--   · Auto-trigger via pg_net.  AFTER INSERT on vehicle_inspections with
--     photos non-empty, POST { inspection_id } to the dvic-ai-review
--     Edge Function.  URL + service role come from postgres GUCs:
--        ALTER DATABASE postgres SET app.dvic_ai_review_url = '...';
--        ALTER DATABASE postgres SET app.service_role_key   = '...';
--     If either is missing the trigger silently no-ops, so this
--     migration is safe to apply before the secrets are set.
--
-- Idempotent.

-- ── Columns ──────────────────────────────────────────────────────────
alter table public.vehicle_inspections
  add column if not exists ai_review_status     text default 'pending'
    check (ai_review_status in ('pending','clean','flagged','skipped','error')),
  add column if not exists ai_review_at         timestamptz,
  add column if not exists ai_review_summary    text,
  add column if not exists ai_review_findings   jsonb default '[]'::jsonb,
  add column if not exists ai_review_model      text,
  add column if not exists ai_review_confidence int,
  add column if not exists ai_compared_to_id    uuid references public.vehicle_inspections(id) on delete set null,
  add column if not exists reviewer_id          uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at          timestamptz,
  add column if not exists reviewer_disposition text
    check (reviewer_disposition is null
        or reviewer_disposition in ('clean','damage_filed','inconclusive')),
  add column if not exists reviewer_notes       text;

create index if not exists ix_vehicle_inspections_ai_pending
  on public.vehicle_inspections (dsp_id, vehicle_id, inspected_at desc)
  where ai_review_status = 'pending';

create index if not exists ix_vehicle_inspections_ai_flagged
  on public.vehicle_inspections (dsp_id, vehicle_id, inspected_at desc)
  where ai_review_status = 'flagged' and reviewer_disposition is null;


-- ── Signed-URL helper (driver-documents is private) ─────────────────
-- We don't sign URLs from SQL; the dashboard / Edge Function does that
-- against storage.  We just return the raw paths and let the caller
-- mint signed URLs.  Keeps the migration storage-extension-free.


-- ── _dvic_prev_inspection ──────────────────────────────────────────
-- Returns the most recent inspection for this vehicle BEFORE the given
-- inspection, with at least one photo recorded.
create or replace function public._dvic_prev_inspection(
  p_vehicle_id  uuid,
  p_inspected_at timestamptz
) returns public.vehicle_inspections
language sql stable security definer set search_path = public as $$
  select *
  from public.vehicle_inspections
  where vehicle_id = p_vehicle_id
    and inspected_at < p_inspected_at
    and dsp_id = private.current_dsp_id()
    and photos is not null
    and jsonb_array_length(coalesce(photos, '[]'::jsonb)) > 0
  order by inspected_at desc
  limit 1;
$$;
grant execute on function public._dvic_prev_inspection(uuid, timestamptz) to authenticated;


-- ── vehicle_dvic_compare_pair ───────────────────────────────────────
-- Returns the JSONB pair { current, previous } for the comparison
-- modal.  If p_inspection_id is null, picks the most recent inspection
-- with photos.  Each side contains: id, inspected_at, inspector_name,
-- kind, result, mileage, photos (raw paths array), notes, the AI and
-- reviewer columns.  Signed URLs are minted client-side from `photos`.
create or replace function public.vehicle_dvic_compare_pair(
  p_vehicle_id   uuid,
  p_inspection_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_cur public.vehicle_inspections;
  v_prev public.vehicle_inspections;
  v_veh record;
begin
  if v_dsp is null then return jsonb_build_object('error', 'no_dsp'); end if;

  select id, coalesce(nickname, name) as label, vin
    into v_veh
    from public.vehicles
   where id = p_vehicle_id and dsp_id = v_dsp;
  if not found then return jsonb_build_object('error', 'vehicle_not_found'); end if;

  if p_inspection_id is not null then
    select * into v_cur from public.vehicle_inspections
     where id = p_inspection_id and dsp_id = v_dsp and vehicle_id = p_vehicle_id;
  else
    select * into v_cur from public.vehicle_inspections
     where vehicle_id = p_vehicle_id and dsp_id = v_dsp
       and photos is not null and jsonb_array_length(coalesce(photos, '[]'::jsonb)) > 0
     order by inspected_at desc
     limit 1;
  end if;

  if v_cur.id is not null then
    v_prev := public._dvic_prev_inspection(p_vehicle_id, v_cur.inspected_at);
  end if;

  return jsonb_build_object(
    'vehicle', jsonb_build_object('id', v_veh.id, 'label', v_veh.label, 'vin', v_veh.vin),
    'current', case when v_cur.id is null then null else jsonb_build_object(
        'id',                v_cur.id,
        'inspected_at',      v_cur.inspected_at,
        'inspector_name',    v_cur.inspector_name,
        'kind',              v_cur.kind,
        'result',            v_cur.result,
        'mileage',           v_cur.mileage,
        'notes',             v_cur.notes,
        'photos',            coalesce(v_cur.photos, '[]'::jsonb),
        'ai_review_status',  v_cur.ai_review_status,
        'ai_review_at',      v_cur.ai_review_at,
        'ai_review_summary', v_cur.ai_review_summary,
        'ai_review_findings',coalesce(v_cur.ai_review_findings, '[]'::jsonb),
        'ai_review_model',   v_cur.ai_review_model,
        'ai_review_confidence', v_cur.ai_review_confidence,
        'reviewer_id',       v_cur.reviewer_id,
        'reviewed_at',       v_cur.reviewed_at,
        'reviewer_disposition', v_cur.reviewer_disposition,
        'reviewer_notes',    v_cur.reviewer_notes
      ) end,
    'previous', case when v_prev.id is null then null else jsonb_build_object(
        'id',             v_prev.id,
        'inspected_at',   v_prev.inspected_at,
        'inspector_name', v_prev.inspector_name,
        'kind',           v_prev.kind,
        'result',         v_prev.result,
        'mileage',        v_prev.mileage,
        'notes',          v_prev.notes,
        'photos',         coalesce(v_prev.photos, '[]'::jsonb)
      ) end,
    'storage_bucket', 'driver-documents'
  );
end $$;
grant execute on function public.vehicle_dvic_compare_pair(uuid, uuid) to authenticated;


-- ── vehicle_dvic_review_save ────────────────────────────────────────
-- Records a human review.  Disposition can be:
--    'clean'         — no damage observed
--    'damage_filed'  — caller is opening a separate issue / RO
--    'inconclusive'  — needs follow-up
-- Closes the corresponding compliance_dismissals row for dvic_ai_damage
-- so it doesn't re-surface for this inspection.
create or replace function public.vehicle_dvic_review_save(
  p_inspection_id uuid,
  p_disposition   text,
  p_notes         text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ins public.vehicle_inspections;
begin
  if v_dsp is null then return jsonb_build_object('error','no_dsp'); end if;
  if p_disposition not in ('clean','damage_filed','inconclusive') then
    return jsonb_build_object('error','bad_disposition');
  end if;

  update public.vehicle_inspections
     set reviewer_id          = auth.uid(),
         reviewed_at          = now(),
         reviewer_disposition = p_disposition,
         reviewer_notes       = nullif(btrim(p_notes), ''),
         updated_at           = now()
   where id = p_inspection_id and dsp_id = v_dsp
   returning * into v_ins;

  if not found then return jsonb_build_object('error','not_found'); end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'dvic_review_logged',
          'DVIC review · ' || p_disposition,
          coalesce(p_notes, ''),
          'vehicle', v_ins.vehicle_id);

  return jsonb_build_object(
    'ok', true,
    'inspection_id', v_ins.id,
    'disposition',   v_ins.reviewer_disposition,
    'reviewed_at',   v_ins.reviewed_at
  );
end $$;
grant execute on function public.vehicle_dvic_review_save(uuid, text, text) to authenticated;


-- ── vehicle_dvic_ai_save ────────────────────────────────────────────
-- Persisted by the Edge Function once Claude returns its verdict.
-- The Edge Function calls this with service-role; we re-derive the
-- dsp_id from the inspection itself so the function doesn't have to
-- pass it.
create or replace function public.vehicle_dvic_ai_save(
  p_inspection_id  uuid,
  p_status         text,
  p_summary        text,
  p_findings       jsonb,
  p_model          text,
  p_confidence     int default null,
  p_compared_to_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_dsp uuid;
  v_ins public.vehicle_inspections;
begin
  if p_status not in ('clean','flagged','skipped','error') then
    return jsonb_build_object('error','bad_status');
  end if;
  select dsp_id into v_dsp from public.vehicle_inspections where id = p_inspection_id;
  if v_dsp is null then return jsonb_build_object('error','not_found'); end if;

  update public.vehicle_inspections
     set ai_review_status     = p_status,
         ai_review_at         = now(),
         ai_review_summary    = nullif(btrim(p_summary), ''),
         ai_review_findings   = coalesce(p_findings, '[]'::jsonb),
         ai_review_model      = nullif(btrim(p_model), ''),
         ai_review_confidence = greatest(0, least(100, coalesce(p_confidence, 0))),
         ai_compared_to_id    = p_compared_to_id,
         updated_at           = now()
   where id = p_inspection_id
   returning * into v_ins;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'system', null,
          case when p_status = 'flagged' then 'dvic_ai_flagged' else 'dvic_ai_clean' end,
          'DVIC AI review · ' || p_status ||
            (case when p_confidence is null then '' else ' (' || p_confidence || '% conf.)' end),
          left(coalesce(p_summary, ''), 200),
          'vehicle', v_ins.vehicle_id);

  return jsonb_build_object(
    'ok', true,
    'inspection_id', v_ins.id,
    'status',        v_ins.ai_review_status,
    'reviewed_at',   v_ins.ai_review_at
  );
end $$;
grant execute on function public.vehicle_dvic_ai_save(uuid, text, text, jsonb, text, int, uuid) to service_role;
grant execute on function public.vehicle_dvic_ai_save(uuid, text, text, jsonb, text, int, uuid) to authenticated;


-- ── vehicle_dvic_request_ai ─────────────────────────────────────────
-- Frontend-callable endpoint to manually request an AI review for an
-- inspection.  Marks the row 'pending' (in case it was 'error') and
-- fires the same pg_net call the trigger uses.
create or replace function public.vehicle_dvic_request_ai(p_inspection_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ok boolean;
begin
  if v_dsp is null then return jsonb_build_object('error','no_dsp'); end if;
  update public.vehicle_inspections
     set ai_review_status = 'pending',
         updated_at       = now()
   where id = p_inspection_id and dsp_id = v_dsp;
  if not found then return jsonb_build_object('error','not_found'); end if;

  perform private.dvic_request_ai_review(p_inspection_id);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.vehicle_dvic_request_ai(uuid) to authenticated;


-- ── private.dvic_request_ai_review ─────────────────────────────────
-- Wraps pg_net.http_post.  Looks up the Edge Function URL + service
-- role from postgres GUCs.  Silent no-op if either is unset so the
-- trigger never fails an INSERT.
create extension if not exists pg_net with schema extensions;

create or replace function private.dvic_request_ai_review(p_inspection_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_key text;
begin
  begin
    v_url := current_setting('app.dvic_ai_review_url', true);
    v_key := current_setting('app.service_role_key', true);
  exception when others then
    v_url := null; v_key := null;
  end;
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return;
  end if;

  begin
    perform extensions.http_post(
      url     := v_url,
      body    := jsonb_build_object('inspection_id', p_inspection_id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      )
    );
  exception when others then
    -- Never let a transport error roll back the parent transaction.
    null;
  end;
end $$;
grant execute on function private.dvic_request_ai_review(uuid) to authenticated;


-- ── AFTER INSERT trigger ─────────────────────────────────────────────
create or replace function private.dvic_after_inspection_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.photos is not null
     and jsonb_array_length(coalesce(new.photos, '[]'::jsonb)) > 0
     and coalesce(new.ai_review_status, 'pending') = 'pending' then
    perform private.dvic_request_ai_review(new.id);
  end if;
  return new;
end $$;

drop trigger if exists dvic_after_inspection_insert on public.vehicle_inspections;
create trigger dvic_after_inspection_insert
  after insert on public.vehicle_inspections
  for each row
  execute function private.dvic_after_inspection_insert();


-- ── vehicles_roster splice ──────────────────────────────────────────
-- Adds three derived keys so the fleet roster can paint the camera
-- chip:  latest_inspection_id, latest_inspection_at, latest_dvic_state
-- ('none' | 'pending' | 'flagged' | 'clean' | 'reviewed').
--
-- Keeps the existing jsonb return shape from 0239 intact — every
-- existing key is preserved verbatim.
create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'operational_status', vh.operational_status,
      'grounded_since',     ge.grounded_at,
      'grounded_reason',    ge.reason,
      'year',               vh.year,
      'make',               vh.make,
      'model',              vh.model,
      'trim_level',         vh.trim_level,
      'color',              vh.color,
      'plate',              vh.plate,
      'plate_state',        vh.plate_state,
      'vin',                vh.vin,
      'mileage',            vh.mileage,
      'mileage_updated_at', vh.mileage_updated_at,
      'last_route_completed_at', vh.last_route_completed_at,
      'photo_path',         vh.photo_path,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'last_service_at',    vh.last_service_at,
      'next_service_due_at',vh.next_service_due_at,
      'dot_inspection_at',  vh.dot_inspection_at,
      'registration_expires_on', vh.registration_expires_on,
      'insurance_expires_on',    vh.insurance_expires_on,
      'updated_at',         vh.updated_at,
      'primary_driver_id',  pri.driver_id,
      'primary_driver_name',pri.name,
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0),
      'active_ro_id',       ro.id,
      'active_ro_code',     ro.code,
      'active_ro_status',   ro.status,
      'active_ro_opened_at',   ro.opened_at,
      'active_ro_scheduled_at',ro.scheduled_at,
      'active_ro_eta_at',      ro.eta_at,
      'active_ro_completed_at',ro.completed_at,
      'active_ro_vendor_name', vendor.name,
      -- NEW · latest inspection summary (drives the camera chip)
      'latest_inspection_id', li.id,
      'latest_inspection_at', li.inspected_at,
      'latest_dvic_state', case
        when li.id is null                            then 'none'
        when li.reviewer_disposition is not null      then 'reviewed'
        when li.ai_review_status = 'flagged'          then 'flagged'
        when li.ai_review_status = 'pending'          then 'pending'
        when li.ai_review_status = 'clean'            then 'clean'
        else 'pending'
      end
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
    left join lateral (
      select greatest(count(*)::int - 1, 0) as backup_count
      from public.vehicle_driver_assignments
      where vehicle_id = vh.id
    ) ch on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed'
    ) oi on true
    left join lateral (
      select grounded_at, reason
      from public.vehicle_grounding_events
      where vehicle_id = vh.id and ungrounded_at is null
      order by grounded_at desc
      limit 1
    ) ge on true
    left join lateral (
      select * from public.repair_orders
      where vehicle_id = vh.id and status not in ('completed','cancelled')
      order by opened_at desc
      limit 1
    ) ro on true
    left join public.vendors vendor on vendor.id = ro.vendor_id
    left join lateral (
      select id, inspected_at, ai_review_status, reviewer_disposition
      from public.vehicle_inspections
      where vehicle_id = vh.id
      order by inspected_at desc
      limit 1
    ) li on true
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


-- ── Bundle splice · dvic_ai_damage risks ────────────────────────────
-- Re-issue compliance_workspace_bundle so the response carries new
-- `dvic_ai_damage` risks for every inspection where AI flagged damage
-- and no human has dispositioned it yet.
create or replace function public.compliance_workspace_bundle(p_dsp_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_now timestamptz := now();
  v_dsp_id uuid := coalesce(p_dsp_id, private.current_dsp_id());
  v_posture jsonb; v_grounded jsonb; v_vendors jsonb; v_cures jsonb;
  v_fmcsa jsonb; v_fmcsa_monitors jsonb;
  v_docs jsonb; v_audit jsonb; v_monitors jsonb;
  v_fleet jsonb; v_risks jsonb; v_gaps jsonb; v_fmcsa_risks jsonb;
  v_dvic_risks jsonb;
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

  -- DVIC AI damage risks · flagged with no human disposition yet.
  with d as (
    select i.id, i.vehicle_id, i.inspected_at,
           i.ai_review_summary, i.ai_review_findings,
           i.ai_review_confidence, i.ai_review_at,
           i.inspector_name,
           coalesce(v.nickname, v.name) as vehicle_label, v.vin
    from public.vehicle_inspections i
    join public.vehicles v on v.id = i.vehicle_id
    where i.dsp_id = v_dsp_id
      and i.ai_review_status = 'flagged'
      and i.reviewer_disposition is null
      and v.archived_at is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', 'dvic_ai_damage',
    'severity', case
                  when coalesce((d.ai_review_confidence), 0) >= 75 then 'critical'
                  when coalesce((d.ai_review_confidence), 0) >= 50 then 'high'
                  else 'medium'
                end,
    'cite', 'routeready',
    'title', 'AI flagged possible damage · ' || coalesce(d.vehicle_label, 'vehicle'),
    'subjects', jsonb_build_array(
      jsonb_build_object('lbl', 'VIN',  'val', coalesce(d.vin, '—')),
      jsonb_build_object('lbl', 'UNIT', 'val', coalesce(d.vehicle_label, '—'))
    ),
    'meta', jsonb_build_object(
      'inspection_id',   d.id,
      'vehicle_id',      d.vehicle_id,
      'inspected_at',    d.inspected_at,
      'inspector_name',  d.inspector_name,
      'ai_summary',      d.ai_review_summary,
      'ai_findings',     coalesce(d.ai_review_findings, '[]'::jsonb),
      'ai_confidence',   d.ai_review_confidence,
      'ai_reviewed_at',  d.ai_review_at,
      'source',          'RouteReady DVIC AI review',
      'context',         'RouteReady''s automated DVIC photo review flagged this inspection as potentially showing damage compared to the prior inspection.',
      'recommended',     'Open the side-by-side comparison and confirm whether damage is present. File an issue / repair order if confirmed, otherwise mark clean.'
    ),
    'object_type', 'vehicle_inspection',
    'object_id',   d.id
  )), '[]'::jsonb) into v_dvic_risks from d;

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

  v_fmcsa_risks := public.fmcsa_risks_for_dsp(v_dsp_id);
  v_risks := v_risks || coalesce(v_fmcsa_risks, '[]'::jsonb);

  -- NEW · DVIC AI damage risks (Rule: AI flagged, human hasn't reviewed)
  v_risks := v_risks || coalesce(v_dvic_risks, '[]'::jsonb);

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
                            - greatest(0, jsonb_array_length(v_gaps))*4
                            - greatest(0, jsonb_array_length(coalesce(v_dvic_risks,'[]'::jsonb)))*5)),
    'grounded_count', coalesce(v_g_count, 0),
    'over_amazon_threshold', coalesce(v_over_amazon, 0),
    'repairs_overdue', coalesce(v_repair_overdue, 0),
    'vendor_stalls', coalesce(v_vendor_stalls, 0),
    'open_cures', coalesce(v_open_cures, 0),
    'no_van_count', jsonb_array_length(v_gaps),
    'dvic_ai_flagged', jsonb_array_length(coalesce(v_dvic_risks,'[]'::jsonb)),
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
