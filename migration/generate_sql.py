#!/usr/bin/env python3
"""Generate Supabase migration SQL from parsed.json."""
import json
import re
from datetime import datetime
from pathlib import Path

DSP_ID = "67e8d369-f071-4df6-a261-dcc14b7e271d"  # Aircapital
PARSED = Path("/home/user/routeready/migration/parsed.json")
OUT_DIR = Path("/home/user/routeready/migration")


def load():
    data = json.loads(PARSED.read_text())
    return {p["block"]: p for p in data}


# ---------- value formatters ----------

def q(s):
    """Quote a string as a SQL literal. None/empty → NULL."""
    if s is None:
        return "NULL"
    s = str(s)
    if s == "":
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def qr(s):
    """Like q() but raw — empty string is empty literal not NULL."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def n(v):
    """Numeric: empty → NULL, else unquoted number."""
    if v is None:
        return "NULL"
    s = str(v).strip()
    if s == "":
        return "NULL"
    try:
        float(s)
    except ValueError:
        return "NULL"
    return s


def i(v):
    """Integer."""
    if v is None:
        return "NULL"
    s = str(v).strip()
    if s == "":
        return "NULL"
    try:
        return str(int(float(s)))
    except ValueError:
        return "NULL"


def b(v):
    if v is None:
        return "NULL"
    s = str(v).strip().lower()
    if s in ("true", "t", "1", "yes", "y"):
        return "true"
    if s in ("false", "f", "0", "no", "n", ""):
        return "false"
    return "NULL"


def parse_date(s):
    """Return ISO date 'YYYY-MM-DD' or None."""
    if not s:
        return None
    s = str(s).strip()
    if not s:
        return None
    fmts = ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"]
    for f in fmts:
        try:
            return datetime.strptime(s, f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # try splitting off time portion
    if " " in s:
        ts = parse_ts(s)
        if ts:
            return ts.split(" ")[0]
    return None


def parse_ts(s):
    """Return ISO timestamp 'YYYY-MM-DD HH:MM:SS' or None."""
    if not s:
        return None
    s = str(s).strip()
    if not s:
        return None
    # remove commas like '4/28/2026, 11:38:15 AM'
    s = s.replace(",", "")
    fmts = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%SZ",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y",
        "%Y-%m-%d",
    ]
    for f in fmts:
        try:
            return datetime.strptime(s, f).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return None


def date_q(s):
    d = parse_date(s)
    return f"'{d}'::date" if d else "NULL"


def ts_q(s):
    t = parse_ts(s)
    return f"'{t}'::timestamptz" if t else "NULL"


def jsonb_q(s):
    if s is None:
        return "NULL"
    s = str(s).strip()
    if not s:
        return "NULL"
    try:
        json.loads(s)
    except Exception:
        return "NULL"
    return q(s) + "::jsonb"


# ---------- enum mappers ----------

def driver_status(s):
    if not s:
        return "'active'::driver_status"
    s = s.strip().lower().replace("-", "_").replace(" ", "_")
    valid = {"pre_onboarding", "onboarding", "active", "inactive", "terminated"}
    if s in valid:
        return f"'{s}'::driver_status"
    return "'active'::driver_status"


def applicant_status(s):
    if not s:
        return "'new'::applicant_status"
    s = s.strip().lower().replace("-", "_").replace(" ", "_")
    valid = {"new", "screening", "passed", "failed", "waitlist", "booked",
             "hired", "not_hired", "no_show", "filtered", "promoted"}
    if s in valid:
        return f"'{s}'::applicant_status"
    return "'new'::applicant_status"


def priority_tier(s):
    if not s:
        return "'low'::priority_tier"
    s = s.strip().lower()
    if s in ("low", "standard", "priority"):
        return f"'{s}'::priority_tier"
    return "'low'::priority_tier"


def coaching_type(s):
    if not s:
        return "'SMS'::coaching_type"
    s = s.strip()
    valid = {"SMS", "InPerson", "Skipped", "StatusChange"}
    if s in valid:
        return f"'{s}'::coaching_type"
    # try common synonyms
    sl = s.lower().replace(" ", "")
    m = {"sms": "SMS", "inperson": "InPerson", "skipped": "Skipped", "statuschange": "StatusChange"}
    if sl in m:
        return f"'{m[sl]}'::coaching_type"
    return "'SMS'::coaching_type"


# ---------- SQL emitters ----------

def emit_settings(rows):
    sql = ["-- settings\n"]
    sql.append("INSERT INTO public.settings (dsp_id, key, value) VALUES")
    vals = []
    for r in rows:
        key = r.get("Setting", "").strip()
        val = r.get("Value", "")
        if not key:
            continue
        vals.append(f"  ('{DSP_ID}'::uuid, {q(key)}, {q(val)})")
    sql.append(",\n".join(vals))
    sql.append("ON CONFLICT (dsp_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();\n")
    return "\n".join(sql)


def emit_question_bank(rows):
    sql = ["-- question_bank\n"]
    sql.append("INSERT INTO public.question_bank (id, category, label, default_filter, amber_warn) VALUES")
    vals = []
    for r in rows:
        if not r.get("id"):
            continue
        vals.append(
            f"  ({q(r['id'])}, {q(r['category'])}, {q(r['label'])}, "
            f"{b(r.get('defaultFilter'))}, {qr(r.get('amberWarn',''))})"
        )
    sql.append(",\n".join(vals))
    sql.append("ON CONFLICT (id) DO UPDATE SET category=EXCLUDED.category, label=EXCLUDED.label, default_filter=EXCLUDED.default_filter, amber_warn=EXCLUDED.amber_warn;\n")
    return "\n".join(sql)


def emit_driver_roster(rows):
    sql = ["-- driver_roster\n"]
    sql.append("INSERT INTO public.driver_roster (dsp_id, transporter_id, driver_name, first_seen_date, hire_date, status, phone_number, phone_source, email, pipeline_score, pipeline_cycle, last_updated) VALUES")
    vals = []
    for r in rows:
        tid = r.get("transporter_id", "").strip()
        name = r.get("driver_name", "").strip()
        if not tid or not name:
            continue
        vals.append(
            f"  ('{DSP_ID}'::uuid, {q(tid)}, {q(name)}, {date_q(r.get('first_seen_date'))}, "
            f"{date_q(r.get('hire_date'))}, {driver_status(r.get('status'))}, "
            f"{q(r.get('phone_number'))}, {q(r.get('phone_source'))}, {q(r.get('email'))}, "
            f"{i(r.get('pipeline_score'))}, {i(r.get('pipeline_cycle'))}, "
            f"COALESCE({ts_q(r.get('last_updated'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append("ON CONFLICT (dsp_id, transporter_id) DO UPDATE SET driver_name=EXCLUDED.driver_name, status=EXCLUDED.status, phone_number=EXCLUDED.phone_number, email=EXCLUDED.email, last_updated=EXCLUDED.last_updated;\n")
    return "\n".join(sql)


def emit_applicants(rows):
    sql = ["-- applicants (Ingest tab)\n"]
    sql.append("INSERT INTO public.applicants (dsp_id, first_name, last_name, phone, email, contacted, status, booking_time, score, priority, ingested_at, attendance, source, video_status, video_url, video_recorded_at, video_transcript, video_score) VALUES")
    vals = []
    for r in rows:
        first = r.get("First Name", "").strip()
        last = r.get("Last Name", "").strip()
        if not first and not last:
            continue
        vals.append(
            f"  ('{DSP_ID}'::uuid, {q(first)}, {q(last)}, {q(r.get('Phone Numer') or r.get('Phone'))}, "
            f"{q(r.get('Email'))}, {q(r.get('Contacted'))}, {applicant_status(r.get('Status'))}, "
            f"{ts_q(r.get('Booking Time'))}, COALESCE({i(r.get('Score'))}, 0), "
            f"{priority_tier(r.get('Priority'))}, "
            f"COALESCE({ts_q(r.get('Ingested'))}, now()), "
            f"{q(r.get('Attendance'))}, {q(r.get('Source'))}, "
            f"{q(r.get('VideoStatus'))}, {q(r.get('VideoURL'))}, "
            f"{ts_q(r.get('VideoRecordedAt'))}, {q(r.get('VideoTranscript'))}, "
            f"{i(r.get('VideoScore'))})"
        )
    sql.append(",\n".join(vals))
    sql.append(";\n")
    return "\n".join(sql)


def emit_failures(rows):
    sql = ["-- failures\n"]
    sql.append("INSERT INTO public.failures (dsp_id, type, identifier, reason, created_at) VALUES")
    vals = []
    for r in rows:
        t = r.get("Type", "").strip()
        if not t:
            continue
        vals.append(
            f"  ('{DSP_ID}'::uuid, {q(t)}, {q(r.get('Identifier'))}, {q(r.get('Reason'))}, "
            f"COALESCE({ts_q(r.get('Timestamp'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append(";\n")
    return "\n".join(sql)


def emit_message_queue(rows):
    sql = ["-- message_queue\n"]
    sql.append("INSERT INTO public.message_queue (dsp_id, recipient, channel, subject, body, status, queued_at) VALUES")
    vals = []
    for r in rows:
        recip = r.get("To", "").strip()
        body = r.get("Body", "").strip()
        if not recip or not body:
            continue
        status = r.get("Status", "pending").strip().lower() or "pending"
        vals.append(
            f"  ('{DSP_ID}'::uuid, {q(recip)}, {q(r.get('Type','sms'))}, "
            f"{q(r.get('Subject'))}, {q(body)}, {q(status)}, "
            f"COALESCE({ts_q(r.get('Queued'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append(";\n")
    return "\n".join(sql)


def emit_decisions_log(rows):
    sql = ["-- decisions_log\n"]
    sql.append("INSERT INTO public.decisions_log (dsp_id, trigger, throttle_mode, risk_level, seven_am_preview, indeed_action, full_payload, created_at) VALUES")
    vals = []
    for r in rows:
        trig = r.get("Trigger", "").strip()
        if not trig:
            continue
        vals.append(
            f"  ('{DSP_ID}'::uuid, {q(trig)}, {q(r.get('ThrottleMode'))}, "
            f"{q(r.get('RiskLevel'))}, {q(r.get('SevenAM Preview'))}, "
            f"{q(r.get('Indeed Action'))}, {jsonb_q(r.get('Full JSON'))}, "
            f"COALESCE({ts_q(r.get('Timestamp'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append(";\n")
    return "\n".join(sql)


def emit_coaching_log(rows):
    sql = ["-- coaching_log\n"]
    sql.append("INSERT INTO public.coaching_log (id, dsp_id, transporter_id, driver_name, type, triggered_by_event_id, message_body, guide_attached, sent_by, created_at) VALUES")
    vals = []
    for r in rows:
        cid = r.get("coaching_id", "").strip()
        tid = r.get("transporter_id", "").strip()
        if not cid or not tid:
            continue
        vals.append(
            f"  ({q(cid)}, '{DSP_ID}'::uuid, {q(tid)}, {q(r.get('driver_name'))}, "
            f"{coaching_type(r.get('type'))}, {q(r.get('triggered_by_event_id'))}, "
            f"{q(r.get('message_body'))}, {q(r.get('guide_attached'))}, "
            f"{q(r.get('sent_by'))}, COALESCE({ts_q(r.get('timestamp'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append("ON CONFLICT (id) DO NOTHING;\n")
    return "\n".join(sql)


def emit_safety_events(rows):
    sql = ["-- safety_events\n"]
    sql.append("INSERT INTO public.safety_events (event_id, dsp_id, transporter_id, driver_name, vin, event_date, event_datetime, metric_type, metric_subtype, program_impact, source, video_link, review_status, ingested_at) VALUES")
    vals = []
    for r in rows:
        eid = r.get("event_id", "").strip()
        tid = r.get("transporter_id", "").strip()
        ed = parse_date(r.get("event_date"))
        if not eid or not tid or not ed:
            continue
        vals.append(
            f"  ({q(eid)}, '{DSP_ID}'::uuid, {q(tid)}, {q(r.get('driver_name'))}, "
            f"{q(r.get('vin'))}, '{ed}'::date, {ts_q(r.get('event_datetime'))}, "
            f"{q(r.get('metric_type'))}, {q(r.get('metric_subtype'))}, "
            f"{q(r.get('program_impact'))}, {q(r.get('source'))}, "
            f"{q(r.get('video_link'))}, {q(r.get('review_status'))}, "
            f"COALESCE({ts_q(r.get('ingested_at'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append("ON CONFLICT (event_id) DO NOTHING;\n")
    return "\n".join(sql)


def emit_quality_daily(rows):
    sql = ["-- quality_daily\n"]
    sql.append("INSERT INTO public.quality_daily (day_id, dsp_id, transporter_id, driver_name, event_date, packages_delivered, routes_completed, dcr_pct, pod_pct, dsb_count, ingested_at) VALUES")
    vals = []
    for r in rows:
        did = r.get("day_id", "").strip()
        tid = r.get("transporter_id", "").strip()
        ed = parse_date(r.get("event_date"))
        if not did or not tid or not ed:
            continue
        vals.append(
            f"  ({q(did)}, '{DSP_ID}'::uuid, {q(tid)}, {q(r.get('driver_name'))}, "
            f"'{ed}'::date, {i(r.get('packages_delivered'))}, "
            f"{i(r.get('routes_completed'))}, {n(r.get('dcr_pct'))}, "
            f"{n(r.get('pod_pct'))}, {i(r.get('dsb_count'))}, "
            f"COALESCE({ts_q(r.get('ingested_at'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append("ON CONFLICT (day_id) DO NOTHING;\n")
    return "\n".join(sql)


def emit_video_recordings(rows):
    sql = ["-- video_recordings\n"]
    sql.append("INSERT INTO public.video_recordings (dsp_id, applicant_email, applicant_phone, video_url, duration_seconds, status, transcript, ai_response, error_log, user_agent, created_at) VALUES")
    vals = []
    for r in rows:
        vu = r.get("Video URL", "").strip()
        if not vu:
            continue
        vals.append(
            f"  ('{DSP_ID}'::uuid, {q(r.get('Applicant Email'))}, "
            f"{q(r.get('Applicant Phone'))}, {q(vu)}, "
            f"{i(r.get('Duration (sec)'))}, {q(r.get('Status'))}, "
            f"{q(r.get('Transcript'))}, {jsonb_q(r.get('AI Response (JSON)'))}, "
            f"{q(r.get('Error Log'))}, {q(r.get('User Agent'))}, "
            f"COALESCE({ts_q(r.get('Timestamp'))}, now()))"
        )
    sql.append(",\n".join(vals))
    sql.append(";\n")
    return "\n".join(sql)


# ---------- driver_roster_id backfill ----------

BACKFILL = f"""-- backfill driver_roster_id on dependent tables
UPDATE public.coaching_log cl
SET driver_roster_id = dr.id
FROM public.driver_roster dr
WHERE cl.dsp_id = dr.dsp_id
  AND cl.transporter_id = dr.transporter_id
  AND cl.driver_roster_id IS NULL
  AND cl.dsp_id = '{DSP_ID}'::uuid;

UPDATE public.safety_events se
SET driver_roster_id = dr.id
FROM public.driver_roster dr
WHERE se.dsp_id = dr.dsp_id
  AND se.transporter_id = dr.transporter_id
  AND se.driver_roster_id IS NULL
  AND se.dsp_id = '{DSP_ID}'::uuid;

UPDATE public.quality_daily qd
SET driver_roster_id = dr.id
FROM public.driver_roster dr
WHERE qd.dsp_id = dr.dsp_id
  AND qd.transporter_id = dr.transporter_id
  AND qd.driver_roster_id IS NULL
  AND qd.dsp_id = '{DSP_ID}'::uuid;
"""


VERIFY = f"""-- Phase 6: re-run all 6 functions, expect non-zero numbers now
select 'tiered_decision_counts' as fn, * from public.decision_view_tiered_counts();
select 'weekly_totals' as fn, * from public.weekly_totals();
select 'tiered_drivers_count' as label, count(*) as rows from public.decision_view_tiered();
select 'coaching_queue_count' as label, count(*) as rows from public.coaching_queue_for_date();
select public.morning_performance() as morning_performance;

-- Row counts per table
select 'driver_roster' tbl, count(*) from public.driver_roster where dsp_id='{DSP_ID}'::uuid
union all select 'safety_events', count(*) from public.safety_events where dsp_id='{DSP_ID}'::uuid
union all select 'quality_daily', count(*) from public.quality_daily where dsp_id='{DSP_ID}'::uuid
union all select 'coaching_log', count(*) from public.coaching_log where dsp_id='{DSP_ID}'::uuid
union all select 'decisions_log', count(*) from public.decisions_log where dsp_id='{DSP_ID}'::uuid
union all select 'failures', count(*) from public.failures where dsp_id='{DSP_ID}'::uuid
union all select 'message_queue', count(*) from public.message_queue where dsp_id='{DSP_ID}'::uuid
union all select 'video_recordings', count(*) from public.video_recordings where dsp_id='{DSP_ID}'::uuid
union all select 'applicants', count(*) from public.applicants where dsp_id='{DSP_ID}'::uuid
union all select 'settings', count(*) from public.settings where dsp_id='{DSP_ID}'::uuid
union all select 'question_bank', count(*) from public.question_bank;
"""


def main():
    data = load()
    header = (
        "-- Generated migration SQL — RouteReady Automation → Supabase\n"
        f"-- DSP: Aircapital ({DSP_ID})\n"
        f"-- Generated: {datetime.utcnow().isoformat()}Z\n"
        "BEGIN;\n\n"
    )
    footer = "\nCOMMIT;\n"

    # Phase 3
    p3 = header
    p3 += emit_settings(data[2]["rows"]) + "\n"
    p3 += emit_question_bank(data[9]["rows"]) + "\n"
    p3 += footer
    (OUT_DIR / "03_reference.sql").write_text(p3)

    # Phase 4
    p4 = header
    p4 += emit_driver_roster(data[22]["rows"]) + "\n"
    p4 += emit_applicants(data[1]["rows"]) + "\n"
    p4 += footer
    (OUT_DIR / "04_core.sql").write_text(p4)

    # Phase 5
    p5 = header
    p5 += emit_failures(data[7]["rows"]) + "\n"
    p5 += emit_message_queue(data[4]["rows"]) + "\n"
    p5 += emit_decisions_log(data[5]["rows"]) + "\n"
    p5 += emit_coaching_log(data[19]["rows"]) + "\n"
    p5 += emit_safety_events(data[20]["rows"]) + "\n"
    p5 += emit_quality_daily(data[21]["rows"]) + "\n"
    p5 += emit_video_recordings(data[23]["rows"]) + "\n"
    p5 += BACKFILL
    p5 += footer
    (OUT_DIR / "05_logs.sql").write_text(p5)

    # Phase 6
    (OUT_DIR / "06_verify.sql").write_text(VERIFY)

    for f in ["03_reference.sql", "04_core.sql", "05_logs.sql", "06_verify.sql"]:
        p = OUT_DIR / f
        print(f"{f:20s} {p.stat().st_size:>8d} bytes  {sum(1 for _ in p.open()):>5d} lines")


if __name__ == "__main__":
    main()
