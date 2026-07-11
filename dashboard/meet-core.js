// meet-core.js · the pure, DOM-free logic behind RouteReady Meet
// (dashboard/meet.html). Everything here is deterministic and runs in
// Node too — scripts/test-meet-core.mjs exercises it directly.
//
// The invariants that matter:
//  · Code normalization must accept every shape a human will paste
//    (bare code, dashed code, full /m/ link, ?m= link, uppercase) and
//    reduce them all to ONE canonical form, because the server matches
//    on the stripped code and the channel name is derived from it —
//    two spellings of the same code must never land in two rooms.
//  · Politeness must be a pure function of the two peer ids and agree
//    from BOTH sides (exactly one polite peer per pair), because the
//    perfect-negotiation pattern deadlocks or double-offers otherwise.

// 23-letter alphabet, i/l/o removed — matches meet_create() in
// supabase/migrations/0457_video_meetings.sql. Codes read over a phone
// without "was that an i or an l?" round-trips.
export const MEET_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz";
export const MEET_CODE_LENGTH = 10; // grouped 3-4-3

// genMeetCode(rng) → "abc-defgh-..." (3-4-3). Only used by the hermetic
// ?local=1 test mode — production codes are minted server-side by the
// meet_create RPC. rng is injectable so tests are deterministic.
export function genMeetCode(rng = Math.random) {
  let raw = "";
  for (let i = 0; i < MEET_CODE_LENGTH; i++) {
    raw += MEET_CODE_ALPHABET[Math.min(MEET_CODE_ALPHABET.length - 1, Math.floor(rng() * MEET_CODE_ALPHABET.length))];
  }
  return formatMeetCode(raw);
}

// formatMeetCode("abcdefghjk") → "abc-defg-hjk". Assumes a pre-stripped
// 10-char code; returns null otherwise.
export function formatMeetCode(raw) {
  const s = String(raw || "");
  if (s.length !== MEET_CODE_LENGTH) return null;
  return s.slice(0, 3) + "-" + s.slice(3, 7) + "-" + s.slice(7);
}

// normalizeMeetCode(anything a user pastes) → canonical "xxx-xxxx-xxx"
// or null. Accepts bare/dashed/spaced codes, full https://…/m/<code>
// links, and ?m=<code> links, any casing. Lenient on charset (letters +
// digits) so a future alphabet change doesn't strand old links; strict
// on length, which is what the server match keys on.
export function normalizeMeetCode(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  // Pull the code out of a pasted link first: ?m=/&m= wins, then a
  // /m/<code> path segment.
  const qm = s.match(/[?&]m=([^&#\s]+)/i);
  if (qm) s = decodeURIComponent(qm[1]);
  else {
    const pm = s.match(/\/m\/([^/?#\s]+)/i);
    if (pm) s = decodeURIComponent(pm[1]);
  }
  const raw = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (raw.length !== MEET_CODE_LENGTH) return null;
  return formatMeetCode(raw);
}

// buildMeetUrl("https://gorouteready.com", "abc-defg-hjk") → short link
// for the invite (netlify.toml/_redirects map /m/:code onto meet.html).
export function buildMeetUrl(baseUrl, code) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base + "/m/" + String(code || "");
}

// isPolite(myKey, theirKey) → am I the polite peer of this pair?
// Perfect negotiation needs exactly one polite peer per pair, agreed on
// by both sides with no extra round-trip. Plain string comparison of
// the (random, unique) peer keys gives exactly that: the lower key is
// polite. Antisymmetric by construction: isPolite(a,b) !== isPolite(b,a)
// for a !== b.
export function isPolite(myKey, theirKey) {
  return String(myKey) < String(theirKey);
}

// sortRoster(entries) → stable participant order for the tile grid.
// entries: [{key, joined_at, ...meta}]. Earliest joiner first so tiles
// don't reshuffle when someone new arrives; key breaks ties so two
// same-millisecond joins still order identically on every client.
export function sortRoster(entries) {
  return [...(entries || [])].sort((a, b) => {
    const ta = Number(a?.joined_at) || 0;
    const tb = Number(b?.joined_at) || 0;
    if (ta !== tb) return ta - tb;
    return String(a?.key) < String(b?.key) ? -1 : 1;
  });
}

// gridDims(n) → {cols, rows} for an n-tile gallery. Squarish, wider
// than tall (Zoom-style): 2→2×1, 3..4→2×2, 5..6→3×2, 7..9→3×3.
export function gridDims(n) {
  const count = Math.max(1, Math.floor(Number(n) || 0));
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

// fmtDuration(ms) → "5:07" / "1:02:33". Meeting-header clock.
export function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? h + ":" + mm : mm) + ":" + String(s).padStart(2, "0");
}

// initials("Dana K. Ortiz") → "DO". Avatar placeholder when a camera is
// off. Falls back to "?" for empty/whitespace names.
export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}
