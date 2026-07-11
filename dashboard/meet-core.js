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

// ─── quality pass (Zoom-parity) ─────────────────────────────────────────

// sendPolicy(participantCount, isScreen) → RTCRtpSender tuning for one
// outgoing video encoding. A mesh sends one copy of your video to EVERY
// peer, so upload cost grows linearly with the roster — the only way a
// 6-person call stays smooth on a normal uplink is to shrink what each
// copy costs as the room grows. Screen shares are exempt: legibility of
// shared text beats motion smoothness, and there's only ever one stage.
export function sendPolicy(participantCount, isScreen = false) {
  if (isScreen) {
    return { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, degradationPreference: "maintain-resolution" };
  }
  const n = Math.max(2, Math.floor(Number(participantCount) || 0));
  if (n <= 2) return { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, degradationPreference: "maintain-framerate" };
  if (n <= 4) return { maxBitrate: 1_200_000, scaleResolutionDownBy: 1.5, degradationPreference: "maintain-framerate" };
  if (n <= 6) return { maxBitrate: 800_000, scaleResolutionDownBy: 2, degradationPreference: "maintain-framerate" };
  return { maxBitrate: 500_000, scaleResolutionDownBy: 2, degradationPreference: "maintain-framerate" };
}

// qualityLevel(rttMs, lossPct) → 3 (good) / 2 (ok) / 1 (poor) / 0 (bad)
// for the per-tile connection bars. Thresholds follow the usual video-
// call rules of thumb: <150ms/<2% is transparent, <300ms/<5% is fine,
// beyond ~450ms or ~10% loss the call is visibly degrading.
export function qualityLevel(rttMs, lossPct) {
  const rtt = Number(rttMs);
  const loss = Number(lossPct);
  const r = Number.isFinite(rtt) ? rtt : 9999;
  const l = Number.isFinite(loss) ? loss : 100;
  if (r < 150 && l < 2) return 3;
  if (r < 300 && l < 5) return 2;
  if (r < 450 && l < 10) return 1;
  return 0;
}

// pickActiveSpeaker(levels, current, lastSwitchAt, now, opts) → the key
// that should hold the speaker-view stage. Pure so the hysteresis is
// testable: without the hold window + louder-by-a-margin rule, the
// stage ping-pongs on every "mm-hm" and the view feels broken.
//  · nobody above the noise threshold → keep current
//  · loudest IS current → keep
//  · within holdMs of the last switch → keep (debounce)
//  · current still audibly speaking and challenger not clearly louder
//    (< margin ×) → keep
export function pickActiveSpeaker(levels, current, lastSwitchAt, now, opts = {}) {
  const { threshold = 0.015, margin = 1.4, holdMs = 1200 } = opts;
  let bestKey = null;
  let bestLevel = 0;
  for (const [key, lvl] of Object.entries(levels || {})) {
    const v = Number(lvl) || 0;
    if (v > bestLevel) { bestLevel = v; bestKey = key; }
  }
  if (!bestKey || bestLevel < threshold) return current;
  if (bestKey === current) return current;
  if ((Number(now) || 0) - (Number(lastSwitchAt) || 0) < holdMs) return current;
  const curLevel = Number(levels?.[current]) || 0;
  if (curLevel >= threshold && bestLevel < curLevel * margin) return current;
  return bestKey;
}
