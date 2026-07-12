// Unit tests for dashboard/meet-core.js — the pure logic behind
// RouteReady Meet. The two invariants that must never regress:
//  · every human spelling of a meeting code normalizes to ONE canonical
//    form (the Realtime channel name derives from it — two spellings
//    must never split a meeting into two rooms), and
//  · politeness is antisymmetric (exactly one polite peer per pair),
//    or the perfect-negotiation handshake double-offers/deadlocks.
import {
  MEET_CODE_ALPHABET, MEET_CODE_LENGTH,
  genMeetCode, formatMeetCode, normalizeMeetCode, buildMeetUrl,
  isPolite, sortRoster, gridDims, fmtDuration, initials,
  sendPolicy, qualityLevel, pickActiveSpeaker,
} from "../dashboard/meet-core.js";

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓", label); return; }
  failures++;
  console.error("  ✗", label, "\n    expected:", e, "\n    actual:  ", a);
}

console.log("normalizeMeetCode");
eq(normalizeMeetCode("abc-defg-hjk"), "abc-defg-hjk", "canonical form passes through");
eq(normalizeMeetCode("abcdefghjk"), "abc-defg-hjk", "bare 10-char code gains dashes");
eq(normalizeMeetCode("ABC DEFG HJK"), "abc-defg-hjk", "uppercase + spaces normalize");
eq(normalizeMeetCode("  abc-defg-hjk  "), "abc-defg-hjk", "surrounding whitespace trimmed");
eq(normalizeMeetCode("https://gorouteready.com/m/abc-defg-hjk"), "abc-defg-hjk", "short /m/ link");
eq(normalizeMeetCode("https://gorouteready.com/m/ABCDEFGHJK?x=1"), "abc-defg-hjk", "/m/ link, bare uppercase code + extra query");
eq(normalizeMeetCode("https://gorouteready.com/dashboard/meet.html?m=abc-defg-hjk"), "abc-defg-hjk", "?m= link");
eq(normalizeMeetCode("https://gorouteready.com/dashboard/meet.html?x=1&m=abc-defg-hjk#room"), "abc-defg-hjk", "&m= with hash");
eq(normalizeMeetCode("ab2-3efg-hjk"), "ab2-3efg-hjk", "digits tolerated (future-proof reads)");
eq(normalizeMeetCode("abc-defg"), null, "too short → null");
eq(normalizeMeetCode("abc-defg-hjkm"), null, "too long → null");
eq(normalizeMeetCode(""), null, "empty → null");
eq(normalizeMeetCode(null), null, "null → null");
eq(normalizeMeetCode("https://gorouteready.com/m/"), null, "link with no code → null");

console.log("formatMeetCode / genMeetCode");
eq(formatMeetCode("abcdefghjk"), "abc-defg-hjk", "3-4-3 grouping");
eq(formatMeetCode("short"), null, "wrong length → null");
{
  // Deterministic rng: cycles through the alphabet.
  let n = 0;
  const rng = () => (n++ % MEET_CODE_ALPHABET.length) / MEET_CODE_ALPHABET.length;
  const code = genMeetCode(rng);
  eq(code, "abc-defg-hjk", "genMeetCode walks the alphabet with a cycling rng");
  eq(normalizeMeetCode(code), code, "generated codes are already canonical");
  eq(genMeetCode(() => 0.9999999).length, MEET_CODE_LENGTH + 2, "rng at 1-ε stays in-alphabet (no undefined chars)");
}

console.log("isPolite");
eq(isPolite("aaa", "bbb"), true, "lower key is polite");
eq(isPolite("bbb", "aaa"), false, "higher key is impolite");
eq(isPolite("aaa", "bbb") !== isPolite("bbb", "aaa"), true, "antisymmetric — exactly one polite peer per pair");

console.log("sortRoster");
eq(
  sortRoster([
    { key: "b", joined_at: 200 },
    { key: "a", joined_at: 100 },
    { key: "c", joined_at: 150 },
  ]).map((p) => p.key),
  ["a", "c", "b"],
  "earliest joiner first"
);
eq(
  sortRoster([
    { key: "z", joined_at: 100 },
    { key: "a", joined_at: 100 },
  ]).map((p) => p.key),
  ["a", "z"],
  "same-millisecond joins tie-break on key (stable on every client)"
);
eq(sortRoster([]), [], "empty roster tolerated");
{
  const input = [{ key: "b", joined_at: 2 }, { key: "a", joined_at: 1 }];
  sortRoster(input);
  eq(input.map((p) => p.key), ["b", "a"], "input array is not mutated");
}

console.log("gridDims");
eq(gridDims(1), { cols: 1, rows: 1 }, "solo call: 1×1");
eq(gridDims(2), { cols: 2, rows: 1 }, "1:1 call: 2×1");
eq(gridDims(3), { cols: 2, rows: 2 }, "3 tiles: 2×2");
eq(gridDims(4), { cols: 2, rows: 2 }, "4 tiles: 2×2");
eq(gridDims(5), { cols: 3, rows: 2 }, "5 tiles: 3×2");
eq(gridDims(9), { cols: 3, rows: 3 }, "9 tiles: 3×3");
eq(gridDims(10), { cols: 4, rows: 3 }, "10 tiles: 4×3");
eq(gridDims(0), { cols: 1, rows: 1 }, "0 clamps to 1×1");

console.log("fmtDuration");
eq(fmtDuration(0), "0:00", "zero");
eq(fmtDuration(5000), "0:05", "seconds pad");
eq(fmtDuration(65_000), "1:05", "minutes");
eq(fmtDuration(3_600_000), "1:00:00", "exactly one hour");
eq(fmtDuration(3_753_000), "1:02:33", "h:mm:ss with padded minutes");
eq(fmtDuration(-5), "0:00", "negative clamps to zero");

console.log("initials");
eq(initials("Dana Ortiz"), "DO", "first + last");
eq(initials("dana k. ortiz"), "DO", "lowercase, middle name skipped");
eq(initials("Cher"), "C", "single name");
eq(initials("  "), "?", "whitespace-only → ?");
eq(initials(null), "?", "null → ?");

console.log("buildMeetUrl");
eq(buildMeetUrl("https://gorouteready.com", "abc-defg-hjk"), "https://gorouteready.com/m/abc-defg-hjk", "plain base");
eq(buildMeetUrl("https://gorouteready.com/", "abc-defg-hjk"), "https://gorouteready.com/m/abc-defg-hjk", "trailing slash stripped");

console.log("sendPolicy");
eq(sendPolicy(2), { maxBitrate: 4_000_000, scaleResolutionDownBy: 1, degradationPreference: "maintain-resolution" }, "1:1 call gets the full 1080p ceiling, resolution-first");
eq(sendPolicy(1), sendPolicy(2), "solo clamps to the 1:1 tier");
eq(sendPolicy(4).maxBitrate, 1_500_000, "4-way steps down to 1.5Mbps");
eq(sendPolicy(4).scaleResolutionDownBy, 1, "4-way keeps full resolution");
eq(sendPolicy(6).maxBitrate, 900_000, "6-way sends 900kbps per peer");
eq(sendPolicy(6).scaleResolutionDownBy, 1.5, "6-way scales resolution down 1.5×");
eq(sendPolicy(9).scaleResolutionDownBy, 2, "big rooms cap at 2× downscale");
eq(sendPolicy(9).maxBitrate, 500_000, "big rooms cap at 500kbps per peer");
eq(sendPolicy(9).degradationPreference, "maintain-framerate", "big rooms keep motion smooth over sharpness");
eq(sendPolicy(6, true), { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, degradationPreference: "maintain-resolution" }, "screen share never degrades with roster size and prefers resolution");

console.log("qualityLevel");
eq(qualityLevel(40, 0), 3, "LAN-grade → 3 bars");
eq(qualityLevel(149, 1.9), 3, "just inside the good thresholds → 3");
eq(qualityLevel(200, 1), 2, "150-300ms RTT → 2 bars");
eq(qualityLevel(100, 4), 2, "2-5% loss → 2 bars");
eq(qualityLevel(400, 8), 1, "high but usable → 1 bar");
eq(qualityLevel(600, 1), 0, "600ms RTT → 0 bars regardless of loss");
eq(qualityLevel(50, 20), 0, "20% loss → 0 bars regardless of RTT");
eq(qualityLevel(undefined, undefined), 0, "missing stats read as bad, not good");

console.log("pickActiveSpeaker");
{
  const t0 = 10_000;
  eq(pickActiveSpeaker({ a: 0.001, b: 0.002 }, "a", 0, t0), "a", "nobody above threshold → keep current");
  eq(pickActiveSpeaker({ a: 0.2, b: 0.05 }, "a", 0, t0), "a", "current is loudest → keep");
  eq(pickActiveSpeaker({ a: 0.02, b: 0.2 }, "a", t0 - 500, t0), "a", "within hold window → keep (debounce)");
  eq(pickActiveSpeaker({ a: 0.02, b: 0.2 }, "a", t0 - 5000, t0), "b", "clearly louder after hold → switch");
  eq(pickActiveSpeaker({ a: 0.1, b: 0.11 }, "a", t0 - 5000, t0), "a", "barely louder than a still-speaking current → keep (margin)");
  eq(pickActiveSpeaker({ a: 0.001, b: 0.2 }, "a", t0 - 5000, t0), "b", "current silent + challenger speaking → switch");
  eq(pickActiveSpeaker({}, "a", 0, t0), "a", "empty levels → keep");
  eq(pickActiveSpeaker({ b: 0.2 }, null, 0, t0), "b", "no current speaker → first talker takes the stage");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll meet-core tests passed.");
