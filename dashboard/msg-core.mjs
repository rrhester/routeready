// ─────────────────────────────────────────────────────────────────────────
// msg-core.mjs · pure logic for the Messages tool (no DOM, no Supabase).
//
// Extracted so the composer/bubble behaviours that are easy to get subtly
// wrong — markdown-lite rendering over already-escaped HTML, emoji
// shortcodes, template variable fill, image resize math — are unit-tested
// in Node (scripts/test-msg-core.mjs) instead of only exercised by hand.
// live.js imports the public names; keep everything here DOM-free.
// ─────────────────────────────────────────────────────────────────────────

// ── Markdown-lite ────────────────────────────────────────────────────────
// Renders a *small* markdown subset inside chat bubbles:
//   **bold**  __bold__   *italic*  _italic_   `code`   "- " bullet lines
// The input is ALREADY HTML-escaped (entities) and may contain <br> tags
// plus <a> anchors injected by linkifyEscaped. We therefore tokenize on
// tags and only transform the text runs between them, so a delimiter can
// never straddle or corrupt real markup. Escaped entities (&amp; etc.)
// pass through untouched — we never introduce raw <, > or & here.

function _mdInline(text) {
  // Backticks first, protecting code spans from the emphasis passes.
  const codeSlots = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, body) => {
    codeSlots.push(`<code class="rr-md-code">${body}</code>`);
    return `${codeSlots.length - 1}`;
  });
  // Bold: **…** and __…__ (no leading/trailing space inside delimiters).
  out = out.replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(\S(?:[^_]*?\S)?)__/g, "<strong>$1</strong>");
  // Italic: single * not part of ** — and single _ only on word boundaries
  // (so snake_case identifiers survive).
  out = out.replace(/(^|[^*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^\s_](?:[^_]*?[^\s_])?)_(?=$|[\s).,!?;:])/g, "$1<em>$2</em>");
  return out.replace(/(\d+)/g, (_, i) => codeSlots[+i]);
}

export function mdLite(escapedHtml) {
  const s = String(escapedHtml ?? "");
  if (!s) return s;
  // Nothing that could be markdown → skip the work entirely.
  if (!/[*_`]|^- |<br>- /.test(s)) return s;
  // Split into tag / text runs; transform only the text runs.
  const parts = s.split(/(<[^>]+>)/);
  let joined = "";
  for (const p of parts) {
    joined += (p.startsWith("<") && p.endsWith(">")) ? p : _mdInline(p);
  }
  // Bullet lines: "- item" at string start or right after a <br>.
  joined = joined.replace(/(^|<br>)- (?=\S)/g, '$1<span class="rr-md-bullet">•</span> ');
  return joined;
}

// ── Emoji shortcodes + picker data ───────────────────────────────────────
export const SHORTCODES = {
  thumbsup: "👍", "+1": "👍", thumbsdown: "👎", ok: "👌", wave: "👋",
  clap: "👏", pray: "🙏", muscle: "💪", point_up: "☝️", eyes: "👀",
  smile: "😄", grin: "😁", joy: "😂", sweat_smile: "😅", wink: "😉",
  blush: "😊", slight_smile: "🙂", thinking: "🤔", neutral: "😐",
  worried: "😟", cry: "😢", sob: "😭", angry: "😠", scream: "😱",
  sleeping: "😴", sick: "🤒", sunglasses: "😎", salute: "🫡",
  heart: "❤️", fire: "🔥", star: "⭐", tada: "🎉", "100": "💯",
  check: "✅", white_check_mark: "✅", x: "❌", warning: "⚠️",
  question: "❓", exclamation: "❗", zap: "⚡", clock: "🕐",
  calendar: "📅", pin: "📌", memo: "📝", phone: "📞", bell: "🔔",
  package: "📦", truck: "🚚", van: "🚐", car: "🚗", fuel: "⛽",
  wrench: "🔧", key: "🔑", map: "🗺️", house: "🏠", office: "🏢",
  sun: "☀️", cloud: "☁️", rain: "🌧️", snow: "❄️", wind: "💨",
  coffee: "☕", pizza: "🍕", dog: "🐶", rocket: "🚀", mic: "🎤",
};

// Curated picker set — [emoji, name, extra search keywords].
export const EMOJIS = [
  ["👍", "thumbs up", "yes ok approve +1"], ["👎", "thumbs down", "no reject"],
  ["👌", "ok hand", "perfect"], ["👋", "wave", "hi hello bye"],
  ["👏", "clap", "applause bravo"], ["🙏", "pray", "please thanks"],
  ["💪", "muscle", "strong flex"], ["👀", "eyes", "look watch"],
  ["🫡", "salute", "yes sir copy"], ["🤝", "handshake", "deal thanks"],
  ["😄", "smile", "happy"], ["😁", "grin", "happy"], ["😂", "joy", "laugh lol funny"],
  ["😅", "sweat smile", "phew close"], ["😉", "wink", ""], ["😊", "blush", "happy"],
  ["🙂", "slight smile", "fine"], ["🤔", "thinking", "hmm consider"],
  ["😐", "neutral", "meh"], ["😟", "worried", "concern"], ["😢", "cry", "sad tear"],
  ["😭", "sob", "crying sad"], ["😠", "angry", "mad"], ["😱", "scream", "shock"],
  ["😴", "sleeping", "tired zzz"], ["🤒", "sick", "ill fever"],
  ["😎", "sunglasses", "cool"], ["🥳", "party", "celebrate"],
  ["❤️", "heart", "love"], ["🔥", "fire", "hot lit"], ["⭐", "star", "favorite"],
  ["🎉", "tada", "party celebrate congrats"], ["💯", "hundred", "100 perfect"],
  ["✅", "check", "done yes complete"], ["❌", "x", "no wrong cancel"],
  ["⚠️", "warning", "caution alert"], ["❓", "question", "what"],
  ["❗", "exclamation", "important"], ["⚡", "zap", "fast lightning"],
  ["🕐", "clock", "time schedule"], ["📅", "calendar", "date schedule"],
  ["📌", "pin", "important save"], ["📝", "memo", "note write"],
  ["📞", "phone", "call"], ["🔔", "bell", "notify alert"],
  ["📦", "package", "box delivery parcel"], ["🚚", "truck", "delivery"],
  ["🚐", "van", "delivery route"], ["🚗", "car", "drive"],
  ["⛽", "fuel", "gas pump"], ["🔧", "wrench", "fix repair tool"],
  ["🔑", "key", "keys unlock"], ["🗺️", "map", "route directions"],
  ["🏠", "house", "home"], ["🏢", "office", "station building"],
  ["☀️", "sun", "sunny weather"], ["☁️", "cloud", "weather"],
  ["🌧️", "rain", "weather wet"], ["❄️", "snow", "cold winter weather"],
  ["💨", "wind", "fast dash"], ["🌩️", "storm", "thunder weather"],
  ["☕", "coffee", "break morning"], ["🍕", "pizza", "food lunch"],
  ["🐶", "dog", "pet animal"], ["🚀", "rocket", "launch fast go"],
  ["🎤", "mic", "voice audio"], ["💬", "speech", "message chat"],
  ["🙌", "raised hands", "praise yay"], ["🤞", "fingers crossed", "luck hope"],
];

export function searchEmoji(q, list = EMOJIS) {
  const s = String(q || "").trim().toLowerCase().replace(/[\s_]+/g, "");
  if (!s) return list;
  // Space/underscore-insensitive so ":thumbsup" finds "thumbs up".
  return list.filter(([, name, kw]) =>
    name.replace(/\s+/g, "").includes(s) || (kw && kw.replace(/\s+/g, " ").includes(s)));
}

// Replace complete :shortcode: tokens in plain text (run before send).
export function applyShortcodes(text, codes = SHORTCODES) {
  return String(text ?? "").replace(/:([a-z0-9_+-]+):/gi, (m, code) =>
    Object.prototype.hasOwnProperty.call(codes, code.toLowerCase()) ? codes[code.toLowerCase()] : m);
}

// If the caret sits inside a partial :shortcode token, return
// { start, query } so the composer can pop suggestions; else null.
// Requires ≥2 typed chars after the colon, and the colon must start a
// word (so "10:30" never triggers).
export function shortcodeAt(text, caret) {
  const upto = String(text ?? "").slice(0, caret);
  const m = upto.match(/(^|[\s>])(:([a-z0-9_+-]{2,}))$/i);
  if (!m) return null;
  return { start: upto.length - m[2].length, query: m[3].toLowerCase() };
}

// ── Message templates / snippets ─────────────────────────────────────────
// {{var}} placeholders, with an optional "|fallback": {{next_shift|your
// next shift}}. Unknown variables are left intact so the operator SEES
// the gap instead of silently sending a blank.
export function fillTemplate(body, ctx) {
  const vars = ctx || {};
  return String(body ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (m, key, fb) => {
    const v = vars[key.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    if (fb !== undefined) return fb;
    return m;
  });
}

export const BUILTIN_TEMPLATES = [
  { id: "b-eta",     name: "Ask for ETA",        shortcut: "eta",     body: "Hi {{first_name}}, can you share your current ETA? Thanks!" },
  { id: "b-shift",   name: "Confirm next shift", shortcut: "shift",   body: "Hi {{first_name}}, confirming your next shift on {{next_shift|your next scheduled day}} starting {{next_shift_time|at the usual time}}. Reply 👍 to confirm." },
  { id: "b-late",    name: "Running-late check", shortcut: "late",    body: "Hi {{first_name}}, your shift started {{next_shift_time|recently}} — are you on your way? Let us know your ETA." },
  { id: "b-welcome", name: "Welcome",            shortcut: "welcome", body: "Welcome to the team, {{first_name}}! This is the dispatch line — message us here any time." },
  { id: "b-callin",  name: "Call dispatch",      shortcut: "call",    body: "Hi {{first_name}}, please call dispatch when you get a moment." },
];

// Filter + rank templates for the slash menu: shortcut prefix matches
// first, then name/body substring matches. q arrives without the "/".
export function matchTemplates(templates, q) {
  const list = Array.isArray(templates) ? templates : [];
  const s = String(q || "").trim().toLowerCase();
  if (!s) return list;
  const pre = [], sub = [];
  for (const t of list) {
    const sc = String(t.shortcut || "").toLowerCase();
    const name = String(t.name || "").toLowerCase();
    const body = String(t.body || "").toLowerCase();
    if (sc.startsWith(s)) pre.push(t);
    else if (name.includes(s) || body.includes(s)) sub.push(t);
  }
  return pre.concat(sub);
}

// ── Attachment helpers ───────────────────────────────────────────────────
// Scale (w,h) to fit within maxDim, preserving aspect; never upscales.
export function fitDims(w, h, maxDim) {
  w = Math.max(1, Math.round(w || 1)); h = Math.max(1, Math.round(h || 1));
  const m = Math.max(w, h);
  if (m <= maxDim) return { w, h };
  const k = maxDim / m;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// Only recompress formats where it's lossless-safe-ish and worth it —
// big JPEG/PNG/WebP photos. GIFs (animation) and small files pass through.
export function shouldCompress(mime, sizeBytes) {
  const m = String(mime || "").toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(m)) return false;
  return (sizeBytes || 0) > 500 * 1024;
}

// ── Misc ─────────────────────────────────────────────────────────────────
export function draftKey(kind, id) { return `rr_draft_${kind}_${id}`; }
