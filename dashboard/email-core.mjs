// email-core.mjs · pure logic extracted from the Email (Fleet Bridge)
// IIFE in live.js (Email review EM#100), following the msg-core/cal-tz
// pattern: no DOM, no Supabase, no Date.now() hidden inside — callers
// pass `now` where time matters, so every function is deterministic
// under test (scripts/test-email-core.mjs, part of `npm test`).
//
// live.js delegates to these — change behavior HERE, not in the
// wrappers, or the suite and the app drift apart.

// Plain text from an HTML-only body (EM#10) · snippet, search, quoting,
// and the preview fallback all read body_text, which is null on rows
// that arrived or were composed as HTML only. Style/script blocks go
// first so CSS soup never leaks into snippets; input is capped so a
// multi-MB marketing email can't stall a 200-row render.
export function textFromHtml(html) {
  if (!html) return "";
  return String(html).slice(0, 8000)
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Date-bucket grouping for the inbox ribbons (Today / Yesterday / …).
export function dateBucket(d, now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msg = new Date(d);
  const startOfMsg = new Date(msg.getFullYear(), msg.getMonth(), msg.getDate()).getTime();
  const days = Math.floor((startOfToday - startOfMsg) / 86400000);
  if (days === 0) return { key: "today",       label: "Today" };
  if (days === 1) return { key: "yesterday",   label: "Yesterday" };
  if (days <  7)  return { key: "this-week",   label: "Earlier this week" };
  if (days < 30)  return { key: "this-month",  label: "Earlier this month" };
  if (days < 365) return { key: "this-year",   label: "Earlier this year" };
  return                  { key: "older",      label: "Older" };
}

// Relative timestamps for list rows ("3d", "2h", "just now").
export function formatRelative(d, now = new Date()) {
  const diff = now.getTime() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString();
}

// Subject prefix hygiene (EM#77) · "Re: Re: Fwd: quote" chains collapse
// to one prefix on compose instead of growing unbounded.
export function prefixSubject(prefix, s) {
  const bare = String(s || "").replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "").trim();
  return bare ? prefix + " " + bare : "";
}

// Search operators (EM#68) · from:/to:/has:attachment/before:/after:
// parsed out of the query; whatever's left is the free-text term.
// Unrecognized values fall back into the free text so a half-typed
// operator never makes mail vanish.
export function parseQuery(raw) {
  const out = { text: "", from: null, to: null, hasAttachment: false, before: null, after: null };
  const free = [];
  for (const tok of String(raw || "").trim().split(/\s+/)) {
    if (!tok) continue;
    const m = tok.match(/^(from|to|has|before|after):(.+)$/i);
    if (!m) { free.push(tok); continue; }
    const k = m[1].toLowerCase(), v = m[2];
    if (k === "from") out.from = v;
    else if (k === "to") out.to = v;
    else if (k === "has") { if (/^attach/i.test(v)) out.hasAttachment = true; else free.push(tok); }
    else {
      const d = new Date(v + "T00:00:00");
      if (isNaN(d.getTime())) { free.push(tok); continue; }
      if (k === "before") out.before = d; else out.after = d;
    }
  }
  out.text = free.join(" ");
  return out;
}

// Recipient address validation + the comma/semicolon chip split.
export function addrOk(a) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a);
}
export function splitAddrs(raw) {
  return String(raw || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

// Threading key (EM#33) · strips reply/forward prefixes so "Re: Fwd:
// Quote" and "Quote" land in one conversation.
export function threadKey(subject) {
  return String(subject || "").replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "").trim().toLowerCase();
}

// The other party of a message — who to thread/reply against.
export function counterpart(m) {
  return ((m.direction === "inbound" ? m.from_email : m.to_email) || "").trim().toLowerCase();
}

// "> "-quoting for reply bodies (the header line stays in live.js —
// it's locale/date formatting, not logic).
export function quoteText(text) {
  return String(text || "").replace(/\s+$/g, "").split("\n").map(l => "> " + l).join("\n");
}
