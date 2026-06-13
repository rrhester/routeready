// dispatch-optimization-run · Workforce Optimization Engine · Step 7.
//
// Edge function that wires the dashboard to the Python CP-SAT solver
// service. Dashboard POSTs the same sfPayload it would have run
// in-browser; this function forwards it to the solver, returns the
// SolveResponse verbatim. Dashboard then runs its existing
// record_optimization_result + write-back path unchanged.
//
// Why an edge function in the middle:
//   • Hides the solver's bearer token from the browser.
//   • Lets the solver URL change without redeploying the dashboard.
//   • Same DSP-scoped auth pattern (JWT → app_users → role gate) as
//     the rest of the AI / analytics surfaces.
//
// Env (Supabase secrets):
//   RR_SOLVER_URL   https://rr-solver.fly.dev   (required)
//   RR_SOLVER_TOKEN  same shared-secret set on the solver  (required)
//   SUPABASE_URL                 auto-injected
//   SUPABASE_SERVICE_ROLE_KEY    auto-injected
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const solverUrl = Deno.env.get("RR_SOLVER_URL");
  const solverToken = Deno.env.get("RR_SOLVER_TOKEN");
  if (!solverUrl || !solverToken) {
    return json({
      error: "solver_not_configured",
      hint: "Set RR_SOLVER_URL + RR_SOLVER_TOKEN as Supabase function secrets, " +
            "matching the values on the deployed solver service.",
    }, 503);
  }

  // Auth — JWT → app_users → role gate. Identical to explain-optimization-run.
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!jwt) return json({ error: "missing_auth" }, 401);

  const supa = serviceClient();
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "invalid_auth" }, 401);

  const { data: appUser } = await supa
    .from("app_users")
    .select("dsp_id, role")
    .eq("id", userData.user.id)
    .eq("active", true)
    .maybeSingle();
  if (!appUser) return json({ error: "no_dsp_membership" }, 403);
  if (!["dispatcher", "ops", "owner", "platform_admin"].includes(appUser.role)) {
    return json({ error: "forbidden" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid_json");
  }
  // Accept the dashboard's sfPayload directly OR wrapped as { payload }.
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : body;
  if (!payload || typeof payload !== "object") {
    return badRequest("payload required");
  }

  // Forward to the solver. The solver's /solve endpoint expects the
  // SolveRequest shape — which matches sfPayload after this small
  // canonicalization step (rename schedule_week_start, ensure arrays).
  const solverReq = {
    schedule_week_start: payload.schedule_week_start || payload.week_start,
    max_days: payload.max_days ?? 5,
    weekly_hour_cap: payload.weekly_hour_cap ?? 40,
    rules: payload.rules ?? {},
    drivers: Array.isArray(payload.drivers) ? payload.drivers : [],
    shifts: Array.isArray(payload.shifts) ? payload.shifts : [],
    vans: Array.isArray(payload.vans) ? payload.vans : [],
    van_pairings: Array.isArray(payload.van_pairings) ? payload.van_pairings : [],
    pto: Array.isArray(payload.pto) ? payload.pto : [],
    ad_hoc_constraints: Array.isArray(payload.ad_hoc_constraints)
      ? payload.ad_hoc_constraints
      : [],
    solver_seed: payload.solver_seed ?? 0,
    time_budget_ms: payload.time_budget_ms ?? 8000,
    // Diagnostic Trace Mode (opt-in). When the dashboard sets `trace: true`
    // the solver attaches a full decision report to the response. Pure
    // observability — never changes the schedule. run_id / dsp_id are echoed
    // into the trace's run summary so a saved report is traceable.
    trace: payload.trace === true,
    run_id: payload.run_id ?? null,
    dsp_id: payload.dsp_id ?? null,
  };

  const startedAt = Date.now();
  let solverResp: Response;
  try {
    solverResp = await fetch(`${solverUrl.replace(/\/$/, "")}/solve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${solverToken}`,
      },
      body: JSON.stringify(solverReq),
    });
  } catch (e) {
    return json({
      error: "solver_unreachable",
      details: String(e),
      solver_url: solverUrl,
    }, 502);
  }

  const elapsed = Date.now() - startedAt;
  if (!solverResp.ok) {
    const text = await solverResp.text();
    return json({
      error: "solver_failed",
      status: solverResp.status,
      body: text.slice(0, 2000),
      elapsed_ms: elapsed,
    }, 502);
  }

  const result = await solverResp.json();
  return json({
    ...result,
    dispatcher_elapsed_ms: elapsed,
  });
});
