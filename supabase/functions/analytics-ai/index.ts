// analytics-ai · RouteReady's AI-first analytics agent.
//
// POST { prompt: string, conversation?: ChatMessage[] }
//
// Calls Anthropic's Messages API with a small set of DSP-scoped data
// tools, lets Claude pick the right ones to answer the prompt, then
// requires it to deliver the final output via the render_result tool —
// a strict JSON schema the dashboard knows how to draw (kpi / kpi_grid
// / table / text_summary / clarification_needed).
//
// All data queries are scoped to the caller's DSP via the JWT. The
// service-role client is used inside this function (RLS bypass) but
// every query explicitly filters by dsp_id so a caller can never see
// another tenant's data.
//
// Env (Supabase secrets):
//   ANTHROPIC_API_KEY   sk-ant-…                         (required)
//   ANTHROPIC_MODEL     defaults to claude-sonnet-4-6    (optional)
//   SUPABASE_URL        auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  auto-injected
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const MAX_TOOL_ITERATIONS = 10;
const MAX_TOOL_ROWS = 200;

// ───────────────────────────────────────────────────────────────────────
// Tool catalogue — each tool is one DSP-scoped Supabase query. Claude
// picks which to call. Every implementation MUST filter by dsp_id.
// ───────────────────────────────────────────────────────────────────────

type ToolContext = { supa: ReturnType<typeof serviceClient>; dspId: string };

const TOOLS = [
  {
    name: "query_drivers",
    description:
      "Look up drivers in this DSP. Use this for any prompt about specific drivers, license expiry, certifications, hire dates, station assignments, or driver counts. Returns up to 200 rows.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by driver status. Common values: active, onboarding, inactive, terminated. Omit to include all non-terminated.",
        },
        station_code: { type: "string", description: "Filter by station code (e.g. KMO1)." },
        license_expires_within_days: {
          type: "integer",
          description: "Only include drivers whose driver's license (dl_expires_on) expires within this many days. Set to 0 for already-expired.",
        },
        hired_within_days: { type: "integer", description: "Only include drivers hired in the last N days." },
        limit: { type: "integer", description: "Max rows (1-200, default 50)." },
      },
    },
    handler: async (input: any, ctx: ToolContext) => {
      let q = ctx.supa
        .from("drivers")
        .select("id, full_name, status, hire_date, station_id, tier, score, metadata, stations(code, name)")
        .eq("dsp_id", ctx.dspId)
        .neq("status", "terminated")
        .order("hire_date", { ascending: false })
        .limit(Math.min(Math.max(parseInt(input.limit) || 50, 1), MAX_TOOL_ROWS));
      if (input.status) q = q.eq("status", String(input.status));
      if (input.station_code) {
        const { data: st } = await ctx.supa
          .from("stations").select("id").eq("dsp_id", ctx.dspId).eq("code", input.station_code).maybeSingle();
        if (st?.id) q = q.eq("station_id", st.id);
      }
      if (Number.isFinite(input.hired_within_days)) {
        const since = new Date(Date.now() - input.hired_within_days * 86_400_000).toISOString().slice(0, 10);
        q = q.gte("hire_date", since);
      }
      const { data, error } = await q;
      if (error) return { error: error.message };
      let rows = (data || []).map((d: any) => ({
        id: d.id,
        name: d.full_name,
        status: d.status,
        hire_date: d.hire_date,
        station: d.stations?.code || null,
        tier: d.tier,
        score: d.score,
        dl_expires_on: d.metadata?.dl_expires_on || null,
        dot_certified: !!d.metadata?.dot_certified,
        xl_certified: !!d.metadata?.xl_certified,
      }));
      if (Number.isFinite(input.license_expires_within_days)) {
        const cutoff = new Date(Date.now() + input.license_expires_within_days * 86_400_000).toISOString().slice(0, 10);
        rows = rows.filter((d) => d.dl_expires_on && d.dl_expires_on <= cutoff);
      }
      return { count: rows.length, rows };
    },
  },

  {
    name: "attendance_metrics",
    description:
      "Aggregate attendance over a date range: how many shifts were scheduled, completed, called off, no-show, or late. Use for prompts about callouts, no-shows, attendance health, reliability.",
    input_schema: {
      type: "object",
      properties: {
        date_range_days: { type: "integer", description: "Last N days to include. Default 30." },
        per_driver: { type: "boolean", description: "Group by driver instead of returning DSP-wide totals." },
        limit: { type: "integer", description: "Max driver rows when per_driver=true (default 25)." },
      },
    },
    handler: async (input: any, ctx: ToolContext) => {
      const days = Math.max(1, Math.min(parseInt(input.date_range_days) || 30, 180));
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const limit = Math.min(parseInt(input.limit) || 25, MAX_TOOL_ROWS);
      const { data, error } = await ctx.supa
        .from("shifts")
        .select("driver_id, status, drivers(full_name, stations(code))")
        .eq("dsp_id", ctx.dspId)
        .gte("date", since)
        .limit(MAX_TOOL_ROWS);
      if (error) return { error: error.message };
      const rows = data || [];
      const STATUSES = ["scheduled", "completed", "called_off", "no_show", "late"];
      if (!input.per_driver) {
        const totals: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const r of rows) totals[r.status] = (totals[r.status] || 0) + 1;
        const total = rows.length;
        const callouts = (totals.called_off || 0) + (totals.no_show || 0);
        return {
          date_range: { since, days },
          totals,
          total_shifts: total,
          callout_rate_pct: total > 0 ? Math.round((callouts / total) * 1000) / 10 : 0,
        };
      }
      const byDriver = new Map<string, any>();
      for (const r of rows) {
        if (!r.driver_id) continue;
        const d = byDriver.get(r.driver_id) || {
          driver_id: r.driver_id,
          name: (r as any).drivers?.full_name || "(unassigned)",
          station: (r as any).drivers?.stations?.code || null,
          scheduled: 0, completed: 0, called_off: 0, no_show: 0, late: 0,
        };
        d[r.status] = (d[r.status] || 0) + 1;
        byDriver.set(r.driver_id, d);
      }
      const list = Array.from(byDriver.values())
        .map((d) => ({ ...d, callouts: d.called_off + d.no_show }))
        .sort((a, b) => b.callouts - a.callouts || b.late - a.late)
        .slice(0, limit);
      return { date_range: { since, days }, drivers: list };
    },
  },

  {
    name: "license_status",
    description:
      "Driver-license expiry breakdown: counts of drivers whose DL has expired or expires within 7/30/60/90 days. Use for prompts about license risk, compliance, who needs to renew.",
    input_schema: { type: "object", properties: {} },
    handler: async (_input: any, ctx: ToolContext) => {
      const { data, error } = await ctx.supa
        .from("drivers")
        .select("id, full_name, status, metadata, stations(code)")
        .eq("dsp_id", ctx.dspId)
        .neq("status", "terminated")
        .limit(MAX_TOOL_ROWS);
      if (error) return { error: error.message };
      const today = new Date().toISOString().slice(0, 10);
      const buckets: Record<string, number> = { expired: 0, "within_7": 0, "within_30": 0, "within_60": 0, "within_90": 0, beyond_90: 0, missing: 0 };
      const at_risk: any[] = [];
      for (const d of data || []) {
        const exp = (d as any).metadata?.dl_expires_on;
        if (!exp) { buckets.missing++; continue; }
        const days = Math.round((new Date(exp).getTime() - new Date(today).getTime()) / 86_400_000);
        if (days < 0) buckets.expired++;
        else if (days <= 7) buckets["within_7"]++;
        else if (days <= 30) buckets["within_30"]++;
        else if (days <= 60) buckets["within_60"]++;
        else if (days <= 90) buckets["within_90"]++;
        else buckets.beyond_90++;
        if (days <= 30) {
          at_risk.push({
            driver_id: d.id,
            name: (d as any).full_name,
            station: (d as any).stations?.code || null,
            dl_expires_on: exp,
            days_until: days,
          });
        }
      }
      at_risk.sort((a, b) => a.days_until - b.days_until);
      return { buckets, at_risk: at_risk.slice(0, 50), as_of: today };
    },
  },

  {
    name: "schedule_coverage",
    description:
      "Coverage % per day for an upcoming or past week. Coverage = filled shifts / needed shifts. Use for prompts about route coverage, capacity, gaps, weekly health.",
    input_schema: {
      type: "object",
      properties: {
        week_offset: {
          type: "integer",
          description: "Weeks from this Monday. 0 = this week, 1 = next, -1 = last. Default 0.",
        },
      },
    },
    handler: async (input: any, ctx: ToolContext) => {
      const offset = parseInt(input.week_offset) || 0;
      const monday = (() => {
        const d = new Date();
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() - day + 1 + offset * 7);
        return d.toISOString().slice(0, 10);
      })();
      const sunday = new Date(new Date(monday).getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await ctx.supa
        .from("shifts")
        .select("date, driver_id, status")
        .eq("dsp_id", ctx.dspId)
        .gte("date", monday)
        .lte("date", sunday)
        .limit(MAX_TOOL_ROWS * 4);
      if (error) return { error: error.message };
      const byDay = new Map<string, { needed: number; filled: number }>();
      for (let i = 0; i < 7; i++) {
        const k = new Date(new Date(monday).getTime() + i * 86_400_000).toISOString().slice(0, 10);
        byDay.set(k, { needed: 0, filled: 0 });
      }
      for (const r of data || []) {
        const k = (r as any).date;
        const slot = byDay.get(k);
        if (!slot) continue;
        slot.needed++;
        if ((r as any).driver_id && ["scheduled", "completed"].includes((r as any).status)) slot.filled++;
      }
      const days = Array.from(byDay.entries()).map(([date, s]) => ({
        date,
        needed: s.needed,
        filled: s.filled,
        coverage_pct: s.needed > 0 ? Math.round((s.filled / s.needed) * 1000) / 10 : null,
      }));
      const totalN = days.reduce((a, d) => a + d.needed, 0);
      const totalF = days.reduce((a, d) => a + d.filled, 0);
      return {
        week_start: monday,
        week_end: sunday,
        days,
        weekly_coverage_pct: totalN > 0 ? Math.round((totalF / totalN) * 1000) / 10 : null,
      };
    },
  },

  {
    name: "applicant_pipeline",
    description:
      "Applicant funnel snapshot: counts by status (applied, screening, interview, hired, rejected, etc.) over a date range. Use for hiring-pipeline, conversion, source, show-rate prompts.",
    input_schema: {
      type: "object",
      properties: {
        date_range_days: { type: "integer", description: "Last N days. Default 30." },
      },
    },
    handler: async (input: any, ctx: ToolContext) => {
      const days = Math.max(1, Math.min(parseInt(input.date_range_days) || 30, 365));
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await ctx.supa
        .from("applicants")
        .select("id, status, source, created_at")
        .eq("dsp_id", ctx.dspId)
        .gte("created_at", since)
        .limit(MAX_TOOL_ROWS * 4);
      if (error) return { error: error.message };
      const byStatus: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      for (const r of data || []) {
        const s = (r as any).status || "unknown";
        const src = (r as any).source || "unknown";
        byStatus[s] = (byStatus[s] || 0) + 1;
        bySource[src] = (bySource[src] || 0) + 1;
      }
      return { date_range: { since, days }, total: (data || []).length, by_status: byStatus, by_source: bySource };
    },
  },

  // ── Fleet ────────────────────────────────────────────────────────
  {
    name: "query_vehicles",
    description:
      "Look up vehicles in this DSP's fleet. Use for any question about vans / vehicles — names, VINs, branded status, ownership type, operational status (active / grounded), how many days a van has been grounded, or recent rotation usage. Returns up to 200 rows.",
    input_schema: {
      type: "object",
      properties: {
        operational_status: { type: "string", description: "Filter by 'active' or 'grounded'." },
        branded:            { type: "boolean", description: "true → only branded (Amazon-wrapped) vans; false → only non-branded." },
        ownership:          { type: "string", description: "amazon_owned | dsp_owned | rental | leased" },
        grounded_for_at_least_days: { type: "integer", description: "Only include grounded vans that have been grounded this many days or more." },
      },
    },
    handler: async (input: any, { supa, dspId }: ToolContext) => {
      let q = supa.from("vehicles")
        .select("id, name, vin, is_branded, ownership, status, operational_status, grounded_since, archived_at")
        .eq("dsp_id", dspId)
        .is("archived_at", null)
        .limit(MAX_TOOL_ROWS);
      if (input.operational_status) q = q.eq("operational_status", input.operational_status);
      if (typeof input.branded === "boolean") q = q.eq("is_branded", input.branded);
      if (input.ownership) q = q.eq("ownership", input.ownership);
      if (typeof input.grounded_for_at_least_days === "number" && input.grounded_for_at_least_days > 0) {
        const cutoff = new Date(Date.now() - input.grounded_for_at_least_days * 86400000).toISOString();
        q = q.lte("grounded_since", cutoff).eq("operational_status", "grounded");
      }
      const { data, error } = await q.order("name");
      if (error) return { error: error.message };
      const today = Date.now();
      const rows = (data || []).map((v: any) => ({
        id: v.id,
        name: v.name,
        vin: v.vin,
        branded: !!v.is_branded,
        ownership: v.ownership,
        status: v.status,
        operational_status: v.operational_status,
        grounded_since: v.grounded_since,
        grounded_days: v.grounded_since ? Math.floor((today - new Date(v.grounded_since).getTime()) / 86400000) : null,
      }));
      return { total: rows.length, rows };
    },
  },

  // ── Time off / PTO ───────────────────────────────────────────────
  {
    name: "time_off_overview",
    description:
      "Summarize PTO and time-off activity. Use when the prompt asks about pending requests, who's out, upcoming PTO, PTO usage, or unpaid time off. Returns counts by status + the next upcoming approved windows.",
    input_schema: {
      type: "object",
      properties: {
        status:         { type: "string", description: "pending | approved | denied | cancelled (omit for all)" },
        upcoming_days:  { type: "integer", description: "Limit approved-window list to start_date within this many days. Default 30." },
      },
    },
    handler: async (input: any, { supa, dspId }: ToolContext) => {
      const since = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + (input.upcoming_days ?? 30) * 86400000).toISOString().slice(0, 10);
      let q = supa.from("time_off_requests")
        .select("id, driver_id, start_date, end_date, status, is_pto, reason, drivers:driver_id(full_name)")
        .eq("dsp_id", dspId)
        .limit(MAX_TOOL_ROWS);
      if (input.status) q = q.eq("status", input.status);
      const { data, error } = await q.order("start_date", { ascending: false });
      if (error) return { error: error.message };
      const byStatus: Record<string, number> = {};
      const upcoming: any[] = [];
      const ptoOnly = (data || []).filter((r: any) => r.is_pto !== false);
      for (const r of (data || [])) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        if (r.status === "approved" && r.start_date >= since && r.start_date <= horizon) {
          upcoming.push({
            driver_name: (r as any).drivers?.full_name || "(unknown)",
            start_date: r.start_date,
            end_date: r.end_date,
            is_pto: !!r.is_pto,
            reason: r.reason,
          });
        }
      }
      upcoming.sort((a, b) => a.start_date.localeCompare(b.start_date));
      return {
        total: (data || []).length,
        pto_count: ptoOnly.length,
        by_status: byStatus,
        upcoming_approved: upcoming.slice(0, 50),
      };
    },
  },

  // ── Recognition history ─────────────────────────────────────────
  {
    name: "recognition_history",
    description:
      "Look up recognition events (kudos, birthdays, anniversaries, safety milestones) sent in this DSP. Use for prompts about who's been recognized recently, recognition trends by kind, or per-driver recognition history.",
    input_schema: {
      type: "object",
      properties: {
        days:    { type: "integer", description: "How many days back to look. Default 30." },
        kind:    { type: "string", description: "Filter by recognition kind (e.g. birthday, work_anniversary, safety_milestone, custom)." },
        driver_id: { type: "string", description: "Optional driver UUID." },
      },
    },
    handler: async (input: any, { supa, dspId }: ToolContext) => {
      const days = Math.max(1, Math.min(365, input.days || 30));
      const since = new Date(Date.now() - days * 86400000).toISOString();
      let q = supa.from("driver_recognitions")
        .select("id, driver_id, kind, title, sent_at, scheduled_for, status, drivers:driver_id(full_name)")
        .eq("dsp_id", dspId)
        .gte("sent_at", since)
        .eq("status", "sent")
        .limit(MAX_TOOL_ROWS);
      if (input.kind) q = q.eq("kind", input.kind);
      if (input.driver_id) q = q.eq("driver_id", input.driver_id);
      const { data, error } = await q.order("sent_at", { ascending: false });
      if (error) return { error: error.message };
      const byKind: Record<string, number> = {};
      const rows = (data || []).map((r: any) => {
        byKind[r.kind] = (byKind[r.kind] || 0) + 1;
        return {
          id: r.id,
          driver_id: r.driver_id,
          driver_name: r.drivers?.full_name || "(unknown)",
          kind: r.kind,
          title: r.title,
          sent_at: r.sent_at,
        };
      });
      return {
        date_range: { since: since.slice(0, 10), days },
        total: rows.length,
        by_kind: byKind,
        rows: rows.slice(0, 80),
      };
    },
  },

  // ── Overtime analysis ───────────────────────────────────────────
  {
    name: "overtime_analysis",
    description:
      "Aggregate paid hours per driver across a date range and surface who's over / approaching the weekly OT threshold (40 h by default). Use for OT exposure, cost questions, who's at risk this week.",
    input_schema: {
      type: "object",
      properties: {
        week_start: { type: "string", description: "ISO date (YYYY-MM-DD) for the Monday/Sunday of the week to analyze. Defaults to current week." },
        threshold:  { type: "integer", description: "Hours that count as OT. Default 40." },
      },
    },
    handler: async (input: any, { supa, dspId }: ToolContext) => {
      const today = new Date();
      const dow = today.getUTCDay();
      const monday = new Date(today.getTime() - dow * 86400000);
      const wkStart = (input.week_start || monday.toISOString().slice(0, 10));
      const wkEnd = new Date(new Date(wkStart + "T12:00:00").getTime() + 6 * 86400000).toISOString().slice(0, 10);
      const threshold = input.threshold || 40;
      const { data, error } = await supa.from("shifts")
        .select("driver_id, date, starts_at, ends_at, status, block_hours, drivers:driver_id(full_name)")
        .eq("dsp_id", dspId)
        .gte("date", wkStart).lte("date", wkEnd)
        .in("status", ["scheduled", "completed", "late"])
        .limit(2000);
      if (error) return { error: error.message };
      const byDriver = new Map<string, { name: string; hours: number; shifts: number }>();
      for (const s of (data || [])) {
        const dur = s.block_hours
          || ((s.starts_at && s.ends_at) ? ((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 3600000) : 10);
        const cur = byDriver.get(s.driver_id) || { name: (s as any).drivers?.full_name || "(unknown)", hours: 0, shifts: 0 };
        cur.hours += dur;
        cur.shifts += 1;
        byDriver.set(s.driver_id, cur);
      }
      const rows = [...byDriver.entries()]
        .map(([id, v]) => ({ driver_id: id, name: v.name, hours: Math.round(v.hours * 10) / 10, shifts: v.shifts, over_threshold: v.hours > threshold }))
        .sort((a, b) => b.hours - a.hours);
      return {
        week: { start: wkStart, end: wkEnd },
        threshold,
        total_drivers: rows.length,
        drivers_over_threshold: rows.filter(r => r.over_threshold).length,
        total_ot_hours: rows.reduce((s, r) => s + Math.max(0, r.hours - threshold), 0),
        rows,
      };
    },
  },

  // ── Recent attendance issues ────────────────────────────────────
  {
    name: "attendance_incidents",
    description:
      "List recent attendance incidents (late, no-show, called-off) with the dispatcher's decision. Use for accountability questions, repeat-offender analysis, or coaching prep.",
    input_schema: {
      type: "object",
      properties: {
        days:        { type: "integer", description: "How many days back to scan. Default 30." },
        outcome:     { type: "string", description: "tardy | ncns | missed_reported (omit for all three)." },
        driver_id:   { type: "string", description: "Optional driver UUID." },
        decided:     { type: "boolean", description: "true → only rows with a decision; false → only undecided." },
      },
    },
    handler: async (input: any, { supa, dspId }: ToolContext) => {
      const days = Math.max(1, Math.min(180, input.days || 30));
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let q = supa.from("today_attendance_history")
        .select("date, driver_id, driver_name, computed_outcome, decision, missed_reason, starts_at")
        .eq("dsp_id", dspId)
        .gte("date", since)
        .in("computed_outcome", ["tardy", "ncns", "missed_reported"])
        .limit(MAX_TOOL_ROWS);
      if (input.outcome)  q = q.eq("computed_outcome", input.outcome);
      if (input.driver_id) q = q.eq("driver_id", input.driver_id);
      if (typeof input.decided === "boolean") {
        q = input.decided ? q.not("decision", "is", null) : q.is("decision", null);
      }
      const { data, error } = await q.order("date", { ascending: false });
      if (error) {
        // Fall back to live today_attendance if the history view isn't
        // present in this environment. Better to surface incomplete
        // data than 500 the chat.
        return { error: error.message, hint: "today_attendance_history may not be available; try attendance_metrics for week aggregates." };
      }
      const byOutcome: Record<string, number> = {};
      const byDriver = new Map<string, { name: string; tardy: number; ncns: number; missed: number }>();
      for (const r of (data || [])) {
        byOutcome[r.computed_outcome] = (byOutcome[r.computed_outcome] || 0) + 1;
        const cur = byDriver.get(r.driver_id) || { name: r.driver_name, tardy: 0, ncns: 0, missed: 0 };
        if (r.computed_outcome === "tardy") cur.tardy += 1;
        else if (r.computed_outcome === "ncns") cur.ncns += 1;
        else cur.missed += 1;
        byDriver.set(r.driver_id, cur);
      }
      const repeat = [...byDriver.entries()]
        .map(([id, v]) => ({ driver_id: id, name: v.name, total: v.tardy + v.ncns + v.missed, tardy: v.tardy, ncns: v.ncns, missed: v.missed }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 50);
      return {
        date_range: { since, days },
        total: (data || []).length,
        by_outcome: byOutcome,
        repeat_offenders: repeat,
      };
    },
  },

  {
    name: "render_result",
    description:
      "TERMINAL TOOL — call this exactly once at the end to render the final answer in the dashboard. Pick the kind that fits the prompt. Always include a clear title, the human-readable source string, and (when relevant) the date range used. Suggest 2-4 short follow-up prompts.",
    input_schema: {
      type: "object",
      required: ["title", "kind", "data", "source"],
      properties: {
        title: { type: "string", description: "Short, specific title (e.g. 'Drivers with licenses expiring in 30 days')." },
        subtitle: { type: "string", description: "Optional context line under the title." },
        kind: {
          type: "string",
          enum: ["kpi", "kpi_grid", "table", "text_summary", "clarification_needed"],
        },
        data: {
          type: "object",
          description:
            "Shape varies by kind. kpi: { value, unit?, label, sublabel?, delta?, trend? }. kpi_grid: { items: [{ value, unit?, label, delta?, trend? }] }. table: { columns: [{ key, label, type? }], rows: [{ key: value }] }. text_summary: { body, bullets? }. clarification_needed: { message, suggestions: [string] }.",
        },
        source: { type: "string", description: "Human label for the underlying tables/RPCs used (e.g. 'drivers + shifts')." },
        date_range: {
          type: "object",
          properties: {
            start: { type: "string" }, end: { type: "string" }, label: { type: "string" },
          },
        },
        follow_up_suggestions: {
          type: "array", items: { type: "string" },
          description: "2-4 short follow-up prompts the dispatcher might naturally ask next.",
        },
      },
    },
    handler: async (input: any) => ({ __terminal__: true, payload: input }),
  },
] as const;

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

const SYSTEM_PROMPT = `You are RouteReady's analytics agent for a Delivery Service Partner (DSP). The dispatcher will ask natural-language questions about their operation. Use the data tools to gather what you need, then deliver the final answer by calling the render_result tool exactly once.

Data domains you can reach:
  * Drivers · query_drivers (roster, license, certs, hire date, station)
  * Fleet   · query_vehicles (vans, VIN, ownership, branded, grounded)
  * Schedule · schedule_coverage (filled vs needed per day), overtime_analysis (weekly hours, OT exposure)
  * Attendance · attendance_metrics (week aggregates), attendance_incidents (recent late / NCNS / called-off events with decisions)
  * Time off · time_off_overview (pending vs approved, upcoming PTO)
  * Recognition · recognition_history (recent kudos / milestones)
  * Compliance · license_status (expirations)
  * Pipeline · applicant_pipeline (hiring funnel)

Guidelines:
- Always scope your reasoning to this single DSP. The data tools are pre-scoped — you don't need to mention DSP IDs.
- For "broad" prompts (e.g. "give me a state-of-the-DSP", "anything I should worry about today?", "weekly briefing"): call 3-5 tools across domains, then synthesize. The agent is allowed to make multi-step plans.
- For specific prompts (e.g. "how many drivers expire next month?"), one tool is usually enough.
- Pick the simplest render kind that answers the question:
  * kpi for a single headline number ("how many active drivers?")
  * kpi_grid for 2-6 related numbers ("attendance health this month")
  * table for lists with multiple columns ("drivers with expiring licenses")
  * text_summary for narrative answers ("what should I watch today?") — include 2-5 short bullet points when useful
  * clarification_needed when the prompt is ambiguous (e.g. no time window for a trend) — include 2-3 sharper follow-up prompts
- Always set a clear, specific title and the human-readable source ("drivers", "drivers + shifts", "applicants", etc.).
- Include date_range whenever the answer depends on a window of time.
- Provide 2-4 follow-up_suggestions tailored to what you just showed; mix domains when the answer spans multiple data sources.
- Never fabricate fields or counts. If a tool returns 0 rows, say so honestly.
- If a tool returns an error, try a related one before giving up (e.g. attendance_incidents → attendance_metrics).
`;

// ───────────────────────────────────────────────────────────────────────
// Anthropic Messages API call + tool loop
// ───────────────────────────────────────────────────────────────────────

async function callClaude(messages: any[], apiKey: string) {
  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
      messages,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`anthropic_${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function runAgent(prompt: string, conversation: any[], ctx: ToolContext, apiKey: string) {
  const messages = [...(conversation || []), { role: "user", content: prompt }];
  const tool_calls: { name: string; input: any }[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const reply = await callClaude(messages, apiKey);
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = (reply.content || []).filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Ran out of tool calls without invoking render_result. Synthesize a
      // text summary from whatever the model said.
      const fallbackText = (reply.content || [])
        .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return {
        result: {
          title: "Answer",
          kind: "text_summary",
          data: { body: fallbackText || "No answer was produced." },
          source: "—",
          follow_up_suggestions: [],
        },
        tool_calls,
      };
    }

    // Execute every tool in this assistant turn
    const toolResults: any[] = [];
    for (const u of toolUses) {
      tool_calls.push({ name: u.name, input: u.input });
      const tool = TOOL_MAP.get(u.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ error: `unknown_tool: ${u.name}` }) });
        continue;
      }
      try {
        const out = await (tool as any).handler(u.input || {}, ctx);
        if (out && out.__terminal__) {
          // render_result called — terminate the loop and return Claude's payload
          return { result: out.payload, tool_calls };
        }
        toolResults.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 24_000) });
      } catch (e) {
        toolResults.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ error: String(e?.message || e) }) });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Iteration budget exhausted
  return {
    result: {
      title: "I need more turns to answer that",
      kind: "clarification_needed",
      data: {
        message: "The query needed more steps than I'm allowed to take. Try a more specific question.",
        suggestions: ["Show drivers with licenses expiring in 30 days", "Coverage % for this week", "Top callouts last 30 days"],
      },
      source: "—",
    },
    tool_calls,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Request handler
// ───────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  const auth = req.headers.get("authorization") || "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!jwt) return json({ error: "missing_auth" }, 401);

  const supa = serviceClient();
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "invalid_auth" }, 401);

  const { data: appUser, error: appErr } = await supa
    .from("app_users").select("dsp_id, role").eq("id", userData.user.id).eq("active", true).maybeSingle();
  if (appErr || !appUser) return json({ error: "no_dsp_membership" }, 403);
  // Only dispatchers + above can use analytics. Keep it consistent with
  // the rest of the read-mostly DSP staff surfaces.
  if (!["dispatcher", "ops", "owner", "platform_admin"].includes(appUser.role)) {
    return json({ error: "forbidden" }, 403);
  }

  // DB-backed daily cap shared with ai-proxy (project-review PR#62) — this
  // endpoint runs up to 10 tool iterations per request on the shared
  // Anthropic key and previously had no limiter at all.
  try {
    const { data: quota, error: qErr } = await supa.rpc("ai_proxy_note_request", {
      p_dsp_id: appUser.dsp_id,
      p_default_cap: 200,
    });
    if (!qErr && quota && (quota as { allowed?: boolean }).allowed === false) {
      return json({ error: "rate_limited", detail: "Daily AI request cap reached. Resets at midnight UTC." }, 429);
    }
    if (qErr) console.error("ai_proxy_note_request error:", qErr.message);
  } catch (e) { console.error("ai_proxy_note_request threw:", (e as Error)?.message); }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const prompt = String(body?.prompt || "").trim().slice(0, 4000);
  if (!prompt) return json({ error: "prompt_required" }, 400);
  // Bound + sanitize the client-supplied conversation: cap turns, and strip
  // any content blocks that would let the CLIENT forge tool_results (the
  // model must only ever see tool output this function itself produced).
  const rawConv = Array.isArray(body?.conversation) ? body.conversation : [];
  const conversation = rawConv.slice(-12).map((m: any) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: typeof m?.content === "string"
      ? m.content.slice(0, 8000)
      : Array.isArray(m?.content)
        ? m.content.filter((b: any) => b && (b.type === "text")).map((b: any) => ({ type: "text", text: String(b.text || "").slice(0, 8000) }))
        : "",
  })).filter((m: any) => (typeof m.content === "string" ? m.content : m.content.length));

  try {
    const { result, tool_calls } = await runAgent(
      prompt,
      conversation,
      { supa, dspId: appUser.dsp_id },
      apiKey,
    );
    return json({
      ok: true,
      result,
      meta: {
        prompt,
        generated_at: new Date().toISOString(),
        model: DEFAULT_MODEL,
        tools_used: tool_calls.map((t) => t.name).filter((n) => n !== "render_result"),
      },
    });
  } catch (e) {
    console.error("analytics-ai agent failed:", String(e?.message || e));
    return json({ error: "agent_failed" }, 500);
  }
});
