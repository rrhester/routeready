// repair-quote-extract · shop estimate/invoice → DRAFT repair quote
//
// document-classify's sibling (same auth, retry, and forced-tool-use
// pattern) for the Repair Center: reads a repair_case_attachments file
// (PDF or photo — shop uploads, inbound email attachments, dashboard
// uploads), TRANSCRIBES it with Claude, and hands the payload to the
// SQL write-back (repair_quote_extract_save, migration 0490), which
// coerces every field fail-closed and creates a DRAFT quote a human
// must review before it counts.
//
// Money rules (non-negotiable):
//   · The model transcribes amounts exactly as printed — integer cents
//     — and is explicitly told NEVER to compute totals itself.
//   · The database recomputes totals from line items
//     (private.repair_quote_recompute); a document whose printed total
//     disagrees with its own line items gets totals_mismatch = true —
//     flagged, never corrected. Same invariant as shop-typed quotes.
//   · Extraction only creates/replaces UNREVIEWED drafts; a quote a
//     human has accepted is never touched by re-extraction.
//
// Input: POST { attachment_id, force? }
// Auth:  service-role bearer (inbound-email pipeline) or user JWT
//        (dashboard "Extract" button; RLS-checked via a user client).
// Env:   ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL override).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
// Sonnet, not Haiku: this is a money document — transcription accuracy
// beats per-call cost here. (The volume is a handful per case, not a
// classification firehose.)
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const PROMPT_VERSION = 1;
const MAX_BYTES_INLINE = 28 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
]);

const SYSTEM_PROMPT = [
  "You transcribe vehicle repair shop documents (estimates, quotes, invoices) for a delivery fleet operator.",
  "You are a TRANSCRIBER, not a calculator: copy amounts exactly as printed on the document, converted to integer cents (e.g. $239.20 → 23920).",
  "NEVER add amounts together, never infer a total that is not printed, never guess an unreadable number — use null instead.",
  "Every line item on the document becomes one line_items entry. Categorize conservatively; when unsure use 'misc'.",
  "shop_reported_total_cents is the document's own printed grand total (null if none is printed).",
  "Call submit_estimate exactly once with your transcription.",
].join(" ");

const EXTRACT_TOOL = {
  name: "submit_estimate",
  description: "Submit the transcription of a repair shop document.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["document_kind", "confidence", "summary", "line_items"],
    properties: {
      document_kind: {
        type: "string",
        enum: ["estimate", "invoice", "other"],
        description: "estimate/quote = proposed work; invoice = billed work; other = not a money document",
      },
      confidence: { type: "number", description: "0..1 — how confident you are in the transcription overall" },
      summary: { type: "string", description: "One sentence: what the document is and what work it covers" },
      quote_number: { type: ["string", "null"] },
      shop_work_order_number: { type: ["string", "null"] },
      shop_name: { type: ["string", "null"], description: "Shop name as printed" },
      shop_reported_total_cents: { type: ["integer", "null"], description: "The document's printed grand total, in cents. Null if not printed." },
      earliest_appointment_at: { type: ["string", "null"], description: "ISO 8601 if printed" },
      estimated_completion_at: { type: ["string", "null"], description: "ISO 8601 if printed" },
      expires_at: { type: ["string", "null"], description: "Estimate expiry, ISO 8601 if printed" },
      warranty_summary: { type: ["string", "null"] },
      parts_availability: { type: ["string", "null"] },
      notes: { type: ["string", "null"], description: "Exclusions, disclaimers, or handwritten notes worth keeping" },
      contact_name: { type: ["string", "null"] },
      contact_phone: { type: ["string", "null"] },
      service_advisor: { type: ["string", "null"] },
      line_items: {
        type: "array",
        maxItems: 60,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description"],
          properties: {
            description: { type: "string" },
            category: {
              type: ["string", "null"],
              enum: ["diagnostic", "labor", "part_oem", "part_aftermarket", "part_used",
                     "part_reman", "sublet", "towing", "supplies", "environmental",
                     "tax", "discount", "misc", null],
            },
            part_number: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unit_price_cents: { type: ["integer", "null"] },
            parts_total_cents: { type: ["integer", "null"] },
            labor_hours: { type: ["number", "null"] },
            labor_rate_cents: { type: ["integer", "null"] },
            labor_total_cents: { type: ["integer", "null"] },
            line_total_cents: { type: ["integer", "null"], description: "This line's printed total, in cents — as printed, never computed" },
          },
        },
      },
    },
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  // Same defensive key-prefix strip as document-classify.
  const rawKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
  const skIdx = rawKey.indexOf("sk-ant-");
  const apiKey = skIdx > 0 ? rawKey.slice(skIdx) : rawKey;
  if (!apiKey) return jsonResponse({ error: "anthropic_key_missing" }, { status: 500, headers: CORS });

  let body: { attachment_id?: string } = {};
  try { body = await req.json(); } catch { return badRequest("invalid_json"); }
  const attachmentId = (body.attachment_id || "").trim();
  if (!attachmentId) return badRequest("attachment_id_required");

  // Auth · service-role bearer (inbound pipeline) or user JWT
  // (dashboard button) RLS-checked against repair_case_attachments.
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
      .from("repair_case_attachments")
      .select("id")
      .eq("id", attachmentId)
      .maybeSingle();
    if (vErr || !visible) {
      return jsonResponse({ error: "forbidden" }, { status: 403, headers: CORS });
    }
  }

  const supa = serviceClient();
  const { data: att, error: loadErr } = await supa
    .from("repair_case_attachments")
    .select("id, dsp_id, repair_case_id, storage_bucket, storage_path, file_name, mime_type, byte_size")
    .eq("id", attachmentId)
    .maybeSingle();
  if (loadErr || !att) {
    return jsonResponse({ error: "attachment_not_found" }, { status: 404, headers: CORS });
  }

  const saveError = async (msg: string) => {
    await supa.rpc("repair_quote_extract_save", {
      p_attachment_id: attachmentId,
      p_payload: null,
      p_model: DEFAULT_MODEL,
      p_prompt_version: PROMPT_VERSION,
      p_error: msg.slice(0, 500),
    });
  };

  const mt = (att.mime_type || "").toLowerCase();
  const isPdf = mt === "application/pdf";
  const isImage = IMAGE_TYPES.has(mt);
  if (!isPdf && !isImage) {
    await saveError(`unsupported_mime_${mt || "unknown"}`);
    return jsonResponse({ ok: false, error: "unsupported_mime", mime: mt }, { headers: CORS });
  }
  const size = Number(att.byte_size || 0);
  if (size > MAX_BYTES_INLINE) {
    await saveError(`file_too_large_${size}`);
    return jsonResponse({ ok: false, error: "file_too_large", bytes: size }, { headers: CORS });
  }

  const { data: blob, error: dlErr } = await supa.storage
    .from(att.storage_bucket || "repair-attachments")
    .download(att.storage_path);
  if (dlErr || !blob) {
    await saveError(`download_failed_${dlErr?.message || "unknown"}`);
    return jsonResponse({ ok: false, error: "download_failed" }, { headers: CORS });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES_INLINE) {
    await saveError(bytes.length === 0 ? "empty_file" : `file_too_large_${bytes.length}`);
    return jsonResponse({ ok: false, error: "bad_file" }, { headers: CORS });
  }
  const b64 = bytesToBase64(bytes);

  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image",    source: { type: "base64", media_type: mt,                 data: b64 } };
  const userText = `Transcribe this repair shop document. ` +
    `Filename: ${att.file_name || "(unknown)"}. MIME: ${mt}. ` +
    `Remember: transcribe amounts exactly as printed (integer cents), never compute. ` +
    `Call submit_estimate.`;

  let payload: Record<string, unknown> | null = null;
  let modelUsed = DEFAULT_MODEL;
  let lastError: string | null = null;
  const requestBody = JSON.stringify({
    model: DEFAULT_MODEL,
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "submit_estimate" },
    messages: [{ role: "user", content: [fileBlock, { type: "text", text: userText }] }],
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
        lastError = `anthropic_${resp.status}_${txt.replace(/\s+/g, " ").slice(0, 200)}`;
        console.error(`repair-quote-extract non-2xx attempt ${attempt + 1}:`, resp.status, txt.slice(0, 400));
        const retriable = resp.status >= 500 || resp.status === 429 || resp.status === 529;
        if (retriable && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        break;
      }
      const data = await resp.json() as {
        model?: string;
        content: Array<{ type: string; name?: string; input?: unknown }>;
      };
      modelUsed = data.model || DEFAULT_MODEL;
      const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === "submit_estimate");
      if (block && typeof block.input === "object" && block.input) {
        payload = block.input as Record<string, unknown>;
        lastError = null;
      } else {
        lastError = "no_tool_use_block";
      }
      break;
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`repair-quote-extract exception attempt ${attempt + 1}:`, e);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      break;
    }
  }

  if (!payload) {
    await saveError(lastError || "no_payload");
    return jsonResponse({ ok: false, error: "extraction_unavailable", detail: lastError }, { headers: CORS });
  }

  // All coercion / money guards / draft-vs-reviewed rules live in SQL.
  const { data: saved, error: saveErr } = await supa.rpc("repair_quote_extract_save", {
    p_attachment_id: attachmentId,
    p_payload: payload,
    p_model: modelUsed,
    p_prompt_version: PROMPT_VERSION,
    p_error: null,
  });
  if (saveErr) {
    console.error("repair-quote-extract save failed:", saveErr.message);
    return jsonResponse({ ok: false, error: "save_failed" }, { status: 500, headers: CORS });
  }
  return jsonResponse({ ok: true, ...saved }, { headers: CORS });
});
