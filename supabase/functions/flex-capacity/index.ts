// flex-capacity · RouteReady Flex Capacity Engine (edge).
//
// Answers: "If Amazon increased routes tomorrow, how many additional routes
// could this DSP absorb with existing driver availability before hiring?"
//
// POST body:
//   { week_start: "2026-05-25", growth_routes_per_day?: number,
//     scenario?: Scenario,                  // optional What-If (full shape)
//     scenario_simple?: SimpleScenario }    // optional What-If by counts —
//                                           // { addRoutesPerDay?, routeMultiplier?,
//                                           //   calloutCount?, attritionCount? },
//                                           // materialized deterministically against
//                                           // the live roster (see flex-capacity/src/simple.ts)
//
// Returns the FlexResult, and (when a scenario is supplied) a WhatIfResult.
//
// Same DSP-scoped auth pattern (JWT → app_users → role gate) as the other
// AI/analytics surfaces. All capacity math runs in the pure engine in
// /flex-capacity — this function only loads rows and shapes the response, so
// the identical engine can later run on a Fly.io worker for heavier
// simulation workloads (see flex-capacity/README.md).
//
// Env (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { buildFlexInput } from "../../../flex-capacity/src/adapter.ts";
import { computeFlexCapacity } from "../../../flex-capacity/src/engine.ts";
import { runWhatIf, type Scenario } from "../../../flex-capacity/src/whatif.ts";
import { materializeScenario, type SimpleScenario } from "../../../flex-capacity/src/simple.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

/** Add (days-1) to an ISO date → the inclusive week-end ISO date. */
function weekEnd(weekStart: string, days = 6): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ── Auth: JWT → app_users → role gate ──────────────────────────────────
  const authz = req.headers.get("authorization") || "";
  const jwt = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7) : "";
  if (!jwt) return json({ error: "missing_auth" }, 401);

  const supa = serviceClient();
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "invalid_auth" }, 401);
  const { data: appUser } = await supa
    .from("app_users")
    .select("dsp_id, role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!appUser?.dsp_id) return json({ error: "forbidden" }, 403);
  if (!["dispatcher", "ops", "owner"].includes(appUser.role)) return json({ error: "forbidden" }, 403);

  // ── Parse request ──────────────────────────────────────────────────────
  let body: {
    week_start?: string;
    growth_routes_per_day?: number;
    scenario?: Scenario;
    scenario_simple?: SimpleScenario;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid_json");
  }
  const weekStart = body.week_start;
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return badRequest("week_start required (YYYY-MM-DD)");
  const weekEndIso = weekEnd(weekStart);
  const dspId = appUser.dsp_id;

  // ── Load rows for the DSP-week (service role; explicit dsp scoping) ─────
  const [driversRes, ptoRes, shiftsRes, demandRes, settingsRes] = await Promise.all([
    supa
      .from("drivers")
      .select("id, status, dot_certified, xl_certified, edv_certified, metadata")
      .eq("dsp_id", dspId)
      .eq("status", "active"),
    supa
      .from("time_off_requests")
      .select("driver_id, start_date, end_date, status")
      .eq("dsp_id", dspId)
      .eq("status", "approved")
      .lte("start_date", weekEndIso)
      .gte("end_date", weekStart),
    supa
      .from("shifts")
      .select("driver_id, date, starts_at, ends_at, block_hours, status, shift_kind")
      .eq("dsp_id", dspId)
      .gte("date", weekStart)
      .lte("date", weekEndIso),
    supa
      .from("okami_demand")
      .select("date, target_routes, service_type_id")
      .eq("dsp_id", dspId)
      .gte("date", weekStart)
      .lte("date", weekEndIso),
    supa
      .from("scheduling_settings")
      .select("default_block_hours, cushion_pct, max_days_per_week")
      .eq("dsp_id", dspId)
      .eq("week_start", weekStart)
      .maybeSingle(),
  ]);

  const firstErr = driversRes.error || ptoRes.error || shiftsRes.error || demandRes.error;
  if (firstErr) return json({ error: "query_failed", detail: firstErr.message }, 500);

  // Settings may not be saved for the week yet — the adapter falls back to
  // safe defaults (block 10h, 5 days, cap = days*block, cushion 0).
  const settings = settingsRes.data || {};

  const input = buildFlexInput({
    weekStart,
    driverRows: driversRes.data ?? [],
    timeOffRows: ptoRes.data ?? [],
    shiftRows: shiftsRes.data ?? [],
    demandRows: demandRes.data ?? [],
    settings,
  });

  const growth = typeof body.growth_routes_per_day === "number" ? body.growth_routes_per_day : 0;
  const flex = computeFlexCapacity(input, growth);
  // Full scenario wins when both are supplied; scenario_simple is expanded
  // against the live roster (deterministic — see simple.ts).
  const scenario = body.scenario
    ?? (body.scenario_simple ? materializeScenario(input, body.scenario_simple) : null);
  const whatIf = scenario ? runWhatIf(input, scenario) : null;

  // Cache the latest base result for fast KPI reads / trend charts. Best
  // effort — a cache failure must never fail the request. (Skipped when the
  // flex_capacity_snapshots table hasn't been created yet.)
  try {
    await supa.from("flex_capacity_snapshots").upsert(
      {
        dsp_id: dspId,
        week_start: weekStart,
        current_routes: flex.kpi.currentRoutes,
        comfortable_capacity: flex.kpi.comfortableCapacity,
        stretch_capacity: flex.kpi.stretchCapacity,
        maximum_capacity: flex.kpi.maximumCapacity,
        comfortable_available: flex.kpi.comfortableRoutesAvailable,
        stretch_available: flex.kpi.stretchRoutesAvailable,
        maximum_available: flex.kpi.maximumRoutesAvailable,
        status: flex.kpi.status,
        result: flex,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "dsp_id,week_start" },
    );
  } catch (_) {
    // ignore — snapshot cache is optional
  }

  return jsonResponse({ flex, whatIf }, { headers: CORS });
});
