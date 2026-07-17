// document-classify · Phase 2 of the document scanner.
//
// POST { id: uuid, force?: bool }
//
// Pulls a single document_intake row by id, downloads the file from
// the document-intake storage bucket, ships it to Claude with a
// general-purpose classification prompt, and writes the verdict back
// through private.document_intake_save_classification (or the _error
// variant). Inline base64 cap is 32 MB — anything larger gets marked
// error/unsupported.
//
// Auth: this endpoint accepts either the service-role key (used
// server-to-server by webhook-email-inbound after a fresh attachment
// lands) OR a regular Supabase JWT (the dashboard's "Re-classify"
// click). For the JWT path we additionally RLS-check the doc by
// querying with a user-scoped client — if the user can SELECT it,
// they're allowed to (re-)classify it.
//
// Env:
//   ANTHROPIC_API_KEY   sk-ant-…                          (required)
//   ANTHROPIC_MODEL     defaults to claude-haiku-4-5      (optional)
//   SUPABASE_URL                                          auto-injected
//   SUPABASE_SERVICE_ROLE_KEY                             auto-injected
//   SUPABASE_ANON_KEY                                     auto-injected
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
const BUCKET = "document-intake";
const PROMPT_VERSION = 1;

// Anthropic inline base64 supports up to ~32MB request size. Leave
// headroom for the JSON envelope and prompt tokens.
const MAX_BYTES_INLINE = 28 * 1024 * 1024;

// Image mime types Claude vision accepts directly.
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);


const SYSTEM_PROMPT = `You are a document classifier for a US-based last-mile delivery service partner (DSP).
DSPs receive constant paperwork — vehicle inspections, driver licenses, DOT medical cards, IRP cab cards, insurance certificates, lease agreements, articles of organization, W-9 / I-9 / W-2, drug test results, motor vehicle reports (MVR), background checks, training certificates, invoices, receipts, payroll, and so on — and need to file each into the right record.

For every document you receive, identify what it is and extract every structured field that is clearly stated. Be precise: do NOT guess. Use null for fields that aren't clearly readable, and prefer fewer high-confidence fields over many shaky ones.

You MUST call the submit_classification tool exactly once. Never produce a final assistant message without calling the tool.`;

const CLASSIFY_TOOL = {
  name: "submit_classification",
  description: "Record the final document classification + extracted fields. Call exactly once after analyzing the document.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description:
          "Short snake_case identifier for the document type. Examples (use these when they apply, otherwise invent a sensible snake_case label): " +
          "vehicle_inspection_report, drivers_license, dot_medical_card, vehicle_registration, irp_cab_card, " +
          "certificate_of_insurance, lease_agreement, w9, w2, i9, drug_test_result, mvr, background_check, " +
          "training_certificate, articles_of_organization, business_license, ein_letter, invoice, receipt, " +
          "bill_of_lading, payroll_report, bank_statement, contract, other.",
      },
      type_label: {
        type: "string",
        description: "Human-readable label, e.g. 'Vehicle Inspection Report' or 'Driver's License'.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How confident you are in the type classification (0.0 - 1.0). Use <0.5 if you genuinely can't tell.",
      },
      summary: {
        type: "string",
        description: "1-2 sentence plain-English summary: what is it and what's the most important info.",
      },
      fields: {
        type: "object",
        description:
          "Structured fields extracted from the document. Keys MUST be snake_case. Common keys when applicable: " +
          "vin, license_plate, vehicle_make, vehicle_model, vehicle_year, mileage, " +
          "driver_name, employee_name, date_of_birth, license_number, license_state, license_class, license_expiration, " +
          "medical_examiner, medical_expiration, dot_number, mc_number, " +
          "policy_number, policy_carrier, policy_effective, policy_expiration, " +
          "ein, ssn_last_four, business_name, business_address, " +
          "issue_date, expiration_date, document_number, total_amount, currency. " +
          "Include any other clearly-stated fields you find. Use ISO 8601 (YYYY-MM-DD) for dates.",
        additionalProperties: true,
      },
      parties: {
        type: "array",
        description: "People or organizations named in the doc, each with a role if clear (e.g. 'issuer', 'subject', 'inspector', 'insured', 'lessor', 'lessee', 'employer', 'employee').",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
          },
          required: ["name"],
        },
      },
    },
    required: ["type", "type_label", "confidence", "summary", "fields"],
  },
};


type ClassifierVerdict = {
  type: string;
  type_label: string;
  confidence: number;
  summary: string;
  fields: Record<string, unknown>;
  parties?: Array<{ name: string; role?: string }>;
};


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  // Some operators paste the key with its dashboard label prefix
  // (e.g. "rrai2 sk-ant-api03-…"). The whitespace makes Headers
  // reject the value with "Invalid header value", so strip anything
  // before the sk-ant- prefix defensively.
  const rawKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
  const skIdx = rawKey.indexOf("sk-ant-");
  const apiKey = skIdx > 0 ? rawKey.slice(skIdx) : rawKey;
  if (!apiKey) return jsonResponse({ error: "anthropic_key_missing" }, { status: 500, headers: CORS });

  let body: { id?: string; force?: boolean } = {};
  try { body = await req.json(); } catch { return badRequest("invalid_json"); }
  const id = (body.id || "").trim();
  if (!id) return badRequest("id_required");

  // Auth · service-role bearer (server-to-server) or user JWT (dashboard).
  // For user JWTs we RLS-check by selecting the doc with a user-scoped
  // client first; if RLS lets them read it, they can classify it.
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const fit = Deno.env.get("FUNCTION_INTERNAL_TOKEN") || "";
  const isServiceCaller = token.length > 0 && (token === srk || (fit !== "" && token === fit));
  if (!isServiceCaller) {
    if (!token) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });
    const supaUrl = Deno.env.get("SUPABASE_URL") || "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!supaUrl || !anon) return jsonResponse({ error: "auth_misconfigured" }, { status: 500, headers: CORS });
    const userClient = createClient(supaUrl, anon, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: visible, error: vErr } = await userClient
      .from("document_intake")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (vErr || !visible) {
      return jsonResponse({ error: "forbidden" }, { status: 403, headers: CORS });
    }
  }

  const supa = serviceClient();

  // Load the intake row.
  const { data: doc, error: loadErr } = await supa
    .from("document_intake")
    .select("id, dsp_id, storage_path, file_name, file_size_bytes, mime_type, status, classification_prompt_version")
    .eq("id", id)
    .maybeSingle();
  if (loadErr || !doc) {
    return jsonResponse({ error: "document_not_found" }, { status: 404, headers: CORS });
  }

  // Skip if already classified at the current prompt version and not forced.
  if (!body.force && doc.status === "classified" && doc.classification_prompt_version === PROMPT_VERSION) {
    return jsonResponse({ ok: true, skipped: "already_classified" }, { headers: CORS });
  }

  // Mark in-flight so the UI can show a spinner and dedupe parallel calls.
  await supa.from("document_intake")
    .update({ status: "classifying", classification_error: null })
    .eq("id", id);

  const mt = (doc.mime_type || "").toLowerCase();
  const isPdf = mt === "application/pdf";
  const isImage = IMAGE_TYPES.has(mt);
  if (!isPdf && !isImage) {
    await saveError(supa, id, `unsupported_mime_${mt || "unknown"}`, DEFAULT_MODEL);
    return jsonResponse({ ok: false, error: "unsupported_mime", mime: mt }, { headers: CORS });
  }

  // Hard size cap — anything larger blows past the Anthropic inline limit.
  const size = Number(doc.file_size_bytes || 0);
  if (size > MAX_BYTES_INLINE) {
    await saveError(supa, id, `file_too_large_${size}`, DEFAULT_MODEL);
    return jsonResponse({ ok: false, error: "file_too_large", bytes: size }, { headers: CORS });
  }

  // Download the file from storage as bytes, then base64 encode.
  const { data: blob, error: dlErr } = await supa.storage.from(BUCKET).download(doc.storage_path);
  if (dlErr || !blob) {
    await saveError(supa, id, `download_failed_${dlErr?.message || "unknown"}`, DEFAULT_MODEL);
    return jsonResponse({ ok: false, error: "download_failed" }, { headers: CORS });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0) {
    await saveError(supa, id, "empty_file", DEFAULT_MODEL);
    return jsonResponse({ ok: false, error: "empty_file" }, { headers: CORS });
  }
  const b64 = bytesToBase64(bytes);

  // Build the Anthropic content block. PDF goes in via the document
  // content type; images via the image content type. Both accept inline
  // base64 with a media_type.
  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image",    source: { type: "base64", media_type: mt,                 data: b64 } };

  const userText = `Classify this document and extract its structured fields. ` +
    `Filename: ${doc.file_name || "(unknown)"}. ` +
    `MIME: ${mt}. ` +
    `Call submit_classification with your verdict.`;

  // Call Anthropic with tool_choice forcing the structured output path.
  // 5xx responses (502/503/504/520 from Cloudflare in front of the
  // Anthropic gateway, or 529 'overloaded') get retried with
  // exponential backoff — these are usually transient blips.
  let verdict: ClassifierVerdict | null = null;
  let modelUsed = DEFAULT_MODEL;
  let lastError: string | null = null;
  const requestBody = JSON.stringify({
    model: DEFAULT_MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "submit_classification" },
    messages: [{
      role: "user",
      content: [fileBlock, { type: "text", text: userText }],
    }],
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        body: requestBody,
      });
      if (!resp.ok) {
        const txt = await resp.text();
        const detail = txt.replace(/\s+/g, " ").slice(0, 200);
        lastError = `anthropic_${resp.status}_${detail}`;
        console.error(`anthropic non-2xx attempt ${attempt + 1}:`, resp.status, txt.slice(0, 500));
        const retriable = resp.status >= 500 || resp.status === 429 || resp.status === 529;
        if (retriable && attempt < 3) {
          // 1s, 2s, 4s — keeps the whole retry envelope under the
          // dashboard's "is it working?" attention span.
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        break;
      }
      const data = await resp.json() as {
        model?: string;
        content: Array<{ type: string; name?: string; input?: unknown }>;
      };
      modelUsed = data.model || DEFAULT_MODEL;
      const block = (data.content || []).find(b => b.type === "tool_use" && b.name === "submit_classification");
      if (block && typeof block.input === "object" && block.input) {
        verdict = coerceVerdict(block.input);
        lastError = null;
      } else {
        lastError = "no_tool_use_block";
      }
      break;
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`anthropic exception attempt ${attempt + 1}:`, e);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      break;
    }
  }

  if (!verdict) {
    await saveError(supa, id, lastError || "no_verdict", modelUsed);
    return jsonResponse({ ok: false, error: "verdict_unavailable", detail: lastError }, { headers: CORS });
  }

  const extracted = {
    fields: verdict.fields || {},
    parties: verdict.parties || [],
  };
  const { error: saveErr } = await supa.rpc("document_intake_save_classification", {
    p_id:             id,
    p_type:           verdict.type,
    p_type_label:     verdict.type_label,
    p_confidence:     clamp01(verdict.confidence),
    p_extracted_data: extracted,
    p_summary:        verdict.summary,
    p_model:          modelUsed,
    p_prompt_version: PROMPT_VERSION,
  });
  if (saveErr) {
    // The RPC lives in `private` schema — fall back to a direct
    // service-role UPDATE if PostgREST doesn't expose it.
    const { error: directErr } = await supa.from("document_intake").update({
      status:                        "classified",
      classified_type:               verdict.type,
      classified_type_label:         verdict.type_label,
      classification_score:          clamp01(verdict.confidence),
      extracted_data:                extracted,
      classification_summary:        verdict.summary,
      classification_model:          modelUsed,
      classification_prompt_version: PROMPT_VERSION,
      classification_error:          null,
      classified_at:                 new Date().toISOString(),
    }).eq("id", id);
    if (directErr) {
      console.error("classification save failed:", saveErr.message, directErr.message);
      return jsonResponse({ ok: false, error: "save_failed" }, { headers: CORS });
    }
  }

  return jsonResponse({
    ok: true,
    id,
    type: verdict.type,
    type_label: verdict.type_label,
    confidence: clamp01(verdict.confidence),
    model: modelUsed,
  }, { headers: CORS });
});


// ── Helpers ───────────────────────────────────────────────────────

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function coerceVerdict(input: unknown): ClassifierVerdict | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (!type) return null;
  const type_label = typeof o.type_label === "string" ? o.type_label : type.replace(/_/g, " ");
  const confidence = clamp01(o.confidence);
  const summary = typeof o.summary === "string" ? o.summary : "";
  const fields = (o.fields && typeof o.fields === "object" && !Array.isArray(o.fields))
    ? o.fields as Record<string, unknown>
    : {};
  const parties = Array.isArray(o.parties)
    ? (o.parties as unknown[])
        .filter(p => p && typeof p === "object" && typeof (p as Record<string, unknown>).name === "string")
        .map(p => {
          const r = p as Record<string, unknown>;
          return { name: String(r.name), role: typeof r.role === "string" ? r.role : undefined };
        })
    : [];
  return { type, type_label, confidence, summary, fields, parties };
}

async function saveError(supa: ReturnType<typeof serviceClient>, id: string, err: string, model: string) {
  // Try the private RPC first, then a direct UPDATE.
  const { error } = await supa.rpc("document_intake_save_classification_error", {
    p_id: id, p_error: err, p_model: model,
  });
  if (error) {
    await supa.from("document_intake").update({
      status:               "error",
      classification_error: err,
      classification_model: model,
    }).eq("id", id);
  }
}

// Browser-style base64 of a Uint8Array — done in chunks so we don't
// blow the stack on multi-MB files.
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
