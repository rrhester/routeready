// Tests for dashboard/email-core.mjs (Email review EM#100).
// These run on every list render (buckets, relative times, snippets),
// every compose (subject prefixes, address chips, quoting), and every
// search keystroke (operator parsing) — pure and deterministic, with
// `now` injected wherever time matters.
import {
  textFromHtml, dateBucket, formatRelative, prefixSubject, parseQuery,
  addrOk, splitAddrs, threadKey, counterpart, quoteText,
} from "../dashboard/email-core.mjs";

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓", label); return; }
  failures++;
  console.error("  ✗", label, "\n    expected:", e, "\n    actual:  ", a);
}

console.log("textFromHtml");
eq(textFromHtml(null), "", "null → empty");
eq(textFromHtml("<p>Hello</p><p>World</p>"), "Hello\nWorld", "paragraphs → newlines");
eq(textFromHtml("a<br>b<br/>c"), "a\nb\nc", "br variants → newlines");
eq(textFromHtml("<style>.x{color:red}</style>Text"), "Text", "style blocks stripped first");
eq(textFromHtml("<script>alert(1)</script>Safe"), "Safe", "script blocks stripped");
eq(textFromHtml("A&nbsp;B &amp; C &lt;tag&gt; &quot;q&quot; &#39;s&#39;"), 'A B & C <tag> "q" \'s\'', "entities decoded");
eq(textFromHtml("x\n\n\n\n\ny"), "x\n\ny", "3+ newlines collapse to 2");

console.log("dateBucket (now = 2026-07-25 12:00 local)");
const NOW = new Date(2026, 6, 25, 12, 0, 0);
eq(dateBucket(new Date(2026, 6, 25, 3, 0), NOW).key, "today", "same day → today");
eq(dateBucket(new Date(2026, 6, 24, 23, 59), NOW).key, "yesterday", "previous day → yesterday");
eq(dateBucket(new Date(2026, 6, 20), NOW).key, "this-week", "5 days ago → this week");
eq(dateBucket(new Date(2026, 6, 1), NOW).key, "this-month", "24 days ago → this month");
eq(dateBucket(new Date(2026, 1, 1), NOW).key, "this-year", "months ago → this year");
eq(dateBucket(new Date(2024, 1, 1), NOW).key, "older", "years ago → older");

console.log("formatRelative");
eq(formatRelative(new Date(NOW.getTime() - 30_000), NOW), "just now", "<1m → just now");
eq(formatRelative(new Date(NOW.getTime() - 5 * 60_000), NOW), "5m", "minutes");
eq(formatRelative(new Date(NOW.getTime() - 3 * 3600_000), NOW), "3h", "hours");
eq(formatRelative(new Date(NOW.getTime() - 2 * 86400_000), NOW), "2d", "days");

console.log("prefixSubject (EM#77)");
eq(prefixSubject("Re:", "Quote request"), "Re: Quote request", "plain subject gets prefix");
eq(prefixSubject("Re:", "Re: Quote request"), "Re: Quote request", "existing Re: not doubled");
eq(prefixSubject("Re:", "Re: Re: Fwd: Quote request"), "Re: Quote request", "chains collapse");
eq(prefixSubject("Fwd:", "RE: FW: quote"), "Fwd: quote", "case-insensitive, FW variant");
eq(prefixSubject("Re:", ""), "", "empty subject stays empty");
eq(prefixSubject("Re:", "Re:"), "", "prefix-only subject → empty");

console.log("parseQuery (EM#68)");
eq(parseQuery("plain words"), { text: "plain words", from: null, to: null, hasAttachment: false, before: null, after: null }, "free text only");
eq(parseQuery("from:bob invoice").from, "bob", "from: operator");
eq(parseQuery("from:bob invoice").text, "invoice", "free text survives operators");
eq(parseQuery("to:ann@x.com").to, "ann@x.com", "to: operator");
eq(parseQuery("has:attachment").hasAttachment, true, "has:attachment");
eq(parseQuery("has:attach").hasAttachment, true, "has:attach shorthand");
eq(parseQuery("has:banana").text, "has:banana", "unknown has: value falls back to text");
eq(parseQuery("before:2026-07-01").before instanceof Date, true, "before: parses a date");
eq(parseQuery("after:notadate").text, "after:notadate", "bad date falls back to text");
eq(parseQuery("from:").text, "from:", "valueless operator stays free text");

console.log("addrOk / splitAddrs");
eq(addrOk("a@b.co"), true, "valid address");
eq(addrOk("nope"), false, "no @ rejected");
eq(addrOk("a b@c.co"), false, "space rejected");
eq(addrOk("a@b"), false, "no TLD dot rejected");
eq(splitAddrs("a@b.co, c@d.co; e@f.co"), ["a@b.co", "c@d.co", "e@f.co"], "comma+semicolon split");
eq(splitAddrs("  a@b.co  "), ["a@b.co"], "trimmed");
eq(splitAddrs(""), [], "empty → []");

console.log("threadKey / counterpart (EM#33)");
eq(threadKey("Re: Fwd: Quote"), "quote", "prefixes stripped + lowercased");
eq(threadKey("AW: Angebot"), "angebot", "German AW: prefix");
eq(threadKey(null), "", "null-safe");
eq(counterpart({ direction: "inbound", from_email: "V@X.com", to_email: "me@y.com" }), "v@x.com", "inbound → sender");
eq(counterpart({ direction: "outbound", from_email: "me@y.com", to_email: "V@X.com" }), "v@x.com", "outbound → recipient");

console.log("quoteText");
eq(quoteText("line one\nline two"), "> line one\n> line two", "each line quoted");
eq(quoteText("trailing ws  \n"), "> trailing ws", "trailing whitespace trimmed");
eq(quoteText(""), "> ", "empty body still quotes one line");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll email-core tests passed.");
