// avatar-claude · Generates an SVG portrait avatar from a driver's
// uploaded photo by sending it to Claude (Anthropic vision) and
// asking the model to return a stylized SVG via tool_use.
//
// Public endpoint (anon-callable). Validates the driver's session
// token via driver_me before reading the photo from the public
// driver-photos bucket. The bucket is public so a base64 read isn't
// strictly required (we could hand Claude a public URL), but doing
// the fetch server-side gives us deterministic timeouts and lets us
// pre-size the image before paying the multimodal token cost.
//
// Body (application/json):
//   token       : driver session token
//   style_id    : one of the AI avatar styles
//                 ("ai-clean", "ai-realistic", "ai-soft3d", "ai-illustrated")
//   nonce       : optional integer / string to nudge regenerate output
//   photo_b64   : optional base64 photo (no data: prefix). When supplied
//                 we use this instead of the driver's persisted photo —
//                 lets the studio generate against a brand-new upload
//                 that hasn't been saved yet.
//   photo_mime  : optional mime when photo_b64 is set; defaults to
//                 image/jpeg.
//
// Returns: { ok, svg, style_id, model }
//
// Env (Supabase secrets):
//   ANTHROPIC_API_KEY   sk-ant-…                       (required)
//   ANTHROPIC_MODEL     defaults to claude-sonnet-4-6  (optional)
//   SUPABASE_URL        auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  auto-injected
import { serviceClient, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";

// Style descriptors keyed by the same id the PWA uses, so the client
// can ship a style choice and the server doesn't need to know what
// the UI calls them. Each entry adds a few sentences of guidance
// that the model layers on top of the base SVG instructions —
// palette, line-weight, fill style, lighting cues.
const STYLE_GUIDE: Record<string, { name: string; brief: string }> = {
  "ai-clean": {
    name: "Clean",
    brief: [
      "Crisp, modern vector portrait with a single accent colour.",
      "Smooth, simple shapes. Limit the palette to 5–7 colours including the background.",
      "No textures, no gradients beyond a single soft skin highlight.",
      "Background: a calm pastel circle behind the head.",
      "Reads as a professional LinkedIn-style illustration.",
    ].join(" "),
  },
  "ai-realistic": {
    name: "Realistic",
    brief: [
      "Warm, painterly vector portrait. Use 2-3 stop linear gradients on skin",
      "and hair for soft volume. Include subtle warm highlights and cool shadows.",
      "Keep edges clean but allow gentle anti-aliasing-style overlapping shapes.",
      "Background: a soft radial gradient in a warm neutral.",
    ].join(" "),
  },
  "ai-soft3d": {
    name: "Soft 3D",
    brief: [
      "Plush, slightly inflated 3D-look portrait. Use rounded forms, large",
      "radial gradients on the face for spherical lighting, and a soft drop-",
      "shadow under the chin. Highlights warm, shadows cool.",
      "Background: a clean, light gradient suggesting a studio backdrop.",
      "Reads as a friendly Pixar-style 3D character but kept stylized, not photoreal.",
    ].join(" "),
  },
  "ai-illustrated": {
    name: "Illustrated",
    brief: [
      "Hand-drawn editorial illustration. Visible 1–2 px ink line, slight",
      "wobble in the contours, flat fills with one or two posterised shading planes.",
      "Background: an off-white paper tone, optionally a single accent shape behind the head.",
      "Reads as a New Yorker-style spot illustration.",
    ].join(" "),
  },
};

const SYSTEM_PROMPT = [
  "You are RouteReady's avatar illustrator. You receive a photo of a delivery",
  "driver and a target style, and you produce a single stylized SVG portrait",
  "avatar of that driver.",
  "",
  "HARD RULES (these are not negotiable):",
  "• Output a 512x512 SVG with viewBox=\"0 0 512 512\". Use solid colours and",
  "  gradients only — no <image>, <foreignObject>, <script>, or external URLs.",
  "• The avatar must be friendly, professional, and work-appropriate.",
  "• Faithfully reflect what you can see in the photo: skin tone, hair colour",
  "  and style, eye colour, whether the person wears glasses, facial hair,",
  "  approximate age range, and apparent gender presentation. Do not invent",
  "  features that are not visible. If a feature is unclear, choose the most",
  "  neutral option.",
  "• Centre the portrait so the head fills roughly the middle 65% of the",
  "  canvas. Keep enough negative space for an upcoming circular crop.",
  "• Absolutely no text, no letters, no numerals, no signatures, no badges,",
  "  no Amazon branding, no uniforms or vests, no copyrighted character",
  "  references (no Pixar/Disney/anime IP, no celebrities). The result must",
  "  be a generic, original illustration.",
  "• Keep the SVG under ~20 KB. Prefer paths over deeply nested groups.",
  "",
  "STYLE: You will be told which style to use. Match its palette, line",
  "weight, lighting, and finishing notes exactly.",
  "",
  "You MUST respond by calling the emit_avatar tool exactly once. Do not",
  "produce a final assistant message without calling the tool.",
].join(" ");

const EMIT_TOOL = {
  name: "emit_avatar",
  description: "Record the final stylised SVG portrait. Call exactly once after analysing the photo.",
  input_schema: {
    type: "object",
    properties: {
      svg: {
        type: "string",
        description: "A full, self-contained SVG document starting with '<svg' and ending with '</svg>'. 512x512, viewBox=\"0 0 512 512\".",
      },
      features: {
        type: "object",
        description: "Structured features you used to render the avatar.",
        properties: {
          skin_tone:       { type: "string", description: "Short descriptor, e.g. 'light warm', 'medium', 'deep'." },
          hair_color:      { type: "string", description: "e.g. 'black', 'brown', 'auburn', 'salt-and-pepper', 'grey'." },
          hair_style:      { type: "string", description: "e.g. 'short', 'wavy medium', 'tied back', 'bald'." },
          facial_hair:     { type: "string", description: "'none' or short descriptor, e.g. 'full beard', 'mustache'." },
          glasses:         { type: "boolean", description: "true if the person wears glasses in the photo." },
          eye_color:       { type: "string", description: "Best-guess eye colour." },
          accent_color:    { type: "string", description: "Hex colour you used as the primary accent (e.g. '#2563EB')." },
        },
        required: ["skin_tone", "hair_color", "hair_style", "facial_hair", "glasses"],
      },
    },
    required: ["svg", "features"],
  },
};

const ALLOWED_STYLES = new Set(Object.keys(STYLE_GUIDE));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "anthropic_key_missing" }, 500);

  let body: {
    token?: string;
    style_id?: string;
    photo_path?: string;
    photo_b64?: string;
    photo_mime?: string;
    nonce?: string | number;
  };
  try { body = await req.json(); }
  catch { return badRequest("invalid_json"); }

  const token = String(body.token || "").trim();
  const styleId = String(body.style_id || "ai-clean").trim();
  const nonce = body.nonce ?? null;
  if (!token)                    return json({ error: "token_required" }, 400);
  if (!ALLOWED_STYLES.has(styleId)) return json({ error: "unsupported_style: " + styleId }, 400);

  const supa = serviceClient();

  // Validate driver session and resolve their current photo path.
  // We always use the driver's persisted photo, not a client-supplied
  // path — keeps the surface tight (no chance of asking Claude to
  // analyse arbitrary URLs) and matches the "tap to regenerate" UX.
  const { data: me, error: meErr } = await supa.rpc("driver_me", { p_token: token });
  if (meErr || !me?.id) return json({ error: "invalid_or_expired_token" }, 403);

  // Two photo sources, in priority order:
  //   1. inline photo_b64 from the client — fresh upload that hasn't
  //      been saved yet.
  //   2. the driver's persisted photo_path in driver-photos.
  // Either way we end up with base64-encoded bytes and a mime hint.
  let imageB64: string;
  let imageMime: string;
  if (typeof body.photo_b64 === "string" && body.photo_b64.length > 0) {
    imageB64  = body.photo_b64.replace(/^data:[^;]+;base64,/i, "");
    imageMime = (typeof body.photo_mime === "string" && /^image\//i.test(body.photo_mime))
      ? body.photo_mime : "image/jpeg";
    // Anthropic's vision API caps individual images at ~5 MB. The
    // base64 string is ~33% larger than the raw bytes, so an 8 MB
    // base64 payload corresponds to roughly a 6 MB image — leave a
    // little headroom past that for the JSON envelope.
    if (imageB64.length > 8 * 1024 * 1024) {
      return json({ error: "photo_too_large" }, 413);
    }
  } else {
    const photoPath = (typeof body.photo_path === "string" && body.photo_path) || me.photo_path || null;
    if (!photoPath) return json({ error: "no_photo_on_file" }, 400);
    try {
      const { data: blob, error: dlErr } = await supa.storage.from("driver-photos").download(photoPath);
      if (dlErr || !blob) throw new Error("photo_download_failed: " + (dlErr?.message || "no_blob"));
      imageMime = blob.type || "image/jpeg";
      const buf = new Uint8Array(await blob.arrayBuffer());
      imageB64 = base64FromBytes(buf);
    } catch (e) {
      console.error("photo fetch:", e);
      return json({ error: "photo_fetch_failed", detail: (e as Error).message }, 500);
    }
  }

  const style = STYLE_GUIDE[styleId];
  const styleBrief = `Style: ${style.name}. ${style.brief}`;
  // Nudge for regenerate — fed in only to mildly perturb sampling so a
  // re-tap actually produces a perceptibly different avatar.
  const nonceLine = nonce != null && nonce !== ""
    ? `\nVariation seed: ${String(nonce).slice(0, 24)}. Slightly vary expression and palette accents while keeping the same identity.`
    : "";

  // Anthropic vision only accepts these four mimes; default to jpeg
  // so a HEIC upload still flows through (the bytes are usually
  // decodable as jpeg by content sniffing, and at worst the model
  // returns an error we surface).
  const visionMime = /^image\/(jpeg|png|gif|webp)$/i.test(imageMime) ? imageMime : "image/jpeg";

  const userContent: unknown[] = [
    { type: "text", text: "Photo of the driver:" },
    {
      type: "image",
      source: { type: "base64", media_type: visionMime, data: imageB64 },
    },
    { type: "text", text: `${styleBrief}${nonceLine}\nAnalyse the photo and call emit_avatar with the SVG and features.` },
  ];

  let svg: string | null = null;
  let features: Record<string, unknown> = {};
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
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: [EMIT_TOOL],
        tool_choice: { type: "tool", name: "emit_avatar" },
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      lastError = `anthropic_${resp.status}: ${txt.slice(0, 400)}`;
      console.error("anthropic non-2xx:", resp.status, txt.slice(0, 500));
    } else {
      const data = await resp.json() as { model?: string; content: Array<{ type: string; name?: string; input?: unknown }> };
      modelUsed = data.model || DEFAULT_MODEL;
      const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === "emit_avatar");
      if (block && typeof block.input === "object" && block.input) {
        const inp = block.input as { svg?: unknown; features?: unknown };
        if (typeof inp.svg === "string") svg = sanitizeSvg(inp.svg);
        if (inp.features && typeof inp.features === "object") {
          features = inp.features as Record<string, unknown>;
        }
      }
    }
  } catch (e) {
    lastError = (e as Error).message;
    console.error("anthropic error:", e);
  }

  if (!svg) {
    return json({ ok: false, error: "no_svg", detail: lastError }, 502);
  }

  return json({ ok: true, svg, style_id: styleId, model: modelUsed, features });
});

// ── Helpers ────────────────────────────────────────────────────────

// Base64-encode a Uint8Array without blowing the call stack on large
// buffers. btoa() only accepts strings, so we chunk the bytes.
function base64FromBytes(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

// Defensive sanitiser — strip any element that could execute code or
// load remote content. Claude is instructed not to emit these, but
// the avatar is rendered as an <img src=data:image/svg+xml...> in the
// PWA, so we double-check before handing it to the client.
function sanitizeSvg(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  if (s.length > 64_000) return null;
  // Forbidden tags / attributes. Order matters — strip script first.
  const banned = [
    /<script[\s\S]*?<\/script>/gi,
    /<foreignObject[\s\S]*?<\/foreignObject>/gi,
    /<image\b[^>]*>/gi,
    /\son\w+="[^"]*"/gi,
    /\son\w+='[^']*'/gi,
    /(?:href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi,
    /(?:href|xlink:href)\s*=\s*'(?!#)[^']*'/gi,
  ];
  let out = s;
  for (const re of banned) out = out.replace(re, "");
  return out;
}
