// Tests for dashboard/msg-core.mjs (Messages 100-list, Batch 1).
// The transforms here run on every chat bubble and every composer
// keystroke — markdown-lite must never corrupt escaped HTML or linkified
// anchors, shortcodes must never fire inside times like "10:30", and
// template fill must leave unknown variables visible instead of silently
// blanking them.
import {
  mdLite, applyShortcodes, shortcodeAt, searchEmoji, EMOJIS, SHORTCODES,
  fillTemplate, matchTemplates, BUILTIN_TEMPLATES, fitDims, shouldCompress, draftKey,
} from "../dashboard/msg-core.mjs";

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓", label); return; }
  failures++;
  console.error("  ✗", label, "\n    expected:", e, "\n    actual:  ", a);
}

console.log("mdLite · basics");
eq(mdLite("plain text"), "plain text", "no markdown → untouched");
eq(mdLite("**bold**"), "<strong>bold</strong>", "double-star bold");
eq(mdLite("__bold__"), "<strong>bold</strong>", "double-underscore bold");
eq(mdLite("a *word* here"), "a <em>word</em> here", "single-star italic");
eq(mdLite("try _this_ now"), "try <em>this</em> now", "underscore italic on word boundary");
eq(mdLite("`code here`"), '<code class="rr-md-code">code here</code>', "inline code");
eq(mdLite("**bold** and *it* and `c`"), '<strong>bold</strong> and <em>it</em> and <code class="rr-md-code">c</code>', "all three together");

console.log("mdLite · non-triggers");
eq(mdLite("5 * 3 * 2"), "5 * 3 * 2", "spaced asterisks are not emphasis");
eq(mdLite("snake_case_name stays"), "snake_case_name stays", "snake_case untouched");
eq(mdLite("a ** b"), "a ** b", "lone double-star untouched");
eq(mdLite("van_101 and route_A"), "van_101 and route_A", "identifiers with underscores survive");
eq(mdLite("`*not bold*`"), '<code class="rr-md-code">*not bold*</code>', "emphasis inside code is protected");

console.log("mdLite · tags and entities pass through");
eq(mdLite('<a href="x">**link**</a>'), '<a href="x"><strong>link</strong></a>', "anchor text transforms, tag untouched");
eq(mdLite("**a**<br>**b**"), "<strong>a</strong><br><strong>b</strong>", "per-segment transform across <br>");
eq(mdLite("**a<br>b**"), "**a<br>b**", "delimiters never straddle a tag");
eq(mdLite("&amp; **x**"), "&amp; <strong>x</strong>", "escaped entities untouched");
eq(mdLite('<a href="http://x.com/a_b_c">u</a>'), '<a href="http://x.com/a_b_c">u</a>', "URL underscores inside tag untouched");

console.log("mdLite · bullets");
eq(mdLite("- first<br>- second"), '<span class="rr-md-bullet">•</span> first<br><span class="rr-md-bullet">•</span> second', "bullet lines at start and after <br>");
eq(mdLite("a - b"), "a - b", "mid-line dash is not a bullet");
eq(mdLite("-no space"), "-no space", "no space after dash → not a bullet");

console.log("applyShortcodes");
eq(applyShortcodes("good :thumbsup:"), "good 👍", "known code replaced");
eq(applyShortcodes(":check: done :x:"), "✅ done ❌", "multiple codes");
eq(applyShortcodes("meet at 10:30:00 sharp"), "meet at 10:30:00 sharp", "times don't match known codes");
eq(applyShortcodes(":notacode:"), ":notacode:", "unknown code left intact");
eq(applyShortcodes(":THUMBSUP:"), "👍", "case-insensitive");

console.log("shortcodeAt");
eq(shortcodeAt("hello :thu", 10), { start: 6, query: "thu" }, "partial token at caret");
eq(shortcodeAt("hello :t", 8), null, "needs ≥2 chars after colon");
eq(shortcodeAt("at 10:30", 8), null, "colon inside a time never triggers");
eq(shortcodeAt(":wave", 5), { start: 0, query: "wave" }, "token at string start");
eq(shortcodeAt("done :ok now", 12), null, "caret past the token → no match");

console.log("searchEmoji");
eq(searchEmoji("truck").map((e) => e[0]), ["🚚"], "search by name");
eq(searchEmoji("weather").length >= 4, true, "search by keyword hits several");
eq(searchEmoji("").length, EMOJIS.length, "empty query returns full set");
eq(searchEmoji("zzzzz").length, 0, "no match → empty");
eq(searchEmoji("thumbsup")[0][0], "👍", "space-insensitive: thumbsup finds thumbs up");
eq(searchEmoji("thumbs_up")[0][0], "👍", "underscore-insensitive too");

console.log("fillTemplate");
eq(fillTemplate("Hi {{first_name}}!", { first_name: "Ryan" }), "Hi Ryan!", "simple fill");
eq(fillTemplate("Hi {{ first_name }}", { first_name: "Ryan" }), "Hi Ryan", "whitespace inside braces ok");
eq(fillTemplate("Shift {{next_shift|your next shift}}", {}), "Shift your next shift", "fallback used when var missing");
eq(fillTemplate("Shift {{next_shift|fallback}}", { next_shift: "Wed" }), "Shift Wed", "value beats fallback");
eq(fillTemplate("Hi {{unknown_var}}", { first_name: "R" }), "Hi {{unknown_var}}", "unknown var stays visible");
eq(fillTemplate("{{FIRST_NAME}}", { first_name: "Ryan" }), "Ryan", "case-insensitive keys");
eq(fillTemplate("{{empty|fb}}", { empty: "  " }), "fb", "blank value falls back");

console.log("matchTemplates");
const tpls = BUILTIN_TEMPLATES;
eq(matchTemplates(tpls, "eta")[0].shortcut, "eta", "shortcut prefix match first");
eq(matchTemplates(tpls, "").length, tpls.length, "empty query → all");
eq(matchTemplates(tpls, "confirm")[0].shortcut, "shift", "name substring match");
eq(matchTemplates(tpls, "zzz").length, 0, "no match → empty");
eq(matchTemplates(tpls, "w")[0].shortcut, "welcome", "single-char prefix works");

console.log("fitDims");
eq(fitDims(3200, 2400, 1600), { w: 1600, h: 1200 }, "landscape downscale");
eq(fitDims(1200, 3000, 1600), { w: 640, h: 1600 }, "portrait downscale");
eq(fitDims(800, 600, 1600), { w: 800, h: 600 }, "small image never upscales");
eq(fitDims(1600, 1600, 1600), { w: 1600, h: 1600 }, "exact max untouched");

console.log("shouldCompress");
eq(shouldCompress("image/jpeg", 2 * 1024 * 1024), true, "big jpeg → compress");
eq(shouldCompress("image/png", 300 * 1024), false, "small png → skip");
eq(shouldCompress("image/gif", 5 * 1024 * 1024), false, "gif never (animation)");
eq(shouldCompress("application/pdf", 5 * 1024 * 1024), false, "non-image never");

console.log("draftKey");
eq(draftKey("dm", "abc"), "rr_draft_dm_abc", "dm key");
eq(draftKey("ch", "42"), "rr_draft_ch_42", "channel key");

console.log("SHORTCODES sanity");
eq(Object.keys(SHORTCODES).length >= 50, true, "healthy shortcode map");
eq(SHORTCODES.thumbsup, "👍", "canonical thumbsup");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll msg-core tests passed.");
