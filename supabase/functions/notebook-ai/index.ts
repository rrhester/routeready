// notebook-ai · RouteReady's in-notebook writing assistant.
//
// POST { action: string, text: string, title?: string }
//
// The notebook editor sends the current selection (or whole page) plus an
// action verb; Claude returns a transformed version of the text as Markdown.
// One Claude round-trip, no tools — the client renders the Markdown into the
// page. We never read DSP data here (only the text the client sends), but the
// call burns our API key, so it's gated to a signed-in, active DSP member —
// exactly like workbook-ai.
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
const MAX_INPUT = 12000;

const SYSTEM_BASE =
  "You are RouteReady's in-notebook writing assistant for a Delivery Service Partner (DSP) operations team " +
  "(drivers, vans, routes, stations, schedules, incidents, coaching). You transform the note text the user " +
  "gives you. Respond with ONLY the transformed content as clean GitHub-flavored Markdown — no preamble, no " +
  "explanation, no code fences around the whole answer. Use '- [ ] ' for open tasks and '- [x] ' for done tasks. " +
  "Keep the operator's facts, names, van numbers and route numbers exactly as written. Be concise and practical.";

// Per-action instruction appended to the system prompt.
const ACTIONS: Record<string, string> = {
  summarize: "Summarize the note into a tight set of bullet points capturing the key facts, decisions and any numbers.",
  action_items: "Extract every action item as a Markdown checklist ('- [ ] task'). Include an owner and due date in the line when the text implies one. If there are none, reply with a single line: 'No action items found.'",
  rewrite: "Rewrite the note so it's clear and well-organized. Keep the same meaning and all facts; fix run-ons; use short paragraphs, headings and bullets where they help.",
  professional: "Rewrite the note in a professional, neutral operations tone suitable for a manager or DSP owner to read. Keep all facts.",
  grammar: "Correct spelling, grammar and punctuation only. Preserve wording, structure, line breaks and formatting as much as possible.",
  expand: "Expand the note into a fuller, well-structured write-up with headings and bullets, elaborating on the points already present. Do not invent specific numbers or names that aren't implied.",
  minutes: "Turn the note into clean meeting minutes: a short heading, an Attendees line if implied, Discussion bullets, a Decisions list, and an Action items checklist.",
  checklist: "Convert the note into a practical Markdown checklist ('- [ ] item'), one actionable item per line, grouped under short headings if there are natural sections.",
  tags: "Suggest 3 to 6 short, lowercase topical tags for this note (single or two words each). Reply with ONLY the tags, comma-separated, on one line. No other text.",
};

async function callClaude(system: string, userText: string, apiKey: string) {
  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`anthropic_${r.status}: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text);
  return (parsed.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  // Auth gate — signed-in, active DSP member (this burns our API key).
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
  const action = String(body?.action || "").trim();
  const instruction = ACTIONS[action];
  if (!instruction) return json({ error: "unknown_action", detail: `Unsupported action "${action}".` }, 400);
  const text = String(body?.text || "").trim().slice(0, MAX_INPUT);
  if (!text) return json({ error: "text_required" }, 400);
  const title = String(body?.title || "").trim().slice(0, 200);

  const system = SYSTEM_BASE + "\n\nTask: " + instruction;
  const userText = (title ? `Note title: ${title}\n\n` : "") + `Note content:\n${text}`;

  try {
    const out = await callClaude(system, userText, apiKey);
    if (action === "tags") {
      const tags = out
        .replace(/^[-*\s]+/gm, "")
        .split(/[,\n]/).map((t: string) => t.trim().toLowerCase().replace(/^#/, "").replace(/[.]+$/, ""))
        .filter((t: string) => t && t.length <= 24)
        .slice(0, 6);
      return json({ ok: true, tags, meta: { action, model: DEFAULT_MODEL, generated_at: new Date().toISOString() } });
    }
    return json({ ok: true, result: out || "", meta: { action, model: DEFAULT_MODEL, generated_at: new Date().toISOString() } });
  } catch (e) {
    return json({ error: "ai_failed", detail: String((e as Error).message || e).slice(0, 300) }, 502);
  }
});
