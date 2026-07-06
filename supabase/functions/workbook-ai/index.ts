// workbook-ai · RouteReady's in-workbook AI analyst.
//
// POST { question: string, schema: SheetSchema[], conversation?: ChatMessage[] }
//
// Unlike analytics-ai (which queries the DSP database), this function
// answers questions about the *workbook the user is looking at*. The
// client sends a compact schema of its sheets — sheet names, column
// names + inferred types + a handful of sample values + row counts —
// and Claude returns a `render_plan`: a short narrative answer plus a
// set of widget specs (KPI / chart / table / insight) that reference
// columns by name. The workbook engine resolves those names to ranges
// and draws everything locally, so the actual cell data never has to
// leave the browser to be computed — only the lightweight schema does.
//
// One Claude round-trip, structured output forced via a single tool.
//
// Env (Supabase secrets):
//   ANTHROPIC_API_KEY   sk-ant-…                         (required)
//   ANTHROPIC_MODEL     defaults to claude-sonnet-4-6    (optional)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   auto-injected (auth gate)
import { serviceClient } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const MAX_SHEETS = 12;
const MAX_COLS = 40;
const MAX_SAMPLES = 4;

// ── The one terminal tool: a strict schema the workbook knows how to draw ──
const RENDER_PLAN_TOOL = {
  name: "render_plan",
  description:
    "Deliver the final answer. Call this exactly once. Provide a short narrative answer plus the widgets that best visualize it. Reference sheets and columns by their exact names from the provided schema.",
  input_schema: {
    type: "object",
    required: ["headline", "answer", "widgets"],
    properties: {
      headline: { type: "string", description: "Short board title, e.g. 'Routes by day, week 27'." },
      answer: {
        type: "string",
        description: "1–3 sentence plain-English answer to the question, grounded in the schema. State the takeaway; don't invent exact numbers you can't know from samples.",
      },
      widgets: {
        type: "array",
        description: "1–6 widgets that visualize the answer. Order them the way they should read top-to-bottom (KPIs first, then a chart, then a table).",
        items: {
          type: "object",
          required: ["type", "sheet", "title"],
          properties: {
            type: { type: "string", enum: ["kpi", "chart", "table", "insight"] },
            sheet: { type: "string", description: "Exact sheet name from the schema." },
            title: { type: "string", description: "Short widget title." },
            // kpi
            column: { type: "string", description: "kpi: the numeric column to aggregate (exact name)." },
            agg: { type: "string", enum: ["sum", "avg", "count", "min", "max", "last"], description: "kpi: how to aggregate the column. Default sum." },
            format: { type: "string", enum: ["number", "compact", "currency", "percent"], description: "kpi: value format. Use currency for money, percent for rates (0–1), compact for large counts." },
            target: { type: "number", description: "kpi: optional goal value to draw a progress gauge toward." },
            // chart
            chartType: { type: "string", enum: ["column", "bar", "line", "area", "pie", "scatter", "combo"], description: "chart: use line/area for a date/time dimension, column/bar for categories, pie for a share of a whole." },
            categoryColumn: { type: "string", description: "chart: the dimension column for the x-axis (a date or category). Pick a column that sits to the LEFT of the value columns." },
            valueColumns: { type: "array", items: { type: "string" }, description: "chart: one or more numeric columns to plot as series." },
            // table
            columns: { type: "array", items: { type: "string" }, description: "table: optional subset of columns to show; omit for all." },
          },
        },
      },
      followups: {
        type: "array",
        items: { type: "string" },
        description: "2–4 short natural follow-up questions the user might ask next.",
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are RouteReady's in-workbook analyst. A Delivery Service Partner (DSP) dispatcher is looking at a spreadsheet workbook and asks a natural-language question about the data in it. You are given the workbook's SCHEMA — each sheet's name, row count, and its columns (name, inferred type, and a few sample values). You do NOT get the full data; you get enough to decide WHICH sheet and columns answer the question and HOW to visualize them.

Deliver your answer by calling render_plan exactly once. Guidelines:
- Choose the single sheet that best answers the question (or a couple of widgets across sheets when it genuinely spans them). Reference sheets and columns by their EXACT names from the schema.
- Pick the simplest widgets that answer it:
  * kpi — a single headline number (a sum/avg/count/min/max of one numeric column). Add 2–4 KPIs when several numbers matter.
  * chart — a trend or comparison. Use line/area when the category column is a date; column/bar for categories; pie for share-of-total. The categoryColumn should sit to the LEFT of the valueColumns in the sheet's column order.
  * table — when the user wants to see the rows themselves.
  * insight — an automatic plain-English findings list for a sheet (peak, leader, trend). Good alongside a chart.
- Keep it to 1–6 widgets. Lead with KPIs, then a chart, then a table.
- Write the 'answer' as a direct, specific takeaway. It's fine to describe the shape of the data ("Wednesday is consistently the lightest day") but never fabricate exact totals you can't derive from the samples — the widgets compute the real numbers client-side.
- Always pick real column names. If a needed column doesn't exist, answer with what's available and say so briefly.
- Suggest 2–4 tailored follow-up questions.`;

function compactSchema(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SHEETS).map((s: any) => ({
    sheet: String(s?.sheet ?? "").slice(0, 80),
    rows: Number.isFinite(s?.rows) ? s.rows : undefined,
    columns: Array.isArray(s?.columns)
      ? s.columns.slice(0, MAX_COLS).map((c: any) => ({
          name: String(c?.name ?? "").slice(0, 80),
          type: ["number", "date", "cat", "text"].includes(c?.type) ? c.type : "text",
          samples: Array.isArray(c?.samples) ? c.samples.slice(0, MAX_SAMPLES).map((v: any) => String(v).slice(0, 40)) : [],
        }))
      : [],
  }));
}

async function callClaude(messages: any[], apiKey: string) {
  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [RENDER_PLAN_TOOL],
      tool_choice: { type: "tool", name: "render_plan" },
      messages,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`anthropic_${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  // Auth gate: this burns our API key, so require a signed-in DSP member.
  // We never read DSP data here — only the schema the client sends — but
  // the gate keeps the endpoint from being an open proxy to Anthropic.
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!jwt) return json({ error: "missing_auth" }, 401);
  const supa = serviceClient();
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "invalid_auth" }, 401);
  const { data: appUser, error: appErr } = await supa
    .from("app_users").select("id").eq("id", userData.user.id).eq("active", true).maybeSingle();
  if (appErr || !appUser) return json({ error: "no_membership" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const question = String(body?.question || "").trim();
  if (!question) return json({ error: "question_required" }, 400);
  const schema = compactSchema(body?.schema);
  if (!schema.length) return json({ error: "schema_required", detail: "No sheets with data were provided." }, 400);
  const conversation = Array.isArray(body?.conversation) ? body.conversation.slice(-6) : [];

  const userTurn =
    `Workbook schema (JSON):\n${JSON.stringify(schema)}\n\n` +
    `Question: ${question}\n\n` +
    `Answer by calling render_plan with the widgets that best visualize this, using exact sheet and column names above.`;

  try {
    const reply = await callClaude([...conversation, { role: "user", content: userTurn }], apiKey);
    const toolUse = (reply.content || []).find((b: any) => b.type === "tool_use" && b.name === "render_plan");
    if (!toolUse) {
      const fallback = (reply.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return json({
        ok: true,
        plan: { headline: "Answer", answer: fallback || "I couldn't build a view for that.", widgets: [], followups: [] },
        meta: { question, generated_at: new Date().toISOString(), model: DEFAULT_MODEL },
      });
    }
    const plan = toolUse.input || {};
    return json({
      ok: true,
      plan: {
        headline: String(plan.headline || "AI answer"),
        answer: String(plan.answer || ""),
        widgets: Array.isArray(plan.widgets) ? plan.widgets : [],
        followups: Array.isArray(plan.followups) ? plan.followups.slice(0, 4) : [],
      },
      meta: { question, generated_at: new Date().toISOString(), model: DEFAULT_MODEL },
    });
  } catch (e) {
    return json({ error: "agent_failed", detail: String((e as any)?.message || e) }, 500);
  }
});
