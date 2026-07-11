// dvic-ai-review · RouteReady DVIC photo-damage detector.
//
// POST { inspection_id: uuid }
//
// Fetches the named inspection plus the most-recent prior inspection
// for the same vehicle, mints signed URLs for up to 6 photos on each
// side from the driver-documents bucket, and sends them to Anthropic's
// Claude Sonnet vision model.  The model must return a structured
// JSON verdict via tool use: status / confidence / summary / findings.
// The verdict is then persisted via public.vehicle_dvic_ai_save.
//
// Auth: this endpoint is ONLY ever invoked server-to-server via pg_net —
// by the AFTER INSERT trigger on vehicle_inspections and by the dashboard's
// "Run AI scan" button, which routes through the vehicle_dvic_request_ai RPC
// → private.dvic_request_ai_review → pg_net. Both present the service-role
// key as a bearer (migration 0242). We require that key (requireServiceKey)
// so an anonymous or cross-tenant caller can't POST a guessed inspection_id
// to burn RouteReady's Anthropic key or overwrite another DSP's inspection
// verdict. Deployed with --no-verify-jwt (the sb_secret_… key is not a JWT
// and would 401 at the gateway); the bearer check happens in-function.
//
// Env (Supabase secrets):
//   ANTHROPIC_API_KEY   sk-ant-…                         (required)
//   ANTHROPIC_MODEL     defaults to claude-sonnet-4-6    (optional)
//   SUPABASE_URL        auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  auto-injected
//   FUNCTION_INTERNAL_TOKEN    optional override if the trigger's
//                              app.service_role_key GUC drifts from the
//                              auto-injected key (see _shared/supabase.ts)
import { serviceClient, jsonResponse, badRequest, requireServiceKey } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const BUCKET = "driver-documents";
const MAX_PHOTOS_PER_SIDE = 6;
const SIGNED_URL_TTL = 60 * 30; // 30 minutes — Claude only needs them once.

type Inspection = {
  id: string;
  vehicle_id: string;
  dsp_id: string;
  inspected_at: string;
  inspector_name: string | null;
  kind: string | null;
  result: string | null;
  notes: string | null;
  photos: unknown;
};

type Finding = {
  area: string;
  description: string;
  severity?: "minor" | "moderate" | "severe";
  confidence?: number;        // 0..100
  photo_index?: number;       // index into current photos
};

type Verdict = {
  status: "clean" | "flagged";
  confidence: number;         // 0..100
  summary: string;
  findings: Finding[];
};

const SYSTEM_PROMPT = [
  "You are RouteReady's DVIC photo reviewer. You receive a set of",
  "BEFORE photos (the prior daily vehicle inspection) and a set of",
  "AFTER photos (today's inspection) for the same Amazon DSP cargo",
  "van. Your job is to compare them and decide whether the AFTER",
  "photos show NEW damage that was not present in the BEFORE photos.",
  "",
  "Decision rules:",
  "• Only flag damage that is plausibly NEW (i.e. visible in AFTER",
  "  but not in BEFORE). Lighting, weather, dirt, water beads, or",
  "  cosmetic shadow differences are NOT damage.",
  "• Pre-existing damage that appears in both sets is NOT a finding.",
  "• If no BEFORE photos were provided, only flag obvious damage in",
  "  AFTER (e.g. dents, scrapes, broken lights, missing trim, body",
  "  panel separation).",
  "• Be conservative. Prefer status=clean when uncertain.",
  "",
  "You MUST respond by calling the record_verdict tool exactly once.",
  "Never produce a final assistant message without calling the tool.",
].join(" ");

const VERDICT_TOOL = {
  name: "record_verdict",
  description: "Record the final DVIC damage-review verdict. Call this exactly once after analyzing the photos.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["clean", "flagged"],
        description: "'flagged' if you believe NEW damage is visible in AFTER, otherwise 'clean'.",
      },
      confidence: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Overall confidence in the verdict (0-100). For flagged: confidence damage is real.",
      },
      summary: {
        type: "string",
        description: "One-sentence summary of the verdict. If flagged, what kind of damage and where.",
      },
      findings: {
        type: "array",
        description: "Specific findings. Empty array when status='clean'.",
        items: {
          type: "object",
          properties: {
            area: { type: "string", description: "Body area, e.g. 'rear bumper', 'driver door', 'roof'." },
            description: { type: "string", description: "Short description of what is visible." },
            severity: { type: "string", enum: ["minor", "moderate", "severe"] },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            photo_index: { type: "integer", minimum: 0, description: "Index in the AFTER photo set." },
          },
          required: ["area", "description"],
        },
      },
    },
    required: ["status", "confidence", "summary", "findings"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  // Server-to-server only: reject anything without the service-role bearer.
  const authFail = requireServiceKey(req);
  if (authFail) return authFail;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "anthropic_key_missing" }, 500);

  let body: { inspection_id?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid_json");
  }
  const inspectionId = (body.inspection_id || "").trim();
  if (!inspectionId) return badRequest("inspection_id_required");

  const supa = serviceClient();

  // Load the current inspection (also gives us dsp_id + vehicle_id).
  const { data: cur, error: curErr } = await supa
    .from("vehicle_inspections")
    .select("id, vehicle_id, dsp_id, inspected_at, inspector_name, kind, result, notes, photos")
    .eq("id", inspectionId)
    .maybeSingle();
  if (curErr || !cur) return json({ error: "inspection_not_found" }, 404);

  const curPhotos = normalizePhotos(cur.photos).slice(0, MAX_PHOTOS_PER_SIDE);
  if (curPhotos.length === 0) {
    // Nothing to review — mark skipped and return.
    await persist(supa, inspectionId, {
      status: "clean",
      confidence: 0,
      summary: "No photos available for review.",
      findings: [],
    }, DEFAULT_MODEL, null, /* skipped */ true);
    return json({ ok: true, status: "skipped", reason: "no_photos" });
  }

  // Load the most recent prior inspection with photos for the same vehicle.
  const { data: priorRows } = await supa
    .from("vehicle_inspections")
    .select("id, inspected_at, photos")
    .eq("vehicle_id", cur.vehicle_id)
    .eq("dsp_id", cur.dsp_id)
    .lt("inspected_at", cur.inspected_at)
    .order("inspected_at", { ascending: false })
    .limit(8);
  let prior: { id: string; photos: string[] } | null = null;
  for (const row of priorRows ?? []) {
    const p = normalizePhotos((row as { photos: unknown }).photos);
    if (p.length > 0) {
      prior = { id: (row as { id: string }).id, photos: p.slice(0, MAX_PHOTOS_PER_SIDE) };
      break;
    }
  }

  const curUrls  = await signMany(supa, curPhotos);
  const priorUrls = prior ? await signMany(supa, prior.photos) : [];

  // Build the Claude message.  Vision content blocks live in user.content.
  const content: unknown[] = [];
  if (priorUrls.length > 0) {
    content.push({ type: "text", text: `BEFORE photos (${priorUrls.length} image${priorUrls.length === 1 ? "" : "s"} · prior inspection on ${prior?.id ? "" : ""}):` });
    for (let i = 0; i < priorUrls.length; i++) {
      content.push({ type: "image", source: { type: "url", url: priorUrls[i] } });
    }
  } else {
    content.push({ type: "text", text: "BEFORE photos: none on file. Compare against your general knowledge of an undamaged Amazon DSP cargo van." });
  }
  content.push({ type: "text", text: `\nAFTER photos (${curUrls.length} image${curUrls.length === 1 ? "" : "s"} · inspection ${cur.id}):` });
  for (let i = 0; i < curUrls.length; i++) {
    content.push({ type: "text", text: `Photo index ${i}:` });
    content.push({ type: "image", source: { type: "url", url: curUrls[i] } });
  }
  content.push({ type: "text", text: "\nReview these photos and call record_verdict with your decision." });

  // Call Anthropic with tool_choice = record_verdict to force the
  // structured output path.
  let verdict: Verdict | null = null;
  let modelUsed = DEFAULT_MODEL;
  let lastError: string | null = null;
  try {
    const resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: "record_verdict" },
        messages: [{ role: "user", content }],
      }),
    });
    if (!resp.ok) {
      lastError = `anthropic_${resp.status}`;
      const txt = await resp.text();
      console.error("anthropic non-2xx:", resp.status, txt.slice(0, 500));
    } else {
      const data = await resp.json() as { model?: string; content: Array<{ type: string; name?: string; input?: unknown }> };
      modelUsed = data.model || DEFAULT_MODEL;
      const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === "record_verdict");
      if (block && typeof block.input === "object" && block.input) {
        verdict = coerceVerdict(block.input);
      }
    }
  } catch (e) {
    lastError = (e as Error).message;
    console.error("anthropic error:", e);
  }

  if (!verdict) {
    await persistError(supa, inspectionId, lastError || "no_verdict", modelUsed);
    return json({ ok: false, error: "verdict_unavailable", detail: lastError });
  }

  await persist(supa, inspectionId, verdict, modelUsed, prior?.id ?? null, false);
  return json({ ok: true, status: verdict.status, confidence: verdict.confidence });
});

function normalizePhotos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (typeof p === "string" ? p : (p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string") ? (p as { path: string }).path : ""))
    .filter((p) => p.length > 0);
}

async function signMany(supa: ReturnType<typeof serviceClient>, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { data, error } = await supa.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
  if (error) {
    console.error("signMany error:", error);
    return [];
  }
  return (data ?? []).map((d) => d.signedUrl).filter(Boolean);
}

function coerceVerdict(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = r.status === "flagged" ? "flagged" : r.status === "clean" ? "clean" : null;
  if (!status) return null;
  const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(100, Math.round(r.confidence))) : 0;
  const summary = typeof r.summary === "string" ? r.summary.slice(0, 1000) : "";
  const findingsRaw = Array.isArray(r.findings) ? r.findings : [];
  const findings: Finding[] = findingsRaw
    .filter((f): f is Record<string, unknown> => f != null && typeof f === "object")
    .slice(0, 12)
    .map((f) => ({
      area: typeof f.area === "string" ? f.area.slice(0, 80) : "unspecified",
      description: typeof f.description === "string" ? f.description.slice(0, 500) : "",
      severity: f.severity === "severe" || f.severity === "moderate" || f.severity === "minor" ? f.severity : undefined,
      confidence: typeof f.confidence === "number" ? Math.max(0, Math.min(100, Math.round(f.confidence))) : undefined,
      photo_index: typeof f.photo_index === "number" ? f.photo_index : undefined,
    }));
  return { status, confidence, summary, findings };
}

async function persist(
  supa: ReturnType<typeof serviceClient>,
  inspectionId: string,
  verdict: Verdict,
  model: string,
  comparedToId: string | null,
  skipped: boolean,
) {
  const status = skipped ? "skipped" : verdict.status;
  const { error } = await supa.rpc("vehicle_dvic_ai_save", {
    p_inspection_id:  inspectionId,
    p_status:         status,
    p_summary:        verdict.summary,
    p_findings:       verdict.findings,
    p_model:          model,
    p_confidence:     verdict.confidence,
    p_compared_to_id: comparedToId,
  });
  if (error) {
    console.error("vehicle_dvic_ai_save error:", error);
  }
}

async function persistError(
  supa: ReturnType<typeof serviceClient>,
  inspectionId: string,
  detail: string,
  model: string,
) {
  const { error } = await supa.rpc("vehicle_dvic_ai_save", {
    p_inspection_id:  inspectionId,
    p_status:         "error",
    p_summary:        `AI review unavailable: ${detail}`,
    p_findings:       [],
    p_model:          model,
    p_confidence:     0,
    p_compared_to_id: null,
  });
  if (error) {
    console.error("vehicle_dvic_ai_save error path failed:", error);
  }
}
