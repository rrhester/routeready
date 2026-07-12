// health · Unauthenticated liveness/readiness probe for an external uptime
// monitor (UptimeRobot, Better Stack, Pingdom, a cron curl, …).
//
// Point a monitor at:  https://<project>.functions.supabase.co/health
//   • 200 {status:"ok"}       → Postgres + PostgREST answered.
//   • 503 {status:"degraded"} → the database round-trip failed. Alert.
//
// This is the difference between learning the app is down from your monitor
// vs. from your customer. It returns ONLY up/down + latency — never any tenant
// data — so it is safe to expose. Gateway verify_jwt is off (see config.toml).
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const started = Date.now();
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const supa = serviceClient();
    // Cheapest round-trip that proves Postgres + PostgREST are alive: a
    // head-only (no rows) count against a tiny, always-present table. Uses the
    // service role so a grant/RLS quirk can't masquerade as an outage.
    const { error } = await supa
      .from("dsps")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) dbError = error.message;
    else dbOk = true;
  } catch (e) {
    dbError = (e as Error)?.message || "db_unreachable";
  }

  const body = {
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "up" : "down",
    ...(dbError ? { error: dbError } : {}),
    ms: Date.now() - started,
    time: new Date().toISOString(),
  };
  return jsonResponse(body, { status: dbOk ? 200 : 503, headers: CORS });
});
