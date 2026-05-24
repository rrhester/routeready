// explain-optimization-run · Workforce Optimization Engine · Step 9.
//
// POST { run_id, question, question_kind? }
//
// Reads optimization_runs + optimization_decisions (the audit data
// captured since step 1/2), assembles a tight context payload, and asks
// Claude to produce a natural-language explanation grounded ONLY in
// that data. The model is not allowed to hallucinate constraints,
// scores, or driver names not present in the captured record.
//
// Result is cached in optimization_explanations keyed on
// (run_id, question_kind, question_hash) so repeat asks return
// instantly without re-billing Anthropic.
//
// Env (Supabase secrets):
//   ANTHROPIC_API_KEY   sk-ant-…                          (required)
//   ANTHROPIC_MODEL     defaults to claude-sonnet-4-6     (optional)
//   SUPABASE_URL                       auto-injected
//   SUPABASE_SERVICE_ROLE_KEY          auto-injected
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

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const MAX_DECISIONS_IN_PROMPT = 80;   // tokens budget

const SYSTEM_PROMPT = `You are an operations analyst for an Amazon DSP (delivery
service partner) explaining a scheduling decision to the dispatcher who
ran Smart Fill. The dispatcher has just clicked "Explain in plain
English" on a single optimization run.

You have access ONLY to the captured audit data for that run:
  • run.metrics — coverage %, assigned / uncovered / unscheduled counts
  • decisions[] — one row per shift the engine touched. Each row has:
      - shift_id, date, driver_id (or null = uncovered)
      - decision: 'assigned' | 'uncovered' | 'locked' | 'swap' |
        'fifth_day' | 'pattern_pass' | 'preserved' | 'skipped'
      - score_components (may be empty)
      - alternatives (may be empty)
      - binding_constraints (which hard rules constrained this slot)
      - reason_code, reason_message

RULES:
  1. Do NOT invent constraints, scores, driver names, or shifts not
     present in the captured data.
  2. If the user asks something the audit data can't answer (e.g.,
     about another week, about a driver not in the run), say so
     plainly and stop.
  3. Cite specific decisions when you reference them: "[decision <id>]"
     after the claim.
  4. Be terse. Two short paragraphs MAX. Bullet points are fine.
  5. Lead with the answer. No throat-clearing.
  6. When the question_kind is 'summary', produce a 2-3 bullet
     executive summary of the run's outcomes.

Output the answer as plain text. No markdown headers, no preamble.`;

const KIND_DEFAULT_PROMPTS: Record<string, string> = {
  summary:        "Give me a quick executive summary of this run's outcomes.",
  shift_change:   "Why was this shift assigned the way it was?",
  uncovered:      "Why is this shift uncovered?",
  driver_idle:    "Why didn't this driver get any shifts?",
  overtime:       "Where is the overtime exposure on this schedule coming from?",
  risk:           "Which drivers or shifts pose the biggest operational risk this week?",
  forecast:       "Based on this run, how many more drivers should we hire?",
  free_text:      "",
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function compactDecisions(decisions: any[]): any[] {
  // Trim each decision down to the fields the model needs. Reduces
  // token cost ~70% without losing signal.
  return decisions.slice(0, MAX_DECISIONS_IN_PROMPT).map((d) => ({
    id: d.id,
    shift_id: d.shift_id,
    driver_id: d.driver_id,
    decision: d.decision,
    binding_constraints: d.binding_constraints || [],
    reason_code: d.reason_code,
    reason_message: d.reason_message,
    score_components: d.score_components,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  // Auth — caller's JWT must resolve to an app_users row.
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
    return json({ error: "invalid_json" }, 400);
  }
  const runId = String(body.run_id || "");
  const questionKind = String(body.question_kind || "free_text");
  const userQuestion = String(body.question || KIND_DEFAULT_PROMPTS[questionKind] || "").trim();
  if (!runId) return badRequest("run_id required");
  if (!userQuestion) return badRequest("question (or question_kind with a default) required");

  // Load the run + decisions, scoped to the caller's DSP.
  const { data: run, error: runErr } = await supa
    .from("optimization_runs")
    .select("id, dsp_id, week_start, trigger_kind, solver_version, status, metrics, result")
    .eq("id", runId)
    .eq("dsp_id", appUser.dsp_id)
    .maybeSingle();
  if (runErr || !run) return json({ error: "run_not_found" }, 404);

  const { data: decisions, error: decErr } = await supa
    .from("optimization_decisions")
    .select("id, shift_id, driver_id, decision, total_score, score_components, binding_constraints, alternatives, ad_hoc_constraint_ids, reason_code, reason_message")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (decErr) return json({ error: "decisions_load_failed", details: decErr.message }, 500);

  // Cache lookup.
  const cacheHash = await sha256Hex(`${questionKind}::${userQuestion}`);
  const { data: cached } = await supa
    .from("optimization_explanations")
    .select("*")
    .eq("run_id", runId)
    .eq("hash", cacheHash)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cached) {
    return json({ answer: cached.answer, cached: true, generated_at: cached.generated_at });
  }

  // Build the user message with the audit context.
  const compactRun = {
    week_start: run.week_start,
    trigger_kind: run.trigger_kind,
    solver_version: run.solver_version,
    status: run.status,
    metrics: run.metrics,
  };
  const compactDecs = compactDecisions(decisions || []);
  const userMessage = [
    `Question kind: ${questionKind}`,
    `Question: ${userQuestion}`,
    "",
    "Run metadata:",
    JSON.stringify(compactRun, null, 2),
    "",
    `Decisions (first ${compactDecs.length} of ${(decisions || []).length}):`,
    JSON.stringify(compactDecs, null, 2),
  ].join("\n");

  // Call Anthropic.
  const anthropicReq = {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  };
  let model = DEFAULT_MODEL;
  let answer = "";
  let promptTokens = 0;
  let outputTokens = 0;
  let citedIds: string[] = [];

  try {
    const resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicReq),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return json({ error: "anthropic_failed", status: resp.status, body: text }, 502);
    }
    const data = await resp.json();
    model = data.model || DEFAULT_MODEL;
    promptTokens = data.usage?.input_tokens || 0;
    outputTokens = data.usage?.output_tokens || 0;
    const textBlocks = (data.content || []).filter((b: any) => b.type === "text");
    answer = textBlocks.map((b: any) => b.text).join("\n").trim();
    // Pluck cited decision IDs from "[decision <uuid>]" patterns.
    const uuidMatches = answer.matchAll(/\[decision\s+([0-9a-fA-F-]{36})\]/g);
    citedIds = Array.from(uuidMatches).map((m) => m[1]);
  } catch (e) {
    return json({ error: "anthropic_unreachable", details: String(e) }, 502);
  }
  if (!answer) return json({ error: "empty_answer" }, 502);

  // Cache.
  const { error: cacheErr } = await supa.from("optimization_explanations").insert({
    run_id: runId,
    question: userQuestion,
    question_kind: questionKind,
    answer,
    cited_decisions: citedIds,
    model,
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    hash: cacheHash,
  });
  if (cacheErr) {
    // Non-fatal: the operator still gets the answer. Just log.
    console.warn("optimization_explanations insert failed:", cacheErr.message);
  }

  return json({
    answer,
    cached: false,
    model,
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    cited_decisions: citedIds,
  });
});
