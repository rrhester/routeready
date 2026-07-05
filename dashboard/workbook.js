// Operations Workbook · workbook.js
//
// A RouteReady-native workbook: spreadsheet blocks with a safe formula
// engine (Excel-compatible date serials, wildcards, approximate lookups,
// A:A ranges, in-formula arrays, LET/LAMBDA, and the full Google Sheets
// function list — ~470 functions), rich-text note blocks, and checklist/task
// blocks — plus comments, @mentions, an activity spine, sharing, CSV
// import/export, and a dependency-free XLSX exporter. Rendered into
// #rr-wb-root (views/view-workbooks.frag) and reached via
// goto('workbooks'). Engine unit tests: scripts/test-formula-engine.mjs.
//
// Design constraints (mirrors the rest of the dashboard):
//   · no framework, no dependencies — string templates + delegation
//   · durable persistence through the tenant-scoped tables from
//     migration 0412 (workbooks / workbook_blocks / workbook_sheets /
//     workbook_cells / ...), direct sb.from() CRUD under RLS
//   · formulas are parsed + evaluated by the recursive-descent engine
//     below — never eval(), never Function()
//   · the grid virtualizes both axes so 1,000×50 sheets stay fast
//
// Exported surface: loadWorkbooksView() — called from the goto()
// dispatcher in live.js when the operator opens the Workbooks view.

"use strict";

// ─── Environment accessors ──────────────────────────────────────────────────
// live.js owns the Supabase client + session (window.RR). workbook.js is
// imported before live.js's body runs, so resolve everything lazily.

function _sb() { return (window.RR && window.RR.sb) || window.sb || null; }
function _me() { return (window.RR && window.RR.user) || null; }
function _dsp() { return (window.RR && window.RR.dsp) || null; }
function _toast(msg, kind) {
  if (typeof window.toast === "function") window.toast(msg, kind);
  else console.log("[wb toast]", kind || "", msg);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flushNow = (...a) => { clearTimeout(t); t = null; fn(...a); };
  return d;
}
function relTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] || "" : "")).toUpperCase();
}
function userName(userId) {
  if (!userId) return "Someone";
  const u = WB.users.find((x) => x.id === userId);
  if (u) return u.full_name || u.email || "Teammate";
  const self = _me();
  if (self && self.id === userId) return self.full_name || "You";
  return "Teammate";
}
function uidShort() { return Math.random().toString(36).slice(2, 10); }

// ─── Rich-text sanitizer ─────────────────────────────────────────────────────
// Allowlist-based: parses into an inert <template>, walks the tree, and
// rebuilds only known-safe tags/attributes. Applied both before save
// and before render, so stored HTML is never trusted either.

const SAFE_TAGS = new Set(["H1", "H2", "H3", "P", "BR", "DIV", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "A", "HR", "CODE", "PRE", "BLOCKQUOTE", "SPAN"]);
const ALIGN_TAGS = new Set(["H1", "H2", "H3", "P", "DIV"]);

function sanitizeHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html ?? "");
  const walk = (node) => {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) { out += esc(child.nodeValue); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (!SAFE_TAGS.has(tag)) { out += walk(child); continue; } // unwrap unknown tags, keep content
      const inner = tag === "BR" || tag === "HR" ? "" : walk(child);
      let attrs = "";
      if (tag === "A") {
        const href = String(child.getAttribute("href") || "");
        if (/^(https?:|mailto:)/i.test(href)) attrs = ` href="${esc(href)}" target="_blank" rel="noopener noreferrer"`;
        else { out += inner; continue; } // drop unsafe links, keep text
      }
      if (ALIGN_TAGS.has(tag)) {
        const st = String(child.getAttribute("style") || "");
        const m = /text-align:\s*(left|center|right)/i.exec(st) || [null, child.getAttribute("align")];
        if (m && m[1] && /^(left|center|right)$/i.test(m[1])) attrs += ` style="text-align:${m[1].toLowerCase()}"`;
      }
      if (tag === "BR" || tag === "HR") out += `<${tag.toLowerCase()}${attrs}>`;
      else out += `<${tag.toLowerCase()}${attrs}>${inner}</${tag.toLowerCase()}>`;
    }
    return out;
  };
  return walk(tpl.content);
}

function richTextToPlain(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = sanitizeHtml(html);
  return (tpl.content.textContent || "").replace(/\s+/g, " ").trim();
}
// RouteReady Operations Workbook · formula engine (draft for workbook.js)
// Safe recursive-descent parser + evaluator. No eval, no Function().
//
// Public surface:
//   parseFormula(src)                -> AST (throws FormulaError)
//   evalFormula(src, ctx)            -> { value, type }  ctx = { getCell(row,col), sheetRows, sheetCols }
//   extractRefs(src)                 -> [{row,col}] flat list of referenced cells (ranges expanded, capped)
//   colLabel(idx) / colIndex(label)  -> 0-based column <-> "A"/"AA" label
//   cellRef(row,col) / parseCellRef("B12") -> "B12" <-> {row,col} 0-based
//
// Error model: FormulaError with .code in
//   #ERROR (parse/eval), #REF (bad/out-of-range ref), #DIV/0, #CIRCULAR,
//   #VALUE (type mismatch), #NAME (unknown function), #NUM (numeric
//   domain/overflow), #N/A (no match)

class FormulaError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

// In-formula array value (2-D, rectangular). Ranges and array-returning
// functions (FILTER, SORT, UNIQUE, SPLIT, …) produce these; aggregates
// consume them. A cell whose final result is an array displays the
// top-left value — results never spill onto the grid.
class Arr {
  constructor(rows) { this.rows = rows; }
  get height() { return this.rows.length; }
  get width() { return this.rows[0] ? this.rows[0].length : 0; }
  top() { return this.rows.length && this.rows[0].length ? this.rows[0][0] : null; }
  flat() { const out = []; for (const r of this.rows) for (const v of r) out.push(v); return out; }
}
function deArr(v) { return v instanceof Arr ? v.top() : v; }
function isClosure(v) { return !!(v && typeof v === "object" && v.__closure); }

// ── Column / cell reference helpers ─────────────────────────────────────────

function colLabel(idx) {
  let n = idx + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function colIndex(label) {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellRef(row, col) { return colLabel(col) + (row + 1); }

const REF_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;
function parseCellRef(s) {
  const m = REF_RE.exec(String(s).trim());
  if (!m) return null;
  return { row: parseInt(m[2], 10) - 1, col: colIndex(m[1]) };
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const TOK_NUM = "num", TOK_STR = "str", TOK_ID = "id", TOK_OP = "op", TOK_LP = "(", TOK_RP = ")", TOK_COMMA = ",", TOK_COLON = ":", TOK_PCT = "%", TOK_LB = "{", TOK_RB = "}", TOK_SEMI = ";";

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c >= "0" && c <= "9" || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i;
      while (j < n && (src[j] >= "0" && src[j] <= "9" || src[j] === ".")) j++;
      // scientific notation 1e5 / 2.5E-3
      if (j < n && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (src[k] >= "0" && src[k] <= "9") { k++; while (k < n && src[k] >= "0" && src[k] <= "9") k++; j = k; }
      }
      const num = Number(src.slice(i, j));
      if (!isFinite(num)) throw new FormulaError("#ERROR", "bad number");
      toks.push({ t: TOK_NUM, v: num });
      i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, out = "";
      for (;;) {
        if (j >= n) throw new FormulaError("#ERROR", "unterminated string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') { out += '"'; j += 2; continue; }
          break;
        }
        out += src[j]; j++;
      }
      toks.push({ t: TOK_STR, v: out });
      i = j + 1; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.$]/.test(src[j])) j++;
      toks.push({ t: TOK_ID, v: src.slice(i, j) });
      i = j; continue;
    }
    if (c === "'") {
      // quoted sheet name: 'Sheet 2'!A1
      let j = i + 1, name = "";
      for (;;) {
        if (j >= n) throw new FormulaError("#ERROR", "unterminated sheet name");
        if (src[j] === "'") { if (src[j + 1] === "'") { name += "'"; j += 2; continue; } break; }
        name += src[j]; j++;
      }
      toks.push({ t: "sheetq", v: name });
      i = j + 1; continue;
    }
    if (c === "!") { toks.push({ t: "!" }); i++; continue; }
    if (c === "#") {
      if (src.slice(i, i + 4).toUpperCase() === "#REF") throw new FormulaError("#REF", "broken reference");
      throw new FormulaError("#ERROR", `unexpected '#'`);
    }
    if (c === "(") { toks.push({ t: TOK_LP }); i++; continue; }
    if (c === ")") { toks.push({ t: TOK_RP }); i++; continue; }
    if (c === "{") { toks.push({ t: TOK_LB }); i++; continue; }
    if (c === "}") { toks.push({ t: TOK_RB }); i++; continue; }
    if (c === ";") { toks.push({ t: TOK_SEMI }); i++; continue; }
    if (c === ",") { toks.push({ t: TOK_COMMA }); i++; continue; }
    if (c === ":") { toks.push({ t: TOK_COLON }); i++; continue; }
    if (c === "%") { toks.push({ t: TOK_PCT }); i++; continue; }
    if (c === "<" && src[i + 1] === "=") { toks.push({ t: TOK_OP, v: "<=" }); i += 2; continue; }
    if (c === ">" && src[i + 1] === "=") { toks.push({ t: TOK_OP, v: ">=" }); i += 2; continue; }
    if (c === "<" && src[i + 1] === ">") { toks.push({ t: TOK_OP, v: "<>" }); i += 2; continue; }
    if ("+-*/^&<>=".includes(c)) { toks.push({ t: TOK_OP, v: c }); i++; continue; }
    throw new FormulaError("#ERROR", `unexpected '${c}'`);
  }
  return toks;
}

// ── Parser (recursive descent) ───────────────────────────────────────────────
// grammar:
//   compare  := concat (( = | <> | < | <= | > | >= ) concat)*
//   concat   := addsub (& addsub)*
//   addsub   := muldiv (( + | - ) muldiv)*
//   muldiv   := unary (( * | / ) unary)*
//   unary    := ( + | - ) unary | power
//   power    := postfix ( ^ unary )?
//   postfix  := primary ( % )*
//   primary  := number | string | ref | range | func(args) | ( compare ) | TRUE | FALSE

const MAX_FORMULA_LEN = 2000;
const MAX_RANGE_CELLS = 20000;
const OPEN_END = 1048575; // sentinel bound for open-ended A:A / 1:3 ranges

function parseFormula(src) {
  if (typeof src !== "string") throw new FormulaError("#ERROR", "not a formula");
  let body = src.trim();
  if (body.startsWith("=")) body = body.slice(1);
  if (body.length === 0) throw new FormulaError("#ERROR", "empty formula");
  if (body.length > MAX_FORMULA_LEN) throw new FormulaError("#ERROR", "formula too long");
  const toks = tokenize(body);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => { const tok = next(); if (!tok || tok.t !== t) throw new FormulaError("#ERROR", `expected ${t}`); return tok; };

  function parseCompare() {
    let left = parseConcat();
    while (peek() && peek().t === TOK_OP && ["=", "<>", "<", "<=", ">", ">="].includes(peek().v)) {
      const op = next().v;
      left = { k: "cmp", op, l: left, r: parseConcat() };
    }
    return left;
  }
  function parseConcat() {
    let left = parseAddSub();
    while (peek() && peek().t === TOK_OP && peek().v === "&") { next(); left = { k: "concat", l: left, r: parseAddSub() }; }
    return left;
  }
  function parseAddSub() {
    let left = parseMulDiv();
    while (peek() && peek().t === TOK_OP && (peek().v === "+" || peek().v === "-")) {
      const op = next().v;
      left = { k: "bin", op, l: left, r: parseMulDiv() };
    }
    return left;
  }
  function parseMulDiv() {
    let left = parseUnary();
    while (peek() && peek().t === TOK_OP && (peek().v === "*" || peek().v === "/")) {
      const op = next().v;
      left = { k: "bin", op, l: left, r: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === TOK_OP && (peek().v === "+" || peek().v === "-")) {
      const op = next().v;
      return { k: "unary", op, v: parseUnary() };
    }
    return parsePower();
  }
  function parsePower() {
    const base = parsePostfix();
    if (peek() && peek().t === TOK_OP && peek().v === "^") { next(); return { k: "bin", op: "^", l: base, r: parseUnary() }; }
    return base;
  }
  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (peek() && peek().t === TOK_PCT) { next(); node = { k: "pct", v: node }; continue; }
      // call-on-expression: LAMBDA(x, x+1)(5), LET-bound lambdas, etc.
      if (peek() && peek().t === TOK_LP && (node.k === "func" || node.k === "call" || node.k === "name")) {
        next();
        const args = [];
        if (peek() && peek().t !== TOK_RP) {
          for (;;) {
            args.push(parseCompare());
            if (peek() && peek().t === TOK_COMMA) { next(); continue; }
            break;
          }
        }
        expect(TOK_RP);
        node = { k: "call", fn: node, args };
        continue;
      }
      break;
    }
    return node;
  }
  function parsePrimary() {
    const tok = next();
    if (!tok) throw new FormulaError("#ERROR", "unexpected end of formula");
    if (tok.t === TOK_NUM) {
      // whole-row range: 1:3 (columns open-ended)
      if (Number.isInteger(tok.v) && tok.v >= 1 && peek() && peek().t === TOK_COLON && toks[p + 1] && toks[p + 1].t === TOK_NUM && Number.isInteger(toks[p + 1].v) && toks[p + 1].v >= 1) {
        next(); // :
        const end = next().v;
        return { k: "range", a: { row: Math.min(tok.v, end) - 1, col: 0 }, b: { row: Math.max(tok.v, end) - 1, col: OPEN_END } };
      }
      return { k: "num", v: tok.v };
    }
    if (tok.t === TOK_STR) return { k: "str", v: tok.v };
    if (tok.t === TOK_LP) { const inner = parseCompare(); expect(TOK_RP); return inner; }
    if (tok.t === TOK_LB) {
      // array literal: {1, 2; 3, 4} — commas separate columns, semicolons rows
      const rows = [[]];
      if (peek() && peek().t !== TOK_RB) {
        for (;;) {
          rows[rows.length - 1].push(parseCompare());
          if (peek() && peek().t === TOK_COMMA) { next(); continue; }
          if (peek() && peek().t === TOK_SEMI) { next(); rows.push([]); continue; }
          break;
        }
      }
      expect(TOK_RB);
      if (rows.some((r) => r.length !== rows[0].length) || !rows[0].length) throw new FormulaError("#VALUE", "array rows must be the same length");
      return { k: "arrlit", rows };
    }
    if (tok.t === TOK_ID) {
      const id = tok.v;
      const up = id.toUpperCase();
      if (up === "TRUE" && !(peek() && peek().t === TOK_LP)) return { k: "bool", v: true };
      if (up === "FALSE" && !(peek() && peek().t === TOK_LP)) return { k: "bool", v: false };
      if (peek() && peek().t === TOK_LP) {
        next(); // consume (
        const args = [];
        if (peek() && peek().t !== TOK_RP) {
          for (;;) {
            args.push(parseCompare());
            if (peek() && peek().t === TOK_COMMA) { next(); continue; }
            break;
          }
        }
        expect(TOK_RP);
        return { k: "func", name: up, args };
      }
      if (peek() && peek().t === "!") { next(); return parseSheetRef(id); }
      // whole-column range: A:A / B:D (rows open-ended)
      if (/^\$?[A-Za-z]{1,3}$/.test(id) && peek() && peek().t === TOK_COLON && toks[p + 1] && toks[p + 1].t === TOK_ID && /^\$?[A-Za-z]{1,3}$/.test(toks[p + 1].v)) {
        next(); // :
        const cA = colIndex(id.replace("$", ""));
        const cB = colIndex(next().v.replace("$", ""));
        return { k: "range", a: { row: 0, col: Math.min(cA, cB) }, b: { row: OPEN_END, col: Math.max(cA, cB) } };
      }
      const ref = parseCellRef(id);
      if (ref) {
        if (peek() && peek().t === TOK_COLON) {
          next();
          const endTok = expect(TOK_ID);
          const end = parseCellRef(endTok.v);
          if (!end) throw new FormulaError("#REF", `bad range end '${endTok.v}'`);
          return { k: "range", a: ref, b: end };
        }
        return { k: "ref", ...ref };
      }
      // bare identifier — resolved at eval time against the LET/LAMBDA scope
      return { k: "name", v: up };
    }
    if (tok.t === "sheetq") {
      const bang = next();
      if (!bang || bang.t !== "!") throw new FormulaError("#ERROR", "expected ! after sheet name");
      return parseSheetRef(tok.v);
    }
    throw new FormulaError("#ERROR", "unexpected token");
  }

  // Sheet-qualified reference: Drivers!A2, 'Sheet 2'!A2:B9 (an optional
  // repeated prefix on the range end is accepted and must match).
  function parseSheetRef(sheetName) {
    const refTok = expect(TOK_ID);
    const a = parseCellRef(refTok.v);
    if (!a) throw new FormulaError("#REF", `bad reference after ${sheetName}!`);
    if (peek() && peek().t === TOK_COLON) {
      next();
      let t2 = next();
      if (t2 && (t2.t === "sheetq" || (t2.t === TOK_ID && peek() && peek().t === "!"))) {
        if (t2.t === TOK_ID) next(); // consume !
        else { const b2 = next(); if (!b2 || b2.t !== "!") throw new FormulaError("#ERROR", "expected !"); }
        t2 = next();
      }
      if (!t2 || t2.t !== TOK_ID) throw new FormulaError("#ERROR", "bad range end");
      const b = parseCellRef(t2.v);
      if (!b) throw new FormulaError("#REF", `bad range end '${t2.v}'`);
      return { k: "range", a, b, sheet: sheetName };
    }
    return { k: "ref", ...a, sheet: sheetName };
  }

  const ast = parseCompare();
  if (p < toks.length) throw new FormulaError("#ERROR", "unexpected trailing input");
  return ast;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

// ── Date serials ─────────────────────────────────────────────────────────────
// Excel-compatible day numbers (days since 1899-12-30), so dates subtract
// and shift like numbers: =C2-B2 is days between, =B2+30 is a month out.

const DATE_EPOCH_UTC = Date.UTC(1899, 11, 30);
function dateToSerial(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - DATE_EPOCH_UTC) / 86400000);
}
function serialToDate(n) {
  const d = new Date(1899, 11, 30);
  d.setDate(d.getDate() + Math.trunc(n));
  return d;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toNum(v) {
  if (v instanceof Arr) v = v.top();
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isClosure(v)) throw new FormulaError("#VALUE", "expected a value, got a LAMBDA");
  const d = typeof v === "string" ? parseDateLoose(v) : null; // dates coerce to serials
  if (d) return dateToSerial(d);
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  if (!isFinite(n)) throw new FormulaError("#VALUE", `'${v}' is not a number`);
  return n;
}

function truthy(v) {
  if (v instanceof Arr) v = v.top();
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v == null || v === "") return false;
  const s = String(v).toUpperCase();
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return true;
}

function cmp(op, a, b) {
  // numeric compare when both coerce; else case-insensitive string compare
  a = deArr(a); b = deArr(b);
  let res;
  const an = typeof a === "number" || (typeof a === "string" && a.trim() !== "" && isFinite(Number(a)));
  const bn = typeof b === "number" || (typeof b === "string" && b.trim() !== "" && isFinite(Number(b)));
  if (an && bn) { const x = Number(a), y = Number(b); res = x < y ? -1 : x > y ? 1 : 0; }
  else {
    // date-aware: "7/10/2026" > "2026-07-01" compares as dates, and a
    // date compares against a plain number as its serial
    const ad = typeof a === "string" ? parseDateLoose(a) : null;
    const bd = typeof b === "string" ? parseDateLoose(b) : null;
    const av = ad ? dateToSerial(ad) : typeof a === "number" ? a : null;
    const bv = bd ? dateToSerial(bd) : typeof b === "number" ? b : null;
    if ((ad || bd) && av != null && bv != null) res = av < bv ? -1 : av > bv ? 1 : 0;
    else { const x = String(a ?? "").toUpperCase(), y = String(b ?? "").toUpperCase(); res = x < y ? -1 : x > y ? 1 : 0; }
  }
  switch (op) {
    case "=": return res === 0;
    case "<>": return res !== 0;
    case "<": return res < 0;
    case "<=": return res <= 0;
    case ">": return res > 0;
    case ">=": return res >= 0;
  }
  throw new FormulaError("#ERROR", "bad comparison");
}

function* rangeCells(a, b) {
  const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
  const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_RANGE_CELLS) throw new FormulaError("#REF", "range too large");
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) yield { row: r, col: c };
}

// Clamp an open-ended range node (A:A, 1:3) to the sheet bounds before
// expansion; bounded ranges pass through untouched.
function boundedRange(node, ctx) {
  let { a, b } = node;
  if (b.row >= OPEN_END || b.col >= OPEN_END) {
    const rowMax = Math.max(0, ((ctx && ctx.rowCount) || 10000) - 1);
    const colMax = Math.max(0, ((ctx && ctx.colCount) || 256) - 1);
    a = { row: Math.min(a.row, rowMax), col: Math.min(a.col, colMax) };
    b = { row: Math.min(b.row, rowMax), col: Math.min(b.col, colMax) };
  }
  return { a, b };
}
function* rangeCellsCtx(node, ctx) {
  const { a, b } = boundedRange(node, ctx);
  yield* rangeCells(a, b);
}

function flatNumeric(vals) {
  const out = [];
  for (const v of vals) {
    if (v == null || v === "") continue;
    if (typeof v === "number") { out.push(v); continue; }
    if (typeof v === "boolean") continue; // Excel: booleans ignored in ranges
    const n = Number(String(v).replace(/[$,\s]/g, ""));
    if (isFinite(n) && String(v).trim() !== "") out.push(n);
  }
  return out;
}

const FUNCS = {
  SUM: (vals) => flatNumeric(vals).reduce((a, b) => a + b, 0),
  AVERAGE: (vals) => { const xs = flatNumeric(vals); if (!xs.length) throw new FormulaError("#DIV/0", "AVERAGE of empty"); return xs.reduce((a, b) => a + b, 0) / xs.length; },
  MIN: (vals) => { const xs = flatNumeric(vals); return xs.length ? Math.min(...xs) : 0; },
  MAX: (vals) => { const xs = flatNumeric(vals); return xs.length ? Math.max(...xs) : 0; },
  COUNT: (vals) => flatNumeric(vals).length,
  MEDIAN: (vals) => { const xs = flatNumeric(vals).sort((a, b) => a - b); if (!xs.length) throw new FormulaError("#DIV/0", "MEDIAN of empty"); const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; },
  COUNTA: (vals) => vals.filter((v) => v != null && v !== "").length,
  ABS: (vals) => Math.abs(toNum(vals[0])),
  INT: (vals) => Math.floor(toNum(vals[0])),
  POWER: (vals) => { const r = Math.pow(toNum(vals[0]), toNum(vals[1])); if (!isFinite(r)) throw new FormulaError("#VALUE", "overflow"); return r; },
  MOD: (vals) => { const d = toNum(vals[1]); if (d === 0) throw new FormulaError("#DIV/0", "MOD by zero"); const a = toNum(vals[0]); return a - d * Math.floor(a / d); },
  SQRT: (vals) => { const n = toNum(vals[0]); if (n < 0) throw new FormulaError("#VALUE", "SQRT of negative"); return Math.sqrt(n); },
  STDEV: (vals) => { const xs = flatNumeric(vals); if (xs.length < 2) throw new FormulaError("#DIV/0", "STDEV needs 2+ numbers"); const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)); },
  COUNTBLANK: (vals) => vals.filter((v) => v == null || v === "").length,
  PROPER: (vals) => fmtScalar(vals[0]).toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (m, p, c) => p + c.toUpperCase()),
  REPT: (vals) => { const n = Math.trunc(toNum(vals[1])); const s = fmtScalar(vals[0]); if (n < 0 || n * s.length > 32767) throw new FormulaError("#VALUE", "REPT too long"); return s.repeat(n); },
  VALUE: (vals) => toNum(vals[0]),
  EXACT: (vals) => fmtScalar(vals[0]) === fmtScalar(vals[1]),
  TRUNC: (vals) => { const d = vals.length > 1 ? Math.trunc(toNum(vals[1])) : 0; const f = Math.pow(10, d); return Math.trunc(toNum(vals[0]) * f) / f; },
  CEILING: (vals) => { const x = toNum(vals[0]); const s = vals.length > 1 ? toNum(vals[1]) : 1; if (s === 0) return 0; return Math.ceil(x / s - 1e-10) * s; },
  FLOOR: (vals) => { const x = toNum(vals[0]); const s = vals.length > 1 ? toNum(vals[1]) : 1; if (s === 0) throw new FormulaError("#DIV/0", "FLOOR by zero"); return Math.floor(x / s + 1e-10) * s; },
  LN: (vals) => { const x = toNum(vals[0]); if (x <= 0) throw new FormulaError("#VALUE", "LN of non-positive"); return Math.log(x); },
  EXP: (vals) => { const r = Math.exp(toNum(vals[0])); if (!isFinite(r)) throw new FormulaError("#VALUE", "overflow"); return r; },
  LOG: (vals) => { const x = toNum(vals[0]); const b = vals.length > 1 ? toNum(vals[1]) : 10; if (x <= 0 || b <= 0 || b === 1) throw new FormulaError("#VALUE", "bad LOG"); return Math.log(x) / Math.log(b); },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: (vals) => { const a = Math.ceil(toNum(vals[0])), b = Math.floor(toNum(vals[1])); if (b < a) throw new FormulaError("#VALUE", "bad RANDBETWEEN range"); return a + Math.floor(Math.random() * (b - a + 1)); },
  XOR: (vals) => vals.filter((v) => truthy(v)).length % 2 === 1,
  // ── math ──
  SIGN: (v) => Math.sign(toNum(v[0])),
  EVEN: (v) => { const x = toNum(v[0]); return x === 0 ? 0 : Math.sign(x) * Math.ceil(Math.abs(x) / 2) * 2; },
  ODD: (v) => { const x = toNum(v[0]); const a = Math.abs(x); const r = a <= 1 ? 1 : Math.ceil((a - 1) / 2) * 2 + 1; return (x < 0 ? -1 : 1) * r; },
  SUMSQ: (v) => flatNumeric(v).reduce((a, b) => a + b * b, 0),
  PRODUCT: (v) => { const xs = flatNumeric(v); return xs.length ? xs.reduce((a, b) => a * b, 1) : 0; },
  QUOTIENT: (v) => { const d = toNum(v[1]); if (d === 0) throw new FormulaError("#DIV/0", "QUOTIENT by zero"); return Math.trunc(toNum(v[0]) / d); },
  GCD: (v) => { const xs = flatNumeric(v).map((x) => Math.trunc(Math.abs(x))); if (!xs.length) return 0; return xs.reduce((a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; }); },
  LCM: (v) => { const xs = flatNumeric(v).map((x) => Math.trunc(Math.abs(x))); const g2 = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; }; return xs.length ? xs.reduce((a, b) => (a && b ? (a / g2(a, b)) * b : 0), 1) : 0; },
  FACT: (v) => { const n = Math.trunc(toNum(v[0])); if (n < 0 || n > 170) throw new FormulaError("#VALUE", "FACT accepts 0-170"); let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
  COMBIN: (v) => { const n = Math.trunc(toNum(v[0])), k = Math.trunc(toNum(v[1])); if (k < 0 || n < 0 || n < k) throw new FormulaError("#VALUE", "bad COMBIN"); let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); },
  SQRTPI: (v) => { const n = toNum(v[0]); if (n < 0) throw new FormulaError("#VALUE", "SQRTPI of negative"); return Math.sqrt(n * Math.PI); },
  MROUND: (v) => { const m = toNum(v[1]); if (m === 0) return 0; return Math.round(toNum(v[0]) / m) * m; },
  SIN: (v) => Math.sin(toNum(v[0])),
  COS: (v) => Math.cos(toNum(v[0])),
  TAN: (v) => Math.tan(toNum(v[0])),
  ASIN: (v) => { const x = toNum(v[0]); if (x < -1 || x > 1) throw new FormulaError("#VALUE", "ASIN domain"); return Math.asin(x); },
  ACOS: (v) => { const x = toNum(v[0]); if (x < -1 || x > 1) throw new FormulaError("#VALUE", "ACOS domain"); return Math.acos(x); },
  ATAN: (v) => Math.atan(toNum(v[0])),
  ATAN2: (v) => Math.atan2(toNum(v[1]), toNum(v[0])), // Excel arg order: (x, y)
  DEGREES: (v) => (toNum(v[0]) * 180) / Math.PI,
  RADIANS: (v) => (toNum(v[0]) * Math.PI) / 180,
  LOG10: (v) => { const x = toNum(v[0]); if (x <= 0) throw new FormulaError("#VALUE", "LOG10 of non-positive"); return Math.log10(x); },
  // ── statistical ──
  AVERAGEA: (v) => { const xs = v.filter((x) => x != null && x !== ""); if (!xs.length) throw new FormulaError("#DIV/0", "AVERAGEA of empty"); return xs.reduce((a, b) => a + (typeof b === "boolean" ? (b ? 1 : 0) : cellNumeric(b) ?? 0), 0) / xs.length; },
  MAXA: (v) => { const xs = v.filter((x) => x != null && x !== "").map((b) => (typeof b === "boolean" ? (b ? 1 : 0) : cellNumeric(b) ?? 0)); return xs.length ? Math.max(...xs) : 0; },
  MINA: (v) => { const xs = v.filter((x) => x != null && x !== "").map((b) => (typeof b === "boolean" ? (b ? 1 : 0) : cellNumeric(b) ?? 0)); return xs.length ? Math.min(...xs) : 0; },
  COUNTUNIQUE: (v) => new Set(v.filter((x) => x != null && x !== "").map((x) => String(x).trim().toLowerCase())).size,
  MODE: (v) => { const xs = flatNumeric(v); const seen = new Map(); let best = null, bestN = 1; for (const x of xs) { const n = (seen.get(x) || 0) + 1; seen.set(x, n); if (n > bestN) { bestN = n; best = x; } } if (best == null) throw new FormulaError("#N/A", "no repeated value"); return best; },
  VAR: (v) => { const xs = flatNumeric(v); if (xs.length < 2) throw new FormulaError("#DIV/0", "VAR needs 2+ numbers"); const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1); },
  VARP: (v) => { const xs = flatNumeric(v); if (!xs.length) throw new FormulaError("#DIV/0", "VARP of empty"); const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length; },
  STDEVP: (v) => { const xs = flatNumeric(v); if (!xs.length) throw new FormulaError("#DIV/0", "STDEVP of empty"); const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length); },
  GEOMEAN: (v) => { const xs = flatNumeric(v); if (!xs.length || xs.some((x) => x <= 0)) throw new FormulaError("#VALUE", "GEOMEAN needs positive numbers"); return Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length); },
  HARMEAN: (v) => { const xs = flatNumeric(v); if (!xs.length || xs.some((x) => x <= 0)) throw new FormulaError("#VALUE", "HARMEAN needs positive numbers"); return xs.length / xs.reduce((a, b) => a + 1 / b, 0); },
  PERCENTILE: (v) => { const p = toNum(v[v.length - 1]); const xs = flatNumeric(v.slice(0, -1)).sort((a, b) => a - b); if (!xs.length || p < 0 || p > 1) throw new FormulaError("#VALUE", "bad PERCENTILE"); const i = (xs.length - 1) * p; const lo = Math.floor(i); return xs[lo] + (xs[Math.min(lo + 1, xs.length - 1)] - xs[lo]) * (i - lo); },
  QUARTILE: (v) => { const q = Math.trunc(toNum(v[v.length - 1])); if (q < 0 || q > 4) throw new FormulaError("#VALUE", "QUARTILE 0-4"); return FUNCS.PERCENTILE([...v.slice(0, -1), q / 4]); },
  // ── text ──
  CHAR: (v) => { const n = Math.trunc(toNum(v[0])); if (n < 1 || n > 1114111) throw new FormulaError("#VALUE", "bad CHAR code"); return String.fromCodePoint(n); },
  CODE: (v) => { const s = fmtScalar(v[0]); if (!s) throw new FormulaError("#VALUE", "CODE of empty"); return s.codePointAt(0); },
  CLEAN: (v) => fmtScalar(v[0]).replace(/[\x00-\x1F\x7F]/g, ""),
  DOLLAR: (v) => { const n = toNum(v[0]); const d = v.length > 1 ? Math.trunc(toNum(v[1])) : 2; const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: Math.max(0, d), maximumFractionDigits: Math.max(0, d) }); return n < 0 ? `($${abs})` : `$${abs}`; },
  FIXED: (v) => { const n = toNum(v[0]); const d = v.length > 1 ? Math.trunc(toNum(v[1])) : 2; const noCommas = v.length > 2 && truthy(v[2]); return noCommas ? n.toFixed(Math.max(0, d)) : n.toLocaleString("en-US", { minimumFractionDigits: Math.max(0, d), maximumFractionDigits: Math.max(0, d) }); },
  JOIN: (v) => v.slice(1).map(fmtScalar).join(fmtScalar(v[0])),
  REPLACE: (v) => { const s = fmtScalar(v[0]); const start = Math.trunc(toNum(v[1])); const len = Math.trunc(toNum(v[2])); if (start < 1 || len < 0) throw new FormulaError("#VALUE", "bad REPLACE bounds"); return s.slice(0, start - 1) + fmtScalar(v[3]) + s.slice(start - 1 + len); },
  T: (v) => (typeof v[0] === "string" ? v[0] : ""),
  // ── info ──
  N: (v) => (typeof v[0] === "number" ? v[0] : typeof v[0] === "boolean" ? (v[0] ? 1 : 0) : 0),
  NA: () => { throw new FormulaError("#N/A", "NA()"); },
  ISEVEN: (v) => Math.trunc(toNum(v[0])) % 2 === 0,
  ISODD: (v) => Math.abs(Math.trunc(toNum(v[0]))) % 2 === 1,
  ISDATE: (v) => typeof v[0] === "string" && !!parseDateLoose(v[0]),
  ISLOGICAL: (v) => typeof v[0] === "boolean",
  ISNONTEXT: (v) => !(typeof v[0] === "string" && v[0] !== ""),
  // ── date basis + time-of-day ──
  DAYS360: (v) => {
    const a = serialToDate(toNum(v[0])), b = serialToDate(toNum(v[1]));
    let d1 = Math.min(a.getDate(), 30), d2 = b.getDate();
    if (d2 === 31 && d1 === 30) d2 = 30;
    return (b.getFullYear() - a.getFullYear()) * 360 + (b.getMonth() - a.getMonth()) * 30 + (d2 - d1);
  },
  YEARFRAC: (v) => {
    const basis = v.length > 2 ? Math.trunc(toNum(v[2])) : 0;
    const s1 = toNum(v[0]), s2 = toNum(v[1]);
    if (basis === 2) return (s2 - s1) / 360;
    if (basis === 3) return (s2 - s1) / 365;
    return FUNCS.DAYS360([v[0], v[1]]) / 360; // 30/360 default (basis 0)
  },
  ISOWEEKNUM: (v) => {
    const d = serialToDate(toNum(v[0]));
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // Thursday of this ISO week
    const jan4 = new Date(t.getFullYear(), 0, 4);
    jan4.setDate(jan4.getDate() + 3 - ((jan4.getDay() + 6) % 7));
    return 1 + Math.round((t - jan4) / (7 * 86400000));
  },
  HOUR: (v) => { const f = timeFracOf(v[0]); if (f == null) throw new FormulaError("#VALUE", "not a time"); return Math.floor(f * 24); },
  MINUTE: (v) => { const f = timeFracOf(v[0]); if (f == null) throw new FormulaError("#VALUE", "not a time"); return Math.floor(f * 1440) % 60; },
  SECOND: (v) => { const f = timeFracOf(v[0]); if (f == null) throw new FormulaError("#VALUE", "not a time"); return Math.round(f * 86400) % 60; },
  TIMEVALUE: (v) => { const f = timeFracOf(v[0]); if (f == null) throw new FormulaError("#VALUE", "not a time"); return f; },
  // ── financial ──
  PMT: (v) => {
    const r = toNum(v[0]), n = toNum(v[1]), pv = toNum(v[2]), fv = v.length > 3 ? toNum(v[3]) : 0, type = v.length > 4 && truthy(v[4]) ? 1 : 0;
    if (n === 0) throw new FormulaError("#DIV/0", "PMT with 0 periods");
    if (r === 0) return -(pv + fv) / n;
    const k = Math.pow(1 + r, n);
    return (-(pv * k + fv) * r) / ((k - 1) * (1 + r * type));
  },
  FV: (v) => {
    const r = toNum(v[0]), n = toNum(v[1]), pmt = toNum(v[2]), pv = v.length > 3 ? toNum(v[3]) : 0, type = v.length > 4 && truthy(v[4]) ? 1 : 0;
    if (r === 0) return -(pv + pmt * n);
    const k = Math.pow(1 + r, n);
    return -(pv * k + (pmt * (1 + r * type) * (k - 1)) / r);
  },
  PV: (v) => {
    const r = toNum(v[0]), n = toNum(v[1]), pmt = toNum(v[2]), fv = v.length > 3 ? toNum(v[3]) : 0, type = v.length > 4 && truthy(v[4]) ? 1 : 0;
    if (r === 0) return -(fv + pmt * n);
    const k = Math.pow(1 + r, n);
    return -((fv + (pmt * (1 + r * type) * (k - 1)) / r) / k);
  },
  NPER: (v) => {
    const r = toNum(v[0]), pmt = toNum(v[1]), pv = toNum(v[2]), fv = v.length > 3 ? toNum(v[3]) : 0, type = v.length > 4 && truthy(v[4]) ? 1 : 0;
    if (r === 0) { if (pmt === 0) throw new FormulaError("#DIV/0", "NPER"); return -(pv + fv) / pmt; }
    const a = pmt * (1 + r * type);
    const x = (a - fv * r) / (pv * r + a);
    if (x <= 0) throw new FormulaError("#VALUE", "NPER has no solution");
    return Math.log(x) / Math.log(1 + r);
  },
  SLN: (v) => { const life = toNum(v[2]); if (life === 0) throw new FormulaError("#DIV/0", "SLN life"); return (toNum(v[0]) - toNum(v[1])) / life; },
  EFFECT: (v) => { const n = Math.trunc(toNum(v[1])); if (n < 1) throw new FormulaError("#VALUE", "EFFECT periods"); return Math.pow(1 + toNum(v[0]) / n, n) - 1; },
  NOMINAL: (v) => { const n = Math.trunc(toNum(v[1])); if (n < 1) throw new FormulaError("#VALUE", "NOMINAL periods"); return (Math.pow(1 + toNum(v[0]), 1 / n) - 1) * n; },
  // ── operator functions (Sheets parity) ──
  ADD: (v) => toNum(v[0]) + toNum(v[1]),
  MINUS: (v) => toNum(v[0]) - toNum(v[1]),
  MULTIPLY: (v) => toNum(v[0]) * toNum(v[1]),
  DIVIDE: (v) => { const d = toNum(v[1]); if (d === 0) throw new FormulaError("#DIV/0", "DIVIDE by zero"); return toNum(v[0]) / d; },
  POW: (v) => FUNCS.POWER(v),
  UMINUS: (v) => -toNum(v[0]),
  UNARY_PERCENT: (v) => toNum(v[0]) / 100,
  EQ: (v) => cmp("=", v[0] ?? "", v[1] ?? ""),
  NE: (v) => cmp("<>", v[0] ?? "", v[1] ?? ""),
  GT: (v) => cmp(">", v[0] ?? "", v[1] ?? ""),
  GTE: (v) => cmp(">=", v[0] ?? "", v[1] ?? ""),
  LT: (v) => cmp("<", v[0] ?? "", v[1] ?? ""),
  LTE: (v) => cmp("<=", v[0] ?? "", v[1] ?? ""),
};

// ═══ Google Sheets function-list parity ══════════════════════════════════════
// Everything below fills out the published Sheets function list
// (support.google.com/docs/table/25273). Excluded by design: functions
// that call Google services or fetch external data (GOOGLEFINANCE,
// GOOGLETRANSLATE, DETECTLANGUAGE, IMAGE, SPARKLINE, QUERY, IMPORT*)
// and GETPIVOTDATA (no pivot tables). Array-returning functions work
// as in-formula values; a bare array result displays its top-left cell.

// ── Numerics core (special functions for the statistical family) ───────────
// Standard machinery: Lanczos log-gamma, regularized incomplete gamma
// (series + continued fraction), regularized incomplete beta, erf via
// incomplete gamma, Acklam's inverse normal. Accuracy ~1e-10 or better
// across the ranges a spreadsheet sees.

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lnGamma(x) {
  if (!isFinite(x)) throw new FormulaError("#NUM", "gamma domain");
  if (x < 0.5) {
    const s = Math.sin(Math.PI * x);
    if (s === 0) throw new FormulaError("#NUM", "gamma pole");
    return Math.log(Math.PI / Math.abs(s)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function gammaFn(x) {
  if (x <= 0 && Number.isInteger(x)) throw new FormulaError("#NUM", "GAMMA pole");
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  const g = Math.exp(lnGamma(x));
  if (!isFinite(g)) throw new FormulaError("#NUM", "GAMMA overflow");
  return g;
}
// regularized lower incomplete gamma P(a, x)
function lowerGammaP(a, x) {
  if (a <= 0 || x < 0) throw new FormulaError("#NUM", "gamma domain");
  if (x === 0) return 0;
  if (x < a + 1) { // series
    let ap = a, sum = 1 / a, del = sum;
    for (let i = 0; i < 500; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, Math.max(0, sum * Math.exp(-x + a * Math.log(x) - lnGamma(a))));
  }
  // continued fraction (Lentz) for Q, then P = 1 - Q
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.min(1, Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h));
}
function betaCF(a, b, x) {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}
// regularized incomplete beta I_x(a, b)
function regIncBeta(a, b, x) {
  if (a <= 0 || b <= 0) throw new FormulaError("#NUM", "beta domain");
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaCF(a, b, x)) / a : 1 - (bt * betaCF(b, a, 1 - x)) / b;
}
function erfFn(x) { return x === 0 ? 0 : Math.sign(x) * lowerGammaP(0.5, x * x); }
function erfcFn(x) { return 1 - erfFn(x); }
function normSCdf(z) { return z < 0 ? 0.5 * (1 - erfFn(-z / Math.SQRT2)) : 0.5 * (1 + erfFn(z / Math.SQRT2)); }
function normSPdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
// Acklam's inverse normal CDF + one Halley refinement
function normSInv(p) {
  if (!(p > 0 && p < 1)) throw new FormulaError("#NUM", "probability must be in (0,1)");
  const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - plow) {
    const q = p - 0.5, r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  const e = normSCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
// invert a monotone-increasing CDF by bisection over [lo, hi]
function invMonotone(cdf, p, lo, hi) {
  let flo = cdf(lo), fhi = cdf(hi);
  for (let i = 0; i < 80 && fhi < p; i++) { hi = lo + (hi - lo) * 2; fhi = cdf(hi); }
  for (let i = 0; i < 80 && flo > p; i++) { lo = hi - (hi - lo) * 2; flo = cdf(lo); }
  if (flo > p || fhi < p) throw new FormulaError("#NUM", "no solution");
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid; else hi = mid;
    if (hi - lo < Math.max(1e-13, Math.abs(hi) * 1e-13)) break;
  }
  return (lo + hi) / 2;
}

// small stat helpers over flattened numeric lists
function statNums(v, what) { const xs = flatNumeric(v); if (!xs.length) throw new FormulaError("#DIV/0", `${what || "statistic"} of empty range`); return xs; }
function meanOf(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function varSOf(xs) { if (xs.length < 2) throw new FormulaError("#DIV/0", "needs 2+ numbers"); const m = meanOf(xs); return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1); }
function varPOf(xs) { const m = meanOf(xs); return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length; }
// A-variant coercion: text → 0, booleans count (STDEVA / VARA / …)
function aNums(v) { return v.filter((x) => x != null && x !== "").map((x) => (typeof x === "boolean" ? (x ? 1 : 0) : cellNumeric(x) ?? 0)); }
function pctlInc(xs, p) { if (!xs.length || p < 0 || p > 1) throw new FormulaError("#NUM", "bad percentile"); const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); }
function pctlExc(xs, p) { const n = xs.length; if (!n) throw new FormulaError("#NUM", "empty range"); if (p < 1 / (n + 1) || p > n / (n + 1)) throw new FormulaError("#NUM", "percentile out of range"); const s = [...xs].sort((a, b) => a - b); const i = (n + 1) * p - 1; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, n - 1)] - s[lo]) * (i - lo); }
function linFit(known_y, known_x) {
  const { xs, ys } = numericPairs(known_x, known_y);
  if (xs.length < 2) throw new FormulaError("#DIV/0", "need 2+ data points");
  const mx = meanOf(xs), my = meanOf(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx === 0) throw new FormulaError("#DIV/0", "x values are constant");
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, xs, ys, mx, my, sxx, sxy };
}

Object.assign(FUNCS, {
  // ── math: hyperbolic + reciprocal trig ──
  SINH: (v) => Math.sinh(toNum(v[0])),
  COSH: (v) => Math.cosh(toNum(v[0])),
  TANH: (v) => Math.tanh(toNum(v[0])),
  ASINH: (v) => Math.asinh(toNum(v[0])),
  ACOSH: (v) => { const x = toNum(v[0]); if (x < 1) throw new FormulaError("#NUM", "ACOSH domain"); return Math.acosh(x); },
  ATANH: (v) => { const x = toNum(v[0]); if (x <= -1 || x >= 1) throw new FormulaError("#NUM", "ATANH domain"); return Math.atanh(x); },
  COT: (v) => { const t = Math.tan(toNum(v[0])); if (t === 0) throw new FormulaError("#DIV/0", "COT undefined"); return 1 / t; },
  COTH: (v) => { const t = Math.tanh(toNum(v[0])); if (t === 0) throw new FormulaError("#DIV/0", "COTH undefined"); return 1 / t; },
  ACOT: (v) => { const x = toNum(v[0]); const a = Math.atan(1 / x); return x < 0 ? a + Math.PI : x === 0 ? Math.PI / 2 : a; },
  ACOTH: (v) => { const x = toNum(v[0]); if (Math.abs(x) <= 1) throw new FormulaError("#NUM", "ACOTH domain"); return Math.atanh(1 / x); },
  CSC: (v) => { const s = Math.sin(toNum(v[0])); if (s === 0) throw new FormulaError("#DIV/0", "CSC undefined"); return 1 / s; },
  CSCH: (v) => { const s = Math.sinh(toNum(v[0])); if (s === 0) throw new FormulaError("#DIV/0", "CSCH undefined"); return 1 / s; },
  SEC: (v) => { const c = Math.cos(toNum(v[0])); if (c === 0) throw new FormulaError("#DIV/0", "SEC undefined"); return 1 / c; },
  SECH: (v) => 1 / Math.cosh(toNum(v[0])),
  // ── math: rounding family ──
  "CEILING.MATH": (v) => {
    const x = toNum(v[0]); const sig = Math.abs(v.length > 1 ? toNum(v[1]) : 1); const mode = v.length > 2 ? toNum(v[2]) : 0;
    if (sig === 0) return 0;
    if (x >= 0 || mode === 0) return Math.ceil(x / sig - 1e-10) * sig;
    return -Math.ceil(Math.abs(x) / sig - 1e-10) * sig; // negatives round away from zero
  },
  "FLOOR.MATH": (v) => {
    const x = toNum(v[0]); const sig = Math.abs(v.length > 1 ? toNum(v[1]) : 1); const mode = v.length > 2 ? toNum(v[2]) : 0;
    if (sig === 0) return 0;
    if (x >= 0 || mode === 0) return Math.floor(x / sig + 1e-10) * sig;
    return -Math.floor(Math.abs(x) / sig + 1e-10) * sig; // negatives round toward zero
  },
  "CEILING.PRECISE": (v) => { const x = toNum(v[0]); const sig = Math.abs(v.length > 1 ? toNum(v[1]) : 1); if (sig === 0) return 0; return Math.ceil(x / sig - 1e-10) * sig; },
  "FLOOR.PRECISE": (v) => { const x = toNum(v[0]); const sig = Math.abs(v.length > 1 ? toNum(v[1]) : 1); if (sig === 0) return 0; return Math.floor(x / sig + 1e-10) * sig; },
  "ISO.CEILING": (v) => FUNCS["CEILING.PRECISE"](v),
  // ── math: combinatorics + series ──
  COMBINA: (v) => { const n = Math.trunc(toNum(v[0])), k = Math.trunc(toNum(v[1])); if (n < 0 || k < 0 || (n === 0 && k > 0)) throw new FormulaError("#NUM", "bad COMBINA"); return FUNCS.COMBIN([n + k - 1, k]); },
  FACTDOUBLE: (v) => { const n = Math.trunc(toNum(v[0])); if (n < -1 || n > 300) throw new FormulaError("#NUM", "FACTDOUBLE accepts -1 to 300"); let r = 1; for (let i = n; i > 1; i -= 2) r *= i; if (!isFinite(r)) throw new FormulaError("#NUM", "overflow"); return r; },
  MULTINOMIAL: (v) => { const xs = flatNumeric(v).map((x) => Math.trunc(x)); if (!xs.length || xs.some((x) => x < 0)) throw new FormulaError("#NUM", "bad MULTINOMIAL"); const total = xs.reduce((a, b) => a + b, 0); let r = lnGamma(total + 1); for (const x of xs) r -= lnGamma(x + 1); return Math.round(Math.exp(r)); },
  SERIESSUM: (v, h) => {
    const x = toNum(deArr(evalNode(h.args[0], h.ctx))), n = toNum(deArr(evalNode(h.args[1], h.ctx))), m = toNum(deArr(evalNode(h.args[2], h.ctx)));
    const coeffs = flatNumeric(argGrid(h.args[3], h.ctx).flat());
    let total = 0;
    for (let i = 0; i < coeffs.length; i++) total += coeffs[i] * Math.pow(x, n + i * m);
    if (!isFinite(total)) throw new FormulaError("#NUM", "SERIESSUM overflow");
    return total;
  },
  GAMMALN: (v) => { const x = toNum(v[0]); if (x <= 0) throw new FormulaError("#NUM", "GAMMALN domain"); return lnGamma(x); },
  "GAMMALN.PRECISE": (v) => FUNCS.GAMMALN(v),
  BASE: (v) => {
    const n = Math.trunc(toNum(v[0])), radix = Math.trunc(toNum(v[1])), minLen = v.length > 2 ? Math.trunc(toNum(v[2])) : 0;
    if (n < 0 || radix < 2 || radix > 36 || minLen < 0 || minLen > 255) throw new FormulaError("#NUM", "bad BASE");
    return n.toString(radix).toUpperCase().padStart(minLen, "0");
  },
  DECIMAL: (v) => {
    const s = fmtScalar(v[0]).trim().toUpperCase();
    const radix = Math.trunc(toNum(v[1]));
    if (radix < 2 || radix > 36 || !s) throw new FormulaError("#NUM", "bad DECIMAL");
    let r = 0;
    for (const ch of s) {
      const d = parseInt(ch, 36);
      if (isNaN(d) || d >= radix) throw new FormulaError("#NUM", `'${ch}' is not a base-${radix} digit`);
      r = r * radix + d;
    }
    return r;
  },
  SUBTOTAL: (v) => {
    const code = Math.trunc(toNum(v[0])) % 100; // 101-111 behave like 1-11 (no hidden-row info in the engine)
    const rest = v.slice(1);
    const table = { 1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 7: "STDEV", 8: "STDEVP", 9: "SUM", 10: "VAR", 11: "VARP" };
    const fname = table[code];
    if (!fname) throw new FormulaError("#VALUE", "SUBTOTAL code must be 1-11 or 101-111");
    return FUNCS[fname](rest);
  },
  // ── statistical: descriptive ──
  AVEDEV: (v) => { const xs = statNums(v, "AVEDEV"); const m = meanOf(xs); return xs.reduce((a, b) => a + Math.abs(b - m), 0) / xs.length; },
  DEVSQ: (v) => { const xs = statNums(v, "DEVSQ"); const m = meanOf(xs); return xs.reduce((a, b) => a + (b - m) * (b - m), 0); },
  KURT: (v) => {
    const xs = statNums(v, "KURT"); const n = xs.length;
    if (n < 4) throw new FormulaError("#DIV/0", "KURT needs 4+ numbers");
    const m = meanOf(xs), s = Math.sqrt(varSOf(xs));
    if (s === 0) throw new FormulaError("#DIV/0", "KURT of constant data");
    const s4 = xs.reduce((a, b) => a + Math.pow((b - m) / s, 4), 0);
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s4 - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  },
  SKEW: (v) => {
    const xs = statNums(v, "SKEW"); const n = xs.length;
    if (n < 3) throw new FormulaError("#DIV/0", "SKEW needs 3+ numbers");
    const m = meanOf(xs), s = Math.sqrt(varSOf(xs));
    if (s === 0) throw new FormulaError("#DIV/0", "SKEW of constant data");
    return (n / ((n - 1) * (n - 2))) * xs.reduce((a, b) => a + Math.pow((b - m) / s, 3), 0);
  },
  "SKEW.P": (v) => {
    const xs = statNums(v, "SKEW.P"); const n = xs.length;
    const m = meanOf(xs), s = Math.sqrt(varPOf(xs));
    if (s === 0) throw new FormulaError("#DIV/0", "SKEW.P of constant data");
    return xs.reduce((a, b) => a + Math.pow((b - m) / s, 3), 0) / n;
  },
  TRIMMEAN: (v) => {
    const p = toNum(v[v.length - 1]);
    if (p < 0 || p >= 1) throw new FormulaError("#NUM", "TRIMMEAN percent must be in [0,1)");
    const xs = statNums(v.slice(0, -1), "TRIMMEAN").sort((a, b) => a - b);
    const drop = Math.floor((xs.length * p) / 2);
    const kept = xs.slice(drop, xs.length - drop);
    if (!kept.length) throw new FormulaError("#NUM", "TRIMMEAN removed everything");
    return meanOf(kept);
  },
  "STDEV.S": (v) => FUNCS.STDEV(v),
  "STDEV.P": (v) => FUNCS.STDEVP(v),
  "VAR.S": (v) => FUNCS.VAR(v),
  "VAR.P": (v) => FUNCS.VARP(v),
  STDEVA: (v) => { const xs = aNums(v); if (xs.length < 2) throw new FormulaError("#DIV/0", "STDEVA needs 2+ values"); return Math.sqrt(varSOf(xs)); },
  STDEVPA: (v) => { const xs = aNums(v); if (!xs.length) throw new FormulaError("#DIV/0", "STDEVPA of empty"); return Math.sqrt(varPOf(xs)); },
  VARA: (v) => { const xs = aNums(v); if (xs.length < 2) throw new FormulaError("#DIV/0", "VARA needs 2+ values"); return varSOf(xs); },
  VARPA: (v) => { const xs = aNums(v); if (!xs.length) throw new FormulaError("#DIV/0", "VARPA of empty"); return varPOf(xs); },
  "MODE.SNGL": (v) => FUNCS.MODE(v),
  "PERCENTILE.INC": (v) => FUNCS.PERCENTILE(v),
  "PERCENTILE.EXC": (v) => { const p = toNum(v[v.length - 1]); return pctlExc(statNums(v.slice(0, -1), "PERCENTILE.EXC"), p); },
  "QUARTILE.INC": (v) => FUNCS.QUARTILE(v),
  "QUARTILE.EXC": (v) => { const q = Math.trunc(toNum(v[v.length - 1])); if (q < 1 || q > 3) throw new FormulaError("#NUM", "QUARTILE.EXC takes 1-3"); return pctlExc(statNums(v.slice(0, -1), "QUARTILE.EXC"), q / 4); },
  PERCENTRANK: (v, h) => FUNCS["PERCENTRANK.INC"](v, h),
  "PERCENTRANK.INC": (v, h) => pctRank(h, false),
  "PERCENTRANK.EXC": (v, h) => pctRank(h, true),
  "RANK.EQ": (v, h) => callFunc({ name: "RANK", args: h.args }, h.ctx),
  "RANK.AVG": (v, h) => {
    const x = toNum(deArr(evalNode(h.args[0], h.ctx)));
    const xs = flatNumeric(argGrid(h.args[1], h.ctx).flat());
    if (!xs.includes(x)) throw new FormulaError("#N/A", "value not in range");
    const asc = h.args.length > 2 && truthy(deArr(evalNode(h.args[2], h.ctx)));
    const better = xs.filter((y) => (asc ? y < x : y > x)).length;
    const ties = xs.filter((y) => y === x).length;
    return better + (ties + 1) / 2;
  },
  PERMUT: (v) => { const n = Math.trunc(toNum(v[0])), k = Math.trunc(toNum(v[1])); if (n < 0 || k < 0 || k > n) throw new FormulaError("#NUM", "bad PERMUT"); const r = Math.round(Math.exp(lnGamma(n + 1) - lnGamma(n - k + 1))); if (!isFinite(r)) throw new FormulaError("#NUM", "overflow"); return r; },
  PERMUTATIONA: (v) => { const n = Math.trunc(toNum(v[0])), k = Math.trunc(toNum(v[1])); if (n < 0 || k < 0) throw new FormulaError("#NUM", "bad PERMUTATIONA"); const r = Math.pow(n, k); if (!isFinite(r)) throw new FormulaError("#NUM", "overflow"); return r; },
  STANDARDIZE: (v) => { const s = toNum(v[2]); if (s <= 0) throw new FormulaError("#NUM", "stdev must be positive"); return (toNum(v[0]) - toNum(v[1])) / s; },
  FISHER: (v) => { const x = toNum(v[0]); if (x <= -1 || x >= 1) throw new FormulaError("#NUM", "FISHER domain"); return Math.atanh(x); },
  FISHERINV: (v) => Math.tanh(toNum(v[0])),
  GAUSS: (v) => normSCdf(toNum(v[0])) - 0.5,
  PHI: (v) => normSPdf(toNum(v[0])),
  GAMMA: (v) => gammaFn(toNum(v[0])),
  CONFIDENCE: (v) => FUNCS["CONFIDENCE.NORM"](v),
  "CONFIDENCE.NORM": (v) => {
    const alpha = toNum(v[0]), sd = toNum(v[1]), n = Math.trunc(toNum(v[2]));
    if (alpha <= 0 || alpha >= 1 || sd <= 0 || n < 1) throw new FormulaError("#NUM", "bad CONFIDENCE");
    return normSInv(1 - alpha / 2) * (sd / Math.sqrt(n));
  },
  "CONFIDENCE.T": (v) => {
    const alpha = toNum(v[0]), sd = toNum(v[1]), n = Math.trunc(toNum(v[2]));
    if (alpha <= 0 || alpha >= 1 || sd <= 0 || n < 2) throw new FormulaError("#NUM", "bad CONFIDENCE.T");
    const df = n - 1;
    const t = invMonotone((x) => tCdf(x, df), 1 - alpha / 2, 0, 50);
    return t * (sd / Math.sqrt(n));
  },
  // ── statistical: distributions (normal / lognormal) ──
  "NORM.DIST": (v) => {
    const x = toNum(v[0]), mu = toNum(v[1]), sd = toNum(v[2]), cum = truthy(v[3]);
    if (sd <= 0) throw new FormulaError("#NUM", "stdev must be positive");
    return cum ? normSCdf((x - mu) / sd) : normSPdf((x - mu) / sd) / sd;
  },
  NORMDIST: (v) => FUNCS["NORM.DIST"](v),
  "NORM.S.DIST": (v) => { const z = toNum(v[0]); const cum = v.length > 1 ? truthy(v[1]) : true; return cum ? normSCdf(z) : normSPdf(z); },
  NORMSDIST: (v) => normSCdf(toNum(v[0])),
  "NORM.INV": (v) => { const p = toNum(v[0]), mu = toNum(v[1]), sd = toNum(v[2]); if (sd <= 0) throw new FormulaError("#NUM", "stdev must be positive"); return mu + sd * normSInv(p); },
  NORMINV: (v) => FUNCS["NORM.INV"](v),
  "NORM.S.INV": (v) => normSInv(toNum(v[0])),
  NORMSINV: (v) => normSInv(toNum(v[0])),
  "LOGNORM.DIST": (v) => {
    const x = toNum(v[0]), mu = toNum(v[1]), sd = toNum(v[2]); const cum = v.length > 3 ? truthy(v[3]) : true;
    if (x <= 0 || sd <= 0) throw new FormulaError("#NUM", "LOGNORM domain");
    return cum ? normSCdf((Math.log(x) - mu) / sd) : normSPdf((Math.log(x) - mu) / sd) / (x * sd);
  },
  LOGNORMDIST: (v) => FUNCS["LOGNORM.DIST"]([v[0], v[1], v[2], true]),
  "LOGNORM.INV": (v) => { const p = toNum(v[0]), mu = toNum(v[1]), sd = toNum(v[2]); if (sd <= 0) throw new FormulaError("#NUM", "LOGNORM domain"); return Math.exp(mu + sd * normSInv(p)); },
  LOGINV: (v) => FUNCS["LOGNORM.INV"](v),
  // ── statistical: t / chi-square / F ──
  "T.DIST": (v) => {
    const x = toNum(v[0]), df = Math.trunc(toNum(v[1])), cum = truthy(v[2]);
    if (df < 1) throw new FormulaError("#NUM", "bad df");
    if (cum) return tCdf(x, df);
    return Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2)) / Math.sqrt(df * Math.PI) * Math.pow(1 + (x * x) / df, -(df + 1) / 2);
  },
  "T.DIST.RT": (v) => 1 - tCdf(toNum(v[0]), Math.trunc(toNum(v[1]))),
  "T.DIST.2T": (v) => { const x = toNum(v[0]); if (x < 0) throw new FormulaError("#NUM", "T.DIST.2T needs x ≥ 0"); return 2 * (1 - tCdf(x, Math.trunc(toNum(v[1])))); },
  TDIST: (v) => {
    const x = toNum(v[0]), df = Math.trunc(toNum(v[1])), tails = Math.trunc(toNum(v[2]));
    if (x < 0 || df < 1 || (tails !== 1 && tails !== 2)) throw new FormulaError("#NUM", "bad TDIST");
    const rt = 1 - tCdf(x, df);
    return tails === 1 ? rt : 2 * rt;
  },
  "T.INV": (v) => { const p = toNum(v[0]), df = Math.trunc(toNum(v[1])); if (p <= 0 || p >= 1 || df < 1) throw new FormulaError("#NUM", "bad T.INV"); return invMonotone((x) => tCdf(x, df), p, -1e4, 1e4); },
  "T.INV.2T": (v) => { const p = toNum(v[0]), df = Math.trunc(toNum(v[1])); if (p <= 0 || p > 1 || df < 1) throw new FormulaError("#NUM", "bad T.INV.2T"); return invMonotone((x) => tCdf(x, df), 1 - p / 2, 0, 1e4); },
  TINV: (v) => FUNCS["T.INV.2T"](v),
  "CHISQ.DIST": (v) => {
    const x = toNum(v[0]), df = Math.trunc(toNum(v[1])), cum = truthy(v[2]);
    if (x < 0 || df < 1) throw new FormulaError("#NUM", "bad CHISQ.DIST");
    if (cum) return lowerGammaP(df / 2, x / 2);
    return x === 0 ? (df === 2 ? 0.5 : df < 2 ? Infinity : 0) : Math.exp((df / 2 - 1) * Math.log(x) - x / 2 - lnGamma(df / 2) - (df / 2) * Math.LN2);
  },
  "CHISQ.DIST.RT": (v) => { const x = toNum(v[0]), df = Math.trunc(toNum(v[1])); if (x < 0 || df < 1) throw new FormulaError("#NUM", "bad CHISQ.DIST.RT"); return 1 - lowerGammaP(df / 2, x / 2); },
  CHIDIST: (v) => FUNCS["CHISQ.DIST.RT"](v),
  "CHISQ.INV": (v) => { const p = toNum(v[0]), df = Math.trunc(toNum(v[1])); if (p < 0 || p >= 1 || df < 1) throw new FormulaError("#NUM", "bad CHISQ.INV"); if (p === 0) return 0; return invMonotone((x) => lowerGammaP(df / 2, x / 2), p, 0, df * 10 + 10); },
  "CHISQ.INV.RT": (v) => FUNCS["CHISQ.INV"]([1 - toNum(v[0]), v[1]]),
  CHIINV: (v) => FUNCS["CHISQ.INV.RT"](v),
  "F.DIST": (v) => {
    const x = toNum(v[0]), d1 = Math.trunc(toNum(v[1])), d2 = Math.trunc(toNum(v[2])), cum = truthy(v[3]);
    if (x < 0 || d1 < 1 || d2 < 1) throw new FormulaError("#NUM", "bad F.DIST");
    const c = (d1 * x) / (d1 * x + d2);
    if (cum) return regIncBeta(d1 / 2, d2 / 2, c);
    return Math.exp((d1 / 2) * Math.log(d1) + (d2 / 2) * Math.log(d2) + (d1 / 2 - 1) * Math.log(x) - ((d1 + d2) / 2) * Math.log(d2 + d1 * x) + lnGamma((d1 + d2) / 2) - lnGamma(d1 / 2) - lnGamma(d2 / 2));
  },
  "F.DIST.RT": (v) => { const x = toNum(v[0]), d1 = Math.trunc(toNum(v[1])), d2 = Math.trunc(toNum(v[2])); if (x < 0 || d1 < 1 || d2 < 1) throw new FormulaError("#NUM", "bad F.DIST.RT"); return 1 - regIncBeta(d1 / 2, d2 / 2, (d1 * x) / (d1 * x + d2)); },
  FDIST: (v) => FUNCS["F.DIST.RT"](v),
  "F.INV": (v) => { const p = toNum(v[0]), d1 = Math.trunc(toNum(v[1])), d2 = Math.trunc(toNum(v[2])); if (p <= 0 || p >= 1 || d1 < 1 || d2 < 1) throw new FormulaError("#NUM", "bad F.INV"); return invMonotone((x) => regIncBeta(d1 / 2, d2 / 2, (d1 * x) / (d1 * x + d2)), p, 0, 1000); },
  "F.INV.RT": (v) => FUNCS["F.INV"]([1 - toNum(v[0]), v[1], v[2]]),
  FINV: (v) => FUNCS["F.INV.RT"](v),
  // ── statistical: beta / gamma / exponential / weibull ──
  "BETA.DIST": (v) => {
    const x = toNum(v[0]), a = toNum(v[1]), b = toNum(v[2]);
    const cum = v.length > 3 ? truthy(v[3]) : true;
    const A = v.length > 4 ? toNum(v[4]) : 0, B = v.length > 5 ? toNum(v[5]) : 1;
    if (a <= 0 || b <= 0 || B <= A || x < A || x > B) throw new FormulaError("#NUM", "bad BETA.DIST");
    const t = (x - A) / (B - A);
    if (cum) return regIncBeta(a, b, t);
    return Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + (a - 1) * Math.log(t) + (b - 1) * Math.log(1 - t)) / (B - A);
  },
  BETADIST: (v) => FUNCS["BETA.DIST"]([v[0], v[1], v[2], true, v[3] ?? 0, v[4] ?? 1]),
  "BETA.INV": (v) => {
    const p = toNum(v[0]), a = toNum(v[1]), b = toNum(v[2]);
    const A = v.length > 3 ? toNum(v[3]) : 0, B = v.length > 4 ? toNum(v[4]) : 1;
    if (p <= 0 || p > 1 || a <= 0 || b <= 0 || B <= A) throw new FormulaError("#NUM", "bad BETA.INV");
    return A + (B - A) * invMonotone((t) => regIncBeta(a, b, t), p, 0, 1);
  },
  BETAINV: (v) => FUNCS["BETA.INV"](v),
  "GAMMA.DIST": (v) => {
    const x = toNum(v[0]), a = toNum(v[1]), b = toNum(v[2]), cum = truthy(v[3]);
    if (x < 0 || a <= 0 || b <= 0) throw new FormulaError("#NUM", "bad GAMMA.DIST");
    if (cum) return lowerGammaP(a, x / b);
    return x === 0 ? (a < 1 ? Infinity : a === 1 ? 1 / b : 0) : Math.exp((a - 1) * Math.log(x) - x / b - lnGamma(a) - a * Math.log(b));
  },
  GAMMADIST: (v) => FUNCS["GAMMA.DIST"](v),
  "GAMMA.INV": (v) => { const p = toNum(v[0]), a = toNum(v[1]), b = toNum(v[2]); if (p < 0 || p >= 1 || a <= 0 || b <= 0) throw new FormulaError("#NUM", "bad GAMMA.INV"); if (p === 0) return 0; return b * invMonotone((x) => lowerGammaP(a, x), p, 0, a * 10 + 10); },
  GAMMAINV: (v) => FUNCS["GAMMA.INV"](v),
  "EXPON.DIST": (v) => { const x = toNum(v[0]), l = toNum(v[1]); const cum = v.length > 2 ? truthy(v[2]) : true; if (x < 0 || l <= 0) throw new FormulaError("#NUM", "bad EXPON.DIST"); return cum ? 1 - Math.exp(-l * x) : l * Math.exp(-l * x); },
  EXPONDIST: (v) => FUNCS["EXPON.DIST"](v),
  "WEIBULL.DIST": (v) => {
    const x = toNum(v[0]), a = toNum(v[1]), b = toNum(v[2]), cum = truthy(v[3]);
    if (x < 0 || a <= 0 || b <= 0) throw new FormulaError("#NUM", "bad WEIBULL");
    return cum ? 1 - Math.exp(-Math.pow(x / b, a)) : (a / Math.pow(b, a)) * Math.pow(x, a - 1) * Math.exp(-Math.pow(x / b, a));
  },
  WEIBULL: (v) => FUNCS["WEIBULL.DIST"](v),
  // ── statistical: discrete distributions ──
  "BINOM.DIST": (v) => {
    const k = Math.trunc(toNum(v[0])), n = Math.trunc(toNum(v[1])), p = toNum(v[2]), cum = truthy(v[3]);
    if (k < 0 || n < 0 || k > n || p < 0 || p > 1) throw new FormulaError("#NUM", "bad BINOM.DIST");
    if (!cum) return Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + (k === 0 ? 0 : k * Math.log(p)) + (n - k === 0 ? 0 : (n - k) * Math.log(1 - p)));
    if (k === n) return 1;
    return regIncBeta(n - k, k + 1, 1 - p);
  },
  BINOMDIST: (v) => FUNCS["BINOM.DIST"](v),
  "BINOM.INV": (v) => {
    const n = Math.trunc(toNum(v[0])), p = toNum(v[1]), alpha = toNum(v[2]);
    if (n < 0 || p < 0 || p > 1 || alpha <= 0 || alpha >= 1) throw new FormulaError("#NUM", "bad BINOM.INV");
    let cum = 0;
    for (let k = 0; k <= n; k++) {
      cum += FUNCS["BINOM.DIST"]([k, n, p, false]);
      if (cum >= alpha - 1e-12) return k;
    }
    return n;
  },
  CRITBINOM: (v) => FUNCS["BINOM.INV"](v),
  "POISSON.DIST": (v) => {
    const k = Math.trunc(toNum(v[0])), mean = toNum(v[1]); const cum = v.length > 2 ? truthy(v[2]) : true;
    if (k < 0 || mean < 0) throw new FormulaError("#NUM", "bad POISSON");
    if (!cum) return Math.exp(-mean + k * Math.log(mean) - lnGamma(k + 1));
    return 1 - lowerGammaP(k + 1, mean);
  },
  POISSON: (v) => FUNCS["POISSON.DIST"](v),
  "NEGBINOM.DIST": (v) => {
    const f = Math.trunc(toNum(v[0])), s = Math.trunc(toNum(v[1])), p = toNum(v[2]); const cum = v.length > 3 ? truthy(v[3]) : false;
    if (f < 0 || s < 1 || p <= 0 || p > 1) throw new FormulaError("#NUM", "bad NEGBINOM");
    if (cum) return regIncBeta(s, f + 1, p);
    return Math.exp(lnGamma(f + s) - lnGamma(s) - lnGamma(f + 1)) * Math.pow(p, s) * Math.pow(1 - p, f);
  },
  NEGBINOMDIST: (v) => FUNCS["NEGBINOM.DIST"]([v[0], v[1], v[2], false]),
  "HYPGEOM.DIST": (v) => {
    const k = Math.trunc(toNum(v[0])), n = Math.trunc(toNum(v[1])), K = Math.trunc(toNum(v[2])), N = Math.trunc(toNum(v[3]));
    const cum = v.length > 4 ? truthy(v[4]) : false;
    if (N < 1 || n < 0 || K < 0 || n > N || K > N) throw new FormulaError("#NUM", "bad HYPGEOM");
    const pmf = (x) => {
      if (x < Math.max(0, n + K - N) || x > Math.min(n, K)) return 0;
      return Math.exp(lnGamma(K + 1) - lnGamma(x + 1) - lnGamma(K - x + 1)
        + lnGamma(N - K + 1) - lnGamma(n - x + 1) - lnGamma(N - K - n + x + 1)
        - (lnGamma(N + 1) - lnGamma(n + 1) - lnGamma(N - n + 1)));
    };
    if (!cum) return pmf(k);
    let total = 0;
    for (let x = 0; x <= k; x++) total += pmf(x);
    return Math.min(1, total);
  },
  HYPGEOMDIST: (v) => FUNCS["HYPGEOM.DIST"]([v[0], v[1], v[2], v[3], false]),
});

// Student-t CDF via the incomplete beta
function tCdf(x, df) {
  if (df < 1) throw new FormulaError("#NUM", "bad df");
  const p = 0.5 * regIncBeta(df / 2, 0.5, df / (df + x * x));
  return x >= 0 ? 1 - p : p;
}

// PERCENTRANK / PERCENTRANK.INC / PERCENTRANK.EXC —
// (data, x, [significance=3]); result truncated to `significance` digits.
function pctRank(h, exclusive) {
  const { args, ctx } = h;
  if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "PERCENTRANK takes data, x, [significance]");
  const xs = flatNumeric(argGrid(args[0], ctx).flat()).sort((a, b) => a - b);
  const x = toNum(deArr(evalNode(args[1], ctx)));
  const sig = args.length === 3 ? Math.trunc(toNum(deArr(evalNode(args[2], ctx)))) : 3;
  if (!xs.length) throw new FormulaError("#NUM", "empty data");
  if (sig < 1) throw new FormulaError("#NUM", "significance must be ≥ 1");
  if (x < xs[0] || x > xs[xs.length - 1]) throw new FormulaError("#N/A", "x outside data range");
  let below = 0;
  while (below < xs.length && xs[below] < x) below++;
  let frac;
  if (exclusive) {
    if (xs[below] === x) frac = (below + 1) / (xs.length + 1);
    else frac = (below + (x - xs[below - 1]) / (xs[below] - xs[below - 1])) / (xs.length + 1);
  } else {
    if (xs.length === 1) frac = 1;
    else if (xs[below] === x) frac = below / (xs.length - 1);
    else frac = (below - 1 + (x - xs[below - 1]) / (xs[below] - xs[below - 1])) / (xs.length - 1);
  }
  const f = Math.pow(10, sig);
  return Math.floor(frac * f + 1e-10) / f;
}

Object.assign(FUNCS, {
  // ── statistical: paired data (correlation / regression / tests) ──
  CORREL: (v, h) => {
    const { xs, ys } = numericPairs(argGrid(h.args[0], h.ctx), argGrid(h.args[1], h.ctx));
    if (xs.length < 2) throw new FormulaError("#DIV/0", "CORREL needs 2+ pairs");
    const mx = meanOf(xs), my = meanOf(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    if (sxx === 0 || syy === 0) throw new FormulaError("#DIV/0", "constant data");
    return sxy / Math.sqrt(sxx * syy);
  },
  PEARSON: (v, h) => FUNCS.CORREL(v, h),
  RSQ: (v, h) => { const r = FUNCS.CORREL(v, h); return r * r; },
  COVAR: (v, h) => FUNCS["COVARIANCE.P"](v, h),
  "COVARIANCE.P": (v, h) => {
    const { xs, ys } = numericPairs(argGrid(h.args[0], h.ctx), argGrid(h.args[1], h.ctx));
    if (!xs.length) throw new FormulaError("#DIV/0", "COVARIANCE of empty");
    const mx = meanOf(xs), my = meanOf(ys);
    return xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.length;
  },
  "COVARIANCE.S": (v, h) => {
    const { xs, ys } = numericPairs(argGrid(h.args[0], h.ctx), argGrid(h.args[1], h.ctx));
    if (xs.length < 2) throw new FormulaError("#DIV/0", "COVARIANCE.S needs 2+ pairs");
    const mx = meanOf(xs), my = meanOf(ys);
    return xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / (xs.length - 1);
  },
  SLOPE: (v, h) => linFit(argGrid(h.args[0], h.ctx), argGrid(h.args[1], h.ctx)).slope,
  INTERCEPT: (v, h) => linFit(argGrid(h.args[0], h.ctx), argGrid(h.args[1], h.ctx)).intercept,
  FORECAST: (v, h) => {
    const x = toNum(deArr(evalNode(h.args[0], h.ctx)));
    const fit = linFit(argGrid(h.args[1], h.ctx), argGrid(h.args[2], h.ctx));
    return fit.intercept + fit.slope * x;
  },
  "FORECAST.LINEAR": (v, h) => FUNCS.FORECAST(v, h),
  STEYX: (v, h) => {
    const fit = linFit(argGrid(h.args[0], h.ctx), argGrid(h.args[1], h.ctx));
    const n = fit.xs.length;
    if (n < 3) throw new FormulaError("#DIV/0", "STEYX needs 3+ pairs");
    let sse = 0;
    for (let i = 0; i < n; i++) { const e = fit.ys[i] - (fit.intercept + fit.slope * fit.xs[i]); sse += e * e; }
    return Math.sqrt(sse / (n - 2));
  },
  "T.TEST": (v, h) => {
    const a = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const b = flatNumeric(argGrid(h.args[1], h.ctx).flat());
    const tails = Math.trunc(toNum(deArr(evalNode(h.args[2], h.ctx))));
    const type = Math.trunc(toNum(deArr(evalNode(h.args[3], h.ctx))));
    if ((tails !== 1 && tails !== 2) || type < 1 || type > 3) throw new FormulaError("#NUM", "bad T.TEST options");
    let t, df;
    if (type === 1) {
      if (a.length !== b.length) throw new FormulaError("#N/A", "paired test needs equal-size ranges");
      const d = a.map((x, i) => x - b[i]);
      if (d.length < 2) throw new FormulaError("#DIV/0", "not enough data");
      const sd = Math.sqrt(varSOf(d));
      if (sd === 0) throw new FormulaError("#DIV/0", "zero variance");
      t = (meanOf(d) * Math.sqrt(d.length)) / sd;
      df = d.length - 1;
    } else {
      if (a.length < 2 || b.length < 2) throw new FormulaError("#DIV/0", "not enough data");
      const va = varSOf(a), vb = varSOf(b);
      if (type === 2) {
        const pooled = ((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2);
        if (pooled === 0) throw new FormulaError("#DIV/0", "zero variance");
        t = (meanOf(a) - meanOf(b)) / Math.sqrt(pooled * (1 / a.length + 1 / b.length));
        df = a.length + b.length - 2;
      } else {
        const qa = va / a.length, qb = vb / b.length;
        if (qa + qb === 0) throw new FormulaError("#DIV/0", "zero variance");
        t = (meanOf(a) - meanOf(b)) / Math.sqrt(qa + qb);
        df = ((qa + qb) ** 2) / ((qa * qa) / (a.length - 1) + (qb * qb) / (b.length - 1));
      }
    }
    const rt = 1 - tCdf(Math.abs(t), Math.max(1, df));
    return tails === 1 ? rt : 2 * rt;
  },
  TTEST: (v, h) => FUNCS["T.TEST"](v, h),
  "F.TEST": (v, h) => {
    const a = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const b = flatNumeric(argGrid(h.args[1], h.ctx).flat());
    if (a.length < 2 || b.length < 2) throw new FormulaError("#DIV/0", "F.TEST needs 2+ values each");
    const va = varSOf(a), vb = varSOf(b);
    if (va === 0 || vb === 0) throw new FormulaError("#DIV/0", "zero variance");
    const f = va / vb;
    const p = 1 - regIncBeta((a.length - 1) / 2, (b.length - 1) / 2, ((a.length - 1) * f) / ((a.length - 1) * f + (b.length - 1)));
    return 2 * Math.min(p, 1 - p);
  },
  FTEST: (v, h) => FUNCS["F.TEST"](v, h),
  "CHISQ.TEST": (v, h) => {
    const o = argGrid(h.args[0], h.ctx), e = argGrid(h.args[1], h.ctx);
    if (o.height !== e.height || o.width !== e.width) throw new FormulaError("#N/A", "ranges must be the same shape");
    let chi = 0, r = o.height, c = o.width;
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
      const ov = toNum(o.rows[i][j]), ev = toNum(e.rows[i][j]);
      if (ev <= 0) throw new FormulaError("#DIV/0", "expected values must be positive");
      chi += ((ov - ev) * (ov - ev)) / ev;
    }
    const df = r > 1 && c > 1 ? (r - 1) * (c - 1) : Math.max(1, r * c - 1);
    return 1 - lowerGammaP(df / 2, chi / 2);
  },
  CHITEST: (v, h) => FUNCS["CHISQ.TEST"](v, h),
  "Z.TEST": (v, h) => {
    const xs = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const x = toNum(deArr(evalNode(h.args[1], h.ctx)));
    if (xs.length < 1) throw new FormulaError("#N/A", "empty data");
    const sigma = h.args.length > 2 ? toNum(deArr(evalNode(h.args[2], h.ctx))) : Math.sqrt(varSOf(xs));
    if (sigma <= 0) throw new FormulaError("#NUM", "sigma must be positive");
    return 1 - normSCdf((meanOf(xs) - x) / (sigma / Math.sqrt(xs.length)));
  },
  ZTEST: (v, h) => FUNCS["Z.TEST"](v, h),
  PROB: (v, h) => {
    const xs = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const ps = flatNumeric(argGrid(h.args[1], h.ctx).flat());
    if (xs.length !== ps.length) throw new FormulaError("#N/A", "ranges must be the same size");
    if (ps.some((p) => p < 0 || p > 1) || Math.abs(ps.reduce((a, b) => a + b, 0) - 1) > 1e-9) throw new FormulaError("#NUM", "probabilities must sum to 1");
    const lo = toNum(deArr(evalNode(h.args[2], h.ctx)));
    const hi = h.args.length > 3 ? toNum(deArr(evalNode(h.args[3], h.ctx))) : lo;
    return xs.reduce((a, x, i) => (x >= lo && x <= hi ? a + ps[i] : a), 0);
  },
  "AVERAGE.WEIGHTED": (v, h) => {
    if (h.args.length < 2 || h.args.length % 2 !== 0) throw new FormulaError("#ERROR", "AVERAGE.WEIGHTED takes value/weight pairs");
    let sum = 0, wsum = 0;
    for (let i = 0; i < h.args.length; i += 2) {
      const { xs, ys } = numericPairs(argGrid(h.args[i], h.ctx), argGrid(h.args[i + 1], h.ctx));
      for (let j = 0; j < xs.length; j++) {
        if (ys[j] < 0) throw new FormulaError("#NUM", "weights must be ≥ 0");
        sum += xs[j] * ys[j];
        wsum += ys[j];
      }
    }
    if (wsum === 0) throw new FormulaError("#DIV/0", "weights sum to zero");
    return sum / wsum;
  },
  MARGINOFERROR: (v, h) => {
    const xs = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const conf = toNum(deArr(evalNode(h.args[1], h.ctx)));
    if (xs.length < 2) throw new FormulaError("#DIV/0", "MARGINOFERROR needs 2+ values");
    if (conf <= 0 || conf >= 1) throw new FormulaError("#NUM", "confidence must be in (0,1)");
    return normSInv(1 - (1 - conf) / 2) * (Math.sqrt(varSOf(xs)) / Math.sqrt(xs.length));
  },
  "MODE.MULT": (v) => {
    const xs = flatNumeric(v);
    const seen = new Map();
    for (const x of xs) seen.set(x, (seen.get(x) || 0) + 1);
    let best = 1;
    for (const n of seen.values()) if (n > best) best = n;
    if (best < 2) throw new FormulaError("#N/A", "no repeated value");
    const modes = [];
    for (const x of xs) if (seen.get(x) === best && !modes.includes(x)) modes.push(x);
    return new Arr(modes.map((m) => [m]));
  },
});

// ── Engineering helpers: fixed-width two's-complement base conversion ───────
// BIN is 10 digits, OCT 10 digits (30 bits), HEX 10 digits (40 bits) —
// Excel/Sheets widths. Values are exact in doubles (< 2^53).

const BASE_SPECS = { 2: { digits: 10, min: -512, max: 511 }, 8: { digits: 10, min: -(2 ** 29), max: 2 ** 29 - 1 }, 16: { digits: 10, min: -(2 ** 39), max: 2 ** 39 - 1 } };
function parseBaseNum(s, radix) {
  const spec = BASE_SPECS[radix];
  const str = fmtScalar(s).trim().toUpperCase();
  if (!str || str.length > spec.digits || [...str].some((ch) => { const d = parseInt(ch, radix); return isNaN(d) || String(d.toString(radix)).toUpperCase() !== ch; })) throw new FormulaError("#NUM", `not a base-${radix} number`);
  let n = parseInt(str, radix);
  const span = Math.pow(radix, spec.digits);
  if (str.length === spec.digits && n >= span / 2) n -= span; // two's complement
  return n;
}
function toBaseNum(n, radix, places) {
  const spec = BASE_SPECS[radix];
  n = Math.trunc(n);
  if (n < spec.min || n > spec.max) throw new FormulaError("#NUM", "value out of range");
  let s;
  if (n < 0) s = (n + Math.pow(radix, spec.digits)).toString(radix).toUpperCase();
  else {
    s = n.toString(radix).toUpperCase();
    if (places != null) {
      const p = Math.trunc(places);
      if (p < s.length || p > spec.digits) throw new FormulaError("#NUM", "bad places");
      s = s.padStart(p, "0");
    }
  }
  return s;
}
function bitArg(x, name) {
  const n = toNum(x);
  if (n < 0 || !Number.isInteger(n) || n >= 2 ** 48) throw new FormulaError("#NUM", `${name} needs a non-negative integer < 2^48`);
  return BigInt(n);
}

// ── Complex-number helpers ("3+4i" strings) ─────────────────────────────────

const CX_FLOAT = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const CX_IMAG_RE = new RegExp("^(" + CX_FLOAT + ")?([ij])$"); // "4i", "-2.5j", "i", "-j"
const CX_FULL_RE = new RegExp("^(" + CX_FLOAT + ")([+-](?:\\d+(?:\\.\\d+)?|\\.\\d+)?(?:[eE][+-]?\\d+)?)([ij])$"); // "3+4i", "3-i"
const CX_REAL_RE = new RegExp("^(" + CX_FLOAT + ")$");
function cxParse(v) {
  if (typeof v === "number") return { re: v, im: 0, sfx: "i" };
  const s = fmtScalar(v).trim();
  if (s === "") return { re: 0, im: 0, sfx: "i" };
  // pure imaginary: "i", "-j", "4i", "-2.5j"
  let m = CX_IMAG_RE.exec(s);
  if (m) { const mag = m[1] == null || m[1] === "" ? 1 : m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]); return { re: 0, im: mag, sfx: m[2] }; }
  // real + imaginary: "3+4i", "3-i", "1.5e2-2.5j"
  m = CX_FULL_RE.exec(s);
  if (m) {
    const body = m[2];
    const mag = body === "+" ? 1 : body === "-" ? -1 : Number(body);
    return { re: Number(m[1]), im: mag, sfx: m[3] };
  }
  // pure real
  m = CX_REAL_RE.exec(s);
  if (m) return { re: Number(m[1]), im: 0, sfx: "i" };
  throw new FormulaError("#NUM", `'${s}' is not a complex number`);
}
function cxNum(n) {
  // trim float noise: 15 significant digits
  const r = Number(n.toPrecision(15));
  return String(r);
}
function cxStr(re, im, sfx) {
  sfx = sfx || "i";
  if (Math.abs(im) < 1e-300) im = 0;
  if (Math.abs(re) < 1e-300) re = 0;
  if (!isFinite(re) || !isFinite(im)) throw new FormulaError("#NUM", "complex overflow");
  if (im === 0) return cxNum(re);
  const imPart = im === 1 ? sfx : im === -1 ? "-" + sfx : cxNum(im) + sfx;
  if (re === 0) return imPart;
  return cxNum(re) + (im > 0 ? "+" : "") + (im === -1 ? "-" + sfx : im === 1 ? sfx : cxNum(im) + sfx);
}
function cxArgs(vals) {
  const list = vals.filter((x) => x != null && x !== "").map(cxParse);
  if (!list.length) throw new FormulaError("#NUM", "no complex values");
  const sfx = list.find((c) => c.im !== 0)?.sfx || "i";
  if (list.some((c) => c.im !== 0 && c.sfx !== sfx)) throw new FormulaError("#VALUE", "mixed i and j suffixes");
  return { list, sfx };
}
function cxMul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cxDiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) throw new FormulaError("#DIV/0", "division by zero complex");
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function cxExp(a) { const e = Math.exp(a.re); return { re: e * Math.cos(a.im), im: e * Math.sin(a.im) }; }
function cxLn(a) {
  const mod = Math.hypot(a.re, a.im);
  if (mod === 0) throw new FormulaError("#NUM", "log of zero");
  return { re: Math.log(mod), im: Math.atan2(a.im, a.re) };
}
function cxSin(a) { return { re: Math.sin(a.re) * Math.cosh(a.im), im: Math.cos(a.re) * Math.sinh(a.im) }; }
function cxCos(a) { return { re: Math.cos(a.re) * Math.cosh(a.im), im: -Math.sin(a.re) * Math.sinh(a.im) }; }

Object.assign(FUNCS, {
  // ── engineering: base conversion ──
  BIN2DEC: (v) => parseBaseNum(v[0], 2),
  OCT2DEC: (v) => parseBaseNum(v[0], 8),
  HEX2DEC: (v) => parseBaseNum(v[0], 16),
  DEC2BIN: (v) => toBaseNum(toNum(v[0]), 2, v.length > 1 ? toNum(v[1]) : null),
  DEC2OCT: (v) => toBaseNum(toNum(v[0]), 8, v.length > 1 ? toNum(v[1]) : null),
  DEC2HEX: (v) => toBaseNum(toNum(v[0]), 16, v.length > 1 ? toNum(v[1]) : null),
  BIN2OCT: (v) => toBaseNum(parseBaseNum(v[0], 2), 8, v.length > 1 ? toNum(v[1]) : null),
  BIN2HEX: (v) => toBaseNum(parseBaseNum(v[0], 2), 16, v.length > 1 ? toNum(v[1]) : null),
  OCT2BIN: (v) => toBaseNum(parseBaseNum(v[0], 8), 2, v.length > 1 ? toNum(v[1]) : null),
  OCT2HEX: (v) => toBaseNum(parseBaseNum(v[0], 8), 16, v.length > 1 ? toNum(v[1]) : null),
  HEX2BIN: (v) => toBaseNum(parseBaseNum(v[0], 16), 2, v.length > 1 ? toNum(v[1]) : null),
  HEX2OCT: (v) => toBaseNum(parseBaseNum(v[0], 16), 8, v.length > 1 ? toNum(v[1]) : null),
  // ── engineering: bitwise ──
  BITAND: (v) => Number(bitArg(v[0], "BITAND") & bitArg(v[1], "BITAND")),
  BITOR: (v) => Number(bitArg(v[0], "BITOR") | bitArg(v[1], "BITOR")),
  BITXOR: (v) => Number(bitArg(v[0], "BITXOR") ^ bitArg(v[1], "BITXOR")),
  BITLSHIFT: (v) => {
    const n = bitArg(v[0], "BITLSHIFT");
    const k = Math.trunc(toNum(v[1]));
    if (Math.abs(k) > 53) throw new FormulaError("#NUM", "shift too large");
    const r = k >= 0 ? n << BigInt(k) : n >> BigInt(-k);
    if (r >= 2n ** 48n) throw new FormulaError("#NUM", "result out of range");
    return Number(r);
  },
  BITRSHIFT: (v) => FUNCS.BITLSHIFT([v[0], -Math.trunc(toNum(v[1]))]),
  // ── engineering: comparison + error function ──
  DELTA: (v) => (toNum(v[0]) === (v.length > 1 ? toNum(v[1]) : 0) ? 1 : 0),
  GESTEP: (v) => (toNum(v[0]) >= (v.length > 1 ? toNum(v[1]) : 0) ? 1 : 0),
  ERF: (v) => (v.length > 1 ? erfFn(toNum(v[1])) - erfFn(toNum(v[0])) : erfFn(toNum(v[0]))),
  "ERF.PRECISE": (v) => erfFn(toNum(v[0])),
  ERFC: (v) => erfcFn(toNum(v[0])),
  "ERFC.PRECISE": (v) => erfcFn(toNum(v[0])),
  // ── engineering: complex numbers ──
  COMPLEX: (v) => {
    const sfx = v.length > 2 ? fmtScalar(v[2]) : "i";
    if (sfx !== "i" && sfx !== "j") throw new FormulaError("#VALUE", "suffix must be i or j");
    return cxStr(toNum(v[0]), toNum(v[1]), sfx);
  },
  IMREAL: (v) => cxParse(v[0]).re,
  IMAGINARY: (v) => cxParse(v[0]).im,
  IMABS: (v) => { const c = cxParse(v[0]); return Math.hypot(c.re, c.im); },
  IMARGUMENT: (v) => { const c = cxParse(v[0]); if (c.re === 0 && c.im === 0) throw new FormulaError("#DIV/0", "argument of zero"); return Math.atan2(c.im, c.re); },
  IMCONJUGATE: (v) => { const c = cxParse(v[0]); return cxStr(c.re, -c.im, c.sfx); },
  IMSUM: (v) => { const { list, sfx } = cxArgs(v); const r = list.reduce((a, c) => ({ re: a.re + c.re, im: a.im + c.im }), { re: 0, im: 0 }); return cxStr(r.re, r.im, sfx); },
  IMSUB: (v) => { const a = cxParse(v[0]), b = cxParse(v[1]); return cxStr(a.re - b.re, a.im - b.im, a.im !== 0 ? a.sfx : b.sfx); },
  IMPRODUCT: (v) => { const { list, sfx } = cxArgs(v); const r = list.reduce((a, c) => cxMul(a, c), { re: 1, im: 0 }); return cxStr(r.re, r.im, sfx); },
  IMDIV: (v) => { const a = cxParse(v[0]), b = cxParse(v[1]); const r = cxDiv(a, b); return cxStr(r.re, r.im, a.im !== 0 ? a.sfx : b.sfx); },
  IMEXP: (v) => { const c = cxParse(v[0]); const r = cxExp(c); return cxStr(r.re, r.im, c.sfx); },
  IMLN: (v) => { const c = cxParse(v[0]); const r = cxLn(c); return cxStr(r.re, r.im, c.sfx); },
  IMLOG: (v) => {
    const c = cxParse(v[0]);
    const base = v.length > 1 ? toNum(v[1]) : 10;
    if (base <= 0 || base === 1) throw new FormulaError("#NUM", "bad log base");
    const l = cxLn(c), k = Math.log(base);
    return cxStr(l.re / k, l.im / k, c.sfx);
  },
  IMLOG10: (v) => FUNCS.IMLOG([v[0], 10]),
  IMLOG2: (v) => FUNCS.IMLOG([v[0], 2]),
  IMPOWER: (v) => {
    const c = cxParse(v[0]); const n = toNum(v[1]);
    if (c.re === 0 && c.im === 0) { if (n <= 0) throw new FormulaError("#NUM", "0^n undefined"); return cxStr(0, 0, c.sfx); }
    const l = cxLn(c);
    const r = cxExp({ re: l.re * n, im: l.im * n });
    return cxStr(r.re, r.im, c.sfx);
  },
  IMSQRT: (v) => FUNCS.IMPOWER([v[0], 0.5]),
  IMSIN: (v) => { const c = cxParse(v[0]); const r = cxSin(c); return cxStr(r.re, r.im, c.sfx); },
  IMCOS: (v) => { const c = cxParse(v[0]); const r = cxCos(c); return cxStr(r.re, r.im, c.sfx); },
  IMTAN: (v) => { const c = cxParse(v[0]); const r = cxDiv(cxSin(c), cxCos(c)); return cxStr(r.re, r.im, c.sfx); },
  IMCOT: (v) => { const c = cxParse(v[0]); const r = cxDiv(cxCos(c), cxSin(c)); return cxStr(r.re, r.im, c.sfx); },
  IMSEC: (v) => { const c = cxParse(v[0]); const r = cxDiv({ re: 1, im: 0 }, cxCos(c)); return cxStr(r.re, r.im, c.sfx); },
  IMCSC: (v) => { const c = cxParse(v[0]); const r = cxDiv({ re: 1, im: 0 }, cxSin(c)); return cxStr(r.re, r.im, c.sfx); },
  IMSINH: (v) => { const c = cxParse(v[0]); return cxStr(Math.sinh(c.re) * Math.cos(c.im), Math.cosh(c.re) * Math.sin(c.im), c.sfx); },
  IMCOSH: (v) => { const c = cxParse(v[0]); return cxStr(Math.cosh(c.re) * Math.cos(c.im), Math.sinh(c.re) * Math.sin(c.im), c.sfx); },
  IMTANH: (v) => { const c = cxParse(v[0]); const s = { re: Math.sinh(c.re) * Math.cos(c.im), im: Math.cosh(c.re) * Math.sin(c.im) }; const ch = { re: Math.cosh(c.re) * Math.cos(c.im), im: Math.sinh(c.re) * Math.sin(c.im) }; const r = cxDiv(s, ch); return cxStr(r.re, r.im, c.sfx); },
  IMCOTH: (v) => { const c = cxParse(v[0]); const t = cxParse(FUNCS.IMTANH([v[0]])); const r = cxDiv({ re: 1, im: 0 }, t); return cxStr(r.re, r.im, c.sfx); },
  IMSECH: (v) => { const c = cxParse(v[0]); const ch = cxParse(FUNCS.IMCOSH([v[0]])); const r = cxDiv({ re: 1, im: 0 }, ch); return cxStr(r.re, r.im, c.sfx); },
  IMCSCH: (v) => { const c = cxParse(v[0]); const sh = cxParse(FUNCS.IMSINH([v[0]])); const r = cxDiv({ re: 1, im: 0 }, sh); return cxStr(r.re, r.im, c.sfx); },
});

// ── Financial: day-count bases + coupon schedules ────────────────────────────
// basis: 0 = US 30/360 (default), 1 = actual/actual, 2 = actual/360,
//        3 = actual/365, 4 = European 30/360

function argDateVal(x, name) {
  if (typeof x === "number") return serialToDate(x);
  const d = parseDateLoose(fmtScalar(x));
  if (!d) throw new FormulaError("#VALUE", `${name} needs a date`);
  return d;
}
function days360Between(d1, d2, european) {
  let a1 = d1.getDate(), a2 = d2.getDate();
  const m1 = d1.getMonth(), m2 = d2.getMonth(), y1 = d1.getFullYear(), y2 = d2.getFullYear();
  if (european) { a1 = Math.min(a1, 30); a2 = Math.min(a2, 30); }
  else {
    const lastFeb1 = m1 === 1 && a1 === new Date(y1, 2, 0).getDate();
    const lastFeb2 = m2 === 1 && a2 === new Date(y2, 2, 0).getDate();
    if (lastFeb1 && lastFeb2) a2 = 30;
    if (lastFeb1) a1 = 30;
    if (a2 === 31 && a1 >= 30) a2 = 30;
    if (a1 === 31) a1 = 30;
  }
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (a2 - a1);
}
function daysBetweenBasis(d1, d2, basis) {
  if (basis === 0) return days360Between(d1, d2, false);
  if (basis === 4) return days360Between(d1, d2, true);
  return dateToSerial(d2) - dateToSerial(d1);
}
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function yearDaysBasis(d, basis) {
  if (basis === 1) return isLeap(d.getFullYear()) ? 366 : 365;
  if (basis === 3) return 365;
  return 360;
}
function yearFracBasis(d1, d2, basis) {
  basis = Math.trunc(basis || 0);
  if (basis < 0 || basis > 4) throw new FormulaError("#NUM", "basis must be 0-4");
  if (dateToSerial(d1) > dateToSerial(d2)) { const t = d1; d1 = d2; d2 = t; }
  if (basis === 0) return days360Between(d1, d2, false) / 360;
  if (basis === 4) return days360Between(d1, d2, true) / 360;
  const days = dateToSerial(d2) - dateToSerial(d1);
  if (basis === 2) return days / 360;
  if (basis === 3) return days / 365;
  // actual/actual
  const y1 = d1.getFullYear(), y2 = d2.getFullYear();
  const withinYear = y1 === y2 || (y2 === y1 + 1 && (d2.getMonth() < d1.getMonth() || (d2.getMonth() === d1.getMonth() && d2.getDate() <= d1.getDate())));
  if (withinYear) {
    let den = 365;
    if (y1 === y2 && isLeap(y1)) den = 366;
    else {
      const feb29a = isLeap(y1) ? new Date(y1, 1, 29) : null;
      const feb29b = isLeap(y2) ? new Date(y2, 1, 29) : null;
      if ((feb29a && dateToSerial(d1) <= dateToSerial(feb29a) && dateToSerial(feb29a) <= dateToSerial(d2)) ||
          (feb29b && dateToSerial(d1) <= dateToSerial(feb29b) && dateToSerial(feb29b) <= dateToSerial(d2))) den = 366;
    }
    return days / den;
  }
  const span = dateToSerial(new Date(y2 + 1, 0, 1)) - dateToSerial(new Date(y1, 0, 1));
  return days / (span / (y2 - y1 + 1));
}
function addMonthsClamped(d, months) {
  const last = new Date(d.getFullYear(), d.getMonth() + months + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + months, Math.min(d.getDate(), last));
}
function couponSchedule(settle, mat, freq) {
  if (freq !== 1 && freq !== 2 && freq !== 4) throw new FormulaError("#NUM", "frequency must be 1, 2, or 4");
  if (dateToSerial(settle) >= dateToSerial(mat)) throw new FormulaError("#NUM", "settlement must be before maturity");
  const step = 12 / freq;
  let n = 0;
  for (;;) {
    const d = addMonthsClamped(mat, -step * (n + 1));
    if (dateToSerial(d) <= dateToSerial(settle)) break;
    n++;
    if (n > 1200) throw new FormulaError("#NUM", "coupon schedule too long");
  }
  return { pcd: addMonthsClamped(mat, -step * (n + 1)), ncd: addMonthsClamped(mat, -step * n), numLeft: n + 1 };
}
function couponMeasures(settle, mat, freq, basis) {
  basis = Math.trunc(basis || 0);
  if (basis < 0 || basis > 4) throw new FormulaError("#NUM", "basis must be 0-4");
  const { pcd, ncd, numLeft } = couponSchedule(settle, mat, freq);
  const E = basis === 1 ? dateToSerial(ncd) - dateToSerial(pcd) : basis === 3 ? 365 / freq : 360 / freq;
  const A = basis === 0 || basis === 4 ? days360Between(pcd, settle, basis === 4) : dateToSerial(settle) - dateToSerial(pcd);
  const DSC = basis === 0 || basis === 4 ? E - A : dateToSerial(ncd) - dateToSerial(settle);
  return { pcd, ncd, numLeft, E, A, DSC };
}
function bondPrice(settle, mat, rate, yld, redemption, freq, basis) {
  const { numLeft: N, E, A, DSC } = couponMeasures(settle, mat, freq, basis);
  const coupon = (100 * rate) / freq;
  if (N === 1) {
    // Excel switches to a money-market formula inside the final period
    const T = DSC / E / freq;
    return (redemption + coupon) / (1 + T * yld) - coupon * (A / E);
  }
  const v = 1 + yld / freq;
  let price = redemption / Math.pow(v, N - 1 + DSC / E);
  for (let k = 1; k <= N; k++) price += coupon / Math.pow(v, k - 1 + DSC / E);
  return price - coupon * (A / E);
}
function finBasisArg(v, i) { return v.length > i && v[i] != null && v[i] !== "" ? Math.trunc(toNum(v[i])) : 0; }

Object.assign(FUNCS, {
  // full-basis upgrades of the earlier date helpers
  YEARFRAC: (v) => yearFracBasis(argDateVal(v[0], "YEARFRAC"), argDateVal(v[1], "YEARFRAC"), v.length > 2 ? toNum(v[2]) : 0),
  DAYS360: (v) => days360Between(argDateVal(v[0], "DAYS360"), argDateVal(v[1], "DAYS360"), v.length > 2 && truthy(v[2])),
  // ── financial: rates + payments ──
  RATE: (v) => {
    const n = toNum(v[0]), pmt = toNum(v[1]), pv = toNum(v[2]);
    const fv = v.length > 3 ? toNum(v[3]) : 0, type = v.length > 4 && truthy(v[4]) ? 1 : 0;
    const guess = v.length > 5 ? toNum(v[5]) : 0.1;
    if (n <= 0) throw new FormulaError("#NUM", "RATE periods must be positive");
    const f = (r) => {
      if (r === 0) return pv + pmt * n + fv;
      const k = Math.pow(1 + r, n);
      return pv * k + pmt * (1 + r * type) * ((k - 1) / r) + fv;
    };
    let r = guess;
    for (let i = 0; i < 100; i++) { // Newton with numeric derivative
      const y = f(r);
      if (Math.abs(y) < 1e-10) return r;
      const dy = (f(r + 1e-6) - y) / 1e-6;
      if (!isFinite(dy) || dy === 0) break;
      const next = r - y / dy;
      if (!isFinite(next) || next <= -0.999999) break;
      if (Math.abs(next - r) < 1e-12) return next;
      r = next;
    }
    // bisection fallback over a sign change
    let lo = -0.99, hi = 10;
    if (f(lo) * f(hi) > 0) throw new FormulaError("#NUM", "RATE didn't converge");
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  },
  IPMT: (v) => {
    const r = toNum(v[0]), per = Math.trunc(toNum(v[1])), n = toNum(v[2]), pv = toNum(v[3]);
    const fv = v.length > 4 ? toNum(v[4]) : 0, type = v.length > 5 && truthy(v[5]) ? 1 : 0;
    if (per < 1 || per > n) throw new FormulaError("#NUM", "period out of range");
    const pmt = FUNCS.PMT([r, n, pv, fv, type]);
    if (r === 0) return 0;
    if (type === 1 && per === 1) return 0;
    const k = Math.pow(1 + r, per - 1);
    let bal = pv * k + pmt * (1 + r * type) * ((k - 1) / r);
    if (type === 1) bal += pmt; // payment at the start of this period reduces the balance first
    return -bal * r;
  },
  PPMT: (v) => {
    const pmt = FUNCS.PMT([v[0], v[2], v[3], v.length > 4 ? v[4] : 0, v.length > 5 ? v[5] : 0]);
    return pmt - FUNCS.IPMT(v);
  },
  CUMIPMT: (v) => {
    const [r, n, pv] = [toNum(v[0]), toNum(v[1]), toNum(v[2])];
    const start = Math.trunc(toNum(v[3])), end = Math.trunc(toNum(v[4])), type = truthy(v[5]) ? 1 : 0;
    if (r <= 0 || n <= 0 || pv <= 0 || start < 1 || end < start || end > n) throw new FormulaError("#NUM", "bad CUMIPMT");
    let total = 0;
    for (let k = start; k <= end; k++) total += FUNCS.IPMT([r, k, n, pv, 0, type]);
    return total;
  },
  CUMPRINC: (v) => {
    const [r, n, pv] = [toNum(v[0]), toNum(v[1]), toNum(v[2])];
    const start = Math.trunc(toNum(v[3])), end = Math.trunc(toNum(v[4])), type = truthy(v[5]) ? 1 : 0;
    if (r <= 0 || n <= 0 || pv <= 0 || start < 1 || end < start || end > n) throw new FormulaError("#NUM", "bad CUMPRINC");
    let total = 0;
    for (let k = start; k <= end; k++) total += FUNCS.PPMT([r, k, n, pv, 0, type]);
    return total;
  },
  ISPMT: (v) => {
    const r = toNum(v[0]), per = toNum(v[1]), n = toNum(v[2]), pv = toNum(v[3]);
    if (n === 0) throw new FormulaError("#DIV/0", "ISPMT periods");
    return -pv * r * (1 - per / n);
  },
  // ── financial: depreciation ──
  SYD: (v) => {
    const cost = toNum(v[0]), salvage = toNum(v[1]), life = toNum(v[2]), per = toNum(v[3]);
    if (life <= 0 || per < 1 || per > life) throw new FormulaError("#NUM", "bad SYD");
    return ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1));
  },
  DB: (v) => {
    const cost = toNum(v[0]), salvage = toNum(v[1]), life = Math.trunc(toNum(v[2])), per = Math.trunc(toNum(v[3]));
    const month = v.length > 4 ? Math.trunc(toNum(v[4])) : 12;
    if (cost < 0 || salvage < 0 || life < 1 || per < 1 || per > life + 1 || month < 1 || month > 12) throw new FormulaError("#NUM", "bad DB");
    if (cost === 0) return 0;
    const rate = Math.round((1 - Math.pow(salvage / cost, 1 / life)) * 1000) / 1000;
    let total = (cost * rate * month) / 12;
    if (per === 1) return total;
    let dep = 0;
    for (let k = 2; k <= per; k++) {
      if (k === life + 1) dep = ((cost - total) * rate * (12 - month)) / 12;
      else dep = (cost - total) * rate;
      total += dep;
    }
    return dep;
  },
  DDB: (v) => {
    const cost = toNum(v[0]), salvage = toNum(v[1]), life = toNum(v[2]), per = toNum(v[3]);
    const factor = v.length > 4 ? toNum(v[4]) : 2;
    if (cost < 0 || salvage < 0 || life <= 0 || per < 1 || per > life || factor <= 0) throw new FormulaError("#NUM", "bad DDB");
    let total = 0, dep = 0;
    for (let k = 1; k <= per; k++) {
      dep = Math.min((cost - total) * (factor / life), Math.max(0, cost - salvage - total));
      total += dep;
    }
    return dep;
  },
  VDB: (v) => {
    const cost = toNum(v[0]), salvage = toNum(v[1]), life = toNum(v[2]);
    const start = toNum(v[3]), end = toNum(v[4]);
    const factor = v.length > 5 && v[5] != null && v[5] !== "" ? toNum(v[5]) : 2;
    const noSwitch = v.length > 6 && truthy(v[6]);
    if (cost < 0 || salvage < 0 || life <= 0 || start < 0 || end < start || end > life || factor <= 0) throw new FormulaError("#NUM", "bad VDB");
    // per-period depreciation with optional switch to straight-line
    const depAt = [];
    let total = 0;
    for (let k = 0; k < Math.ceil(end); k++) {
      const ddb = (cost - total) * (factor / life);
      const sl = life - k > 0 ? (cost - total - salvage) / (life - k) : 0;
      let dep = noSwitch ? ddb : Math.max(ddb, sl);
      dep = Math.min(dep, Math.max(0, cost - salvage - total));
      depAt.push(dep);
      total += dep;
    }
    let out = 0;
    for (let k = Math.floor(start); k < Math.ceil(end); k++) {
      const from = Math.max(start, k), to = Math.min(end, k + 1);
      out += depAt[k] * (to - from);
    }
    return out;
  },
  AMORLINC: (v) => {
    const cost = toNum(v[0]);
    const purchased = argDateVal(v[1], "AMORLINC"), firstEnd = argDateVal(v[2], "AMORLINC");
    const salvage = toNum(v[3]), period = Math.trunc(toNum(v[4])), rate = toNum(v[5]);
    const basis = finBasisArg(v, 6);
    if (cost <= 0 || salvage < 0 || salvage > cost || rate <= 0 || period < 0) throw new FormulaError("#NUM", "bad AMORLINC");
    const perDep = cost * rate;
    const firstDep = perDep * yearFracBasis(purchased, firstEnd, basis);
    const depreciable = cost - salvage;
    let total = 0;
    for (let k = 0; k <= period; k++) {
      const dep = Math.min(k === 0 ? firstDep : perDep, Math.max(0, depreciable - total));
      if (k === period) return dep;
      total += dep;
    }
    return 0;
  },
  // ── financial: cash-flow series ──
  MIRR: (v, h) => {
    const xs = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const fin = toNum(deArr(evalNode(h.args[1], h.ctx))), re = toNum(deArr(evalNode(h.args[2], h.ctx)));
    if (!xs.some((x) => x > 0) || !xs.some((x) => x < 0)) throw new FormulaError("#DIV/0", "MIRR needs mixed-sign cash flows");
    const n = xs.length;
    let npvPos = 0, npvNeg = 0;
    xs.forEach((x, i) => {
      if (x > 0) npvPos += x / Math.pow(1 + re, i);
      else npvNeg += x / Math.pow(1 + fin, i);
    });
    return Math.pow((-npvPos * Math.pow(1 + re, n - 1)) / (npvNeg * (1 + fin)), 1 / (n - 1)) - 1;
  },
  XNPV: (v, h) => {
    const rate = toNum(deArr(evalNode(h.args[0], h.ctx)));
    const xs = flatNumeric(argGrid(h.args[1], h.ctx).flat());
    const dates = argGrid(h.args[2], h.ctx).flat().filter((d) => d != null && d !== "").map((d) => dateToSerial(argDateVal(d, "XNPV")));
    if (xs.length !== dates.length || !xs.length) throw new FormulaError("#NUM", "XNPV needs matching values and dates");
    if (rate <= -1) throw new FormulaError("#NUM", "bad XNPV rate");
    const d0 = Math.min(...dates);
    return xs.reduce((a, x, i) => a + x / Math.pow(1 + rate, (dates[i] - d0) / 365), 0);
  },
  XIRR: (v, h) => {
    const xs = flatNumeric(argGrid(h.args[0], h.ctx).flat());
    const dates = argGrid(h.args[1], h.ctx).flat().filter((d) => d != null && d !== "").map((d) => dateToSerial(argDateVal(d, "XIRR")));
    if (xs.length !== dates.length || xs.length < 2 || !xs.some((x) => x > 0) || !xs.some((x) => x < 0)) throw new FormulaError("#NUM", "XIRR needs mixed-sign dated cash flows");
    const d0 = Math.min(...dates);
    const f = (r) => xs.reduce((a, x, i) => a + x / Math.pow(1 + r, (dates[i] - d0) / 365), 0);
    let lo = -0.999999, hi = 10;
    let flo = f(lo), fhi = f(hi);
    for (let i = 0; i < 60 && flo * fhi > 0; i++) { hi *= 2; fhi = f(hi); }
    if (flo * fhi > 0) throw new FormulaError("#NUM", "XIRR didn't converge");
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) { hi = mid; } else { lo = mid; flo = f(lo); } }
    return (lo + hi) / 2;
  },
  FVSCHEDULE: (v, h) => {
    const principal = toNum(deArr(evalNode(h.args[0], h.ctx)));
    const rates = flatNumeric(argGrid(h.args[1], h.ctx).flat());
    return rates.reduce((a, r) => a * (1 + r), principal);
  },
  PDURATION: (v) => {
    const r = toNum(v[0]), pv = toNum(v[1]), fv = toNum(v[2]);
    if (r <= 0 || pv <= 0 || fv <= 0) throw new FormulaError("#NUM", "bad PDURATION");
    return (Math.log(fv) - Math.log(pv)) / Math.log(1 + r);
  },
  RRI: (v) => {
    const n = toNum(v[0]), pv = toNum(v[1]), fv = toNum(v[2]);
    if (n <= 0 || pv <= 0 || fv < 0) throw new FormulaError("#NUM", "bad RRI");
    return Math.pow(fv / pv, 1 / n) - 1;
  },
  DOLLARDE: (v) => {
    const x = toNum(v[0]), frac = Math.trunc(toNum(v[1]));
    if (frac <= 0) throw new FormulaError("#NUM", "fraction must be positive");
    const whole = Math.trunc(x);
    const digits = Math.pow(10, Math.ceil(Math.log10(frac)));
    return whole + ((x - whole) * digits) / frac;
  },
  DOLLARFR: (v) => {
    const x = toNum(v[0]), frac = Math.trunc(toNum(v[1]));
    if (frac <= 0) throw new FormulaError("#NUM", "fraction must be positive");
    const whole = Math.trunc(x);
    const digits = Math.pow(10, Math.ceil(Math.log10(frac)));
    return whole + ((x - whole) * frac) / digits;
  },
  // ── financial: securities ──
  ACCRINT: (v) => {
    const issue = argDateVal(v[0], "ACCRINT"), settle = argDateVal(v[2], "ACCRINT");
    const rate = toNum(v[3]), par = toNum(v[4]);
    const basis = finBasisArg(v, 6);
    if (rate <= 0 || par <= 0 || dateToSerial(settle) <= dateToSerial(issue)) throw new FormulaError("#NUM", "bad ACCRINT");
    return par * rate * yearFracBasis(issue, settle, basis);
  },
  ACCRINTM: (v) => {
    const issue = argDateVal(v[0], "ACCRINTM"), settle = argDateVal(v[1], "ACCRINTM");
    const rate = toNum(v[2]), par = toNum(v[3]);
    const basis = finBasisArg(v, 4);
    if (rate <= 0 || par <= 0 || dateToSerial(settle) <= dateToSerial(issue)) throw new FormulaError("#NUM", "bad ACCRINTM");
    return par * rate * yearFracBasis(issue, settle, basis);
  },
  DISC: (v) => {
    const settle = argDateVal(v[0], "DISC"), mat = argDateVal(v[1], "DISC");
    const pr = toNum(v[2]), red = toNum(v[3]); const basis = finBasisArg(v, 4);
    if (pr <= 0 || red <= 0 || dateToSerial(settle) >= dateToSerial(mat)) throw new FormulaError("#NUM", "bad DISC");
    return ((red - pr) / red) * (yearDaysBasis(settle, basis) / daysBetweenBasis(settle, mat, basis));
  },
  INTRATE: (v) => {
    const settle = argDateVal(v[0], "INTRATE"), mat = argDateVal(v[1], "INTRATE");
    const inv = toNum(v[2]), red = toNum(v[3]); const basis = finBasisArg(v, 4);
    if (inv <= 0 || red <= 0 || dateToSerial(settle) >= dateToSerial(mat)) throw new FormulaError("#NUM", "bad INTRATE");
    return ((red - inv) / inv) * (yearDaysBasis(settle, basis) / daysBetweenBasis(settle, mat, basis));
  },
  RECEIVED: (v) => {
    const settle = argDateVal(v[0], "RECEIVED"), mat = argDateVal(v[1], "RECEIVED");
    const inv = toNum(v[2]), disc = toNum(v[3]); const basis = finBasisArg(v, 4);
    if (inv <= 0 || disc <= 0 || dateToSerial(settle) >= dateToSerial(mat)) throw new FormulaError("#NUM", "bad RECEIVED");
    const t = daysBetweenBasis(settle, mat, basis) / yearDaysBasis(settle, basis);
    if (disc * t >= 1) throw new FormulaError("#NUM", "discount too large");
    return inv / (1 - disc * t);
  },
  PRICEDISC: (v) => {
    const settle = argDateVal(v[0], "PRICEDISC"), mat = argDateVal(v[1], "PRICEDISC");
    const disc = toNum(v[2]), red = toNum(v[3]); const basis = finBasisArg(v, 4);
    if (disc <= 0 || red <= 0 || dateToSerial(settle) >= dateToSerial(mat)) throw new FormulaError("#NUM", "bad PRICEDISC");
    return red * (1 - (disc * daysBetweenBasis(settle, mat, basis)) / yearDaysBasis(settle, basis));
  },
  YIELDDISC: (v) => {
    const settle = argDateVal(v[0], "YIELDDISC"), mat = argDateVal(v[1], "YIELDDISC");
    const pr = toNum(v[2]), red = toNum(v[3]); const basis = finBasisArg(v, 4);
    if (pr <= 0 || red <= 0 || dateToSerial(settle) >= dateToSerial(mat)) throw new FormulaError("#NUM", "bad YIELDDISC");
    return ((red - pr) / pr) * (yearDaysBasis(settle, basis) / daysBetweenBasis(settle, mat, basis));
  },
  PRICEMAT: (v) => {
    const settle = argDateVal(v[0], "PRICEMAT"), mat = argDateVal(v[1], "PRICEMAT"), issue = argDateVal(v[2], "PRICEMAT");
    const rate = toNum(v[3]), yld = toNum(v[4]); const basis = finBasisArg(v, 5);
    if (rate < 0 || yld < 0 || dateToSerial(settle) >= dateToSerial(mat) || dateToSerial(issue) >= dateToSerial(settle)) throw new FormulaError("#NUM", "bad PRICEMAT");
    const dim = yearFracBasis(issue, mat, basis), dsm = yearFracBasis(settle, mat, basis), a = yearFracBasis(issue, settle, basis);
    return (100 + dim * rate * 100) / (1 + dsm * yld) - a * rate * 100;
  },
  YIELDMAT: (v) => {
    const pr = toNum(v[4]);
    if (pr <= 0) throw new FormulaError("#NUM", "bad YIELDMAT price");
    const price = (yld) => FUNCS.PRICEMAT([v[0], v[1], v[2], v[3], yld, v.length > 5 ? v[5] : 0]);
    return invMonotone((y) => -price(y), -pr, -1e-9, 5); // price falls as yield rises
  },
  TBILLPRICE: (v) => {
    const settle = argDateVal(v[0], "TBILLPRICE"), mat = argDateVal(v[1], "TBILLPRICE");
    const disc = toNum(v[2]);
    const dsm = dateToSerial(mat) - dateToSerial(settle);
    if (disc <= 0 || dsm <= 0 || dsm > 366) throw new FormulaError("#NUM", "bad TBILLPRICE");
    const p = 100 * (1 - (disc * dsm) / 360);
    if (p <= 0) throw new FormulaError("#NUM", "discount too large");
    return p;
  },
  TBILLYIELD: (v) => {
    const settle = argDateVal(v[0], "TBILLYIELD"), mat = argDateVal(v[1], "TBILLYIELD");
    const pr = toNum(v[2]);
    const dsm = dateToSerial(mat) - dateToSerial(settle);
    if (pr <= 0 || dsm <= 0 || dsm > 366) throw new FormulaError("#NUM", "bad TBILLYIELD");
    return ((100 - pr) / pr) * (360 / dsm);
  },
  TBILLEQ: (v) => {
    const settle = argDateVal(v[0], "TBILLEQ"), mat = argDateVal(v[1], "TBILLEQ");
    const disc = toNum(v[2]);
    const dsm = dateToSerial(mat) - dateToSerial(settle);
    if (disc <= 0 || dsm <= 0 || dsm > 366) throw new FormulaError("#NUM", "bad TBILLEQ");
    const den = 360 - disc * dsm;
    if (den <= 0) throw new FormulaError("#NUM", "discount too large");
    return (365 * disc) / den;
  },
  COUPPCD: (v) => { const s = couponSchedule(argDateVal(v[0], "COUPPCD"), argDateVal(v[1], "COUPPCD"), Math.trunc(toNum(v[2]))); return isoDate(s.pcd); },
  COUPNCD: (v) => { const s = couponSchedule(argDateVal(v[0], "COUPNCD"), argDateVal(v[1], "COUPNCD"), Math.trunc(toNum(v[2]))); return isoDate(s.ncd); },
  COUPNUM: (v) => couponSchedule(argDateVal(v[0], "COUPNUM"), argDateVal(v[1], "COUPNUM"), Math.trunc(toNum(v[2]))).numLeft,
  COUPDAYS: (v) => couponMeasures(argDateVal(v[0], "COUPDAYS"), argDateVal(v[1], "COUPDAYS"), Math.trunc(toNum(v[2])), finBasisArg(v, 3)).E,
  COUPDAYBS: (v) => couponMeasures(argDateVal(v[0], "COUPDAYBS"), argDateVal(v[1], "COUPDAYBS"), Math.trunc(toNum(v[2])), finBasisArg(v, 3)).A,
  COUPDAYSNC: (v) => couponMeasures(argDateVal(v[0], "COUPDAYSNC"), argDateVal(v[1], "COUPDAYSNC"), Math.trunc(toNum(v[2])), finBasisArg(v, 3)).DSC,
  PRICE: (v) => {
    const settle = argDateVal(v[0], "PRICE"), mat = argDateVal(v[1], "PRICE");
    const rate = toNum(v[2]), yld = toNum(v[3]), red = toNum(v[4]);
    const freq = Math.trunc(toNum(v[5])); const basis = finBasisArg(v, 6);
    if (rate < 0 || yld < 0 || red <= 0) throw new FormulaError("#NUM", "bad PRICE");
    return bondPrice(settle, mat, rate, yld, red, freq, basis);
  },
  YIELD: (v) => {
    const settle = argDateVal(v[0], "YIELD"), mat = argDateVal(v[1], "YIELD");
    const rate = toNum(v[2]), pr = toNum(v[3]), red = toNum(v[4]);
    const freq = Math.trunc(toNum(v[5])); const basis = finBasisArg(v, 6);
    if (rate < 0 || pr <= 0 || red <= 0) throw new FormulaError("#NUM", "bad YIELD");
    return invMonotone((y) => -bondPrice(settle, mat, rate, y, red, freq, basis), -pr, -1e-9, 20);
  },
  DURATION: (v) => {
    const settle = argDateVal(v[0], "DURATION"), mat = argDateVal(v[1], "DURATION");
    const rate = toNum(v[2]), yld = toNum(v[3]);
    const freq = Math.trunc(toNum(v[4])); const basis = finBasisArg(v, 5);
    if (rate < 0 || yld < 0) throw new FormulaError("#NUM", "bad DURATION");
    const { numLeft: N, E, DSC } = couponMeasures(settle, mat, freq, basis);
    const coupon = (100 * rate) / freq;
    const v1 = 1 + yld / freq;
    let pvSum = 0, tSum = 0;
    for (let k = 1; k <= N; k++) {
      const t = (k - 1 + DSC / E) / freq;
      const cf = coupon + (k === N ? 100 : 0);
      const pv = cf / Math.pow(v1, k - 1 + DSC / E);
      pvSum += pv;
      tSum += t * pv;
    }
    if (pvSum === 0) throw new FormulaError("#DIV/0", "DURATION");
    return tSum / pvSum;
  },
  MDURATION: (v) => FUNCS.DURATION(v) / (1 + toNum(v[3]) / Math.trunc(toNum(v[4]))),
});

// ── Text helpers: byte-width variants + regex guards ─────────────────────────
// *B functions count double-byte characters (code points above U+00FF)
// as 2, like Sheets. Split characters are never torn in half.

function chBytes(ch) { return ch.codePointAt(0) > 0xff ? 2 : 1; }
function strBytes(s) { let n = 0; for (const ch of s) n += chBytes(ch); return n; }
function bytesToCharIdx(s, byteLen) {
  // characters that fully fit within byteLen bytes
  let bytes = 0, chars = 0;
  for (const ch of s) {
    if (bytes + chBytes(ch) > byteLen) break;
    bytes += chBytes(ch);
    chars++;
  }
  return chars;
}
const MAX_RE_PATTERN = 255, MAX_RE_INPUT = 20000;
function safeRegex(pattern, flags) {
  const p = fmtScalar(pattern);
  if (p.length > MAX_RE_PATTERN) throw new FormulaError("#VALUE", "regular expression too long");
  try { return new RegExp(p, flags); }
  catch (_) { throw new FormulaError("#VALUE", "bad regular expression"); }
}
function reInput(v) {
  const s = fmtScalar(v);
  if (s.length > MAX_RE_INPUT) throw new FormulaError("#VALUE", "text too long for a regular expression");
  return s;
}
const ROMAN_VALS = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];

// weekend spec for NETWORKDAYS.INTL / WORKDAY.INTL → Set of serial-dow
// values (serial % 7: 0=Sat, 1=Sun, 2=Mon … 6=Fri)
function weekendSpec(v) {
  if (v == null || v === "") return new Set([0, 1]); // Sat + Sun
  const JS2SERIAL = [1, 2, 3, 4, 5, 6, 0]; // getDay() Sun..Sat → serial dow
  if (typeof v === "string" && /^[01]{7}$/.test(v)) {
    const set = new Set();
    for (let i = 0; i < 7; i++) if (v[i] === "1") set.add(JS2SERIAL[(i + 1) % 7]); // string starts Monday
    if (set.size === 7) throw new FormulaError("#VALUE", "weekend can't cover every day");
    return set;
  }
  const n = Math.trunc(toNum(v));
  const pairs = { 1: [6, 0], 2: [0, 1], 3: [1, 2], 4: [2, 3], 5: [3, 4], 6: [4, 5], 7: [5, 6] }; // js dows
  if (pairs[n]) return new Set(pairs[n].map((d) => JS2SERIAL[d]));
  if (n >= 11 && n <= 17) return new Set([JS2SERIAL[n - 11]]);
  throw new FormulaError("#NUM", "bad weekend spec");
}

Object.assign(FUNCS, {
  // ── text ──
  ROMAN: (v) => {
    let n = Math.trunc(toNum(v[0]));
    if (n < 0 || n > 3999) throw new FormulaError("#VALUE", "ROMAN accepts 0-3999");
    let out = "";
    for (const [val, sym] of ROMAN_VALS) while (n >= val) { out += sym; n -= val; }
    return out;
  },
  ARABIC: (v) => {
    let s = fmtScalar(v[0]).trim().toUpperCase();
    const neg = s.startsWith("-");
    if (neg) s = s.slice(1);
    if (!s || s.length > 255 || /[^IVXLCDM]/.test(s)) throw new FormulaError("#VALUE", "not a roman numeral");
    const val = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < s.length; i++) {
      const cur = val[s[i]], nxt = val[s[i + 1]] || 0;
      total += cur < nxt ? -cur : cur;
    }
    return neg ? -total : total;
  },
  UNICHAR: (v) => FUNCS.CHAR(v),
  UNICODE: (v) => FUNCS.CODE(v),
  ASC: (v) => fmtScalar(v[0]).replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, " "),
  REGEXMATCH: (v) => safeRegex(v[1]).test(reInput(v[0])),
  REGEXEXTRACT: (v) => {
    const m = safeRegex(v[1]).exec(reInput(v[0]));
    if (!m) throw new FormulaError("#N/A", "no match");
    if (m.length > 2) return new Arr([m.slice(1).map((g) => g ?? "")]); // several capture groups → row of them
    return m.length === 2 ? m[1] ?? "" : m[0];
  },
  REGEXREPLACE: (v) => reInput(v[0]).replace(safeRegex(v[1], "g"), fmtScalar(v[2]).replace(/\$/g, "$$$$")),
  LENB: (v) => strBytes(fmtScalar(v[0])),
  LEFTB: (v) => { const s = fmtScalar(v[0]); const n = v.length > 1 ? Math.max(0, Math.trunc(toNum(v[1]))) : 1; return [...s].slice(0, bytesToCharIdx(s, n)).join(""); },
  RIGHTB: (v) => {
    const s = fmtScalar(v[0]); const n = v.length > 1 ? Math.max(0, Math.trunc(toNum(v[1]))) : 1;
    const chars = [...s];
    let bytes = 0, take = 0;
    for (let i = chars.length - 1; i >= 0; i--) { if (bytes + chBytes(chars[i]) > n) break; bytes += chBytes(chars[i]); take++; }
    return take ? chars.slice(-take).join("") : "";
  },
  MIDB: (v) => {
    const s = fmtScalar(v[0]);
    const start = Math.trunc(toNum(v[1])), len = Math.trunc(toNum(v[2]));
    if (start < 1 || len < 0) throw new FormulaError("#VALUE", "bad MIDB bounds");
    const chars = [...s];
    const skip = bytesToCharIdx(s, start - 1);
    const rest = chars.slice(skip).join("");
    return [...rest].slice(0, bytesToCharIdx(rest, len)).join("");
  },
  FINDB: (v, h) => { const pos = callFunc({ name: "FIND", args: h.args.slice(0, 2) }, h.ctx); const s = fmtScalar(v[1]); return strBytes([...s].slice(0, pos - 1).join("")) + 1; },
  SEARCHB: (v, h) => { const pos = callFunc({ name: "SEARCH", args: h.args.slice(0, 2) }, h.ctx); const s = fmtScalar(v[1]); return strBytes([...s].slice(0, pos - 1).join("")) + 1; },
  REPLACEB: (v) => {
    const s = fmtScalar(v[0]);
    const start = Math.trunc(toNum(v[1])), len = Math.trunc(toNum(v[2]));
    if (start < 1 || len < 0) throw new FormulaError("#VALUE", "bad REPLACEB bounds");
    const chars = [...s];
    const before = chars.slice(0, bytesToCharIdx(s, start - 1)).join("");
    const rest = chars.slice(bytesToCharIdx(s, start - 1)).join("");
    const after = [...rest].slice(bytesToCharIdx(rest, len)).join("");
    return before + fmtScalar(v[3]) + after;
  },
  // ── date / time ──
  TIME: (v) => {
    const h2 = Math.trunc(toNum(v[0])), m = Math.trunc(toNum(v[1])), s = Math.trunc(toNum(v[2]));
    const total = h2 * 3600 + m * 60 + s;
    if (total < 0) throw new FormulaError("#NUM", "negative time");
    return (total % 86400) / 86400;
  },
  EPOCHTODATE: (v) => {
    const ts = toNum(v[0]);
    const unit = v.length > 1 ? Math.trunc(toNum(v[1])) : 1;
    const ms = unit === 1 ? ts * 1000 : unit === 2 ? ts : unit === 3 ? ts / 1000 : null;
    if (ms == null) throw new FormulaError("#VALUE", "unit must be 1 (s), 2 (ms), or 3 (µs)");
    const d = new Date(ms);
    if (isNaN(d)) throw new FormulaError("#NUM", "bad timestamp");
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  },
  "NETWORKDAYS.INTL": (v, h) => {
    const s1 = dateToSerial(argDateVal(deArr(evalNode(h.args[0], h.ctx)), "NETWORKDAYS.INTL"));
    const s2 = dateToSerial(argDateVal(deArr(evalNode(h.args[1], h.ctx)), "NETWORKDAYS.INTL"));
    const weekend = weekendSpec(h.args.length > 2 ? deArr(evalNode(h.args[2], h.ctx)) : null);
    const holidays = holidaySerials(h.args[3], h.ctx);
    const lo = Math.min(s1, s2), hi = Math.max(s1, s2);
    if (hi - lo > 100000) throw new FormulaError("#VALUE", "date span too large");
    let n = 0;
    for (let s = lo; s <= hi; s++) if (!weekend.has(s % 7) && !holidays.has(s)) n++;
    return s1 <= s2 ? n : -n;
  },
  "WORKDAY.INTL": (v, h) => {
    let s = dateToSerial(argDateVal(deArr(evalNode(h.args[0], h.ctx)), "WORKDAY.INTL"));
    let left = Math.trunc(toNum(deArr(evalNode(h.args[1], h.ctx))));
    if (Math.abs(left) > 100000) throw new FormulaError("#VALUE", "too many days");
    const weekend = weekendSpec(h.args.length > 2 ? deArr(evalNode(h.args[2], h.ctx)) : null);
    const holidays = holidaySerials(h.args[3], h.ctx);
    const step = left >= 0 ? 1 : -1;
    while (left !== 0) {
      s += step;
      if (!weekend.has(s % 7) && !holidays.has(s)) left -= step;
    }
    return isoDate(serialToDate(s));
  },
  // ── info / logical / operator / web ──
  TRUE: () => true,
  FALSE: () => false,
  ISEMAIL: (v) => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(fmtScalar(v[0])),
  ISURL: (v) => {
    const s = fmtScalar(v[0]).trim();
    if (/^(https?|ftp):\/\/\S+\.\S+/i.test(s)) return true;
    if (/^mailto:\S+@\S+/i.test(s)) return true;
    return /^(www\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/\S*)?$/.test(s);
  },
  ISBETWEEN: (v) => {
    const x = v[0] ?? "", lo = v[1] ?? "", hi = v[2] ?? "";
    const loInc = v.length > 3 ? truthy(v[3]) : true;
    const hiInc = v.length > 4 ? truthy(v[4]) : true;
    return cmp(loInc ? ">=" : ">", x, lo) && cmp(hiInc ? "<=" : "<", x, hi);
  },
  UPLUS: (v) => (v.length ? v[0] : 0),
  ENCODEURL: (v) => encodeURIComponent(fmtScalar(v[0])),
  HYPERLINK: (v) => (v.length > 1 ? v[1] : fmtScalar(v[0])),
  // ── parser: TO_* coercions ──
  TO_DATE: (v) => { const n = cellNumeric(v[0]); if (n == null) return v[0] ?? ""; return isoDate(serialToDate(n)); },
  TO_TEXT: (v) => fmtScalar(v[0]),
  TO_PURE_NUMBER: (v) => { const n = cellNumeric(v[0]); return n == null ? (v[0] ?? "") : n; },
  TO_DOLLARS: (v) => {
    const n = cellNumeric(v[0]);
    if (n == null) return v[0] ?? "";
    const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? `-$${abs}` : `$${abs}`;
  },
  TO_PERCENT: (v) => {
    const n = cellNumeric(v[0]);
    if (n == null) return v[0] ?? "";
    const p = Number((n * 100).toPrecision(12));
    return `${p}%`;
  },
  CONVERT: (v) => convertUnits(toNum(v[0]), fmtScalar(v[1]), fmtScalar(v[2])),
});

// ── CONVERT unit tables ──────────────────────────────────────────────────────
// factor = size of the unit in the category's base unit. metric: accepts
// metric prefixes (k, m, µ …). bin: accepts binary prefixes (Ki, Mi …).

const CONV_UNITS = {
  // mass (base: gram)
  g: { cat: "mass", f: 1, metric: true }, u: { cat: "mass", f: 1.66053878283e-24, metric: true },
  grain: { cat: "mass", f: 0.06479891 }, ozm: { cat: "mass", f: 28.349523125 }, lbm: { cat: "mass", f: 453.59237 },
  stone: { cat: "mass", f: 6350.29318 }, sg: { cat: "mass", f: 14593.90294 }, ton: { cat: "mass", f: 907184.74 },
  uk_ton: { cat: "mass", f: 1016046.9088 }, LTON: { cat: "mass", f: 1016046.9088 },
  // distance (base: metre)
  m: { cat: "dist", f: 1, metric: true }, ang: { cat: "dist", f: 1e-10, metric: true },
  in: { cat: "dist", f: 0.0254 }, ft: { cat: "dist", f: 0.3048 }, yd: { cat: "dist", f: 0.9144 },
  mi: { cat: "dist", f: 1609.344 }, Nmi: { cat: "dist", f: 1852 }, ell: { cat: "dist", f: 1.143 },
  ly: { cat: "dist", f: 9460730472580800 }, parsec: { cat: "dist", f: 3.08567758128e16 }, pc: { cat: "dist", f: 3.08567758128e16 },
  Picapt: { cat: "dist", f: 0.0254 / 72 }, Pica: { cat: "dist", f: 0.0254 / 72 }, pica: { cat: "dist", f: 0.0254 / 6 },
  survey_mi: { cat: "dist", f: 1609.3472186944375 },
  // time (base: second)
  sec: { cat: "time", f: 1, metric: true }, s: { cat: "time", f: 1, metric: true },
  mn: { cat: "time", f: 60 }, min: { cat: "time", f: 60 }, hr: { cat: "time", f: 3600 },
  day: { cat: "time", f: 86400 }, d: { cat: "time", f: 86400 }, yr: { cat: "time", f: 31557600 },
  // pressure (base: pascal)
  Pa: { cat: "press", f: 1, metric: true }, p: { cat: "press", f: 1, metric: true },
  atm: { cat: "press", f: 101325, metric: true }, at: { cat: "press", f: 101325, metric: true },
  mmHg: { cat: "press", f: 133.322 }, psi: { cat: "press", f: 6894.757293168 }, Torr: { cat: "press", f: 133.32236842105263 },
  // force (base: newton)
  N: { cat: "force", f: 1, metric: true }, dyn: { cat: "force", f: 1e-5, metric: true }, dy: { cat: "force", f: 1e-5, metric: true },
  lbf: { cat: "force", f: 4.4482216152605 }, pond: { cat: "force", f: 0.00980665, metric: true },
  // energy (base: joule)
  J: { cat: "energy", f: 1, metric: true }, j: { cat: "energy", f: 1, metric: true },
  e: { cat: "energy", f: 1e-7, metric: true }, c: { cat: "energy", f: 4.184, metric: true }, cal: { cat: "energy", f: 4.1868, metric: true },
  eV: { cat: "energy", f: 1.602176487e-19, metric: true }, ev: { cat: "energy", f: 1.602176487e-19, metric: true },
  HPh: { cat: "energy", f: 2684519.5368856 }, hh: { cat: "energy", f: 2684519.5368856 },
  Wh: { cat: "energy", f: 3600, metric: true }, wh: { cat: "energy", f: 3600, metric: true },
  flb: { cat: "energy", f: 1.3558179483314004 }, BTU: { cat: "energy", f: 1055.05585262 }, btu: { cat: "energy", f: 1055.05585262 },
  // power (base: watt)
  W: { cat: "power", f: 1, metric: true }, w: { cat: "power", f: 1, metric: true },
  HP: { cat: "power", f: 745.6998715822702 }, h: { cat: "power", f: 745.6998715822702 }, PS: { cat: "power", f: 735.49875 },
  // magnetism (base: tesla)
  T: { cat: "mag", f: 1, metric: true }, ga: { cat: "mag", f: 1e-4, metric: true },
  // volume (base: litre)
  l: { cat: "vol", f: 1, metric: true }, L: { cat: "vol", f: 1, metric: true }, lt: { cat: "vol", f: 1, metric: true },
  tsp: { cat: "vol", f: 0.00492892159375 }, tspm: { cat: "vol", f: 0.005 }, tbs: { cat: "vol", f: 0.01478676478125 },
  oz: { cat: "vol", f: 0.0295735295625 }, cup: { cat: "vol", f: 0.2365882365 },
  pt: { cat: "vol", f: 0.473176473 }, us_pt: { cat: "vol", f: 0.473176473 }, uk_pt: { cat: "vol", f: 0.56826125 },
  qt: { cat: "vol", f: 0.946352946 }, uk_qt: { cat: "vol", f: 1.1365225 },
  gal: { cat: "vol", f: 3.785411784 }, uk_gal: { cat: "vol", f: 4.54609 },
  barrel: { cat: "vol", f: 158.987294928 }, bushel: { cat: "vol", f: 35.23907016688 },
  // area (base: square metre)
  m2: { cat: "area", f: 1, metric: true }, ang2: { cat: "area", f: 1e-20, metric: true },
  in2: { cat: "area", f: 0.0254 ** 2 }, ft2: { cat: "area", f: 0.3048 ** 2 }, yd2: { cat: "area", f: 0.9144 ** 2 },
  mi2: { cat: "area", f: 1609.344 ** 2 }, Nmi2: { cat: "area", f: 1852 ** 2 },
  ar: { cat: "area", f: 100, metric: true }, ha: { cat: "area", f: 10000 }, Morgen: { cat: "area", f: 2500 },
  uk_acre: { cat: "area", f: 4046.8564224 }, us_acre: { cat: "area", f: 4046.87260987425 },
  // speed (base: metre/second)
  "m/s": { cat: "speed", f: 1, metric: true }, "m/sec": { cat: "speed", f: 1, metric: true },
  "m/h": { cat: "speed", f: 1 / 3600, metric: true }, "m/hr": { cat: "speed", f: 1 / 3600, metric: true },
  mph: { cat: "speed", f: 0.44704 }, kn: { cat: "speed", f: 0.5144444444444445 }, admkn: { cat: "speed", f: 0.5147733333333334 },
  // information (base: bit)
  bit: { cat: "info", f: 1, metric: true, bin: true }, byte: { cat: "info", f: 8, metric: true, bin: true },
};
const CONV_PREFIX = { Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 10, e: 10, d: 0.1, c: 0.01, m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18, z: 1e-21, y: 1e-24 };
const CONV_BIN_PREFIX = { Yi: 2 ** 80, Zi: 2 ** 70, Ei: 2 ** 60, Pi: 2 ** 50, Ti: 2 ** 40, Gi: 2 ** 30, Mi: 2 ** 20, Ki: 2 ** 10 };
const CONV_TEMP = new Set(["C", "cel", "F", "fah", "K", "kel", "Rank", "Reau"]);

function convResolve(name) {
  if (CONV_UNITS[name]) return { unit: CONV_UNITS[name], mult: 1 };
  for (const [pre, mult] of Object.entries(CONV_BIN_PREFIX)) {
    if (name.startsWith(pre)) { const u = CONV_UNITS[name.slice(pre.length)]; if (u && u.bin) return { unit: u, mult }; }
  }
  for (const [pre, mult] of Object.entries(CONV_PREFIX)) {
    if (name.startsWith(pre)) { const u = CONV_UNITS[name.slice(pre.length)]; if (u && u.metric) return { unit: u, mult }; }
  }
  return null;
}
function tempToKelvin(x, u) {
  if (u === "C" || u === "cel") return x + 273.15;
  if (u === "F" || u === "fah") return ((x + 459.67) * 5) / 9;
  if (u === "K" || u === "kel") return x;
  if (u === "Rank") return (x * 5) / 9;
  return x * 1.25 + 273.15; // Réaumur
}
function tempFromKelvin(k, u) {
  if (u === "C" || u === "cel") return k - 273.15;
  if (u === "F" || u === "fah") return (k * 9) / 5 - 459.67;
  if (u === "K" || u === "kel") return k;
  if (u === "Rank") return (k * 9) / 5;
  return (k - 273.15) * 0.8; // Réaumur
}
function convertUnits(x, from, to) {
  if (CONV_TEMP.has(from) || CONV_TEMP.has(to)) {
    if (!CONV_TEMP.has(from) || !CONV_TEMP.has(to)) throw new FormulaError("#N/A", "incompatible units");
    return tempFromKelvin(tempToKelvin(x, from), to);
  }
  const a = convResolve(from), b = convResolve(to);
  if (!a || !b) throw new FormulaError("#N/A", `unknown unit '${!a ? from : to}'`);
  if (a.unit.cat !== b.unit.cat) throw new FormulaError("#N/A", "incompatible units");
  return (x * a.unit.f * a.mult) / (b.unit.f * b.mult);
}

// ── Sorting / matrix / database helpers ─────────────────────────────────────

// three-way, type-ranked comparison for SORT/SORTN/UNIQUE:
// numbers < text < booleans < blanks (blanks always last)
function cmp3(a, b) {
  const rank = (x) => (x == null || x === "" ? 3 : typeof x === "boolean" ? 2 : typeof x === "number" || (typeof x === "string" && x.trim() !== "" && isFinite(Number(x))) ? 0 : 1);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) { const x = Number(a), y = Number(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (ra === 2) return (a ? 1 : 0) - (b ? 1 : 0);
  if (ra === 3) return 0;
  const x = String(a).toUpperCase(), y = String(b).toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
function uniqKey(v) {
  if (v == null || v === "") return "∅";
  if (typeof v === "number") return "n" + v;
  if (typeof v === "boolean") return "b" + v;
  const n = typeof v === "string" && v.trim() !== "" && isFinite(Number(v)) ? Number(v) : null;
  return n != null ? "n" + n : "s" + String(v).trim().toLowerCase();
}
function numMatrix(grid, name) {
  const rows = grid.rows.map((r) => r.map((x) => toNum(x)));
  if (!rows.length || rows.some((r) => r.length !== rows[0].length)) throw new FormulaError("#VALUE", `${name} needs a rectangular range`);
  return rows;
}
// LU decomposition with partial pivoting → determinant
function matDet(m) {
  const n = m.length;
  const a = m.map((r) => [...r]);
  let det = 1;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    if (Math.abs(a[piv][i]) < 1e-300) return 0;
    if (piv !== i) { const t = a[piv]; a[piv] = a[i]; a[i] = t; det = -det; }
    det *= a[i][i];
    for (let r = i + 1; r < n; r++) {
      const f = a[r][i] / a[i][i];
      for (let c = i; c < n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return det;
}
function matInverse(m) {
  const n = m.length;
  const a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    if (Math.abs(a[piv][i]) < 1e-300) throw new FormulaError("#NUM", "matrix is singular");
    if (piv !== i) { const t = a[piv]; a[piv] = a[i]; a[i] = t; }
    const d = a[i][i];
    for (let c = 0; c < 2 * n; c++) a[i][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i];
      for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return a.map((r) => r.slice(n));
}
// database-function core: header row + data rows, criteria grid → matching rows
function dbMatches(db, crit) {
  if (db.height < 2) throw new FormulaError("#VALUE", "database needs a header row and data");
  if (crit.height < 2) throw new FormulaError("#VALUE", "criteria needs a header row and at least one row");
  const headers = db.rows[0].map((x) => fmtScalar(x).trim().toLowerCase());
  const colOf = crit.rows[0].map((x) => {
    const name = fmtScalar(x).trim().toLowerCase();
    const idx = headers.indexOf(name);
    if (name !== "" && idx < 0) throw new FormulaError("#VALUE", `criteria field '${fmtScalar(x)}' not in the database`);
    return idx;
  });
  const out = [];
  for (let r = 1; r < db.height; r++) {
    const row = db.rows[r];
    let hit = false;
    for (let cr = 1; cr < crit.height && !hit; cr++) {
      let all = true;
      for (let cc = 0; cc < crit.width; cc++) {
        const c = crit.rows[cr][cc];
        if (c == null || c === "" || colOf[cc] < 0) continue;
        if (!matchesCriterion(row[colOf[cc]], c)) { all = false; break; }
      }
      if (all) hit = true;
    }
    if (hit) out.push(row);
  }
  return { headers, rows: out };
}
function dbFieldValues(args, ctx, name) {
  const db = argGrid(args[0], ctx);
  const fieldRaw = deArr(evalNode(args[1], ctx));
  const crit = argGrid(args[2], ctx);
  const { headers, rows } = dbMatches(db, crit);
  let col;
  const fn = cellNumeric(fieldRaw);
  if (typeof fieldRaw === "number" || (fn != null && typeof fieldRaw !== "boolean" && String(fieldRaw).trim() !== "")) col = Math.trunc(fn) - 1;
  else col = headers.indexOf(fmtScalar(fieldRaw).trim().toLowerCase());
  if (col < 0 || col >= headers.length) throw new FormulaError("#VALUE", `${name}: unknown field`);
  return rows.map((r) => r[col]);
}
const DB_AGGS = {
  DSUM: (xs) => FUNCS.SUM(xs), DAVERAGE: (xs) => FUNCS.AVERAGE(xs),
  DCOUNT: (xs) => FUNCS.COUNT(xs), DCOUNTA: (xs) => FUNCS.COUNTA(xs),
  DMAX: (xs) => FUNCS.MAX(xs), DMIN: (xs) => FUNCS.MIN(xs),
  DPRODUCT: (xs) => FUNCS.PRODUCT(xs), DSTDEV: (xs) => FUNCS.STDEV(xs),
  DSTDEVP: (xs) => FUNCS.STDEVP(xs), DVAR: (xs) => FUNCS.VAR(xs), DVARP: (xs) => FUNCS.VARP(xs),
  DGET: (xs) => {
    if (!xs.length) throw new FormulaError("#VALUE", "DGET found no match");
    if (xs.length > 1) throw new FormulaError("#NUM", "DGET found more than one match");
    return xs[0];
  },
};

function lambdaArg(node, ctx, name) {
  const v = evalNode(node, ctx);
  if (!isClosure(v)) throw new FormulaError("#VALUE", `${name} needs a LAMBDA`);
  return v;
}
const ERROR_TYPE_CODES = { "#NULL": 1, "#DIV/0": 2, "#VALUE": 3, "#REF": 4, "#NAME": 5, "#NUM": 6, "#N/A": 7, "#ERROR": 8, "#CIRCULAR": 8 };

// R1C1 absolute reference: R3C2 (row 3, col 2), optional :R5C4 range end
const R1C1_RE = /^R(\d{1,7})C(\d{1,5})$/i;

// ── Raw-argument registry ────────────────────────────────────────────────────
// These functions receive their argument AST nodes unevaluated: lambdas,
// reference probes, error catchers, dynamic references, and the
// array-shaping family (which wants grids, not flattened values).

const FUNCS_RAW = {
  // ── logical: LET / LAMBDA family ──
  LET: (args, ctx) => {
    if (args.length < 3 || args.length % 2 === 0) throw new FormulaError("#ERROR", "LET takes name/value pairs then a result");
    const saved = ctx.scope;
    ctx.scope = new Map(saved || []);
    try {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (args[i].k !== "name") throw new FormulaError("#VALUE", "LET names must be plain identifiers");
        ctx.scope.set(args[i].v, args[i + 1].k === "range" ? gridOfRange(args[i + 1], ctx) : evalNode(args[i + 1], ctx));
      }
      return evalNode(args[args.length - 1], ctx);
    } finally { ctx.scope = saved; }
  },
  LAMBDA: (args, ctx) => {
    if (args.length < 1) throw new FormulaError("#ERROR", "LAMBDA needs a body");
    const params = args.slice(0, -1).map((a) => {
      if (a.k !== "name") throw new FormulaError("#VALUE", "LAMBDA parameters must be plain identifiers");
      return a.v;
    });
    return { __closure: true, params, body: args[args.length - 1], scope: ctx.scope ? new Map(ctx.scope) : null };
  },
  MAP: (args, ctx) => {
    if (args.length < 2) throw new FormulaError("#ERROR", "MAP takes arrays then a LAMBDA");
    const grids = args.slice(0, -1).map((a) => argGrid(a, ctx));
    const fn = lambdaArg(args[args.length - 1], ctx, "MAP");
    const h0 = grids[0].height, w0 = grids[0].width;
    if (grids.some((g) => g.height !== h0 || g.width !== w0)) throw new FormulaError("#VALUE", "MAP arrays must be the same shape");
    const rows = [];
    for (let r = 0; r < h0; r++) {
      const row = [];
      for (let c = 0; c < w0; c++) row.push(deArr(callClosure(fn, grids.map((g) => g.rows[r][c]), ctx)));
      rows.push(row);
    }
    return new Arr(rows);
  },
  REDUCE: (args, ctx) => {
    if (args.length !== 3) throw new FormulaError("#ERROR", "REDUCE takes initial, array, LAMBDA");
    let acc = deArr(evalNode(args[0], ctx));
    const grid = argGrid(args[1], ctx);
    const fn = lambdaArg(args[2], ctx, "REDUCE");
    for (const row of grid.rows) for (const v of row) acc = deArr(callClosure(fn, [acc, v], ctx));
    return acc;
  },
  SCAN: (args, ctx) => {
    if (args.length !== 3) throw new FormulaError("#ERROR", "SCAN takes initial, array, LAMBDA");
    let acc = deArr(evalNode(args[0], ctx));
    const grid = argGrid(args[1], ctx);
    const fn = lambdaArg(args[2], ctx, "SCAN");
    const rows = grid.rows.map((row) => row.map((v) => { acc = deArr(callClosure(fn, [acc, v], ctx)); return acc; }));
    return new Arr(rows);
  },
  BYROW: (args, ctx) => {
    if (args.length !== 2) throw new FormulaError("#ERROR", "BYROW takes an array and a LAMBDA");
    const grid = argGrid(args[0], ctx);
    const fn = lambdaArg(args[1], ctx, "BYROW");
    return new Arr(grid.rows.map((row) => [deArr(callClosure(fn, [new Arr([row])], ctx))]));
  },
  BYCOL: (args, ctx) => {
    if (args.length !== 2) throw new FormulaError("#ERROR", "BYCOL takes an array and a LAMBDA");
    const grid = argGrid(args[0], ctx);
    const fn = lambdaArg(args[1], ctx, "BYCOL");
    const out = [];
    for (let c = 0; c < grid.width; c++) out.push(deArr(callClosure(fn, [new Arr(grid.rows.map((r) => [r[c]]))], ctx)));
    return new Arr([out]);
  },
  MAKEARRAY: (args, ctx) => {
    if (args.length !== 3) throw new FormulaError("#ERROR", "MAKEARRAY takes rows, columns, LAMBDA");
    const nr = Math.trunc(toNum(deArr(evalNode(args[0], ctx))));
    const nc = Math.trunc(toNum(deArr(evalNode(args[1], ctx))));
    if (nr < 1 || nc < 1 || nr * nc > MAX_RANGE_CELLS) throw new FormulaError("#NUM", "bad MAKEARRAY size");
    const fn = lambdaArg(args[2], ctx, "MAKEARRAY");
    const rows = [];
    for (let r = 1; r <= nr; r++) {
      const row = [];
      for (let c = 1; c <= nc; c++) row.push(deArr(callClosure(fn, [r, c], ctx)));
      rows.push(row);
    }
    return new Arr(rows);
  },
  // ── info probes (control their own evaluation to observe errors/refs) ──
  ISERR: (args, ctx) => {
    if (args.length !== 1) throw new FormulaError("#ERROR", "ISERR takes 1 arg");
    try { evalNode(args[0], ctx); return false; }
    catch (e) { if (e instanceof FormulaError) return e.code !== "#N/A"; throw e; }
  },
  "ERROR.TYPE": (args, ctx) => {
    if (args.length !== 1) throw new FormulaError("#ERROR", "ERROR.TYPE takes 1 arg");
    try { evalNode(args[0], ctx); }
    catch (e) { if (e instanceof FormulaError) return ERROR_TYPE_CODES[e.code] || 8; throw e; }
    throw new FormulaError("#N/A", "value is not an error");
  },
  TYPE: (args, ctx) => {
    if (args.length !== 1) throw new FormulaError("#ERROR", "TYPE takes 1 arg");
    let v;
    try { v = evalNode(args[0], ctx); } catch (e) { if (e instanceof FormulaError) return 16; throw e; }
    if (v instanceof Arr) return 64;
    if (typeof v === "boolean") return 4;
    if (typeof v === "number") return 1;
    if (v == null || v === "") return 1; // blank counts as a number, like Sheets
    return 2;
  },
  ISREF: (args) => args.length === 1 && (args[0].k === "ref" || args[0].k === "range"),
  ISFORMULA: (args, ctx) => {
    if (args.length !== 1 || (args[0].k !== "ref" && args[0].k !== "range")) throw new FormulaError("#VALUE", "ISFORMULA needs a reference");
    if (!ctx.getFormula) return false;
    const rc = args[0].k === "ref" ? args[0] : boundedRange(args[0], ctx).a;
    return ctx.getFormula(rc.row, rc.col) != null;
  },
  FORMULATEXT: (args, ctx) => {
    if (args.length !== 1 || (args[0].k !== "ref" && args[0].k !== "range")) throw new FormulaError("#VALUE", "FORMULATEXT needs a reference");
    if (!ctx.getFormula) throw new FormulaError("#N/A", "no formula context");
    const rc = args[0].k === "ref" ? args[0] : boundedRange(args[0], ctx).a;
    const f = ctx.getFormula(rc.row, rc.col);
    if (f == null) throw new FormulaError("#N/A", "referenced cell has no formula");
    return f;
  },
  CELL: (args, ctx) => {
    if (args.length !== 2) throw new FormulaError("#ERROR", "CELL takes info_type and a reference");
    const info = fmtScalar(deArr(evalNode(args[0], ctx))).toLowerCase();
    if (args[1].k !== "ref" && args[1].k !== "range") throw new FormulaError("#VALUE", "CELL needs a reference");
    const rc = args[1].k === "ref" ? args[1] : boundedRange(args[1], ctx).a;
    if (info === "row") return rc.row + 1;
    if (info === "col") return rc.col + 1;
    if (info === "address") return `$${colLabel(rc.col)}$${rc.row + 1}`;
    if (info === "contents") { const v = ctx.getCell(rc.row, rc.col, args[1].sheet); return v == null ? 0 : v; }
    if (info === "type") { const v = ctx.getCell(rc.row, rc.col, args[1].sheet); return v == null || v === "" ? "b" : typeof v === "string" && !(v.trim() !== "" && isFinite(Number(v))) ? "l" : "v"; }
    throw new FormulaError("#VALUE", `CELL info_type '${info}' not supported`);
  },
  // ── dynamic references ──
  INDIRECT: (args, ctx) => {
    if (args.length < 1 || args.length > 2) throw new FormulaError("#ERROR", "INDIRECT takes a reference string");
    const text = fmtScalar(deArr(evalNode(args[0], ctx))).trim();
    const a1 = args.length < 2 || truthy(deArr(evalNode(args[1], ctx)));
    let sheet = null, body = text;
    const bang = text.lastIndexOf("!");
    if (bang >= 0) {
      sheet = text.slice(0, bang).replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
      body = text.slice(bang + 1);
    }
    const parseOne = (part) => {
      if (a1) { const rc = parseCellRef(part); if (!rc) throw new FormulaError("#REF", `bad reference '${part}'`); return rc; }
      const m = R1C1_RE.exec(part);
      if (!m) throw new FormulaError("#REF", `bad R1C1 reference '${part}'`);
      return { row: parseInt(m[1], 10) - 1, col: parseInt(m[2], 10) - 1 };
    };
    const colon = body.indexOf(":");
    if (colon < 0) {
      const rc = parseOne(body);
      return ctx.getCell(rc.row, rc.col, sheet);
    }
    const a = parseOne(body.slice(0, colon)), b = parseOne(body.slice(colon + 1));
    return gridOfRange({ k: "range", a, b, sheet }, ctx);
  },
  OFFSET: (args, ctx) => {
    if (args.length < 3 || args.length > 5) throw new FormulaError("#ERROR", "OFFSET takes reference, rows, cols, [height], [width]");
    if (args[0].k !== "ref" && args[0].k !== "range") throw new FormulaError("#VALUE", "OFFSET needs a reference");
    const base = args[0].k === "ref" ? { a: args[0], b: args[0] } : boundedRange(args[0], ctx);
    const dr = Math.trunc(toNum(deArr(evalNode(args[1], ctx))));
    const dc = Math.trunc(toNum(deArr(evalNode(args[2], ctx))));
    const height = args.length > 3 ? Math.trunc(toNum(deArr(evalNode(args[3], ctx)))) : Math.abs(base.b.row - base.a.row) + 1;
    const width = args.length > 4 ? Math.trunc(toNum(deArr(evalNode(args[4], ctx)))) : Math.abs(base.b.col - base.a.col) + 1;
    if (height < 1 || width < 1) throw new FormulaError("#REF", "OFFSET size must be positive");
    const r0 = Math.min(base.a.row, base.b.row) + dr, c0 = Math.min(base.a.col, base.b.col) + dc;
    if (r0 < 0 || c0 < 0 || r0 + height > (ctx.rowCount ?? 100000) || c0 + width > (ctx.colCount ?? 16384)) throw new FormulaError("#REF", "OFFSET out of range");
    if (height === 1 && width === 1) return ctx.getCell(r0, c0, args[0].sheet);
    return gridOfRange({ k: "range", a: { row: r0, col: c0 }, b: { row: r0 + height - 1, col: c0 + width - 1 }, sheet: args[0].sheet }, ctx);
  },
  XMATCH: (args, ctx) => {
    if (args.length < 2 || args.length > 4) throw new FormulaError("#ERROR", "XMATCH takes value, range, [match_mode], [search_mode]");
    const needle = deArr(evalNode(args[0], ctx));
    const vec = argGrid(args[1], ctx).flat();
    const mode = args.length > 2 ? Math.trunc(toNum(deArr(evalNode(args[2], ctx)))) : 0;
    const search = args.length > 3 ? Math.trunc(toNum(deArr(evalNode(args[3], ctx)))) : 1;
    const idxs = search < 0 ? [...vec.keys()].reverse() : [...vec.keys()];
    let best = -1, bestVal = null;
    for (const i of idxs) {
      const v = vec[i];
      if (v == null || v === "") continue;
      try {
        if (mode === 2) { if (matchesCriterion(v, needle)) return i + 1; continue; }
        if (cmp("=", v, needle ?? "")) return i + 1;
        if (mode === -1 && cmp("<=", v, needle ?? "") && (best < 0 || cmp(">", v, bestVal))) { best = i; bestVal = v; }
        if (mode === 1 && cmp(">=", v, needle ?? "") && (best < 0 || cmp("<", v, bestVal))) { best = i; bestVal = v; }
      } catch (_) {}
    }
    if (best >= 0) return best + 1;
    throw new FormulaError("#N/A", "no match found");
  },
  // ── array shaping ──
  ARRAYFORMULA: (args, ctx) => {
    if (args.length !== 1) throw new FormulaError("#ERROR", "ARRAYFORMULA takes 1 arg");
    return args[0].k === "range" ? gridOfRange(args[0], ctx) : evalNode(args[0], ctx);
  },
  FILTER: (args, ctx) => {
    if (args.length < 2) throw new FormulaError("#ERROR", "FILTER takes a range and conditions");
    const src = argGrid(args[0], ctx);
    const conds = args.slice(1).map((a) => argGrid(a, ctx));
    const byRow = conds.every((c) => c.width === 1 && c.height === src.height);
    const byCol = !byRow && conds.every((c) => c.height === 1 && c.width === src.width);
    if (!byRow && !byCol) throw new FormulaError("#VALUE", "FILTER conditions must match the range's rows or columns");
    const rows = [];
    if (byRow) {
      for (let r = 0; r < src.height; r++) if (conds.every((c) => truthy(c.rows[r][0]))) rows.push([...src.rows[r]]);
    } else {
      const keep = [];
      for (let c = 0; c < src.width; c++) if (conds.every((g) => truthy(g.rows[0][c]))) keep.push(c);
      if (keep.length) for (const row of src.rows) rows.push(keep.map((c) => row[c]));
    }
    if (!rows.length) throw new FormulaError("#N/A", "FILTER found no matches");
    return new Arr(rows);
  },
  SORT: (args, ctx) => {
    if (!args.length) throw new FormulaError("#ERROR", "SORT takes a range");
    const src = argGrid(args[0], ctx);
    const specs = [];
    for (let i = 1; i < args.length; i += 2) {
      const keyRaw = args[i].k === "range" ? gridOfRange(args[i], ctx) : evalNode(args[i], ctx);
      const asc = i + 1 < args.length ? truthy(deArr(evalNode(args[i + 1], ctx))) : true;
      let keys;
      if (keyRaw instanceof Arr) {
        if (keyRaw.width !== 1 || keyRaw.height !== src.height) throw new FormulaError("#VALUE", "sort column must be one column the height of the range");
        keys = keyRaw.rows.map((r) => r[0]);
      } else {
        const idx = Math.trunc(toNum(keyRaw));
        if (idx < 1 || idx > src.width) throw new FormulaError("#VALUE", "sort column out of range");
        keys = src.rows.map((r) => r[idx - 1]);
      }
      specs.push({ keys, asc });
    }
    if (!specs.length) specs.push({ keys: src.rows.map((r) => r[0]), asc: true });
    const order = [...src.rows.keys()].sort((x, y) => {
      for (const s of specs) {
        const d = cmp3(s.keys[x], s.keys[y]);
        if (d) return s.asc ? d : -d;
      }
      return x - y;
    });
    return new Arr(order.map((i) => [...src.rows[i]]));
  },
  SORTN: (args, ctx) => {
    const sorted = FUNCS_RAW.SORT([args[0], ...args.slice(3)], ctx);
    const n = args.length > 1 ? Math.trunc(toNum(deArr(evalNode(args[1], ctx)))) : 1;
    const mode = args.length > 2 ? Math.trunc(toNum(deArr(evalNode(args[2], ctx)))) : 0;
    if (n < 0 || mode < 0 || mode > 3) throw new FormulaError("#NUM", "bad SORTN options");
    const rowKey = (row) => row.map(uniqKey).join("¦");
    let rows = sorted.rows;
    if (mode === 2) { const seen = new Set(); rows = rows.filter((r) => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true; }); }
    let out;
    if (mode === 1 && rows.length > n && n > 0) {
      const kn = rowKey(rows[n - 1]);
      let end = n;
      while (end < rows.length && rowKey(rows[end]) === kn) end++;
      out = rows.slice(0, end);
    } else if (mode === 3) {
      out = [];
      const seen = new Set();
      for (const r of rows) {
        const k = rowKey(r);
        if (seen.has(k)) { if (out.some((o) => rowKey(o) === k)) out.push(r); continue; }
        if (seen.size >= n) continue;
        seen.add(k);
        out.push(r);
      }
    } else {
      out = rows.slice(0, n);
    }
    if (!out.length) throw new FormulaError("#N/A", "SORTN returned nothing");
    return new Arr(out.map((r) => [...r]));
  },
  UNIQUE: (args, ctx) => {
    if (args.length < 1 || args.length > 3) throw new FormulaError("#ERROR", "UNIQUE takes a range, [by_column], [exactly_once]");
    let src = argGrid(args[0], ctx);
    const byCol = args.length > 1 && truthy(deArr(evalNode(args[1], ctx)));
    const once = args.length > 2 && truthy(deArr(evalNode(args[2], ctx)));
    let rows = src.rows;
    if (byCol) rows = rows[0].map((_, c) => rows.map((r) => r[c])); // transpose → dedupe "rows" → transpose back
    const counts = new Map();
    for (const r of rows) { const k = r.map(uniqKey).join("¦"); counts.set(k, (counts.get(k) || 0) + 1); }
    const seen = new Set();
    let out = [];
    for (const r of rows) {
      const k = r.map(uniqKey).join("¦");
      if (seen.has(k)) continue;
      seen.add(k);
      if (once && counts.get(k) !== 1) continue;
      out.push(r);
    }
    if (!out.length) throw new FormulaError("#N/A", "UNIQUE returned nothing");
    if (byCol) out = out[0].map((_, c) => out.map((r) => r[c]));
    return new Arr(out.map((r) => [...r]));
  },
  SPLIT: (args, ctx) => {
    if (args.length < 2 || args.length > 4) throw new FormulaError("#ERROR", "SPLIT takes text, delimiter, [split_by_each], [remove_empty]");
    const text = fmtScalar(deArr(evalNode(args[0], ctx)));
    const delim = fmtScalar(deArr(evalNode(args[1], ctx)));
    const each = args.length < 3 || truthy(deArr(evalNode(args[2], ctx)));
    const removeEmpty = args.length < 4 || truthy(deArr(evalNode(args[3], ctx)));
    if (delim === "") throw new FormulaError("#VALUE", "empty delimiter");
    let parts;
    if (each) {
      const set = new Set([...delim]);
      parts = [];
      let cur = "";
      for (const ch of text) {
        if (set.has(ch)) { parts.push(cur); cur = ""; }
        else cur += ch;
      }
      parts.push(cur);
    } else {
      parts = text.split(delim);
    }
    if (removeEmpty) parts = parts.filter((p) => p !== "");
    if (!parts.length) parts = [""];
    return new Arr([parts.map((p) => { const n = p.trim() !== "" && isFinite(Number(p)) ? Number(p) : null; return n != null ? n : p; })]);
  },
  FLATTEN: (args, ctx) => {
    if (!args.length) throw new FormulaError("#ERROR", "FLATTEN takes ranges");
    const out = [];
    for (const a of args) for (const v of argGrid(a, ctx).flat()) out.push([v]);
    return new Arr(out);
  },
  TRANSPOSE: (args, ctx) => {
    if (args.length !== 1) throw new FormulaError("#ERROR", "TRANSPOSE takes a range");
    const g = argGrid(args[0], ctx);
    return new Arr(g.rows[0].map((_, c) => g.rows.map((r) => r[c])));
  },
  SEQUENCE: (args, ctx) => {
    const s = (i, dflt) => (args.length > i ? Math.trunc(toNum(deArr(evalNode(args[i], ctx)))) : dflt);
    const nr = s(0, 1), nc = s(1, 1);
    const start = args.length > 2 ? toNum(deArr(evalNode(args[2], ctx))) : 1;
    const step = args.length > 3 ? toNum(deArr(evalNode(args[3], ctx))) : 1;
    if (nr < 1 || nc < 1 || nr * nc > MAX_RANGE_CELLS) throw new FormulaError("#NUM", "bad SEQUENCE size");
    const rows = [];
    let v = start;
    for (let r = 0; r < nr; r++) { const row = []; for (let c = 0; c < nc; c++) { row.push(v); v += step; } rows.push(row); }
    return new Arr(rows);
  },
  RANDARRAY: (args, ctx) => {
    const nr = args.length > 0 ? Math.trunc(toNum(deArr(evalNode(args[0], ctx)))) : 1;
    const nc = args.length > 1 ? Math.trunc(toNum(deArr(evalNode(args[1], ctx)))) : 1;
    if (nr < 1 || nc < 1 || nr * nc > MAX_RANGE_CELLS) throw new FormulaError("#NUM", "bad RANDARRAY size");
    return new Arr(Array.from({ length: nr }, () => Array.from({ length: nc }, () => Math.random())));
  },
  ARRAY_CONSTRAIN: (args, ctx) => {
    if (args.length !== 3) throw new FormulaError("#ERROR", "ARRAY_CONSTRAIN takes range, rows, cols");
    const g = argGrid(args[0], ctx);
    const nr = Math.trunc(toNum(deArr(evalNode(args[1], ctx))));
    const nc = Math.trunc(toNum(deArr(evalNode(args[2], ctx))));
    if (nr < 1 || nc < 1) throw new FormulaError("#NUM", "bad ARRAY_CONSTRAIN size");
    return new Arr(g.rows.slice(0, nr).map((r) => r.slice(0, nc)));
  },
  CHOOSEROWS: (args, ctx) => {
    if (args.length < 2) throw new FormulaError("#ERROR", "CHOOSEROWS takes a range and row numbers");
    const g = argGrid(args[0], ctx);
    const idxs = collectArgValues(args.slice(1), { ...ctx }).map((x) => Math.trunc(toNum(x)));
    const rows = idxs.map((i) => {
      const r = i < 0 ? g.height + i : i - 1;
      if (r < 0 || r >= g.height) throw new FormulaError("#VALUE", "row number out of range");
      return [...g.rows[r]];
    });
    return new Arr(rows);
  },
  CHOOSECOLS: (args, ctx) => {
    if (args.length < 2) throw new FormulaError("#ERROR", "CHOOSECOLS takes a range and column numbers");
    const g = argGrid(args[0], ctx);
    const idxs = collectArgValues(args.slice(1), { ...ctx }).map((x) => Math.trunc(toNum(x)));
    const cols = idxs.map((i) => {
      const c = i < 0 ? g.width + i : i - 1;
      if (c < 0 || c >= g.width) throw new FormulaError("#VALUE", "column number out of range");
      return c;
    });
    return new Arr(g.rows.map((r) => cols.map((c) => r[c])));
  },
  HSTACK: (args, ctx) => {
    if (!args.length) throw new FormulaError("#ERROR", "HSTACK takes ranges");
    const grids = args.map((a) => argGrid(a, ctx));
    const height = Math.max(...grids.map((g) => g.height));
    const rows = [];
    for (let r = 0; r < height; r++) {
      const row = [];
      for (const g of grids) for (let c = 0; c < g.width; c++) row.push(r < g.height ? g.rows[r][c] : null);
      rows.push(row);
    }
    return new Arr(rows);
  },
  VSTACK: (args, ctx) => {
    if (!args.length) throw new FormulaError("#ERROR", "VSTACK takes ranges");
    const grids = args.map((a) => argGrid(a, ctx));
    const width = Math.max(...grids.map((g) => g.width));
    const rows = [];
    for (const g of grids) for (const r of g.rows) rows.push([...r, ...Array.from({ length: width - r.length }, () => null)]);
    return new Arr(rows);
  },
  TOROW: (args, ctx) => {
    const g = argGrid(args[0], ctx);
    const ignore = args.length > 1 ? Math.trunc(toNum(deArr(evalNode(args[1], ctx)))) : 0;
    const byCol = args.length > 2 && truthy(deArr(evalNode(args[2], ctx)));
    let vals = byCol ? g.rows[0].map((_, c) => g.rows.map((r) => r[c])).flat() : g.flat();
    if (ignore === 1 || ignore === 3) vals = vals.filter((v) => v != null && v !== "");
    if (!vals.length) vals = [null];
    return new Arr([vals]);
  },
  TOCOL: (args, ctx) => {
    const row = FUNCS_RAW.TOROW(args, ctx);
    return new Arr(row.rows[0].map((v) => [v]));
  },
  WRAPROWS: (args, ctx) => {
    if (args.length < 2) throw new FormulaError("#ERROR", "WRAPROWS takes a vector and a wrap count");
    const vals = argGrid(args[0], ctx).flat();
    const count = Math.trunc(toNum(deArr(evalNode(args[1], ctx))));
    const pad = args.length > 2 ? deArr(evalNode(args[2], ctx)) : null;
    if (count < 1) throw new FormulaError("#NUM", "wrap count must be ≥ 1");
    const rows = [];
    for (let i = 0; i < vals.length; i += count) {
      const row = vals.slice(i, i + count);
      while (row.length < count) row.push(pad);
      rows.push(row);
    }
    return new Arr(rows.length ? rows : [[pad]]);
  },
  WRAPCOLS: (args, ctx) => {
    const wrapped = FUNCS_RAW.WRAPROWS(args, ctx);
    return new Arr(wrapped.rows[0].map((_, c) => wrapped.rows.map((r) => r[c])));
  },
  FREQUENCY: (args, ctx) => {
    if (args.length !== 2) throw new FormulaError("#ERROR", "FREQUENCY takes data and classes");
    const data = flatNumeric(argGrid(args[0], ctx).flat());
    const classesRaw = flatNumeric(argGrid(args[1], ctx).flat());
    const order = [...classesRaw.keys()].sort((a, b) => classesRaw[a] - classesRaw[b]);
    const counts = new Array(classesRaw.length + 1).fill(0);
    for (const x of data) {
      let placed = false;
      let prev = -Infinity;
      for (let k = 0; k < order.length; k++) {
        const bound = classesRaw[order[k]];
        if (x > prev && x <= bound) { counts[order[k]]++; placed = true; break; }
        prev = bound;
      }
      if (!placed) counts[classesRaw.length]++;
    }
    return new Arr(counts.map((c) => [c]));
  },
  // ── matrix math ──
  MMULT: (args, ctx) => {
    if (args.length !== 2) throw new FormulaError("#ERROR", "MMULT takes two ranges");
    const a = numMatrix(argGrid(args[0], ctx), "MMULT");
    const b = numMatrix(argGrid(args[1], ctx), "MMULT");
    if (a[0].length !== b.length) throw new FormulaError("#VALUE", "MMULT dimensions don't line up");
    const rows = [];
    for (let i = 0; i < a.length; i++) {
      const row = [];
      for (let j = 0; j < b[0].length; j++) {
        let s = 0;
        for (let k = 0; k < b.length; k++) s += a[i][k] * b[k][j];
        row.push(s);
      }
      rows.push(row);
    }
    return new Arr(rows);
  },
  MDETERM: (args, ctx) => {
    const m = numMatrix(argGrid(args[0], ctx), "MDETERM");
    if (m.length !== m[0].length) throw new FormulaError("#VALUE", "MDETERM needs a square range");
    return matDet(m);
  },
  MINVERSE: (args, ctx) => {
    const m = numMatrix(argGrid(args[0], ctx), "MINVERSE");
    if (m.length !== m[0].length) throw new FormulaError("#VALUE", "MINVERSE needs a square range");
    return new Arr(matInverse(m));
  },
  MUNIT: (args, ctx) => {
    const n = Math.trunc(toNum(deArr(evalNode(args[0], ctx))));
    if (n < 1 || n * n > MAX_RANGE_CELLS) throw new FormulaError("#NUM", "bad MUNIT size");
    return new Arr(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  },
  // ── regression over arrays ──
  TREND: (args, ctx) => regressArr(args, ctx, false),
  GROWTH: (args, ctx) => regressArr(args, ctx, true),
  LINEST: (args, ctx) => {
    const fit = regressFit(args, ctx, false);
    return new Arr([[fit.slope, fit.intercept]]);
  },
  LOGEST: (args, ctx) => {
    const fit = regressFit(args, ctx, true);
    return new Arr([[Math.exp(fit.slope), Math.exp(fit.intercept)]]);
  },
  SUMX2MY2: (args, ctx) => { const { xs, ys } = numericPairs(argGrid(args[0], ctx), argGrid(args[1], ctx)); return xs.reduce((a, x, i) => a + x * x - ys[i] * ys[i], 0); },
  SUMX2PY2: (args, ctx) => { const { xs, ys } = numericPairs(argGrid(args[0], ctx), argGrid(args[1], ctx)); return xs.reduce((a, x, i) => a + x * x + ys[i] * ys[i], 0); },
  SUMXMY2: (args, ctx) => { const { xs, ys } = numericPairs(argGrid(args[0], ctx), argGrid(args[1], ctx)); return xs.reduce((a, x, i) => a + (x - ys[i]) * (x - ys[i]), 0); },
};

// database functions share one raw implementation
for (const name of Object.keys(DB_AGGS)) {
  FUNCS_RAW[name] = (args, ctx) => {
    if (args.length !== 3) throw new FormulaError("#ERROR", `${name} takes database, field, criteria`);
    return DB_AGGS[name](dbFieldValues(args, ctx, name));
  };
}

// TREND / GROWTH / LINEST / LOGEST share a single-variable least-squares fit
function regressFit(args, ctx, logY) {
  if (!args.length) throw new FormulaError("#ERROR", "needs known_y values");
  const yGrid = argGrid(args[0], ctx);
  const ysRaw = flatNumeric(yGrid.flat());
  if (ysRaw.length < 2) throw new FormulaError("#DIV/0", "need 2+ data points");
  const xsRaw = args.length > 1 && args[1] ? flatNumeric(argGrid(args[1], ctx).flat()) : ysRaw.map((_, i) => i + 1);
  if (xsRaw.length !== ysRaw.length) throw new FormulaError("#N/A", "known_x and known_y must match");
  const ys = logY ? ysRaw.map((y) => { if (y <= 0) throw new FormulaError("#NUM", "GROWTH/LOGEST need positive y values"); return Math.log(y); }) : ysRaw;
  const fit = linFit(new Arr([ys]), new Arr([xsRaw]));
  return fit;
}
function regressArr(args, ctx, logY) {
  const fit = regressFit(args, ctx, logY);
  const newXGrid = args.length > 2 && args[2] ? argGrid(args[2], ctx) : args.length > 1 && args[1] ? argGrid(args[1], ctx) : null;
  const predict = (x) => { const y = fit.intercept + fit.slope * x; return logY ? Math.exp(y) : y; };
  if (!newXGrid) return new Arr(fit.xs.map((x) => [predict(x)]));
  return new Arr(newXGrid.rows.map((row) => row.map((x) => predict(toNum(x)))));
}

// Time-of-day fraction from "14:30", "2:30 PM", "…T14:30:05", or the
// fractional part of a numeric serial.
const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i;
function timeFracOf(v) {
  if (typeof v === "number") return v - Math.floor(v);
  const m = TIME_RE.exec(String(v ?? ""));
  if (!m) return null;
  let h = +m[1]; const mi = +m[2], se = +(m[3] || 0);
  const ap = (m[4] || "").toLowerCase();
  if (h > 23 || mi > 59 || se > 59) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return (h * 3600 + mi * 60 + se) / 86400;
}

function evalFormula(src, ctx) {
  let ast = parseFormula(src);
  if (ctx && ctx.names instanceof Map && ctx.names.size) ast = bindNames(ast, ctx.names);
  const val = evalNode(ast, ctx);
  return val;
}

function evalAst(ast, ctx) { return evalNode(ast, ctx); }

function evalNode(node, ctx) {
  switch (node.k) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "pct": return toNum(evalNode(node.v, ctx)) / 100;
    case "unary": {
      const v = toNum(evalNode(node.v, ctx));
      return node.op === "-" ? -v : v;
    }
    case "bin": {
      const a = toNum(evalNode(node.l, ctx));
      const b = toNum(evalNode(node.r, ctx));
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": if (b === 0) throw new FormulaError("#DIV/0", "division by zero"); return a / b;
        case "^": { const r = Math.pow(a, b); if (!isFinite(r)) throw new FormulaError("#VALUE", "overflow"); return r; }
      }
      throw new FormulaError("#ERROR", "bad operator");
    }
    case "concat": {
      const a = evalNode(node.l, ctx), b = evalNode(node.r, ctx);
      return fmtScalar(a) + fmtScalar(b);
    }
    case "cmp": return cmp(node.op, evalNode(node.l, ctx), evalNode(node.r, ctx));
    case "ref": {
      if (node.sheet) return ctx.getCell(node.row, node.col, node.sheet);
      if (node.row < 0 || node.col < 0 || node.row >= (ctx.rowCount ?? 100000) || node.col >= (ctx.colCount ?? 16384)) throw new FormulaError("#REF", "out of range");
      return ctx.getCell(node.row, node.col);
    }
    case "range": throw new FormulaError("#VALUE", "range not allowed here");
    case "func": return callFunc(node, ctx);
    case "arrlit": {
      const rows = node.rows.map((r) => r.map((el) => deArr(evalNode(el, ctx))));
      return new Arr(rows);
    }
    case "name": {
      const v = ctx.scope && ctx.scope.has(node.v) ? ctx.scope.get(node.v) : undefined;
      if (v === undefined) throw new FormulaError("#NAME", `unknown name '${node.v}'`);
      return v;
    }
    case "call": {
      const fn = evalNode(node.fn, ctx);
      if (!isClosure(fn)) throw new FormulaError("#VALUE", "not a LAMBDA");
      return callClosure(fn, node.args.map((a) => (a.k === "range" ? gridOfRange(a, ctx) : evalNode(a, ctx))), ctx);
    }
  }
  throw new FormulaError("#ERROR", "bad node");
}

// Invoke a LAMBDA closure with already-evaluated argument values.
function callClosure(fn, argVals, ctx) {
  if (argVals.length !== fn.params.length) throw new FormulaError("#VALUE", `LAMBDA takes ${fn.params.length} arg${fn.params.length === 1 ? "" : "s"}`);
  const saved = ctx.scope;
  ctx.scope = new Map(fn.scope || []);
  fn.params.forEach((p, i) => ctx.scope.set(p, argVals[i]));
  try { return evalNode(fn.body, ctx); }
  finally { ctx.scope = saved; }
}

function fmtScalar(v) {
  if (v instanceof Arr) v = v.top();
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isClosure(v)) throw new FormulaError("#VALUE", "expected a value, got a LAMBDA");
  return String(v);
}

function collectArgValues(args, ctx) {
  // flattens refs + ranges + scalars into a value list (for aggregates);
  // in-formula arrays (FILTER, SORT, {1;2}) flatten the same way ranges do
  const out = [];
  for (const a of args) {
    if (a.k === "range") {
      for (const { row, col } of rangeCellsCtx(a, ctx)) out.push(ctx.getCell(row, col, a.sheet));
    } else {
      const v = evalNode(a, ctx);
      if (v instanceof Arr) out.push(...v.flat());
      else out.push(v);
    }
  }
  return out;
}

// ── Grid helpers (structured 2-D argument access) ───────────────────────────
// argGrid turns any argument — range, array value, or scalar — into a
// rectangular 2-D value array. Everything array-shaped funnels through here.

function gridOfRange(node, ctx) {
  const { a, b } = boundedRange(node, ctx);
  const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
  const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_RANGE_CELLS) throw new FormulaError("#REF", "range too large");
  const rows = [];
  for (let r = r0; r <= r1; r++) {
    const row = [];
    for (let c = c0; c <= c1; c++) row.push(ctx.getCell(r, c, node.sheet));
    rows.push(row);
  }
  return new Arr(rows);
}

function argGrid(node, ctx) {
  if (!node) throw new FormulaError("#VALUE", "missing range argument");
  if (node.k === "range") return gridOfRange(node, ctx);
  const v = evalNode(node, ctx);
  if (v instanceof Arr) return v;
  if (isClosure(v)) throw new FormulaError("#VALUE", "expected a range, got a LAMBDA");
  return new Arr([[v]]);
}

// Aligned numeric pairs from two same-shaped grids (regression / covariance
// helpers): rows where either side is non-numeric are skipped, like Excel.
function numericPairs(g1, g2) {
  const a = g1.flat(), b = g2.flat();
  if (a.length !== b.length) throw new FormulaError("#N/A", "ranges must be the same size");
  const xs = [], ys = [];
  for (let i = 0; i < a.length; i++) {
    const x = typeof a[i] === "number" ? a[i] : cellNumeric(a[i]);
    const y = typeof b[i] === "number" ? b[i] : cellNumeric(b[i]);
    if (x != null && y != null && typeof a[i] !== "boolean" && typeof b[i] !== "boolean" && String(a[i]).trim() !== "" && String(b[i]).trim() !== "") { xs.push(x); ys.push(y); }
  }
  return { xs, ys };
}

// Evaluate an argument as a date: serial numbers round-trip, strings parse
// loosely ("2026-07-05" or "7/5/2026").
function argDate(node, ctx, name) {
  const v = evalNode(node, ctx);
  if (typeof v === "number") return serialToDate(v);
  const d = parseDateLoose(fmtScalar(v));
  if (!d) throw new FormulaError("#VALUE", `${name} needs a date`);
  return d;
}

// Optional holidays argument for NETWORKDAYS / WORKDAY → Set of serials.
function holidaySerials(node, ctx) {
  const set = new Set();
  if (!node) return set;
  if (node.k === "range") {
    for (const { row, col } of rangeCellsCtx(node, ctx)) {
      const d = parseDateLoose(fmtScalar(ctx.getCell(row, col, node.sheet) ?? ""));
      if (d) set.add(dateToSerial(d));
    }
  } else {
    const v = evalNode(node, ctx);
    const vals = v instanceof Arr ? v.flat() : [v];
    for (const x of vals) {
      if (typeof x === "number") { set.add(Math.trunc(x)); continue; }
      const d = parseDateLoose(fmtScalar(x ?? ""));
      if (d) set.add(dateToSerial(d));
    }
  }
  return set;
}

// Day-of-week straight from a serial: epoch 1899-12-30 was a Saturday,
// so serial % 7 → 0=Sat, 1=Sun, 2=Mon … 6=Fri (weekdays are 2–6).
function serialIsWeekday(s) { const dow = s % 7; return dow >= 2 && dow <= 6; }

function callFunc(node, ctx) {
  const { name, args } = node;
  switch (name) {
    case "IF": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "IF takes 2-3 args");
      const c = truthy(evalNode(args[0], ctx));
      if (c) return evalNode(args[1], ctx);
      return args.length === 3 ? evalNode(args[2], ctx) : false;
    }
    case "AND": { if (!args.length) throw new FormulaError("#ERROR", "AND needs args"); return args.every((a) => truthy(evalNode(a, ctx))); }
    case "OR": { if (!args.length) throw new FormulaError("#ERROR", "OR needs args"); return args.some((a) => truthy(evalNode(a, ctx))); }
    case "NOT": { if (args.length !== 1) throw new FormulaError("#ERROR", "NOT takes 1 arg"); return !truthy(evalNode(args[0], ctx)); }
    case "ROUND": case "ROUNDUP": case "ROUNDDOWN": {
      if (args.length < 1 || args.length > 2) throw new FormulaError("#ERROR", `${name} takes 1-2 args`);
      const v = toNum(evalNode(args[0], ctx));
      const d = args.length === 2 ? Math.trunc(toNum(evalNode(args[1], ctx))) : 0;
      if (d < -12 || d > 12) throw new FormulaError("#VALUE", "digits out of range");
      const f = Math.pow(10, d);
      if (name === "ROUND") return Math.round((v * f + (v >= 0 ? 1e-10 : -1e-10))) / f;
      if (name === "ROUNDUP") return (v >= 0 ? Math.ceil(v * f - 1e-10) : Math.floor(v * f + 1e-10)) / f;
      return (v >= 0 ? Math.floor(v * f + 1e-10) : Math.ceil(v * f - 1e-10)) / f;
    }
    case "TODAY": { if (args.length) throw new FormulaError("#ERROR", "TODAY takes no args"); const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10); }
    case "NOW": { if (args.length) throw new FormulaError("#ERROR", "NOW takes no args"); const d = new Date(); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
    case "LEN": { if (args.length !== 1) throw new FormulaError("#ERROR", "LEN takes 1 arg"); return String(fmtScalar(evalNode(args[0], ctx))).length; }
    case "UPPER": { if (args.length !== 1) throw new FormulaError("#ERROR", "UPPER takes 1 arg"); return fmtScalar(evalNode(args[0], ctx)).toUpperCase(); }
    case "LOWER": { if (args.length !== 1) throw new FormulaError("#ERROR", "LOWER takes 1 arg"); return fmtScalar(evalNode(args[0], ctx)).toLowerCase(); }
    case "TRIM": { if (args.length !== 1) throw new FormulaError("#ERROR", "TRIM takes 1 arg"); return fmtScalar(evalNode(args[0], ctx)).trim().replace(/\s+/g, " "); }
    case "CONCAT": case "CONCATENATE": return collectArgValues(args, ctx).map(fmtScalar).join("");
    case "COUNTIF": {
      if (args.length !== 2) throw new FormulaError("#ERROR", "COUNTIF takes 2 args");
      if (args[0].k !== "range" && args[0].k !== "ref") throw new FormulaError("#VALUE", "COUNTIF needs a range");
      const vals = args[0].k === "range" ? [...rangeCellsCtx(args[0], ctx)].map(({ row, col }) => ctx.getCell(row, col, args[0].sheet)) : [evalNode(args[0], ctx)];
      const crit = evalNode(args[1], ctx);
      return vals.filter((v) => matchesCriterion(v, crit)).length;
    }
    case "SUMIF": {
      if (args.length !== 2 && args.length !== 3) throw new FormulaError("#ERROR", "SUMIF takes 2-3 args");
      if (args[0].k !== "range") throw new FormulaError("#VALUE", "SUMIF needs a range");
      const cells = [...rangeCellsCtx(args[0], ctx)];
      const crit = evalNode(args[1], ctx);
      let sumCells = cells;
      if (args.length === 3) {
        if (args[2].k !== "range") throw new FormulaError("#VALUE", "SUMIF sum_range must be a range");
        const s = [...rangeCellsCtx(args[2], ctx)];
        if (s.length < cells.length) throw new FormulaError("#REF", "sum_range too small");
        sumCells = s;
      }
      let total = 0;
      cells.forEach((rc, i) => {
        if (matchesCriterion(ctx.getCell(rc.row, rc.col, args[0].sheet), crit)) {
          const sv = ctx.getCell(sumCells[i].row, sumCells[i].col, args.length === 3 ? args[2].sheet : args[0].sheet);
          const n = Number(String(sv ?? "").replace(/[$,\s]/g, ""));
          if (isFinite(n) && String(sv ?? "").trim() !== "") total += n;
        }
      });
      return total;
    }
    case "VLOOKUP": {
      if (args.length < 3 || args.length > 4) throw new FormulaError("#ERROR", "VLOOKUP takes 3-4 args");
      const needle = evalNode(args[0], ctx);
      const idx = Math.trunc(toNum(evalNode(args[2], ctx)));
      // range_lookup TRUE = approximate (largest value ≤ needle, data sorted
      // ascending); omitted stays exact so existing sheets don't shift
      const approx = args.length === 4 && truthy(evalNode(args[3], ctx));
      const g = argGrid(args[1], ctx);
      if (idx < 1 || idx > g.width) throw new FormulaError("#REF", "VLOOKUP column index out of range");
      let best = -1;
      for (let r = 0; r < g.height; r++) {
        const v = g.rows[r][0];
        let eq = false, keep = false;
        try {
          eq = cmp("=", v ?? "", needle ?? "");
          keep = approx && v != null && v !== "" && cmp("<=", v, needle ?? "");
        } catch (_) {}
        if (eq) return g.rows[r][idx - 1];
        if (keep) best = r;
      }
      if (approx && best >= 0) return g.rows[best][idx - 1];
      throw new FormulaError("#N/A", "no match found");
    }
    case "IFERROR": {
      if (args.length !== 2) throw new FormulaError("#ERROR", "IFERROR takes 2 args");
      try { return evalNode(args[0], ctx); } catch (e) { if (e instanceof FormulaError) return evalNode(args[1], ctx); throw e; }
    }
    case "IFS": {
      if (args.length < 2 || args.length % 2 !== 0) throw new FormulaError("#ERROR", "IFS takes condition/value pairs");
      for (let i = 0; i < args.length; i += 2) {
        if (truthy(evalNode(args[i], ctx))) return evalNode(args[i + 1], ctx);
      }
      throw new FormulaError("#N/A", "no IFS condition matched");
    }
    case "LEFT": case "RIGHT": {
      if (args.length < 1 || args.length > 2) throw new FormulaError("#ERROR", `${name} takes 1-2 args`);
      const s = fmtScalar(evalNode(args[0], ctx));
      const k = args.length === 2 ? Math.max(0, Math.trunc(toNum(evalNode(args[1], ctx)))) : 1;
      return name === "LEFT" ? s.slice(0, k) : k === 0 ? "" : s.slice(-k);
    }
    case "MID": {
      if (args.length !== 3) throw new FormulaError("#ERROR", "MID takes 3 args");
      const s = fmtScalar(evalNode(args[0], ctx));
      const start = Math.trunc(toNum(evalNode(args[1], ctx)));
      const len = Math.trunc(toNum(evalNode(args[2], ctx)));
      if (start < 1 || len < 0) throw new FormulaError("#VALUE", "bad MID bounds");
      return s.slice(start - 1, start - 1 + len);
    }
    case "FIND": case "SEARCH": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", `${name} takes 2-3 args`);
      let needle = fmtScalar(evalNode(args[0], ctx));
      let hay = fmtScalar(evalNode(args[1], ctx));
      if (name === "SEARCH") { needle = needle.toLowerCase(); hay = hay.toLowerCase(); } // SEARCH is case-insensitive
      const start = args.length === 3 ? Math.max(1, Math.trunc(toNum(evalNode(args[2], ctx)))) : 1;
      const idx = hay.indexOf(needle, start - 1);
      if (idx < 0) throw new FormulaError("#VALUE", "text not found");
      return idx + 1;
    }
    case "SUBSTITUTE": {
      if (args.length < 3 || args.length > 4) throw new FormulaError("#ERROR", "SUBSTITUTE takes 3-4 args");
      const s = fmtScalar(evalNode(args[0], ctx));
      const from = fmtScalar(evalNode(args[1], ctx));
      const to = fmtScalar(evalNode(args[2], ctx));
      if (from === "") return s;
      if (args.length === 4) {
        const nth = Math.trunc(toNum(evalNode(args[3], ctx)));
        if (nth < 1) throw new FormulaError("#VALUE", "instance must be ≥ 1");
        let i = -1;
        for (let k = 0; k < nth; k++) { i = s.indexOf(from, i + 1); if (i < 0) return s; }
        return s.slice(0, i) + to + s.slice(i + from.length);
      }
      return s.split(from).join(to);
    }
    case "TEXT": {
      if (args.length !== 2) throw new FormulaError("#ERROR", "TEXT takes 2 args");
      const v = evalNode(args[0], ctx);
      const fmt = fmtScalar(evalNode(args[1], ctx));
      const num = cellNumeric(v);
      if (/^0+$/.test(fmt) && num != null) return String(Math.round(num)).padStart(fmt.length, "0");
      if (fmt === "0.00" && num != null) return num.toFixed(2);
      if (fmt === "0.0" && num != null) return num.toFixed(1);
      if (fmt === "#,##0" && num != null) return Math.round(num).toLocaleString("en-US");
      if (fmt === "#,##0.00" && num != null) return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (fmt === "0%" && num != null) return Math.round(num * 100) + "%";
      if (fmt === "$#,##0.00" && num != null) return (num < 0 ? "-$" : "$") + Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const d = parseDateLoose(String(v)) || (num != null && num > 20000 && num < 200000 ? serialToDate(num) : null);
      if (d) {
        const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        if (/^m+\/d+\/y+$/i.test(fmt)) return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
        if (/^mmm d$/i.test(fmt)) return `${MO[d.getMonth()]} ${d.getDate()}`;
        if (/^yyyy-mm-dd$/i.test(fmt)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      return fmtScalar(v);
    }
    case "DATE": {
      if (args.length !== 3) throw new FormulaError("#ERROR", "DATE takes 3 args");
      const y = Math.trunc(toNum(evalNode(args[0], ctx)));
      const mo = Math.trunc(toNum(evalNode(args[1], ctx)));
      const da = Math.trunc(toNum(evalNode(args[2], ctx)));
      const d = new Date(y, mo - 1, da);
      if (isNaN(d)) throw new FormulaError("#VALUE", "bad date");
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    case "DAY": case "MONTH": case "YEAR": case "WEEKDAY": {
      if (args.length < 1 || args.length > 2) throw new FormulaError("#ERROR", `${name} takes 1 arg`);
      const d = argDate(args[0], ctx, name);
      if (name === "DAY") return d.getDate();
      if (name === "MONTH") return d.getMonth() + 1;
      if (name === "YEAR") return d.getFullYear();
      const type = args.length === 2 ? Math.trunc(toNum(evalNode(args[1], ctx))) : 1;
      if (type === 1) return d.getDay() + 1;          // Sunday=1 … Saturday=7
      if (type === 2) return ((d.getDay() + 6) % 7) + 1; // Monday=1 … Sunday=7
      if (type === 3) return (d.getDay() + 6) % 7;       // Monday=0 … Sunday=6
      throw new FormulaError("#NUM", "WEEKDAY type must be 1, 2, or 3");
    }
    case "INDEX": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "INDEX takes 2-3 args");
      const g = argGrid(args[0], ctx);
      const rIdx = Math.trunc(toNum(evalNode(args[1], ctx)));
      const cIdx = args.length === 3 ? Math.trunc(toNum(evalNode(args[2], ctx))) : 1;
      if (rIdx < 1 || rIdx > g.height || cIdx < 1 || cIdx > g.width) throw new FormulaError("#REF", "INDEX out of range");
      return g.rows[rIdx - 1][cIdx - 1];
    }
    case "MATCH": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "MATCH takes 2-3 args");
      // match type: 0 exact (our default — Excel defaults to 1), 1 = largest
      // value ≤ needle (sorted ascending), -1 = smallest value ≥ needle
      let mt = 0;
      if (args.length === 3) mt = Math.sign(Math.trunc(toNum(evalNode(args[2], ctx))));
      const needle = evalNode(args[0], ctx);
      const vec = argGrid(args[1], ctx).flat();
      let best = -1;
      for (let i = 0; i < vec.length; i++) {
        const v = vec[i];
        if (mt !== 0 && (v == null || v === "")) continue;
        let eq = false, keep = false;
        try {
          eq = cmp("=", v ?? "", needle ?? "");
          keep = mt === 1 ? cmp("<=", v, needle ?? "") : mt === -1 ? cmp(">=", v, needle ?? "") : false;
        } catch (_) {}
        if (eq) return i + 1;
        if (keep) best = i;
      }
      if (mt !== 0 && best >= 0) return best + 1;
      throw new FormulaError("#N/A", "no match found");
    }
    case "HLOOKUP": {
      if (args.length < 3 || args.length > 4) throw new FormulaError("#ERROR", "HLOOKUP takes 3-4 args");
      const needle = evalNode(args[0], ctx);
      const idx = Math.trunc(toNum(evalNode(args[2], ctx)));
      const approx = args.length === 4 && truthy(evalNode(args[3], ctx));
      const g = argGrid(args[1], ctx);
      if (idx < 1 || idx > g.height) throw new FormulaError("#REF", "HLOOKUP row index out of range");
      let best = -1;
      for (let c = 0; c < g.width; c++) {
        const v = g.rows[0][c];
        let eq = false, keep = false;
        try {
          eq = cmp("=", v ?? "", needle ?? "");
          keep = approx && v != null && v !== "" && cmp("<=", v, needle ?? "");
        } catch (_) {}
        if (eq) return g.rows[idx - 1][c];
        if (keep) best = c;
      }
      if (approx && best >= 0) return g.rows[idx - 1][best];
      throw new FormulaError("#N/A", "no match found");
    }
    case "XLOOKUP": {
      if (args.length < 3 || args.length > 4) throw new FormulaError("#ERROR", "XLOOKUP takes 3-4 args");
      const needle = evalNode(args[0], ctx);
      const look = argGrid(args[1], ctx).flat();
      const ret = argGrid(args[2], ctx).flat();
      if (ret.length < look.length) throw new FormulaError("#REF", "return range too small");
      for (let i = 0; i < look.length; i++) {
        let eq = false;
        try { eq = cmp("=", look[i] ?? "", needle ?? ""); } catch (_) {}
        if (eq) return ret[i];
      }
      if (args.length === 4) return evalNode(args[3], ctx);
      throw new FormulaError("#N/A", "no match found");
    }
    case "COUNTIFS": case "SUMIFS": case "AVERAGEIFS": case "MAXIFS": case "MINIFS": {
      const isAvg = name === "AVERAGEIFS", isMax = name === "MAXIFS", isMin = name === "MINIFS";
      const base = name === "COUNTIFS" ? 0 : 1;
      if (args.length < base + 2 || (args.length - base) % 2 !== 0) throw new FormulaError("#ERROR", `${name} takes ${base ? "a value range plus " : ""}range/criteria pairs`);
      let sumCells2 = null;
      if (base === 1) {
        if (args[0].k !== "range") throw new FormulaError("#VALUE", `${name} needs a range first`);
        sumCells2 = [...rangeCellsCtx(args[0], ctx)].map((rc) => ({ ...rc, sheet: args[0].sheet }));
      }
      const pairs = [];
      for (let i = base; i < args.length; i += 2) {
        if (args[i].k !== "range") throw new FormulaError("#VALUE", `${name} criteria range must be a range`);
        pairs.push({ cellsIn: [...rangeCellsCtx(args[i], ctx)], sheet: args[i].sheet, crit: evalNode(args[i + 1], ctx) });
      }
      const len = pairs[0].cellsIn.length;
      if (pairs.some((p) => p.cellsIn.length !== len) || (sumCells2 && sumCells2.length < len)) throw new FormulaError("#REF", "ranges must be the same size");
      let count = 0, total = 0, nnum = 0, best = null;
      for (let i = 0; i < len; i++) {
        if (pairs.every((p) => matchesCriterion(ctx.getCell(p.cellsIn[i].row, p.cellsIn[i].col, p.sheet), p.crit))) {
          count++;
          if (sumCells2) {
            const sv = ctx.getCell(sumCells2[i].row, sumCells2[i].col, sumCells2[i].sheet);
            const num = Number(String(sv ?? "").replace(/[$,\s]/g, ""));
            if (isFinite(num) && String(sv ?? "").trim() !== "") {
              total += num; nnum++;
              if (best == null || (isMax ? num > best : num < best)) best = num;
            }
          }
        }
      }
      if (name === "COUNTIFS") return count;
      if (isAvg) { if (!nnum) throw new FormulaError("#DIV/0", "no numeric matches"); return total / nnum; }
      if (isMax || isMin) return best == null ? 0 : best;
      return total;
    }
    case "AVERAGEIF": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "AVERAGEIF takes 2-3 args");
      if (args[0].k !== "range") throw new FormulaError("#VALUE", "AVERAGEIF needs a range");
      const cellsIn = [...rangeCellsCtx(args[0], ctx)];
      const crit = evalNode(args[1], ctx);
      let avgCells = cellsIn.map((rc) => ({ ...rc, sheet: args[0].sheet }));
      if (args.length === 3) {
        if (args[2].k !== "range") throw new FormulaError("#VALUE", "AVERAGEIF avg_range must be a range");
        const s2 = [...rangeCellsCtx(args[2], ctx)].map((rc) => ({ ...rc, sheet: args[2].sheet }));
        if (s2.length < cellsIn.length) throw new FormulaError("#REF", "avg_range too small");
        avgCells = s2;
      }
      let total = 0, nnum = 0;
      cellsIn.forEach((rc, i) => {
        if (matchesCriterion(ctx.getCell(rc.row, rc.col, args[0].sheet), crit)) {
          const sv = ctx.getCell(avgCells[i].row, avgCells[i].col, avgCells[i].sheet);
          const num = Number(String(sv ?? "").replace(/[$,\s]/g, ""));
          if (isFinite(num) && String(sv ?? "").trim() !== "") { total += num; nnum++; }
        }
      });
      if (!nnum) throw new FormulaError("#DIV/0", "no numeric matches");
      return total / nnum;
    }
    case "TEXTJOIN": {
      if (args.length < 3) throw new FormulaError("#ERROR", "TEXTJOIN takes a delimiter, ignore_empty, then values");
      const delim = fmtScalar(evalNode(args[0], ctx));
      const ignore = truthy(evalNode(args[1], ctx));
      const vals = collectArgValues(args.slice(2), ctx).map(fmtScalar);
      return (ignore ? vals.filter((v) => v !== "") : vals).join(delim);
    }
    case "SUMPRODUCT": {
      if (!args.length) throw new FormulaError("#ERROR", "SUMPRODUCT needs at least one range");
      const lists = args.map((a) => {
        const g = a.k === "range" ? gridOfRange(a, ctx) : evalNode(a, ctx);
        if (!(g instanceof Arr)) return [toNum(g)];
        return g.flat().map((v) => { if (typeof v === "boolean") return v ? 1 : 0; const n = cellNumeric(v); return n == null ? 0 : n; });
      });
      const len = lists[0].length;
      if (lists.some((l) => l.length !== len)) throw new FormulaError("#VALUE", "SUMPRODUCT ranges must be the same size");
      let total = 0;
      for (let i = 0; i < len; i++) { let prod = 1; for (const l of lists) prod *= l[i]; total += prod; }
      return total;
    }
    case "LARGE": case "SMALL": {
      if (args.length !== 2) throw new FormulaError("#ERROR", `${name} takes a range and k`);
      const xs = flatNumeric(argGrid(args[0], ctx).flat()).sort((x, y) => y - x);
      const k = Math.trunc(toNum(evalNode(args[1], ctx)));
      if (k < 1 || k > xs.length) throw new FormulaError("#VALUE", `${name} k out of range`);
      return name === "LARGE" ? xs[k - 1] : xs[xs.length - k];
    }
    case "RANK": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "RANK takes a value, a range, and an optional order");
      const x = toNum(evalNode(args[0], ctx));
      const xs = flatNumeric(argGrid(args[1], ctx).flat());
      if (!xs.includes(x)) throw new FormulaError("#N/A", "value not in range");
      const asc = args.length === 3 && truthy(evalNode(args[2], ctx));
      return 1 + xs.filter((v) => (asc ? v < x : v > x)).length;
    }
    case "CHOOSE": {
      if (args.length < 2) throw new FormulaError("#ERROR", "CHOOSE takes an index then values");
      const k = Math.trunc(toNum(evalNode(args[0], ctx)));
      if (k < 1 || k >= args.length) throw new FormulaError("#VALUE", "CHOOSE index out of range");
      return evalNode(args[k], ctx);
    }
    case "SWITCH": {
      if (args.length < 3) throw new FormulaError("#ERROR", "SWITCH takes a value then match/result pairs");
      const x = evalNode(args[0], ctx);
      let i = 1;
      for (; i + 1 < args.length; i += 2) {
        let eq = false;
        try { eq = cmp("=", x ?? "", evalNode(args[i], ctx) ?? ""); } catch (_) {}
        if (eq) return evalNode(args[i + 1], ctx);
      }
      if (i < args.length) return evalNode(args[i], ctx); // trailing default
      throw new FormulaError("#N/A", "no SWITCH case matched");
    }
    case "ISBLANK": case "ISNUMBER": case "ISTEXT": case "ISERROR": {
      if (args.length !== 1) throw new FormulaError("#ERROR", `${name} takes 1 arg`);
      let v;
      try { v = evalNode(args[0], ctx); } catch (e) { if (e instanceof FormulaError) return name === "ISERROR"; throw e; }
      if (name === "ISERROR") return false;
      if (name === "ISBLANK") return v == null || v === "";
      if (name === "ISNUMBER") return typeof v === "number";
      return typeof v === "string" && v !== "";
    }
    case "DATEVALUE": {
      if (args.length !== 1) throw new FormulaError("#ERROR", "DATEVALUE takes 1 arg");
      return dateToSerial(argDate(args[0], ctx, name));
    }
    case "DAYS": {
      if (args.length !== 2) throw new FormulaError("#ERROR", "DAYS takes end, start");
      return dateToSerial(argDate(args[0], ctx, name)) - dateToSerial(argDate(args[1], ctx, name));
    }
    case "DATEDIF": {
      if (args.length !== 3) throw new FormulaError("#ERROR", "DATEDIF takes start, end, unit");
      const d1 = argDate(args[0], ctx, name), d2 = argDate(args[1], ctx, name);
      const unit = fmtScalar(evalNode(args[2], ctx)).toUpperCase();
      const s1 = dateToSerial(d1), s2 = dateToSerial(d2);
      if (s2 < s1) throw new FormulaError("#VALUE", "end before start");
      if (unit === "D") return s2 - s1;
      let months = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
      if (d2.getDate() < d1.getDate()) months--;
      if (unit === "M") return months;
      if (unit === "Y") return Math.floor(months / 12);
      if (unit === "YM") return months % 12;
      throw new FormulaError("#VALUE", "DATEDIF unit must be D, M, Y, or YM");
    }
    case "EDATE": case "EOMONTH": {
      if (args.length !== 2) throw new FormulaError("#ERROR", `${name} takes a date and months`);
      const d = argDate(args[0], ctx, name);
      const m = Math.trunc(toNum(evalNode(args[1], ctx)));
      if (name === "EOMONTH") return isoDate(new Date(d.getFullYear(), d.getMonth() + m + 1, 0));
      const last = new Date(d.getFullYear(), d.getMonth() + m + 1, 0).getDate();
      return isoDate(new Date(d.getFullYear(), d.getMonth() + m, Math.min(d.getDate(), last)));
    }
    case "NETWORKDAYS": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "NETWORKDAYS takes start, end, [holidays]");
      const s1 = dateToSerial(argDate(args[0], ctx, name));
      const s2 = dateToSerial(argDate(args[1], ctx, name));
      const holidays = holidaySerials(args[2], ctx);
      const lo = Math.min(s1, s2), hi = Math.max(s1, s2);
      if (hi - lo > 100000) throw new FormulaError("#VALUE", "date span too large");
      let n = 0;
      for (let s = lo; s <= hi; s++) if (serialIsWeekday(s) && !holidays.has(s)) n++;
      return s1 <= s2 ? n : -n;
    }
    case "WORKDAY": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "WORKDAY takes a start date, days, [holidays]");
      let s = dateToSerial(argDate(args[0], ctx, name));
      let left = Math.trunc(toNum(evalNode(args[1], ctx)));
      if (Math.abs(left) > 100000) throw new FormulaError("#VALUE", "too many days");
      const holidays = holidaySerials(args[2], ctx);
      const step = left >= 0 ? 1 : -1;
      while (left !== 0) {
        s += step;
        if (serialIsWeekday(s) && !holidays.has(s)) left -= step;
      }
      return isoDate(serialToDate(s));
    }
    case "WEEKNUM": {
      if (args.length < 1 || args.length > 2) throw new FormulaError("#ERROR", "WEEKNUM takes a date");
      const d = argDate(args[0], ctx, name);
      const jan1 = new Date(d.getFullYear(), 0, 1);
      return Math.floor((dateToSerial(d) - dateToSerial(jan1) + jan1.getDay()) / 7) + 1;
    }
    case "IFNA": {
      if (args.length !== 2) throw new FormulaError("#ERROR", "IFNA takes 2 args");
      try { return evalNode(args[0], ctx); }
      catch (e) { if (e instanceof FormulaError && e.code === "#N/A") return evalNode(args[1], ctx); throw e; }
    }
    case "ISNA": {
      if (args.length !== 1) throw new FormulaError("#ERROR", "ISNA takes 1 arg");
      try { evalNode(args[0], ctx); return false; }
      catch (e) { if (e instanceof FormulaError) return e.code === "#N/A"; throw e; }
    }
    case "NPV": {
      if (args.length < 2) throw new FormulaError("#ERROR", "NPV takes a rate then values");
      const rate = toNum(evalNode(args[0], ctx));
      if (rate <= -1) throw new FormulaError("#VALUE", "bad NPV rate");
      const xs = flatNumeric(collectArgValues(args.slice(1), ctx));
      return xs.reduce((a, x, i) => a + x / Math.pow(1 + rate, i + 1), 0);
    }
    case "IRR": {
      if (args.length < 1 || args.length > 2) throw new FormulaError("#ERROR", "IRR takes a range of cash flows");
      const xs = flatNumeric(argGrid(args[0], ctx).flat());
      if (xs.length < 2 || !xs.some((x) => x > 0) || !xs.some((x) => x < 0)) throw new FormulaError("#VALUE", "IRR needs mixed-sign cash flows");
      let r = args.length === 2 ? toNum(evalNode(args[1], ctx)) : 0.1;
      for (let i = 0; i < 60; i++) {
        let f = 0, df = 0;
        xs.forEach((x, k) => { const d = Math.pow(1 + r, k); f += x / d; df -= (k * x) / (d * (1 + r)); });
        if (Math.abs(df) < 1e-12) break;
        const next = r - f / df;
        if (!isFinite(next) || next <= -0.999999) break;
        if (Math.abs(next - r) < 1e-9) return next;
        r = next;
      }
      throw new FormulaError("#VALUE", "IRR didn't converge");
    }
    case "LOOKUP": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "LOOKUP takes a value, a lookup range, and an optional result range");
      const needle = evalNode(args[0], ctx);
      const look = argGrid(args[1], ctx).flat();
      const res = args.length === 3 ? argGrid(args[2], ctx).flat() : look;
      let best = -1;
      for (let i = 0; i < look.length; i++) {
        const v = look[i];
        if (v == null || v === "") continue;
        try { if (cmp("<=", v, needle ?? "")) best = i; } catch (_) {}
      }
      if (best < 0) throw new FormulaError("#N/A", "no match found");
      return res[Math.min(best, res.length - 1)];
    }
    case "ROW": case "COLUMN": {
      if (args.length > 1) throw new FormulaError("#ERROR", `${name} takes 0-1 args`);
      if (args.length === 1) {
        const a0 = args[0];
        if (a0.k === "ref") return name === "ROW" ? a0.row + 1 : a0.col + 1;
        if (a0.k === "range") return name === "ROW" ? Math.min(a0.a.row, a0.b.row) + 1 : Math.min(a0.a.col, a0.b.col) + 1;
        throw new FormulaError("#VALUE", `${name} needs a reference`);
      }
      if (!ctx.cur) throw new FormulaError("#ERROR", `${name}() needs a cell context`);
      return name === "ROW" ? ctx.cur.r + 1 : ctx.cur.c + 1;
    }
    case "ROWS": case "COLUMNS": {
      if (args.length !== 1) throw new FormulaError("#VALUE", `${name} needs a range`);
      if (args[0].k === "ref") return 1;
      if (args[0].k === "range") { const { a, b } = boundedRange(args[0], ctx); return name === "ROWS" ? Math.abs(b.row - a.row) + 1 : Math.abs(b.col - a.col) + 1; }
      const g = argGrid(args[0], ctx);
      return name === "ROWS" ? g.height : g.width;
    }
    case "ADDRESS": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "ADDRESS takes row, column, [abs]");
      const r = Math.trunc(toNum(evalNode(args[0], ctx))), c = Math.trunc(toNum(evalNode(args[1], ctx)));
      if (r < 1 || c < 1) throw new FormulaError("#VALUE", "bad ADDRESS");
      const abs = args.length === 3 ? Math.trunc(toNum(evalNode(args[2], ctx))) : 1;
      const cl = colLabel(c - 1);
      if (abs === 2) return `${cl}$${r}`;
      if (abs === 3) return `$${cl}${r}`;
      if (abs === 4) return `${cl}${r}`;
      return `$${cl}$${r}`;
    }
    default: {
      // a LET/LAMBDA-bound name used in call position: f(5) where f is a closure
      if (ctx.scope && ctx.scope.has(name) && isClosure(ctx.scope.get(name))) {
        return callClosure(ctx.scope.get(name), args.map((a) => (a.k === "range" ? gridOfRange(a, ctx) : evalNode(a, ctx))), ctx);
      }
      // raw registry: these control their own argument evaluation
      // (lambdas, references-as-references, error probes, dynamic refs)
      const raw = FUNCS_RAW[name];
      if (raw) return raw(args, ctx);
      const fn = FUNCS[name];
      if (!fn) throw new FormulaError("#NAME", `unknown function ${name}`);
      return fn(collectArgValues(args, ctx), { args, ctx });
    }
  }
}

// Excel wildcard criteria: * = any run, ? = one character, ~* / ~? literal.
function wildcardRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && (pattern[i + 1] === "*" || pattern[i + 1] === "?")) { out += "\\" + pattern[i + 1]; i++; }
    else if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$", "i");
}

function matchesCriterion(v, crit) {
  const s = String(crit ?? "").trim();
  const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(s);
  const op = m ? m[1] : "=";
  const body = m ? m[2] : s;
  if ((op === "=" || op === "<>") && /[*?]/.test(body)) {
    const hit = wildcardRegex(body).test(String(v ?? ""));
    return op === "<>" ? !hit : hit;
  }
  if (m) { try { return cmp(m[1], v ?? "", m[2]); } catch (_) { return false; } }
  // plain equality (numeric-aware, case-insensitive)
  try { return cmp("=", v ?? "", crit ?? ""); } catch (_) { return false; }
}

// ── Dependency extraction (for recalc graph + circular detection) ────────────

function refsFromAst(ast, bounds) {
  const refs = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.k === "ref") { if (!n.sheet) refs.push({ row: n.row, col: n.col }); return; }
    if (n.k === "range") {
      if (n.sheet) return;
      const { a, b } = boundedRange(n, bounds);
      try { for (const rc of rangeCells(a, b)) refs.push(rc); } catch (_) {}
      return;
    }
    if (n.k === "func") { n.args.forEach(walk); return; }
    if (n.k === "call") { walk(n.fn); n.args.forEach(walk); return; }
    if (n.k === "arrlit") { for (const row of n.rows) row.forEach(walk); return; }
    if (n.l) walk(n.l);
    if (n.r) walk(n.r);
    if (n.v && typeof n.v === "object") walk(n.v);
  })(ast);
  return refs;
}

function extractRefs(src, bounds, names) {
  let ast;
  try { ast = parseFormula(src); } catch (_) { return []; }
  if (names && names.size) ast = bindNames(ast, names);
  return refsFromAst(ast, bounds);
}

// Named-range binding — rewrite free identifier ("name") nodes into the
// range/ref AST they point at, so a name behaves exactly like the cells it
// stands for (dependencies, criteria functions, cross-sheet reads all just
// work). Names bound by an enclosing LET/LAMBDA shadow a same-named range,
// matching Excel. `names` is a Map of UPPERCASE name -> range|ref AST node.
// Returns a new tree; the input is left untouched.
function cloneNode(n) { return JSON.parse(JSON.stringify(n)); }
function bindNames(node, names, bound) {
  if (!node || typeof node !== "object") return node;
  switch (node.k) {
    case "name": {
      if (bound && bound.has(node.v)) return node;
      const def = names && names.get(node.v);
      return def ? cloneNode(def) : node;
    }
    case "func": {
      let nb = bound;
      if (node.name === "LET" || node.name === "LAMBDA") {
        nb = new Set(bound || []);
        const last = node.args.length - 1;
        node.args.forEach((a, i) => {
          const isNamePos = node.name === "LAMBDA" ? i < last : i % 2 === 0 && i < last;
          if (isNamePos && a && a.k === "name") nb.add(a.v);
        });
      }
      return { ...node, args: node.args.map((a) => bindNames(a, names, nb)) };
    }
    case "call": return { ...node, fn: bindNames(node.fn, names, bound), args: node.args.map((a) => bindNames(a, names, bound)) };
    case "arrlit": return { ...node, rows: node.rows.map((row) => row.map((el) => bindNames(el, names, bound))) };
    default: {
      const out = { ...node };
      if (node.l) out.l = bindNames(node.l, names, bound);
      if (node.r) out.r = bindNames(node.r, names, bound);
      if (node.v && typeof node.v === "object") out.v = bindNames(node.v, names, bound);
      return out;
    }
  }
}

// Formulas whose reads can't be known statically (INDIRECT/OFFSET build
// references at eval time) get a second recalc pass — see recalcSheet.
function hasDynamicRefs(ast) {
  let found = false;
  (function walk(n) {
    if (!n || typeof n !== "object" || found) return;
    if (n.k === "func") {
      if (n.name === "INDIRECT" || n.name === "OFFSET") { found = true; return; }
      n.args.forEach(walk); return;
    }
    if (n.k === "call") { walk(n.fn); n.args.forEach(walk); return; }
    if (n.k === "arrlit") { for (const row of n.rows) row.forEach(walk); return; }
    if (n.l) walk(n.l);
    if (n.r) walk(n.r);
    if (n.v && typeof n.v === "object") walk(n.v);
  })(ast);
  return found;
}
// RouteReady Operations Workbook · CSV utilities (draft for workbook.js)
// RFC-4180-ish: quoted values, embedded commas, embedded quotes (""),
// embedded newlines inside quotes, CRLF/LF/CR line endings, BOM strip.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = String(text ?? "");
  const n = s.length;
  if (s.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < n) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { if (s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // drop single trailing fully-empty row (file ended with newline)
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

// ─── Workbook templates ──────────────────────────────────────────────────────
// Client-defined starter workbooks (same approach as the scheduling
// engine's STANDARD_SCENARIOS: plain data, easy to extend). Each
// template describes blocks; sheets carry a header row plus optional
// example rows. Cells land as plain values — no formulas are imported
// from templates except where explicitly listed, and those go through
// the same parser as user input.

const WB_TEMPLATES = [
  {
    key: "route-coverage",
    name: "Weekly Route Coverage Plan",
    category: "Dispatch",
    desc: "Routes vs. staffed drivers for the week, with coverage math and a pre-week checklist.",
    build: () => ({
      title: "Weekly Route Coverage Plan",
      description: "Plan route coverage for the week — staffing per day, gaps, and backups.",
      blocks: [
        { type: "text", title: "How to use this plan", html: "<p>Track <strong>routes vs. staffed drivers</strong> for each day this week. Fill the Coverage sheet, then work the checklist before publishing the schedule.</p><ul><li>Gap = Routes − Staffed (formula, column E)</li><li>Flag any day with a positive gap</li></ul>" },
        { type: "sheet", title: "Coverage", sheets: [{ name: "This week", cols: ["Day", "Routes", "Staffed", "Backups", "Gap", "Notes"], colWidths: { 0: 110, 5: 220 }, rows: [
          ["Monday", "18", "17", "2", "=B2-C2", ""],
          ["Tuesday", "18", "18", "2", "=B3-C3", ""],
          ["Wednesday", "19", "18", "1", "=B4-C4", ""],
          ["Thursday", "19", "19", "2", "=B5-C5", ""],
          ["Friday", "21", "20", "2", "=B6-C6", ""],
          ["Saturday", "22", "21", "1", "=B7-C7", ""],
          ["Sunday", "17", "17", "2", "=B8-C8", ""],
          ["Total", "=SUM(B2:B8)", "=SUM(C2:C8)", "=SUM(D2:D8)", "=SUM(E2:E8)", ""],
        ] }] },
        { type: "checklist", title: "Before publishing", items: ["Confirm route count with the station", "Review PTO conflicts", "Assign backup drivers", "Message affected drivers", "Publish final schedule"] },
      ],
    }),
  },
  {
    key: "peak-staffing",
    name: "Peak Staffing Plan",
    category: "Planning",
    desc: "Forecast vs. headcount through Peak, hiring gap math, and a readiness checklist.",
    build: () => ({
      title: "Peak Staffing Plan",
      description: "Prepare staffing for Peak — weekly demand forecast, current headcount, and the hiring gap.",
      blocks: [
        { type: "text", title: "Plan overview", html: "<p>Use this plan to prepare for <strong>Peak hiring</strong>. The Gap column shows how many drivers each week still needs; review it with recruiting weekly.</p>" },
        { type: "sheet", title: "Forecast", sheets: [{ name: "Weeks", cols: ["Week", "Forecast routes", "Drivers available", "Gap", "Hires in pipeline", "Notes"], colWidths: { 0: 110, 5: 220 }, rows: [
          ["Wk 45", "24", "21", "=B2-C2", "2", ""],
          ["Wk 46", "26", "21", "=B3-C3", "3", ""],
          ["Wk 47", "30", "22", "=B4-C4", "4", ""],
          ["Wk 48", "32", "23", "=B5-C5", "4", ""],
        ] }] },
        { type: "checklist", title: "Peak readiness", items: ["Review hiring gap with recruiting", "Confirm fleet availability for added routes", "Schedule peak training sessions", "Confirm rental van order", "Review attendance risks"] },
      ],
    }),
  },
  {
    key: "fleet-maintenance",
    name: "Fleet Maintenance Tracker",
    category: "Fleet",
    desc: "Vans, mileage, service dates and open issues in one sheet, with a weekly fleet checklist.",
    build: () => ({
      title: "Fleet Maintenance Tracker",
      description: "Track van mileage, service dates, and open issues week to week.",
      blocks: [
        { type: "text", title: "Fleet notes", html: "<p>Fleet issues requiring follow-up this week. Keep the tracker current — grounded vans should carry a note and a target return date.</p>" },
        { type: "sheet", title: "Vans", sheets: [{ name: "Fleet", cols: ["Van", "Status", "Mileage", "Last service", "Next service due", "Open issue", "Owner"], colWidths: { 5: 240 }, rows: [
          ["V-101", "Active", "48210", "", "", "", ""],
          ["V-102", "Active", "51876", "", "", "", ""],
          ["V-103", "Grounded", "62930", "", "", "Brake inspection", ""],
        ] }] },
        { type: "checklist", title: "Weekly fleet review", items: ["Check open vehicle issues", "Confirm fleet availability for the weekend", "Review grounded vans and return dates", "Schedule overdue services"] },
      ],
    }),
  },
  {
    key: "driver-coaching",
    name: "Driver Coaching Tracker",
    category: "People",
    desc: "Coaching conversations, focus areas, and follow-up dates per driver.",
    build: () => ({
      title: "Driver Coaching Tracker",
      description: "Log coaching conversations and follow-ups so nothing slips between weeks.",
      blocks: [
        { type: "sheet", title: "Coaching log", sheets: [{ name: "Log", cols: ["Date", "Driver", "Focus area", "Severity", "Summary", "Follow-up date", "Status"], colWidths: { 4: 260 }, rows: [] }] },
        { type: "checklist", title: "This week", items: ["Review new coachable events", "Hold scheduled coaching conversations", "Record outcomes in the log", "Schedule follow-ups"] },
      ],
    }),
  },
  {
    key: "pto-impact",
    name: "PTO Impact Planner",
    category: "Planning",
    desc: "Upcoming PTO vs. daily coverage so approvals never surprise the schedule.",
    build: () => ({
      title: "PTO Impact Planner",
      description: "Review PTO conflicts before approving the final schedule.",
      blocks: [
        { type: "text", title: "How this works", html: "<p>List upcoming PTO and the days it touches. <strong>Review PTO conflicts before approving the final schedule.</strong></p>" },
        { type: "sheet", title: "PTO", sheets: [{ name: "Upcoming", cols: ["Driver", "Start", "End", "Days", "Routes affected", "Backup plan", "Approved?"], colWidths: { 5: 240 }, rows: [] }] },
        { type: "checklist", title: "Approval pass", items: ["Pull pending PTO requests", "Check daily coverage on affected days", "Assign backup drivers", "Approve or decline with notes"] },
      ],
    }),
  },
  {
    key: "attendance-review",
    name: "Attendance Review Sheet",
    category: "People",
    desc: "Weekly attendance exceptions with points math and follow-up actions.",
    build: () => ({
      title: "Attendance Review Sheet",
      description: "Weekly attendance exceptions, points, and follow-up actions.",
      blocks: [
        { type: "sheet", title: "Exceptions", sheets: [{ name: "This week", cols: ["Date", "Driver", "Type", "Points", "Total points", "Action", "Done?"], rows: [] }] },
        { type: "checklist", title: "Weekly review", items: ["Review attendance risks", "Update points totals", "Message drivers at threshold", "Escalate repeat patterns"] },
      ],
    }),
  },
  {
    key: "hiring-pipeline",
    name: "Hiring Pipeline Plan",
    category: "Recruiting",
    desc: "Weekly funnel counts with conversion math, plus the recruiting to-do list.",
    build: () => ({
      title: "Hiring Pipeline Plan",
      description: "Track weekly funnel throughput against the hiring goal.",
      blocks: [
        { type: "sheet", title: "Funnel", sheets: [{ name: "Weekly", cols: ["Week", "Applied", "Screened", "Interviewed", "Hired", "Hire rate", "Goal", "Gap"], rows: [
          ["This week", "0", "0", "0", "0", "=IF(B2>0,ROUND(E2/B2*100,1),0)", "3", "=G2-E2"],
        ] }] },
        { type: "checklist", title: "Recruiting actions", items: ["Review hiring gap", "Post/refresh job listings", "Clear the screening queue", "Confirm interview day capacity"] },
      ],
    }),
  },
  {
    key: "payroll-prep",
    name: "Payroll Prep Worksheet",
    category: "Payroll",
    desc: "Pre-payroll exceptions sheet and the export checklist.",
    build: () => ({
      title: "Payroll Prep Worksheet",
      description: "Work the exceptions list before exporting payroll.",
      blocks: [
        { type: "sheet", title: "Exceptions", sheets: [{ name: "Pay period", cols: ["Driver", "Issue", "Hours delta", "Adjusted?", "Notes"], colWidths: { 4: 260 }, rows: [] }] },
        { type: "checklist", title: "Before export", items: ["Reconcile missing punches", "Confirm OT approvals", "Apply adjustments", "Export payroll file"] },
      ],
    }),
  },
  {
    key: "daily-dispatch",
    name: "Daily Dispatch Checklist",
    category: "Dispatch",
    desc: "The morning launch runbook plus a same-day issues sheet.",
    build: () => ({
      title: "Daily Dispatch Checklist",
      description: "Morning launch runbook and same-day issue tracking.",
      blocks: [
        { type: "checklist", title: "Morning launch", items: ["Confirm route count", "Confirm fleet availability", "Check call-outs and swaps", "Stage devices and keys", "Send launch announcements"] },
        { type: "sheet", title: "Same-day issues", sheets: [{ name: "Today", cols: ["Time", "Route", "Driver", "Issue", "Action taken", "Resolved?"], colWidths: { 3: 240, 4: 240 }, rows: [] }] },
      ],
    }),
  },
  {
    key: "compliance-review",
    name: "Compliance Review Workbook",
    category: "Compliance",
    desc: "License, medical card, and document expirations with a monthly review checklist.",
    build: () => ({
      title: "Compliance Review Workbook",
      description: "Track expirations and work the monthly compliance review.",
      blocks: [
        { type: "sheet", title: "Expirations", sheets: [{ name: "Documents", cols: ["Driver", "Document", "Expires", "Days left", "Status", "Action"], rows: [] }] },
        { type: "checklist", title: "Monthly review", items: ["Pull expiring licenses (60 days)", "Verify medical cards", "Collect outstanding documents", "Record completed re-checks"] },
      ],
    }),
  },
];

// ─── Module state ────────────────────────────────────────────────────────────
// One workbook open at a time. Sheet cell data lives in sparse Maps
// keyed "row,col"; grids (see the grid engine below) hold per-block
// view state keyed by block id.

const WB = {
  view: "list",              // "list" | "detail"
  workbooks: [],
  users: [],                 // app_users for owner names / assignees / mentions
  usersLoaded: false,
  showArchived: false,
  wb: null,                  // open workbook row
  blocks: [],
  sheetsByBlock: new Map(),  // blockId -> [sheet]
  itemsByBlock: new Map(),   // blockId -> [checklist items]
  comments: [],
  permissions: [],
  activity: [],
  canEdit: false,
  canAdmin: false,
  panelOpen: false,
  panelTab: "comments",
  showResolved: false,
  taskFilter: "open",
  channel: null,
  presence: [],
  saveState: "saved",        // saved | dirty | saving | error
  dirtyCells: new Map(),     // sheetId -> Set("r,c")
  pendingActivity: [],       // coalesced cell-edit summaries awaiting flush
  commentDraftTarget: null,  // {blockId, sheetId, cellRef} when composing a cell comment
  gotoWrapped: false,
  listenersInstalled: false,
  clipboard: null,           // rich copy/cut buffer (cells + TSV mirror)
};

const GRIDS = new Map();     // blockId -> grid instance

function wbRoot() { return document.getElementById("rr-wb-root"); }
function cellKey(r, c) { return r + "," + c; }
function keyRC(key) { const i = key.indexOf(","); return { r: +key.slice(0, i), c: +key.slice(i + 1) }; }

function findSheet(sheetId) {
  for (const arr of WB.sheetsByBlock.values()) {
    const s = arr.find((x) => x.id === sheetId);
    if (s) return s;
  }
  return null;
}
function activeSheetOf(block) {
  const arr = WB.sheetsByBlock.get(block.id) || [];
  const want = block.settings && block.settings.active_sheet_id;
  return arr.find((s) => s.id === want) || arr[0] || null;
}
function findBlock(blockId) { return WB.blocks.find((b) => b.id === blockId) || null; }

// ─── Named ranges (block-scoped, like an Excel workbook's names) ─────────────
// Stored on block.settings.namedRanges as [{ name, ref }] where ref is a
// sheet-qualified A1 range ("Roster!A2:A50"). Names are workbook-scope
// within a spreadsheet block, which is exactly the set of sheets that can
// already reference one another.
const WB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
function blockNamedRanges(block) {
  const v = block && block.settings && block.settings.namedRanges;
  return Array.isArray(v) ? v : [];
}
function isValidRangeName(name) {
  if (!name || !WB_NAME_RE.test(name)) return false;
  const up = name.toUpperCase();
  if (parseCellRef(up)) return false;                 // looks like a cell ref
  if (/^[A-Za-z]{1,3}$/.test(up)) return false;       // looks like a column
  if (up === "TRUE" || up === "FALSE" || up === "R" || up === "C") return false;
  if (FUNCS[up]) return false;                         // collides with a function
  return true;
}
// Map of UPPERCASE name -> range|ref AST, resolved for the requesting sheet.
// A target on the same sheet drops its sheet qualifier so the dependency
// graph treats it as a local edge (correct recalc ordering); other-sheet
// targets keep it and recompute via the sibling pass.
function namesForSheet(sheet) {
  const block = findBlock(sheet && sheet.blockId);
  const defs = blockNamedRanges(block);
  const m = new Map();
  if (!defs.length) return m;
  const here = String(sheet.name || "").trim().toLowerCase();
  for (const d of defs) {
    if (!d || !d.name || !d.ref) continue;
    let node;
    try { node = parseFormula("=" + d.ref); } catch (_) { continue; }
    if (node.k !== "range" && node.k !== "ref") continue;
    if (node.sheet && String(node.sheet).trim().toLowerCase() === here) delete node.sheet;
    m.set(String(d.name).toUpperCase(), node);
  }
  return m;
}

// ─── Access level (client mirror of private.can_*_workbook) ────────────────

function computeAccess() {
  const self = _me();
  const wb = WB.wb;
  if (!wb || !self) { WB.canEdit = false; WB.canAdmin = false; return; }
  const mine = WB.permissions.find((p) => p.subject_type === "user" && p.subject_id === self.id);
  const owner = wb.owner_user_id === self.id;
  WB.canEdit = owner || wb.visibility === "org" || (mine && (mine.access_level === "edit" || mine.access_level === "admin"));
  const role = self.role;
  WB.canAdmin = owner || role === "ops" || role === "owner" || role === "platform_admin" || (mine && mine.access_level === "admin");
}

// ─── Activity spine ──────────────────────────────────────────────────────────

async function wbLog(action, summary, extra) {
  const wb = WB.wb;
  if (!wb) return;
  try {
    const row = {
      dsp_id: wb.dsp_id,
      workbook_id: wb.id,
      actor_user_id: _me() ? _me().id : null,
      action,
      summary: String(summary || "").slice(0, 300),
      target_type: (extra && extra.target_type) || null,
      target_id: (extra && extra.target_id) || null,
      detail: (extra && extra.detail) || {},
    };
    const res = await _sb().from("workbook_activity").insert(row).select().single();
    if (res.error) { console.warn("workbook activity:", res.error.message); return; }
    // record locally too — the realtime echo also delivers this row,
    // but the feed must not depend on the channel being healthy
    if (res.data && !WB.activity.some((a) => a.id === res.data.id)) {
      WB.activity.unshift(res.data);
      if (WB.panelOpen && WB.panelTab === "activity") renderPanelBody();
    }
  } catch (e) { console.warn("workbook activity:", e && e.message); }
}

// ─── Cell persistence ────────────────────────────────────────────────────────
// Debounced batch upsert. Cleared cells become tombstones (all-null
// payload) so a single upsert path covers both; tombstones are skipped
// on load. Failures keep the dirty set intact and surface a retry chip.

function markSaveState(state) {
  WB.saveState = state;
  const modeText = { saved: "Ready", dirty: "Unsaved changes", saving: "Saving…", error: "Save failed" }[state] || "Ready";
  for (const g of GRIDS.values()) {
    if (g.els.sbmode) {
      g.els.sbmode.textContent = modeText;
      g.els.sbmode.classList.toggle("is-error", state === "error");
    }
  }
  const el = document.querySelector("[data-wb-savestate]");
  if (!el) return;
  const map = {
    saved: `<span class="wb-save is-saved">Saved</span>`,
    dirty: `<span class="wb-save is-dirty">Unsaved changes</span>`,
    saving: `<span class="wb-save is-saving">Saving…</span>`,
    error: `<span class="wb-save is-error">Save failed · <button type="button" class="wb-save-retry" data-wb-act="retry-save">Retry</button></span>`,
  };
  el.innerHTML = map[state] || "";
}

function markCellsDirty(sheet, keys) {
  if (!WB.dirtyCells.has(sheet.id)) WB.dirtyCells.set(sheet.id, new Set());
  const set = WB.dirtyCells.get(sheet.id);
  keys.forEach((k) => set.add(k));
  markSaveState("dirty");
  scheduleCellFlush();
}

const scheduleCellFlush = debounce(() => { flushCells(); }, 900);

async function flushCells() {
  if (![...WB.dirtyCells.values()].some((s) => s.size)) return;
  const wb = WB.wb;
  if (!wb) { WB.dirtyCells.clear(); return; }
  markSaveState("saving");
  const payload = [];
  const flushed = new Map(); // sheetId -> keys array (to clear on success)
  for (const [sheetId, keys] of WB.dirtyCells) {
    const sheet = findSheet(sheetId);
    if (!sheet || !keys.size) continue;
    const arr = [...keys];
    flushed.set(sheetId, arr);
    for (const k of arr) {
      const { r, c } = keyRC(k);
      const cell = sheet.cells.get(k);
      payload.push({
        dsp_id: wb.dsp_id,
        workbook_id: wb.id,
        sheet_id: sheetId,
        row_index: r,
        col_index: c,
        value: cell ? (cell.value ?? null) : null,
        formula: cell ? (cell.formula ?? null) : null,
        computed: cell ? (cell.err ? cell.err : cell.computed != null ? String(cell.computed) : null) : null,
        value_type: cell ? (cell.type ?? null) : null,
        format: cell && cell.format ? cell.format : {},
        updated_by: _me() ? _me().id : null,
      });
    }
  }
  if (!payload.length) { WB.dirtyCells.clear(); markSaveState("saved"); return; }
  try {
    // Chunk very large flushes (paste of thousands of cells).
    for (let i = 0; i < payload.length; i += 500) {
      const res = await _sb().from("workbook_cells").upsert(payload.slice(i, i + 500), { onConflict: "sheet_id,row_index,col_index" });
      if (res.error) throw res.error;
    }
    for (const [sheetId, keys] of flushed) {
      const set = WB.dirtyCells.get(sheetId);
      if (set) { keys.forEach((k) => set.delete(k)); if (!set.size) WB.dirtyCells.delete(sheetId); }
    }
    if ([...WB.dirtyCells.values()].some((s) => s.size)) { markSaveState("dirty"); scheduleCellFlush(); }
    else markSaveState("saved");
    // one coalesced activity row per flush
    const pend = WB.pendingActivity.splice(0);
    if (pend.length) {
      const total = pend.reduce((a, p) => a + p.count, 0);
      const first = pend[0];
      const summary = pend.length === 1 && first.count === 1
        ? `updated cell ${first.ref} in ${first.sheetName}`
        : `updated ${total} cell${total === 1 ? "" : "s"} in ${[...new Set(pend.map((p) => p.sheetName))].join(", ")}`;
      wbLog("cells.updated", summary, { target_type: "sheet", target_id: first.sheetId, detail: { changes: pend.flatMap((p) => p.changes).slice(0, 100) } });
    }
  } catch (e) {
    console.warn("workbook cell flush:", e && e.message);
    markSaveState("error");
  }
}

// Record a pending activity summary for the next flush.
function queueCellActivity(sheet, changes) {
  if (!changes.length) return;
  const refs = changes.map((ch) => colLabel(ch.c) + (ch.r + 1));
  WB.pendingActivity.push({
    sheetId: sheet.id,
    sheetName: sheet.name,
    ref: refs[0],
    count: changes.length,
    changes: changes.slice(0, 50).map((ch) => ({ ref: colLabel(ch.c) + (ch.r + 1), prev: ch.prev ?? null, next: ch.next ?? null })),
  });
}

const saveSheetMeta = debounce(async (sheetId) => {
  const sheet = findSheet(sheetId);
  if (!sheet || !WB.wb) return;
  try {
    const res = await _sb().from("workbook_sheets").update({
      name: sheet.name,
      position: sheet.position,
      row_count: sheet.rowCount,
      col_count: sheet.colCount,
      frozen_rows: sheet.frozenRows,
      frozen_cols: sheet.frozenCols,
      col_widths: sheet.colWidths || {},
      row_heights: sheet.rowHeights || {},
      meta: { ...(sheet.meta || {}), hiddenRows: [...(sheet.hiddenRows || [])], hiddenCols: [...(sheet.hiddenCols || [])] },
    }).eq("id", sheetId);
    if (res.error) throw res.error;
  } catch (e) {
    // migration 0414 adds workbook_sheets.meta — until it's applied,
    // retry without it so widths/frozen panes still save
    if (/'meta' column|meta.*schema cache/i.test(String(e && e.message))) {
      try {
        const res2 = await _sb().from("workbook_sheets").update({
          name: sheet.name, position: sheet.position, row_count: sheet.rowCount, col_count: sheet.colCount,
          frozen_rows: sheet.frozenRows, frozen_cols: sheet.frozenCols,
          col_widths: sheet.colWidths || {}, row_heights: sheet.rowHeights || {},
        }).eq("id", sheetId);
        if (!res2.error) { _toast("Hidden rows and rules need migration 0414 to persist", "warn"); return; }
      } catch (_) {}
    }
    console.warn("sheet meta save:", e && e.message); _toast("Couldn't save sheet settings", "warn");
  }
}, 700);

const saveWbMeta = debounce(async () => {
  const wb = WB.wb;
  if (!wb) return;
  try {
    const res = await _sb().from("workbooks").update({ title: wb.title, description: wb.description, visibility: wb.visibility }).eq("id", wb.id);
    if (res.error) throw res.error;
  } catch (e) { console.warn("workbook meta save:", e && e.message); _toast("Couldn't save workbook details", "warn"); }
}, 700);

async function saveBlock(block, fields) {
  try {
    const res = await _sb().from("workbook_blocks").update(fields).eq("id", block.id);
    if (res.error) throw res.error;
  } catch (e) { console.warn("block save:", e && e.message); _toast("Couldn't save block", "warn"); }
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

async function fetchUsers() {
  if (WB.usersLoaded) return;
  try {
    const res = await _sb().from("app_users").select("id, full_name, email, role").eq("dsp_id", _dsp().id).eq("active", true).order("full_name");
    if (!res.error && Array.isArray(res.data)) { WB.users = res.data; WB.usersLoaded = true; }
  } catch (e) { console.warn("workbook users:", e && e.message); }
}

function wbMigrationErr(msg) {
  return /does not exist|schema cache|PGRST2|relation .*workbook/i.test(String(msg || ""));
}

async function fetchWorkbooksList() {
  const res = await _sb().from("workbooks")
    .select("id, dsp_id, owner_user_id, title, description, visibility, template_key, archived_at, created_at, updated_at")
    .eq("dsp_id", _dsp().id)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (res.error) throw res.error;
  WB.workbooks = res.data || [];
  // Report workbooks (created by the Reports tab) carry a report spec on
  // their sheet block — that's what splits the Reports library from the
  // Workbooks list. Detection failure degrades to "everything is a
  // workbook" rather than blocking the page.
  WB.reportInfo = new Map();
  try {
    const bl = await _sb().from("workbook_blocks")
      .select("workbook_id, type, settings")
      .eq("dsp_id", _dsp().id)
      .eq("type", "sheet")
      .limit(2000);
    for (const b of (bl.data || [])) {
      if (b.settings && b.settings.report) WB.reportInfo.set(b.workbook_id, b.settings.report);
    }
  } catch (e) { console.warn("report detection:", e && e.message); }
}

function isReportWb(w) { return !!(WB.reportInfo && WB.reportInfo.has(typeof w === "string" ? w : w && w.id)); }

function normalizeSheet(row) {
  return {
    id: row.id,
    blockId: row.block_id,
    name: row.name || "Sheet 1",
    position: row.position || 0,
    rowCount: Math.max(1, row.row_count || 200),
    colCount: Math.max(1, row.col_count || 26),
    frozenRows: row.frozen_rows || 0,
    frozenCols: row.frozen_cols || 0,
    colWidths: row.col_widths && typeof row.col_widths === "object" ? row.col_widths : {},
    rowHeights: row.row_heights && typeof row.row_heights === "object" ? row.row_heights : {},
    meta: row.meta && typeof row.meta === "object" ? row.meta : {},
    hiddenRows: new Set(Array.isArray(row.meta?.hiddenRows) ? row.meta.hiddenRows : []),
    hiddenCols: new Set(Array.isArray(row.meta?.hiddenCols) ? row.meta.hiddenCols : []),
    cells: new Map(),
  };
}

function ingestCellRow(sheet, row) {
  const empty = row.value == null && row.formula == null;
  const fmt = row.format && typeof row.format === "object" ? row.format : {};
  if (empty && !Object.keys(fmt).length) { sheet.cells.delete(cellKey(row.row_index, row.col_index)); return; }
  const cell = { value: row.value, formula: row.formula, format: fmt, type: row.value_type || null, computed: null, err: null };
  sheet.cells.set(cellKey(row.row_index, row.col_index), cell);
}

async function openWorkbook(id) {
  const root = wbRoot();
  if (!root) return;
  restoreVaultNode();
  root.innerHTML = `<div class="wb-loading"><span class="rr-skel rr-skel-md" style="width:280px"></span><span class="rr-skel rr-skel-sm" style="width:60%"></span><span class="rr-skel rr-skel-sm" style="width:44%"></span></div>`;
  try {
    const s = _sb();
    const [wbRes, blocksRes, permsRes] = await Promise.all([
      s.from("workbooks").select("*").eq("id", id).maybeSingle(),
      s.from("workbook_blocks").select("*").eq("workbook_id", id).order("position"),
      s.from("workbook_permissions").select("*").eq("workbook_id", id),
    ]);
    if (wbRes.error) throw wbRes.error;
    if (!wbRes.data) { _toast("That workbook is gone or not shared with you", "warn"); WB.view = "list"; return renderListPage(); }
    WB.wb = wbRes.data;
    WB.blocks = (blocksRes.data || []).map((b) => ({ ...b, settings: b.settings || {}, content: b.content || {} }));
    // keep the report registry fresh even when the list hasn't refetched —
    // "back" from a report must land on the Reports tab immediately
    if (!WB.reportInfo) WB.reportInfo = new Map();
    for (const b of WB.blocks) if (b.settings && b.settings.report) WB.reportInfo.set(b.workbook_id, b.settings.report);
    WB.permissions = permsRes.data || [];
    computeAccess();

    const blockIds = WB.blocks.map((b) => b.id);
    WB.sheetsByBlock = new Map();
    WB.itemsByBlock = new Map();
    let sheets = [];
    if (blockIds.length) {
      const [sheetsRes, itemsRes] = await Promise.all([
        s.from("workbook_sheets").select("*").in("block_id", blockIds).order("position"),
        s.from("workbook_checklist_items").select("*").in("block_id", blockIds).order("position"),
      ]);
      if (sheetsRes.error) throw sheetsRes.error;
      sheets = (sheetsRes.data || []).map(normalizeSheet);
      for (const sh of sheets) {
        if (!WB.sheetsByBlock.has(sh.blockId)) WB.sheetsByBlock.set(sh.blockId, []);
        WB.sheetsByBlock.get(sh.blockId).push(sh);
      }
      for (const it of itemsRes.data || []) {
        if (!WB.itemsByBlock.has(it.block_id)) WB.itemsByBlock.set(it.block_id, []);
        WB.itemsByBlock.get(it.block_id).push(it);
      }
    }
    // Cells: page through so big sheets load fully (PostgREST caps at 1000/req).
    if (sheets.length) {
      const sheetIds = sheets.map((sh) => sh.id);
      let from = 0;
      const PAGE = 1000;
      for (;;) {
        const cellRes = await s.from("workbook_cells").select("sheet_id, row_index, col_index, value, formula, value_type, format").in("sheet_id", sheetIds).range(from, from + PAGE - 1);
        if (cellRes.error) throw cellRes.error;
        const rows = cellRes.data || [];
        for (const row of rows) {
          const sheet = sheets.find((sh) => sh.id === row.sheet_id);
          if (sheet) ingestCellRow(sheet, row);
        }
        if (rows.length < PAGE) break;
        from += PAGE;
        if (from > 60000) break; // hard stop far above the perf target
      }
    }
    const [commentsRes, activityRes] = await Promise.all([
      s.from("workbook_comments").select("*").eq("workbook_id", id).order("created_at"),
      s.from("workbook_activity").select("*").eq("workbook_id", id).order("created_at", { ascending: false }).limit(120),
    ]);
    WB.comments = commentsRes.data || [];
    WB.activity = activityRes.data || [];

    for (const arr of WB.sheetsByBlock.values()) arr.forEach((sh) => recalcSheet(sh));
    // second pass: sheets with cross-sheet formulas (or any block with named
    // ranges) now see fresh values
    for (const arr of WB.sheetsByBlock.values()) {
      const hasNames = arr.length ? blockNamedRanges(findBlock(arr[0].blockId)).length > 0 : false;
      for (const sh of arr) {
        let cross = hasNames;
        if (!cross) for (const cell of sh.cells.values()) if (cell.formula && cell.formula.includes("!")) { cross = true; break; }
        if (cross) recalcSheet(sh);
      }
    }

    WB.view = "detail";
    WB.dirtyCells = new Map();
    WB.pendingActivity = [];
    GRIDS.clear();
    renderDetailPage();
    openRealtime();
    refreshLiveReports();
    fetchUsers().then(() => { renderPresence(); refreshPanel(); });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.warn("open workbook:", msg);
    root.innerHTML = wbErrorHtml("Couldn't open that workbook", msg);
  }
}

// ─── Create / template apply ────────────────────────────────────────────────

async function createWorkbook({ title, description, visibility, templateKey, spec: givenSpec }) {
  const s = _sb();
  const self = _me();
  const dsp = _dsp();
  const tpl = templateKey ? WB_TEMPLATES.find((t) => t.key === templateKey) : null;
  const spec = givenSpec || (tpl ? tpl.build() : null);
  const row = {
    dsp_id: dsp.id,
    owner_user_id: self ? self.id : null,
    title: (title || (spec && spec.title) || "Untitled workbook").slice(0, 200),
    description: (description || (spec && spec.description) || "").slice(0, 2000),
    visibility: visibility === "private" ? "private" : "org",
    template_key: templateKey || null,
  };
  const ins = await s.from("workbooks").insert(row).select().single();
  if (ins.error) throw ins.error;
  const wb = ins.data;

  // spreadsheets only — the block system is retired, so template
  // note/checklist specs are dropped at creation
  let blockSpecs = (spec ? spec.blocks : [{ type: "sheet", title: "", sheets: [{ name: "Sheet 1", cols: null, rows: [] }] }])
    .filter((b) => b.type === "sheet");
  if (!blockSpecs.length) blockSpecs = [{ type: "sheet", title: "", sheets: [{ name: "Sheet 1", cols: null, rows: [] }] }];
  let pos = 0;
  for (const bs of blockSpecs) {
    const bRow = { dsp_id: dsp.id, workbook_id: wb.id, type: bs.type, title: bs.title || "", position: pos++, settings: bs.settings || {}, content: bs.type === "text" ? { html: sanitizeHtml(bs.html || "") } : {} };
    const bIns = await s.from("workbook_blocks").insert(bRow).select().single();
    if (bIns.error) throw bIns.error;
    const block = bIns.data;
    if (bs.type === "sheet") {
      const sheetSpecs = bs.sheets && bs.sheets.length ? bs.sheets : [{ name: "Sheet 1", cols: null, rows: [] }];
      let sPos = 0;
      for (const ss of sheetSpecs) {
        const cols = Math.max(26, ss.cols ? ss.cols.length : 0);
        const rows = Math.max(spec ? 200 : 500, (ss.rows ? ss.rows.length : 0) + 40);
        const shIns = await s.from("workbook_sheets").insert({
          dsp_id: dsp.id, workbook_id: wb.id, block_id: block.id,
          name: ss.name || `Sheet ${sPos + 1}`, position: sPos++,
          row_count: rows, col_count: cols, col_widths: ss.colWidths || {},
        }).select().single();
        if (shIns.error) throw shIns.error;
        const sheet = shIns.data;
        const cellRows = [];
        if (ss.cols) {
          ss.cols.forEach((label, c) => {
            cellRows.push({ dsp_id: dsp.id, workbook_id: wb.id, sheet_id: sheet.id, row_index: 0, col_index: c, value: label, value_type: "text", format: { bold: true, bg: "header" }, updated_by: self ? self.id : null });
          });
        }
        (ss.rows || []).forEach((r, ri) => {
          r.forEach((v, ci) => {
            if (v === "" || v == null) return;
            const isFormula = typeof v === "string" && v.startsWith("=");
            cellRows.push({
              dsp_id: dsp.id, workbook_id: wb.id, sheet_id: sheet.id,
              row_index: ri + 1, col_index: ci,
              value: isFormula ? null : String(v),
              formula: isFormula ? v : null,
              value_type: isFormula ? "formula" : detectType(String(v)).type,
              format: {}, updated_by: self ? self.id : null,
            });
          });
        });
        for (let i = 0; i < cellRows.length; i += 500) {
          const cRes = await s.from("workbook_cells").insert(cellRows.slice(i, i + 500));
          if (cRes.error) throw cRes.error;
        }
      }
    }
    if (bs.type === "checklist" && bs.items && bs.items.length) {
      const itemRows = bs.items.map((label, i) => ({ dsp_id: dsp.id, workbook_id: wb.id, block_id: block.id, label, position: i, created_by: self ? self.id : null }));
      const iRes = await s.from("workbook_checklist_items").insert(itemRows);
      if (iRes.error) throw iRes.error;
    }
  }
  WB.wb = wb; // so wbLog targets the new workbook
  await wbLog("workbook.created", tpl ? `created this workbook from the “${tpl.name}” template` : "created this workbook", { target_type: "workbook", target_id: wb.id });
  if (tpl) await wbLog("template.applied", `applied the “${tpl.name}” template`, { target_type: "workbook", target_id: wb.id });
  return wb;
}

// ─── Report → workbook bridge ────────────────────────────────────────────────
// The Reports Builder (reports.js) hands us a {headers, rows} matrix; we
// materialize it as a normal workbook through createWorkbook's spec path so
// the result is indistinguishable from a hand-built sheet. The new workbook
// opens on the next loadWorkbooksView pass (queued so navigation and render
// can't race).

let PENDING_OPEN_ID = null;

export async function createReportWorkbook({ title, description, headers, rows, sheetName, report }) {
  const wb = await createWorkbook({
    title,
    description,
    visibility: "org",
    spec: {
      title,
      description,
      blocks: [{
        type: "sheet",
        title: "",
        settings: report ? { report } : {},
        sheets: [{ name: String(sheetName || title || "Report").slice(0, 60), cols: headers, rows }],
      }],
    },
  });
  PENDING_OPEN_ID = wb.id;
  if (report) {
    if (!WB.reportInfo) WB.reportInfo = new Map();
    WB.reportInfo.set(wb.id, report);
  }
  if (typeof window.goto === "function") window.goto("workbooks");
  return wb.id;
}

// ─── Live report refresh ─────────────────────────────────────────────────────
// A report block whose settings.report.live flag is set re-pulls its data
// every time the workbook is opened. The provider (reports.js, registered by
// live.js) turns the stored report spec back into a {headers, rows} matrix;
// only the report's own columns are rewritten, so formulas or notes the
// operator added in the columns to the right survive every refresh. Writes
// go through the normal dirty-cell flush — no undo entries, no activity spam.

let REPORT_PROVIDER = null;

export function registerReportProvider(fn) { REPORT_PROVIDER = fn; }

// ─── Reports screen ──────────────────────────────────────────────────────────
// The strip's Reports tab swaps the Workbooks list for a full Reports page
// rendered by reports.js (registered by live.js — same DI pattern as the
// data provider, so this module never imports reports.js).

let REPORTS_RENDERER = null;
let PENDING_SCREEN = null;

export function registerReportsScreen(fn) { REPORTS_RENDERER = fn; }

// App-launcher entry: navigate to the Workbooks view with the Reports
// screen up (used by the Reports button in the right-side launcher).
export function openReportsScreen() {
  PENDING_SCREEN = "reports";
  if (typeof window.goto === "function") window.goto("workbooks");
}

function syncWbTabs(screen) {
  const cmd = document.getElementById("rr-wb-cmd");
  if (!cmd) return;
  cmd.querySelectorAll("[data-wb-tab]").forEach((b) => {
    const on = b.getAttribute("data-wb-tab") === screen;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  // the strip action follows the tab: New workbook ↔ New report
  const nwb = cmd.querySelector('[data-wb-act="new-workbook"]');
  const nrp = cmd.querySelector('[data-wb-act="new-report"]');
  if (nwb) nwb.hidden = screen !== "workbooks";
  if (nrp) nrp.hidden = screen !== "reports";
  const ab = cmd.querySelector("#rr-wb-ab");
  if (ab) ab.hidden = screen === "vault";
}

// The Reports tab is a library: every generated report workbook lives
// here as a card. "New report" opens the builder as a subscreen.
async function renderReportsPage() {
  const root = wbRoot();
  if (!root) return;
  restoreVaultNode();
  closeRealtime();
  WB.view = "reports";
  const cmd = document.getElementById("rr-wb-cmd");
  if (cmd) cmd.style.display = "";
  syncWbTabs("reports");
  try {
    await Promise.all([fetchWorkbooksList(), fetchUsers()]);
  } catch (e) {
    root.innerHTML = wbErrorHtml("Couldn't load reports", (e && e.message) || String(e));
    return;
  }
  if (WB.view !== "reports") return; // navigated away while loading
  renderReportsBody(root);
}

// Reports list body renders from cache — star toggles and card-menu
// actions rebuild it instantly, same as the workbook list.
function renderReportsBody(root) {
  root = root || wbRoot();
  if (!root || WB.view !== "reports") return;
  const list = WB.workbooks.filter((w) => !w.archived_at && isReportWb(w));
  const favs = wbFavs();
  const self = _me();
  const canAdminWb = (w) => !!self && (w.owner_user_id === self.id || ["ops", "owner", "platform_admin"].includes(self.role));
  const card = (w) => {
    const info = WB.reportInfo.get(w.id) || {};
    const fav = favs.has(w.id);
    return `<button type="button" class="wb-card" data-wb-open="${esc(w.id)}">
      <span class="wb-fav ${fav ? "is-fav" : ""}" data-wb-fav="${esc(w.id)}" role="button" tabindex="0" title="${fav ? "Remove from favorites" : "Add to favorites"}" aria-label="${fav ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${fav}">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2.5 15.09 8.6 21.8 9.55 16.9 14.25 18.08 20.9 12 17.77 5.92 20.9 7.1 14.25 2.2 9.55 8.91 8.6 12 2.5"/></svg>
      </span>
      ${canAdminWb(w) ? `<span class="wb-cardmenu" data-wb-cardmenu="${esc(w.id)}" role="button" tabindex="0" title="Report actions" aria-label="Report actions">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </span>` : ""}
      <span class="wb-card-ic">${WB_ICON_SVG}</span>
      <span class="wb-card-main">
        <span class="wb-card-title">${esc(w.title || "Untitled report")}</span>
        ${w.description ? `<span class="wb-card-desc">${esc(w.description)}</span>` : ""}
        <span class="wb-card-meta">
          ${esc(userName(w.owner_user_id))} · ${esc(relTime(w.updated_at))}
          ${info.live ? `<span class="wb-badge">Live</span>` : `<span class="wb-badge is-muted">Snapshot</span>`}
          ${w.visibility === "private" ? `<span class="wb-badge">Private</span>` : ""}
        </span>
      </span>
    </button>`;
  };
  const favList = list.filter((w) => favs.has(w.id));
  const restList = list.filter((w) => !favs.has(w.id));
  const cardsHtml = favList.length
    ? `<div class="wb-list-sec">★ Favorites</div>
       <div class="wb-cards">${favList.map(card).join("")}</div>
       ${restList.length ? `<div class="wb-list-sec">All reports</div><div class="wb-cards">${restList.map(card).join("")}</div>` : ""}`
    : `<div class="wb-cards">${list.map(card).join("")}</div>`;
  root.innerHTML = list.length
    ? cardsHtml
    : `<div class="rr-empty">
        <div class="rr-empty-icon">${WB_ICON_SVG}</div>
        <div class="rr-empty-title">No reports yet</div>
        <div class="rr-empty-sub">Reports you generate will live here — build one from your people data and open it as a live workbook.</div>
        <div class="rr-empty-action"><button type="button" class="btn btn-primary btn-sm" data-wb-act="new-report">Create your first report</button></div>
      </div>`;
}

// Builder subscreen (still under the Reports tab) with a back link.
// ─── Vault (inline) ──────────────────────────────────────────────────────────
// The Vault tab mounts the ENTIRE #view-drive page node inside this page
// (schedule-roster "portable node" pattern): the node is MOVED under our
// tab strip, its live.js delegates keep working (they're id-based), and
// it is moved home before anything else overwrites rr-wb-root — an
// innerHTML write while the node is borrowed would destroy the Vault DOM.

function restoreVaultNode() {
  const node = document.querySelector("#rr-wb-root .rr-drive-page");
  if (node && node.__wbHome) node.__wbHome.appendChild(node);
}

function renderVaultPage() {
  const root = wbRoot();
  if (!root) return;
  closeRealtime();
  WB.view = "vault";
  const cmd = document.getElementById("rr-wb-cmd");
  if (cmd) cmd.style.display = "";
  syncWbTabs("vault");
  const node = document.querySelector("#view-drive .rr-drive-page") || document.querySelector("#rr-wb-root .rr-drive-page");
  if (!node) {
    root.innerHTML = wbErrorHtml("The Vault isn't available", "Reload the page and try again.");
    return;
  }
  if (!node.__wbHome) node.__wbHome = node.parentNode;
  root.innerHTML = "";
  root.appendChild(node);
  if (typeof window.loadDriveView === "function") window.loadDriveView({});
}

function renderReportBuilderPage() {
  const root = wbRoot();
  if (!root) return;
  restoreVaultNode();
  closeRealtime();
  WB.view = "reports-builder";
  const cmd = document.getElementById("rr-wb-cmd");
  if (cmd) cmd.style.display = "";
  syncWbTabs("reports");
  if (!REPORTS_RENDERER) {
    root.innerHTML = wbErrorHtml("Reports aren't available", "Reload the page and try again.");
    return;
  }
  root.innerHTML = `<button type="button" class="btn btn-ghost btn-sm rr-wb-reports-back" data-wb-act="reports-back">← Reports</button><div data-rb-mount></div>`;
  REPORTS_RENDERER(root.querySelector("[data-rb-mount]"));
}

async function refreshLiveReports() {
  if (!REPORT_PROVIDER || !WB.canEdit || !WB.wb) return;
  const openedId = WB.wb.id;
  for (const block of WB.blocks) {
    const spec = block.type === "sheet" && block.settings && block.settings.report;
    if (!spec || !spec.live) continue;
    const sheets = WB.sheetsByBlock.get(block.id) || [];
    const sheet = sheets[0];
    const g = GRIDS.get(block.id);
    if (!sheet || !g) continue;
    try {
      const matrix = await REPORT_PROVIDER(spec);
      if (!matrix || !Array.isArray(matrix.headers)) continue;
      if (!WB.wb || WB.wb.id !== openedId) return; // navigated away mid-fetch
      applyReportRefresh(g, sheet, matrix);
    } catch (e) { console.warn("live report refresh:", e && e.message); }
  }
}

function applyReportRefresh(g, sheet, { headers, rows }) {
  if (g.editing) return; // never fight an in-progress edit
  const nCols = headers.length;
  const touched = [];
  const want = (r, c) => (r === 0 ? headers[c] : (rows[r - 1] || [])[c]);
  const wantRows = rows.length + 1;
  for (let r = 0; r < wantRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const v = String(want(r, c) ?? "");
      const key = cellKey(r, c);
      const cur = sheet.cells.get(key);
      if (cur && !cur.formula && String(cur.value ?? "") === v) continue;
      const format = cur && cur.format && Object.keys(cur.format).length ? cur.format : (r === 0 ? { bold: true, bg: "header" } : {});
      sheet.cells.set(key, { value: v, formula: null, type: detectType(v).type, format, computed: null, err: null });
      touched.push(key);
    }
  }
  // roster shrank since the last refresh → clear the leftover data rows
  for (const key of [...sheet.cells.keys()]) {
    const { r, c } = keyRC(key);
    if (c < nCols && r >= wantRows) { sheet.cells.delete(key); touched.push(key); }
  }
  if (!touched.length) return;
  if (sheet.rowCount < wantRows + 20) { sheet.rowCount = wantRows + 40; saveSheetMeta(sheet.id); }
  recalcWithSiblings(sheet);
  markCellsDirty(sheet, touched);
  // the refresh writes rows in provider order — restore the operator's sort
  const spec = Array.isArray(sheet.meta && sheet.meta.sortSpec) ? sheet.meta.sortSpec.filter((sp) => typeof sp.col === "number" && sp.col < sheet.colCount) : null;
  if (spec && spec.length) sortBySpecs(g, spec, { quiet: true });
  computeGeometry(g);
  repaintGrid(g);
  syncFormulaBar(g);
  _toast("Report data refreshed", "info");
}

// ─── Realtime + presence ─────────────────────────────────────────────────────
// Foundation-grade: cell/comment/item/activity changes for the open
// workbook stream in and refresh in-memory state (skipping anything the
// operator is actively editing); presence is an ephemeral channel with
// avatar chips. Any failure here degrades silently — collaboration is
// additive, never load-bearing.

function closeRealtime() {
  if (WB.channel) {
    try { _sb().removeChannel(WB.channel); } catch (_) {}
    WB.channel = null;
  }
  WB.presence = [];
}

function openRealtime() {
  closeRealtime();
  const wb = WB.wb;
  const self = _me();
  if (!wb || !self) return;
  try {
    const ch = _sb().channel("rr-wb-" + wb.id, { config: { presence: { key: self.id } } });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "workbook_cells", filter: "workbook_id=eq." + wb.id }, (payload) => onRemoteCell(payload));
    ch.on("postgres_changes", { event: "*", schema: "public", table: "workbook_comments", filter: "workbook_id=eq." + wb.id }, () => { refreshComments(); });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "workbook_checklist_items", filter: "workbook_id=eq." + wb.id }, () => { refreshChecklistItems(); });
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "workbook_activity", filter: "workbook_id=eq." + wb.id }, (payload) => {
      const row = payload && payload.new;
      if (row && !WB.activity.some((a) => a.id === row.id)) {
        WB.activity.unshift(row);
        if (WB.panelOpen && WB.panelTab === "activity") renderPanelBody();
      }
    });
    ch.on("presence", { event: "sync" }, () => {
      try {
        const state = ch.presenceState();
        WB.presence = Object.entries(state).map(([uid, metas]) => ({ id: uid, name: (metas[0] && metas[0].name) || "Teammate" }));
        renderPresence();
      } catch (_) {}
    });
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        try { ch.track({ name: self.full_name || "Teammate", at: new Date().toISOString() }); } catch (_) {}
      }
    });
    WB.channel = ch;
  } catch (e) { console.warn("workbook realtime:", e && e.message); }
}

function onRemoteCell(payload) {
  try {
    const row = payload.eventType === "DELETE" ? payload.old : payload.new;
    if (!row || !row.sheet_id) return;
    const sheet = findSheet(row.sheet_id);
    if (!sheet) return;
    const key = cellKey(row.row_index, row.col_index);
    // Skip while this cell is dirty locally (our write, or a conflict
    // the local editor wins until their save lands) or being edited.
    const dirtySet = WB.dirtyCells.get(sheet.id);
    if (dirtySet && dirtySet.has(key)) return;
    const g = [...GRIDS.values()].find((x) => x.sheet && x.sheet.id === sheet.id);
    if (g && g.editing && cellKey(g.editing.r, g.editing.c) === key) return;
    if (payload.eventType === "DELETE") sheet.cells.delete(key);
    else ingestCellRow(sheet, row);
    recalcWithSiblings(sheet);
    if (g) repaintGrid(g);
  } catch (e) { console.warn("remote cell:", e && e.message); }
}

const refreshComments = debounce(async () => {
  if (!WB.wb) return;
  try {
    const res = await _sb().from("workbook_comments").select("*").eq("workbook_id", WB.wb.id).order("created_at");
    if (!res.error) {
      WB.comments = res.data || [];
      paintCommentMarkers();
      if (WB.panelOpen && WB.panelTab === "comments") renderPanelBody();
    }
  } catch (_) {}
}, 400);

const refreshChecklistItems = debounce(async () => {
  if (!WB.wb) return;
  const blockIds = WB.blocks.filter((b) => b.type === "checklist").map((b) => b.id);
  if (!blockIds.length) return;
  try {
    const res = await _sb().from("workbook_checklist_items").select("*").in("block_id", blockIds).order("position");
    if (!res.error) {
      WB.itemsByBlock = new Map();
      for (const it of res.data || []) {
        if (!WB.itemsByBlock.has(it.block_id)) WB.itemsByBlock.set(it.block_id, []);
        WB.itemsByBlock.get(it.block_id).push(it);
      }
      WB.blocks.filter((b) => b.type === "checklist").forEach((b) => renderChecklistBlockBody(b));
      if (WB.panelOpen && WB.panelTab === "tasks") renderPanelBody();
    }
  } catch (_) {}
}, 400);

// ─── Value typing + display formatting ──────────────────────────────────────

const NUM_RE = /^-?\$?\s*-?[\d,]*\.?\d+%?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})$|^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

function detectType(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { type: null };
  if (/^(true|false)$/i.test(s)) return { type: "boolean" };
  if (DATE_RE.test(s)) return { type: "date" };
  if (NUM_RE.test(s)) {
    if (s.includes("%")) return { type: "percent" };
    if (s.includes("$")) return { type: "currency" };
    return { type: "number" };
  }
  return { type: "text" };
}

function cellNumeric(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return raw;
  const n = Number(String(raw).replace(/[$,%\s]/g, ""));
  return isFinite(n) && String(raw).trim() !== "" ? n : null;
}

// The value handed to the formula engine for a cell.
function engineValue(sheet, r, c) {
  const cell = sheet.cells.get(cellKey(r, c));
  if (!cell) return null;
  if (cell.formula) {
    if (cell.err) throw new FormulaError(cell.err, "referenced cell has an error");
    return cell.computed;
  }
  const n = cellNumeric(cell.value);
  if (n != null && cell.type !== "text") {
    if (cell.type === "percent" || (typeof cell.value === "string" && cell.value.includes("%"))) return n / 100;
    return n;
  }
  if (cell.type === "boolean") return /^true$/i.test(String(cell.value));
  return cell.value;
}

// What the grid paints inside the cell box.
function displayValue(sheet, r, c) {
  const cell = sheet.cells.get(cellKey(r, c));
  if (!cell) return "";
  if (cell.formula) {
    if (cell.err) return cell.err;
    return formatForDisplay(cell.computed, cell.format, "formula");
  }
  return formatForDisplay(cell.value, cell.format, cell.type);
}

// Kill binary floating-point noise the way spreadsheets do:
// 55.199999999999996 displays as 55.2 (12 significant digits).
function cleanNum(x) {
  if (Number.isInteger(x)) return String(x);
  return String(parseFloat(x.toPrecision(12)));
}

function formatForDisplay(v, format, type) {
  if (v == null || v === "") return "";
  const numFmt = format && format.num;
  const dec = format && Number.isInteger(format.dec) ? Math.min(6, Math.max(0, format.dec)) : null;
  const n = cellNumeric(v);
  if (numFmt === "text") return String(v);
  if (n != null && type !== "text") {
    const fd = (d) => ({ minimumFractionDigits: d, maximumFractionDigits: d });
    if (numFmt === "currency" || (!numFmt && type === "currency")) {
      return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, fd(dec ?? 2));
    }
    if (numFmt === "percent" || (!numFmt && type === "percent")) {
      const pct = type === "percent" && typeof v === "string" && v.includes("%") ? n : n * (numFmt === "percent" && type !== "percent" ? 100 : 1);
      return pct.toLocaleString(undefined, dec != null ? fd(dec) : { maximumFractionDigits: 2 }) + "%";
    }
    if (numFmt === "number") return n.toLocaleString(undefined, fd(dec ?? 2));
    if (numFmt === "accounting") {
      const abs = Math.abs(n).toLocaleString(undefined, fd(dec ?? 2));
      return n < 0 ? `($${abs})` : `$${abs}`;
    }
    if (numFmt === "scientific") return n.toExponential(dec ?? 2).toUpperCase();
    if (numFmt === "date") {
      // accept both date text and serial numbers (e.g. =B2+30 results)
      const d = parseDateLoose(String(v)) || (n > 0 && n < 200000 ? serialToDate(n) : null);
      if (d) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    if (dec != null) return n.toLocaleString(undefined, fd(dec));
    if (typeof v === "number") return cleanNum(v);
    return String(v);
  }
  if ((numFmt === "date" || (!numFmt && type === "date"))) {
    const d = parseDateLoose(String(v));
    if (d) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function parseDateLoose(s) {
  const m = DATE_RE.exec(String(s).trim());
  if (!m) return null;
  if (m[1]) { const d = new Date(m[1] + "T00:00:00"); return isNaN(d) ? null : d; }
  let y = +m[4]; if (y < 100) y += 2000;
  const d = new Date(y, +m[2] - 1, +m[3]);
  return isNaN(d) ? null : d;
}

// ─── Recalc ──────────────────────────────────────────────────────────────────
// Full-sheet recalc on every change: formula cells only, topologically
// ordered with cycle detection. Formula counts on operational sheets
// are small (tens to low hundreds), so this stays well under a frame.

function recalcSheet(sheet) {
  const formulaCells = [];
  let usedR = 0, usedC = 0;
  for (const [key, cell] of sheet.cells) {
    const rc = keyRC(key);
    if (rc.r > usedR) usedR = rc.r;
    if (rc.c > usedC) usedC = rc.c;
    if (cell.formula) { formulaCells.push([key, cell]); cell.err = null; cell.computed = null; }
  }
  if (!formulaCells.length) return;
  // open ranges (A:A) clamp to the used extent for dependency purposes —
  // only formula cells matter as graph edges, and those are all in-use
  const depBounds = { rowCount: usedR + 1, colCount: usedC + 1 };
  const names = namesForSheet(sheet);
  const asts = new Map();
  const deps = new Map();
  for (const [key, cell] of formulaCells) {
    try {
      let ast = parseFormula(cell.formula);
      if (names.size) ast = bindNames(ast, names);
      asts.set(key, ast);
      deps.set(key, refsFromAst(ast, depBounds).map((rc) => cellKey(rc.r ?? rc.row, rc.c ?? rc.col)));
    } catch (e) {
      cell.err = e instanceof FormulaError ? e.code : "#ERROR";
    }
  }
  // topo order over formula cells (edges: dep formula -> dependent)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const order = [];
  const formulaSet = new Set(asts.keys());
  const visit = (key, stack) => {
    color.set(key, GRAY);
    stack.add(key);
    for (const dep of deps.get(key) || []) {
      if (!formulaSet.has(dep)) continue;
      const c = color.get(dep) || WHITE;
      if (c === GRAY) { // cycle: poison every member currently in the stack
        for (const k of stack) { const cell = sheet.cells.get(k); if (cell) cell.err = "#CIRCULAR"; }
        continue;
      }
      if (c === WHITE) visit(dep, stack);
    }
    stack.delete(key);
    color.set(key, BLACK);
    order.push(key);
  };
  for (const key of formulaSet) if ((color.get(key) || WHITE) === WHITE) visit(key, new Set());

  const ctx = {
    rowCount: sheet.rowCount,
    colCount: sheet.colCount,
    getCell: (r, c, sheetName) => (sheetName ? crossSheetValue(sheet, sheetName, r, c) : engineValue(sheet, r, c)),
    getFormula: (r, c) => { const cell = sheet.cells.get(cellKey(r, c)); return cell && cell.formula ? cell.formula : null; },
  };
  const evalOne = (key) => {
    const cell = sheet.cells.get(key);
    if (!cell || cell.err) return false;
    const before = cell.computed;
    try {
      ctx.cur = keyRC(key); // ROW()/COLUMN() with no args resolve here
      let v = evalAst(asts.get(key), ctx);
      if (v instanceof Arr) v = v.top(); // arrays display their top-left value
      if (isClosure(v)) throw new FormulaError("#VALUE", "a LAMBDA needs to be called");
      cell.computed = v;
      return v !== before;
    } catch (e) {
      cell.err = e instanceof FormulaError ? e.code : "#ERROR";
      cell.computed = null;
      return true;
    }
  };
  for (const key of order) evalOne(key);
  // INDIRECT/OFFSET read cells chosen at eval time, invisible to the static
  // dependency graph — re-evaluate those formulas once everything else has
  // settled, then cascade through their (statically known) dependents.
  const dynamic = order.filter((key) => { const ast = asts.get(key); return ast && hasDynamicRefs(ast); });
  if (dynamic.length) {
    const changed = new Set();
    const reEval = (key) => {
      const cell = sheet.cells.get(key);
      if (!cell || cell.err === "#CIRCULAR") return;
      cell.err = null;
      if (evalOne(key)) changed.add(key);
    };
    for (const key of dynamic) reEval(key);
    if (changed.size) {
      for (const key of order) {
        if (changed.has(key)) continue;
        if ((deps.get(key) || []).some((d) => changed.has(d))) reEval(key);
      }
    }
  }
}

// ─── Error / empty chrome ───────────────────────────────────────────────────

// Cross-sheet reads resolve against a sibling sheet in the same block
// by (case-insensitive) name, using its stored computed values — no
// recursive evaluation, so cross-sheet cycles are impossible.
function crossSheetValue(fromSheet, sheetName, r, c) {
  const sibs = WB.sheetsByBlock.get(fromSheet.blockId) || [];
  const want = String(sheetName).trim().toLowerCase();
  const target = sibs.find((s) => s.name.trim().toLowerCase() === want);
  if (!target) throw new FormulaError("#REF", `no sheet named “${sheetName}”`);
  if (r < 0 || c < 0 || r >= target.rowCount || c >= target.colCount) throw new FormulaError("#REF", "out of range");
  return engineValue(target, r, c);
}

// Recalc a sheet, then any sibling sheets whose formulas read across
// sheets (their inputs may have just changed).
function recalcWithSiblings(sheet) {
  recalcSheet(sheet);
  const sibs = WB.sheetsByBlock.get(sheet.blockId) || [];
  // named ranges can create cross-sheet reads that carry no "!" in the
  // formula text, so any defined name forces a full sibling recompute
  const hasNames = blockNamedRanges(findBlock(sheet.blockId)).length > 0;
  for (const s2 of sibs) {
    if (s2.id === sheet.id) continue;
    let cross = hasNames;
    if (!cross) for (const cell of s2.cells.values()) {
      if (cell.formula && cell.formula.includes("!")) { cross = true; break; }
    }
    if (cross) recalcSheet(s2);
  }
}

function wbErrorHtml(title, sub) {
  const deploying = wbMigrationErr(sub);
  return `<div class="rr-empty">
    <div class="rr-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
    <div class="rr-empty-title">${esc(title)}</div>
    <div class="rr-empty-sub">${esc(sub || "")}${deploying ? " — if Workbooks just shipped, the database migration (0412) may still be deploying. Give it a minute and reload." : ""}</div>
    <div class="rr-empty-action"><button type="button" class="btn btn-sm" data-wb-act="back-to-list">Back to workbooks</button></div>
  </div>`;
}

// ─── List page ───────────────────────────────────────────────────────────────

async function renderListPage() {
  const root = wbRoot();
  if (!root) return;
  restoreVaultNode();
  closeRealtime();
  WB.view = "list";
  const cmd = document.getElementById("rr-wb-cmd");
  if (cmd) cmd.style.display = "";
  syncWbTabs("workbooks");
  try {
    await Promise.all([fetchWorkbooksList(), fetchUsers()]);
  } catch (e) {
    root.innerHTML = wbErrorHtml("Couldn't load workbooks", (e && e.message) || String(e));
    return;
  }
  renderListBody(root);
}

// ── Favorites: starred workbooks float to a top row. Stars live in
// localStorage per tenant — a personal, per-browser shortlist.
function wbFavKey() { const d = _dsp(); return "rr-wb-favs-" + ((d && d.id) || "x"); }
function wbFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(wbFavKey()) || "[]");
    return new Set(Array.isArray(a) ? a : []);
  } catch (_) { return new Set(); }
}
function toggleWbFav(id) {
  const s = wbFavs();
  if (s.has(id)) s.delete(id); else s.add(id);
  try { localStorage.setItem(wbFavKey(), JSON.stringify([...s])); } catch (_) {}
}

// List body renders from the cached WB.workbooks — star toggles rebuild
// it instantly without refetching.
function renderListBody(root) {
  root = root || wbRoot();
  if (!root || WB.view !== "list") return;
  // report workbooks live under the Reports tab, not here
  const active = WB.workbooks.filter((w) => !w.archived_at && !isReportWb(w));
  const archived = WB.workbooks.filter((w) => w.archived_at && !isReportWb(w));
  const list = WB.showArchived ? archived : active;
  const favs = wbFavs();

  const self = _me();
  const canAdminWb = (w) => !!self && (w.owner_user_id === self.id || ["ops", "owner", "platform_admin"].includes(self.role));
  const card = (w) => {
    const tpl = WB_TEMPLATES.find((t) => t.key === w.template_key);
    const fav = favs.has(w.id);
    return `<button type="button" class="wb-card" data-wb-open="${esc(w.id)}">
      <span class="wb-fav ${fav ? "is-fav" : ""}" data-wb-fav="${esc(w.id)}" role="button" tabindex="0" title="${fav ? "Remove from favorites" : "Add to favorites"}" aria-label="${fav ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${fav}">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2.5 15.09 8.6 21.8 9.55 16.9 14.25 18.08 20.9 12 17.77 5.92 20.9 7.1 14.25 2.2 9.55 8.91 8.6 12 2.5"/></svg>
      </span>
      ${canAdminWb(w) ? `<span class="wb-cardmenu" data-wb-cardmenu="${esc(w.id)}" role="button" tabindex="0" title="Workbook actions" aria-label="Workbook actions">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </span>` : ""}
      <span class="wb-card-ic">${WB_ICON_SVG}</span>
      <span class="wb-card-main">
        <span class="wb-card-title">${esc(w.title || "Untitled workbook")}</span>
        ${w.description ? `<span class="wb-card-desc">${esc(w.description)}</span>` : ""}
        <span class="wb-card-meta">
          ${esc(userName(w.owner_user_id))} · ${esc(relTime(w.updated_at))}
          ${w.visibility === "private" ? `<span class="wb-badge">Private</span>` : ""}
          ${w.archived_at ? `<span class="wb-badge is-muted">Archived</span>` : ""}
          ${tpl ? `<span class="wb-badge is-muted">${esc(tpl.name)}</span>` : ""}
        </span>
      </span>
    </button>`;
  };

  const favList = list.filter((w) => favs.has(w.id));
  const restList = list.filter((w) => !favs.has(w.id));
  const cardsHtml = favList.length
    ? `<div class="wb-list-sec">★ Favorites</div>
       <div class="wb-cards">${favList.map(card).join("")}</div>
       ${restList.length ? `<div class="wb-list-sec">All workbooks</div><div class="wb-cards">${restList.map(card).join("")}</div>` : ""}`
    : `<div class="wb-cards">${list.map(card).join("")}</div>`;

  // the New workbook action lives in the page strip (schedule-style
  // chrome in view-workbooks.frag) — the list body is just the cards
  root.innerHTML = `
    ${list.length ? cardsHtml : WB.showArchived ? `
      <div class="rr-empty">
        <div class="rr-empty-icon">${WB_ICON_SVG}</div>
        <div class="rr-empty-title">No archived workbooks</div>
        <div class="rr-empty-sub">Workbooks you archive will land here.</div>
      </div>` : `
      <div class="rr-empty">
        <div class="rr-empty-icon">${WB_ICON_SVG}</div>
        <div class="rr-empty-title">No workbooks yet</div>
        <div class="rr-empty-sub">Start with a template — route coverage, peak staffing, payroll prep — or a blank workbook with a spreadsheet, notes, and a checklist.</div>
        <div class="rr-empty-action"><button type="button" class="btn btn-primary btn-sm" data-wb-act="new-workbook">Create your first workbook</button></div>
      </div>`}
    <div class="wb-list-foot">
      ${archived.length || WB.showArchived ? `<button type="button" class="btn btn-ghost btn-sm" data-wb-act="toggle-archived">${WB.showArchived ? "Show active workbooks" : `Archived (${archived.length})`}</button>` : ""}
    </div>`;
}

const WB_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/><line x1="3" y1="14.5" x2="21" y2="14.5"/></svg>`;

// ─── Create-workbook modal ──────────────────────────────────────────────────

// "New workbook" skips the old create dialog (title/visibility/template
// picker) — it creates a blank org-visible workbook and opens it
// straight into the grid, Sheets-style. Rename in the header when ready.
async function createBlankWorkbookNow() {
  if (WB.creating) return;
  WB.creating = true;
  _toast("Creating workbook…", "info");
  try {
    const wb = await createWorkbook({ title: "", description: "", visibility: "org", templateKey: null });
    await openWorkbook(wb.id);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    _toast(wbMigrationErr(msg) ? "Workbooks schema isn't deployed yet — apply migration 0412 and retry" : "Couldn't create the workbook: " + msg, "error");
  } finally { WB.creating = false; }
}

function openCreateModal() {
  document.getElementById("wb-create-modal")?.remove();
  const tplCard = (t) => `<button type="button" class="wb-tpl-card" data-wb-tpl="${esc(t.key)}">
    <span class="wb-tpl-name">${esc(t.name)}</span>
    <span class="wb-tpl-cat">${esc(t.category)}</span>
    <span class="wb-tpl-desc">${esc(t.desc)}</span>
  </button>`;
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-create-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="New workbook" style="width:760px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content">
          <span class="rr-modal-eyebrow">${WB_ICON_SVG} Operations Workbook</span>
          <p class="rr-modal-title">New workbook</p>
        </div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <label class="wb-field"><span class="wb-field-label">Title</span>
          <input type="text" class="wb-input" id="wb-new-title" maxlength="200" placeholder="Weekly Route Coverage Plan" autocomplete="off"></label>
        <label class="wb-field"><span class="wb-field-label">Description <span class="wb-field-opt">optional</span></span>
          <input type="text" class="wb-input" id="wb-new-desc" maxlength="500" placeholder="What is this workbook for?" autocomplete="off"></label>
        <div class="wb-field"><span class="wb-field-label">Who can see it</span>
          <div class="wb-vis-row" role="radiogroup" aria-label="Visibility">
            <label class="wb-vis-opt"><input type="radio" name="wb-new-vis" value="org" checked> <span><strong>Everyone at ${esc((_dsp() && _dsp().name) || "your DSP")}</strong><br><span class="wb-vis-sub">Teammates can view and edit</span></span></label>
            <label class="wb-vis-opt"><input type="radio" name="wb-new-vis" value="private"> <span><strong>Only me</strong><br><span class="wb-vis-sub">Share with specific people later</span></span></label>
          </div>
        </div>
        <div class="wb-field"><span class="wb-field-label">Start from</span>
          <div class="wb-tpls">
            <button type="button" class="wb-tpl-card is-selected" data-wb-tpl="">
              <span class="wb-tpl-name">Blank workbook</span>
              <span class="wb-tpl-cat">Start fresh</span>
              <span class="wb-tpl-desc">One empty spreadsheet — add notes and checklists as you go.</span>
            </button>
            ${WB_TEMPLATES.map(tplCard).join("")}
          </div>
        </div>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-wb-act="create-workbook">Create workbook</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { close(); return; }
    const tplBtn = e.target.closest("[data-wb-tpl]");
    if (tplBtn) {
      wrap.querySelectorAll(".wb-tpl-card").forEach((b) => b.classList.toggle("is-selected", b === tplBtn));
      const t = WB_TEMPLATES.find((x) => x.key === tplBtn.getAttribute("data-wb-tpl"));
      const titleEl = wrap.querySelector("#wb-new-title");
      if (t && titleEl && !titleEl.dataset.touched) titleEl.placeholder = t.name;
      return;
    }
    if (e.target.closest('[data-wb-act="create-workbook"]')) submitCreate(wrap);
  });
  wrap.querySelector("#wb-new-title").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("wb-input")) submitCreate(wrap);
  });
  setTimeout(() => wrap.querySelector("#wb-new-title")?.focus(), 30);
}

async function submitCreate(wrap) {
  const btn = wrap.querySelector('[data-wb-act="create-workbook"]');
  if (btn.disabled) return;
  const tplKey = wrap.querySelector(".wb-tpl-card.is-selected")?.getAttribute("data-wb-tpl") || "";
  const title = wrap.querySelector("#wb-new-title").value.trim();
  const desc = wrap.querySelector("#wb-new-desc").value.trim();
  const vis = wrap.querySelector('input[name="wb-new-vis"]:checked')?.value || "org";
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const wb = await createWorkbook({ title, description: desc, visibility: vis, templateKey: tplKey || null });
    wrap.remove();
    await openWorkbook(wb.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Create workbook";
    const msg = (e && e.message) || String(e);
    _toast(wbMigrationErr(msg) ? "Workbooks schema isn't deployed yet — apply migration 0412 and retry" : "Couldn't create the workbook: " + msg, "error");
  }
}

// ─── Detail page ─────────────────────────────────────────────────────────────

function renderDetailPage() {
  const root = wbRoot();
  const wb = WB.wb;
  if (!root || !wb) return;
  const cmd = document.getElementById("rr-wb-cmd");
  if (cmd) cmd.style.display = "none"; // full canvas while a workbook is open
  const ro = !WB.canEdit;
  root.innerHTML = `
    <div class="wb-detail ${WB.panelOpen ? "is-panel-open" : ""}" id="wb-detail">
      <div class="wb-head">
        <button type="button" class="btn btn-ghost btn-icon" data-wb-act="back-to-list" title="All workbooks" aria-label="Back to workbooks">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </button>
        <input type="text" class="wb-title-input" id="wb-title-input" value="${esc(wb.title)}" maxlength="200" ${ro ? "readonly" : ""} aria-label="Workbook title">
        <div class="wb-menubar" role="menubar" aria-label="Workbook menus">
          ${WB_MENUS.map((n) => `<button type="button" class="wb-menubtn" data-wb-menubar="${n}" role="menuitem">${n}</button>`).join("")}
        </div>
        <div class="wb-head-side">
          <span data-wb-savestate></span>
          <span class="wb-presence" id="wb-presence"></span>
          ${ro ? `<span class="wb-badge" title="You can view${canCommentOnly() ? " and comment" : ""}, but not edit">Read-only</span>` : ""}
          <span class="popover-anchor">
            <button type="button" class="btn btn-ghost btn-icon ${wb.description ? "is-on" : ""}" data-wb-act="desc-menu" title="Workbook description" aria-haspopup="true" aria-label="Workbook description">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="13" y2="14"/></svg>
            </button>
            <div class="popover wb-desc-pop">
              <input type="text" class="wb-desc-input" id="wb-desc-input" value="${esc(wb.description || "")}" maxlength="500" placeholder="${ro ? "" : "Add a description…"}" ${ro ? "readonly" : ""} aria-label="Workbook description">
            </div>
          </span>
          <span class="popover-anchor">
            <button type="button" class="btn btn-ghost btn-icon" data-wb-act="head-menu" title="Workbook actions" aria-haspopup="menu" aria-label="Workbook actions">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
            </button>
            <div class="popover wb-head-pop" role="menu">
              ${WB.canAdmin ? `<button type="button" class="popover-item" data-wb-act="${wb.archived_at ? "unarchive-wb" : "archive-wb"}" role="menuitem">${wb.archived_at ? "Restore workbook" : "Archive workbook"}</button>` : ""}
              ${WB.canAdmin ? `<button type="button" class="popover-item is-danger" data-wb-act="delete-wb" role="menuitem">Delete workbook…</button>` : ""}
            </div>
          </span>
        </div>
      </div>
      ${wb.archived_at ? `<div class="wb-archived-note">This workbook is archived — it's read-only in spirit; restore it from the ⋯ menu to keep working.</div>` : ""}
      <div class="wb-body">
        <div class="wb-blocks" id="wb-blocks"></div>
        <aside class="wb-panel" id="wb-panel" aria-label="Workbook panel" ${WB.panelOpen ? "" : "hidden"}></aside>
      </div>
    </div>`;

  // Workbooks are spreadsheets — the block system is retired. Legacy
  // note/checklist blocks stay in the database but are no longer shown,
  // and there's no way to add new ones.
  const blocksEl = document.getElementById("wb-blocks");
  const sheetBlocks = WB.blocks.filter((b) => b.type === "sheet");
  if (!sheetBlocks.length) {
    blocksEl.innerHTML = `<div class="rr-empty">
      <div class="rr-empty-icon">${WB_ICON_SVG}</div>
      <div class="rr-empty-title">This workbook is empty</div>
      <div class="rr-empty-sub">Add a spreadsheet to get started.</div>
      ${WB.canEdit ? `<div class="rr-empty-action wb-add-row">
        <button type="button" class="btn btn-sm" data-wb-act="add-block" data-type="sheet">+ Spreadsheet</button>
      </div>` : ""}
    </div>`;
  } else {
    for (const block of sheetBlocks) blocksEl.appendChild(buildBlockEl(block));
  }
  // Sheets model: the workbook page never scrolls — the detail column is
  // locked to the viewport, the grid is the main scroller, and anything
  // taller (charts, legacy blocks) scrolls inside .wb-blocks with the
  // toolbar + formula bar pinned sticky at its top.
  const detailEl = document.getElementById("wb-detail");
  WB.fitDetail = () => {
    const d = document.getElementById("wb-detail");
    if (!d || d !== detailEl) return;
    const top = d.getBoundingClientRect().top + window.scrollY;
    d.style.height = Math.max(420, window.innerHeight - top - 10) + "px";
  };
  WB.fitDetail();
  if (!WB.fitDetailBound) {
    WB.fitDetailBound = true;
    window.addEventListener("resize", () => { if (WB.fitDetail) WB.fitDetail(); });
    document.addEventListener("fullscreenchange", () => { if (WB.fitDetail) WB.fitDetail(); });
  }
  bindDetailInputs();
  renderPresence();
  if (WB.panelOpen) renderPanel();
  paintCommentMarkers();
}

function canCommentOnly() {
  const self = _me();
  if (!self || !WB.wb) return false;
  const mine = WB.permissions.find((p) => p.subject_type === "user" && p.subject_id === self.id);
  return !WB.canEdit && (WB.wb.visibility === "org" || !!mine);
}

function bindDetailInputs() {
  const t = document.getElementById("wb-title-input");
  const d = document.getElementById("wb-desc-input");
  if (t) t.addEventListener("input", () => {
    if (!WB.canEdit) return;
    const prev = WB.wb.title;
    WB.wb.title = t.value.trim() || "Untitled workbook";
    saveWbMeta();
    clearTimeout(t._logT);
    t._logT = setTimeout(() => { if (prev !== WB.wb.title) wbLog("workbook.renamed", `renamed the workbook to “${WB.wb.title}”`); }, 2500);
  });
  if (d) d.addEventListener("input", () => {
    if (!WB.canEdit) return;
    WB.wb.description = d.value.trim();
    // the head icon lights up while a description exists
    document.querySelector('[data-wb-act="desc-menu"]')?.classList.toggle("is-on", !!WB.wb.description);
    saveWbMeta();
    clearTimeout(d._logT);
    d._logT = setTimeout(() => wbLog("workbook.description", "updated the description"), 2500);
  });
}

function renderPresence() {
  const el = document.getElementById("wb-presence");
  if (!el) return;
  const self = _me();
  const others = WB.presence.filter((p) => !self || p.id !== self.id);
  if (!others.length) { el.innerHTML = ""; return; }
  const chips = others.slice(0, 4).map((p) => `<span class="wb-avatar" title="${esc(p.name)} is viewing">${esc(initialsOf(p.name))}</span>`).join("");
  el.innerHTML = chips + (others.length > 1 ? `<span class="wb-presence-n">${others.length} viewing</span>` : "");
}

// ─── Block chrome ───────────────────────────────────────────────────────────

function buildBlockEl(block) {
  // no block chrome — the workbook IS the spreadsheet, so the grid
  // mounts bare (no "Spreadsheet" title bar, no block kebab)
  const el = document.createElement("section");
  const primarySheet = block.type === "sheet" && (WB.blocks.find((b) => b.type === "sheet") || {}).id === block.id;
  el.className = "wb-block wb-block-" + block.type + (primarySheet ? " wb-block-primary" : "");
  el.dataset.wbBlock = block.id;
  el.innerHTML = `<div class="wb-block-body" data-wb-block-body="${block.id}"></div>`;
  const body = el.querySelector(".wb-block-body");
  if (block.type === "sheet") mountSheetBlock(block, body);
  else body.innerHTML = `<div class="rr-empty-inline">This block type (“${esc(block.type)}”) isn't supported in this version yet.</div>`;
  return el;
}

async function addBlock(type) {
  if (!WB.canEdit || !WB.wb) return;
  const s = _sb();
  const dsp = _dsp();
  try {
    const pos = WB.blocks.length ? Math.max(...WB.blocks.map((b) => b.position)) + 1 : 0;
    const ins = await s.from("workbook_blocks").insert({
      dsp_id: dsp.id, workbook_id: WB.wb.id, type, title: "", position: pos,
      settings: {}, content: type === "text" ? { html: "" } : {},
    }).select().single();
    if (ins.error) throw ins.error;
    const block = { ...ins.data, settings: ins.data.settings || {}, content: ins.data.content || {} };
    if (type === "sheet") {
      const shIns = await s.from("workbook_sheets").insert({
        dsp_id: dsp.id, workbook_id: WB.wb.id, block_id: block.id, name: "Sheet 1", position: 0, row_count: 500,
      }).select().single();
      if (shIns.error) throw shIns.error;
      WB.sheetsByBlock.set(block.id, [normalizeSheet(shIns.data)]);
    }
    WB.blocks.push(block);
    wbLog("block.added", `added a ${type === "sheet" ? "spreadsheet" : type} block`, { target_type: "block", target_id: block.id });
    renderDetailPage();
    document.querySelector(`[data-wb-block="${block.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) { _toast("Couldn't add the block: " + ((e && e.message) || e), "error"); }
}

async function moveBlock(blockId, dir) {
  const idx = WB.blocks.findIndex((b) => b.id === blockId);
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= WB.blocks.length) return;
  const [b] = WB.blocks.splice(idx, 1);
  WB.blocks.splice(to, 0, b);
  WB.blocks.forEach((blk, i) => { blk.position = i; });
  renderDetailPage();
  try {
    for (const blk of WB.blocks) await _sb().from("workbook_blocks").update({ position: blk.position }).eq("id", blk.id);
  } catch (e) { console.warn("block reorder:", e && e.message); }
}

async function deleteBlock(blockId) {
  const block = WB.blocks.find((b) => b.id === blockId);
  if (!block) return;
  const label = block.title || { sheet: "spreadsheet", text: "note", checklist: "checklist" }[block.type] || "block";
  confirmModal({
    title: "Delete this block?",
    body: `“${esc(label)}” and everything in it will be permanently deleted. This can't be undone.`,
    confirmLabel: "Delete block",
    danger: true,
    onConfirm: async () => {
      try {
        const res = await _sb().from("workbook_blocks").delete().eq("id", blockId);
        if (res.error) throw res.error;
        WB.blocks = WB.blocks.filter((b) => b.id !== blockId);
        WB.sheetsByBlock.delete(blockId);
        WB.itemsByBlock.delete(blockId);
        GRIDS.delete(blockId);
        wbLog("block.deleted", `deleted a ${block.type} block${block.title ? ` (“${block.title}”)` : ""}`);
        renderDetailPage();
      } catch (e) { _toast("Couldn't delete the block: " + ((e && e.message) || e), "error"); }
    },
  });
}

// Small confirm dialog on the .rr-modal pattern.
function confirmModal({ title, body, confirmLabel, danger, onConfirm }) {
  document.getElementById("wb-confirm-modal")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-confirm-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:440px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">${esc(title)}</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body"><p class="wb-confirm-body">${body}</p></div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn ${danger ? "danger" : "primary"}" type="button" data-wb-confirm>${esc(confirmLabel || "Confirm")}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-wb-confirm]")) {
      const btn = wrap.querySelector("[data-wb-confirm]");
      btn.disabled = true;
      await onConfirm();
      wrap.remove();
    }
  });
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); wrap.remove(); } });
  setTimeout(() => wrap.querySelector("[data-wb-confirm]")?.focus(), 30);
}

// ─── Rich text block ─────────────────────────────────────────────────────────
// A deliberately small editor: headings, paragraph text, bold/italic/
// underline, lists, dividers, links, inline code. Content is sanitized
// through the allowlist on both save and render.

function mountTextBlock(block, body) {
  const html = sanitizeHtml((block.content && block.content.html) || "");
  const ro = !WB.canEdit;
  body.innerHTML = `
    ${ro ? "" : `<div class="wb-rt-toolbar" role="toolbar" aria-label="Text formatting">
      <button type="button" class="wb-tbtn" data-rt-cmd="formatBlock" data-val="h1" title="Heading 1">H1</button>
      <button type="button" class="wb-tbtn" data-rt-cmd="formatBlock" data-val="h2" title="Heading 2">H2</button>
      <button type="button" class="wb-tbtn" data-rt-cmd="formatBlock" data-val="p" title="Paragraph">¶</button>
      <span class="wb-tsep"></span>
      <button type="button" class="wb-tbtn" data-rt-cmd="bold" title="Bold (Ctrl+B)"><strong>B</strong></button>
      <button type="button" class="wb-tbtn" data-rt-cmd="italic" title="Italic (Ctrl+I)"><em>I</em></button>
      <button type="button" class="wb-tbtn" data-rt-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
      <span class="wb-tsep"></span>
      <button type="button" class="wb-tbtn" data-rt-cmd="insertUnorderedList" title="Bulleted list">•≡</button>
      <button type="button" class="wb-tbtn" data-rt-cmd="insertOrderedList" title="Numbered list">1≡</button>
      <button type="button" class="wb-tbtn" data-rt-cmd="insertHorizontalRule" title="Divider">—</button>
      <button type="button" class="wb-tbtn" data-rt-cmd="link" title="Link">⧉</button>
      <button type="button" class="wb-tbtn" data-rt-cmd="code" title="Inline code">&lt;/&gt;</button>
    </div>`}
    <div class="wb-rt ${ro ? "is-readonly" : ""}" ${ro ? "" : 'contenteditable="true"'} data-wb-rt="${block.id}" aria-label="Note content">${html || (ro ? `<p class="wb-rt-empty">No notes yet.</p>` : "")}</div>`;
  const rt = body.querySelector(".wb-rt");
  if (ro) return;
  if (!html) rt.innerHTML = "<p><br></p>";
  const save = debounce(() => {
    const clean = sanitizeHtml(rt.innerHTML);
    block.content = { html: clean, plain: richTextToPlain(clean) };
    saveBlock(block, { content: block.content });
    clearTimeout(rt._logT);
    rt._logT = setTimeout(() => wbLog("text.edited", `edited ${block.title ? `“${block.title}”` : "a note block"}`, { target_type: "block", target_id: block.id }), 4000);
  }, 900);
  rt.addEventListener("input", save);
  rt.addEventListener("blur", () => save.flushNow());
  rt.addEventListener("paste", (e) => {
    // paste as sanitized content, never raw markup
    e.preventDefault();
    const htmlData = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    const clean = htmlData ? sanitizeHtml(htmlData) : esc(text).replace(/\n/g, "<br>");
    document.execCommand("insertHTML", false, clean);
  });
  body.querySelector(".wb-rt-toolbar")?.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
  body.querySelector(".wb-rt-toolbar")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rt-cmd]");
    if (!btn) return;
    const cmd = btn.getAttribute("data-rt-cmd");
    rt.focus();
    if (cmd === "link") {
      const url = window.prompt("Link URL (https://…)");
      if (url && /^https?:\/\//i.test(url.trim())) document.execCommand("createLink", false, url.trim());
      else if (url) _toast("Links must start with http:// or https://", "warn");
    } else if (cmd === "code") {
      const sel = String(window.getSelection() || "");
      if (sel) document.execCommand("insertHTML", false, `<code>${esc(sel)}</code>`);
    } else if (cmd === "formatBlock") {
      document.execCommand("formatBlock", false, btn.getAttribute("data-val"));
    } else {
      document.execCommand(cmd, false, null);
    }
    save();
  });
}

// ─── Checklist block ─────────────────────────────────────────────────────────

function mountChecklistBlock(block, body) {
  body.innerHTML = `<div class="wb-cl" data-wb-cl="${block.id}"></div>
    ${WB.canEdit ? `<div class="wb-cl-add">
      <input type="text" class="wb-input wb-cl-add-input" placeholder="Add an item and press Enter…" maxlength="300" aria-label="New checklist item">
    </div>` : ""}`;
  // pass the local host — during renderDetailPage the block element is
  // still detached, so a document-level query would find nothing
  renderChecklistBlockBody(block, body.querySelector(".wb-cl"));
  const addInput = body.querySelector(".wb-cl-add-input");
  if (addInput) addInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const label = addInput.value.trim();
    if (!label) return;
    addInput.value = "";
    await addChecklistItem(block, label);
  });
}

function renderChecklistBlockBody(block, hostEl) {
  const host = hostEl || document.querySelector(`[data-wb-cl="${block.id}"]`);
  if (!host) return;
  const items = (WB.itemsByBlock.get(block.id) || []).slice().sort((a, b) => (a.position - b.position) || a.created_at.localeCompare(b.created_at));
  if (!items.length) {
    host.innerHTML = `<div class="rr-empty-inline">No items yet${WB.canEdit ? " — add the first one below." : "."}</div>`;
    return;
  }
  const open = items.filter((i) => !i.completed_at).length;
  host.innerHTML = `
    <div class="wb-cl-progress"><span>${items.length - open}/${items.length} done</span><span class="wb-cl-bar"><span style="width:${items.length ? Math.round(((items.length - open) / items.length) * 100) : 0}%"></span></span></div>
    ${items.map((it) => checklistItemHtml(it)).join("")}`;
}

function checklistItemHtml(it) {
  const done = !!it.completed_at;
  const overdue = !done && it.due_date && it.due_date < new Date().toISOString().slice(0, 10);
  const assignee = it.assignee_user_id ? userName(it.assignee_user_id) : "";
  return `<div class="wb-cl-item ${done ? "is-done" : ""}" data-wb-item="${it.id}">
    <button type="button" class="wb-cl-check" data-wb-act="item-toggle" role="checkbox" aria-checked="${done}" aria-label="${done ? "Mark incomplete" : "Mark complete"}" ${WB.canEdit ? "" : "disabled"}>
      ${done ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
    </button>
    <span class="wb-cl-label">${esc(it.label)}</span>
    ${it.priority && it.priority !== "normal" ? `<span class="wb-chip is-${it.priority}">${it.priority === "high" ? "High" : "Low"}</span>` : ""}
    ${it.due_date ? `<span class="wb-chip ${overdue ? "is-overdue" : ""}" title="Due date">${esc(new Date(it.due_date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</span>` : ""}
    ${assignee ? `<span class="wb-avatar wb-avatar-sm" title="Assigned to ${esc(assignee)}">${esc(initialsOf(assignee))}</span>` : ""}
    ${WB.canEdit ? `<button type="button" class="btn btn-ghost btn-icon btn-sm wb-cl-edit" data-wb-act="item-edit" title="Edit item" aria-label="Edit item">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>` : ""}
  </div>`;
}

async function addChecklistItem(block, label, extra) {
  try {
    const items = WB.itemsByBlock.get(block.id) || [];
    const ins = await _sb().from("workbook_checklist_items").insert({
      dsp_id: WB.wb.dsp_id, workbook_id: WB.wb.id, block_id: block.id,
      label, position: items.length ? Math.max(...items.map((i) => i.position)) + 1 : 0,
      created_by: _me() ? _me().id : null,
      ...(extra || {}),
    }).select().single();
    if (ins.error) throw ins.error;
    if (!WB.itemsByBlock.has(block.id)) WB.itemsByBlock.set(block.id, []);
    WB.itemsByBlock.get(block.id).push(ins.data);
    renderChecklistBlockBody(block);
    if (WB.panelOpen && WB.panelTab === "tasks") renderPanelBody();
    wbLog("task.created", `added “${label}”`, { target_type: "checklist_item", target_id: ins.data.id });
  } catch (e) { _toast("Couldn't add the item: " + ((e && e.message) || e), "error"); }
}

function findItem(itemId) {
  for (const [blockId, arr] of WB.itemsByBlock) {
    const it = arr.find((x) => x.id === itemId);
    if (it) return { item: it, blockId };
  }
  return null;
}

async function toggleItem(itemId) {
  const found = findItem(itemId);
  if (!found || !WB.canEdit) return;
  const it = found.item;
  const done = !it.completed_at;
  const patch = done
    ? { completed_at: new Date().toISOString(), completed_by: _me() ? _me().id : null }
    : { completed_at: null, completed_by: null };
  Object.assign(it, patch);
  const block = WB.blocks.find((b) => b.id === found.blockId);
  if (block) renderChecklistBlockBody(block);
  if (WB.panelOpen && WB.panelTab === "tasks") renderPanelBody();
  try {
    const res = await _sb().from("workbook_checklist_items").update(patch).eq("id", itemId);
    if (res.error) throw res.error;
    if (done) wbLog("task.completed", `completed “${it.label}”`, { target_type: "checklist_item", target_id: it.id });
  } catch (e) { _toast("Couldn't update the item", "error"); }
}

function openItemEditor(itemId) {
  const found = findItem(itemId);
  if (!found) return;
  const it = found.item;
  document.getElementById("wb-item-modal")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-item-modal";
  const userOpts = [`<option value="">Unassigned</option>`]
    .concat(WB.users.map((u) => `<option value="${esc(u.id)}" ${u.id === it.assignee_user_id ? "selected" : ""}>${esc(u.full_name || u.email || "Teammate")}</option>`)).join("");
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Edit checklist item" style="width:480px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Edit item</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <label class="wb-field"><span class="wb-field-label">Item</span>
          <input type="text" class="wb-input" id="wb-item-label" value="${esc(it.label)}" maxlength="300"></label>
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Assignee</span>
            <select class="wb-input" id="wb-item-assignee">${userOpts}</select></label>
          <label class="wb-field"><span class="wb-field-label">Due date</span>
            <input type="date" class="wb-input" id="wb-item-due" value="${esc(it.due_date || "")}"></label>
          <label class="wb-field"><span class="wb-field-label">Priority</span>
            <select class="wb-input" id="wb-item-priority">
              <option value="" ${!it.priority || it.priority === "normal" ? "selected" : ""}>Normal</option>
              <option value="high" ${it.priority === "high" ? "selected" : ""}>High</option>
              <option value="low" ${it.priority === "low" ? "selected" : ""}>Low</option>
            </select></label>
        </div>
        <label class="wb-field"><span class="wb-field-label">Notes <span class="wb-field-opt">optional</span></span>
          <textarea class="wb-input" id="wb-item-note" rows="2" maxlength="1000">${esc(it.note || "")}</textarea></label>
      </div>
      <div class="rr-modal-foot" style="justify-content:space-between">
        <button class="rr-modal-btn" type="button" data-wb-item-delete style="color:var(--red)">Delete</button>
        <span style="display:flex;gap:8px">
          <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
          <button class="rr-modal-btn primary" type="button" data-wb-item-save>Save</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); wrap.remove(); } });
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-wb-item-delete]")) {
      wrap.remove();
      confirmModal({
        title: "Delete this item?", body: `“${esc(it.label)}” will be removed from the checklist.`, confirmLabel: "Delete item", danger: true,
        onConfirm: async () => {
          try {
            const res = await _sb().from("workbook_checklist_items").delete().eq("id", it.id);
            if (res.error) throw res.error;
            WB.itemsByBlock.set(found.blockId, (WB.itemsByBlock.get(found.blockId) || []).filter((x) => x.id !== it.id));
            const block = WB.blocks.find((b) => b.id === found.blockId);
            if (block) renderChecklistBlockBody(block);
            if (WB.panelOpen && WB.panelTab === "tasks") renderPanelBody();
          } catch (err) { _toast("Couldn't delete the item", "error"); }
        },
      });
      return;
    }
    if (e.target.closest("[data-wb-item-save]")) {
      const patch = {
        label: wrap.querySelector("#wb-item-label").value.trim() || it.label,
        assignee_user_id: wrap.querySelector("#wb-item-assignee").value || null,
        due_date: wrap.querySelector("#wb-item-due").value || null,
        priority: wrap.querySelector("#wb-item-priority").value || null,
        note: wrap.querySelector("#wb-item-note").value.trim(),
      };
      const hadAssignee = it.assignee_user_id;
      try {
        const res = await _sb().from("workbook_checklist_items").update(patch).eq("id", it.id);
        if (res.error) throw res.error;
        Object.assign(it, patch);
        wrap.remove();
        const block = WB.blocks.find((b) => b.id === found.blockId);
        if (block) renderChecklistBlockBody(block);
        if (WB.panelOpen && WB.panelTab === "tasks") renderPanelBody();
        if (patch.assignee_user_id && patch.assignee_user_id !== hadAssignee) {
          wbLog("task.assigned", `assigned “${it.label}” to ${userName(patch.assignee_user_id)}`, { target_type: "checklist_item", target_id: it.id });
        }
      } catch (err) { _toast("Couldn't save the item", "error"); }
    }
  });
  setTimeout(() => wrap.querySelector("#wb-item-label")?.focus(), 30);
}

// ─── Spreadsheet grid ────────────────────────────────────────────────────────
// Both axes are virtualized: prefix-sum geometry over row heights /
// column widths, binary search for the visible window, and a single
// innerHTML paint per frame. DOM stays at viewport-size (~500–900 cell
// nodes) regardless of sheet size, which carries the 1,000×50 target
// comfortably.

const DEF_COL_W = 120, MIN_COL_W = 40, MAX_COL_W = 500;
const DEF_ROW_H = 28, MIN_ROW_H = 22, MAX_ROW_H = 300;
const HDR_COL_W = 46, HDR_ROW_H = 26;
const GRID_MAX_H = 460;

function colW(sheet, c) {
  if (sheet.hiddenCols && sheet.hiddenCols.has(c)) return 0;
  const w = sheet.colWidths && sheet.colWidths[c];
  return typeof w === "number" ? Math.min(MAX_COL_W, Math.max(MIN_COL_W, w)) : DEF_COL_W;
}
function rowH(sheet, r) { const h = sheet.rowHeights && sheet.rowHeights[r]; return typeof h === "number" ? Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, h)) : DEF_ROW_H; }

function mountSheetBlock(block, body) {
  const sheets = WB.sheetsByBlock.get(block.id) || [];
  if (!sheets.length) {
    body.innerHTML = `<div class="rr-empty-inline">This spreadsheet block has no sheets.${WB.canEdit ? ` <button type="button" class="btn btn-sm" data-wb-act="sheet-add" data-block="${block.id}">Add a sheet</button>` : ""}</div>`;
    return;
  }
  const sheet = activeSheetOf(block);
  const ro = !WB.canEdit;
  body.innerHTML = `
    <div class="wb-chrome">
    ${sheetToolbarHtml(block, ro)}
    <div class="wb-fbar">
      <input type="text" class="wb-fbar-ref" data-wb-fbar-ref value="A1" aria-label="Name box — type a cell reference and press Enter" autocomplete="off" spellcheck="false">
      <span class="wb-fbar-fx" aria-hidden="true">fx</span>
      <input type="text" class="wb-fbar-input" data-wb-fbar-input placeholder="${ro ? "" : "Enter a value or =formula"}" ${ro ? "readonly" : ""} aria-label="Formula bar" autocomplete="off" spellcheck="false">
      <span class="wb-fbar-err" data-wb-fbar-err hidden></span>
    </div>
    </div>
    <div class="wb-grid ${ro ? "is-readonly" : ""}" tabindex="0" role="grid" aria-label="${esc(block.title || "Spreadsheet")}" data-wb-gridfocus="${block.id}">
      <div class="wb-gr-corner" style="width:${HDR_COL_W}px;height:${HDR_ROW_H}px"></div>
      <div class="wb-gr-cols" style="left:${HDR_COL_W}px;height:${HDR_ROW_H}px"><div class="wb-gr-cols-inner"></div></div>
      <div class="wb-gr-rows" style="top:${HDR_ROW_H}px;width:${HDR_COL_W}px"><div class="wb-gr-rows-inner"></div></div>
      <div class="wb-gr-frozen-top" style="left:${HDR_COL_W}px;top:${HDR_ROW_H}px" hidden><div class="wb-gr-frozen-top-inner"></div></div>
      <div class="wb-gr-frozen-left" style="top:${HDR_ROW_H}px" hidden><div class="wb-gr-frozen-left-inner"></div></div>
      <div class="wb-gr-scroll" style="left:${HDR_COL_W}px;top:${HDR_ROW_H}px">
        <div class="wb-gr-canvas">
          <div class="wb-gr-cells"></div>
          <div class="wb-gr-refhl" aria-hidden="true"></div>
          <div class="wb-gr-sel" aria-hidden="true"></div>
          <div class="wb-addrows-row" data-wb-addrowsrow>
            <div class="wb-addrows" data-wb-addrows>
              <button type="button" class="wb-addrows-btn" data-wb-addbtn ${ro ? "disabled" : ""}>Add</button>
              <input type="number" class="wb-addrows-n" data-wb-addn value="1000" min="1" max="20000" step="1" ${ro ? "disabled" : ""} aria-label="Rows to add">
              <span class="wb-addrows-lbl">more rows at the bottom</span>
            </div>
          </div>
        </div>
      </div>
      <div class="wb-gr-filterchip" hidden></div>
    </div>
    <div class="wb-charts" data-wb-charts hidden></div>
    <div class="wb-pivots" data-wb-pivots hidden></div>
    <div class="wb-tabs" data-wb-tabs="${block.id}"></div>
    <div class="wb-statusbar" data-wb-statusbar>
      <span class="wb-sb-mode" data-wb-sbmode>Ready</span>
      <span class="wb-sb-filter" data-wb-sbfilter></span>
      <span class="wb-selstats" data-wb-selstats aria-live="polite"></span>
      <select class="wb-sb-zoom" data-wb-zoom aria-label="Zoom" title="Zoom">
        <option value="0.5">50%</option>
        <option value="0.75">75%</option>
        <option value="0.9">90%</option>
        <option value="1" selected>100%</option>
        <option value="1.25">125%</option>
        <option value="1.5">150%</option>
        <option value="2">200%</option>
      </select>
    </div>`;

  const g = {
    blockId: block.id,
    block,
    sheet,
    els: {
      body,
      grid: body.querySelector(".wb-grid"),
      scroll: body.querySelector(".wb-gr-scroll"),
      canvas: body.querySelector(".wb-gr-canvas"),
      cells: body.querySelector(".wb-gr-cells"),
      sel: body.querySelector(".wb-gr-sel"),
      refhl: body.querySelector(".wb-gr-refhl"),
      colsInner: body.querySelector(".wb-gr-cols-inner"),
      rowsInner: body.querySelector(".wb-gr-rows-inner"),
      frozenTop: body.querySelector(".wb-gr-frozen-top"),
      frozenTopInner: body.querySelector(".wb-gr-frozen-top-inner"),
      frozenLeft: body.querySelector(".wb-gr-frozen-left"),
      frozenLeftInner: body.querySelector(".wb-gr-frozen-left-inner"),
      fbarRef: body.querySelector("[data-wb-fbar-ref]"),
      fbarInput: body.querySelector("[data-wb-fbar-input]"),
      fbarErr: body.querySelector("[data-wb-fbar-err]"),
      filterChip: body.querySelector(".wb-gr-filterchip"),
      charts: body.querySelector("[data-wb-charts]"),
      pivots: body.querySelector("[data-wb-pivots]"),
      tabs: body.querySelector("[data-wb-tabs]"),
    },
    active: { r: 0, c: 0 },
    sel: { r0: 0, c0: 0, r1: 0, c1: 0 },
    editing: null,          // { r, c, input, viaBar }
    dragging: false,
    resize: null,
    zoom: 1,
    filterMode: false,      // Excel AutoFilter toggle: ▾ buttons on the header row
    filters: new Map(),     // col -> { values: Set<string>|null, text: string|null }
    rows: [],               // visible actual row indexes (filter-aware)
    colX: [], rowY: [],     // prefix sums (rowY over g.rows)
    undo: [], redo: [],
    raf: 0,
    clipboardTimer: null,
    primary: (WB.blocks.find((b) => b.type === "sheet") || {}).id === block.id,
    fxWord: null,
  };
  GRIDS.set(block.id, g);
  bindGridEvents(g);
  restoreViewState(g);
  computeGeometry(g);
  renderSheetTabs(g);
  repaintGrid(g);
  syncFormulaBar(g);
  renderCharts(g);
  renderPivots(g);
  renderFillBar(g); // Schedule Intelligence Bar (from the last saved run)
  g.els.charts.addEventListener("click", (e) => {
    const card = e.target.closest("[data-wb-chart]");
    const act = e.target.closest("[data-wb-chartact]");
    if (!card || !act) return;
    const ch = sheetCharts(g.sheet).find((x) => x.id === card.getAttribute("data-wb-chart"));
    if (!ch) return;
    if (act.getAttribute("data-wb-chartact") === "edit") openChartDialog(g, ch);
    else confirmModal({ title: "Delete this chart?", body: "The underlying cells are untouched.", confirmLabel: "Delete chart", danger: true, onConfirm: () => deleteChart(g, ch.id) });
  });
  g.els.pivots.addEventListener("click", (e) => {
    const card = e.target.closest("[data-wb-pivot]");
    const act = e.target.closest("[data-wb-pivotact]");
    if (!card || !act) return;
    const pv = sheetPivots(g.sheet).find((x) => x.id === card.getAttribute("data-wb-pivot"));
    if (!pv) return;
    if (act.getAttribute("data-wb-pivotact") === "edit") openPivotDialog(g, pv);
    else confirmModal({ title: "Delete this pivot table?", body: "The underlying cells are untouched.", confirmLabel: "Delete pivot", danger: true, onConfirm: () => deletePivot(g, pv.id) });
  });
}

function sheetToolbarHtml(block, ro) {
  const btn = (act, title, svg, extra) => `<button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="${act}" ${extra || ""} title="${esc(title)}" aria-label="${esc(title)}" ${ro && act !== "export-csv" && act !== "find" && act !== "comment-cell" ? "disabled" : ""}>${svg}</button>`;
  // dropdown trigger: icon + a small caret (keeps the strip one row)
  const mbtn = (act, title, svg) => `<button type="button" class="btn btn-ghost btn-sm wb-tb wb-tb-menu" data-wb-tb="${act}" title="${esc(title)}" aria-label="${esc(title)}" aria-haspopup="menu" ${ro ? "disabled" : ""}>${svg}<span class="wb-tb-caret">▾</span></button>`;
  const I = {
    undo: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`,
    redo: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>`,
    bold: `<span class="wb-tb-txt"><strong>B</strong></span>`,
    italic: `<span class="wb-tb-txt"><em>I</em></span>`,
    underline: `<span class="wb-tb-txt"><u>U</u></span>`,
    alignL: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/></svg>`,
    alignC: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg>`,
    alignR: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="20" y2="18"/></svg>`,
    fill: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 11l-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0L19 11z"/><path d="M5 2l5 5"/><path d="M21 16s-1.5 2-1.5 3.5a1.5 1.5 0 0 0 3 0C22.5 18 21 16 21 16z"/></svg>`,
    textc: `<span class="wb-tb-txt wb-tb-textc">A</span>`,
    borders: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="4" y1="12" x2="20" y2="12"/></svg>`,
    clearFmt: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v9"/><line x1="4" y1="17" x2="20" y2="21"/></svg>`,
    addRow: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="6" rx="1"/><line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`,
    delRow: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="6" rx="1"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`,
    addCol: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="3" width="6" height="18" rx="1"/><line x1="14" y1="12" x2="20" y2="12"/><line x1="17" y1="9" x2="17" y2="15"/></svg>`,
    delCol: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="3" width="6" height="18" rx="1"/><line x1="14" y1="12" x2="20" y2="12"/></svg>`,
    freeze: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9" stroke-width="2.6"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
    sortAsc: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="M3 17l3 3 3-3"/><path d="M6 18V4"/></svg>`,
    sortDesc: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h4"/><path d="M11 9h7"/><path d="M11 13h10"/><path d="M3 7l3-3 3 3"/><path d="M6 6v14"/></svg>`,
    filter: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/></svg>`,
    more: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`,
    find: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg>`,
    dv: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 12l2.5 2.5 5-5"/></svg>`,
    cf: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/></svg>`,
  };
  return `<div class="wb-toolbar" role="toolbar" aria-label="Spreadsheet tools" data-wb-toolbar="${block.id}">
    <div class="wb-tgrp">${btn("undo", "Undo (Ctrl+Z)", I.undo)}${btn("redo", "Redo (Ctrl+Y)", I.redo)}${btn("paint-format", "Format painter — copy the active cell's formatting to the next selection", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="14" height="5" rx="1"/><path d="M18 5h2v5H9v3"/><rect x="7" y="13" width="4" height="8" rx="1"/></svg>`)}</div>
    <div class="wb-tgrp">
      <button type="button" class="btn btn-ghost btn-sm wb-tb wb-tb-fill" data-wb-tb="fill-people" title="Choose driver fields and load the roster into this sheet" ${ro ? "disabled" : ""}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>People</button>
    </div>
    <div class="wb-tgrp">${btn("autosum", "AutoSum — insert =SUM(…) for the selection", `<span class="wb-tb-txt wb-tb-sigma">Σ</span>`)}
      <span class="popover-anchor">
        <button type="button" class="btn btn-ghost btn-sm wb-tb wb-tb-fnbtn" data-wb-tb="fn-menu" title="Functions — browse and insert (${FUNCTION_META.length})" aria-label="Insert function" aria-haspopup="menu" ${ro ? "disabled" : ""}><span class="wb-tb-txt wb-tb-fx"><em>f</em>x</span><span class="wb-tb-caret">▾</span></button>
        <div class="popover wb-tb-pop wb-fn-pop" role="menu"></div>
      </span>
    </div>
    <div class="wb-tgrp">
      ${btn("fmt-currency", "Format as currency", `<span class="wb-tb-txt">$</span>`)}${btn("fmt-percent", "Format as percent", `<span class="wb-tb-txt">%</span>`)}
      <button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="dec-minus" title="Decrease decimal places" aria-label="Decrease decimal places" ${ro ? "disabled" : ""}><span class="wb-tb-txt wb-tb-dec">.0</span></button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="dec-plus" title="Increase decimal places" aria-label="Increase decimal places" ${ro ? "disabled" : ""}><span class="wb-tb-txt wb-tb-dec">.00</span></button>
      <span class="popover-anchor">
        <button type="button" class="btn btn-ghost btn-sm wb-tb wb-tb-numfmt" data-wb-tb="numfmt-menu" title="Number format" aria-haspopup="menu" ${ro ? "disabled" : ""}>123 ▾</button>
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-numfmt="" role="menuitem">Automatic</button>
          <button type="button" class="popover-item" data-wb-numfmt="text" role="menuitem">Plain text</button>
          <button type="button" class="popover-item" data-wb-numfmt="number" role="menuitem">Number · 1,250.00</button>
          <button type="button" class="popover-item" data-wb-numfmt="currency" role="menuitem">Currency · $1,250.00</button>
          <button type="button" class="popover-item" data-wb-numfmt="percent" role="menuitem">Percent · 12%</button>
          <button type="button" class="popover-item" data-wb-numfmt="date" role="menuitem">Date · Jul 4, 2026</button>
        </div>
      </span>
    </div>
    <div class="wb-tgrp">
      <select class="wb-tb-ffsel" data-wb-ffsel aria-label="Font" title="Font" ${ro ? "disabled" : ""}>
        <option value="">Default</option>
        ${Object.entries(WB_FONT_LABELS).map(([k, label]) => `<option value="${k}" style="font-family:${WB_FONT_FAMILIES[k]}">${label}</option>`).join("")}
      </select>
      ${btn("fs-minus", "Decrease font size", `<span class="wb-tb-txt">−</span>`)}
      <input type="number" class="wb-tb-fs" data-wb-fsinput min="8" max="36" step="1" placeholder="13" aria-label="Font size (px)" title="Font size (px)" ${ro ? "disabled" : ""}>
      ${btn("fs-plus", "Increase font size", `<span class="wb-tb-txt">+</span>`)}
    </div>
    <div class="wb-tgrp">${btn("bold", "Bold (Ctrl+B)", I.bold)}${btn("italic", "Italic (Ctrl+I)", I.italic)}${btn("underline", "Underline (Ctrl+U)", I.underline)}${btn("strike", "Strikethrough", `<span class="wb-tb-txt"><s>S</s></span>`)}</div>
    <div class="wb-tgrp">
      <span class="popover-anchor">${mbtn("align-menu", "Alignment & wrapping", I.alignL)}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-tb="align-left" role="menuitem">Align left</button>
          <button type="button" class="popover-item" data-wb-tb="align-center" role="menuitem">Align center</button>
          <button type="button" class="popover-item" data-wb-tb="align-right" role="menuitem">Align right</button>
          <div class="popover-section"></div>
          <button type="button" class="popover-item" data-wb-tb="valign-top" role="menuitem">Align top</button>
          <button type="button" class="popover-item" data-wb-tb="valign-middle" role="menuitem">Align middle</button>
          <button type="button" class="popover-item" data-wb-tb="valign-bottom" role="menuitem">Align bottom</button>
          <div class="popover-section"></div>
          <button type="button" class="popover-item" data-wb-tb="wrap" role="menuitem">Wrap text (toggle)</button>
        </div></span>
      <span class="popover-anchor">${btn("fill-menu", "Fill color", I.fill, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop wb-color-pop" role="menu" data-wb-colorkind="bg"></div></span>
      <span class="popover-anchor">${btn("textc-menu", "Text color", I.textc, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop wb-color-pop" role="menu" data-wb-colorkind="fg"></div></span>
      <span class="popover-anchor">${btn("border-menu", "Borders", I.borders, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-border="all" role="menuitem">All borders</button>
          <button type="button" class="popover-item" data-wb-border="outline" role="menuitem">Outline</button>
          <button type="button" class="popover-item" data-wb-border="top" role="menuitem">Top border</button>
          <button type="button" class="popover-item" data-wb-border="bottom" role="menuitem">Bottom border</button>
          <button type="button" class="popover-item" data-wb-border="left" role="menuitem">Left border</button>
          <button type="button" class="popover-item" data-wb-border="right" role="menuitem">Right border</button>
          <button type="button" class="popover-item" data-wb-border="none" role="menuitem">No borders</button>
          <div class="popover-section"></div>
          <button type="button" class="popover-item" data-wb-bw="1" role="menuitem"><span class="wb-bw-sample" style="border-top-width:1px"></span>Thin line</button>
          <button type="button" class="popover-item" data-wb-bw="2" role="menuitem"><span class="wb-bw-sample" style="border-top-width:2px"></span>Medium line</button>
          <button type="button" class="popover-item" data-wb-bw="3" role="menuitem"><span class="wb-bw-sample" style="border-top-width:3px"></span>Thick line</button>
        </div></span>
    </div>
    <div class="wb-tgrp">${btn("merge", "Merge / unmerge cells", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 12h6"/><path d="M7 9l-2 3 2 3"/><path d="M17 9l2 3-2 3"/></svg>`)}${btn("insert-link", "Insert link (Ctrl+click opens)", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`)}${btn("comment-cell", "Comment on the active cell", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`)}${btn("insert-chart", "Insert chart from the selection", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="10" width="3" height="7"/><rect x="11" y="6" width="3" height="11"/><rect x="16" y="13" width="3" height="4"/></svg>`)}</div>
    <div class="wb-tgrp">
      <span class="popover-anchor">${mbtn("rowcol-menu", "Rows & columns", I.addRow)}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-tb="row-add" role="menuitem">Insert row below</button>
          <button type="button" class="popover-item" data-wb-tb="col-add" role="menuitem">Insert column right</button>
          <div class="popover-section"></div>
          <button type="button" class="popover-item" data-wb-tb="row-del" role="menuitem">Delete row</button>
          <button type="button" class="popover-item" data-wb-tb="col-del" role="menuitem">Delete column</button>
        </div></span>
      <span class="popover-anchor">${btn("freeze-menu", "Freeze", I.freeze, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-freeze="row" role="menuitem">Freeze top row</button>
          <button type="button" class="popover-item" data-wb-freeze="col" role="menuitem">Freeze first column</button>
          <button type="button" class="popover-item" data-wb-freeze="none" role="menuitem">Unfreeze</button>
        </div></span>
      <span class="popover-anchor">${mbtn("sort-menu", "Sort", I.sortAsc)}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-tb="sort-asc" role="menuitem">Sort by active column, A→Z</button>
          <button type="button" class="popover-item" data-wb-tb="sort-desc" role="menuitem">Sort by active column, Z→A</button>
          <div class="popover-section"></div>
          <button type="button" class="popover-item" data-wb-tb="sort-custom" role="menuitem">Custom sort…</button>
        </div></span>
      ${btn("filter", "Create / remove filter", I.filter)}${btn("find", "Find and replace (Ctrl+F)", I.find)}
    </div>
    <div class="wb-tgrp">
      <button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb ${WB.panelOpen ? "is-on" : ""}" data-wb-tb="panel-toggle" title="Comments &amp; activity" aria-label="Toggle comments and activity panel" aria-pressed="${WB.panelOpen}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
      <span class="popover-anchor">
        <button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="io-menu" title="More tools" aria-haspopup="menu" aria-label="More tools">${I.more}</button>
        <div class="popover wb-tb-pop wb-tb-pop-end" role="menu">
          <button type="button" class="popover-item" data-wb-tb="validation" role="menuitem" ${ro ? "disabled" : ""}>Data validation…</button>
          <button type="button" class="popover-item" data-wb-tb="condfmt" role="menuitem" ${ro ? "disabled" : ""}>Conditional formatting…</button>
          <button type="button" class="popover-item" data-wb-tb="named-ranges" role="menuitem">Named ranges…</button>
          <button type="button" class="popover-item" data-wb-tb="pivot" role="menuitem" ${ro ? "disabled" : ""}>Pivot table…</button>
          <button type="button" class="popover-item" data-wb-tb="clear-format" role="menuitem" ${ro ? "disabled" : ""}>Clear formatting</button>
          <div class="popover-section"></div>
          <button type="button" class="popover-item" data-wb-tb2="import-csv" role="menuitem" ${ro ? "disabled" : ""}>Import CSV into this sheet…</button>
          <button type="button" class="popover-item" data-wb-tb2="export-xlsx" role="menuitem">Export as Excel (.xlsx)</button>
          <button type="button" class="popover-item" data-wb-tb2="export-csv" role="menuitem">Export sheet as CSV</button>
          <button type="button" class="popover-item" data-wb-tb2="print" role="menuitem">Print sheet…</button>
        </div>
      </span>
    </div>
  </div>`;
}

// ─── Geometry ────────────────────────────────────────────────────────────────

// The text a filter compares against — what the cell shows, not how it's
// formatted (formula cells contribute their computed value).
function filterCellText(sheet, r, col) {
  const cell = sheet.cells.get(cellKey(r, col));
  return cell ? String(cell.formula ? (cell.err || (cell.computed ?? "")) : (cell.value ?? "")) : "";
}

function computeGeometry(g) {
  const sheet = g.sheet;
  // visible rows (filter-aware; header row 0 always visible). Every
  // filtered column must accept the row — Excel AutoFilter semantics.
  const rows = [];
  const rowHidden = (r) => sheet.hiddenRows && sheet.hiddenRows.has(r);
  const filters = g.filters && g.filters.size
    ? [...g.filters.entries()].map(([col, f]) => ({ col, needle: f.text ? f.text.toLowerCase() : null, values: f.values || null }))
    : null;
  for (let r = 0; r < sheet.rowCount; r++) {
    if (rowHidden(r)) continue;
    if (r === 0 || !filters) { rows.push(r); continue; }
    let show = true;
    for (const f of filters) {
      const t = filterCellText(sheet, r, f.col);
      if (f.needle && !t.toLowerCase().includes(f.needle)) { show = false; break; }
      if (f.values && !f.values.has(t)) { show = false; break; }
    }
    if (show) rows.push(r);
  }
  g.rows = rows;
  const z = g.zoom || 1; // zoom scales the geometry itself, so hit-testing stays exact
  g.rowY = new Array(rows.length + 1);
  g.rowY[0] = 0;
  for (let i = 0; i < rows.length; i++) g.rowY[i + 1] = g.rowY[i] + Math.round(rowH(sheet, rows[i]) * z);
  g.colX = new Array(sheet.colCount + 1);
  g.colX[0] = 0;
  for (let c = 0; c < sheet.colCount; c++) g.colX[c + 1] = g.colX[c] + Math.round(colW(sheet, c) * z);
  g.els.canvas.style.width = g.colX[sheet.colCount] + "px";
  // trailing space hosts the "Add N more rows" bar (Sheets-style)
  const addRow = g.els.body.querySelector("[data-wb-addrowsrow]");
  const addH = addRow ? 48 : 0;
  if (addRow) addRow.style.top = g.rowY[rows.length] + 6 + "px";
  g.els.canvas.style.height = (g.rowY[rows.length] + addH) + "px";
  sizeGrid(g);
}

// The primary sheet fills the viewport — the workbook opens as a
// spreadsheet canvas, not a card in a document. Secondary sheet blocks
// (below the fold) keep a bounded height.
function sizeGrid(g) {
  const grid = g.els.grid;
  const contentH = (g.rowY[g.rows.length] || 0) + HDR_ROW_H + 14;
  let target;
  if (g.primary) {
    const top = grid.getBoundingClientRect().top;
    const avail = (top > 40 ? window.innerHeight - top : window.innerHeight - 300) - 88;
    target = Math.max(420, Math.min(avail, contentH));
  } else {
    target = Math.max(220, Math.min(GRID_MAX_H + HDR_ROW_H, contentH));
  }
  const cur = parseFloat(grid.style.height) || 0;
  if (Math.abs(cur - target) > 3) grid.style.height = Math.round(target) + "px";
}

function setZoom(g, z) {
  g.zoom = Math.min(2, Math.max(0.5, z || 1));
  g.els.grid.style.setProperty("--wb-zoom", String(g.zoom));
  const sel = g.els.body.querySelector("[data-wb-zoom]");
  if (sel) sel.value = String(g.zoom);
  try { localStorage.setItem("rr-wb-zoom-" + g.sheet.id, String(g.zoom)); } catch (_) {}
  cancelEdit(g);
  computeGeometry(g);
  repaintGrid(g);
}

function idxFromPrefix(prefix, pos) {
  let lo = 0, hi = prefix.length - 2;
  if (pos <= 0) return 0;
  if (pos >= prefix[prefix.length - 1]) return prefix.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// display index (into g.rows) from a y coordinate; actual row = g.rows[di]
function dispRowAt(g, y) { return Math.max(0, Math.min(g.rows.length - 1, idxFromPrefix(g.rowY, y))); }
function colAt(g, x) { return Math.max(0, Math.min(g.sheet.colCount - 1, idxFromPrefix(g.colX, x))); }
function dispIndexOfRow(g, r) { return g.rows.indexOf(r); }

// ─── Painting ────────────────────────────────────────────────────────────────

// Web-safe families only — nothing to load, and every one round-trips
// through the XLSX exporter with a matching installed-font name.
const WB_FONT_FAMILIES = {
  arial: "Arial, Helvetica, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  verdana: "Verdana, Geneva, sans-serif",
  trebuchet: "'Trebuchet MS', sans-serif",
};
const WB_FONT_LABELS = { arial: "Arial", georgia: "Georgia", times: "Times New Roman", courier: "Courier New", verdana: "Verdana", trebuchet: "Trebuchet MS" };

// Cells are flex containers (vertical centering + valign support), so
// horizontal alignment needs both text-align (wrapped lines) and
// justify-content (the flex item itself).
function alignCss(a) {
  const jc = a === "left" ? "flex-start" : a === "center" ? "center" : "flex-end";
  return `text-align:${a};justify-content:${jc};`;
}

function cellStyle(sheet, r, c, cell) {
  const f = (cell && cell.format) || {};
  let s = "";
  if (f.bold) s += "font-weight:600;";
  if (f.italic) s += "font-style:italic;";
  const deco = [];
  if (f.underline || f.link) deco.push("underline");
  if (f.strike) deco.push("line-through");
  if (deco.length) s += `text-decoration:${deco.join(" ")};`;
  if (Number.isInteger(f.fs)) s += `font-size:calc(${Math.min(36, Math.max(8, f.fs))}px * var(--wb-zoom, 1));`;
  if (f.ff && WB_FONT_FAMILIES[f.ff]) s += `font-family:${WB_FONT_FAMILIES[f.ff]};`;
  if (f.align) s += alignCss(f.align);
  else if (cell && !cell.formula && (cell.type === "number" || cell.type === "currency" || cell.type === "percent")) s += alignCss("right");
  else if (cell && cell.formula && typeof cell.computed === "number") s += alignCss("right");
  if (f.valign) s += `align-items:${f.valign === "top" ? "flex-start" : f.valign === "bottom" ? "flex-end" : "center"};`;
  if (f.bg && f.bg !== "header") s += `background:${wbColorCss("bg", f.bg)};`;
  if (f.bg === "header") s += "background:var(--canvas);font-weight:600;";
  if (f.fg) s += `color:${wbColorCss("fg", f.fg)};`;
  else if (f.link) s += "color:var(--accent, #2563EB);";
  if (f.wrap) s += "white-space:normal;line-height:1.3;";
  // applied borders read solid black, like Excel's default border ink;
  // format.bw picks the line weight (1 thin · 2 medium · 3 thick)
  const bw = f.bw === 2 || f.bw === 3 ? f.bw : 1;
  const bAll = bw === 1 ? 1 : bw === 2 ? 2 : 3;
  const bEdge = bw === 1 ? 1.5 : bw === 2 ? 2.5 : 4;
  if (f.border === "all" || f.border === "outline") s += `box-shadow:inset 0 0 0 ${bAll}px #000;`;
  else if (f.border === "bottom") s += `box-shadow:inset 0 -${bEdge}px 0 #000;`;
  else if (f.border === "top") s += `box-shadow:inset 0 ${bEdge}px 0 #000;`;
  else if (f.border === "left") s += `box-shadow:inset ${bEdge}px 0 0 #000;`;
  else if (f.border === "right") s += `box-shadow:inset -${bEdge}px 0 0 #000;`;
  return s;
}

// Cell content wrapper: a cell that resolves to a link (explicit or an
// auto-detected email/URL) renders its text as a real <a> so it looks and
// behaves like a hyperlink — blue, underlined, click to open. Rotated text
// renders inside a span so the background/borders stay square.
function cellInnerHtml(cell, disp) {
  const f = cell && cell.format;
  const link = cellLink(cell);
  // only http(s)/mailto reach an href — never javascript:/data: schemes
  const safe = link && /^(https?:|mailto:)/i.test(link) ? link : null;
  const body = safe
    ? `<a class="wb-cell-link" href="${esc(safe)}" target="_blank" rel="noopener noreferrer" draggable="false">${esc(disp)}</a>`
    : esc(disp);
  if (f && (f.rot === 45 || f.rot === 90)) return `<span class="wb-rot" style="transform:rotate(-${f.rot}deg)">${body}</span>`;
  return body;
}

// Auto-linkify plain-text cells that hold a bare email or URL (Sheets does
// the same), so a cell of "sam@acme.com" is clickable without an explicit
// Insert-link. An explicit format.link always wins.
const WB_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WB_URL_RE = /^(https?:\/\/|www\.)[^\s]+$/i;
function autoLinkFor(cell) {
  if (!cell || cell.formula) return null;
  const v = String(cell.value ?? "").trim();
  if (!v) return null;
  if (WB_EMAIL_RE.test(v)) return "mailto:" + v;
  if (WB_URL_RE.test(v)) return /^www\./i.test(v) ? "https://" + v : v;
  return null;
}
// The link a cell resolves to (explicit link, else an auto-detected one).
function cellLink(cell) {
  if (cell && cell.format && cell.format.link) return cell.format.link;
  return autoLinkFor(cell);
}

const WB_COLORS = {
  bg: { none: "", gray: "#F3F4F6", blue: "rgba(37,99,235,.09)", green: "rgba(22,163,74,.10)", amber: "rgba(217,119,6,.12)", red: "rgba(220,38,38,.09)", violet: "rgba(124,58,237,.10)" },
  fg: { default: "", muted: "#6B7280", blue: "#1E40AF", green: "#166534", amber: "#92400E", red: "#B91C1C" },
};

// Preset keys resolve through the palette; a #RRGGBB value (from the
// custom picker) passes through directly. Anything else is inert.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function wbColorCss(kind, key) {
  if (HEX_COLOR_RE.test(String(key))) return key;
  return esc(WB_COLORS[kind][key] || (kind === "bg" ? "transparent" : "inherit"));
}

// Cell images live on format.img as a base64 data URL. The strict shape
// check is the injection guard — a validated string needs no escaping —
// and results are memoized per format object so scroll repaints don't
// re-scan hundreds of KB.
const WB_IMG_RE = /^data:image\/(png|jpe?g|webp|gif|bmp|avif);base64,[A-Za-z0-9+/=]+$/;
const WB_IMG_OK = new WeakMap();
function cellImgSrc(cell) {
  const f = cell && cell.format;
  const src = f && f.img;
  if (typeof src !== "string" || !src) return null;
  let ok = WB_IMG_OK.get(f);
  if (ok === undefined) { ok = WB_IMG_RE.test(src); WB_IMG_OK.set(f, ok); }
  return ok ? src : null;
}

function repaintGrid(g) {
  if (g.raf) return;
  g.raf = requestAnimationFrame(() => { g.raf = 0; paintNow(g); });
}

function paintNow(g) {
  const sheet = g.sheet;
  cfClearMemo(); // color-scale stats + custom-formula ctx are per-repaint
  sizeGrid(g);
  const scroll = g.els.scroll;
  const sx = scroll.scrollLeft, sy = scroll.scrollTop;
  const vw = scroll.clientWidth, vh = scroll.clientHeight;
  const d0 = dispRowAt(g, sy), d1 = Math.min(g.rows.length - 1, dispRowAt(g, sy + vh) + 1);
  const c0 = colAt(g, sx), c1 = Math.min(sheet.colCount - 1, colAt(g, sx + vw) + 1);

  // column headers
  let colsHtml = "";
  for (let c = c0; c <= c1; c++) {
    const w = g.colX[c + 1] - g.colX[c];
    if (w === 0) continue; // hidden column
    const isSel = c >= Math.min(g.sel.c0, g.sel.c1) && c <= Math.max(g.sel.c0, g.sel.c1);
    colsHtml += `<div class="wb-hcell wb-hcol ${isSel ? "is-sel" : ""}" data-wb-col="${c}" style="left:${g.colX[c]}px;width:${w}px;height:${HDR_ROW_H}px">${colLabel(c)}<span class="wb-rz-col" data-wb-rzcol="${c}"></span></div>`;
  }
  g.els.colsInner.innerHTML = colsHtml;
  g.els.colsInner.style.transform = `translateX(${-sx}px)`;

  // row headers
  let rowsHtml = "";
  for (let di = d0; di <= d1; di++) {
    const r = g.rows[di];
    const h = g.rowY[di + 1] - g.rowY[di];
    const isSel = r >= Math.min(g.sel.r0, g.sel.r1) && r <= Math.max(g.sel.r0, g.sel.r1);
    rowsHtml += `<div class="wb-hcell wb-hrow ${isSel ? "is-sel" : ""}" data-wb-row="${r}" style="top:${g.rowY[di]}px;height:${h}px;width:${HDR_COL_W}px">${r + 1}<span class="wb-rz-row" data-wb-rzrow="${r}"></span></div>`;
  }
  g.els.rowsInner.innerHTML = rowsHtml;
  g.els.rowsInner.style.transform = `translateY(${-sy}px)`;

  // cells
  const commented = commentedCellSet(sheet.id);
  const mergesArr = sheetMerges(sheet);
  // AutoFilter mode: header-row cells across the used range get ▾ buttons
  g.fltMaxC = g.filterMode ? usedRange(sheet).maxC : -1;
  const fltBtn = (r, c) => (r === 0 && c <= g.fltMaxC
    ? `<button type="button" class="wb-flt-btn ${g.filters.has(c) ? "is-filtered" : ""}" data-wb-fltbtn="${c}" title="Filter column ${colLabel(c)}" aria-label="Filter column ${colLabel(c)}">${g.filters.has(c) ? "▼" : "▾"}</button>`
    : "");
  const hasDvRules = Array.isArray(sheet.meta && sheet.meta.validation) && sheet.meta.validation.length > 0;
  const cellDiv = (r, c, x, top, w, h) => {
    const key = cellKey(r, c);
    const cell = sheet.cells.get(key);
    // View → Show → Formulas: formula cells show their source (Ctrl+`)
    const disp = cell ? (g.showFormulas && cell.formula ? cell.formula : displayValue(sheet, r, c)) : "";
    const err = cell && cell.err;
    const inval = cellInvalid(sheet, r, c, cell);
    const linkUrl = cell ? cellLink(cell) : null; // explicit or auto-detected email/URL
    // list-validated cells fill with their option's color and carry a
    // ▾ mark pinned to the far right (Sheets' whole-cell dropdown look)
    const dvRule = hasDvRules && r > 0 ? findValidationRule(sheet, r, c) : null;
    const isDv = !!(dvRule && (dvRule.type === "list" || dvRule.type === "range") && WB.canEdit);
    const dvCheck = !!(dvRule && dvRule.type === "checkbox" && WB.canEdit);
    const dvChecked = dvCheck && cell && /^true$/i.test(String(cell.formula ? cell.computed : cell.value));
    // display style (rule.style): "arrow" fills the cell + right ▾ mark,
    // "chip" wraps the value in a colored pill, "plain" is fill only
    const dvStyle = isDv ? (dvRule.style === "chip" || dvRule.style === "plain" ? dvRule.style : "arrow") : null;
    const dvColor = isDv ? dvOptionColor(dvRule, cell ? (cell.formula ? cell.computed : cell.value) : null) : null;
    const dvFill = isDv && dvStyle !== "chip" ? dvColor : null;
    const dvMark = isDv && dvStyle === "arrow" ? `<span class="wb-dv-mark" data-wb-dvchip="${r},${c}" title="Pick from list" aria-label="Pick from list">▾</span>` : "";
    // a cell image takes over the cell's face; click opens the lightbox
    const imgSrc = cell ? cellImgSrc(cell) : null;
    const inner = imgSrc
      ? `<img class="wb-cell-img" src="${imgSrc}" data-wb-img="${r},${c}" alt="Cell image" title="Click to enlarge" draggable="false">`
      : dvCheck
      ? `<span class="wb-dv-checkbox ${dvChecked ? "is-checked" : ""}" data-wb-dvcheck="${r},${c}" role="checkbox" aria-checked="${dvChecked}" title="Toggle">${dvChecked ? "☑" : "☐"}</span>`
      : isDv && dvStyle === "chip"
        ? `<span class="wb-dv-pill ${cell && disp ? "" : "is-empty"}" data-wb-dvchip="${r},${c}" style="${dvColor ? `background:${dvColor};` : ""}">${cell && disp ? esc(disp) : "Select"}<span class="wb-dv-pillarrow">▾</span></span>`
        : cell && disp ? cellInnerHtml(cell, disp) : isDv && dvStyle === "arrow" ? `<span class="wb-dv-chip-empty">Select</span>` : "";
    return `<div class="wb-cell ${err ? "is-err" : ""} ${cell && cell.formula ? "is-formula" : ""} ${inval ? "is-invalid" : ""} ${isDv ? "is-dv" : ""} ${isDv && dvStyle === "arrow" ? "is-dvarrow" : ""} ${imgSrc ? "is-img" : ""} ${linkUrl ? "is-link" : ""}" data-r="${r}" data-c="${c}" style="left:${x}px;top:${top}px;width:${w}px;height:${h}px;${cell ? cellStyle(sheet, r, c, cell) : ""}${dvFill ? `background:${dvFill};` : ""}${condStyleFor(sheet, r, c, cell)}" ${inval ? `title="${esc(validationMsg(findValidationRule(sheet, r, c)))}"` : linkUrl ? `title="${esc(linkUrl)}"` : ""}>${commented.has(key) ? `<span class="wb-cmark" title="Has comments"></span>` : ""}${inner}${dvMark}${fltBtn(r, c)}</div>`;
  };
  let html = "";
  const paintedMerges = new Set();
  for (let di = d0; di <= d1; di++) {
    const r = g.rows[di];
    const top = g.rowY[di], h = g.rowY[di + 1] - top;
    for (let c = c0; c <= c1; c++) {
      const w = g.colX[c + 1] - g.colX[c];
      if (w === 0) continue; // hidden column
      const mg = mergesArr.length ? mergeAt(sheet, r, c) : null;
      if (mg) {
        // any visible piece of a merge paints the whole merge once,
        // anchored at the anchor cell's absolute coordinates
        if (paintedMerges.has(mg)) continue;
        const px = mergePixelRect(g, mg);
        paintedMerges.add(mg);
        if (px) html += cellDiv(mg.r0, mg.c0, px.x, px.y, px.w, px.h);
        continue;
      }
      html += cellDiv(r, c, g.colX[c], top, w, h);
    }
  }
  g.els.cells.innerHTML = html;

  paintSelection(g);
  paintFrozen(g, sx, sy, c0, c1);
  paintFilterChip(g);
}

function paintSelection(g) {
  const { r0, c0, r1, c1 } = g.sel;
  const a = g.active;
  const di0 = dispIndexOfRow(g, Math.min(r0, r1)), di1 = dispIndexOfRow(g, Math.max(r0, r1));
  const adi = dispIndexOfRow(g, a.r);
  let html = "";
  if (di0 >= 0 && di1 >= 0) {
    const x = g.colX[Math.min(c0, c1)], x2 = g.colX[Math.max(c0, c1) + 1];
    const y = g.rowY[di0], y2 = g.rowY[di1 + 1];
    if (Math.min(r0, r1) !== Math.max(r0, r1) || Math.min(c0, c1) !== Math.max(c0, c1)) {
      html += `<div class="wb-sel-range" style="left:${x}px;top:${y}px;width:${x2 - x}px;height:${y2 - y}px"></div>`;
    }
  }
  if (adi >= 0) {
    const am = mergeAt(g.sheet, a.r, a.c);
    const px = am ? mergePixelRect(g, am) : null;
    const ax = px ? px.x : g.colX[a.c], aw = px ? px.w : g.colX[a.c + 1] - g.colX[a.c];
    const ay = px ? px.y : g.rowY[adi], ah = px ? px.h : g.rowY[adi + 1] - g.rowY[adi];
    html += `<div class="wb-sel-active" style="left:${ax}px;top:${ay}px;width:${aw}px;height:${ah}px"></div>`;
  }
  // drag-fill handle at the selection's bottom-right corner
  if (WB.canEdit && !g.editing && di1 >= 0) {
    const hx = g.colX[Math.max(c0, c1) + 1], hy = g.rowY[di1 + 1];
    html += `<div class="wb-fill-handle" data-wb-fillhandle title="Drag to fill" style="left:${hx - 4}px;top:${hy - 4}px"></div>`;
  }
  g.els.sel.innerHTML = html;
  updateSelStats(g);
}

// Excel-style status stats for the current selection (Sum / Avg / Count).
function updateSelStats(g) {
  const el = g.els.selstats;
  if (!el) return;
  if (g.els.sbfilter) {
    g.els.sbfilter.textContent = g.filters && g.filters.size ? `${g.rows.length - 1} of ${g.sheet.rowCount} rows` : "";
  }
  const { r0, r1, c0, c1 } = selRect(g);
  if (r0 === r1 && c0 === c1) { el.textContent = `${colLabel(c0)}${r0 + 1}`; return; }
  let sum = 0, nnum = 0, cnt = 0;
  for (const [key, cell] of g.sheet.cells) {
    const { r, c } = keyRC(key);
    if (r < r0 || r > r1 || c < c0 || c > c1) continue;
    const raw = cell.formula ? (cell.err ? null : cell.computed) : cell.value;
    if (raw == null || raw === "") continue;
    cnt++;
    const num = cellNumeric(raw);
    if (num != null && cell.type !== "text") { sum += num; nnum++; }
  }
  const fmtN = (x) => {
    const r2 = Math.round(x * 100) / 100;
    return Math.abs(r2) >= 1000 ? r2.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(r2);
  };
  const ref = `${colLabel(c0)}${r0 + 1}:${colLabel(c1)}${r1 + 1}`;
  el.textContent = !cnt ? ref
    : nnum ? `${ref} · Sum ${fmtN(sum)} · Avg ${fmtN(sum / nnum)} · Count ${cnt}`
    : `${ref} · Count ${cnt}`;
}

function paintFrozen(g, sx, sy, c0, c1) {
  const sheet = g.sheet;
  // frozen top row
  if (sheet.frozenRows > 0 && g.rows.length) {
    const r = g.rows[0];
    const h = g.rowY[1] - g.rowY[0];
    let html = "";
    for (let c = c0; c <= c1; c++) {
      const cell = sheet.cells.get(cellKey(r, c));
      const w = g.colX[c + 1] - g.colX[c];
      const fzFlt = r === 0 && g.filterMode && c <= (g.fltMaxC ?? -1)
        ? `<button type="button" class="wb-flt-btn ${g.filters.has(c) ? "is-filtered" : ""}" data-wb-fltbtn="${c}" title="Filter column ${colLabel(c)}" aria-label="Filter column ${colLabel(c)}">${g.filters.has(c) ? "▼" : "▾"}</button>`
        : "";
      html += `<div class="wb-cell" data-r="${r}" data-c="${c}" style="left:${g.colX[c]}px;top:0;width:${w}px;height:${h}px;${cell ? cellStyle(sheet, r, c, cell) : ""}${condStyleFor(sheet, r, c, cell)}">${cell ? cellInnerHtml(cell, displayValue(sheet, r, c)) : ""}${fzFlt}</div>`;
    }
    g.els.frozenTop.hidden = false;
    g.els.frozenTop.style.height = h + "px";
    g.els.frozenTopInner.innerHTML = html;
    g.els.frozenTopInner.style.transform = `translateX(${-sx}px)`;
    g.els.frozenTop.classList.toggle("is-lifted", sy > 0);
  } else {
    g.els.frozenTop.hidden = true;
  }
  // frozen first column
  if (sheet.frozenCols > 0) {
    const w = g.colX[1] - g.colX[0];
    const d0 = dispRowAt(g, sy), d1 = Math.min(g.rows.length - 1, dispRowAt(g, sy + g.els.scroll.clientHeight) + 1);
    let html = "";
    for (let di = d0; di <= d1; di++) {
      const r = g.rows[di];
      const cell = sheet.cells.get(cellKey(r, 0));
      const h = g.rowY[di + 1] - g.rowY[di];
      html += `<div class="wb-cell" data-r="${r}" data-c="0" style="left:0;top:${g.rowY[di]}px;width:${w}px;height:${h}px;${cell ? cellStyle(sheet, r, 0, cell) : ""}${condStyleFor(sheet, r, 0, cell)}">${cell ? cellInnerHtml(cell, displayValue(sheet, r, 0)) : ""}</div>`;
    }
    g.els.frozenLeft.hidden = false;
    g.els.frozenLeft.style.left = HDR_COL_W + "px";
    g.els.frozenLeft.style.width = w + "px";
    g.els.frozenLeftInner.innerHTML = html;
    g.els.frozenLeftInner.style.transform = `translateY(${-sy}px)`;
    g.els.frozenLeft.classList.toggle("is-lifted", sx > 0);
  } else {
    g.els.frozenLeft.hidden = true;
  }
}

function paintFilterChip(g) {
  const chip = g.els.filterChip;
  if (g.filters && g.filters.size) {
    const parts = [...g.filters.entries()].map(([col, f]) => {
      const bits = [];
      if (f.values) bits.push(`${f.values.size} value${f.values.size === 1 ? "" : "s"}`);
      if (f.text) bits.push(`contains “${esc(f.text)}”`);
      return `${colLabel(col)} ${bits.join(", ")}`;
    });
    chip.hidden = false;
    chip.innerHTML = `Filter: ${parts.join(" · ")} · ${g.rows.length - 1} row${g.rows.length === 2 ? "" : "s"} <button type="button" class="wb-filter-clear" data-wb-act="filter-clear" data-block="${g.blockId}">Clear</button>`;
  } else {
    chip.hidden = true;
  }
}

// Hide/unhide rows or columns across a span; persisted in sheet.meta.
function setHidden(g, axis, from, to, hidden) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const set = axis === "row" ? sheet.hiddenRows : sheet.hiddenCols;
  for (let i = from; i <= to; i++) {
    if (hidden) set.add(i);
    else set.delete(i);
  }
  // never hide everything
  if (axis === "row" && set.size >= sheet.rowCount) set.delete(from);
  if (axis === "col" && set.size >= sheet.colCount) set.delete(from);
  saveSheetMeta(sheet.id);
  computeGeometry(g);
  repaintGrid(g);
}

// Paste Special: values only — computed results land, formulas don't.
// Values-only and format-only are the common cases of the unified
// paste-special path (pasteSpecial → pasteRich, defined further down).
async function pasteValuesOnly(g) { pasteSpecial(g, "values"); }
function pasteFormatOnly(g) { pasteSpecial(g, "formats"); }

// Formula auditing: light one — reuse the reference-highlight layer.
function tracePrecedents(g) {
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  if (!cell || !cell.formula) { _toast("The active cell has no formula", "info"); return; }
  paintRefsFromText(g, cell.formula);
}

function traceDependents(g) {
  const target = { r: g.active.r, c: g.active.c };
  const hits = [];
  const depBounds = { rowCount: g.sheet.rowCount, colCount: g.sheet.colCount };
  for (const [key, cell] of g.sheet.cells) {
    if (!cell.formula) continue;
    if (extractRefs(cell.formula, depBounds).some((rc) => rc.row === target.r && rc.col === target.c)) {
      const { r, c } = keyRC(key);
      hits.push(colLabel(c) + (r + 1));
      if (hits.length >= 10) break;
    }
  }
  if (!hits.length) { _toast("No formulas reference this cell", "info"); return; }
  paintRefsFromText(g, "=" + hits.join("+")); // reuse highlighter on the dependent refs
}

// Step the selection's decimal places (Sheets' .0 / .00 buttons).
function adjustDecimals(g, delta) {
  if (!WB.canEdit) return;
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  const cur = cell && cell.format && Number.isInteger(cell.format.dec) ? cell.format.dec : 2;
  formatSelection(g, { dec: Math.min(6, Math.max(0, cur + delta)) });
}

// Step the selection's font size (Sheets' − / + buttons; 13px base).
function adjustFontSize(g, delta) {
  if (!WB.canEdit) return;
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  const cur = cell && cell.format && Number.isInteger(cell.format.fs) ? cell.format.fs : 13;
  formatSelection(g, { fs: Math.min(36, Math.max(8, cur + delta)) });
  syncFontControls(g);
}

// Reflect the active cell's font in the toolbar controls.
function syncFontControls(g) {
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  const f = (cell && cell.format) || {};
  const fsEl = g.els.body.querySelector("[data-wb-fsinput]");
  if (fsEl && document.activeElement !== fsEl) fsEl.value = Number.isInteger(f.fs) ? f.fs : "";
  const ffEl = g.els.body.querySelector("[data-wb-ffsel]");
  if (ffEl && document.activeElement !== ffEl) ffEl.value = f.ff && WB_FONT_FAMILIES[f.ff] ? f.ff : "";
}

// Excel-style Format Cells dialog: number format, decimal places,
// alignment, style, wrap — applied to the whole selection.
function openFormatCellsDialog(g) {
  if (!WB.canEdit) return;
  document.getElementById("wb-format-modal")?.remove();
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  const f = (cell && cell.format) || {};
  const rawVal = cell ? (cell.formula ? cell.computed : cell.value) : "1234.567";
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-format-modal";
  const opt = (v, label) => `<option value="${v}" ${((f.num || "") === v) ? "selected" : ""}>${label}</option>`;
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Format cells" style="width:480px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Format cells</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Number format</span>
            <select class="wb-input" id="wb-fmt-num">
              ${opt("", "Automatic")}${opt("number", "Number · 1,250.00")}${opt("currency", "Currency · $1,250.00")}${opt("accounting", "Accounting · ($1,250.00)")}${opt("percent", "Percent · 12%")}${opt("scientific", "Scientific · 1.25E+3")}${opt("date", "Date · Jul 4, 2026")}${opt("text", "Plain text")}
            </select></label>
          <label class="wb-field" style="flex:0 0 132px"><span class="wb-field-label">Decimal places</span>
            <input type="number" class="wb-input" id="wb-fmt-dec" min="0" max="6" step="1" value="${Number.isInteger(f.dec) ? f.dec : ""}" placeholder="auto"></label>
        </div>
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Font</span>
            <select class="wb-input" id="wb-fmt-ff">
              <option value="" ${!f.ff ? "selected" : ""}>Default (system sans)</option>
              ${Object.entries(WB_FONT_LABELS).map(([k, label]) => `<option value="${k}" ${f.ff === k ? "selected" : ""} style="font-family:${WB_FONT_FAMILIES[k]}">${label}</option>`).join("")}
            </select></label>
          <label class="wb-field" style="flex:0 0 132px"><span class="wb-field-label">Font size (px)</span>
            <input type="number" class="wb-input" id="wb-fmt-fs" min="8" max="36" step="1" value="${Number.isInteger(f.fs) ? f.fs : ""}" placeholder="auto"></label>
        </div>
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Alignment</span>
            <select class="wb-input" id="wb-fmt-align">
              <option value="" ${!f.align ? "selected" : ""}>Automatic</option>
              <option value="left" ${f.align === "left" ? "selected" : ""}>Left</option>
              <option value="center" ${f.align === "center" ? "selected" : ""}>Center</option>
              <option value="right" ${f.align === "right" ? "selected" : ""}>Right</option>
            </select></label>
          <label class="wb-field"><span class="wb-field-label">Vertical</span>
            <select class="wb-input" id="wb-fmt-valign">
              <option value="" ${!f.valign ? "selected" : ""}>Middle</option>
              <option value="top" ${f.valign === "top" ? "selected" : ""}>Top</option>
              <option value="bottom" ${f.valign === "bottom" ? "selected" : ""}>Bottom</option>
            </select></label>
          <label class="wb-field"><span class="wb-field-label">Rotation</span>
            <select class="wb-input" id="wb-fmt-rot">
              <option value="" ${!f.rot ? "selected" : ""}>None</option>
              <option value="45" ${f.rot === 45 ? "selected" : ""}>Tilt 45°</option>
              <option value="90" ${f.rot === 90 ? "selected" : ""}>Vertical</option>
            </select></label>
        </div>
        <div class="wb-field"><span class="wb-field-label">Style</span>
          <div class="wb-fmt-checks">
            <label><input type="checkbox" id="wb-fmt-bold" ${f.bold ? "checked" : ""}> <strong>B</strong></label>
            <label><input type="checkbox" id="wb-fmt-italic" ${f.italic ? "checked" : ""}> <em>I</em></label>
            <label><input type="checkbox" id="wb-fmt-underline" ${f.underline ? "checked" : ""}> <u>U</u></label>
            <label><input type="checkbox" id="wb-fmt-strike" ${f.strike ? "checked" : ""}> <s>S</s></label>
            <label><input type="checkbox" id="wb-fmt-wrap" ${f.wrap ? "checked" : ""}> Wrap</label>
          </div>
        </div>
        <div class="wb-fmt-preview" id="wb-fmt-preview" aria-live="polite"></div>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-wb-fmt-apply>Apply</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const readForm = () => {
    const decRaw = wrap.querySelector("#wb-fmt-dec").value;
    const fsRaw = wrap.querySelector("#wb-fmt-fs").value;
    return {
      num: wrap.querySelector("#wb-fmt-num").value || null,
      dec: decRaw === "" ? null : Math.min(6, Math.max(0, Math.trunc(+decRaw))),
      ff: wrap.querySelector("#wb-fmt-ff").value || null,
      fs: fsRaw === "" ? null : Math.min(36, Math.max(8, Math.trunc(+fsRaw))),
      align: wrap.querySelector("#wb-fmt-align").value || null,
      valign: wrap.querySelector("#wb-fmt-valign").value || null,
      rot: +wrap.querySelector("#wb-fmt-rot").value || null,
      bold: wrap.querySelector("#wb-fmt-bold").checked || null,
      italic: wrap.querySelector("#wb-fmt-italic").checked || null,
      underline: wrap.querySelector("#wb-fmt-underline").checked || null,
      strike: wrap.querySelector("#wb-fmt-strike").checked || null,
      wrap: wrap.querySelector("#wb-fmt-wrap").checked || null,
    };
  };
  const paintPreview = () => {
    const p = readForm();
    const sample = rawVal != null && rawVal !== "" ? rawVal : "1234.567";
    const shown = formatForDisplay(sample, { num: p.num || "", dec: p.dec ?? undefined }, cell ? cell.type : "number");
    wrap.querySelector("#wb-fmt-preview").textContent = `Preview: ${shown}`;
  };
  paintPreview();
  wrap.addEventListener("input", paintPreview);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-wb-fmt-apply]")) {
      formatSelection(g, readForm());
      wrap.remove();
      g.els.grid.focus();
    }
  });
  setTimeout(() => wrap.querySelector("#wb-fmt-num")?.focus(), 30);
}

// ─── Excel-grade formula entry toolkit ──────────────────────────────────────

// AutoSum (Σ): with a range selected, writes =SUM(col-slice) below each
// column; on a single cell it hunts upward (then leftward) for the
// contiguous numbers and opens the editor with =SUM(...) pre-filled.
function autoSum(g) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const { r0, r1, c0, c1 } = selRect(g);
  const isNum = (r, c) => {
    const cell = sheet.cells.get(cellKey(r, c));
    if (!cell) return false;
    const raw = cell.formula ? cell.computed : cell.value;
    return cellNumeric(raw) != null && cell.type !== "text";
  };
  if (r0 !== r1 || c0 !== c1) {
    const changes = [];
    for (let c = c0; c <= c1; c++) {
      const t = r1 + 1;
      if (t >= sheet.rowCount) continue;
      const prev = sheet.cells.get(cellKey(t, c));
      const base = prev ? cloneCell(prev) : { value: null, formula: null, type: null, format: {} };
      changes.push({ r: t, c, cell: { ...base, value: null, type: "formula", formula: `=SUM(${colLabel(c)}${r0 + 1}:${colLabel(c)}${r1 + 1})` } });
    }
    if (changes.length) {
      setCells(g, changes);
      setActive(g, Math.min(r1 + 1, sheet.rowCount - 1), c0);
    }
    return;
  }
  let a = r0 - 1;
  while (a >= 0 && isNum(a, c0)) a--;
  if (a < r0 - 1) { startEdit(g, r0, c0, `=SUM(${colLabel(c0)}${a + 2}:${colLabel(c0)}${r0})`); return; }
  let b = c0 - 1;
  while (b >= 0 && isNum(r0, b)) b--;
  if (b < c0 - 1) { startEdit(g, r0, c0, `=SUM(${colLabel(b + 1)}${r0 + 1}:${colLabel(c0 - 1)}${r0 + 1})`); return; }
  startEdit(g, r0, c0, "=SUM(");
}

// Rewrite every cell/range reference in a formula through `fn`,
// preserving quoted string literals and sheet-name prefixes
// (Drivers!A2, 'Sheet 2'!A2). fn receives {sheet, colAbs, rowAbs, row,
// col} and returns replacement text (or null to keep the original).
function rewriteRefs(formula, fn) {
  const RE = /((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/g;
  const parts = String(formula).split(/("(?:[^"]|"")*")/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(RE, (m, pfx, d1, colStr, d2, rowStr, off, whole) => {
      const prev = off > 0 ? whole[off - 1] : "";
      if (!pfx && /[A-Za-z0-9_$]/.test(prev)) return m;      // tail of a longer identifier
      const after = whole[off + m.length] || "";
      if (/[A-Za-z0-9_(]/.test(after)) return m;             // function name / longer id
      const rc = parseCellRef(colStr + rowStr);
      if (!rc) return m;
      const out = fn({ sheet: pfx || "", colAbs: !!d1, rowAbs: !!d2, row: rc.row, col: rc.col });
      return out == null ? m : out;
    });
  }
  return parts.join("");
}

// Copy/fill semantics: $-anchored axes stay pinned, everything else
// shifts by the offset; sheet prefixes are preserved. Off-grid → #REF.
function shiftFormulaRelative(formula, dr, dc) {
  return rewriteRefs(formula, (ref) => {
    const col = ref.colAbs ? ref.col : ref.col + dc;
    const row = ref.rowAbs ? ref.row : ref.row + dr;
    if (row < 0 || col < 0) return "#REF";
    return ref.sheet + (ref.colAbs ? "$" : "") + colLabel(col) + (ref.rowAbs ? "$" : "") + (row + 1);
  });
}

const _fFloat = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : Math.round(v * 1e6) / 1e6);

// Drag-fill: copies the source block into the extension; a numeric
// column/row with a constant step extends the series (1,2 → 3,4…);
// formulas shift their relative refs like a spreadsheet.
function applyFill(g, src, ext) {
  const sheet = g.sheet;
  const changes = [];
  const vertical = ext.axis === "row";
  const laneLo = vertical ? src.c0 : src.r0;
  const laneHi = vertical ? src.c1 : src.r1;
  const srcLo = vertical ? src.r0 : src.c0;
  const srcHi = vertical ? src.r1 : src.c1;
  const srcLen = srcHi - srcLo + 1;
  for (let lane = laneLo; lane <= laneHi; lane++) {
    const series = [];
    for (let i = srcLo; i <= srcHi; i++) series.push(sheet.cells.get(vertical ? cellKey(i, lane) : cellKey(lane, i)) || null);
    const nums = series.map((cl) => (cl && !cl.formula ? cellNumeric(cl.value) : null));
    let step = null;
    if (series.length >= 2 && nums.every((v) => v != null)) {
      step = nums[1] - nums[0];
      for (let i = 2; i < nums.length; i++) if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) { step = null; break; }
    }
    for (let k = 1; k <= ext.count; k++) {
      const t = srcHi + k;
      if (vertical ? t >= sheet.rowCount : t >= sheet.colCount) break;
      const si = (k - 1) % srcLen;
      const srcCell = series[si];
      let next = null;
      if (srcCell) {
        next = cloneCell(srcCell);
        if (srcCell.formula) {
          next.formula = vertical
            ? shiftFormulaRelative(srcCell.formula, t - (srcLo + si), 0)
            : shiftFormulaRelative(srcCell.formula, 0, t - (srcLo + si));
        } else if (step != null) {
          next.value = String(_fFloat(nums[srcLen - 1] + step * k));
          next.type = "number";
        }
      }
      changes.push(vertical ? { r: t, c: lane, cell: next } : { r: lane, c: t, cell: next });
    }
  }
  if (!changes.length) return;
  setCells(g, changes);
  if (vertical) g.sel = { r0: src.r0, c0: src.c0, r1: src.r1 + ext.count, c1: src.c1 };
  else g.sel = { r0: src.r0, c0: src.c0, r1: src.r1, c1: src.c1 + ext.count };
  paintSelection(g);
  repaintGrid(g);
}

// ── Point mode: while typing a formula, clicking/dragging cells (or
// arrow keys) inserts references — the Excel interaction model. ──

const REF_ALLOWED_BEFORE = /[=+\-*/^&<>,(:]\s*$/;

function formulaEditInput(g) {
  if (!g.editing) return null;
  if (g.editing.input) return g.editing.input;
  if (g.editing.viaBar && document.activeElement === g.els.fbarInput) return g.els.fbarInput;
  return null;
}

function formulaPointState(g) {
  const input = formulaEditInput(g);
  if (!input) return null;
  const v = input.value;
  if (!v.startsWith("=")) return null;
  const caret = input.selectionStart ?? v.length;
  const pt = g.editing.point;
  if (pt && pt.end === caret) return { input, caret, replace: pt };
  if (REF_ALLOWED_BEFORE.test(v.slice(0, caret))) return { input, caret, replace: null };
  return null;
}

function insertPointRef(g, st, refText) {
  const input = st.input;
  const v = input.value;
  const start = st.replace ? st.replace.start : st.caret;
  const end = st.replace ? st.replace.end : st.caret;
  input.value = v.slice(0, start) + refText + v.slice(end);
  const pos = start + refText.length;
  try { input.setSelectionRange(pos, pos); } catch (_) {}
  g.editing.point = { start, end: pos };
  if (g.editing.input && input !== g.editing.input) g.editing.input.value = input.value;
  if (g.els.fbarInput && input !== g.els.fbarInput) g.els.fbarInput.value = input.value;
  paintFormulaRefs(g);
}

// ─── Cross-sheet point mode ──────────────────────────────────────────────────
// Excel's tab-switch-while-editing gesture: start a formula, click another
// sheet's tab, click cells there to insert 'Sheet Name'!A1 references, type
// operators between clicks, Enter commits back on the origin sheet. The
// in-progress formula lives in g.xedit while the editor DOM is torn down.

function sheetRefName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "'" + String(name).replace(/'/g, "''") + "'";
}

function xeditHint(g) {
  if (g.els.sbmode) g.els.sbmode.textContent = "Point — click a cell to reference it · Enter to confirm · Esc to cancel";
}

// Insert (or replace, on consecutive clicks — Excel point semantics) a
// reference to a rect on the CURRENTLY VISIBLE sheet into the pending formula.
function xeditInsertRef(g, r0, c0, r1, c1) {
  const x = g.xedit;
  if (!x) return;
  const rr0 = Math.min(r0, r1), rr1 = Math.max(r0, r1);
  const cc0 = Math.min(c0, c1), cc1 = Math.max(c0, c1);
  const ref = sheetRefName(g.sheet.name) + "!" + colLabel(cc0) + (rr0 + 1)
    + (rr1 !== rr0 || cc1 !== cc0 ? ":" + colLabel(cc1) + (rr1 + 1) : "");
  const start = x.seg ? x.seg.start : x.caret;
  const end = x.seg ? x.seg.end : x.caret;
  if (!x.seg && !REF_ALLOWED_BEFORE.test(x.value.slice(0, start))) return; // caret isn't at a ref position
  x.value = x.value.slice(0, start) + ref + x.value.slice(end);
  x.seg = { start, end: start + ref.length };
  x.caret = x.seg.end;
  if (g.els.fbarInput) g.els.fbarInput.value = x.value;
  g.active = { r: rr0, c: cc0 };
  g.sel = { r0: rr0, c0: cc0, r1: rr1, c1: cc1 };
  paintSelection(g);
  xeditHint(g);
}

function commitXedit(g) {
  const x = g.xedit;
  if (!x) return;
  g.xedit = null;
  switchSheet(g, x.sheetId);
  setActive(g, x.r, x.c);
  // replay through the normal editor commit so validation, undo, recalc
  // and activity logging all apply exactly as if typed in place
  startEdit(g, x.r, x.c, x.value);
  commitEdit(g, 1, 0);
  markSaveState(WB.saveState);
}

function cancelXedit(g) {
  const x = g.xedit;
  if (!x) return;
  g.xedit = null;
  switchSheet(g, x.sheetId);
  setActive(g, x.r, x.c);
  markSaveState(WB.saveState);
  g.els.grid.focus();
}

// Clicking back to the origin tab resumes the in-cell editor mid-formula.
function restoreXeditEditor(g) {
  const x = g.xedit;
  if (!x) return;
  g.xedit = null;
  setActive(g, x.r, x.c);
  startEdit(g, x.r, x.c, x.value);
  if (g.editing && x.seg && x.seg.end === x.value.length) g.editing.point = { ...x.seg };
  markSaveState(WB.saveState);
}

// Colored highlights on every cell/range the formula references.
const REFHL_COLORS = ["#2563EB", "#16A34A", "#7C3AED", "#D97706", "#DC2626"];

function paintFormulaRefs(g) {
  const input = formulaEditInput(g) || (g.editing && g.editing.input);
  const v = input && input.value.startsWith("=") ? input.value : null;
  paintRefsFromText(g, v);
}

function paintRefsFromText(g, v) {
  const layer = g.els.refhl;
  if (!layer) return;
  if (!v) { layer.innerHTML = ""; return; }
  const parts = v.split(/("(?:[^"]|"")*")/);
  const found = [];
  const seen = new Set();
  for (let i = 0; i < parts.length && found.length < 10; i += 2) {
    const re = /((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})(?::(\$?[A-Za-z]{1,3}\$?[0-9]{1,7}))?/g;
    let m;
    while ((m = re.exec(parts[i])) && found.length < 10) {
      if (m[1]) continue; // cross-sheet ref — not on this grid
      const prevCh = m.index > 0 ? parts[i][m.index - 1] : "";
      if (/[A-Za-z0-9_$!]/.test(prevCh)) continue;
      const a = parseCellRef(m[2]);
      const b = m[3] ? parseCellRef(m[3]) : a;
      if (!a || !b) continue;
      const key = [a.row, a.col, b.row, b.col].join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ a, b });
    }
  }
  let html = "";
  found.forEach((rf, i) => {
    const r0 = Math.max(0, Math.min(rf.a.row, rf.b.row)), r1 = Math.min(g.sheet.rowCount - 1, Math.max(rf.a.row, rf.b.row));
    const c0 = Math.max(0, Math.min(rf.a.col, rf.b.col)), c1 = Math.min(g.sheet.colCount - 1, Math.max(rf.a.col, rf.b.col));
    const d0 = dispIndexOfRow(g, r0), d1 = dispIndexOfRow(g, r1);
    if (d0 < 0 || d1 < 0 || r1 < r0 || c1 < c0) return;
    const color = REFHL_COLORS[i % REFHL_COLORS.length];
    html += `<div class="wb-ref-hl" style="left:${g.colX[c0]}px;top:${g.rowY[d0]}px;width:${g.colX[c1 + 1] - g.colX[c0]}px;height:${g.rowY[d1 + 1] - g.rowY[d0]}px;border-color:${color};background:${color}14"></div>`;
  });
  layer.innerHTML = html;
}

function clearFormulaChrome(g) {
  if (g.els.refhl) g.els.refhl.innerHTML = "";
  if (g.els.fxpop) g.els.fxpop.hidden = true;
  g.fxWord = null;
}

// ── Function autocomplete + signature hints ──

const FUNCTION_META = [
  { n: "SUM", sig: "SUM(range)", d: "Add the numbers in a range" },
  { n: "AVERAGE", sig: "AVERAGE(range)", d: "Mean of the numbers in a range" },
  { n: "MIN", sig: "MIN(range)", d: "Smallest number" },
  { n: "MAX", sig: "MAX(range)", d: "Largest number" },
  { n: "COUNT", sig: "COUNT(range)", d: "How many numeric cells" },
  { n: "COUNTA", sig: "COUNTA(range)", d: "How many non-empty cells" },
  { n: "COUNTIF", sig: "COUNTIF(range, criteria)", d: "Count cells matching a condition" },
  { n: "SUMIF", sig: "SUMIF(range, criteria, [sum_range])", d: "Sum cells matching a condition" },
  { n: "IF", sig: "IF(condition, then, else)", d: "Branch on a condition" },
  { n: "AND", sig: "AND(a, b, …)", d: "TRUE when every condition holds" },
  { n: "OR", sig: "OR(a, b, …)", d: "TRUE when any condition holds" },
  { n: "NOT", sig: "NOT(condition)", d: "Invert a condition" },
  { n: "VLOOKUP", sig: "VLOOKUP(value, range, col, FALSE)", d: "Find a row by its first column" },
  { n: "MEDIAN", sig: "MEDIAN(range)", d: "Middle value" },
  { n: "ROUND", sig: "ROUND(number, digits)", d: "Round to N digits" },
  { n: "ROUNDUP", sig: "ROUNDUP(number, digits)", d: "Round away from zero" },
  { n: "ROUNDDOWN", sig: "ROUNDDOWN(number, digits)", d: "Round toward zero" },
  { n: "ABS", sig: "ABS(number)", d: "Absolute value" },
  { n: "SQRT", sig: "SQRT(number)", d: "Square root" },
  { n: "LEN", sig: "LEN(text)", d: "Length of text" },
  { n: "UPPER", sig: "UPPER(text)", d: "Uppercase" },
  { n: "LOWER", sig: "LOWER(text)", d: "Lowercase" },
  { n: "TRIM", sig: "TRIM(text)", d: "Strip extra spaces" },
  { n: "CONCAT", sig: "CONCAT(a, b, …)", d: "Join values into text" },
  { n: "INT", sig: "INT(number)", d: "Round down to a whole number" },
  { n: "MOD", sig: "MOD(number, divisor)", d: "Remainder after division" },
  { n: "POWER", sig: "POWER(number, exponent)", d: "Raise to a power" },
  { n: "IFERROR", sig: "IFERROR(value, fallback)", d: "Fallback when a formula errors" },
  { n: "IFS", sig: "IFS(cond1, val1, …)", d: "First value whose condition holds" },
  { n: "LEFT", sig: "LEFT(text, count)", d: "Leading characters" },
  { n: "RIGHT", sig: "RIGHT(text, count)", d: "Trailing characters" },
  { n: "MID", sig: "MID(text, start, count)", d: "Characters from the middle" },
  { n: "FIND", sig: "FIND(needle, text)", d: "Position of text (case-sensitive)" },
  { n: "SUBSTITUTE", sig: "SUBSTITUTE(text, old, new)", d: "Replace text" },
  { n: "TEXT", sig: "TEXT(value, format)", d: "Format a number as text" },
  { n: "DATE", sig: "DATE(year, month, day)", d: "Build a date" },
  { n: "DAY", sig: "DAY(date)", d: "Day of month" },
  { n: "MONTH", sig: "MONTH(date)", d: "Month number" },
  { n: "YEAR", sig: "YEAR(date)", d: "Year" },
  { n: "WEEKDAY", sig: "WEEKDAY(date)", d: "Day of week (Sun=1)" },
  { n: "INDEX", sig: "INDEX(range, row, [col])", d: "Value at a position in a range" },
  { n: "MATCH", sig: "MATCH(value, range, 0)", d: "Position of a value in a range" },
  { n: "HLOOKUP", sig: "HLOOKUP(value, range, row, FALSE)", d: "Find a column by its first row" },
  { n: "XLOOKUP", sig: "XLOOKUP(value, lookup, return, [if_missing])", d: "Modern lookup" },
  { n: "COUNTIFS", sig: "COUNTIFS(range1, crit1, …)", d: "Count rows matching every condition" },
  { n: "SUMIFS", sig: "SUMIFS(sum_range, range1, crit1, …)", d: "Sum rows matching every condition" },
  { n: "AVERAGEIF", sig: "AVERAGEIF(range, criteria, [avg_range])", d: "Average of matches" },
  { n: "AVERAGEIFS", sig: "AVERAGEIFS(avg_range, range1, crit1, …)", d: "Average matching every condition" },
  { n: "TODAY", sig: "TODAY()", d: "Today's date" },
  { n: "NOW", sig: "NOW()", d: "Current date & time" },
  { n: "DATEDIF", sig: "DATEDIF(start, end, \"D\"|\"M\"|\"Y\")", d: "Days/months/years between dates" },
  { n: "DAYS", sig: "DAYS(end, start)", d: "Days between two dates" },
  { n: "DATEVALUE", sig: "DATEVALUE(text)", d: "Date text → serial number" },
  { n: "EDATE", sig: "EDATE(date, months)", d: "Date shifted by N months" },
  { n: "EOMONTH", sig: "EOMONTH(date, months)", d: "End of month, N months out" },
  { n: "NETWORKDAYS", sig: "NETWORKDAYS(start, end, [holidays])", d: "Working days between dates" },
  { n: "WORKDAY", sig: "WORKDAY(start, days, [holidays])", d: "Date N working days out" },
  { n: "WEEKNUM", sig: "WEEKNUM(date)", d: "Week number in the year" },
  { n: "SUMPRODUCT", sig: "SUMPRODUCT(range1, range2, …)", d: "Sum of products across ranges" },
  { n: "TEXTJOIN", sig: "TEXTJOIN(delim, ignore_empty, values…)", d: "Join values with a delimiter" },
  { n: "MAXIFS", sig: "MAXIFS(range, crit_range, crit, …)", d: "Largest value matching conditions" },
  { n: "MINIFS", sig: "MINIFS(range, crit_range, crit, …)", d: "Smallest value matching conditions" },
  { n: "LARGE", sig: "LARGE(range, k)", d: "K-th largest value" },
  { n: "SMALL", sig: "SMALL(range, k)", d: "K-th smallest value" },
  { n: "RANK", sig: "RANK(value, range, [order])", d: "Rank of a value in a range" },
  { n: "STDEV", sig: "STDEV(range)", d: "Sample standard deviation" },
  { n: "COUNTBLANK", sig: "COUNTBLANK(range)", d: "How many empty cells" },
  { n: "CHOOSE", sig: "CHOOSE(index, a, b, …)", d: "Pick a value by position" },
  { n: "SWITCH", sig: "SWITCH(value, case, result, …, [default])", d: "Match a value against cases" },
  { n: "XOR", sig: "XOR(a, b, …)", d: "TRUE when an odd number hold" },
  { n: "SEARCH", sig: "SEARCH(needle, text)", d: "Position of text (ignores case)" },
  { n: "PROPER", sig: "PROPER(text)", d: "Capitalize Each Word" },
  { n: "REPT", sig: "REPT(text, count)", d: "Repeat text N times" },
  { n: "VALUE", sig: "VALUE(text)", d: "Text → number" },
  { n: "EXACT", sig: "EXACT(a, b)", d: "Case-sensitive equality" },
  { n: "TRUNC", sig: "TRUNC(number, [digits])", d: "Cut off decimals" },
  { n: "CEILING", sig: "CEILING(number, [step])", d: "Round up to a multiple" },
  { n: "FLOOR", sig: "FLOOR(number, [step])", d: "Round down to a multiple" },
  { n: "ISBLANK", sig: "ISBLANK(cell)", d: "TRUE when empty" },
  { n: "ISNUMBER", sig: "ISNUMBER(value)", d: "TRUE for numbers" },
  { n: "ISTEXT", sig: "ISTEXT(value)", d: "TRUE for text" },
  { n: "ISERROR", sig: "ISERROR(value)", d: "TRUE when a formula errors" },
  { n: "LN", sig: "LN(number)", d: "Natural log" },
  { n: "LOG", sig: "LOG(number, [base])", d: "Logarithm (base 10 default)" },
  { n: "EXP", sig: "EXP(number)", d: "e raised to a power" },
  { n: "RAND", sig: "RAND()", d: "Random number 0–1" },
  { n: "RANDBETWEEN", sig: "RANDBETWEEN(low, high)", d: "Random whole number" },
  { n: "SIGN", sig: "SIGN(number)", d: "-1, 0, or 1" },
  { n: "EVEN", sig: "EVEN(number)", d: "Round up to even" },
  { n: "ODD", sig: "ODD(number)", d: "Round up to odd" },
  { n: "SUMSQ", sig: "SUMSQ(range)", d: "Sum of squares" },
  { n: "PRODUCT", sig: "PRODUCT(range)", d: "Multiply the numbers" },
  { n: "QUOTIENT", sig: "QUOTIENT(a, b)", d: "Integer division" },
  { n: "GCD", sig: "GCD(a, b, …)", d: "Greatest common divisor" },
  { n: "LCM", sig: "LCM(a, b, …)", d: "Least common multiple" },
  { n: "FACT", sig: "FACT(n)", d: "Factorial" },
  { n: "COMBIN", sig: "COMBIN(n, k)", d: "Ways to choose k of n" },
  { n: "MROUND", sig: "MROUND(number, multiple)", d: "Round to a multiple" },
  { n: "SIN", sig: "SIN(radians)", d: "Sine" },
  { n: "COS", sig: "COS(radians)", d: "Cosine" },
  { n: "TAN", sig: "TAN(radians)", d: "Tangent" },
  { n: "ASIN", sig: "ASIN(number)", d: "Inverse sine" },
  { n: "ACOS", sig: "ACOS(number)", d: "Inverse cosine" },
  { n: "ATAN", sig: "ATAN(number)", d: "Inverse tangent" },
  { n: "ATAN2", sig: "ATAN2(x, y)", d: "Angle of a point" },
  { n: "DEGREES", sig: "DEGREES(radians)", d: "Radians → degrees" },
  { n: "RADIANS", sig: "RADIANS(degrees)", d: "Degrees → radians" },
  { n: "LOG10", sig: "LOG10(number)", d: "Base-10 log" },
  { n: "SQRTPI", sig: "SQRTPI(number)", d: "√(n × π)" },
  { n: "AVERAGEA", sig: "AVERAGEA(range)", d: "Mean; text counts as 0" },
  { n: "MAXA", sig: "MAXA(range)", d: "Max; text counts as 0" },
  { n: "MINA", sig: "MINA(range)", d: "Min; text counts as 0" },
  { n: "COUNTUNIQUE", sig: "COUNTUNIQUE(range)", d: "Distinct values" },
  { n: "MODE", sig: "MODE(range)", d: "Most frequent number" },
  { n: "VAR", sig: "VAR(range)", d: "Sample variance" },
  { n: "VARP", sig: "VARP(range)", d: "Population variance" },
  { n: "STDEVP", sig: "STDEVP(range)", d: "Population std deviation" },
  { n: "GEOMEAN", sig: "GEOMEAN(range)", d: "Geometric mean" },
  { n: "HARMEAN", sig: "HARMEAN(range)", d: "Harmonic mean" },
  { n: "PERCENTILE", sig: "PERCENTILE(range, k)", d: "K-th percentile (0–1)" },
  { n: "QUARTILE", sig: "QUARTILE(range, q)", d: "Quartile 0–4" },
  { n: "CHAR", sig: "CHAR(code)", d: "Character from a code" },
  { n: "CODE", sig: "CODE(text)", d: "Code of first character" },
  { n: "CLEAN", sig: "CLEAN(text)", d: "Strip control characters" },
  { n: "DOLLAR", sig: "DOLLAR(number, [decimals])", d: "Format as currency text" },
  { n: "FIXED", sig: "FIXED(number, [decimals])", d: "Format with fixed decimals" },
  { n: "JOIN", sig: "JOIN(delim, values…)", d: "Join with a delimiter" },
  { n: "REPLACE", sig: "REPLACE(text, start, length, new)", d: "Replace by position" },
  { n: "T", sig: "T(value)", d: "Text values pass through" },
  { n: "N", sig: "N(value)", d: "Numbers pass through" },
  { n: "NA", sig: "NA()", d: "The #N/A error" },
  { n: "IFNA", sig: "IFNA(value, fallback)", d: "Fallback on #N/A only" },
  { n: "ISNA", sig: "ISNA(value)", d: "TRUE on #N/A" },
  { n: "ISEVEN", sig: "ISEVEN(number)", d: "TRUE for even numbers" },
  { n: "ISODD", sig: "ISODD(number)", d: "TRUE for odd numbers" },
  { n: "ISDATE", sig: "ISDATE(value)", d: "TRUE when it parses as a date" },
  { n: "ISLOGICAL", sig: "ISLOGICAL(value)", d: "TRUE for TRUE/FALSE" },
  { n: "ISNONTEXT", sig: "ISNONTEXT(value)", d: "TRUE when not text" },
  { n: "DAYS360", sig: "DAYS360(start, end)", d: "Days on a 360-day year" },
  { n: "YEARFRAC", sig: "YEARFRAC(start, end, [basis])", d: "Fraction of a year" },
  { n: "ISOWEEKNUM", sig: "ISOWEEKNUM(date)", d: "ISO week number" },
  { n: "HOUR", sig: "HOUR(time)", d: "Hour of a time" },
  { n: "MINUTE", sig: "MINUTE(time)", d: "Minute of a time" },
  { n: "SECOND", sig: "SECOND(time)", d: "Second of a time" },
  { n: "TIMEVALUE", sig: "TIMEVALUE(text)", d: "Time text → day fraction" },
  { n: "PMT", sig: "PMT(rate, nper, pv, [fv])", d: "Loan payment per period" },
  { n: "FV", sig: "FV(rate, nper, pmt, [pv])", d: "Future value" },
  { n: "PV", sig: "PV(rate, nper, pmt, [fv])", d: "Present value" },
  { n: "NPER", sig: "NPER(rate, pmt, pv, [fv])", d: "Number of periods" },
  { n: "NPV", sig: "NPV(rate, values…)", d: "Net present value" },
  { n: "IRR", sig: "IRR(cash_flows, [guess])", d: "Internal rate of return" },
  { n: "SLN", sig: "SLN(cost, salvage, life)", d: "Straight-line depreciation" },
  { n: "EFFECT", sig: "EFFECT(nominal, periods)", d: "Effective annual rate" },
  { n: "NOMINAL", sig: "NOMINAL(effective, periods)", d: "Nominal annual rate" },
  { n: "LOOKUP", sig: "LOOKUP(value, lookup_range, [result_range])", d: "Approximate vector lookup" },
  { n: "ROW", sig: "ROW([reference])", d: "Row number" },
  { n: "COLUMN", sig: "COLUMN([reference])", d: "Column number" },
  { n: "ROWS", sig: "ROWS(range)", d: "Rows in a range" },
  { n: "COLUMNS", sig: "COLUMNS(range)", d: "Columns in a range" },
  { n: "ADDRESS", sig: "ADDRESS(row, column, [abs])", d: "Build a cell reference" },
  // ── Google Sheets function-list parity ──
  // math
  { n: "SINH", sig: "SINH(number)", d: "Hyperbolic sine" },
  { n: "COSH", sig: "COSH(number)", d: "Hyperbolic cosine" },
  { n: "TANH", sig: "TANH(number)", d: "Hyperbolic tangent" },
  { n: "ASINH", sig: "ASINH(number)", d: "Inverse hyperbolic sine" },
  { n: "ACOSH", sig: "ACOSH(number)", d: "Inverse hyperbolic cosine" },
  { n: "ATANH", sig: "ATANH(number)", d: "Inverse hyperbolic tangent" },
  { n: "COT", sig: "COT(angle)", d: "Cotangent" },
  { n: "COTH", sig: "COTH(number)", d: "Hyperbolic cotangent" },
  { n: "ACOT", sig: "ACOT(number)", d: "Inverse cotangent" },
  { n: "ACOTH", sig: "ACOTH(number)", d: "Inverse hyperbolic cotangent" },
  { n: "CSC", sig: "CSC(angle)", d: "Cosecant" },
  { n: "CSCH", sig: "CSCH(number)", d: "Hyperbolic cosecant" },
  { n: "SEC", sig: "SEC(angle)", d: "Secant" },
  { n: "SECH", sig: "SECH(number)", d: "Hyperbolic secant" },
  { n: "CEILING.MATH", sig: "CEILING.MATH(number, [significance], [mode])", d: "Round up, with a mode for negatives" },
  { n: "FLOOR.MATH", sig: "FLOOR.MATH(number, [significance], [mode])", d: "Round down, with a mode for negatives" },
  { n: "CEILING.PRECISE", sig: "CEILING.PRECISE(number, [significance])", d: "Round up toward +∞" },
  { n: "FLOOR.PRECISE", sig: "FLOOR.PRECISE(number, [significance])", d: "Round down toward −∞" },
  { n: "ISO.CEILING", sig: "ISO.CEILING(number, [significance])", d: "Round up toward +∞" },
  { n: "COMBINA", sig: "COMBINA(n, k)", d: "Combinations with repetition" },
  { n: "FACTDOUBLE", sig: "FACTDOUBLE(n)", d: "Double factorial n!!" },
  { n: "MULTINOMIAL", sig: "MULTINOMIAL(a, b, …)", d: "Multinomial coefficient" },
  { n: "SERIESSUM", sig: "SERIESSUM(x, n, m, coefficients)", d: "Sum of a power series" },
  { n: "GAMMALN", sig: "GAMMALN(x)", d: "Natural log of the gamma function" },
  { n: "GAMMA", sig: "GAMMA(x)", d: "Gamma function" },
  { n: "BASE", sig: "BASE(number, radix, [min_length])", d: "Number → base string" },
  { n: "DECIMAL", sig: "DECIMAL(text, radix)", d: "Base string → number" },
  { n: "SUBTOTAL", sig: "SUBTOTAL(function_code, range)", d: "Aggregate with a chosen function" },
  // statistical
  { n: "AVEDEV", sig: "AVEDEV(range)", d: "Mean absolute deviation" },
  { n: "DEVSQ", sig: "DEVSQ(range)", d: "Sum of squared deviations" },
  { n: "KURT", sig: "KURT(range)", d: "Kurtosis" },
  { n: "SKEW", sig: "SKEW(range)", d: "Skewness (sample)" },
  { n: "SKEW.P", sig: "SKEW.P(range)", d: "Skewness (population)" },
  { n: "TRIMMEAN", sig: "TRIMMEAN(range, percent)", d: "Mean after trimming outliers" },
  { n: "STDEV.S", sig: "STDEV.S(range)", d: "Sample standard deviation" },
  { n: "STDEV.P", sig: "STDEV.P(range)", d: "Population standard deviation" },
  { n: "VAR.S", sig: "VAR.S(range)", d: "Sample variance" },
  { n: "VAR.P", sig: "VAR.P(range)", d: "Population variance" },
  { n: "STDEVA", sig: "STDEVA(range)", d: "Sample std dev; text = 0" },
  { n: "STDEVPA", sig: "STDEVPA(range)", d: "Population std dev; text = 0" },
  { n: "VARA", sig: "VARA(range)", d: "Sample variance; text = 0" },
  { n: "VARPA", sig: "VARPA(range)", d: "Population variance; text = 0" },
  { n: "MODE.SNGL", sig: "MODE.SNGL(range)", d: "Most frequent number" },
  { n: "MODE.MULT", sig: "MODE.MULT(range)", d: "All most-frequent numbers" },
  { n: "PERCENTILE.INC", sig: "PERCENTILE.INC(range, k)", d: "K-th percentile, inclusive" },
  { n: "PERCENTILE.EXC", sig: "PERCENTILE.EXC(range, k)", d: "K-th percentile, exclusive" },
  { n: "QUARTILE.INC", sig: "QUARTILE.INC(range, q)", d: "Quartile, inclusive" },
  { n: "QUARTILE.EXC", sig: "QUARTILE.EXC(range, q)", d: "Quartile, exclusive" },
  { n: "PERCENTRANK", sig: "PERCENTRANK(data, x, [significance])", d: "Percentile rank of a value" },
  { n: "PERCENTRANK.INC", sig: "PERCENTRANK.INC(data, x, [significance])", d: "Percentile rank, inclusive" },
  { n: "PERCENTRANK.EXC", sig: "PERCENTRANK.EXC(data, x, [significance])", d: "Percentile rank, exclusive" },
  { n: "RANK.EQ", sig: "RANK.EQ(value, data, [order])", d: "Rank; ties share the top rank" },
  { n: "RANK.AVG", sig: "RANK.AVG(value, data, [order])", d: "Rank; ties get the average" },
  { n: "PERMUT", sig: "PERMUT(n, k)", d: "Permutations" },
  { n: "PERMUTATIONA", sig: "PERMUTATIONA(n, k)", d: "Permutations with repetition" },
  { n: "STANDARDIZE", sig: "STANDARDIZE(x, mean, sd)", d: "Z-score of a value" },
  { n: "FISHER", sig: "FISHER(x)", d: "Fisher transformation" },
  { n: "FISHERINV", sig: "FISHERINV(y)", d: "Inverse Fisher transform" },
  { n: "GAUSS", sig: "GAUSS(z)", d: "P(0 < X < z) for standard normal" },
  { n: "PHI", sig: "PHI(x)", d: "Standard normal density" },
  { n: "CONFIDENCE", sig: "CONFIDENCE(alpha, sd, n)", d: "Confidence interval (normal)" },
  { n: "CONFIDENCE.NORM", sig: "CONFIDENCE.NORM(alpha, sd, n)", d: "Confidence interval (normal)" },
  { n: "CONFIDENCE.T", sig: "CONFIDENCE.T(alpha, sd, n)", d: "Confidence interval (t)" },
  { n: "NORMDIST", sig: "NORMDIST(x, mean, sd, cumulative)", d: "Normal distribution" },
  { n: "NORM.DIST", sig: "NORM.DIST(x, mean, sd, cumulative)", d: "Normal distribution" },
  { n: "NORMSDIST", sig: "NORMSDIST(z)", d: "Standard normal CDF" },
  { n: "NORM.S.DIST", sig: "NORM.S.DIST(z, cumulative)", d: "Standard normal distribution" },
  { n: "NORMINV", sig: "NORMINV(p, mean, sd)", d: "Inverse normal distribution" },
  { n: "NORM.INV", sig: "NORM.INV(p, mean, sd)", d: "Inverse normal distribution" },
  { n: "NORMSINV", sig: "NORMSINV(p)", d: "Inverse standard normal" },
  { n: "NORM.S.INV", sig: "NORM.S.INV(p)", d: "Inverse standard normal" },
  { n: "LOGNORMDIST", sig: "LOGNORMDIST(x, mean, sd)", d: "Lognormal CDF" },
  { n: "LOGNORM.DIST", sig: "LOGNORM.DIST(x, mean, sd, cumulative)", d: "Lognormal distribution" },
  { n: "LOGINV", sig: "LOGINV(p, mean, sd)", d: "Inverse lognormal" },
  { n: "LOGNORM.INV", sig: "LOGNORM.INV(p, mean, sd)", d: "Inverse lognormal" },
  { n: "TDIST", sig: "TDIST(x, df, tails)", d: "Student t (right/two-tailed)" },
  { n: "T.DIST", sig: "T.DIST(x, df, cumulative)", d: "Student t distribution" },
  { n: "T.DIST.RT", sig: "T.DIST.RT(x, df)", d: "Student t, right tail" },
  { n: "T.DIST.2T", sig: "T.DIST.2T(x, df)", d: "Student t, two tails" },
  { n: "TINV", sig: "TINV(p, df)", d: "Inverse t, two-tailed" },
  { n: "T.INV", sig: "T.INV(p, df)", d: "Inverse t, left-tailed" },
  { n: "T.INV.2T", sig: "T.INV.2T(p, df)", d: "Inverse t, two-tailed" },
  { n: "CHIDIST", sig: "CHIDIST(x, df)", d: "Chi-square, right tail" },
  { n: "CHISQ.DIST", sig: "CHISQ.DIST(x, df, cumulative)", d: "Chi-square distribution" },
  { n: "CHISQ.DIST.RT", sig: "CHISQ.DIST.RT(x, df)", d: "Chi-square, right tail" },
  { n: "CHIINV", sig: "CHIINV(p, df)", d: "Inverse chi-square, right tail" },
  { n: "CHISQ.INV", sig: "CHISQ.INV(p, df)", d: "Inverse chi-square, left tail" },
  { n: "CHISQ.INV.RT", sig: "CHISQ.INV.RT(p, df)", d: "Inverse chi-square, right tail" },
  { n: "FDIST", sig: "FDIST(x, df1, df2)", d: "F distribution, right tail" },
  { n: "F.DIST", sig: "F.DIST(x, df1, df2, cumulative)", d: "F distribution" },
  { n: "F.DIST.RT", sig: "F.DIST.RT(x, df1, df2)", d: "F distribution, right tail" },
  { n: "FINV", sig: "FINV(p, df1, df2)", d: "Inverse F, right tail" },
  { n: "F.INV", sig: "F.INV(p, df1, df2)", d: "Inverse F, left tail" },
  { n: "F.INV.RT", sig: "F.INV.RT(p, df1, df2)", d: "Inverse F, right tail" },
  { n: "BETADIST", sig: "BETADIST(x, alpha, beta, [A], [B])", d: "Beta CDF" },
  { n: "BETA.DIST", sig: "BETA.DIST(x, alpha, beta, cumulative, [A], [B])", d: "Beta distribution" },
  { n: "BETAINV", sig: "BETAINV(p, alpha, beta, [A], [B])", d: "Inverse beta" },
  { n: "BETA.INV", sig: "BETA.INV(p, alpha, beta, [A], [B])", d: "Inverse beta" },
  { n: "GAMMADIST", sig: "GAMMADIST(x, alpha, beta, cumulative)", d: "Gamma distribution" },
  { n: "GAMMA.DIST", sig: "GAMMA.DIST(x, alpha, beta, cumulative)", d: "Gamma distribution" },
  { n: "GAMMAINV", sig: "GAMMAINV(p, alpha, beta)", d: "Inverse gamma" },
  { n: "GAMMA.INV", sig: "GAMMA.INV(p, alpha, beta)", d: "Inverse gamma" },
  { n: "EXPONDIST", sig: "EXPONDIST(x, lambda, cumulative)", d: "Exponential distribution" },
  { n: "EXPON.DIST", sig: "EXPON.DIST(x, lambda, cumulative)", d: "Exponential distribution" },
  { n: "WEIBULL", sig: "WEIBULL(x, shape, scale, cumulative)", d: "Weibull distribution" },
  { n: "WEIBULL.DIST", sig: "WEIBULL.DIST(x, shape, scale, cumulative)", d: "Weibull distribution" },
  { n: "BINOMDIST", sig: "BINOMDIST(k, n, p, cumulative)", d: "Binomial distribution" },
  { n: "BINOM.DIST", sig: "BINOM.DIST(k, n, p, cumulative)", d: "Binomial distribution" },
  { n: "BINOM.INV", sig: "BINOM.INV(n, p, alpha)", d: "Smallest k with CDF ≥ alpha" },
  { n: "CRITBINOM", sig: "CRITBINOM(n, p, alpha)", d: "Smallest k with CDF ≥ alpha" },
  { n: "NEGBINOMDIST", sig: "NEGBINOMDIST(f, s, p)", d: "Negative binomial" },
  { n: "NEGBINOM.DIST", sig: "NEGBINOM.DIST(f, s, p, cumulative)", d: "Negative binomial" },
  { n: "POISSON", sig: "POISSON(k, mean, cumulative)", d: "Poisson distribution" },
  { n: "POISSON.DIST", sig: "POISSON.DIST(k, mean, cumulative)", d: "Poisson distribution" },
  { n: "HYPGEOMDIST", sig: "HYPGEOMDIST(k, n, K, N)", d: "Hypergeometric distribution" },
  { n: "HYPGEOM.DIST", sig: "HYPGEOM.DIST(k, n, K, N, cumulative)", d: "Hypergeometric distribution" },
  { n: "CORREL", sig: "CORREL(data_y, data_x)", d: "Correlation coefficient" },
  { n: "PEARSON", sig: "PEARSON(data_y, data_x)", d: "Pearson correlation" },
  { n: "RSQ", sig: "RSQ(data_y, data_x)", d: "R² of a linear fit" },
  { n: "COVAR", sig: "COVAR(data_y, data_x)", d: "Population covariance" },
  { n: "COVARIANCE.P", sig: "COVARIANCE.P(data_y, data_x)", d: "Population covariance" },
  { n: "COVARIANCE.S", sig: "COVARIANCE.S(data_y, data_x)", d: "Sample covariance" },
  { n: "SLOPE", sig: "SLOPE(data_y, data_x)", d: "Slope of a linear fit" },
  { n: "INTERCEPT", sig: "INTERCEPT(data_y, data_x)", d: "Intercept of a linear fit" },
  { n: "FORECAST", sig: "FORECAST(x, data_y, data_x)", d: "Predict y from a linear fit" },
  { n: "FORECAST.LINEAR", sig: "FORECAST.LINEAR(x, data_y, data_x)", d: "Predict y from a linear fit" },
  { n: "STEYX", sig: "STEYX(data_y, data_x)", d: "Standard error of the estimate" },
  { n: "TREND", sig: "TREND(data_y, [data_x], [new_x])", d: "Linear trend values" },
  { n: "GROWTH", sig: "GROWTH(data_y, [data_x], [new_x])", d: "Exponential growth values" },
  { n: "LINEST", sig: "LINEST(data_y, [data_x])", d: "Linear regression coefficients" },
  { n: "LOGEST", sig: "LOGEST(data_y, [data_x])", d: "Exponential regression coefficients" },
  { n: "TTEST", sig: "TTEST(range1, range2, tails, type)", d: "Student t-test p-value" },
  { n: "T.TEST", sig: "T.TEST(range1, range2, tails, type)", d: "Student t-test p-value" },
  { n: "FTEST", sig: "FTEST(range1, range2)", d: "F-test p-value" },
  { n: "F.TEST", sig: "F.TEST(range1, range2)", d: "F-test p-value" },
  { n: "CHITEST", sig: "CHITEST(observed, expected)", d: "Chi-square test p-value" },
  { n: "CHISQ.TEST", sig: "CHISQ.TEST(observed, expected)", d: "Chi-square test p-value" },
  { n: "ZTEST", sig: "ZTEST(data, x, [sigma])", d: "Z-test p-value" },
  { n: "Z.TEST", sig: "Z.TEST(data, x, [sigma])", d: "Z-test p-value" },
  { n: "PROB", sig: "PROB(values, probabilities, low, [high])", d: "Probability within a range" },
  { n: "AVERAGE.WEIGHTED", sig: "AVERAGE.WEIGHTED(values, weights, …)", d: "Weighted average" },
  { n: "MARGINOFERROR", sig: "MARGINOFERROR(range, confidence)", d: "Margin of error" },
  // engineering
  { n: "BIN2DEC", sig: "BIN2DEC(binary)", d: "Binary → decimal" },
  { n: "BIN2OCT", sig: "BIN2OCT(binary, [places])", d: "Binary → octal" },
  { n: "BIN2HEX", sig: "BIN2HEX(binary, [places])", d: "Binary → hexadecimal" },
  { n: "OCT2DEC", sig: "OCT2DEC(octal)", d: "Octal → decimal" },
  { n: "OCT2BIN", sig: "OCT2BIN(octal, [places])", d: "Octal → binary" },
  { n: "OCT2HEX", sig: "OCT2HEX(octal, [places])", d: "Octal → hexadecimal" },
  { n: "DEC2BIN", sig: "DEC2BIN(decimal, [places])", d: "Decimal → binary" },
  { n: "DEC2OCT", sig: "DEC2OCT(decimal, [places])", d: "Decimal → octal" },
  { n: "DEC2HEX", sig: "DEC2HEX(decimal, [places])", d: "Decimal → hexadecimal" },
  { n: "HEX2DEC", sig: "HEX2DEC(hex)", d: "Hexadecimal → decimal" },
  { n: "HEX2BIN", sig: "HEX2BIN(hex, [places])", d: "Hexadecimal → binary" },
  { n: "HEX2OCT", sig: "HEX2OCT(hex, [places])", d: "Hexadecimal → octal" },
  { n: "BITAND", sig: "BITAND(a, b)", d: "Bitwise AND" },
  { n: "BITOR", sig: "BITOR(a, b)", d: "Bitwise OR" },
  { n: "BITXOR", sig: "BITXOR(a, b)", d: "Bitwise XOR" },
  { n: "BITLSHIFT", sig: "BITLSHIFT(value, shift)", d: "Shift bits left" },
  { n: "BITRSHIFT", sig: "BITRSHIFT(value, shift)", d: "Shift bits right" },
  { n: "DELTA", sig: "DELTA(a, [b])", d: "1 when equal, else 0" },
  { n: "GESTEP", sig: "GESTEP(value, [step])", d: "1 when value ≥ step" },
  { n: "ERF", sig: "ERF(lower, [upper])", d: "Error function" },
  { n: "ERF.PRECISE", sig: "ERF.PRECISE(x)", d: "Error function" },
  { n: "ERFC", sig: "ERFC(x)", d: "Complementary error function" },
  { n: "ERFC.PRECISE", sig: "ERFC.PRECISE(x)", d: "Complementary error function" },
  { n: "COMPLEX", sig: "COMPLEX(real, imaginary, [suffix])", d: "Build a complex number" },
  { n: "IMREAL", sig: "IMREAL(complex)", d: "Real part" },
  { n: "IMAGINARY", sig: "IMAGINARY(complex)", d: "Imaginary part" },
  { n: "IMABS", sig: "IMABS(complex)", d: "Modulus" },
  { n: "IMARGUMENT", sig: "IMARGUMENT(complex)", d: "Argument (angle)" },
  { n: "IMCONJUGATE", sig: "IMCONJUGATE(complex)", d: "Complex conjugate" },
  { n: "IMSUM", sig: "IMSUM(a, b, …)", d: "Add complex numbers" },
  { n: "IMSUB", sig: "IMSUB(a, b)", d: "Subtract complex numbers" },
  { n: "IMPRODUCT", sig: "IMPRODUCT(a, b, …)", d: "Multiply complex numbers" },
  { n: "IMDIV", sig: "IMDIV(a, b)", d: "Divide complex numbers" },
  { n: "IMEXP", sig: "IMEXP(complex)", d: "e raised to a complex power" },
  { n: "IMLN", sig: "IMLN(complex)", d: "Complex natural log" },
  { n: "IMLOG", sig: "IMLOG(complex, base)", d: "Complex log" },
  { n: "IMLOG10", sig: "IMLOG10(complex)", d: "Complex base-10 log" },
  { n: "IMLOG2", sig: "IMLOG2(complex)", d: "Complex base-2 log" },
  { n: "IMPOWER", sig: "IMPOWER(complex, power)", d: "Complex power" },
  { n: "IMSQRT", sig: "IMSQRT(complex)", d: "Complex square root" },
  { n: "IMSIN", sig: "IMSIN(complex)", d: "Complex sine" },
  { n: "IMCOS", sig: "IMCOS(complex)", d: "Complex cosine" },
  { n: "IMTAN", sig: "IMTAN(complex)", d: "Complex tangent" },
  { n: "IMCOT", sig: "IMCOT(complex)", d: "Complex cotangent" },
  { n: "IMSEC", sig: "IMSEC(complex)", d: "Complex secant" },
  { n: "IMCSC", sig: "IMCSC(complex)", d: "Complex cosecant" },
  { n: "IMSINH", sig: "IMSINH(complex)", d: "Complex hyperbolic sine" },
  { n: "IMCOSH", sig: "IMCOSH(complex)", d: "Complex hyperbolic cosine" },
  { n: "IMTANH", sig: "IMTANH(complex)", d: "Complex hyperbolic tangent" },
  { n: "IMCOTH", sig: "IMCOTH(complex)", d: "Complex hyperbolic cotangent" },
  { n: "IMSECH", sig: "IMSECH(complex)", d: "Complex hyperbolic secant" },
  { n: "IMCSCH", sig: "IMCSCH(complex)", d: "Complex hyperbolic cosecant" },
  // financial
  { n: "RATE", sig: "RATE(nper, pmt, pv, [fv], [type], [guess])", d: "Interest rate per period" },
  { n: "IPMT", sig: "IPMT(rate, per, nper, pv, [fv], [type])", d: "Interest portion of a payment" },
  { n: "PPMT", sig: "PPMT(rate, per, nper, pv, [fv], [type])", d: "Principal portion of a payment" },
  { n: "CUMIPMT", sig: "CUMIPMT(rate, nper, pv, start, end, type)", d: "Cumulative interest paid" },
  { n: "CUMPRINC", sig: "CUMPRINC(rate, nper, pv, start, end, type)", d: "Cumulative principal paid" },
  { n: "ISPMT", sig: "ISPMT(rate, per, nper, pv)", d: "Interest for a straight-line loan" },
  { n: "SYD", sig: "SYD(cost, salvage, life, period)", d: "Sum-of-years'-digits depreciation" },
  { n: "DB", sig: "DB(cost, salvage, life, period, [month])", d: "Declining-balance depreciation" },
  { n: "DDB", sig: "DDB(cost, salvage, life, period, [factor])", d: "Double-declining depreciation" },
  { n: "VDB", sig: "VDB(cost, salvage, life, start, end, [factor], [no_switch])", d: "Variable declining depreciation" },
  { n: "AMORLINC", sig: "AMORLINC(cost, purchased, first_end, salvage, period, rate, [basis])", d: "French straight-line depreciation" },
  { n: "MIRR", sig: "MIRR(cash_flows, finance_rate, reinvest_rate)", d: "Modified internal rate of return" },
  { n: "XNPV", sig: "XNPV(rate, cash_flows, dates)", d: "NPV with specific dates" },
  { n: "XIRR", sig: "XIRR(cash_flows, dates, [guess])", d: "IRR with specific dates" },
  { n: "FVSCHEDULE", sig: "FVSCHEDULE(principal, rates)", d: "Future value with variable rates" },
  { n: "PDURATION", sig: "PDURATION(rate, pv, fv)", d: "Periods to reach a value" },
  { n: "RRI", sig: "RRI(nper, pv, fv)", d: "Equivalent interest rate" },
  { n: "DOLLARDE", sig: "DOLLARDE(fractional, fraction)", d: "Fractional price → decimal" },
  { n: "DOLLARFR", sig: "DOLLARFR(decimal, fraction)", d: "Decimal price → fractional" },
  { n: "ACCRINT", sig: "ACCRINT(issue, first, settlement, rate, par, freq, [basis])", d: "Accrued interest, periodic" },
  { n: "ACCRINTM", sig: "ACCRINTM(issue, settlement, rate, par, [basis])", d: "Accrued interest at maturity" },
  { n: "DISC", sig: "DISC(settlement, maturity, price, redemption, [basis])", d: "Discount rate of a security" },
  { n: "INTRATE", sig: "INTRATE(settlement, maturity, investment, redemption, [basis])", d: "Interest rate of a security" },
  { n: "RECEIVED", sig: "RECEIVED(settlement, maturity, investment, discount, [basis])", d: "Amount received at maturity" },
  { n: "PRICE", sig: "PRICE(settlement, maturity, rate, yield, redemption, freq, [basis])", d: "Price of a coupon bond" },
  { n: "PRICEDISC", sig: "PRICEDISC(settlement, maturity, discount, redemption, [basis])", d: "Price of a discounted security" },
  { n: "PRICEMAT", sig: "PRICEMAT(settlement, maturity, issue, rate, yield, [basis])", d: "Price, interest at maturity" },
  { n: "YIELD", sig: "YIELD(settlement, maturity, rate, price, redemption, freq, [basis])", d: "Yield of a coupon bond" },
  { n: "YIELDDISC", sig: "YIELDDISC(settlement, maturity, price, redemption, [basis])", d: "Yield of a discounted security" },
  { n: "YIELDMAT", sig: "YIELDMAT(settlement, maturity, issue, rate, price, [basis])", d: "Yield, interest at maturity" },
  { n: "TBILLPRICE", sig: "TBILLPRICE(settlement, maturity, discount)", d: "Treasury-bill price" },
  { n: "TBILLYIELD", sig: "TBILLYIELD(settlement, maturity, price)", d: "Treasury-bill yield" },
  { n: "TBILLEQ", sig: "TBILLEQ(settlement, maturity, discount)", d: "Bond-equivalent T-bill yield" },
  { n: "COUPPCD", sig: "COUPPCD(settlement, maturity, frequency, [basis])", d: "Previous coupon date" },
  { n: "COUPNCD", sig: "COUPNCD(settlement, maturity, frequency, [basis])", d: "Next coupon date" },
  { n: "COUPNUM", sig: "COUPNUM(settlement, maturity, frequency, [basis])", d: "Coupons until maturity" },
  { n: "COUPDAYS", sig: "COUPDAYS(settlement, maturity, frequency, [basis])", d: "Days in the coupon period" },
  { n: "COUPDAYBS", sig: "COUPDAYBS(settlement, maturity, frequency, [basis])", d: "Days from coupon start to settlement" },
  { n: "COUPDAYSNC", sig: "COUPDAYSNC(settlement, maturity, frequency, [basis])", d: "Days from settlement to next coupon" },
  { n: "DURATION", sig: "DURATION(settlement, maturity, rate, yield, frequency, [basis])", d: "Macaulay duration" },
  { n: "MDURATION", sig: "MDURATION(settlement, maturity, rate, yield, frequency, [basis])", d: "Modified duration" },
  // text
  { n: "ROMAN", sig: "ROMAN(number)", d: "Number → Roman numeral" },
  { n: "ARABIC", sig: "ARABIC(roman)", d: "Roman numeral → number" },
  { n: "UNICHAR", sig: "UNICHAR(code)", d: "Character from a Unicode code" },
  { n: "UNICODE", sig: "UNICODE(text)", d: "Unicode code of first character" },
  { n: "ASC", sig: "ASC(text)", d: "Full-width → half-width" },
  { n: "REGEXMATCH", sig: "REGEXMATCH(text, pattern)", d: "TRUE when a pattern matches" },
  { n: "REGEXEXTRACT", sig: "REGEXEXTRACT(text, pattern)", d: "First matching substring" },
  { n: "REGEXREPLACE", sig: "REGEXREPLACE(text, pattern, replacement)", d: "Replace matches" },
  { n: "LENB", sig: "LENB(text)", d: "Length in bytes" },
  { n: "LEFTB", sig: "LEFTB(text, num_bytes)", d: "Leading bytes" },
  { n: "RIGHTB", sig: "RIGHTB(text, num_bytes)", d: "Trailing bytes" },
  { n: "MIDB", sig: "MIDB(text, start, num_bytes)", d: "Bytes from the middle" },
  { n: "FINDB", sig: "FINDB(needle, text, [start])", d: "Byte position (case-sensitive)" },
  { n: "SEARCHB", sig: "SEARCHB(needle, text, [start])", d: "Byte position (ignores case)" },
  { n: "REPLACEB", sig: "REPLACEB(text, start, num_bytes, new)", d: "Replace by byte position" },
  // date / time
  { n: "TIME", sig: "TIME(hour, minute, second)", d: "Build a time" },
  { n: "EPOCHTODATE", sig: "EPOCHTODATE(timestamp, [unit])", d: "Unix timestamp → date" },
  { n: "NETWORKDAYS.INTL", sig: "NETWORKDAYS.INTL(start, end, [weekend], [holidays])", d: "Working days with custom weekend" },
  { n: "WORKDAY.INTL", sig: "WORKDAY.INTL(start, days, [weekend], [holidays])", d: "Date N working days out" },
  // info / logical / lookup / operator / web
  { n: "TRUE", sig: "TRUE()", d: "The logical TRUE" },
  { n: "FALSE", sig: "FALSE()", d: "The logical FALSE" },
  { n: "ISEMAIL", sig: "ISEMAIL(value)", d: "TRUE for an email address" },
  { n: "ISURL", sig: "ISURL(value)", d: "TRUE for a URL" },
  { n: "ISBETWEEN", sig: "ISBETWEEN(value, low, high, [low_incl], [high_incl])", d: "TRUE when in a range" },
  { n: "ISERR", sig: "ISERR(value)", d: "TRUE for errors except #N/A" },
  { n: "ISREF", sig: "ISREF(value)", d: "TRUE for a reference" },
  { n: "ISFORMULA", sig: "ISFORMULA(cell)", d: "TRUE when the cell holds a formula" },
  { n: "FORMULATEXT", sig: "FORMULATEXT(cell)", d: "The formula as text" },
  { n: "ERROR.TYPE", sig: "ERROR.TYPE(value)", d: "Error code number" },
  { n: "TYPE", sig: "TYPE(value)", d: "Data-type code" },
  { n: "CELL", sig: "CELL(info_type, reference)", d: "Info about a cell" },
  { n: "LET", sig: "LET(name, value, …, formula)", d: "Name intermediate values" },
  { n: "LAMBDA", sig: "LAMBDA(name, …, formula)", d: "Define a reusable function" },
  { n: "MAP", sig: "MAP(array, …, lambda)", d: "Apply a lambda to each value" },
  { n: "REDUCE", sig: "REDUCE(initial, array, lambda)", d: "Fold an array to one value" },
  { n: "SCAN", sig: "SCAN(initial, array, lambda)", d: "Running fold over an array" },
  { n: "BYROW", sig: "BYROW(array, lambda)", d: "Apply a lambda to each row" },
  { n: "BYCOL", sig: "BYCOL(array, lambda)", d: "Apply a lambda to each column" },
  { n: "MAKEARRAY", sig: "MAKEARRAY(rows, columns, lambda)", d: "Build an array from a lambda" },
  { n: "INDIRECT", sig: "INDIRECT(reference_text, [a1])", d: "Reference from text" },
  { n: "OFFSET", sig: "OFFSET(reference, rows, cols, [height], [width])", d: "Shifted reference" },
  { n: "XMATCH", sig: "XMATCH(search, range, [match_mode], [search_mode])", d: "Modern MATCH" },
  { n: "ENCODEURL", sig: "ENCODEURL(text)", d: "URL-encode text" },
  { n: "HYPERLINK", sig: "HYPERLINK(url, [label])", d: "Clickable link" },
  // parser
  { n: "CONVERT", sig: "CONVERT(value, from_unit, to_unit)", d: "Convert between units" },
  { n: "TO_DATE", sig: "TO_DATE(value)", d: "Convert to a date" },
  { n: "TO_TEXT", sig: "TO_TEXT(value)", d: "Convert to text" },
  { n: "TO_PURE_NUMBER", sig: "TO_PURE_NUMBER(value)", d: "Strip formatting to a number" },
  { n: "TO_DOLLARS", sig: "TO_DOLLARS(value)", d: "Convert to a currency value" },
  { n: "TO_PERCENT", sig: "TO_PERCENT(value)", d: "Convert to a percent value" },
  // database
  { n: "DSUM", sig: "DSUM(database, field, criteria)", d: "Sum matching records" },
  { n: "DAVERAGE", sig: "DAVERAGE(database, field, criteria)", d: "Average matching records" },
  { n: "DCOUNT", sig: "DCOUNT(database, field, criteria)", d: "Count numeric matches" },
  { n: "DCOUNTA", sig: "DCOUNTA(database, field, criteria)", d: "Count non-empty matches" },
  { n: "DMAX", sig: "DMAX(database, field, criteria)", d: "Max of matching records" },
  { n: "DMIN", sig: "DMIN(database, field, criteria)", d: "Min of matching records" },
  { n: "DGET", sig: "DGET(database, field, criteria)", d: "The one matching value" },
  { n: "DPRODUCT", sig: "DPRODUCT(database, field, criteria)", d: "Product of matches" },
  { n: "DSTDEV", sig: "DSTDEV(database, field, criteria)", d: "Sample std dev of matches" },
  { n: "DSTDEVP", sig: "DSTDEVP(database, field, criteria)", d: "Population std dev of matches" },
  { n: "DVAR", sig: "DVAR(database, field, criteria)", d: "Sample variance of matches" },
  { n: "DVARP", sig: "DVARP(database, field, criteria)", d: "Population variance of matches" },
  // array / filter
  { n: "ARRAYFORMULA", sig: "ARRAYFORMULA(array_expression)", d: "Evaluate as an array" },
  { n: "FILTER", sig: "FILTER(range, condition, …)", d: "Keep rows meeting conditions" },
  { n: "SORT", sig: "SORT(range, [sort_column], [ascending], …)", d: "Sort a range" },
  { n: "SORTN", sig: "SORTN(range, [n], [ties_mode], [sort_column], [ascending], …)", d: "Top-N rows, sorted" },
  { n: "UNIQUE", sig: "UNIQUE(range, [by_column], [exactly_once])", d: "Distinct rows" },
  { n: "SPLIT", sig: "SPLIT(text, delimiter, [split_by_each], [remove_empty])", d: "Split text into cells" },
  { n: "FLATTEN", sig: "FLATTEN(range, …)", d: "Flatten ranges into one column" },
  { n: "TRANSPOSE", sig: "TRANSPOSE(range)", d: "Swap rows and columns" },
  { n: "SEQUENCE", sig: "SEQUENCE(rows, [columns], [start], [step])", d: "Generate a sequence" },
  { n: "RANDARRAY", sig: "RANDARRAY([rows], [columns])", d: "Array of random numbers" },
  { n: "ARRAY_CONSTRAIN", sig: "ARRAY_CONSTRAIN(array, rows, columns)", d: "Crop an array" },
  { n: "CHOOSEROWS", sig: "CHOOSEROWS(array, row_num, …)", d: "Pick rows by number" },
  { n: "CHOOSECOLS", sig: "CHOOSECOLS(array, col_num, …)", d: "Pick columns by number" },
  { n: "HSTACK", sig: "HSTACK(range, …)", d: "Join ranges side by side" },
  { n: "VSTACK", sig: "VSTACK(range, …)", d: "Stack ranges vertically" },
  { n: "TOROW", sig: "TOROW(array, [ignore], [scan_by_column])", d: "Flatten into a row" },
  { n: "TOCOL", sig: "TOCOL(array, [ignore], [scan_by_column])", d: "Flatten into a column" },
  { n: "WRAPROWS", sig: "WRAPROWS(vector, wrap_count, [pad])", d: "Wrap a vector into rows" },
  { n: "WRAPCOLS", sig: "WRAPCOLS(vector, wrap_count, [pad])", d: "Wrap a vector into columns" },
  { n: "FREQUENCY", sig: "FREQUENCY(data, classes)", d: "Histogram counts" },
  { n: "MMULT", sig: "MMULT(matrix1, matrix2)", d: "Matrix multiplication" },
  { n: "MDETERM", sig: "MDETERM(matrix)", d: "Matrix determinant" },
  { n: "MINVERSE", sig: "MINVERSE(matrix)", d: "Matrix inverse" },
  { n: "MUNIT", sig: "MUNIT(dimension)", d: "Identity matrix" },
  { n: "SUMX2MY2", sig: "SUMX2MY2(array_x, array_y)", d: "Σ(x²−y²)" },
  { n: "SUMX2PY2", sig: "SUMX2PY2(array_x, array_y)", d: "Σ(x²+y²)" },
  { n: "SUMXMY2", sig: "SUMXMY2(array_x, array_y)", d: "Σ(x−y)²" },
];

function ensureFxPop(g) {
  if (!g.els.fxpop) {
    const d = document.createElement("div");
    d.className = "wb-fx-pop";
    d.hidden = true;
    g.els.canvas.appendChild(d);
    g.els.fxpop = d;
    d.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep the editor focused
      const it = e.target.closest("[data-fx]");
      if (it) acceptFx(g, it.getAttribute("data-fx"));
    });
  }
  return g.els.fxpop;
}

function updateFxPop(g) {
  const ed = g.editing;
  const input = ed && ed.input;
  const pop = ensureFxPop(g);
  let show = false;
  if (input && input.value.startsWith("=")) {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const mWord = /(^=|[^A-Za-z0-9.$_])([A-Za-z][A-Za-z0-9._]{0,22})$/.exec(before);
    const mSig = /([A-Za-z][A-Za-z0-9._]{1,22})\($/.exec(before);
    if (mWord) {
      const q = mWord[2].toUpperCase();
      const items = FUNCTION_META.filter((f) => f.n.startsWith(q)).slice(0, 8);
      if (items.length && !(items.length === 1 && items[0].n === q)) {
        pop.innerHTML = items.map((f) => `<button type="button" class="wb-fx-item" data-fx="${f.n}"><span class="wb-fx-name">${f.n}(</span><span class="wb-fx-desc">${esc(f.d)}</span></button>`).join("")
          + `<div class="wb-fx-foot">Tab or click to insert</div>`;
        g.fxWord = { start: caret - q.length, end: caret };
        show = true;
      }
    } else if (mSig) {
      const f = FUNCTION_META.find((x) => x.n === mSig[1].toUpperCase());
      if (f) {
        pop.innerHTML = `<div class="wb-fx-hint"><span class="wb-fx-name">${esc(f.sig)}</span><span class="wb-fx-desc">${esc(f.d)}</span></div>`;
        g.fxWord = null;
        show = true;
      }
    }
  }
  if (show && input) {
    pop.style.left = input.style.left;
    pop.style.top = (parseFloat(input.style.top) + parseFloat(input.style.height) + 2) + "px";
    pop.hidden = false;
  } else {
    pop.hidden = true;
    g.fxWord = null;
  }
}

function acceptFx(g, name) {
  const ed = g.editing;
  if (!ed || !ed.input || !g.fxWord) return;
  const input = ed.input;
  const v = input.value;
  input.value = v.slice(0, g.fxWord.start) + name + "(" + v.slice(g.fxWord.end);
  const pos = g.fxWord.start + name.length + 1;
  input.focus();
  try { input.setSelectionRange(pos, pos); } catch (_) {}
  g.fxWord = null;
  if (g.els.fbarInput) g.els.fbarInput.value = input.value;
  updateFxPop(g);
  paintFormulaRefs(g);
}

// ── Functions browser (toolbar fx button) ──
// A searchable directory over the full FUNCTION_META list. Empty query
// shows a curated "Common" shortlist; typing ranks matches by
// name-prefix → name-substring → description. Picking one inserts
// "=NAME(" into the active cell and drops into the editor, where the
// signature hint takes over.

const FN_COMMON = ["SUM", "AVERAGE", "COUNT", "COUNTA", "IF", "IFS", "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "VLOOKUP", "XLOOKUP", "INDEX", "MATCH", "FILTER", "SORT", "UNIQUE", "ROUND", "TODAY", "CONCATENATE"];

function fnSearch(q) {
  const Q = q.toUpperCase();
  const hits = [];
  for (const f of FUNCTION_META) {
    let score;
    if (f.n === Q) score = 0;
    else if (f.n.startsWith(Q)) score = 1;
    else if (f.n.includes(Q)) score = 2;
    else if (f.sig.toUpperCase().includes(Q) || f.d.toUpperCase().includes(Q)) score = 3;
    else continue;
    hits.push([score, f]);
  }
  hits.sort((a, b) => a[0] - b[0] || (a[1].n < b[1].n ? -1 : a[1].n > b[1].n ? 1 : 0));
  return hits.map((h) => h[1]);
}

function fnItemHtml(f, active) {
  return `<button type="button" class="wb-fn-item${active ? " is-active" : ""}" data-wb-fn="${esc(f.n)}" role="option" title="${esc(f.sig)}">`
    + `<span class="wb-fn-name">${esc(f.n)}</span><span class="wb-fn-desc">${esc(f.d)}</span></button>`;
}

function fnListHtml(q) {
  if (!q) {
    const common = FN_COMMON.map((n) => FUNCTION_META.find((f) => f.n === n)).filter(Boolean);
    return `<div class="wb-fn-group">Common</div>`
      + common.map((f, i) => fnItemHtml(f, i === 0)).join("")
      + `<div class="wb-fn-foot">Type to search all ${FUNCTION_META.length} functions</div>`;
  }
  const hits = fnSearch(q).slice(0, 60);
  if (!hits.length) return `<div class="wb-fn-empty">No function matches “${esc(q)}”</div>`;
  return hits.map((f, i) => fnItemHtml(f, i === 0)).join("");
}

function fnBrowserPop(g, anchorBtn) {
  const pop = anchorBtn.closest(".popover-anchor")?.querySelector(".wb-fn-pop");
  if (!pop) return;
  pop.innerHTML = `<div class="wb-fn-head"><input type="text" class="wb-fn-search" placeholder="Search functions…" aria-label="Search functions" autocomplete="off" spellcheck="false"></div><div class="wb-fn-list" role="listbox"></div>`;
  const input = pop.querySelector(".wb-fn-search");
  const list = pop.querySelector(".wb-fn-list");
  const render = () => { list.innerHTML = fnListHtml(input.value.trim()); list.scrollTop = 0; };
  render();
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll(".wb-fn-item")];
    if (!items.length) return;
    let idx = items.findIndex((el) => el.classList.contains("is-active"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (idx < 0) idx = 0;
      items[idx]?.classList.remove("is-active");
      idx = e.key === "ArrowDown" ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      items[idx].classList.add("is-active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = items[idx] || items[0];
      const nm = pick.getAttribute("data-wb-fn");
      closeAllPopovers();
      if (WB.canEdit) startEdit(g, g.active.r, g.active.c, "=" + nm + "(");
    } else if (e.key === "Escape") {
      closeAllPopovers();
      g.els.grid.focus();
    }
  });
}

function commentedCellSet(sheetId) {
  const set = new Set();
  for (const c of WB.comments) {
    if (c.sheet_id === sheetId && c.cell_ref && !c.resolved_at && !c.parent_comment_id) {
      const rc = parseCellRef(c.cell_ref);
      if (rc) set.add(cellKey(rc.row, rc.col));
    }
  }
  return set;
}

function paintCommentMarkers() {
  for (const g of GRIDS.values()) repaintGrid(g);
}

// ─── Sheet tabs ──────────────────────────────────────────────────────────────

function renderSheetTabs(g) {
  const all = (WB.sheetsByBlock.get(g.blockId) || []).slice().sort((a, b) => a.position - b.position);
  const sheets = all.filter((sh) => !(sh.meta && sh.meta.hidden) || sh.id === g.sheet.id);
  const ro = !WB.canEdit;
  const tabBtn = (sh) => {
    const active = sh.id === g.sheet.id;
    const color = sh.meta && sh.meta.tabColor && HEX_COLOR_RE.test(sh.meta.tabColor) ? sh.meta.tabColor : null;
    return `<button type="button" class="wb-tab ${active ? "is-active" : ""}" role="tab" aria-selected="${active}" data-wb-sheettab="${sh.id}" title="${esc(sh.name)}${ro ? "" : " — double-click to rename"}"${color ? ` style="box-shadow:inset 0 -3px 0 ${color}"` : ""}>${esc(sh.name)}${active && !ro ? `<span class="wb-tab-caret" data-wb-tabmenu="${sh.id}" title="Sheet menu" aria-label="Sheet menu">▾</span>` : ""}</button>`;
  };
  g.els.tabs.innerHTML = `
    <button type="button" class="btn btn-ghost btn-icon btn-sm wb-tab-all" data-wb-allsheets title="All sheets" aria-label="All sheets">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
    </button>
    <div class="wb-tabs-scroll" role="tablist" aria-label="Sheets">
      ${sheets.map(tabBtn).join("")}
    </div>
    ${ro ? "" : `<button type="button" class="btn btn-ghost btn-icon btn-sm wb-tab-add" data-wb-act="sheet-add" data-block="${g.blockId}" title="Add sheet" aria-label="Add sheet">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`}`;
  g.els.selstats = g.els.body.querySelector("[data-wb-selstats]");
  g.els.sbmode = g.els.body.querySelector("[data-wb-sbmode]");
  g.els.sbfilter = g.els.body.querySelector("[data-wb-sbfilter]");
}

// Sheets' ☰ list: every sheet including hidden ones; picking a hidden
// sheet unhides it.
function openAllSheetsMenu(g, x, y) {
  const all = (WB.sheetsByBlock.get(g.blockId) || []).slice().sort((a, b) => a.position - b.position);
  const m = ctxMenu(x, y, all.map((sh) => {
    const hidden = sh.meta && sh.meta.hidden;
    return `<button type="button" class="popover-item" data-sheet-go="${esc(sh.id)}" role="menuitem">${sh.id === g.sheet.id ? "✓ " : ""}${esc(sh.name)}${hidden ? ` <span class="wb-badge is-muted">hidden</span>` : ""}</button>`;
  }).join(""));
  m.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sheet-go]");
    if (!btn) return;
    const sh = all.find((s) => s.id === btn.getAttribute("data-sheet-go"));
    closeAllPopovers();
    if (!sh) return;
    if (sh.meta && sh.meta.hidden && WB.canEdit) { sh.meta = { ...sh.meta, hidden: false }; saveSheetMeta(sh.id); }
    switchSheet(g, sh.id);
    renderSheetTabs(g);
  });
}

function switchSheet(g, sheetId) {
  const sheets = WB.sheetsByBlock.get(g.blockId) || [];
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet || sheet.id === g.sheet.id) return;
  cancelEdit(g);
  g.sheet = sheet;
  recalcSheet(sheet); // cross-sheet inputs may have changed while hidden
  closeFindPanel(g);
  restoreViewState(g); // persisted filters/filter mode + this viewer's zoom
  g.active = { r: 0, c: 0 };
  g.sel = { r0: 0, c0: 0, r1: 0, c1: 0 };
  g.undo = []; g.redo = [];
  g.block.settings = { ...(g.block.settings || {}), active_sheet_id: sheetId };
  if (WB.canEdit) saveBlock(g.block, { settings: g.block.settings });
  computeGeometry(g);
  g.els.scroll.scrollLeft = 0;
  g.els.scroll.scrollTop = 0;
  renderSheetTabs(g);
  repaintGrid(g);
  syncFormulaBar(g);
  renderCharts(g);
  renderPivots(g);
}

// ─── Selection + navigation ─────────────────────────────────────────────────

function setActive(g, r, c, opts) {
  const sheet = g.sheet;
  r = Math.max(0, Math.min(sheet.rowCount - 1, r));
  c = Math.max(0, Math.min(sheet.colCount - 1, c));
  const mg = mergeAt(sheet, r, c);
  if (mg) { r = mg.r0; c = mg.c0; } // clicks inside a merge land on its anchor
  g.active = { r, c };
  if (!opts || !opts.keepSel) g.sel = { r0: r, c0: c, r1: r, c1: c };
  if (!g.editing && g.els.refhl && g.els.refhl.innerHTML) g.els.refhl.innerHTML = "";
  paintSelection(g);
  // headers repaint for the sel highlight (cheap — reuse main paint)
  repaintGrid(g);
  syncFormulaBar(g);
  if (!opts || opts.scroll !== false) scrollCellIntoView(g, r, c);
}

// Select an explicit rectangle (top-left becomes active).
function selectRect(g, r0, c0, r1, c1) {
  const sheet = g.sheet;
  const rr0 = Math.max(0, Math.min(sheet.rowCount - 1, Math.min(r0, r1)));
  const cc0 = Math.max(0, Math.min(sheet.colCount - 1, Math.min(c0, c1)));
  const rr1 = Math.max(0, Math.min(sheet.rowCount - 1, Math.max(r0, r1)));
  const cc1 = Math.max(0, Math.min(sheet.colCount - 1, Math.max(c0, c1)));
  setActive(g, rr0, cc0, { keepSel: true });
  g.sel = { r0: rr0, c0: cc0, r1: rr1, c1: cc1 };
  paintSelection(g);
  repaintGrid(g);
  syncFormulaBar(g);
  scrollCellIntoView(g, rr0, cc0);
}

// Name-box "go to": a cell ref (B12), an A1 range (B2:D9), or a named range
// (case-insensitive; jumps to its sheet). Returns true when it navigated.
function gotoNameBox(g, text) {
  if (!text) return false;
  const block = findBlock(g.sheet.blockId);
  const def = blockNamedRanges(block).find((d) => d.name && d.name.toLowerCase() === text.toLowerCase());
  const src = def ? def.ref : text;
  let node;
  try { node = parseFormula("=" + src); } catch (_) { return false; }
  if (node.k !== "range" && node.k !== "ref") return false;
  if (node.sheet) {
    const sibs = WB.sheetsByBlock.get(g.sheet.blockId) || [];
    const target = sibs.find((s) => s.name.trim().toLowerCase() === String(node.sheet).trim().toLowerCase());
    if (target && target.id !== g.sheet.id) switchSheet(g, target.id);
    else if (!target) return false;
  }
  if (node.k === "ref") {
    if (node.row >= g.sheet.rowCount || node.col >= g.sheet.colCount) return false;
    setActive(g, node.row, node.col);
  } else {
    const b = boundedRange(node, { rowCount: g.sheet.rowCount, colCount: g.sheet.colCount });
    selectRect(g, b.a.row, b.a.col, b.b.row, b.b.col);
  }
  return true;
}

function scrollCellIntoView(g, r, c) {
  const di = dispIndexOfRow(g, r);
  if (di < 0) return;
  const scroll = g.els.scroll;
  const x = g.colX[c], x2 = g.colX[c + 1];
  const y = g.rowY[di], y2 = g.rowY[di + 1];
  if (x < scroll.scrollLeft) scroll.scrollLeft = x;
  else if (x2 > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = x2 - scroll.clientWidth;
  if (y < scroll.scrollTop) scroll.scrollTop = y;
  else if (y2 > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y2 - scroll.clientHeight;
}

function moveActive(g, dr, dc, extend) {
  cancelMenusFrom(g.els.grid);
  let { r, c } = extend ? { r: g.sel.r1, c: g.sel.c1 } : g.active;
  // move through the *visible* row list so filtered rows are skipped
  if (dr !== 0) {
    const di = dispIndexOfRow(g, r);
    const nd = Math.max(0, Math.min(g.rows.length - 1, di + dr));
    r = g.rows[nd];
  }
  c = Math.max(0, Math.min(g.sheet.colCount - 1, c + dc));
  if (dc !== 0 && g.sheet.hiddenCols && g.sheet.hiddenCols.size) {
    let guard = 0;
    while (g.sheet.hiddenCols.has(c) && guard++ < g.sheet.colCount) {
      const nxt = c + (dc > 0 ? 1 : -1);
      if (nxt < 0 || nxt >= g.sheet.colCount) break;
      c = nxt;
    }
  }
  // arrows step past a merged range instead of getting stuck inside it
  const fromM = mergeAt(g.sheet, extend ? g.sel.r1 : g.active.r, extend ? g.sel.c1 : g.active.c);
  if (fromM && r >= fromM.r0 && r <= fromM.r1 && c >= fromM.c0 && c <= fromM.c1) {
    if (dr > 0) r = g.rows.find((x) => x > fromM.r1) ?? r;
    else if (dr < 0) { let cand = null; for (const x of g.rows) { if (x < fromM.r0) cand = x; else break; } r = cand ?? r; }
    if (dc > 0) c = Math.min(g.sheet.colCount - 1, fromM.c1 + 1);
    else if (dc < 0) c = Math.max(0, fromM.c0 - 1);
  }
  if (extend) {
    g.sel.r1 = r; g.sel.c1 = c;
    paintSelection(g);
    repaintGrid(g);
    scrollCellIntoView(g, r, c);
  } else {
    setActive(g, r, c);
  }
}

// Ctrl+Arrow: jump to the edge of the current data block (Excel).
function dataEdge(g, from, dr, dc) {
  const sheet = g.sheet;
  const filled = (r, c) => {
    const cl = sheet.cells.get(cellKey(r, c));
    return !!(cl && ((cl.value != null && cl.value !== "") || cl.formula));
  };
  const inB = (r, c) => r >= 0 && c >= 0 && r < sheet.rowCount && c < sheet.colCount;
  let { r, c } = from;
  let nr = r + dr, nc = c + dc;
  if (!inB(nr, nc)) return { r, c };
  if (filled(r, c) && filled(nr, nc)) {
    while (inB(nr + dr, nc + dc) && filled(nr + dr, nc + dc)) { nr += dr; nc += dc; }
    return { r: nr, c: nc };
  }
  while (inB(nr, nc) && !filled(nr, nc)) { nr += dr; nc += dc; }
  if (inB(nr, nc)) return { r: nr, c: nc };
  // nothing ahead: go to the sheet edge
  return {
    r: dr < 0 ? 0 : dr > 0 ? sheet.rowCount - 1 : r,
    c: dc < 0 ? 0 : dc > 0 ? sheet.colCount - 1 : c,
  };
}

function selRect(g) {
  return {
    r0: Math.min(g.sel.r0, g.sel.r1), r1: Math.max(g.sel.r0, g.sel.r1),
    c0: Math.min(g.sel.c0, g.sel.c1), c1: Math.max(g.sel.c0, g.sel.c1),
  };
}

// rows in the selection that are actually visible under the filter
function selVisibleRows(g) {
  const { r0, r1 } = selRect(g);
  return g.rows.filter((r) => r >= r0 && r <= r1);
}

// ─── Central mutation (undo/redo + persistence + recalc) ───────────────────

function cloneCell(cell) {
  // carries computed/err so clipboard snapshots can paste-as-values;
  // every write path re-nulls them before storing into the cell map
  return cell ? { value: cell.value, formula: cell.formula, type: cell.type, computed: cell.computed ?? null, err: cell.err ?? null, format: cell.format ? { ...cell.format } : {} } : null;
}

function setCells(g, changes, opts) {
  // changes: [{ r, c, cell: {value, formula, format, type} | null }]
  if (!WB.canEdit || !changes.length) return;
  const sheet = g.sheet;
  const applied = [];
  for (const ch of changes) {
    if (ch.r < 0 || ch.c < 0 || ch.r >= sheet.rowCount || ch.c >= sheet.colCount) continue;
    const key = cellKey(ch.r, ch.c);
    const prev = cloneCell(sheet.cells.get(key));
    const next = ch.cell ? { ...ch.cell, computed: null, err: null } : null;
    if (next) sheet.cells.set(key, next);
    else sheet.cells.delete(key);
    applied.push({ r: ch.r, c: ch.c, prev, next: cloneCell(next), key });
  }
  if (!applied.length) return;
  if (!opts || opts.undoable !== false) {
    g.undo.push({ changes: applied });
    if (g.undo.length > 100) g.undo.shift();
    g.redo = [];
  }
  recalcWithSiblings(sheet);
  markCellsDirty(sheet, applied.map((a) => a.key));
  queueCellActivity(sheet, applied.map((a) => ({
    r: a.r, c: a.c,
    prev: a.prev ? (a.prev.formula || a.prev.value) : null,
    next: a.next ? (a.next.formula || a.next.value) : null,
  })));
  if (g.filters.size) computeGeometry(g);
  repaintGrid(g);
  syncFormulaBar(g);
  scheduleChartRender(g);
}

function undoGrid(g) {
  const op = g.undo.pop();
  if (!op) return;
  const sheet = g.sheet;
  const inverse = [];
  for (const ch of op.changes) {
    inverse.push({ r: ch.r, c: ch.c, prev: cloneCell(sheet.cells.get(ch.key)), next: ch.prev, key: ch.key });
    if (ch.prev) sheet.cells.set(ch.key, { ...ch.prev, computed: null, err: null });
    else sheet.cells.delete(ch.key);
  }
  g.redo.push(op);
  recalcWithSiblings(sheet);
  markCellsDirty(sheet, op.changes.map((c) => c.key));
  if (g.filters.size) computeGeometry(g);
  repaintGrid(g);
  syncFormulaBar(g);
  scheduleChartRender(g);
}

function redoGrid(g) {
  const op = g.redo.pop();
  if (!op) return;
  const sheet = g.sheet;
  for (const ch of op.changes) {
    if (ch.next) sheet.cells.set(ch.key, { ...ch.next, computed: null, err: null });
    else sheet.cells.delete(ch.key);
  }
  g.undo.push(op);
  recalcWithSiblings(sheet);
  markCellsDirty(sheet, op.changes.map((c) => c.key));
  if (g.filters.size) computeGeometry(g);
  repaintGrid(g);
  syncFormulaBar(g);
  scheduleChartRender(g);
}

// Parse raw user input into a cell object (or null for empty).
function cellFromInput(raw, prevCell) {
  const s = String(raw ?? "");
  const keepFormat = prevCell && prevCell.format ? { ...prevCell.format } : {};
  if (s.trim() === "" || s.trim() === "=") {
    return Object.keys(keepFormat).length ? { value: null, formula: null, type: null, format: keepFormat } : null;
  }
  if (s.startsWith("=")) {
    let f = s;
    // "=A1:A6" alone means "add these up" to every operator — wrap the
    // bare range in SUM instead of erroring with #VALUE.
    try { const ast = parseFormula(f); if (ast.k === "range") f = "=SUM(" + f.slice(1).trim() + ")"; } catch (_) {}
    return { value: null, formula: f, type: "formula", format: keepFormat };
  }
  return { value: s, formula: null, type: detectType(s).type, format: keepFormat };
}

// ─── Editing ─────────────────────────────────────────────────────────────────

function startEdit(g, r, c, initial) {
  if (!WB.canEdit) return;
  cancelEdit(g);
  const sheet = g.sheet;
  const di = dispIndexOfRow(g, r);
  if (di < 0) return;
  const cell = sheet.cells.get(cellKey(r, c));
  const input = document.createElement("input");
  input.type = "text";
  input.className = "wb-cell-editor";
  input.setAttribute("aria-label", `Edit cell ${colLabel(c)}${r + 1}`);
  input.value = initial != null ? initial : cell ? (cell.formula || (cell.value ?? "")) : "";
  const am = mergeAt(sheet, r, c);
  const px = am ? mergePixelRect(g, am) : null;
  const x = px ? px.x : g.colX[c], y = px ? px.y : g.rowY[di];
  input.style.left = x + "px";
  input.style.top = y + "px";
  input.style.width = Math.max(px ? px.w : g.colX[c + 1] - x, 60) + "px";
  input.style.height = (px ? px.h : g.rowY[di + 1] - y) + "px";
  g.els.canvas.appendChild(input);
  // type-to-replace passes the first typed char as `initial` — that
  // always counts as a change, so orig must NOT equal the seeded value
  // enterMode = Excel's type-to-replace state: arrow keys commit + move
  g.editing = { r, c, input, orig: initial != null ? "\u0000" : input.value, enterMode: initial != null, point: null, pointRC: null, pointAnchor: null };
  input.focus();
  if (initial != null) input.setSelectionRange(input.value.length, input.value.length);
  else input.select();
  syncFormulaBar(g);
  paintFormulaRefs(g);

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    const ed2 = g.editing;
    if (e.key === "Tab" && g.els.fxpop && !g.els.fxpop.hidden && g.fxWord) {
      e.preventDefault();
      const first = g.els.fxpop.querySelector("[data-fx]");
      if (first) acceptFx(g, first.getAttribute("data-fx"));
      return;
    }
    if (e.key.startsWith("Arrow") && ed2) {
      const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      const st = formulaPointState(g);
      if (st && dir) {
        // Excel point mode: arrows write/adjust a cell reference
        e.preventDefault();
        let rc = ed2.pointRC || { r: ed2.r, c: ed2.c };
        rc = { r: Math.max(0, Math.min(g.sheet.rowCount - 1, rc.r + dir[0])), c: Math.max(0, Math.min(g.sheet.colCount - 1, rc.c + dir[1])) };
        let text;
        if (e.shiftKey && ed2.pointAnchor) {
          const anch = ed2.pointAnchor;
          const rr0 = Math.min(anch.r, rc.r), rr1 = Math.max(anch.r, rc.r);
          const cc0 = Math.min(anch.c, rc.c), cc1 = Math.max(anch.c, rc.c);
          text = colLabel(cc0) + (rr0 + 1) + ":" + colLabel(cc1) + (rr1 + 1);
        } else {
          ed2.pointAnchor = rc;
          text = colLabel(rc.c) + (rc.r + 1);
        }
        ed2.pointRC = rc;
        insertPointRef(g, st, text);
        return;
      }
      if (dir && ed2.enterMode) {
        // Excel enter mode: arrows commit the value and move
        e.preventDefault();
        commitEdit(g, dir[0], dir[1]);
        return;
      }
      return; // edit mode: arrows move the caret
    }
    if (e.key === "Enter") { e.preventDefault(); commitEdit(g, e.shiftKey ? -1 : 1, 0); }
    else if (e.key === "Tab") { e.preventDefault(); commitEdit(g, 0, e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (g.els.fxpop && !g.els.fxpop.hidden) { g.els.fxpop.hidden = true; g.fxWord = null; return; }
      cancelEdit(g);
      g.els.grid.focus();
    }
  });
  input.addEventListener("input", () => {
    const ed2 = g.editing;
    if (ed2) { ed2.point = null; ed2.pointRC = null; ed2.pointAnchor = null; ed2.enterMode = false; }
    if (g.els.fbarInput && document.activeElement !== g.els.fbarInput) g.els.fbarInput.value = input.value;
    updateFxPop(g);
    paintFormulaRefs(g);
  });
  input.addEventListener("blur", () => {
    // commit on outside click (unless we already committed/cancelled)
    setTimeout(() => { if (g.editing && g.editing.input === input) commitEdit(g, 0, 0, { refocus: false }); }, 0);
  });
}

function commitEdit(g, dr, dc, opts) {
  const ed = g.editing;
  if (!ed) return;
  g.editing = null;
  clearFormulaChrome(g);
  const raw = ed.input.value;
  ed.input.remove();
  if (raw !== ed.orig) {
    const prev = g.sheet.cells.get(cellKey(ed.r, ed.c));
    const nextCell = cellFromInput(raw, prev);
    const v = validateCommit(g.sheet, ed.r, ed.c, nextCell);
    if (!v.ok && v.strict) {
      _toast(v.msg, "error");
      // re-open the editor so the entry can be fixed — except on blur,
      // where fighting for focus would be worse than reverting
      if (!opts || opts.refocus !== false) { startEdit(g, ed.r, ed.c, raw); return; }
      paintSelection(g);
      syncFormulaBar(g);
      return;
    }
    if (!v.ok) _toast(v.msg, "warn");
    setCells(g, [{ r: ed.r, c: ed.c, cell: nextCell }]);
  }
  if (!opts || opts.refocus !== false) g.els.grid.focus();
  if (dr || dc) moveActive(g, dr, dc, false);
  else { paintSelection(g); syncFormulaBar(g); }
}

function cancelEdit(g) {
  const ed = g.editing;
  if (!ed) return;
  g.editing = null;
  clearFormulaChrome(g);
  if (ed.input) ed.input.remove();
  syncFormulaBar(g);
}

// ─── Formula bar ─────────────────────────────────────────────────────────────

function syncFormulaBar(g) {
  const { r, c } = g.active;
  if (g.els.fbarRef) {
    const refText = colLabel(c) + (r + 1);
    if (g.els.fbarRef.tagName === "INPUT") { if (document.activeElement !== g.els.fbarRef) g.els.fbarRef.value = refText; }
    else g.els.fbarRef.textContent = refText;
  }
  const cell = g.sheet.cells.get(cellKey(r, c));
  if (g.els.fbarInput && document.activeElement !== g.els.fbarInput) {
    g.els.fbarInput.value = g.xedit ? g.xedit.value
      : g.editing && g.editing.input ? g.editing.input.value
      : cell ? (cell.formula || (cell.value ?? "")) : "";
  }
  syncFontControls(g);
  if (g.els.fbarErr) {
    if (cell && cell.err) {
      g.els.fbarErr.hidden = false;
      g.els.fbarErr.textContent = cell.err + (cell.err === "#CIRCULAR" ? " · circular reference" : cell.err === "#DIV/0" ? " · division by zero" : cell.err === "#N/A" ? " · no match found" : cell.err === "#REF" ? " · broken reference" : cell.err === "#NUM" ? " · number out of range" : cell.err === "#NAME" ? " · unknown name" : cell.err === "#VALUE" ? " · wrong kind of value" : "");
    } else g.els.fbarErr.hidden = true;
  }
}

// ─── Clipboard ───────────────────────────────────────────────────────────────

function selectionToTsv(g) {
  const { r0, r1, c0, c1 } = selRect(g);
  const sheet = g.sheet;
  const lines = [];
  for (let r = r0; r <= r1; r++) {
    const parts = [];
    for (let c = c0; c <= c1; c++) {
      const cell = sheet.cells.get(cellKey(r, c));
      let v = cell ? (cell.formula ? (cell.err || String(cell.computed ?? "")) : String(cell.value ?? "")) : "";
      if (/[\t\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
      parts.push(v);
    }
    lines.push(parts.join("\t"));
  }
  return lines.join("\n");
}

// Rich internal clipboard: cell objects (formulas + formats) plus the
// TSV text mirror. On paste, if the system clipboard text still matches
// the mirror, the rich cells win and formulas rewrite Excel-style.
function captureClipboard(g, mode) {
  const { r0, r1, c0, c1 } = selRect(g);
  const rows = [];
  for (let r = r0; r <= r1; r++) {
    const line = [];
    for (let c = c0; c <= c1; c++) line.push(cloneCell(g.sheet.cells.get(cellKey(r, c))));
    rows.push(line);
  }
  WB.clipboard = { mode: mode || "copy", sheetId: g.sheet.id, r0, c0, rows, text: selectionToTsv(g) };
}

async function copySelection(g, mode) {
  captureClipboard(g, mode);
  const tsv = WB.clipboard.text;
  try { await navigator.clipboard.writeText(tsv); }
  catch (_) {
    const ta = document.createElement("textarea");
    ta.value = tsv;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }
}

function parseClipboardMatrix(text) {
  // TSV with quoted fields (Excel / Sheets export shape); falls back to
  // a single column of lines when no tabs are present.
  const rows = [];
  let row = [], field = "", inQ = false;
  const s = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
      continue;
    }
    if (ch === '"' && field === "") { inQ = true; continue; }
    if (ch === "\t") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

function pasteMatrix(g, matrix) {
  if (!matrix.length || !WB.canEdit) return;
  const sheet = g.sheet;
  const { r0, c0, r1, c1 } = selRect(g);
  const changes = [];
  const single = matrix.length === 1 && matrix[0].length === 1;
  if (single && (r1 > r0 || c1 > c0)) {
    // one value pasted onto a range → fill the range
    const raw = matrix[0][0];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      changes.push({ r, c, cell: cellFromInput(raw, sheet.cells.get(cellKey(r, c))) });
    }
  } else {
    const maxR = Math.min(sheet.rowCount - 1, g.active.r + matrix.length - 1);
    for (let r = g.active.r; r <= maxR; r++) {
      const line = matrix[r - g.active.r];
      const maxC = Math.min(sheet.colCount - 1, g.active.c + line.length - 1);
      for (let c = g.active.c; c <= maxC; c++) {
        changes.push({ r, c, cell: cellFromInput(line[c - g.active.c], sheet.cells.get(cellKey(r, c))) });
      }
    }
    const clippedR = matrix.length - (maxR - g.active.r + 1);
    if (clippedR > 0) _toast(`Paste clipped: ${clippedR} row${clippedR === 1 ? "" : "s"} didn't fit the sheet`, "warn");
  }
  setCells(g, changes);
}

async function pasteFromClipboard(g) {
  // menu/context-menu paste: reach for an image first when the clipboard
  // holds one without text (same precedence as the native paste path)
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const t = (item.types || []).find((x) => /^image\//.test(x));
        if (t && !(item.types || []).includes("text/plain")) {
          const blob = await item.getType(t);
          await insertImageFile(g, new File([blob], "pasted-image", { type: t }));
          return;
        }
      }
    }
  } catch (_) { /* fall through to the text path */ }
  try {
    const text = await navigator.clipboard.readText();
    if (text) pasteAt(g, text);
    else if (WB.clipboard && WB.clipboard.rows.length && WB.clipboard.text === "") pasteRich(g, WB.clipboard);
  } catch (_) {
    _toast("Press Ctrl+V to paste (clipboard access was blocked)", "info");
  }
}

// Route a paste: if the system clipboard still holds our own copy, use
// the rich cells (formulas rewrite); otherwise parse as external TSV.
function pasteAt(g, text) {
  const cb = WB.clipboard;
  if (cb && cb.rows.length && text !== "" && cb.text === text) return pasteRich(g, cb);
  pasteMatrix(g, parseClipboardMatrix(text));
}

// The concrete value a "paste values only" writes for a source cell —
// a formula contributes its computed result (or error text).
function pasteValueParts(srcCell) {
  if (!srcCell) return { value: "", type: null };
  if (srcCell.formula) {
    const v = srcCell.err ? srcCell.err : srcCell.computed;
    return { value: v == null ? "" : String(v), type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : srcCell.type || null };
  }
  return { value: srcCell.value ?? "", type: srcCell.type || null };
}

// Build the target cell for one source/target pair under a paste-special
// mode. opts: { values | formats | formulas } (default = everything).
function buildPasteCell(srcCell, targetOld, opts, dr, dc, cutMode) {
  if (opts.formats) {
    const fmt = srcCell && srcCell.format && Object.keys(srcCell.format).length ? { ...srcCell.format } : null;
    if (!targetOld && !fmt) return null;
    const base = targetOld ? cloneCell(targetOld) : { value: "", formula: null, type: null, computed: null, err: null, format: {} };
    base.format = fmt || {};
    return base;
  }
  if (opts.values) {
    const { value, type } = pasteValueParts(srcCell);
    if (value === "" && !targetOld) return null;
    const base = targetOld ? cloneCell(targetOld) : { value: "", formula: null, type: null, computed: null, err: null, format: {} };
    base.value = value; base.type = type; base.formula = null; base.computed = null; base.err = null;
    return base; // keeps the target's existing format
  }
  if (!srcCell) return null;
  const base = cloneCell(srcCell);
  if (opts.formulas) base.format = {}; // formulas/content, drop formatting
  if (base.formula && cutMode !== "cut") base.formula = shiftFormulaRelative(base.formula, dr, dc);
  return base;
}

function pasteRich(g, cb, opts) {
  if (!WB.canEdit) return;
  opts = opts || {};
  const transpose = !!opts.transpose;
  const sheet = g.sheet;
  const sel = selRect(g);
  const srcR = cb.rows.length, srcC = cb.rows[0].length;
  const outR = transpose ? srcC : srcR, outC = transpose ? srcR : srcC;
  const selR = sel.r1 - sel.r0 + 1, selC = sel.c1 - sel.c0 + 1;
  // Excel tiling: repeat the block when the target is an exact multiple
  // (transpose pastes once — tiling a transposed block is confusing)
  const repR = !transpose && selR > 1 && selR % outR === 0 ? selR / outR : 1;
  const repC = !transpose && selC > 1 && selC % outC === 0 ? selC / outC : 1;
  const changes = [];
  const covered = new Set();
  for (let br = 0; br < repR; br++) for (let bc = 0; bc < repC; bc++) {
    for (let i = 0; i < srcR; i++) for (let j = 0; j < srcC; j++) {
      const oi = transpose ? j : i, oj = transpose ? i : j;
      const tr = sel.r0 + br * outR + oi, tc = sel.c0 + bc * outC + oj;
      if (tr >= sheet.rowCount || tc >= sheet.colCount) continue;
      const srcCell = cb.rows[i][j];
      const targetOld = sheet.cells.get(cellKey(tr, tc));
      const next = buildPasteCell(srcCell, targetOld, opts, tr - (cb.r0 + i), tc - (cb.c0 + j), cb.mode);
      changes.push({ r: tr, c: tc, cell: next });
      covered.add(cellKey(tr, tc));
    }
  }
  if (cb.mode === "cut" && !opts.values && !opts.formats && !opts.formulas) {
    if (cb.sheetId === sheet.id) {
      for (let i = 0; i < srcR; i++) for (let j = 0; j < srcC; j++) {
        const sr = cb.r0 + i, sc = cb.c0 + j;
        if (!covered.has(cellKey(sr, sc))) changes.push({ r: sr, c: sc, cell: null });
      }
    }
    cb.mode = "copy"; // a cut pastes once; further pastes behave as copy
  }
  setCells(g, changes);
  g.sel = { r0: sel.r0, c0: sel.c0, r1: Math.min(sheet.rowCount - 1, sel.r0 + repR * outR - 1), c1: Math.min(sheet.colCount - 1, sel.c0 + repC * outC - 1) };
  g.active = { r: sel.r0, c: sel.c0 };
  paintSelection(g);
}

// Paste-special entry point: reads our own rich clipboard and applies the
// chosen subset. External (system-clipboard-only) copies fall back to a
// values paste since we don't hold their formulas/formats.
function pasteSpecial(g, mode) {
  if (!WB.canEdit) return;
  const cb = WB.clipboard;
  if (!cb || !cb.rows || !cb.rows.length) { _toast("Copy a range first, then Paste special", "info"); return; }
  const opts = mode === "values" ? { values: true }
    : mode === "formats" ? { formats: true }
    : mode === "formulas" ? { formulas: true }
    : mode === "transpose" ? { transpose: true }
    : {};
  pasteRich(g, cb, opts);
}

// ── Cell images (paste a screenshot, click to enlarge — Quip-style) ──

const WB_IMG_MAX_CHARS = 480000; // ~350KB of pixels; cells persist as jsonb rows

// Encode a pasted/picked image as a bounded data URL. Small originals
// keep their exact bytes (GIFs keep animating); everything else is
// redrawn through a canvas, stepping the bounding box down until the
// payload fits.
async function wbEncodeImage(file) {
  if (file.size <= 220000 && /^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    const direct = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ""));
      fr.onerror = () => rej(fr.error || new Error("read failed"));
      fr.readAsDataURL(file);
    });
    if (WB_IMG_RE.test(direct)) return direct;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("bad image"));
      im.src = url;
    });
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;
    for (const maxDim of [1000, 720, 520, 360, 240]) {
      const k = Math.min(1, maxDim / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      let out = cv.toDataURL("image/webp", 0.82);
      if (!out.startsWith("data:image/webp")) {
        // no webp encoder: jpeg on a white ground (drops transparency)
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        out = cv.toDataURL("image/jpeg", 0.85);
      }
      if (out.length <= WB_IMG_MAX_CHARS) return out;
    }
    return null;
  } finally { URL.revokeObjectURL(url); }
}

async function insertImageFile(g, file) {
  if (!WB.canEdit || !file) return;
  const { r, c } = g.active;
  let src = null;
  try { src = await wbEncodeImage(file); } catch (_) { src = null; }
  if (!src || !WB_IMG_RE.test(src)) { _toast("Couldn't read that image", "error"); return; }
  const sheet = g.sheet;
  const prev = sheet.cells.get(cellKey(r, c));
  const cell = prev ? cloneCell(prev) : { value: null, formula: null, type: null, format: {} };
  cell.format = { ...(cell.format || {}), img: src };
  setCells(g, [{ r, c, cell }]);
  // give the image room to read as a thumbnail, once, without shrinking
  // rows the user already made taller
  if (rowH(sheet, r) < 76) {
    sheet.rowHeights[r] = 76;
    computeGeometry(g);
    repaintGrid(g);
    saveSheetMeta(sheet.id);
  }
}

function pickImageInto(g) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    if (f) insertImageFile(g, f);
  });
  inp.click();
}

function removeCellImage(g, r, c) {
  const cell = g.sheet.cells.get(cellKey(r, c));
  if (!cell || !cell.format || !cell.format.img) return;
  const next = cloneCell(cell);
  delete next.format.img;
  const empty = next.value == null && !next.formula && !Object.keys(next.format).length;
  setCells(g, [{ r, c, cell: empty ? null : next }]);
}

// ── Drag-move: grab the selection border and drop the cells elsewhere ──

// True when p (content px) sits in the grab band around the selection's
// edge — just inside the border, plus a hair outside (Excel's move zone).
function selBorderHit(g, p) {
  const { r0, c0, r1, c1 } = selRect(g);
  const di0 = dispIndexOfRow(g, r0), di1 = dispIndexOfRow(g, r1);
  if (di0 < 0 || di1 < 0) return false;
  const x = g.colX[c0], x2 = g.colX[c1 + 1];
  const y = g.rowY[di0], y2 = g.rowY[di1 + 1];
  const inOuter = p.x >= x - 2 && p.x <= x2 + 2 && p.y >= y - 2 && p.y <= y2 + 2;
  if (!inOuter) return false;
  const inInner = p.x >= x + 5 && p.x <= x2 - 5 && p.y >= y + 5 && p.y <= y2 - 5;
  return !inInner;
}

function rectIntersectsMerge(sheet, r0, c0, r1, c1) {
  return sheetMerges(sheet).some((m) => m.r0 <= r1 && m.r1 >= r0 && m.c0 <= c1 && m.c1 >= c0);
}

// Change list for relocating src by (dr, dc). Destination writes come
// from a snapshot taken up front, so overlapping moves are safe. Move
// keeps formulas verbatim (Excel cut semantics); copy shifts relative
// refs. Returns null when the destination falls outside the sheet.
function planMoveChanges(sheet, src, dr, dc, copy) {
  const nR = src.r1 - src.r0 + 1, nC = src.c1 - src.c0 + 1;
  const dstR0 = src.r0 + dr, dstC0 = src.c0 + dc;
  if (dstR0 < 0 || dstC0 < 0 || dstR0 + nR > sheet.rowCount || dstC0 + nC > sheet.colCount) return null;
  if (!dr && !dc) return [];
  const changes = [];
  const dstKeys = new Set();
  for (let i = 0; i < nR; i++) for (let j = 0; j < nC; j++) {
    const srcCell = cloneCell(sheet.cells.get(cellKey(src.r0 + i, src.c0 + j)));
    const next = srcCell && srcCell.formula && copy
      ? { ...srcCell, formula: shiftFormulaRelative(srcCell.formula, dr, dc) }
      : srcCell;
    changes.push({ r: dstR0 + i, c: dstC0 + j, cell: next });
    dstKeys.add(cellKey(dstR0 + i, dstC0 + j));
  }
  if (!copy) {
    for (let i = 0; i < nR; i++) for (let j = 0; j < nC; j++) {
      const key = cellKey(src.r0 + i, src.c0 + j);
      if (!dstKeys.has(key)) changes.push({ r: src.r0 + i, c: src.c0 + j, cell: null });
    }
  }
  return changes;
}

function startMoveDrag(g, e0, src, canvasPos) {
  const sheet = g.sheet;
  const nR = src.r1 - src.r0 + 1, nC = src.c1 - src.c0 + 1;
  const start = canvasPos(e0);
  const grabR = (g.rows[dispRowAt(g, start.y)] ?? src.r0) - src.r0;
  const grabC = colAt(g, start.x) - src.c0;
  const preview = document.createElement("div");
  preview.className = "wb-move-preview";
  preview.innerHTML = `<span class="wb-move-badge"></span>`;
  g.els.sel.appendChild(preview);
  const badge = preview.firstChild;
  let dst = { r0: src.r0, c0: src.c0 };
  let copy = e0.ctrlKey || e0.metaKey || e0.altKey;
  let canceled = false;
  g.moveDrag = true;
  const paint = () => {
    const di = dispIndexOfRow(g, dst.r0);
    const x = g.colX[dst.c0], x2 = g.colX[dst.c0 + nC];
    const y = g.rowY[di], y2 = g.rowY[di + nR];
    preview.style.left = x + "px";
    preview.style.top = y + "px";
    preview.style.width = (x2 - x) + "px";
    preview.style.height = (y2 - y) + "px";
    const ref = nR === 1 && nC === 1
      ? cellRef(dst.r0, dst.c0)
      : `${cellRef(dst.r0, dst.c0)}:${cellRef(dst.r0 + nR - 1, dst.c0 + nC - 1)}`;
    badge.textContent = (copy ? "+ " : "") + ref;
  };
  paint();
  const onMove = (ev) => {
    copy = ev.ctrlKey || ev.metaKey || ev.altKey;
    // edge auto-scroll keeps long moves reachable
    const rect = g.els.scroll.getBoundingClientRect();
    if (ev.clientY > rect.bottom - 24) g.els.scroll.scrollTop += 18;
    else if (ev.clientY < rect.top + 24) g.els.scroll.scrollTop -= 18;
    if (ev.clientX > rect.right - 24) g.els.scroll.scrollLeft += 18;
    else if (ev.clientX < rect.left + 24) g.els.scroll.scrollLeft -= 18;
    const p = canvasPos(ev);
    const r = g.rows[dispRowAt(g, p.y)] ?? dst.r0 + grabR;
    const c = colAt(g, p.x);
    dst = {
      r0: Math.max(0, Math.min(sheet.rowCount - nR, r - grabR)),
      c0: Math.max(0, Math.min(sheet.colCount - nC, c - grabC)),
    };
    paint();
  };
  const finish = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("keydown", onKey, true);
    preview.remove();
    g.moveDrag = false;
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); canceled = true; finish(); }
  };
  const onUp = () => {
    finish();
    const dr = dst.r0 - src.r0, dc = dst.c0 - src.c0;
    if (canceled || (!dr && !dc)) return;
    if (rectIntersectsMerge(sheet, dst.r0, dst.c0, dst.r0 + nR - 1, dst.c0 + nC - 1)) {
      _toast("Can't drop onto merged cells — unmerge them first", "warn");
      return;
    }
    const changes = planMoveChanges(sheet, src, dr, dc, copy);
    if (!changes || !changes.length) return;
    setCells(g, changes);
    g.sel = { r0: dst.r0, c0: dst.c0, r1: dst.r0 + nR - 1, c1: dst.c0 + nC - 1 };
    g.active = { r: dst.r0 + (g.active.r - src.r0), c: dst.c0 + (g.active.c - src.c0) };
    paintSelection(g);
    syncFormulaBar(g);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("keydown", onKey, true);
}

// Quip-style lightbox: dimmed backdrop, the image large in the middle,
// click anywhere or Esc to dismiss. src must already be WB_IMG_RE-clean.
function openImageLightbox(src) {
  document.querySelectorAll(".wb-imgbox").forEach((b) => b.remove());
  closeAllPopovers();
  const box = document.createElement("div");
  box.className = "wb-imgbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Image preview");
  box.innerHTML = `<img src="${src}" alt="Workbook image"><div class="wb-imgbox-hint">Click anywhere or press Esc to close</div>`;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const close = () => { document.removeEventListener("keydown", onKey, true); box.remove(); };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(box);
}

function clearSelection(g, { formatToo } = {}) {
  const sheet = g.sheet;
  const { c0, c1 } = selRect(g);
  const changes = [];
  for (const r of selVisibleRows(g)) {
    for (let c = c0; c <= c1; c++) {
      const cell = sheet.cells.get(cellKey(r, c));
      if (!cell) continue;
      if (formatToo) changes.push({ r, c, cell: null });
      else changes.push({ r, c, cell: cellFromInput("", cell) });
    }
  }
  if (changes.length) setCells(g, changes);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatSelection(g, patch) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const { c0, c1 } = selRect(g);
  const changes = [];
  for (const r of selVisibleRows(g)) {
    for (let c = c0; c <= c1; c++) {
      const cell = sheet.cells.get(cellKey(r, c));
      const base = cell ? cloneCell(cell) : { value: null, formula: null, type: null, format: {} };
      const fmt = { ...base.format };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === false) delete fmt[k];
        else fmt[k] = v;
      }
      if (!cell && !Object.keys(fmt).length) continue;
      changes.push({ r, c, cell: { ...base, format: fmt } });
    }
  }
  if (changes.length) setCells(g, changes);
}

function toggleFormat(g, key) {
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  const on = cell && cell.format && cell.format[key];
  formatSelection(g, { [key]: on ? null : true });
}

function clearFormatting(g) {
  const sheet = g.sheet;
  const { c0, c1 } = selRect(g);
  const changes = [];
  for (const r of selVisibleRows(g)) {
    for (let c = c0; c <= c1; c++) {
      const cell = sheet.cells.get(cellKey(r, c));
      if (!cell || !cell.format || !Object.keys(cell.format).length) continue;
      const base = cloneCell(cell);
      base.format = {};
      changes.push({ r, c, cell: base.value == null && base.formula == null ? null : base });
    }
  }
  if (changes.length) setCells(g, changes);
}

// ─── Row / column structure ─────────────────────────────────────────────────
// Insert/delete shift the sparse map and rewrite cell references inside
// formulas (refs on a deleted row/col become #REF, matching spreadsheet
// convention). One undo entry captures the whole reshape.

const CELLREF_TOKEN = /(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/g;

function shiftFormulaRefs(formula, axis, index, delta) {
  // Structural insert/delete on THIS sheet: refs at/after the index
  // move (anchored or not — structure moved under them); refs into
  // other sheets are untouched; refs to a deleted row/col become #REF.
  return rewriteRefs(formula, (ref) => {
    if (ref.sheet) return null;
    const cut = delta < 0 ? -delta : 0;
    let { row, col } = ref;
    if (axis === "row") {
      if (delta < 0 && row >= index && row < index + cut) return "#REF";
      if (row >= index + cut) row += delta;
      else if (delta > 0 && row >= index) row += delta;
    } else {
      if (delta < 0 && col >= index && col < index + cut) return "#REF";
      if (col >= index + cut) col += delta;
      else if (delta > 0 && col >= index) col += delta;
    }
    if (row < 0 || col < 0) return "#REF";
    return (ref.colAbs ? "$" : "") + colLabel(col) + (ref.rowAbs ? "$" : "") + (row + 1);
  });
}

function restructure(g, axis, index, delta) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  if (axis === "row" && delta < 0 && sheet.rowCount <= 1) return;
  if (axis === "col" && delta < 0 && sheet.colCount <= 1) return;
  cancelEdit(g);
  const oldCells = sheet.cells;
  const next = new Map();
  const changes = []; // for undo: record every key that differs
  const touched = new Set();
  for (const [key, cell] of oldCells) {
    const { r, c } = keyRC(key);
    let nr = r, nc = c;
    const cut = delta < 0 ? -delta : 0; // width of the deleted band
    if (axis === "row") {
      if (delta < 0 && r >= index && r < index + cut) { changes.push({ r, c, prevCell: cloneCell(cell), nextCell: null }); touched.add(key); continue; }
      if (r >= index + cut) nr = r + delta;
      else if (delta > 0 && r >= index) nr = r + delta;
    } else {
      if (delta < 0 && c >= index && c < index + cut) { changes.push({ r, c, prevCell: cloneCell(cell), nextCell: null }); touched.add(key); continue; }
      if (c >= index + cut) nc = c + delta;
      else if (delta > 0 && c >= index) nc = c + delta;
    }
    const moved = nr !== r || nc !== c;
    const newCell = { ...cloneCell(cell), computed: null, err: null };
    if (newCell.formula) {
      const shifted = shiftFormulaRefs(newCell.formula, axis, index, delta);
      if (shifted !== newCell.formula) newCell.formula = shifted;
    }
    next.set(cellKey(nr, nc), newCell);
    if (moved || newCell.formula !== cell.formula) {
      changes.push({ r, c, prevCell: cloneCell(cell), nextCell: null });          // old slot cleared
      changes.push({ r: nr, c: nc, prevCell: cloneCell(oldCells.get(cellKey(nr, nc))), nextCell: cloneCell(newCell) });
      touched.add(key);
      touched.add(cellKey(nr, nc));
    }
  }
  sheet.cells = next;
  if (axis === "row") {
    sheet.rowCount = Math.max(1, sheet.rowCount + delta);
    sheet.rowHeights = shiftIndexMap(sheet.rowHeights, index, delta);
    sheet.hiddenRows = shiftIndexSet(sheet.hiddenRows, index, delta);
  } else {
    sheet.colCount = Math.max(1, sheet.colCount + delta);
    sheet.colWidths = shiftIndexMap(sheet.colWidths, index, delta);
    sheet.hiddenCols = shiftIndexSet(sheet.hiddenCols, index, delta);
  }
  shiftRuleRanges(sheet, axis, index, delta);
  // undo entry (bespoke: restores both maps' touched keys)
  g.undo.push({ changes: changes.map((ch) => ({ r: ch.r, c: ch.c, key: cellKey(ch.r, ch.c), prev: ch.prevCell, next: ch.nextCell })) });
  if (g.undo.length > 100) g.undo.shift();
  g.redo = [];
  recalcWithSiblings(sheet);
  markCellsDirty(sheet, [...touched]);
  queueCellActivity(sheet, [{ r: index, c: 0, prev: null, next: null }]);
  wbLog("sheet.restructured", `${delta > 0 ? "inserted" : "deleted"} a ${axis === "row" ? "row" : "column"} ${axis === "row" ? "at row " + (index + 1) : "at column " + colLabel(index)} in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
  saveSheetMeta(sheet.id);
  const a = g.active;
  computeGeometry(g);
  setActive(g, Math.min(a.r, sheet.rowCount - 1), Math.min(a.c, sheet.colCount - 1));
  scheduleChartRender(g);
}

function shiftIndexMap(map, index, delta) {
  const cut = delta < 0 ? -delta : 0;
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const i = +k;
    if (delta < 0 && i >= index && i < index + cut) continue;
    out[i >= index + cut ? i + delta : delta > 0 && i >= index ? i + delta : i] = v;
  }
  return out;
}

function shiftIndexSet(set, index, delta) {
  const cut = delta < 0 ? -delta : 0;
  const out = new Set();
  for (const i of set || []) {
    if (delta < 0 && i >= index && i < index + cut) continue;
    out.add(i >= index + cut ? i + delta : delta > 0 && i >= index ? i + delta : i);
  }
  return out;
}

// ─── Sheet rules: data validation + conditional formatting ──────────────────
// Rules live in sheet.meta.validation / sheet.meta.condFormat (jsonb via
// migration 0414) as {id, r0, c0, r1, c1, ...} rectangles. The LAST rule
// covering a cell wins, so re-applying to a selection overrides without
// destroying larger overlapping rules.

function sheetRules(sheet, key) {
  const v = sheet.meta && sheet.meta[key];
  return Array.isArray(v) ? v : [];
}

function setSheetRules(g, key, rules) {
  g.sheet.meta = { ...(g.sheet.meta || {}), [key]: rules };
  saveSheetMeta(g.sheet.id);
  repaintGrid(g);
}

function ruleCovers(rule, r, c) {
  return r >= rule.r0 && r <= rule.r1 && c >= rule.c0 && c <= rule.c1;
}

function ruleRefText(rule) {
  return colLabel(rule.c0) + (rule.r0 + 1) + (rule.r1 !== rule.r0 || rule.c1 !== rule.c0 ? ":" + colLabel(rule.c1) + (rule.r1 + 1) : "");
}

function findValidationRule(sheet, r, c) {
  const rules = sheetRules(sheet, "validation");
  for (let i = rules.length - 1; i >= 0; i--) if (ruleCovers(rules[i], r, c)) return rules[i];
  return null;
}

// The color assigned to a dropdown option (rule.colors runs parallel to
// rule.list); null when the option is uncolored or unmatched.
function dvOptionColor(rule, value) {
  if (!rule || rule.type !== "list" || !Array.isArray(rule.colors)) return null;
  const s = String(value ?? "").trim().toLowerCase();
  const i = (rule.list || []).findIndex((o) => String(o).trim().toLowerCase() === s);
  const hex = i >= 0 ? rule.colors[i] : null;
  return hex && HEX_COLOR_RE.test(hex) ? hex : null;
}

// A date-ish value → Excel serial (numbers pass through as serials).
function dvDateSerial(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (s === "") return null;
  if (isFinite(Number(s))) return Number(s);
  const d = parseDateLoose(s);
  return d ? dateToSerial(d) : null;
}

// The options a list/range dropdown offers. A range source reads distinct,
// non-empty values from its cells (sheet-qualified refs and named ranges
// both resolve through the shared eval ctx).
function dvOptionList(rule, sheet) {
  if (rule.type === "range" && rule.source && sheet) {
    try {
      const ctx = cfEvalCtx(sheet);
      let node = parseFormula("=" + rule.source);
      if (node.k === "name") node = bindNames(node, ctx.names);
      if (node.k !== "range" && node.k !== "ref") return [];
      const grid = argGrid(node, ctx);
      const out = [], seen = new Set();
      for (const v of grid.flat()) {
        if (v == null || v === "") continue;
        const s = String(v);
        if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
      return out;
    } catch (_) { return []; }
  }
  return rule.list || [];
}

// Custom-formula validation: the formula is authored relative to the
// range's top-left cell; shift it to this cell and test truthiness.
function dvCustomHits(sheet, rule, r, c) {
  if (!rule.formula) return true;
  try {
    const shifted = shiftFormulaRelative(rule.formula, r - rule.r0, c - rule.c0);
    if (shifted.includes("#REF")) return false;
    let v = evalFormula(shifted, cfEvalCtx(sheet));
    if (v instanceof Arr) v = v.top();
    return truthy(v);
  } catch (_) { return false; }
}

function dvNumericCompare(op, x, a, b) {
  switch (op) {
    case "between": return x >= Math.min(a, b) && x <= Math.max(a, b);
    case ">": return x > a;
    case ">=": return x >= a;
    case "<": return x < a;
    case "<=": return x <= a;
    case "=": return x === a;
    default: return true;
  }
}

function valueSatisfiesRule(rule, raw, sheet, r, c) {
  if (raw == null || raw === "") return true;
  if (rule.type === "checkbox") { const s = String(raw).trim().toLowerCase(); return s === "true" || s === "false"; }
  if (rule.type === "list" || rule.type === "range") {
    const s = String(raw).trim().toLowerCase();
    return dvOptionList(rule, sheet).some((it) => String(it).trim().toLowerCase() === s);
  }
  if (rule.type === "custom") return dvCustomHits(sheet, rule, r, c);
  if (rule.type === "textlen") return dvNumericCompare(rule.op, String(raw).length, +rule.v1, +rule.v2);
  if (rule.type === "date") {
    const x = dvDateSerial(raw);
    if (x == null) return false;
    return dvNumericCompare(rule.op, x, dvDateSerial(rule.v1), dvDateSerial(rule.v2));
  }
  const x = cellNumeric(raw);
  if (x == null) return false;
  return dvNumericCompare(rule.op, x, +rule.v1, +rule.v2);
}

function validationMsg(rule) {
  if (rule.type === "list" || rule.type === "range") {
    const list = rule.type === "range" ? (rule.list || []) : (rule.list || []); // static hint list; range shows generic text
    if (rule.type === "range") return `Value must come from ${rule.source || "the source range"}`;
    const opts = list.slice(0, 6).join(", ");
    return `Value must be one of: ${opts}${list.length > 6 ? ", …" : ""}`;
  }
  if (rule.type === "checkbox") return "Value must be TRUE or FALSE";
  if (rule.type === "custom") return `Value must satisfy ${rule.formula || "the custom formula"}`;
  const opText = rule.op === "between" ? `between ${rule.v1} and ${rule.v2}` : `${rule.op} ${rule.v1}`;
  if (rule.type === "textlen") return `Text length must be ${opText}`;
  if (rule.type === "date") return `Date must be ${opText}`;
  return `Value must be a number ${opText}`;
}

// Enforced on typed commits only — paste and fill bypass validation,
// which matches Excel. Formula cells are never blocked; their results
// just get the red invalid marker if they violate the rule.
function validateCommit(sheet, r, c, cell) {
  const rule = findValidationRule(sheet, r, c);
  if (!rule || !cell || cell.formula || cell.value == null || cell.value === "") return { ok: true };
  if (valueSatisfiesRule(rule, cell.value, sheet, r, c)) return { ok: true };
  return { ok: false, strict: rule.mode !== "warn", msg: validationMsg(rule) };
}

function cellInvalid(sheet, r, c, cell) {
  if (!cell) return false;
  const rules = sheet.meta && sheet.meta.validation;
  if (!Array.isArray(rules) || !rules.length) return false;
  const rule = findValidationRule(sheet, r, c);
  if (!rule) return false;
  const raw = cell.formula ? (cell.err ? null : cell.computed) : cell.value;
  if (raw == null || raw === "") return false;
  return !valueSatisfiesRule(rule, raw, sheet, r, c);
}

const WB_CF_STYLES = {
  green: { bg: "rgba(22,163,74,.15)", fg: "#166534", label: "Green" },
  amber: { bg: "rgba(217,119,6,.16)", fg: "#92400E", label: "Amber" },
  red: { bg: "rgba(220,38,38,.14)", fg: "#B91C1C", label: "Red" },
  blue: { bg: "rgba(37,99,235,.13)", fg: "#1E40AF", label: "Blue" },
  violet: { bg: "rgba(124,58,237,.14)", fg: "#5B21B6", label: "Violet" },
  gray: { bg: "#E5E7EB", fg: "#374151", label: "Gray" },
};

const WB_CF_KINDS = {
  gt: "Greater than", lt: "Less than", between: "Between", eq: "Equal to",
  contains: "Text contains", notempty: "Is not empty", empty: "Is empty",
  formula: "Custom formula is",
};

// Color-scale presets (Google Sheets' default gradient colors). Two- or
// three-stop; the value's position between the range min and max picks a
// color by linear RGB interpolation.
const WB_CF_SCALES = {
  gyr: { label: "Green → Yellow → Red", stops: ["#57BB8A", "#FFD666", "#E67C73"] },
  ryg: { label: "Red → Yellow → Green", stops: ["#E67C73", "#FFD666", "#57BB8A"] },
  wg: { label: "White → Green", stops: ["#FFFFFF", "#57BB8A"] },
  wb: { label: "White → Blue", stops: ["#FFFFFF", "#6FA8DC"] },
  wr: { label: "White → Red", stops: ["#FFFFFF", "#E67C73"] },
};

function cfHexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function cfLerp(a, b, t) { return Math.round(a + (b - a) * t); }
function cfScaleColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const rgb = stops.map(cfHexToRgb);
  if (rgb.length === 2) { const [a, b] = rgb; return `rgb(${cfLerp(a[0], b[0], t)},${cfLerp(a[1], b[1], t)},${cfLerp(a[2], b[2], t)})`; }
  const [a, m, b] = rgb;
  const [lo, hi, tt] = t < 0.5 ? [a, m, t / 0.5] : [m, b, (t - 0.5) / 0.5];
  return `rgb(${cfLerp(lo[0], hi[0], tt)},${cfLerp(lo[1], hi[1], tt)},${cfLerp(lo[2], hi[2], tt)})`;
}

// Per-repaint memos: color-scale min/max over a rule's rectangle, and a
// reusable eval ctx for custom-formula rules (cleared in paintNow because
// cell values change between repaints).
let _cfScaleMemo = new WeakMap();
let _cfCtxMemo = new WeakMap();
function cfClearMemo() { _cfScaleMemo = new WeakMap(); _cfCtxMemo = new WeakMap(); }
function cfScaleStats(sheet, rule) {
  let s = _cfScaleMemo.get(rule);
  if (s) return s;
  let min = Infinity, max = -Infinity;
  for (let rr = rule.r0; rr <= rule.r1; rr++) {
    for (let cc = rule.c0; cc <= rule.c1; cc++) {
      const cl = sheet.cells.get(cellKey(rr, cc));
      if (!cl) continue;
      const n = cellNumeric(cl.formula ? (cl.err ? null : cl.computed) : cl.value);
      if (n == null) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  s = min === Infinity ? { empty: true } : { min, max };
  _cfScaleMemo.set(rule, s);
  return s;
}
function cfEvalCtx(sheet) {
  let ctx = _cfCtxMemo.get(sheet);
  if (ctx) return ctx;
  ctx = {
    rowCount: sheet.rowCount, colCount: sheet.colCount,
    getCell: (r, c, sn) => (sn ? crossSheetValue(sheet, sn, r, c) : engineValue(sheet, r, c)),
    names: namesForSheet(sheet),
  };
  _cfCtxMemo.set(sheet, ctx);
  return ctx;
}
// A custom-formula rule authored relative to the range's top-left cell:
// shift its relative refs to this cell, evaluate, and test truthiness.
function cfFormulaHits(sheet, rule, r, c) {
  if (!rule.formula) return false;
  try {
    const shifted = shiftFormulaRelative(rule.formula, r - rule.r0, c - rule.c0);
    if (shifted.includes("#REF")) return false;
    let v = evalFormula(shifted, cfEvalCtx(sheet));
    if (v instanceof Arr) v = v.top();
    return truthy(v);
  } catch (_) { return false; }
}

function condRuleHits(rule, raw) {
  const empty = raw == null || raw === "";
  if (rule.kind === "empty") return empty;
  if (rule.kind === "notempty") return !empty;
  if (empty) return false;
  if (rule.kind === "contains") return String(raw).toLowerCase().includes(String(rule.v1 ?? "").toLowerCase());
  const x = cellNumeric(raw);
  const a = +rule.v1, b = +rule.v2;
  switch (rule.kind) {
    case "gt": return x != null && x > a;
    case "lt": return x != null && x < a;
    case "between": return x != null && x >= Math.min(a, b) && x <= Math.max(a, b);
    case "eq": {
      if (x != null && rule.v1 !== "" && !isNaN(a)) return x === a;
      return String(raw).trim().toLowerCase() === String(rule.v1 ?? "").trim().toLowerCase();
    }
    default: return false;
  }
}

// Extra inline style for a painted cell; conditional formats win over
// manual fills (Excel's precedence), so this appends AFTER cellStyle.
function condStyleFor(sheet, r, c, cell) {
  const rules = sheet.meta && sheet.meta.condFormat;
  if (!Array.isArray(rules) || !rules.length) return "";
  let out = "";
  for (const rule of rules) {
    if (!ruleCovers(rule, r, c)) continue;
    if (rule.type === "colorscale") {
      const n = cellNumeric(cell ? (cell.formula ? (cell.err ? null : cell.computed) : cell.value) : null);
      if (n == null) continue;
      const st = cfScaleStats(sheet, rule);
      if (st.empty) continue;
      const t = st.max === st.min ? 0.5 : (n - st.min) / (st.max - st.min);
      out = `background:${cfScaleColor((WB_CF_SCALES[rule.scale] || WB_CF_SCALES.gyr).stops, t)};`;
      continue;
    }
    if (rule.type === "formula" || rule.kind === "formula") {
      if (!cfFormulaHits(sheet, rule, r, c)) continue;
      const stf = WB_CF_STYLES[rule.style] || WB_CF_STYLES.amber;
      out = `background:${stf.bg};color:${stf.fg};`;
      continue;
    }
    const raw = cell ? (cell.formula ? (cell.err ? null : cell.computed) : cell.value) : null;
    if (condRuleHits(rule, raw)) {
      const st = WB_CF_STYLES[rule.style] || WB_CF_STYLES.amber;
      out = `background:${st.bg};color:${st.fg};`;
    }
  }
  return out;
}

// Keep rule rectangles anchored through row/column insert/delete.
function shiftRuleRanges(sheet, axis, index, delta) {
  const meta = sheet.meta || {};
  const lo = axis === "row" ? "r0" : "c0", hi = axis === "row" ? "r1" : "c1";
  const cut = delta < 0 ? -delta : 0;
  for (const key of ["validation", "condFormat", "merges", "charts", "pivots"]) {
    if (!Array.isArray(meta[key]) || !meta[key].length) continue;
    const next = [];
    for (const rule of meta[key]) {
      let x0 = rule[lo], x1 = rule[hi];
      if (delta < 0) {
        if (x0 >= index && x1 < index + cut) continue; // fully deleted
        x0 = x0 >= index + cut ? x0 + delta : x0 > index ? index : x0;
        x1 = x1 >= index + cut ? x1 + delta : x1 >= index ? index - 1 : x1;
        if (x1 < x0) continue;
      } else {
        if (x0 >= index) x0 += delta;
        if (x1 >= index) x1 += delta;
      }
      next.push({ ...rule, [lo]: x0, [hi]: x1 });
    }
    meta[key] = next;
  }
  sheet.meta = meta;
}

// Flip a checkbox-validated cell between TRUE and FALSE.
function toggleCheckbox(g, r, c) {
  if (!WB.canEdit) return;
  const prev = g.sheet.cells.get(cellKey(r, c));
  const cur = prev && /^true$/i.test(String(prev.formula ? prev.computed : prev.value));
  setCells(g, [{ r, c, cell: { value: cur ? "FALSE" : "TRUE", formula: null, type: "boolean", computed: null, err: null, format: prev && prev.format ? { ...prev.format } : {} } }]);
}

// Dropdown picker for list-validated cells (the ▾ beside the active cell).
function openValidationPicker(g, btnEl) {
  const { r, c } = g.active;
  const rule = findValidationRule(g.sheet, r, c);
  if (!rule || (rule.type !== "list" && rule.type !== "range") || !WB.canEdit) return;
  const rect = btnEl.getBoundingClientRect();
  const m = ctxMenu(rect.left - 120, rect.bottom + 2, dvOptionList(rule, g.sheet).map((opt, i) => {
    const hex = Array.isArray(rule.colors) && rule.colors[i] && HEX_COLOR_RE.test(rule.colors[i]) ? rule.colors[i] : null;
    return `<button type="button" class="popover-item" data-dv-opt="${esc(String(opt))}" role="menuitem">${hex ? `<span class="wb-dv-menuswatch" style="background:${hex}"></span>` : `<span class="wb-dv-menuswatch is-none"></span>`}${esc(String(opt))}</button>`;
  }).join("") +
    `<div class="popover-section"></div><button type="button" class="popover-item" data-dv-clear role="menuitem">Clear value</button>`);
  m.addEventListener("click", (e) => {
    const opt = e.target.closest("[data-dv-opt]");
    const clr = e.target.closest("[data-dv-clear]");
    if (!opt && !clr) return;
    const text = opt ? opt.getAttribute("data-dv-opt") : "";
    closeAllPopovers();
    const prev = g.sheet.cells.get(cellKey(r, c));
    setCells(g, [{ r, c, cell: cellFromInput(text, prev) }]);
    g.els.grid.focus();
  });
}

// ─── Data validation dialog ──────────────────────────────────────────────────

function openValidationDialog(g) {
  if (!WB.canEdit) return;
  document.getElementById("wb-dv-modal")?.remove();
  const sheet = g.sheet;
  const rect = selRect(g);
  const existing = findValidationRule(sheet, g.active.r, g.active.c);
  const cur = existing || { type: "list", list: [], op: "between", v1: "", v2: "", mode: "reject" };
  const refText = colLabel(rect.c0) + (rect.r0 + 1) + ":" + colLabel(rect.c1) + (rect.r1 + 1);
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-dv-modal";
  const opSel = (v, label) => `<option value="${v}" ${cur.op === v ? "selected" : ""}>${label}</option>`;
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Data validation" style="width:480px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Data validation</p><p class="rr-modal-sub">Applies to ${esc(refText)}</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Criteria</span>
            <select class="wb-input" id="wb-dv-type">
              <option value="list" ${cur.type === "list" ? "selected" : ""}>Dropdown from a list</option>
              <option value="range" ${cur.type === "range" ? "selected" : ""}>Dropdown from a range</option>
              <option value="checkbox" ${cur.type === "checkbox" ? "selected" : ""}>Checkbox</option>
              <option value="number" ${cur.type === "number" ? "selected" : ""}>Number</option>
              <option value="date" ${cur.type === "date" ? "selected" : ""}>Date</option>
              <option value="textlen" ${cur.type === "textlen" ? "selected" : ""}>Text length</option>
              <option value="custom" ${cur.type === "custom" ? "selected" : ""}>Custom formula</option>
            </select></label>
          <label class="wb-field" style="flex:0 0 168px"><span class="wb-field-label">On invalid input</span>
            <select class="wb-input" id="wb-dv-mode">
              <option value="reject" ${cur.mode !== "warn" ? "selected" : ""}>Reject the input</option>
              <option value="warn" ${cur.mode === "warn" ? "selected" : ""}>Show a warning</option>
            </select></label>
        </div>
        <div id="wb-dv-list-row">
          <span class="wb-field-label">Options</span>
          <div class="wb-dv-opts" id="wb-dv-opts"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="wb-dv-addopt">+ Add option</button>
          <label class="wb-field" style="margin-top:10px"><span class="wb-field-label">Display style — how the cell looks</span>
            <select class="wb-input" id="wb-dv-style">
              <option value="arrow" ${(cur.style || "arrow") === "arrow" ? "selected" : ""}>Colored cell with an arrow</option>
              <option value="chip" ${cur.style === "chip" ? "selected" : ""}>Chip — a colored pill around the value</option>
              <option value="plain" ${cur.style === "plain" ? "selected" : ""}>Plain text — just the colored fill</option>
            </select></label>
        </div>
        <div id="wb-dv-range-row" hidden>
          <label class="wb-field"><span class="wb-field-label">Options come from</span>
            <input type="text" class="wb-input" id="wb-dv-source" value="${esc(cur.source || "")}" placeholder="Sheet1!A2:A50 or a named range" spellcheck="false"></label>
          <p class="wb-dv-hint" style="margin-top:6px">Distinct, non-empty values from that range fill the dropdown.</p>
        </div>
        <div class="wb-field-row" id="wb-dv-num-row" hidden>
          <label class="wb-field"><span class="wb-field-label" id="wb-dv-op-label">Condition</span>
            <select class="wb-input" id="wb-dv-op">
              ${opSel("between", "Between")}${opSel(">=", "Greater or equal")}${opSel("<=", "Less or equal")}${opSel(">", "Greater than")}${opSel("<", "Less than")}${opSel("=", "Equal to")}
            </select></label>
          <label class="wb-field" style="flex:0 0 120px"><span class="wb-field-label">Value</span>
            <input type="text" class="wb-input" id="wb-dv-v1" value="${esc(cur.v1 ?? "")}"></label>
          <label class="wb-field" style="flex:0 0 120px" id="wb-dv-v2-field"><span class="wb-field-label">and</span>
            <input type="text" class="wb-input" id="wb-dv-v2" value="${esc(cur.v2 ?? "")}"></label>
        </div>
        <div id="wb-dv-custom-row" hidden>
          <label class="wb-field"><span class="wb-field-label">Custom formula — relative to the top-left cell, must return TRUE</span>
            <input type="text" class="wb-input" id="wb-dv-formula" value="${esc(cur.formula || "")}" placeholder='=AND(A1>0, A1<100)' spellcheck="false"></label>
        </div>
        <p class="wb-dv-hint">Cells that break the rule get a red corner marker. Typed input is checked as you enter it; pasted data is only flagged.</p>
      </div>
      <div class="rr-modal-foot">
        ${existing ? `<button class="rr-modal-btn" type="button" data-wb-dv-remove style="margin-right:auto">Remove rule</button>` : ""}
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-wb-dv-apply>Apply</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  // per-option rows: text + a color that fills the cell when selected
  const DV_COLORS = [["", "No color"], ["#E8EAED", "Gray"], ["#C9DAF8", "Blue"], ["#D9EAD3", "Green"], ["#FFF2CC", "Yellow"], ["#FCE5CD", "Orange"], ["#F4CCCC", "Red"], ["#D9D2E9", "Purple"], ["#EAD1DC", "Pink"]];
  const optsHost = wrap.querySelector("#wb-dv-opts");
  // color chooser is swatch-only — a strip of dots, no names
  const addOptRow = (text, color) => {
    const row = document.createElement("div");
    row.className = "wb-dv-optrow";
    row.innerHTML = `
      <input type="text" class="wb-input" data-dv-opt-text value="${esc(text || "")}" placeholder="Option" maxlength="120">
      <input type="hidden" data-dv-opt-color value="${esc(color || "")}">
      <span class="wb-dv-swatches" role="radiogroup" aria-label="Option color">
        ${DV_COLORS.map(([hex, label]) => `<button type="button" class="wb-dv-sw ${(color || "") === hex ? "is-sel" : ""} ${hex ? "" : "is-none"}" data-dv-sw="${hex}" ${hex ? `style="background:${hex}"` : ""} title="${esc(label)}" aria-label="${esc(label)}" role="radio" aria-checked="${(color || "") === hex}"></button>`).join("")}
      </span>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-dv-opt-del title="Remove option" aria-label="Remove option">×</button>`;
    optsHost.appendChild(row);
    return row;
  };
  const curList = cur.list || [];
  const curColors = Array.isArray(cur.colors) ? cur.colors : [];
  if (curList.length) curList.forEach((opt, i) => addOptRow(String(opt), curColors[i] || ""));
  else { addOptRow("", ""); addOptRow("", ""); }
  wrap.querySelector("#wb-dv-addopt").addEventListener("click", () => { addOptRow("", "").querySelector("[data-dv-opt-text]").focus(); });
  optsHost.addEventListener("click", (e) => {
    const del = e.target.closest("[data-dv-opt-del]");
    if (del && optsHost.children.length > 1) { del.closest(".wb-dv-optrow").remove(); return; }
    const sw = e.target.closest("[data-dv-sw]");
    if (sw) {
      const row = sw.closest(".wb-dv-optrow");
      row.querySelector("[data-dv-opt-color]").value = sw.getAttribute("data-dv-sw");
      row.querySelectorAll(".wb-dv-sw").forEach((b) => {
        b.classList.toggle("is-sel", b === sw);
        b.setAttribute("aria-checked", String(b === sw));
      });
    }
  });

  const syncRows = () => {
    const t = wrap.querySelector("#wb-dv-type").value;
    const opBased = t === "number" || t === "date" || t === "textlen";
    wrap.querySelector("#wb-dv-list-row").hidden = t !== "list";
    wrap.querySelector("#wb-dv-range-row").hidden = t !== "range";
    wrap.querySelector("#wb-dv-num-row").hidden = !opBased;
    wrap.querySelector("#wb-dv-custom-row").hidden = t !== "custom";
    wrap.querySelector("#wb-dv-op-label").textContent = t === "textlen" ? "Length" : t === "date" ? "Date is" : "Condition";
    wrap.querySelector("#wb-dv-v2-field").style.display = wrap.querySelector("#wb-dv-op").value === "between" ? "" : "none";
  };
  syncRows();
  wrap.addEventListener("input", syncRows);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-wb-dv-remove]")) {
      setSheetRules(g, "validation", sheetRules(sheet, "validation").filter((x) => !ruleCovers(x, g.active.r, g.active.c)));
      wbLog("sheet.validation", `removed a data-validation rule in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
      wrap.remove();
      g.els.grid.focus();
      return;
    }
    if (e.target.closest("[data-wb-dv-apply]")) {
      const type = wrap.querySelector("#wb-dv-type").value;
      const rule = {
        id: "dv" + Math.random().toString(36).slice(2, 8),
        r0: rect.r0, c0: rect.c0, r1: rect.r1, c1: rect.c1,
        type, mode: wrap.querySelector("#wb-dv-mode").value,
      };
      if (type === "list") {
        rule.list = [];
        rule.colors = [];
        rule.style = wrap.querySelector("#wb-dv-style").value || "arrow";
        optsHost.querySelectorAll(".wb-dv-optrow").forEach((row) => {
          const t = row.querySelector("[data-dv-opt-text]").value.trim();
          if (!t) return;
          rule.list.push(t);
          rule.colors.push(row.querySelector("[data-dv-opt-color]").value || null);
        });
        if (!rule.list.length) { _toast("Add at least one option", "warn"); return; }
      } else if (type === "range") {
        const src = normalizeNameRef(wrap.querySelector("#wb-dv-source").value.trim(), sheet.name)
          || (blockNamedRanges(findBlock(sheet.blockId)).some((d) => d.name.toLowerCase() === wrap.querySelector("#wb-dv-source").value.trim().toLowerCase()) ? wrap.querySelector("#wb-dv-source").value.trim() : null);
        if (!src) { _toast("Enter a range like A2:A50 or a named range", "warn"); return; }
        rule.source = src;
      } else if (type === "custom") {
        const formula = wrap.querySelector("#wb-dv-formula").value.trim();
        if (!formula.startsWith("=")) { _toast("Custom formula must start with =", "warn"); return; }
        try { parseFormula(formula); } catch (_) { _toast("That formula doesn't parse", "warn"); return; }
        rule.formula = formula;
      } else if (type === "checkbox") {
        // no extra config — the cell just toggles TRUE/FALSE
      } else {
        rule.op = wrap.querySelector("#wb-dv-op").value;
        rule.v1 = wrap.querySelector("#wb-dv-v1").value;
        rule.v2 = wrap.querySelector("#wb-dv-v2").value;
        if (rule.v1 === "" || (rule.op === "between" && rule.v2 === "")) { _toast("Enter the limit value", "warn"); return; }
      }
      const rules = sheetRules(sheet, "validation").filter((x) =>
        !(x.r0 === rect.r0 && x.c0 === rect.c0 && x.r1 === rect.r1 && x.c1 === rect.c1));
      rules.push(rule);
      setSheetRules(g, "validation", rules);
      wbLog("sheet.validation", `set a data-validation rule on ${refText} in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
      wrap.remove();
      g.els.grid.focus();
    }
  });
  setTimeout(() => wrap.querySelector("#wb-dv-type")?.focus(), 30);
}

// ─── Named ranges dialog ─────────────────────────────────────────────────────

function setBlockNamedRanges(g, defs) {
  const block = findBlock(g.sheet.blockId);
  if (!block) return;
  block.settings = { ...(block.settings || {}), namedRanges: defs };
  if (WB.canEdit) saveBlock(block, { settings: block.settings });
  // a name change ripples through every sheet's formulas in this block
  for (const sh of WB.sheetsByBlock.get(block.id) || []) recalcSheet(sh);
  repaintGrid(g);
}

// Normalize a user-typed target ("A1:B5" or "Roster!A1:B5") into a
// sheet-qualified ref string, or null if it isn't a valid range/ref.
function normalizeNameRef(text, defaultSheet) {
  let node;
  try { node = parseFormula("=" + String(text).trim()); } catch (_) { return null; }
  if (node.k !== "range" && node.k !== "ref") return null;
  const sheetName = node.sheet || defaultSheet;
  const q = /[^A-Za-z0-9_]/.test(sheetName) ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  if (node.k === "ref") return `${q}!${colLabel(node.col)}${node.row + 1}`;
  const a = colLabel(node.a.col) + (node.a.row + 1);
  const b = colLabel(node.b.col) + (node.b.row + 1);
  return `${q}!${a}:${b}`;
}

function openNamedRangesDialog(g) {
  document.getElementById("wb-nr-modal")?.remove();
  const sheet = g.sheet;
  const ro = !WB.canEdit;
  const rect = selRect(g);
  const selRef = colLabel(rect.c0) + (rect.r0 + 1) + ":" + colLabel(rect.c1) + (rect.r1 + 1);
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-nr-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Named ranges" style="width:520px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Named ranges</p><p class="rr-modal-sub">Give a range a name, then use it in formulas — <code>=SUM(Drivers)</code>. Names are shared across the sheets in this block.</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        ${ro ? "" : `<div class="wb-field-row" style="align-items:flex-end">
          <label class="wb-field" style="flex:0 0 160px"><span class="wb-field-label">Name</span>
            <input type="text" class="wb-input" id="wb-nr-name" placeholder="Drivers" spellcheck="false" maxlength="60"></label>
          <label class="wb-field"><span class="wb-field-label">Refers to</span>
            <input type="text" class="wb-input" id="wb-nr-ref" value="${esc(selRef)}" placeholder="A2:A50" spellcheck="false"></label>
          <button type="button" class="btn btn-primary btn-sm" data-wb-nr-add style="flex:0 0 auto">Add</button>
        </div>`}
        <div class="wb-nr-list" id="wb-nr-list"></div>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn primary" type="button" data-wb-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const paint = () => {
    const defs = blockNamedRanges(findBlock(sheet.blockId));
    wrap.querySelector("#wb-nr-list").innerHTML = !defs.length
      ? `<p class="wb-cf-none">No named ranges yet.</p>`
      : defs.map((d, i) =>
          `<div class="wb-nr-row"><button type="button" class="wb-nr-name" data-nr-go="${esc(d.ref)}" title="Go to ${esc(d.ref)}">${esc(d.name)}</button><span class="wb-nr-ref">${esc(d.ref)}</span>${ro ? "" : `<button type="button" class="wb-cf-del" data-nr-del="${i}" aria-label="Delete ${esc(d.name)}">×</button>`}</div>`).join("");
  };
  paint();
  const addName = () => {
    const name = wrap.querySelector("#wb-nr-name").value.trim();
    const refIn = wrap.querySelector("#wb-nr-ref").value.trim();
    if (!isValidRangeName(name)) { _toast("Pick a name that starts with a letter and isn't a cell reference or function", "warn"); return; }
    const ref = normalizeNameRef(refIn, sheet.name);
    if (!ref) { _toast("Enter a range like A2:A50", "warn"); return; }
    const defs = blockNamedRanges(findBlock(sheet.blockId)).filter((d) => d.name.toLowerCase() !== name.toLowerCase());
    defs.push({ name, ref });
    defs.sort((a, b) => a.name.localeCompare(b.name));
    setBlockNamedRanges(g, defs);
    wbLog("sheet.namedrange", `defined the name “${name}” for ${ref}`, { target_type: "sheet", target_id: sheet.id });
    wrap.querySelector("#wb-nr-name").value = "";
    paint();
    wrap.querySelector("#wb-nr-name").focus();
  };
  wrap.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { wrap.remove(); return; }
    if (e.key === "Enter" && e.target.closest("#wb-nr-name, #wb-nr-ref")) { e.preventDefault(); addName(); }
  });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); g.els.grid.focus(); return; }
    if (e.target.closest("[data-wb-nr-add]")) { addName(); return; }
    const go = e.target.closest("[data-nr-go]");
    if (go) { wrap.remove(); gotoNameBox(g, go.getAttribute("data-nr-go")); g.els.grid.focus(); return; }
    const del = e.target.closest("[data-nr-del]");
    if (del) {
      const defs = blockNamedRanges(findBlock(sheet.blockId)).slice();
      const [removed] = defs.splice(+del.getAttribute("data-nr-del"), 1);
      setBlockNamedRanges(g, defs);
      if (removed) wbLog("sheet.namedrange", `deleted the name “${removed.name}”`, { target_type: "sheet", target_id: sheet.id });
      paint();
    }
  });
  setTimeout(() => wrap.querySelector("#wb-nr-name")?.focus(), 30);
}

// ─── Conditional formatting dialog ───────────────────────────────────────────

function openCondFormatDialog(g) {
  if (!WB.canEdit) return;
  document.getElementById("wb-cf-modal")?.remove();
  const sheet = g.sheet;
  const rect = selRect(g);
  const refText = colLabel(rect.c0) + (rect.r0 + 1) + ":" + colLabel(rect.c1) + (rect.r1 + 1);
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-cf-modal";
  const kindOpts = Object.entries(WB_CF_KINDS).map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  const scaleOpts = Object.entries(WB_CF_SCALES).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("");
  const chips = Object.entries(WB_CF_STYLES).map(([k, st], i) =>
    `<button type="button" class="wb-cf-chip ${i === 0 ? "is-on" : ""}" data-cf-style="${k}" style="background:${st.bg};color:${st.fg}" title="${st.label}" aria-pressed="${i === 0}">Aa</button>`).join("");
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Conditional formatting" style="width:540px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Conditional formatting</p><p class="rr-modal-sub">New rules apply to ${esc(refText)}</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <div class="wb-field-row">
          <label class="wb-field" style="flex:0 0 148px"><span class="wb-field-label">Type</span>
            <select class="wb-input" id="wb-cf-type">
              <option value="single">Single color</option>
              <option value="scale">Color scale</option>
            </select></label>
          <label class="wb-field" id="wb-cf-kind-field"><span class="wb-field-label">Format cells if…</span>
            <select class="wb-input" id="wb-cf-kind">${kindOpts}</select></label>
          <label class="wb-field" style="flex:0 0 96px" id="wb-cf-v1-field"><span class="wb-field-label">Value</span>
            <input type="text" class="wb-input" id="wb-cf-v1"></label>
          <label class="wb-field" style="flex:0 0 96px" id="wb-cf-v2-field"><span class="wb-field-label">and</span>
            <input type="text" class="wb-input" id="wb-cf-v2"></label>
        </div>
        <label class="wb-field" id="wb-cf-formula-field" style="display:none"><span class="wb-field-label">Custom formula — relative to the top-left cell</span>
          <input type="text" class="wb-input" id="wb-cf-formula" placeholder='=$D2=&quot;Late&quot;' spellcheck="false"></label>
        <label class="wb-field" id="wb-cf-scale-field" style="display:none"><span class="wb-field-label">Gradient</span>
          <select class="wb-input" id="wb-cf-scale">${scaleOpts}</select></label>
        <div class="wb-field" id="wb-cf-style-field"><span class="wb-field-label">Style</span>
          <div class="wb-cf-chips" id="wb-cf-chips">${chips}</div></div>
        <button type="button" class="btn btn-primary btn-sm" data-wb-cf-add>Add rule</button>
        <div class="wb-cf-rules" id="wb-cf-rules"></div>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn primary" type="button" data-wb-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const paintRules = () => {
    const rules = sheetRules(sheet, "condFormat");
    wrap.querySelector("#wb-cf-rules").innerHTML = !rules.length
      ? `<p class="wb-cf-none">No rules on this sheet yet.</p>`
      : rules.map((rule, i) => {
          let swatch, what;
          if (rule.type === "colorscale") {
            const sc = WB_CF_SCALES[rule.scale] || WB_CF_SCALES.gyr;
            swatch = `<span class="wb-cf-swatch" style="background:linear-gradient(90deg,${sc.stops.join(",")})"></span>`;
            what = sc.label;
          } else {
            const st = WB_CF_STYLES[rule.style] || WB_CF_STYLES.amber;
            swatch = `<span class="wb-cf-swatch" style="background:${st.bg};color:${st.fg}">Aa</span>`;
            what = rule.kind === "formula" ? `Custom · ${rule.formula}`
              : rule.kind === "empty" || rule.kind === "notempty" ? WB_CF_KINDS[rule.kind]
              : rule.kind === "between" ? `${WB_CF_KINDS.between} ${rule.v1} and ${rule.v2}`
              : `${WB_CF_KINDS[rule.kind] || rule.kind} ${rule.v1}`;
          }
          return `<div class="wb-cf-rule">${swatch}<span class="wb-cf-what">${esc(ruleRefText(rule))} · ${esc(what)}</span><button type="button" class="wb-cf-del" data-cf-del="${i}" aria-label="Delete rule">×</button></div>`;
        }).join("");
  };
  const syncFields = () => {
    const type = wrap.querySelector("#wb-cf-type").value;
    const k = wrap.querySelector("#wb-cf-kind").value;
    const isScale = type === "scale";
    const isFormula = !isScale && k === "formula";
    const show = (id, on) => { wrap.querySelector(id).style.display = on ? "" : "none"; };
    show("#wb-cf-kind-field", !isScale);
    show("#wb-cf-v1-field", !isScale && !isFormula && k !== "empty" && k !== "notempty");
    show("#wb-cf-v2-field", !isScale && !isFormula && k === "between");
    show("#wb-cf-formula-field", isFormula);
    show("#wb-cf-scale-field", isScale);
    show("#wb-cf-style-field", !isScale);
  };
  paintRules();
  syncFields();
  wrap.addEventListener("input", syncFields);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); g.els.grid.focus(); return; }
    const chip = e.target.closest("[data-cf-style]");
    if (chip) {
      wrap.querySelectorAll(".wb-cf-chip").forEach((el) => { el.classList.toggle("is-on", el === chip); el.setAttribute("aria-pressed", String(el === chip)); });
      return;
    }
    const del = e.target.closest("[data-cf-del]");
    if (del) {
      const rules = sheetRules(sheet, "condFormat").slice();
      rules.splice(+del.getAttribute("data-cf-del"), 1);
      setSheetRules(g, "condFormat", rules);
      paintRules();
      return;
    }
    if (e.target.closest("[data-wb-cf-add]")) {
      const type = wrap.querySelector("#wb-cf-type").value;
      const base = { id: "cf" + Math.random().toString(36).slice(2, 8), r0: rect.r0, c0: rect.c0, r1: rect.r1, c1: rect.c1 };
      const rules = sheetRules(sheet, "condFormat").slice();
      if (type === "scale") {
        rules.push({ ...base, type: "colorscale", scale: wrap.querySelector("#wb-cf-scale").value || "gyr" });
      } else {
        const kind = wrap.querySelector("#wb-cf-kind").value;
        const style = wrap.querySelector(".wb-cf-chip.is-on")?.getAttribute("data-cf-style") || "green";
        if (kind === "formula") {
          const formula = wrap.querySelector("#wb-cf-formula").value.trim();
          if (!formula.startsWith("=")) { _toast("Custom formula must start with =", "warn"); return; }
          try { parseFormula(formula); } catch (_) { _toast("That formula doesn't parse", "warn"); return; }
          rules.push({ ...base, type: "formula", kind: "formula", formula, style });
        } else {
          const v1 = wrap.querySelector("#wb-cf-v1").value.trim();
          const v2 = wrap.querySelector("#wb-cf-v2").value.trim();
          if (kind !== "empty" && kind !== "notempty" && v1 === "") { _toast("Enter a value for the condition", "warn"); return; }
          if (kind === "between" && v2 === "") { _toast("Enter both limits", "warn"); return; }
          rules.push({ ...base, kind, v1, v2, style });
        }
      }
      setSheetRules(g, "condFormat", rules);
      wbLog("sheet.condformat", `added a conditional-format rule on ${refText} in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
      paintRules();
    }
  });
}

// ─── Find & replace ──────────────────────────────────────────────────────────

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function closeFindPanel(g) {
  if (g.els.findPanel) { g.els.findPanel.remove(); g.els.findPanel = null; }
  g.find = null;
}

function computeFindMatches(g) {
  const f = g.find;
  if (!f) return;
  f.matches = [];
  if (f.text) {
    const needle = f.matchCase ? f.text : f.text.toLowerCase();
    const entries = [...g.sheet.cells.entries()].map(([key, cell]) => ({ ...keyRC(key), cell })).sort((a, b) => a.r - b.r || a.c - b.c);
    for (const { r, c, cell } of entries) {
      if (dispIndexOfRow(g, r) < 0 || colW(g.sheet, c) === 0) continue; // hidden/filtered out
      const texts = [];
      if (cell.formula) { texts.push(String(cell.err ? "" : cell.computed ?? "")); if (f.inFormulas) texts.push(cell.formula); }
      else texts.push(String(cell.value ?? ""));
      const hit = texts.some((t) => {
        const hay = f.matchCase ? t : t.toLowerCase();
        return f.entire ? hay === needle : hay.includes(needle);
      });
      if (hit) f.matches.push({ r, c });
    }
  }
  f.idx = f.matches.length ? 0 : -1;
}

function paintFindCount(g) {
  const f = g.find;
  const el = g.els.findPanel && g.els.findPanel.querySelector("[data-wb-find-count]");
  if (!el || !f) return;
  el.textContent = !f.text ? "" : !f.matches.length ? "No matches" : `${f.idx + 1} of ${f.matches.length}`;
}

function stepFind(g, dir) {
  const f = g.find;
  if (!f || !f.matches.length) { paintFindCount(g); return; }
  f.idx = (f.idx + dir + f.matches.length) % f.matches.length;
  const m = f.matches[f.idx];
  setActive(g, m.r, m.c);
  paintFindCount(g);
}

function replaceInText(t, f, replText) {
  if (f.entire) {
    const hay = f.matchCase ? t : t.toLowerCase();
    const nd = f.matchCase ? f.text : f.text.toLowerCase();
    return hay === nd ? replText : t;
  }
  return t.replace(new RegExp(escapeRegExp(f.text), f.matchCase ? "g" : "gi"), replText);
}

function replacementFor(g, m, replText) {
  const f = g.find;
  const cell = g.sheet.cells.get(cellKey(m.r, m.c));
  if (!cell) return null;
  if (cell.formula) {
    if (!f.inFormulas) return null; // matched the computed result — nothing editable
    const nf = replaceInText(cell.formula, f, replText);
    return nf === cell.formula ? null : { r: m.r, c: m.c, cell: cellFromInput(nf, cell) };
  }
  const nv = replaceInText(String(cell.value ?? ""), f, replText);
  return nv === String(cell.value ?? "") ? null : { r: m.r, c: m.c, cell: cellFromInput(nv, cell) };
}

function replaceCurrent(g, replText) {
  const f = g.find;
  if (!WB.canEdit || !f || f.idx < 0) return;
  const m = f.matches[f.idx];
  const change = replacementFor(g, m, replText);
  if (!change) { _toast("This match is a formula result — turn on the Formulas option to edit it", "warn"); stepFind(g, 1); return; }
  setCells(g, [change]);
  const keep = f.idx;
  computeFindMatches(g);
  f.idx = f.matches.length ? Math.min(keep, f.matches.length - 1) : -1;
  if (f.idx >= 0) { const nm = f.matches[f.idx]; setActive(g, nm.r, nm.c); }
  paintFindCount(g);
}

function replaceAll(g, replText) {
  const f = g.find;
  if (!WB.canEdit || !f || !f.matches.length) return;
  const changes = [];
  let skipped = 0;
  for (const m of f.matches) {
    const change = replacementFor(g, m, replText);
    if (change) changes.push(change); else skipped++;
  }
  if (changes.length) setCells(g, changes);
  _toast(changes.length ? `Replaced in ${changes.length} cell${changes.length === 1 ? "" : "s"}${skipped ? ` · ${skipped} formula result${skipped === 1 ? "" : "s"} skipped` : ""}` : "Nothing to replace", changes.length ? "success" : "info");
  computeFindMatches(g);
  paintFindCount(g);
}

function openFindPanel(g, withReplace) {
  const ro = !WB.canEdit;
  if (g.els.findPanel) {
    if (withReplace && !ro) g.els.findPanel.classList.add("has-replace");
    g.els.findPanel.querySelector("[data-wb-find-input]").focus();
    g.els.findPanel.querySelector("[data-wb-find-input]").select();
    return;
  }
  const panel = document.createElement("div");
  panel.className = "wb-find-panel" + (withReplace && !ro ? " has-replace" : "");
  panel.innerHTML = `
    <div class="wb-find-row">
      <input type="text" class="wb-input" data-wb-find-input placeholder="Find in sheet" aria-label="Find in sheet" autocomplete="off" spellcheck="false">
      <span class="wb-find-count" data-wb-find-count></span>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-find="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-find="next" title="Next match (Enter)" aria-label="Next match">↓</button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-find="close" title="Close (Esc)" aria-label="Close find">×</button>
    </div>
    <div class="wb-find-opts">
      <label><input type="checkbox" data-wb-find-opt="matchCase"> Match case</label>
      <label><input type="checkbox" data-wb-find-opt="entire"> Entire cell</label>
      <label><input type="checkbox" data-wb-find-opt="inFormulas"> Formulas</label>
      ${ro ? "" : `<button type="button" class="wb-find-toggle" data-wb-find="toggle-replace">Replace…</button>`}
    </div>
    ${ro ? "" : `<div class="wb-find-row wb-find-replace-row">
      <input type="text" class="wb-input" data-wb-find-rinput placeholder="Replace with" aria-label="Replace with" autocomplete="off" spellcheck="false">
      <button type="button" class="btn btn-ghost btn-sm" data-wb-find="replace">Replace</button>
      <button type="button" class="btn btn-ghost btn-sm" data-wb-find="replace-all">All</button>
    </div>`}`;
  g.els.grid.appendChild(panel);
  g.els.findPanel = panel;
  g.find = { text: "", matchCase: false, entire: false, inFormulas: false, matches: [], idx: -1 };
  const input = panel.querySelector("[data-wb-find-input]");
  const rinput = panel.querySelector("[data-wb-find-rinput]");
  panel.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeFindPanel(g); g.els.grid.focus(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (rinput && document.activeElement === rinput) replaceCurrent(g, rinput.value);
      else stepFind(g, e.shiftKey ? -1 : 1);
    }
  });
  input.addEventListener("input", () => {
    g.find.text = input.value;
    computeFindMatches(g);
    if (g.find.idx >= 0) { const m = g.find.matches[g.find.idx]; setActive(g, m.r, m.c); }
    paintFindCount(g);
  });
  panel.addEventListener("change", (e) => {
    const opt = e.target.closest("[data-wb-find-opt]");
    if (!opt) return;
    g.find[opt.getAttribute("data-wb-find-opt")] = opt.checked;
    computeFindMatches(g);
    if (g.find.idx >= 0) { const m = g.find.matches[g.find.idx]; setActive(g, m.r, m.c); }
    paintFindCount(g);
  });
  panel.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-wb-find]");
    if (!btn) return;
    switch (btn.getAttribute("data-wb-find")) {
      case "prev": stepFind(g, -1); break;
      case "next": stepFind(g, 1); break;
      case "close": closeFindPanel(g); g.els.grid.focus(); break;
      case "toggle-replace": panel.classList.toggle("has-replace"); if (panel.classList.contains("has-replace")) rinput?.focus(); break;
      case "replace": replaceCurrent(g, rinput ? rinput.value : ""); break;
      case "replace-all": replaceAll(g, rinput ? rinput.value : ""); break;
    }
  });
  input.focus();
}

// ─── Sort ────────────────────────────────────────────────────────────────────
// Sorts data rows (2..N — row 1 is treated as the header). Whole rows
// move together; one undo entry. Multi-level: specs = [{col, dir}, …].

function sortByColumn(g, col, dir) { sortBySpecs(g, [{ col, dir }]); }

// Quiet = no activity log and no sort-spec persistence (used when a live
// report refresh re-applies the operator's saved sort).

// Ordinal text values sort by meaning, not alphabet — a Risk Level
// column sorts High→Medium→Low, never High→Low→Medium. A set applies
// only when EVERY non-empty value in the column belongs to it.
const WB_SORT_ORDINALS = [
  { low: 0, medium: 1, high: 2 },
  { good: 0, warning: 1, serious: 2, critical: 3 },
];

function sortBySpecs(g, specs, opts) {
  if (!WB.canEdit || !specs || !specs.length) return;
  const quiet = !!(opts && opts.quiet);
  const sheet = g.sheet;
  cancelEdit(g);
  let maxRow = 0;
  for (const key of sheet.cells.keys()) maxRow = Math.max(maxRow, keyRC(key).r);
  if (maxRow < 2) { _toast("Nothing to sort below the header row", "info"); return; }
  if (sheetMerges(sheet).some((m) => m.r1 > 0)) { _toast("Unmerge cells below the header before sorting", "warn"); return; }
  const rowsIdx = [];
  for (let r = 1; r <= maxRow; r++) rowsIdx.push(r);
  const rawOf = (r, col) => {
    const cell = sheet.cells.get(cellKey(r, col));
    if (!cell) return null;
    const raw = cell.formula ? cell.computed : cell.value;
    return raw == null || raw === "" ? null : raw;
  };
  const ordinalFor = (col) => {
    let found;
    for (let r = 1; r <= maxRow; r++) {
      const raw = rawOf(r, col);
      if (raw == null || typeof raw !== "string") { if (raw != null) return null; continue; }
      const s = raw.trim().toLowerCase();
      if (found === undefined) {
        found = WB_SORT_ORDINALS.find((o) => s in o) || null;
        if (!found) return null;
      } else if (!found || !(s in found)) return null;
    }
    return found || null;
  };
  const ordBy = new Map(specs.map((sp) => [sp.col, ordinalFor(sp.col)]));
  const keyOf = (r, col) => {
    const cell = sheet.cells.get(cellKey(r, col));
    if (!cell) return { empty: true };
    const raw = cell.formula ? cell.computed : cell.value;
    if (raw == null || raw === "") return { empty: true };
    let n = cellNumeric(raw);
    const ord = ordBy.get(col);
    if (ord && typeof raw === "string" && raw.trim().toLowerCase() in ord) n = ord[raw.trim().toLowerCase()];
    else if (n == null && typeof raw === "string") { const d = parseDateLoose(raw); if (d) n = dateToSerial(d); } // dates sort as dates
    return { empty: false, n, s: String(raw).toLowerCase() };
  };
  const cmpLevel = (a, b, col, dir) => {
    const ka = keyOf(a, col), kb = keyOf(b, col);
    if (ka.empty && kb.empty) return 0;
    if (ka.empty) return 1; // empties always last
    if (kb.empty) return -1;
    let cmp;
    if (ka.n != null && kb.n != null) cmp = ka.n - kb.n;
    else if (ka.n != null) cmp = -1;
    else if (kb.n != null) cmp = 1;
    else cmp = ka.s < kb.s ? -1 : ka.s > kb.s ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  };
  const sorted = rowsIdx.slice().sort((a, b) => {
    for (const sp of specs) {
      const cmp = cmpLevel(a, b, sp.col, sp.dir);
      if (cmp) return cmp;
    }
    return a - b; // stable
  });
  if (sorted.every((r, i) => r === rowsIdx[i])) { repaintGrid(g); return; }
  // rebuild the map with rows in the new order
  const rowSnapshot = new Map(); // old row -> [ [c, cell] ]
  for (const [key, cell] of sheet.cells) {
    const { r, c } = keyRC(key);
    if (r < 1 || r > maxRow) continue;
    if (!rowSnapshot.has(r)) rowSnapshot.set(r, []);
    rowSnapshot.get(r).push([c, cell]);
  }
  const changes = [];
  const touched = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i], to = rowsIdx[i];
    if (from === to) continue;
    const cols = new Set([...(rowSnapshot.get(from) || []).map(([c]) => c), ...(rowSnapshot.get(to) || []).map(([c]) => c)]);
    for (const c of cols) {
      const key = cellKey(to, c);
      const fromCell = (rowSnapshot.get(from) || []).find(([cc]) => cc === c);
      changes.push({ key, r: to, c, prev: cloneCell(sheet.cells.get(key)), next: fromCell ? cloneCell(fromCell[1]) : null });
      touched.add(key);
    }
  }
  for (const ch of changes) {
    if (ch.next) sheet.cells.set(ch.key, { ...ch.next, computed: null, err: null });
    else sheet.cells.delete(ch.key);
  }
  g.undo.push({ changes });
  if (g.undo.length > 100) g.undo.shift();
  g.redo = [];
  recalcWithSiblings(sheet);
  markCellsDirty(sheet, [...touched]);
  if (!quiet) {
    wbLog("sheet.sorted", `sorted ${sheet.name} by ${specs.map((sp) => `${colLabel(sp.col)} ${sp.dir === "asc" ? "A→Z" : "Z→A"}`).join(", ")}`, { target_type: "sheet", target_id: sheet.id });
    // remember the sort so live report refreshes can restore it
    sheet.meta = { ...(sheet.meta || {}), sortSpec: specs.map((sp) => ({ col: sp.col, dir: sp.dir })) };
    saveSheetMeta(sheet.id);
  }
  computeGeometry(g);
  repaintGrid(g);
}

// Custom sort dialog: up to three levels, column labels pulled from the
// header row so operators pick by name, not letter.
function openSortDialog(g) {
  if (!WB.canEdit) return;
  document.getElementById("wb-sort-modal")?.remove();
  const sheet = g.sheet;
  const colOpts = (sel) => {
    let out = "";
    for (let c = 0; c < sheet.colCount; c++) {
      const header = filterCellText(sheet, 0, c);
      out += `<option value="${c}" ${c === sel ? "selected" : ""}>${esc(colLabel(c))}${header ? ` — ${esc(header.slice(0, 28))}` : ""}</option>`;
    }
    return out;
  };
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-sort-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Sort" style="width:520px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Sort</p><p class="rr-modal-sub">Row 1 stays put as the header; whole rows move together.</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        ${[0, 1, 2].map((i) => `
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">${i === 0 ? "Sort by" : "Then by"}</span>
            <select class="wb-input" data-sort-col="${i}">${i === 0 ? "" : `<option value="">—</option>`}${colOpts(i === 0 ? g.active.c : -1)}</select></label>
          <label class="wb-field" style="flex:0 0 170px"><span class="wb-field-label">Order</span>
            <select class="wb-input" data-sort-dir="${i}">
              <option value="asc">A → Z · low → high</option>
              <option value="desc">Z → A · high → low</option>
            </select></label>
        </div>`).join("")}
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-wb-sort-apply>Sort</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-wb-sort-apply]")) {
      const specs = [];
      for (let i = 0; i < 3; i++) {
        const col = wrap.querySelector(`[data-sort-col="${i}"]`).value;
        if (col === "") continue;
        const c = +col;
        if (specs.some((s) => s.col === c)) continue;
        specs.push({ col: c, dir: wrap.querySelector(`[data-sort-dir="${i}"]`).value });
      }
      wrap.remove();
      if (specs.length) sortBySpecs(g, specs);
      g.els.grid.focus();
    }
  });
  setTimeout(() => wrap.querySelector('[data-sort-col="0"]')?.focus(), 30);
}

// ─── Filter ──────────────────────────────────────────────────────────────────
// Excel-style AutoFilter: a per-column dropdown with the column's distinct
// values as checkboxes plus a contains-text box. Filters stack across
// columns; the chip below the grid summarizes and clears them.

// Excel's Filter toggle: on → every header cell in the used range grows
// a ▾ dropdown; off → buttons and all criteria clear.
function toggleFilterMode(g) {
  g.filterMode = !g.filterMode;
  if (!g.filterMode) g.filters = new Map();
  const btn = g.els.body.querySelector('[data-wb-tb="filter"]');
  if (btn) btn.classList.toggle("is-on", g.filterMode);
  computeGeometry(g);
  repaintGrid(g);
  persistFilterState(g);
  if (g.els.sbmode) g.els.sbmode.textContent = g.filterMode ? "Filter on — use the ▾ buttons in the header row" : "Ready";
}

// ─── View-state persistence ──────────────────────────────────────────────────
// Filters + filter mode live in sheet.meta (shared, like Sheets' on-sheet
// filter); zoom is a personal preference and stays in localStorage.

function persistFilterState(g) {
  if (!WB.canEdit) return;
  g.sheet.meta = {
    ...(g.sheet.meta || {}),
    filterState: {
      on: g.filterMode,
      filters: [...g.filters.entries()].map(([col, f]) => ({ col, text: f.text || null, values: f.values ? [...f.values] : null })),
    },
  };
  saveSheetMeta(g.sheet.id);
}

function restoreViewState(g) {
  const sheet = g.sheet;
  const fs = sheet.meta && sheet.meta.filterState;
  g.filters = new Map();
  g.filterMode = false;
  if (fs && typeof fs === "object") {
    g.filterMode = !!fs.on;
    for (const f of Array.isArray(fs.filters) ? fs.filters : []) {
      if (typeof f.col === "number") g.filters.set(f.col, { text: f.text || null, values: Array.isArray(f.values) ? new Set(f.values) : null });
    }
  }
  g.els.body.querySelector('[data-wb-tb="filter"]')?.classList.toggle("is-on", g.filterMode);
  let z = 1;
  try { z = parseFloat(localStorage.getItem("rr-wb-zoom-" + sheet.id)) || 1; } catch (_) {}
  g.zoom = Math.min(2, Math.max(0.5, z));
  g.els.grid.style.setProperty("--wb-zoom", String(g.zoom));
  const zs = g.els.body.querySelector("[data-wb-zoom]");
  if (zs) zs.value = String(g.zoom);
  // View → Show state: gridlines per sheet (meta), formula bar per user
  g.els.grid.classList.toggle("is-nogrid", !!(sheet.meta && sheet.meta.nogrid));
  if (WB.showFbar === undefined) {
    try { WB.showFbar = localStorage.getItem("rr-wb-fbar") !== "0"; } catch (_) { WB.showFbar = true; }
  }
  const fb = g.els.body.querySelector(".wb-fbar");
  if (fb) fb.hidden = WB.showFbar === false;
}

const FILTER_VALUE_CAP = 200;

function openFilterPanel(g, col, anchorEl, at) {
  const sheet = g.sheet;
  const cur = (g.filters && g.filters.get(col)) || null;
  const counts = new Map();
  for (let r = 1; r < sheet.rowCount; r++) {
    if (sheet.hiddenRows && sheet.hiddenRows.has(r)) continue;
    const t = filterCellText(sheet, r, col);
    if (t === "") continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const values = [...counts.keys()].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (isFinite(na) && isFinite(nb) && a.trim() !== "" && b.trim() !== "") return na - nb;
    const la = a.toLowerCase(), lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const shown = values.slice(0, FILTER_VALUE_CAP);
  const header = filterCellText(sheet, 0, col);
  const isChecked = (v) => (cur && cur.values ? cur.values.has(v) : true);
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  const m = ctxMenu(at ? at.x : rect ? rect.left : 120, at ? at.y : rect ? rect.bottom + 4 : 120, `
    <div class="wb-filterpop">
      <div class="wb-filterpop-head">Filter ${esc(colLabel(col))}${header ? ` · ${esc(header.slice(0, 32))}` : ""}</div>
      ${WB.canEdit ? `<div class="wb-filterpop-sortrow">
        <button type="button" class="wb-filterpop-sortbtn" data-fp-sort="asc">↑ Sort A→Z · low→high</button>
        <button type="button" class="wb-filterpop-sortbtn" data-fp-sort="desc">↓ Sort Z→A · high→low</button>
      </div>` : ""}
      <input type="text" class="wb-input wb-filterpop-text" data-fp-text placeholder="Contains…" value="${esc((cur && cur.text) || "")}" autocomplete="off" spellcheck="false" aria-label="Rows containing text">
      <label class="wb-filterpop-item wb-filterpop-all"><input type="checkbox" data-fp-all ${!cur || !cur.values ? "checked" : ""}> <span>Select all</span><span class="wb-filterpop-n">${values.length}</span></label>
      <div class="wb-filterpop-list">
        ${shown.map((v) => `<label class="wb-filterpop-item"><input type="checkbox" data-fp-val="${esc(v)}" ${isChecked(v) ? "checked" : ""}> <span>${esc(v)}</span><span class="wb-filterpop-n">${counts.get(v)}</span></label>`).join("") || `<div class="rr-empty-inline">No values below the header yet.</div>`}
        ${values.length > FILTER_VALUE_CAP ? `<div class="wb-filterpop-more">…and ${values.length - FILTER_VALUE_CAP} more — use “Contains” to narrow.</div>` : ""}
      </div>
      <div class="wb-filterpop-foot">
        <button type="button" class="btn btn-ghost btn-sm" data-fp-clear>Clear</button>
        <button type="button" class="btn btn-primary btn-sm" data-fp-apply>Apply</button>
      </div>
    </div>`);
  const allBox = m.querySelector("[data-fp-all]");
  const apply = () => {
    const text = m.querySelector("[data-fp-text]").value.trim();
    const boxes = [...m.querySelectorAll("[data-fp-val]")];
    const all = !boxes.length || boxes.every((cb) => cb.checked);
    const picked = new Set(boxes.filter((cb) => cb.checked).map((cb) => cb.getAttribute("data-fp-val")));
    closeAllPopovers();
    if (!text && all) g.filters.delete(col);
    else {
      g.filters.set(col, { text: text || null, values: all ? null : picked });
      // applying a filter turns filter mode on so the header ▾ buttons show
      if (!g.filterMode) {
        g.filterMode = true;
        g.els.body.querySelector('[data-wb-tb="filter"]')?.classList.add("is-on");
      }
    }
    computeGeometry(g);
    repaintGrid(g);
    persistFilterState(g);
    g.els.grid.focus();
  };
  allBox.addEventListener("change", () => {
    m.querySelectorAll("[data-fp-val]").forEach((cb) => { cb.checked = allBox.checked; });
  });
  m.addEventListener("change", (e) => {
    if (e.target.closest("[data-fp-val]")) {
      const boxes = [...m.querySelectorAll("[data-fp-val]")];
      allBox.checked = boxes.every((cb) => cb.checked);
    }
  });
  m.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { closeAllPopovers(); g.els.grid.focus(); }
    if (e.key === "Enter") { e.preventDefault(); apply(); }
  });
  m.querySelector("[data-fp-apply]").addEventListener("click", apply);
  m.querySelectorAll("[data-fp-sort]").forEach((sb) => sb.addEventListener("click", () => {
    const dir = sb.getAttribute("data-fp-sort");
    closeAllPopovers();
    sortByColumn(g, col, dir);
    g.els.grid.focus();
  }));
  m.querySelector("[data-fp-clear]").addEventListener("click", () => {
    closeAllPopovers();
    g.filters.delete(col);
    computeGeometry(g);
    repaintGrid(g);
    persistFilterState(g);
    g.els.grid.focus();
  });
  setTimeout(() => m.querySelector("[data-fp-text]")?.focus(), 30);
}

// ─── Merged cells ────────────────────────────────────────────────────────────
// Merge rectangles live in sheet.meta.merges as {r0,c0,r1,c1}. The
// top-left (anchor) cell holds the value; covered cells are skipped at
// paint time and clicks/arrows resolve to the anchor.

function sheetMerges(sheet) {
  const v = sheet.meta && sheet.meta.merges;
  return Array.isArray(v) ? v : [];
}

function mergeAt(sheet, r, c) {
  for (const m of sheetMerges(sheet)) {
    if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m;
  }
  return null;
}

// Pixel rect of a merge in canvas space (filter/hide-aware). Null when
// the anchor row is filtered out.
function mergePixelRect(g, m) {
  const di0 = dispIndexOfRow(g, m.r0);
  if (di0 < 0) return null;
  let di1 = di0;
  for (let r = m.r1; r >= m.r0; r--) { const d = dispIndexOfRow(g, r); if (d >= 0) { di1 = d; break; } }
  return { x: g.colX[m.c0], y: g.rowY[di0], w: g.colX[m.c1 + 1] - g.colX[m.c0], h: g.rowY[di1 + 1] - g.rowY[di0] };
}

function setMerges(g, merges) {
  g.sheet.meta = { ...(g.sheet.meta || {}), merges };
  saveSheetMeta(g.sheet.id);
  computeGeometry(g);
  repaintGrid(g);
}

function toggleMergeSelection(g) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const rect = selRect(g);
  const touched = sheetMerges(sheet).filter((m) => !(m.r1 < rect.r0 || m.r0 > rect.r1 || m.c1 < rect.c0 || m.c0 > rect.c1));
  if (touched.length) {
    setMerges(g, sheetMerges(sheet).filter((m) => !touched.includes(m)));
    wbLog("sheet.merge", `unmerged ${touched.length} range${touched.length === 1 ? "" : "s"} in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
    return;
  }
  if (rect.r0 === rect.r1 && rect.c0 === rect.c1) { _toast("Select more than one cell to merge", "info"); return; }
  if ((rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) > 400) { _toast("That merge is too large", "warn"); return; }
  // keep the top-left value; clearing the rest is undoable
  const changes = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      if (r === rect.r0 && c === rect.c0) continue;
      const cell = sheet.cells.get(cellKey(r, c));
      if (cell && (cell.value != null || cell.formula)) changes.push({ r, c, cell: null });
    }
  }
  if (changes.length) { setCells(g, changes); _toast("Merged — only the top-left value was kept", "info"); }
  setMerges(g, [...sheetMerges(sheet), { r0: rect.r0, c0: rect.c0, r1: rect.r1, c1: rect.c1 }]);
  setActive(g, rect.r0, rect.c0);
  wbLog("sheet.merge", `merged ${colLabel(rect.c0)}${rect.r0 + 1}:${colLabel(rect.c1)}${rect.r1 + 1} in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
}

// ─── Format painter ──────────────────────────────────────────────────────────
// Copy the active cell's formatting, then the next selection gets it
// applied wholesale (values and formulas untouched). Esc cancels.

function startFormatPainter(g) {
  if (!WB.canEdit) return;
  if (g.painter) { cancelFormatPainter(g); return; }
  const cell = g.sheet.cells.get(cellKey(g.active.r, g.active.c));
  g.painter = cell && cell.format ? { ...cell.format } : {};
  g.els.body.querySelector('[data-wb-tb="paint-format"]')?.classList.add("is-on");
  if (g.els.sbmode) g.els.sbmode.textContent = "Format painter — select cells to apply · Esc to cancel";
}

function cancelFormatPainter(g) {
  if (!g.painter) return;
  g.painter = null;
  g.els.body.querySelector('[data-wb-tb="paint-format"]')?.classList.remove("is-on");
  markSaveState(WB.saveState);
}

function applyFormatPainter(g) {
  const src = g.painter;
  if (!src) return;
  cancelFormatPainter(g);
  const changes = [];
  const { c0, c1 } = selRect(g);
  for (const r of selVisibleRows(g)) {
    for (let c = c0; c <= c1; c++) {
      const cell = g.sheet.cells.get(cellKey(r, c));
      if (!cell && !Object.keys(src).length) continue;
      const base = cell ? cloneCell(cell) : { value: null, formula: null, type: null, format: {} };
      base.format = { ...src };
      changes.push({ r, c, cell: base.value == null && base.formula == null && !Object.keys(base.format).length ? null : base });
    }
  }
  if (changes.length) setCells(g, changes);
}

// ─── Autofit ─────────────────────────────────────────────────────────────────
// Size columns to their widest rendered value (Excel's double-click-the-
// divider gesture). Canvas measureText against the grid's own font.

let AUTOFIT_MEASURE = null;

function autofitColumns(g, c0, c1) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  if (!AUTOFIT_MEASURE) AUTOFIT_MEASURE = document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(g.els.cells);
  const widths = new Map();
  let scanned = 0;
  for (const [key, cell] of sheet.cells) {
    const { r, c } = keyRC(key);
    if (c < c0 || c > c1) continue;
    const disp = displayValue(sheet, r, c);
    if (!disp) continue;
    if (++scanned > 20000) break;
    const f = cell.format || {};
    const bold = f.bold || f.bg === "header";
    const fsPx = Number.isInteger(f.fs) ? `${f.fs}px` : cs.fontSize || "13px";
    const fam = f.ff && WB_FONT_FAMILIES[f.ff] ? WB_FONT_FAMILIES[f.ff] : cs.fontFamily || "sans-serif";
    AUTOFIT_MEASURE.font = `${bold ? "600" : cs.fontWeight || "400"} ${fsPx} ${fam}`;
    const w = Math.ceil(AUTOFIT_MEASURE.measureText(disp).width) + 18;
    if (w > (widths.get(c) || 0)) widths.set(c, w);
  }
  for (let c = c0; c <= c1; c++) {
    sheet.colWidths[c] = Math.min(MAX_COL_W, Math.max(MIN_COL_W, widths.get(c) || DEF_COL_W));
  }
  computeGeometry(g);
  repaintGrid(g);
  saveSheetMeta(sheet.id);
}

// ─── Freeze ──────────────────────────────────────────────────────────────────

function setFreeze(g, what) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  if (what === "row") sheet.frozenRows = sheet.frozenRows ? 0 : 1;
  else if (what === "col") sheet.frozenCols = sheet.frozenCols ? 0 : 1;
  else { sheet.frozenRows = 0; sheet.frozenCols = 0; }
  saveSheetMeta(sheet.id);
  repaintGrid(g);
}

// ─── Sheet CRUD ──────────────────────────────────────────────────────────────

async function addSheetTo(blockId) {
  const g = GRIDS.get(blockId);
  const block = WB.blocks.find((b) => b.id === blockId);
  if (!block || !WB.canEdit) return;
  const sheets = WB.sheetsByBlock.get(blockId) || [];
  try {
    const ins = await _sb().from("workbook_sheets").insert({
      dsp_id: WB.wb.dsp_id, workbook_id: WB.wb.id, block_id: blockId,
      name: `Sheet ${sheets.length + 1}`,
      position: sheets.length ? Math.max(...sheets.map((s) => s.position)) + 1 : 0,
      row_count: 500,
    }).select().single();
    if (ins.error) throw ins.error;
    const sheet = normalizeSheet(ins.data);
    if (!WB.sheetsByBlock.has(blockId)) WB.sheetsByBlock.set(blockId, []);
    WB.sheetsByBlock.get(blockId).push(sheet);
    wbLog("sheet.added", `added sheet “${sheet.name}”`, { target_type: "sheet", target_id: sheet.id });
    if (g) { renderSheetTabs(g); switchSheet(g, sheet.id); }
    else { const body = document.querySelector(`[data-wb-block-body="${blockId}"]`); if (body) mountSheetBlock(block, body); }
  } catch (e) { _toast("Couldn't add the sheet: " + ((e && e.message) || e), "error"); }
}

async function renameSheet(g, sheetId) {
  const sheets = WB.sheetsByBlock.get(g.blockId) || [];
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet || !WB.canEdit) return;
  const name = window.prompt("Sheet name:", sheet.name);
  if (name == null || !name.trim() || name.trim() === sheet.name) return;
  const prev = sheet.name;
  sheet.name = name.trim().slice(0, 80);
  renderSheetTabs(g);
  saveSheetMeta.flushNow(sheetId);
  wbLog("sheet.renamed", `renamed sheet “${prev}” to “${sheet.name}”`, { target_type: "sheet", target_id: sheetId });
}

async function duplicateSheet(g, sheetId) {
  const sheets = WB.sheetsByBlock.get(g.blockId) || [];
  const src = sheets.find((s) => s.id === sheetId);
  if (!src || !WB.canEdit) return;
  try {
    const shRow = {
      dsp_id: WB.wb.dsp_id, workbook_id: WB.wb.id, block_id: g.blockId,
      name: `${src.name} copy`.slice(0, 80),
      position: sheets.length ? Math.max(...sheets.map((s) => s.position)) + 1 : 0,
      row_count: src.rowCount, col_count: src.colCount,
      frozen_rows: src.frozenRows, frozen_cols: src.frozenCols,
      col_widths: src.colWidths || {}, row_heights: src.rowHeights || {},
      // rules, merges, charts, filter views, tab color all ride along
      meta: { ...(src.meta || {}), hiddenRows: [...(src.hiddenRows || [])], hiddenCols: [...(src.hiddenCols || [])] },
    };
    let ins = await _sb().from("workbook_sheets").insert(shRow).select().single();
    if (ins.error && /meta/i.test(String(ins.error.message))) {
      delete shRow.meta; // pre-0414 schema
      ins = await _sb().from("workbook_sheets").insert(shRow).select().single();
    }
    if (ins.error) throw ins.error;
    const sheet = normalizeSheet(ins.data);
    const rows = [];
    for (const [key, cell] of src.cells) {
      const { r, c } = keyRC(key);
      rows.push({
        dsp_id: WB.wb.dsp_id, workbook_id: WB.wb.id, sheet_id: sheet.id,
        row_index: r, col_index: c,
        value: cell.value ?? null, formula: cell.formula ?? null,
        value_type: cell.type ?? null, format: cell.format || {},
        updated_by: _me() ? _me().id : null,
      });
      sheet.cells.set(key, cloneCell(cell));
    }
    for (let i = 0; i < rows.length; i += 500) {
      const res = await _sb().from("workbook_cells").insert(rows.slice(i, i + 500));
      if (res.error) throw res.error;
    }
    recalcSheet(sheet);
    WB.sheetsByBlock.get(g.blockId).push(sheet);
    wbLog("sheet.added", `duplicated sheet “${src.name}”`, { target_type: "sheet", target_id: sheet.id });
    renderSheetTabs(g);
    switchSheet(g, sheet.id);
  } catch (e) { _toast("Couldn't duplicate the sheet: " + ((e && e.message) || e), "error"); }
}

function deleteSheet(g, sheetId) {
  const sheets = WB.sheetsByBlock.get(g.blockId) || [];
  if (sheets.length <= 1) { _toast("A spreadsheet block needs at least one sheet", "warn"); return; }
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet || !WB.canEdit) return;
  confirmModal({
    title: "Delete this sheet?",
    body: `“${esc(sheet.name)}” and all of its cells will be permanently deleted.`,
    confirmLabel: "Delete sheet", danger: true,
    onConfirm: async () => {
      try {
        const res = await _sb().from("workbook_sheets").delete().eq("id", sheetId);
        if (res.error) throw res.error;
        WB.sheetsByBlock.set(g.blockId, sheets.filter((s) => s.id !== sheetId));
        wbLog("sheet.deleted", `deleted sheet “${sheet.name}”`);
        const remaining = WB.sheetsByBlock.get(g.blockId);
        if (g.sheet.id === sheetId) { g.sheet = remaining[0]; g.block.settings = { ...(g.block.settings || {}), active_sheet_id: g.sheet.id }; saveBlock(g.block, { settings: g.block.settings }); computeGeometry(g); repaintGrid(g); }
        renderSheetTabs(g);
      } catch (e) { _toast("Couldn't delete the sheet: " + ((e && e.message) || e), "error"); }
    },
  });
}

async function moveSheet(g, sheetId, dir) {
  const sheets = (WB.sheetsByBlock.get(g.blockId) || []).slice().sort((a, b) => a.position - b.position);
  const idx = sheets.findIndex((s) => s.id === sheetId);
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= sheets.length) return;
  const [s] = sheets.splice(idx, 1);
  sheets.splice(to, 0, s);
  sheets.forEach((sh, i) => { sh.position = i; });
  WB.sheetsByBlock.set(g.blockId, sheets);
  renderSheetTabs(g);
  try {
    for (const sh of sheets) await _sb().from("workbook_sheets").update({ position: sh.position }).eq("id", sh.id);
  } catch (e) { console.warn("sheet reorder:", e && e.message); }
}

// ─── CSV import / export ────────────────────────────────────────────────────

function usedRange(sheet) {
  let maxR = -1, maxC = -1;
  for (const [key, cell] of sheet.cells) {
    if (cell.value == null && cell.formula == null) continue;
    const { r, c } = keyRC(key);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { maxR, maxC };
}

// CSV-injection guard: values a spreadsheet app would execute get an
// apostrophe prefix (plain negative numbers stay untouched).
function csvSafe(v) {
  const s = String(v ?? "");
  if (/^[=@]/.test(s)) return "'" + s;
  if (/^[+-]/.test(s) && !NUM_RE.test(s)) return "'" + s;
  return s;
}

function exportSheetCsv(g) {
  const sheet = g.sheet;
  const { maxR, maxC } = usedRange(sheet);
  if (maxR < 0) { _toast("This sheet is empty — nothing to export", "info"); return; }
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = sheet.cells.get(cellKey(r, c));
      if (!cell) { row.push(""); continue; }
      row.push(csvSafe(cell.formula ? (cell.err || (cell.computed ?? "")) : (cell.value ?? "")));
    }
    rows.push(row);
  }
  const csv = "﻿" + toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const wbName = (WB.wb && WB.wb.title ? WB.wb.title : "workbook").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "workbook";
  a.download = `${wbName}-${sheet.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "sheet"}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  wbLog("csv.exported", `exported ${sheet.name} as CSV`, { target_type: "sheet", target_id: sheet.id });
  _toast("CSV exported", "success");
}

// ─── Print ───────────────────────────────────────────────────────────────────
// Clean HTML-table rendition of the used range in a popup, which then
// calls window.print() — covers paper and print-to-PDF.

function printSheet(g) {
  const sheet = g.sheet;
  const { maxR, maxC } = usedRange(sheet);
  if (maxR < 0) { _toast("This sheet is empty — nothing to print", "info"); return; }
  const merges = sheetMerges(sheet);
  const covered = new Set();
  for (const m of merges) {
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(cellKey(r, c));
  }
  let rowsHtml = "";
  for (let r = 0; r <= maxR; r++) {
    if (sheet.hiddenRows && sheet.hiddenRows.has(r)) continue;
    let tds = "";
    for (let c = 0; c <= maxC; c++) {
      if (covered.has(cellKey(r, c)) || (sheet.hiddenCols && sheet.hiddenCols.has(c))) continue;
      const cell = sheet.cells.get(cellKey(r, c));
      const m = merges.find((x) => x.r0 === r && x.c0 === c);
      const span = m ? ` colspan="${m.c1 - m.c0 + 1}" rowspan="${m.r1 - m.r0 + 1}"` : "";
      const style = cell ? cellStyle(sheet, r, c, cell) + condStyleFor(sheet, r, c, cell) : "";
      const imgSrc = cell ? cellImgSrc(cell) : null;
      tds += `<td${span} style="${style}">${imgSrc ? `<img src="${imgSrc}" style="display:block;max-width:200px;max-height:140px" alt="">` : esc(cell ? displayValue(sheet, r, c) : "")}</td>`;
    }
    rowsHtml += `<tr>${tds}</tr>`;
  }
  const win = window.open("", "_blank");
  if (!win) { _toast("Allow pop-ups for this site to print", "warn"); return; }
  win.document.write(`<!doctype html><html><head><title>${esc(WB.wb && WB.wb.title ? WB.wb.title : "Workbook")} — ${esc(sheet.name)}</title><style>
    :root{--canvas:#F3F4F6;--border-strong:#9CA3AF;--border-subtle:#E5E7EB;--accent:#2563EB;--red:#B91C1C;--text:#111827;--surface:#fff;--wb-zoom:1;--fs-md:13px}
    body{font:12px -apple-system,system-ui,sans-serif;color:#111827;margin:24px}
    h2{font-size:15px;margin:0 0 2px}
    .sub{margin:0 0 14px;color:#6B7280;font-size:11px}
    table{border-collapse:collapse}
    td{border:1px solid #D1D5DB;padding:3px 7px;max-width:360px;overflow:hidden;white-space:nowrap;vertical-align:middle}
    @media print{body{margin:0}}
  </style></head><body>
    <h2>${esc(WB.wb && WB.wb.title ? WB.wb.title : "Workbook")}</h2>
    <p class="sub">${esc(sheet.name)} · printed ${esc(new Date().toLocaleDateString())}</p>
    <table>${rowsHtml}</table>
    <script>window.onload = function () { window.print(); };<\/script>
  </body></html>`);
  win.document.close();
  wbLog("sheet.printed", `printed ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
}

// ─── Filter views ────────────────────────────────────────────────────────────
// Named snapshots of the AutoFilter state, shared per sheet (persisted
// in sheet.meta.filterViews).

function sheetFilterViews(sheet) {
  const v = sheet.meta && sheet.meta.filterViews;
  return Array.isArray(v) ? v : [];
}

function saveFilterView(g) {
  if (!WB.canEdit) return;
  if (!g.filters.size) { _toast("Set up a filter first, then save it as a view", "info"); return; }
  const name = window.prompt("Name this filter view:", "");
  if (!name || !name.trim()) return;
  const spec = [...g.filters.entries()].map(([col, f]) => ({ col, text: f.text || null, values: f.values ? [...f.values] : null }));
  const views = [...sheetFilterViews(g.sheet), { id: "fv" + Math.random().toString(36).slice(2, 8), name: name.trim().slice(0, 60), filters: spec }];
  g.sheet.meta = { ...(g.sheet.meta || {}), filterViews: views };
  saveSheetMeta(g.sheet.id);
  wbLog("sheet.filterview", `saved filter view “${name.trim()}” on ${g.sheet.name}`, { target_type: "sheet", target_id: g.sheet.id });
  _toast(`Saved filter view “${name.trim()}”`, "success");
}

function applyFilterView(g, viewId) {
  const view = sheetFilterViews(g.sheet).find((v) => v.id === viewId);
  if (!view) return;
  g.filters = new Map(view.filters.map((f) => [f.col, { text: f.text || null, values: f.values ? new Set(f.values) : null }]));
  if (g.filters.size && !g.filterMode) {
    g.filterMode = true;
    g.els.body.querySelector('[data-wb-tb="filter"]')?.classList.add("is-on");
  }
  computeGeometry(g);
  repaintGrid(g);
  persistFilterState(g);
}

function deleteFilterView(g, viewId) {
  if (!WB.canEdit) return;
  g.sheet.meta = { ...(g.sheet.meta || {}), filterViews: sheetFilterViews(g.sheet).filter((v) => v.id !== viewId) };
  saveSheetMeta(g.sheet.id);
}

// ─── Data tools ──────────────────────────────────────────────────────────────
// Sheets Data-menu equivalents: column stats, split text to columns,
// remove duplicates, trim whitespace. All act on the active grid.

function showColumnStats(g) {
  const sheet = g.sheet;
  const col = g.active.c;
  const header = filterCellText(sheet, 0, col);
  let filled = 0, empty = 0, nnum = 0, sum = 0, min = null, max = null;
  const distinct = new Map();
  let maxRow = 0;
  for (const key of sheet.cells.keys()) maxRow = Math.max(maxRow, keyRC(key).r);
  for (let r = 1; r <= maxRow; r++) {
    const t = filterCellText(sheet, r, col);
    if (t === "") { empty++; continue; }
    filled++;
    distinct.set(t, (distinct.get(t) || 0) + 1);
    const cell = sheet.cells.get(cellKey(r, col));
    const raw = cell ? (cell.formula ? (cell.err ? null : cell.computed) : cell.value) : null;
    const n = cellNumeric(raw);
    if (n != null && cell && cell.type !== "text") { nnum++; sum += n; min = min == null ? n : Math.min(min, n); max = max == null ? n : Math.max(max, n); }
  }
  const top = [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const fmtN = (x) => (Math.round(x * 100) / 100).toLocaleString();
  const row = (label, val) => `<div class="wb-kv"><span class="wb-kv-k">${esc(label)}</span><span class="wb-kv-v">${val}</span></div>`;
  document.getElementById("wb-colstats-modal")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-colstats-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Column stats" style="width:420px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Column ${esc(colLabel(col))}${header ? ` — ${esc(header)}` : ""}</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        ${row("Filled cells", String(filled))}
        ${row("Empty (to last data row)", String(empty))}
        ${row("Distinct values", String(distinct.size))}
        ${nnum ? row("Sum", fmtN(sum)) + row("Average", fmtN(sum / nnum)) + row("Min · Max", `${fmtN(min)} · ${fmtN(max)}`) : ""}
        ${top.length ? `<div class="wb-kv"><span class="wb-kv-k">Most frequent</span><span class="wb-kv-v">${top.map(([v, n]) => `${esc(v.slice(0, 24))} <span style="color:var(--text-subtle)">×${n}</span>`).join("<br>")}</span></div>` : ""}
      </div>
      <div class="rr-modal-foot"><button class="rr-modal-btn primary" type="button" data-wb-close>Done</button></div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-wb-close]")) wrap.remove(); });
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
}

function splitTextToColumns(g) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const col = g.active.c;
  const delim = window.prompt(`Split column ${colLabel(col)} on which separator?`, ",");
  if (delim == null || delim === "") return;
  const rect = selRect(g);
  const r0 = rect.r0 === rect.r1 ? 1 : rect.r0; // single cell → all data rows
  let r1 = rect.r0 === rect.r1 ? 0 : rect.r1;
  if (rect.r0 === rect.r1) for (const key of sheet.cells.keys()) r1 = Math.max(r1, keyRC(key).r);
  const rowsToSplit = [];
  let maxParts = 1;
  for (let r = r0; r <= r1; r++) {
    const cell = sheet.cells.get(cellKey(r, col));
    if (!cell || cell.formula || cell.value == null) continue;
    const parts = String(cell.value).split(delim).map((s) => s.trim());
    if (parts.length < 2) continue;
    rowsToSplit.push([r, parts]);
    maxParts = Math.max(maxParts, parts.length);
  }
  if (!rowsToSplit.length) { _toast(`No cells in ${colLabel(col)} contain “${delim}”`, "info"); return; }
  let overwrite = false;
  for (const [r, parts] of rowsToSplit) {
    for (let i = 1; i < parts.length && !overwrite; i++) {
      const t = sheet.cells.get(cellKey(r, col + i));
      if (t && (t.value != null || t.formula)) overwrite = true;
    }
  }
  const apply = () => {
    if (col + maxParts > sheet.colCount) { sheet.colCount = Math.min(200, col + maxParts + 2); saveSheetMeta(sheet.id); computeGeometry(g); }
    const changes = [];
    for (const [r, parts] of rowsToSplit) {
      parts.forEach((p, i) => {
        const prev = sheet.cells.get(cellKey(r, col + i));
        changes.push({ r, c: col + i, cell: cellFromInput(p, prev) });
      });
    }
    setCells(g, changes);
    _toast(`Split ${rowsToSplit.length} cell${rowsToSplit.length === 1 ? "" : "s"} across up to ${maxParts} columns`, "success");
  };
  if (overwrite) {
    confirmModal({
      title: "Overwrite cells to the right?",
      body: `Splitting will write into columns ${esc(colLabel(col + 1))}–${esc(colLabel(col + maxParts - 1))}, and some of those cells already have data.`,
      confirmLabel: "Split anyway", danger: true, onConfirm: apply,
    });
  } else apply();
}

function removeDuplicateRows(g) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  if (sheetMerges(sheet).length) { _toast("Unmerge cells before removing duplicates", "warn"); return; }
  let rect = selRect(g);
  if (rect.r0 === rect.r1 && rect.c0 === rect.c1) {
    const { maxR, maxC } = usedRange(sheet);
    if (maxR < 2) { _toast("Nothing to de-duplicate below the header", "info"); return; }
    rect = { r0: 1, r1: maxR, c0: 0, c1: maxC };
  }
  const seen = new Set();
  const dupRows = [];
  for (let r = Math.max(1, rect.r0); r <= rect.r1; r++) {
    const parts = [];
    for (let c = rect.c0; c <= rect.c1; c++) parts.push(filterCellText(sheet, r, c).toLowerCase());
    const k = parts.join("");
    if (!parts.some((p) => p !== "")) continue; // fully empty rows don't count
    if (seen.has(k)) dupRows.push(r);
    else seen.add(k);
  }
  if (!dupRows.length) { _toast("No duplicate rows found", "success"); return; }
  confirmModal({
    title: `Remove ${dupRows.length} duplicate row${dupRows.length === 1 ? "" : "s"}?`,
    body: `Rows with identical values in columns ${esc(colLabel(rect.c0))}–${esc(colLabel(rect.c1))} will be deleted; the first occurrence stays.`,
    confirmLabel: "Remove duplicates", danger: true,
    onConfirm: () => {
      for (const r of dupRows.sort((a, b) => b - a)) restructure(g, "row", r, -1);
      _toast(`Removed ${dupRows.length} duplicate row${dupRows.length === 1 ? "" : "s"}`, "success");
    },
  });
}

function trimWhitespace(g) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const rect = selRect(g);
  const single = rect.r0 === rect.r1 && rect.c0 === rect.c1;
  const changes = [];
  const scan = (r, c, cell) => {
    if (!cell || cell.formula || typeof cell.value !== "string") return;
    const t = cell.value.replace(/\s+/g, " ").trim();
    if (t !== cell.value) changes.push({ r, c, cell: { ...cloneCell(cell), value: t, type: detectType(t).type } });
  };
  if (single) { for (const [key, cell] of sheet.cells) { const rc = keyRC(key); scan(rc.r, rc.c, cell); } }
  else { for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) scan(r, c, sheet.cells.get(cellKey(r, c))); }
  if (!changes.length) { _toast("No extra whitespace found", "success"); return; }
  setCells(g, changes);
  _toast(`Trimmed whitespace in ${changes.length} cell${changes.length === 1 ? "" : "s"}`, "success");
}

const CSV_MAX_ROWS = 2000, CSV_MAX_COLS = 104;

function importCsvInto(g) {
  if (!WB.canEdit) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv,text/plain";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { _toast("That file is over 5 MB — split it up first", "error"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let matrix;
      try { matrix = parseCsv(String(reader.result || "")); }
      catch (e) { _toast("Couldn't parse that CSV file", "error"); return; }
      if (!matrix.length) { _toast("That CSV file is empty", "warn"); return; }
      let clipped = false;
      if (matrix.length > CSV_MAX_ROWS) { matrix = matrix.slice(0, CSV_MAX_ROWS); clipped = true; }
      matrix = matrix.map((row) => { if (row.length > CSV_MAX_COLS) { clipped = true; return row.slice(0, CSV_MAX_COLS); } return row; });
      const sheet = g.sheet;
      const hasData = usedRange(sheet).maxR >= 0;
      const doImport = () => applyCsvImport(g, matrix, clipped, file.name);
      if (hasData) {
        confirmModal({
          title: "Replace this sheet's data?",
          body: `Importing <strong>${esc(file.name)}</strong> (${matrix.length} row${matrix.length === 1 ? "" : "s"}) will replace everything currently on “${esc(sheet.name)}”.`,
          confirmLabel: "Replace and import", danger: true, onConfirm: doImport,
        });
      } else doImport();
    };
    reader.onerror = () => _toast("Couldn't read that file", "error");
    reader.readAsText(file);
  });
  input.click();
}

function applyCsvImport(g, matrix, clipped, fileName) {
  const sheet = g.sheet;
  const changes = [];
  // clear current contents
  for (const [key, cell] of sheet.cells) {
    const { r, c } = keyRC(key);
    changes.push({ r, c, cell: null });
  }
  // imported values land as plain values — never as live formulas
  matrix.forEach((row, r) => {
    row.forEach((raw, c) => {
      const s = String(raw ?? "");
      if (s === "") return;
      changes.push({ r, c, cell: { value: s, formula: null, type: s.startsWith("=") ? "text" : detectType(s).type, format: r === 0 ? { bold: true, bg: "header" } : {} } });
    });
  });
  if (matrix.length + 20 > sheet.rowCount) sheet.rowCount = Math.min(10000, matrix.length + 40);
  const widest = Math.max(...matrix.map((r) => r.length), 1);
  if (widest > sheet.colCount) sheet.colCount = Math.min(200, Math.max(widest, 26));
  saveSheetMeta(sheet.id);
  computeGeometry(g);
  setCells(g, changes);
  setActive(g, 0, 0);
  wbLog("csv.imported", `imported ${fileName} into ${sheet.name} (${matrix.length} rows)`, { target_type: "sheet", target_id: sheet.id });
  _toast(clipped ? `Imported with clipping — sheets cap at ${CSV_MAX_ROWS} rows × ${CSV_MAX_COLS} columns` : "CSV imported", clipped ? "warn" : "success");
}

// ─── XLSX export ─────────────────────────────────────────────────────────────
// Minimal Office Open XML writer, no dependencies. Zip entries are STORED
// (no compression) — Excel, Sheets, and Numbers all accept that. Formulas
// are exported live (our function surface is a subset of Excel's), values
// keep their types (dates become real Excel date serials), and the core
// formats (bold/italic/underline, fills, text color, alignment, wrap,
// number formats, column widths, frozen panes) survive the trip.

const XLSX_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function xlsxCrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = XLSX_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Zip container with stored entries and a fixed timestamp (deterministic
// output — same workbook, same bytes).
function xlsxZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  for (const f of files) {
    const crc = xlsxCrc32(f.bytes);
    const local = new Uint8Array(30 + f.nameB.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 names
    dv.setUint16(8, 0, true);      // stored
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.bytes.length, true);
    dv.setUint32(22, f.bytes.length, true);
    dv.setUint16(26, f.nameB.length, true);
    local.set(f.nameB, 30);
    chunks.push(local, f.bytes);
    central.push({ nameB: f.nameB, crc, size: f.bytes.length, offset });
    offset += local.length + f.bytes.length;
  }
  const centralStart = offset;
  for (const c of central) {
    const hdr = new Uint8Array(46 + c.nameB.length);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(14, DOS_DATE, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.nameB.length, true);
    dv.setUint32(42, c.offset, true);
    hdr.set(c.nameB, 46);
    chunks.push(hdr);
    offset += hdr.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, offset - centralStart, true);
  dv.setUint32(16, centralStart, true);
  chunks.push(eocd);
  const out = new Uint8Array(offset + 22);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Excel sheet names: no : \ / ? * [ ], 31 chars, unique per workbook.
function xlsxSheetName(name, used) {
  const base = String(name || "Sheet").replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let out = base, i = 2;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 28)} ${i++}`.trim();
  used.add(out.toLowerCase());
  return out;
}

function buildXlsxBytes(sheets) {
  const enc = new TextEncoder();
  const XMLH = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
  const FG_HEX = { muted: "FF6B7280", blue: "FF1E40AF", green: "FF166534", amber: "FF92400E", red: "FFB91C1C" };
  const BG_HEX = { gray: "FFF3F4F6", blue: "FFDBEAFE", green: "FFDCFCE7", amber: "FFFEF3C7", red: "FFFEE2E2", violet: "FFEDE9FE", header: "FFF3F4F6" };
  const NUMFMT = { number: 4, percent: 10, date: 14, text: 49, currency: 164, scientific: 11, accounting: 44 };
  const FONT_NAME = { arial: "Arial", georgia: "Georgia", times: "Times New Roman", courier: "Courier New", verdana: "Verdana", trebuchet: "Trebuchet MS" };

  // dynamic style registries (index 0 = default; fill 1 is zip-required gray125)
  const fonts = [`<font><sz val="11"/><name val="Calibri"/></font>`];
  const fontIdx = new Map([["||||||", 0]]);
  const fills = [`<fill><patternFill patternType="none"/></fill>`, `<fill><patternFill patternType="gray125"/></fill>`];
  const fillIdx = new Map([["", 0]]);
  const BORDER_EDGE = `<color rgb="FF000000"/>`;
  const borderXml = (edges, style) => `<border>` +
    ["left", "right", "top", "bottom"].map((e) => (edges.includes(e) ? `<${e} style="${style || "thin"}">${BORDER_EDGE}</${e}>` : `<${e}/>`)).join("") +
    `<diagonal/></border>`;
  const borders = [borderXml([])];
  const borderIdx = new Map([["", 0]]);
  const xfs = [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`];
  const xfIdx = new Map([["0|0|0||0||0|0", 0]]);

  const styleFor = (cell) => {
    const f = (cell && cell.format) || {};
    const effNum = f.num || (cell && !cell.formula && ["currency", "percent", "date"].includes(cell.type) ? cell.type : null);
    const numId = effNum != null && NUMFMT[effNum] != null ? NUMFMT[effNum] : 0;
    const bold = !!(f.bold || f.bg === "header");
    const fgHex = f.fg ? (HEX_COLOR_RE.test(f.fg) ? "FF" + f.fg.slice(1).toUpperCase() : FG_HEX[f.fg] || "") : "";
    const pt = Number.isInteger(f.fs) ? Math.max(6, Math.round(f.fs * 0.75)) : 11; // px → pt
    const ffName = FONT_NAME[f.ff] || "Calibri";
    const fontKey = `${bold ? "b" : ""}|${f.italic ? "i" : ""}|${f.underline ? "u" : ""}|${f.strike ? "s" : ""}|${fgHex}|${pt === 11 ? "" : pt}|${ffName === "Calibri" ? "" : ffName}`;
    let fontId = fontIdx.get(fontKey);
    if (fontId == null) {
      fontId = fonts.length;
      fonts.push(`<font>${bold ? "<b/>" : ""}${f.italic ? "<i/>" : ""}${f.underline ? "<u/>" : ""}${f.strike ? "<strike/>" : ""}${fgHex ? `<color rgb="${fgHex}"/>` : ""}<sz val="${pt}"/><name val="${ffName}"/></font>`);
      fontIdx.set(fontKey, fontId);
    }
    const bgHex = f.bg ? (HEX_COLOR_RE.test(f.bg) ? "FF" + f.bg.slice(1).toUpperCase() : BG_HEX[f.bg] || "") : "";
    let fillId = fillIdx.get(bgHex);
    if (fillId == null) {
      fillId = fills.length;
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${bgHex}"/><bgColor indexed="64"/></patternFill></fill>`);
      fillIdx.set(bgHex, fillId);
    }
    // per-cell borders: all/outline both mean every edge of the cell;
    // format.bw maps to OOXML line styles (thin/medium/thick)
    const bSide = ["all", "outline", "top", "bottom", "left", "right"].includes(f.border) ? f.border : "";
    const bStyle = bSide ? (f.bw === 3 ? "thick" : f.bw === 2 ? "medium" : "thin") : "";
    const bKey = bSide ? `${bSide}|${bStyle}` : "";
    let borderId = borderIdx.get(bKey);
    if (borderId == null) {
      borderId = borders.length;
      borders.push(borderXml(bSide === "all" || bSide === "outline" ? ["left", "right", "top", "bottom"] : [bSide], bStyle));
      borderIdx.set(bKey, borderId);
    }
    const align = f.align || "";
    const valign = f.valign === "middle" ? "center" : f.valign || "";
    const rot = f.rot === 45 || f.rot === 90 ? f.rot : 0;
    const wrap = f.wrap ? 1 : 0;
    const xfKey = `${numId}|${fontId}|${fillId}|${align}|${wrap}|${valign}|${rot}|${borderId}`;
    let s = xfIdx.get(xfKey);
    if (s == null) {
      s = xfs.length;
      const alignXml = align || wrap || valign || rot
        ? `<alignment${align ? ` horizontal="${align}"` : ""}${valign ? ` vertical="${valign}"` : ""}${wrap ? ` wrapText="1"` : ""}${rot ? ` textRotation="${rot}"` : ""}/>`
        : "";
      xfs.push(`<xf numFmtId="${numId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}"${numId ? ` applyNumberFormat="1"` : ""}${fontId ? ` applyFont="1"` : ""}${fillId ? ` applyFill="1"` : ""}${borderId ? ` applyBorder="1"` : ""}${alignXml ? ` applyAlignment="1"` : ""}>${alignXml}</xf>`);
      xfIdx.set(xfKey, s);
    }
    return s;
  };

  const sheetXml = (sheet) => {
    const links = [];
    const rowsMap = new Map();
    for (const [key, cell] of sheet.cells) {
      if (cell.value == null && cell.formula == null && !(cell.format && Object.keys(cell.format).length)) continue;
      const rc = keyRC(key);
      if (!rowsMap.has(rc.r)) rowsMap.set(rc.r, []);
      rowsMap.get(rc.r).push([rc.c, cell]);
    }
    let body = "";
    for (const r of [...rowsMap.keys()].sort((a, b) => a - b)) {
      let line = `<row r="${r + 1}">`;
      for (const [c, cell] of rowsMap.get(r).sort((a, b) => a[0] - b[0])) {
        const ref = colLabel(c) + (r + 1);
        if (cell.format && cell.format.link) links.push({ ref, url: cell.format.link });
        const s = styleFor(cell);
        const sAttr = s ? ` s="${s}"` : "";
        if (cell.formula) {
          const fx = xmlEsc(String(cell.formula).replace(/^=/, ""));
          const v = cell.err ? null : cell.computed;
          if (typeof v === "number" && isFinite(v)) line += `<c r="${ref}"${sAttr}><f>${fx}</f><v>${v}</v></c>`;
          else if (typeof v === "boolean") line += `<c r="${ref}"${sAttr} t="b"><f>${fx}</f><v>${v ? 1 : 0}</v></c>`;
          else if (v != null && v !== "") line += `<c r="${ref}"${sAttr} t="str"><f>${fx}</f><v>${xmlEsc(String(v))}</v></c>`;
          else line += `<c r="${ref}"${sAttr}><f>${fx}</f></c>`;
          continue;
        }
        const raw = cell.value;
        if (raw == null || raw === "") { if (sAttr) line += `<c r="${ref}"${sAttr}/>`; continue; }
        if (cell.type === "date") {
          const d = parseDateLoose(String(raw));
          if (d) { line += `<c r="${ref}"${sAttr}><v>${dateToSerial(d)}</v></c>`; continue; }
        }
        if (cell.type === "number" || cell.type === "currency" || cell.type === "percent") {
          const n = cellNumeric(raw);
          if (n != null) { line += `<c r="${ref}"${sAttr}><v>${cell.type === "percent" ? n / 100 : n}</v></c>`; continue; }
        }
        if (cell.type === "boolean") { line += `<c r="${ref}"${sAttr} t="b"><v>${/^true$/i.test(String(raw)) ? 1 : 0}</v></c>`; continue; }
        line += `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(raw))}</t></is></c>`;
      }
      body += line + "</row>";
    }
    const wEntries = Object.entries(sheet.colWidths || {}).filter(([, w]) => typeof w === "number");
    const cols = wEntries.length
      ? "<cols>" + wEntries.map(([c, w]) => `<col min="${+c + 1}" max="${+c + 1}" width="${(Math.min(MAX_COL_W, Math.max(MIN_COL_W, w)) / 7).toFixed(2)}" customWidth="1"/>`).join("") + "</cols>"
      : "";
    let view = `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
    if (sheet.frozenRows || sheet.frozenCols) {
      const x = sheet.frozenCols ? 1 : 0, y = sheet.frozenRows ? 1 : 0;
      view = `<sheetViews><sheetView workbookViewId="0"><pane${x ? ` xSplit="${x}"` : ""}${y ? ` ySplit="${y}"` : ""} topLeftCell="${colLabel(x) + (y + 1)}" state="frozen"/></sheetView></sheetViews>`;
    }
    const merges = Array.isArray(sheet.meta && sheet.meta.merges) ? sheet.meta.merges.filter((m) => m.r1 > m.r0 || m.c1 > m.c0) : [];
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${colLabel(m.c0)}${m.r0 + 1}:${colLabel(m.c1)}${m.r1 + 1}"/>`).join("")}</mergeCells>`
      : "";
    const linkXml = links.length
      ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rlk${i + 1}"/>`).join("")}</hyperlinks>`
      : "";
    const xml = `${XMLH}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${view}${cols}<sheetData>${body}</sheetData>${mergeXml}${linkXml}</worksheet>`;
    return { xml, links };
  };

  // sheet XML first — it populates the style registries as it goes
  const sheetParts = sheets.map(sheetXml);
  const used = new Set();
  const names = sheets.map((sh) => xlsxSheetName(sh.name, used));

  const stylesXml = `${XMLH}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs></styleSheet>`;
  const workbookXml = `${XMLH}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const wbRels = `${XMLH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `${XMLH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `${XMLH}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const file = (name, xml) => ({ nameB: enc.encode(name), bytes: enc.encode(xml) });
  const parts = [
    file("[Content_Types].xml", contentTypes),
    file("_rels/.rels", rootRels),
    file("xl/workbook.xml", workbookXml),
    file("xl/_rels/workbook.xml.rels", wbRels),
    file("xl/styles.xml", stylesXml),
    ...sheetParts.map((p, i) => file(`xl/worksheets/sheet${i + 1}.xml`, p.xml)),
  ];
  // hyperlink relationships (one rels part per sheet that has links)
  sheetParts.forEach((p, i) => {
    if (!p.links.length) return;
    const rels = `${XMLH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${p.links.map((l, j) => `<Relationship Id="rlk${j + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(l.url)}" TargetMode="External"/>`).join("")}</Relationships>`;
    parts.push(file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, rels));
  });
  return xlsxZip(parts);
}

function exportBlockXlsx(g) {
  const sheets = (WB.sheetsByBlock.get(g.blockId) || []).slice().sort((a, b) => a.position - b.position);
  if (!sheets.length || sheets.every((sh) => usedRange(sh).maxR < 0)) { _toast("Nothing to export yet", "info"); return; }
  let bytes;
  try { bytes = buildXlsxBytes(sheets); }
  catch (e) { console.warn("xlsx export:", e && e.message); _toast("Couldn't build the Excel file", "error"); return; }
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const wbName = (WB.wb && WB.wb.title ? WB.wb.title : "workbook").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "workbook";
  a.download = `${wbName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  wbLog("xlsx.exported", `exported ${sheets.length === 1 ? `sheet “${sheets[0].name}”` : `${sheets.length} sheets`} as an Excel file`, { target_type: "block", target_id: g.blockId });
  _toast("Excel file exported", "success");
}

// ─── Charts ──────────────────────────────────────────────────────────────────
// Chart specs live flat in sheet.meta.charts ({id, type, title, r0..c1})
// so structural edits shift them like validation/merge rects. Rendered
// as inline SVG cards in a strip under the grid; series values re-read
// from cells on every data change. Palette: the validated 8-slot
// categorical set (fixed order, never cycled) from the dataviz method;
// axis text and gridlines use the app's ink tokens.

const WB_CHART_COLORS = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
const WB_CHART_TYPES = { column: "Column", bar: "Bar", stackcol: "Stacked column", stackbar: "Stacked bar", line: "Line", area: "Area", combo: "Combo (columns + line)", scatter: "Scatter", pie: "Pie" };

function sheetCharts(sheet) {
  const v = sheet.meta && sheet.meta.charts;
  return Array.isArray(v) ? v : [];
}

function chartRefText(ch) {
  return colLabel(ch.c0) + (ch.r0 + 1) + ":" + colLabel(ch.c1) + (ch.r1 + 1);
}

// Range → {categories, series:[{name, values}]}. Row 1 of the range is
// treated as headers; the first column as category labels when it isn't
// numeric. A single-column range becomes one series over row numbers.
function chartData(sheet, ch) {
  const r1 = Math.min(ch.r1, sheet.rowCount - 1), c1 = Math.min(ch.c1, sheet.colCount - 1);
  const rawOf = (r, c) => {
    const cell = sheet.cells.get(cellKey(r, c));
    return cell ? (cell.formula ? (cell.err ? null : cell.computed) : cell.value) : null;
  };
  const numOf = (r, c) => {
    const cell = sheet.cells.get(cellKey(r, c));
    if (!cell || cell.type === "text") return null;
    return cellNumeric(cell.formula ? (cell.err ? null : cell.computed) : cell.value);
  };
  const single = c1 === ch.c0;
  const firstDataCol = single ? ch.c0 : ch.c0 + 1;
  const categories = [];
  const series = [];
  for (let c = firstDataCol; c <= c1; c++) {
    series.push({ name: String(rawOf(ch.r0, c) ?? colLabel(c)), values: [] });
  }
  for (let r = ch.r0 + 1; r <= r1; r++) {
    const label = single ? String(r + 1) : String(rawOf(r, ch.c0) ?? r + 1);
    let any = false;
    const rowVals = series.map((s, i) => {
      const v = numOf(r, firstDataCol + i);
      if (v != null) any = true;
      return v;
    });
    if (!any && label.trim() === "") continue;
    categories.push(label);
    rowVals.forEach((v, i) => series[i].values.push(v));
  }
  return { categories, series: series.filter((s) => s.values.some((v) => v != null)) };
}

function chartNiceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) hi = lo + 1;
  const span = hi - lo;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step0;
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const top = Math.ceil(hi / step) * step; // domain must cover the max
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function chartFmt(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "M";
  if (a >= 1e4) return (v / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "k";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Rounded data-end bar anchored to the baseline (spec: only the value
// end is rounded).
function chartBarPath(x, y, w, h, up, color, title) {
  const r = Math.min(4, w / 2, h);
  const d = up
    ? `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
    : `M${x},${y} L${x + w},${y} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} Z`;
  return `<path d="${d}" fill="${color}"><title>${title}</title></path>`;
}

function chartSvg(sheet, ch) {
  const { categories, series } = chartData(sheet, ch);
  if (!categories.length || !series.length) {
    return { svg: `<div class="wb-chart-empty">No numeric data in ${esc(chartRefText(ch))} yet.</div>`, legend: "" };
  }
  const color = (i) => WB_CHART_COLORS[i % WB_CHART_COLORS.length];
  const t = (s) => esc(String(s));

  if (ch.type === "pie") {
    const s0 = series[0];
    let entries = categories.map((label, i) => ({ label, v: Math.max(0, s0.values[i] ?? 0) })).filter((e) => e.v > 0);
    if (entries.length > 8) {
      const rest = entries.slice(7).reduce((a, e) => a + e.v, 0);
      entries = [...entries.slice(0, 7), { label: "Other", v: rest }];
    }
    const total = entries.reduce((a, e) => a + e.v, 0);
    if (!total) return { svg: `<div class="wb-chart-empty">Nothing to chart in ${esc(chartRefText(ch))}.</div>`, legend: "" };
    const CX = 240, CY = 110, R = 92;
    let a0 = -Math.PI / 2;
    let paths = "";
    entries.forEach((e, i) => {
      const frac = e.v / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0);
      const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
      paths += frac >= 0.999
        ? `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${color(i)}"><title>${t(e.label)} — ${chartFmt(e.v)} (${Math.round(frac * 100)}%)</title></circle>`
        : `<path d="M${CX},${CY} L${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} Z" fill="${color(i)}" stroke="var(--surface)" stroke-width="2"><title>${t(e.label)} — ${chartFmt(e.v)} (${Math.round(frac * 100)}%)</title></path>`;
      a0 = a1;
    });
    const legend = entries.map((e, i) =>
      `<span class="wb-chart-key"><span class="wb-chart-swatch" style="background:${color(i)}"></span>${t(e.label)} <span class="wb-chart-keyv">${Math.round((e.v / total) * 100)}%</span></span>`).join("");
    return { svg: `<svg viewBox="0 0 480 220" role="img" aria-label="${t(ch.title || "Pie chart")}">${paths}</svg>`, legend };
  }

  if (ch.type === "scatter") {
    // first data column = X (numeric), each further column = a Y series;
    // if X isn't numeric, fall back to the row index
    const xs = categories.map((lb, i) => { const n = Number(lb); return isFinite(n) && lb !== "" ? n : i; });
    const W = 480, H = 220, padL = 46, padR = 12, padT = 10, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const ys = series.flatMap((s) => s.values).filter((v) => v != null);
    if (!ys.length) return { svg: `<div class="wb-chart-empty">No numeric data in ${esc(chartRefText(ch))} yet.</div>`, legend: "" };
    const xt = chartNiceTicks(Math.min(...xs), Math.max(...xs));
    const yt = chartNiceTicks(Math.min(0, ...ys), Math.max(...ys));
    const xLo = xt[0], xHi = xt[xt.length - 1], yLo = yt[0], yHi = yt[yt.length - 1];
    const px = (v) => padL + ((v - xLo) / (xHi - xLo || 1)) * plotW;
    const py = (v) => padT + plotH - ((v - yLo) / (yHi - yLo || 1)) * plotH;
    let out = "";
    for (const tk of yt) { out += `<line x1="${padL}" y1="${py(tk)}" x2="${W - padR}" y2="${py(tk)}" stroke="var(--border-subtle)" stroke-width="1"/><text x="${padL - 6}" y="${py(tk) + 3}" text-anchor="end" class="wb-chart-tick">${chartFmt(tk)}</text>`; }
    for (const tk of xt) { out += `<text x="${px(tk)}" y="${H - 8}" text-anchor="middle" class="wb-chart-tick">${chartFmt(tk)}</text>`; }
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v == null) return;
        out += `<circle cx="${px(xs[i])}" cy="${py(v)}" r="3.5" fill="${color(si)}" fill-opacity="0.85"><title>(${chartFmt(xs[i])}, ${chartFmt(v)}) · ${t(s.name)}</title></circle>`;
      });
    });
    out += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border-strong)" stroke-width="1"/>`;
    const legend = series.length > 1 ? series.map((s, si) => `<span class="wb-chart-key"><span class="wb-chart-swatch" style="background:${color(si)}"></span>${t(s.name)}</span>`).join("") : "";
    return { svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t(ch.title || "Scatter chart")}">${out}</svg>`, legend };
  }

  // shared cartesian frame
  const W = 480, H = 220, padL = 46, padR = 10, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const stacked = ch.type === "stackcol" || ch.type === "stackbar";
  const combo = ch.type === "combo";
  const horizontal = ch.type === "bar" || ch.type === "stackbar";
  let lo = 0, hi = 1;
  const allVals = series.flatMap((s) => s.values).filter((v) => v != null);
  if (allVals.length) { lo = Math.min(...allVals), hi = Math.max(...allVals); }
  if (stacked) {
    // domain covers the per-category positive / negative running totals
    lo = 0; hi = 0;
    for (let i = 0; i < categories.length; i++) {
      let pos = 0, neg = 0;
      series.forEach((s) => { const v = s.values[i]; if (v > 0) pos += v; else if (v < 0) neg += v; });
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    }
  } else if (ch.type !== "line") { lo = Math.min(0, lo); hi = Math.max(0, hi); } // bars/areas keep a zero baseline
  const ticks = chartNiceTicks(lo, hi);
  lo = ticks[0]; hi = ticks[ticks.length - 1];
  const span = hi - lo || 1;
  const vx = (v) => padL + ((v - lo) / span) * plotW;   // horizontal value axis (bar)
  const vy = (v) => padT + plotH - ((v - lo) / span) * plotH;
  let out = "";

  // gridlines + value axis labels (recessive ink)
  for (const tk of ticks) {
    if (horizontal) {
      out += `<line x1="${vx(tk)}" y1="${padT}" x2="${vx(tk)}" y2="${padT + plotH}" stroke="var(--border-subtle)" stroke-width="1"/>`;
      out += `<text x="${vx(tk)}" y="${H - 8}" text-anchor="middle" class="wb-chart-tick">${chartFmt(tk)}</text>`;
    } else {
      out += `<line x1="${padL}" y1="${vy(tk)}" x2="${W - padR}" y2="${vy(tk)}" stroke="var(--border-subtle)" stroke-width="1"/>`;
      out += `<text x="${padL - 6}" y="${vy(tk) + 3}" text-anchor="end" class="wb-chart-tick">${chartFmt(tk)}</text>`;
    }
  }

  const nCat = categories.length;
  const catLabel = (label, i) => {
    const step = Math.ceil(nCat / (horizontal ? 12 : 8));
    if (i % step !== 0) return "";
    const short = String(label).slice(0, horizontal ? 9 : 10);
    return horizontal
      ? `<text x="${padL - 6}" y="${padT + ((i + 0.5) / nCat) * plotH + 3}" text-anchor="end" class="wb-chart-tick">${t(short)}</text>`
      : `<text x="${padL + ((i + 0.5) / nCat) * plotW}" y="${H - 8}" text-anchor="middle" class="wb-chart-tick">${t(short)}</text>`;
  };
  categories.forEach((label, i) => { out += catLabel(label, i); });

  if (ch.type === "column" || ch.type === "bar" || stacked || combo) {
    const band = (horizontal ? plotH : plotW) / nCat;
    const inner = band * 0.72;
    // combo draws all-but-last series as grouped columns and overlays the
    // last as a line; a single-series combo is just a line
    const barSeries = combo ? series.slice(0, Math.max(1, series.length - 1)) : series;
    const nBars = stacked ? 1 : barSeries.length;
    const bw = stacked ? inner : Math.max(3, (inner - (nBars - 1) * 2) / nBars);
    categories.forEach((label, i) => {
      if (stacked) {
        let posAcc = 0, negAcc = 0;
        const off = (horizontal ? padT : padL) + i * band + (band - inner) / 2;
        series.forEach((s, si) => {
          const v = s.values[i];
          if (v == null || v === 0) return;
          const base = v >= 0 ? posAcc : negAcc;
          const title = `${t(label)} · ${t(s.name)}: ${chartFmt(v)}`;
          if (horizontal) { const a = vx(base), b = vx(base + v); out += `<rect x="${Math.min(a, b)}" y="${off}" width="${Math.abs(b - a)}" height="${inner}" fill="${color(si)}"><title>${title}</title></rect>`; }
          else { const a = vy(base), b = vy(base + v); out += `<rect x="${off}" y="${Math.min(a, b)}" width="${inner}" height="${Math.abs(b - a)}" fill="${color(si)}"><title>${title}</title></rect>`; }
          if (v >= 0) posAcc += v; else negAcc += v;
        });
        return;
      }
      barSeries.forEach((s, si) => {
        const v = s.values[i];
        if (v == null) return;
        const off = (horizontal ? padT : padL) + i * band + (band - inner) / 2 + si * (bw + 2);
        const title = `${t(label)} · ${t(s.name)}: ${chartFmt(v)}`;
        if (horizontal) {
          const x0 = vx(Math.min(0, v)), x1 = vx(Math.max(0, v));
          const r = Math.min(4, (x1 - x0), bw / 2);
          out += `<path d="M${x0},${off} L${x1 - r},${off} Q${x1},${off} ${x1},${off + r} L${x1},${off + bw - r} Q${x1},${off + bw} ${x1 - r},${off + bw} L${x0},${off + bw} Z" fill="${color(si)}"><title>${title}</title></path>`;
        } else {
          const y0 = vy(Math.max(0, v)), y1 = vy(Math.min(0, v));
          out += chartBarPath(off, y0, bw, Math.max(1, y1 - y0), v >= 0, color(si), title);
        }
      });
    });
    // combo line overlay (the last series), plotted over the category midpoints
    if (combo && series.length > 1) {
      const s = series[series.length - 1], si = series.length - 1;
      const cx = (i) => padL + ((i + 0.5) / nCat) * plotW;
      const pts = [];
      s.values.forEach((v, i) => { if (v != null) pts.push([cx(i), vy(v), i, v]); });
      if (pts.length) {
        out += `<path d="${pts.map((p, k) => `${k ? "L" : "M"}${p[0]},${p[1]}`).join(" ")}" fill="none" stroke="${color(si)}" stroke-width="2.5" stroke-linejoin="round"/>`;
        for (const [x, y, i, v] of pts) out += `<circle cx="${x}" cy="${y}" r="3" fill="${color(si)}"><title>${t(categories[i])} · ${t(s.name)}: ${chartFmt(v)}</title></circle>`;
      }
    }
    // zero baseline
    if (horizontal) out += `<line x1="${vx(0)}" y1="${padT}" x2="${vx(0)}" y2="${padT + plotH}" stroke="var(--border-strong)" stroke-width="1"/>`;
    else out += `<line x1="${padL}" y1="${vy(0)}" x2="${W - padR}" y2="${vy(0)}" stroke="var(--border-strong)" stroke-width="1"/>`;
  } else {
    // line / area over category midpoints
    const cx = (i) => padL + ((i + 0.5) / nCat) * plotW;
    series.forEach((s, si) => {
      const pts = [];
      s.values.forEach((v, i) => { if (v != null) pts.push([cx(i), vy(v), i, v]); });
      if (!pts.length) return;
      const line = pts.map((p, k) => `${k ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
      if (ch.type === "area" && series.length === 1) {
        out += `<path d="${line} L${pts[pts.length - 1][0]},${vy(Math.max(lo, 0))} L${pts[0][0]},${vy(Math.max(lo, 0))} Z" fill="${color(si)}29"/>`;
      }
      out += `<path d="${line}" fill="none" stroke="${color(si)}" stroke-width="2" stroke-linejoin="round"/>`;
      for (const [x, y, i, v] of pts) {
        out += `<circle cx="${x}" cy="${y}" r="3" fill="${color(si)}"><title>${t(categories[i])} · ${t(s.name)}: ${chartFmt(v)}</title></circle>`;
      }
    });
    out += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border-strong)" stroke-width="1"/>`;
  }

  const legend = series.length > 1
    ? series.map((s, si) => `<span class="wb-chart-key"><span class="wb-chart-swatch" style="background:${color(si)}"></span>${t(s.name)}</span>`).join("")
    : "";
  return { svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t(ch.title || WB_CHART_TYPES[ch.type] + " chart")}">${out}</svg>`, legend };
}

function renderCharts(g) {
  const host = g.els.charts;
  if (!host) return;
  const charts = sheetCharts(g.sheet);
  if (!charts.length) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = charts.map((ch) => {
    const { svg, legend } = chartSvg(g.sheet, ch);
    return `<div class="wb-chart-card" data-wb-chart="${esc(ch.id)}">
      <div class="wb-chart-head">
        <span class="wb-chart-title">${esc(ch.title || `${WB_CHART_TYPES[ch.type] || "Chart"} · ${chartRefText(ch)}`)}</span>
        ${WB.canEdit ? `<button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-chartact="edit" title="Edit chart" aria-label="Edit chart"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-chartact="delete" title="Delete chart" aria-label="Delete chart">×</button>` : ""}
      </div>
      ${legend ? `<div class="wb-chart-legend">${legend}</div>` : ""}
      ${svg}
    </div>`;
  }).join("");
}

function scheduleChartRender(g) {
  if (!g.els.charts) return;
  clearTimeout(g.chartsT);
  g.chartsT = setTimeout(() => { renderCharts(g); renderPivots(g); }, 250);
}

function parseRangeRefText(s) {
  const m = String(s || "").trim().split(":");
  if (m.length !== 2) return null;
  const a = parseCellRef(m[0]), b = parseCellRef(m[1]);
  if (!a || !b) return null;
  return { r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) };
}

function openChartDialog(g, existing) {
  if (!WB.canEdit) return;
  document.getElementById("wb-chart-modal")?.remove();
  const rect = selRect(g);
  const defRef = existing ? chartRefText(existing) : `${colLabel(rect.c0)}${rect.r0 + 1}:${colLabel(rect.c1)}${rect.r1 + 1}`;
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-chart-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="${existing ? "Edit chart" : "Insert chart"}" style="width:460px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">${existing ? "Edit chart" : "Insert chart"}</p><p class="rr-modal-sub">Row 1 of the range holds series names; the first column holds labels.</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <label class="wb-field"><span class="wb-field-label">Title <span class="wb-field-opt">optional</span></span>
          <input type="text" class="wb-input" id="wb-chart-title" maxlength="120" value="${esc((existing && existing.title) || "")}" placeholder="Routes per day"></label>
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Chart type</span>
            <select class="wb-input" id="wb-chart-type">
              ${Object.entries(WB_CHART_TYPES).map(([k, label]) => `<option value="${k}" ${(existing ? existing.type : "column") === k ? "selected" : ""}>${label}</option>`).join("")}
            </select></label>
          <label class="wb-field"><span class="wb-field-label">Data range</span>
            <input type="text" class="wb-input" id="wb-chart-range" value="${esc(defRef)}" placeholder="A1:C8" spellcheck="false"></label>
        </div>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-wb-chart-save>${existing ? "Save" : "Insert chart"}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (!e.target.closest("[data-wb-chart-save]")) return;
    const range = parseRangeRefText(wrap.querySelector("#wb-chart-range").value);
    if (!range) { _toast("Enter a range like A1:C8", "warn"); return; }
    if (range.r1 - range.r0 > 500 || range.c1 - range.c0 > 9) { _toast("Chart ranges cap at 500 rows × 10 columns", "warn"); return; }
    const spec = {
      id: existing ? existing.id : "ch" + Math.random().toString(36).slice(2, 8),
      type: wrap.querySelector("#wb-chart-type").value,
      title: wrap.querySelector("#wb-chart-title").value.trim(),
      ...range,
    };
    const charts = sheetCharts(g.sheet).filter((c) => c.id !== spec.id);
    charts.push(spec);
    g.sheet.meta = { ...(g.sheet.meta || {}), charts };
    saveSheetMeta(g.sheet.id);
    wbLog("sheet.chart", `${existing ? "updated" : "added"} a ${WB_CHART_TYPES[spec.type].toLowerCase()} chart on ${chartRefText(spec)} in ${g.sheet.name}`, { target_type: "sheet", target_id: g.sheet.id });
    wrap.remove();
    renderCharts(g);
    g.els.charts?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  setTimeout(() => wrap.querySelector("#wb-chart-title")?.focus(), 30);
}

function deleteChart(g, chartId) {
  if (!WB.canEdit) return;
  g.sheet.meta = { ...(g.sheet.meta || {}), charts: sheetCharts(g.sheet).filter((c) => c.id !== chartId) };
  saveSheetMeta(g.sheet.id);
  renderCharts(g);
}

// ─── Pivot tables ────────────────────────────────────────────────────────────
// A pivot lives on its sheet (sheet.meta.pivots), reads a source range whose
// first row is a header, and renders an aggregated table below the grid.
// rows/cols are grouping dimensions; values aggregate a field per cell.

const WB_PIVOT_AGGS = { sum: "Sum", count: "Count", avg: "Average", min: "Min", max: "Max", countunique: "Count unique" };
const PIVOT_MAX_ROWS = 20000;

function sheetPivots(sheet) {
  const v = sheet.meta && sheet.meta.pivots;
  return Array.isArray(v) ? v : [];
}

function pivotRefText(spec) { return colLabel(spec.c0) + (spec.r0 + 1) + ":" + colLabel(spec.c1) + (spec.r1 + 1); }

// Source range → { fields:[header names], records:[{field: value}] }.
function pivotSource(sheet, spec) {
  const r0 = spec.r0, c0 = spec.c0, r1 = Math.min(spec.r1, sheet.rowCount - 1, spec.r0 + PIVOT_MAX_ROWS), c1 = Math.min(spec.c1, sheet.colCount - 1);
  const rawOf = (r, c) => { const cell = sheet.cells.get(cellKey(r, c)); return cell ? (cell.formula ? (cell.err ? null : cell.computed) : cell.value) : null; };
  const fields = [];
  for (let c = c0; c <= c1; c++) fields.push(String(rawOf(r0, c) ?? colLabel(c)));
  const records = [];
  for (let r = r0 + 1; r <= r1; r++) {
    const rec = {}; let any = false;
    for (let c = c0; c <= c1; c++) { const v = rawOf(r, c); rec[fields[c - c0]] = v; if (v != null && v !== "") any = true; }
    if (any) records.push(rec);
  }
  return { fields, records };
}

function pivotAggregate(agg, vals) {
  const nums = vals.map((v) => cellNumeric(v)).filter((v) => v != null);
  switch (agg) {
    case "count": return vals.filter((v) => v != null && v !== "").length;
    case "countunique": return new Set(vals.filter((v) => v != null && v !== "").map(String)).size;
    case "avg": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "min": return nums.length ? Math.min(...nums) : null;
    case "max": return nums.length ? Math.max(...nums) : null;
    case "sum": default: return nums.reduce((a, b) => a + b, 0);
  }
}

// Pure computation → grouping keys + an aggregate accessor that re-aggregates
// over the underlying records (so totals of averages stay correct).
function computePivot(sheet, spec) {
  const { records } = pivotSource(sheet, spec);
  const rowFields = (spec.rows || []).filter(Boolean);
  const colFields = (spec.cols || []).filter(Boolean);
  const values = (spec.values || []).filter((v) => v && v.field);
  if (!values.length) return null;
  const filt = (spec.filters || []).filter((f) => f && f.field && Array.isArray(f.values) && f.values.length);
  const keyed = records.filter((rec) => filt.every((f) => f.values.map(String).includes(String(rec[f.field] ?? ""))));
  const rowKey = (rec) => rowFields.map((f) => String(rec[f] ?? "")).join(" · ");
  const colKey = (rec) => colFields.map((f) => String(rec[f] ?? "")).join(" · ");
  const rowSeen = new Set(), colSeen = new Set(), rowKeys = [], colKeys = [];
  for (const rec of keyed) {
    const rk = rowKey(rec); if (!rowSeen.has(rk)) { rowSeen.add(rk); rowKeys.push(rk); }
    const ck = colKey(rec); if (!colSeen.has(ck)) { colSeen.add(ck); colKeys.push(ck); }
  }
  rowKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  colKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // rk/ck === null means "all" (used for totals)
  const aggOf = (rk, ck, vi) => {
    const v = values[vi];
    const recs = keyed.filter((rec) => (rk == null || rowKey(rec) === rk) && (ck == null || colKey(rec) === ck));
    return pivotAggregate(v.agg, recs.map((r) => r[v.field]));
  };
  return { rowFields, colFields, values, rowKeys, colKeys, aggOf, records: keyed };
}

function pivotNumFmt(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") return (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return esc(String(v));
}

function pivotTableHtml(sheet, spec) {
  const p = computePivot(sheet, spec);
  if (!p) return `<div class="wb-chart-empty">Add at least one value field to this pivot.</div>`;
  if (!p.records.length || !p.rowKeys.length) return `<div class="wb-chart-empty">No data to summarize in ${esc(pivotRefText(spec))} yet.</div>`;
  const nv = p.values.length;
  const hasCols = p.colFields.length > 0 && p.colKeys.length > 0;
  const rowHdrs = p.rowFields.length ? p.rowFields : ["Total"];
  const vlab = (vi) => esc(`${WB_PIVOT_AGGS[p.values[vi].agg] || ""} of ${p.values[vi].field}`);
  // column groups: each colKey, then a Grand Total group (only when cols exist)
  const groups = hasCols ? [...p.colKeys.map((ck) => ({ ck, label: ck || "(blank)" })), { ck: null, label: "Grand total" }] : [{ ck: "", label: null }];

  let thead;
  if (hasCols) {
    const r1 = rowHdrs.map((h) => `<th rowspan="2" class="wb-pv-rh">${esc(h)}</th>`).join("") +
      groups.map((gp) => `<th colspan="${nv}" class="wb-pv-ch">${esc(gp.label)}</th>`).join("");
    const r2 = groups.map(() => p.values.map((_, vi) => `<th class="wb-pv-vh">${vlab(vi)}</th>`).join("")).join("");
    thead = `<tr>${r1}</tr><tr>${r2}</tr>`;
  } else {
    thead = `<tr>${rowHdrs.map((h) => `<th class="wb-pv-rh">${esc(h)}</th>`).join("")}${p.values.map((_, vi) => `<th class="wb-pv-vh">${vlab(vi)}</th>`).join("")}</tr>`;
  }

  const bodyRows = p.rowKeys.map((rk) => {
    const parts = p.rowFields.length ? rk.split(" · ") : ["Total"];
    const rhCells = rowHdrs.map((_, i) => `<td class="wb-pv-rk">${esc(parts[i] ?? "")}</td>`).join("");
    const dataCells = groups.map((gp) => p.values.map((_, vi) => `<td class="wb-pv-num">${pivotNumFmt(p.aggOf(rk, gp.ck, vi))}</td>`).join("")).join("");
    return `<tr>${rhCells}${dataCells}</tr>`;
  }).join("");

  // grand total row
  const gtLabel = `<td class="wb-pv-rk wb-pv-gt" colspan="${rowHdrs.length}">Grand total</td>`;
  const gtCells = groups.map((gp) => p.values.map((_, vi) => `<td class="wb-pv-num wb-pv-gt">${pivotNumFmt(p.aggOf(null, gp.ck, vi))}</td>`).join("")).join("");
  const foot = `<tr>${gtLabel}${gtCells}</tr>`;

  return `<div class="wb-pv-scroll"><table class="wb-pv-table"><thead>${thead}</thead><tbody>${bodyRows}${foot}</tbody></table></div>`;
}

function renderPivots(g) {
  const host = g.els.pivots;
  if (!host) return;
  const pivots = sheetPivots(g.sheet);
  if (!pivots.length) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = pivots.map((pv) => {
    let table;
    try { table = pivotTableHtml(g.sheet, pv); }
    catch (e) { table = `<div class="wb-chart-empty">Couldn't build this pivot.</div>`; }
    return `<div class="wb-pivot-card" data-wb-pivot="${esc(pv.id)}">
      <div class="wb-chart-head">
        <span class="wb-chart-title">${esc(pv.title || `Pivot · ${pivotRefText(pv)}`)}</span>
        ${WB.canEdit ? `<button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-pivotact="edit" title="Edit pivot" aria-label="Edit pivot"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-pivotact="delete" title="Delete pivot" aria-label="Delete pivot">×</button>` : ""}
      </div>
      ${table}
    </div>`;
  }).join("");
}

function deletePivot(g, pivotId) {
  if (!WB.canEdit) return;
  g.sheet.meta = { ...(g.sheet.meta || {}), pivots: sheetPivots(g.sheet).filter((p) => p.id !== pivotId) };
  saveSheetMeta(g.sheet.id);
  renderPivots(g);
}

function openPivotDialog(g, existing) {
  if (!WB.canEdit) return;
  document.getElementById("wb-pivot-modal")?.remove();
  const sheet = g.sheet;
  const rect = selRect(g);
  const spec = existing || { r0: rect.r0, c0: rect.c0, r1: rect.r1, c1: rect.c1, rows: [], cols: [], values: [] };
  const fieldsOf = () => pivotSource(sheet, spec).fields;
  let fields = fieldsOf();
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-pivot-modal";
  const fieldOpts = (sel) => `<option value=""></option>` + fields.map((f) => `<option value="${esc(f)}" ${f === sel ? "selected" : ""}>${esc(f)}</option>`).join("");
  const aggOpts = (sel) => Object.entries(WB_PIVOT_AGGS).map(([k, l]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${l}</option>`).join("");
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="${existing ? "Edit pivot table" : "Pivot table"}" style="width:560px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">${existing ? "Edit pivot table" : "Pivot table"}</p><p class="rr-modal-sub">Summarize a range whose first row is a header.</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <label class="wb-field"><span class="wb-field-label">Source range</span>
          <input type="text" class="wb-input" id="wb-pv-range" value="${esc(pivotRefText(spec))}" placeholder="A1:F200" spellcheck="false"></label>
        <div class="wb-field-row" style="margin-top:10px">
          <label class="wb-field"><span class="wb-field-label">Rows — group by</span>
            <select class="wb-input" id="wb-pv-row1">${fieldOpts(spec.rows && spec.rows[0])}</select></label>
          <label class="wb-field"><span class="wb-field-label">then by <span class="wb-field-opt">optional</span></span>
            <select class="wb-input" id="wb-pv-row2">${fieldOpts(spec.rows && spec.rows[1])}</select></label>
        </div>
        <label class="wb-field" style="margin-top:10px"><span class="wb-field-label">Columns — split across <span class="wb-field-opt">optional</span></span>
          <select class="wb-input" id="wb-pv-col">${fieldOpts(spec.cols && spec.cols[0])}</select></label>
        <div class="wb-field-row" style="margin-top:10px">
          <label class="wb-field"><span class="wb-field-label">Values — summarize</span>
            <select class="wb-input" id="wb-pv-val1">${fieldOpts(spec.values && spec.values[0] && spec.values[0].field)}</select></label>
          <label class="wb-field" style="flex:0 0 150px"><span class="wb-field-label">as</span>
            <select class="wb-input" id="wb-pv-agg1">${aggOpts(spec.values && spec.values[0] && spec.values[0].agg || "sum")}</select></label>
        </div>
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">and <span class="wb-field-opt">optional</span></span>
            <select class="wb-input" id="wb-pv-val2">${fieldOpts(spec.values && spec.values[1] && spec.values[1].field)}</select></label>
          <label class="wb-field" style="flex:0 0 150px"><span class="wb-field-label">as</span>
            <select class="wb-input" id="wb-pv-agg2">${aggOpts(spec.values && spec.values[1] && spec.values[1].agg || "sum")}</select></label>
        </div>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-wb-pv-save>${existing ? "Save" : "Create pivot"}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  // reload field lists when the range changes
  const reloadFields = () => {
    const rng = parseRangeRefText(wrap.querySelector("#wb-pv-range").value);
    if (!rng) return;
    spec.r0 = rng.r0; spec.c0 = rng.c0; spec.r1 = rng.r1; spec.c1 = rng.c1;
    fields = fieldsOf();
    for (const [id, cur] of [["wb-pv-row1", spec.rows && spec.rows[0]], ["wb-pv-row2", spec.rows && spec.rows[1]], ["wb-pv-col", spec.cols && spec.cols[0]], ["wb-pv-val1", spec.values && spec.values[0] && spec.values[0].field], ["wb-pv-val2", spec.values && spec.values[1] && spec.values[1].field]]) {
      const sel = wrap.querySelector("#" + id); const keep = sel.value || cur;
      sel.innerHTML = fieldOpts(keep);
    }
  };
  wrap.querySelector("#wb-pv-range").addEventListener("change", reloadFields);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (!e.target.closest("[data-wb-pv-save]")) return;
    const rng = parseRangeRefText(wrap.querySelector("#wb-pv-range").value);
    if (!rng) { _toast("Enter a range like A1:F200", "warn"); return; }
    const rows = [wrap.querySelector("#wb-pv-row1").value, wrap.querySelector("#wb-pv-row2").value].filter(Boolean);
    const cols = [wrap.querySelector("#wb-pv-col").value].filter(Boolean);
    const values = [
      { field: wrap.querySelector("#wb-pv-val1").value, agg: wrap.querySelector("#wb-pv-agg1").value },
      { field: wrap.querySelector("#wb-pv-val2").value, agg: wrap.querySelector("#wb-pv-agg2").value },
    ].filter((v) => v.field);
    if (!rows.length) { _toast("Pick at least one Rows field", "warn"); return; }
    if (!values.length) { _toast("Pick at least one Values field", "warn"); return; }
    const next = { id: existing ? existing.id : "pv" + Math.random().toString(36).slice(2, 8), ...rng, rows, cols, values, title: existing ? existing.title : "" };
    const pivots = sheetPivots(sheet).filter((p) => p.id !== next.id);
    pivots.push(next);
    g.sheet.meta = { ...(g.sheet.meta || {}), pivots };
    saveSheetMeta(sheet.id);
    wbLog("sheet.pivot", `${existing ? "updated" : "created"} a pivot table on ${pivotRefText(next)} in ${sheet.name}`, { target_type: "sheet", target_id: sheet.id });
    wrap.remove();
    renderPivots(g);
    g.els.pivots?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  setTimeout(() => wrap.querySelector("#wb-pv-range")?.focus(), 30);
}

// ─── Menus (shared open/close discipline) ───────────────────────────────────

function closeAllPopovers() {
  document.querySelectorAll(".popover.open").forEach((p) => p.classList.remove("open"));
  document.querySelectorAll(".wb-ctx-menu").forEach((m) => m.remove());
}
function cancelMenusFrom() { closeAllPopovers(); }

function togglePopover(anchorBtn) {
  const pop = anchorBtn.closest(".popover-anchor")?.querySelector(".popover");
  if (!pop) return;
  const wasOpen = pop.classList.contains("open");
  closeAllPopovers();
  if (!wasOpen) { pop.classList.add("open"); clampPopover(pop); }
}

// Keep a just-opened popover inside the viewport: toolbar popovers are
// left-aligned to their trigger, so the rightmost ones (the ⋮ menu) run
// off the right edge — flip those to right-aligned. Uses offsetWidth (the
// untransformed layout width) so the open animation's scale doesn't skew
// the measurement.
function clampPopover(pop) {
  pop.style.left = ""; pop.style.right = "";
  const anchor = pop.closest(".popover-anchor");
  if (!anchor) return;
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const margin = 8;
  if (a.left + w > window.innerWidth - margin) { pop.style.left = "auto"; pop.style.right = "0"; }
}

// ─── Grid event binding ─────────────────────────────────────────────────────

function bindGridEvents(g) {
  const grid = g.els.grid;
  const scroll = g.els.scroll;

  // menu-bar actions target the last grid the operator touched
  grid.addEventListener("focus", () => { WB.activeGridId = g.blockId; });
  grid.addEventListener("mousedown", () => { WB.activeGridId = g.blockId; }, true);

  scroll.addEventListener("scroll", () => repaintGrid(g));

  // ── mouse selection / resize ──
  const canvasPos = (e) => {
    const rect = scroll.getBoundingClientRect();
    return { x: e.clientX - rect.left + scroll.scrollLeft, y: e.clientY - rect.top + scroll.scrollTop };
  };

  grid.addEventListener("mousedown", (e) => {
    if (e.button === 2) return; // context menu path

    // the "Add N more rows" bar handles its own clicks/typing
    if (e.target.closest("[data-wb-addrows]")) return;

    // ── formula point mode: clicking cells inserts references ──
    if (!e.target.closest(".wb-cell-editor")) {
      const stPoint = formulaPointState(g);
      if (stPoint) {
        e.preventDefault(); // keep focus in the formula editor
        const fzPt = e.target.closest(".wb-gr-frozen-top .wb-cell, .wb-gr-frozen-left .wb-cell");
        if (fzPt) {
          insertPointRef(g, stPoint, colLabel(+fzPt.getAttribute("data-c")) + (+fzPt.getAttribute("data-r") + 1));
          return;
        }
        const inCanvasPt = e.target.closest(".wb-gr-scroll");
        if (!inCanvasPt) return; // headers etc: ignore, don't commit
        const pos0 = canvasPos(e);
        const anchor = { r: g.rows[dispRowAt(g, pos0.y)] ?? 0, c: colAt(g, pos0.x) };
        insertPointRef(g, stPoint, colLabel(anchor.c) + (anchor.r + 1));
        if (g.editing) { g.editing.pointRC = anchor; g.editing.pointAnchor = anchor; }
        const onMove = (ev) => {
          const p = canvasPos(ev);
          const r2 = g.rows[dispRowAt(g, p.y)] ?? anchor.r;
          const c2 = colAt(g, p.x);
          const rr0 = Math.min(anchor.r, r2), rr1 = Math.max(anchor.r, r2);
          const cc0 = Math.min(anchor.c, c2), cc1 = Math.max(anchor.c, c2);
          const txt = rr0 === rr1 && cc0 === cc1
            ? colLabel(cc0) + (rr0 + 1)
            : colLabel(cc0) + (rr0 + 1) + ":" + colLabel(cc1) + (rr1 + 1);
          const st2 = formulaPointState(g);
          if (st2) insertPointRef(g, st2, txt);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return;
      }
    }

    // ── cross-sheet point mode: clicks insert refs into the pending formula ──
    if (g.xedit && g.sheet.id !== g.xedit.sheetId) {
      const ptCell = e.target.closest(".wb-cell");
      if (ptCell && e.button === 0) {
        e.preventDefault();
        const ar = +ptCell.getAttribute("data-r"), ac = +ptCell.getAttribute("data-c");
        xeditInsertRef(g, ar, ac, ar, ac);
        const onMove = (ev) => {
          const p = canvasPos(ev);
          const r2 = g.rows[dispRowAt(g, p.y)] ?? ar;
          const c2 = colAt(g, p.x);
          xeditInsertRef(g, ar, ac, r2, c2);
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        g.els.grid.focus();
        return;
      }
    }

    // ── dropdown chips, header filter buttons, cell images ── (opened
    // from the document click delegate — opening here on mousedown would
    // be undone by the click-away closer, and the repaint that follows
    // setActive would detach the node before its click event fires)
    if (e.target.closest("[data-wb-dvchip]") || e.target.closest("[data-wb-dvcheck]") || e.target.closest("[data-wb-fltbtn]") || (e.button === 0 && e.target.closest("[data-wb-img]"))) { e.preventDefault(); return; }

    // ── drag-fill handle ──
    const fh = e.target.closest("[data-wb-fillhandle]");
    if (fh && WB.canEdit) {
      e.preventDefault();
      if (g.filters.size) { _toast("Clear the filter before drag-filling", "warn"); return; }
      const src = selRect(g);
      const preview = document.createElement("div");
      preview.className = "wb-fill-preview";
      g.els.sel.appendChild(preview);
      const d0 = dispIndexOfRow(g, src.r0);
      let ext = null;
      const onMove = (ev) => {
        const p = canvasPos(ev);
        const r = g.rows[dispRowAt(g, p.y)] ?? src.r1;
        const c = colAt(g, p.x);
        const dRow = r - src.r1, dCol = c - src.c1;
        if (dRow > 0 && dRow >= dCol) ext = { axis: "row", count: dRow };
        else if (dCol > 0) ext = { axis: "col", count: dCol };
        else ext = null;
        const x = g.colX[src.c0], y = g.rowY[d0];
        const x2 = ext && ext.axis === "col" ? g.colX[Math.min(g.sheet.colCount, src.c1 + ext.count + 1)] : g.colX[src.c1 + 1];
        const dEnd = ext && ext.axis === "row" ? dispIndexOfRow(g, Math.min(g.sheet.rowCount - 1, src.r1 + ext.count)) : dispIndexOfRow(g, src.r1);
        const y2 = dEnd >= 0 ? g.rowY[dEnd + 1] : g.rowY[dispIndexOfRow(g, src.r1) + 1];
        preview.style.left = x + "px";
        preview.style.top = y + "px";
        preview.style.width = (x2 - x) + "px";
        preview.style.height = (y2 - y) + "px";
        preview.style.display = ext ? "block" : "none";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        preview.remove();
        if (ext) applyFill(g, src, ext);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return;
    }

    const rzCol = e.target.closest("[data-wb-rzcol]");
    const rzRow = e.target.closest("[data-wb-rzrow]");
    if (rzCol || rzRow) {
      e.preventDefault();
      const sheet = g.sheet;
      if (!WB.canEdit) return;
      g.resize = rzCol
        ? { kind: "col", idx: +rzCol.getAttribute("data-wb-rzcol"), startPos: e.clientX, startSize: colW(sheet, +rzCol.getAttribute("data-wb-rzcol")) }
        : { kind: "row", idx: +rzRow.getAttribute("data-wb-rzrow"), startPos: e.clientY, startSize: rowH(sheet, +rzRow.getAttribute("data-wb-rzrow")) };
      document.body.style.cursor = rzCol ? "col-resize" : "row-resize";
      const onMove = (ev) => {
        const rs = g.resize;
        if (!rs) return;
        const delta = (rs.kind === "col" ? ev.clientX : ev.clientY) - rs.startPos;
        const size = Math.round(rs.startSize + delta / (g.zoom || 1));
        if (rs.kind === "col") sheet.colWidths[rs.idx] = Math.min(MAX_COL_W, Math.max(MIN_COL_W, size));
        else sheet.rowHeights[rs.idx] = Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, size));
        computeGeometry(g);
        repaintGrid(g);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        if (g.resize) saveSheetMeta(g.sheet.id);
        g.resize = null;
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return;
    }

    if (e.target.closest(".wb-gr-corner")) {
      commitEdit(g, 0, 0, { refocus: false });
      g.active = { r: g.rows[0] ?? 0, c: 0 };
      g.sel = { r0: 0, c0: 0, r1: g.sheet.rowCount - 1, c1: g.sheet.colCount - 1 };
      grid.focus();
      repaintGrid(g);
      syncFormulaBar(g);
      return;
    }
    const hcol = e.target.closest(".wb-hcol");
    if (hcol) {
      const c = +hcol.getAttribute("data-wb-col");
      commitEdit(g, 0, 0, { refocus: false });
      if (e.shiftKey) {
        g.sel = { r0: 0, c0: Math.min(g.sel.c0, c), r1: g.sheet.rowCount - 1, c1: Math.max(g.sel.c1, c) };
      } else {
        g.active = { r: g.rows[0] ?? 0, c };
        g.sel = { r0: 0, c0: c, r1: g.sheet.rowCount - 1, c1: c };
        const onMove = (ev) => {
          const rect = g.els.scroll.getBoundingClientRect();
          const c2 = colAt(g, ev.clientX - rect.left + g.els.scroll.scrollLeft);
          if (c2 !== g.sel.c1) { g.sel.c1 = c2; paintSelection(g); repaintGrid(g); }
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }
      grid.focus();
      repaintGrid(g);
      syncFormulaBar(g);
      return;
    }
    const hrow = e.target.closest(".wb-hrow");
    if (hrow) {
      const r = +hrow.getAttribute("data-wb-row");
      commitEdit(g, 0, 0, { refocus: false });
      if (e.shiftKey) {
        g.sel = { r0: Math.min(g.sel.r0, r), c0: 0, r1: Math.max(g.sel.r1, r), c1: g.sheet.colCount - 1 };
      } else {
        g.active = { r, c: 0 };
        g.sel = { r0: r, c0: 0, r1: r, c1: g.sheet.colCount - 1 };
        const onMove = (ev) => {
          const rect = g.els.scroll.getBoundingClientRect();
          const r2 = g.rows[dispRowAt(g, ev.clientY - rect.top + g.els.scroll.scrollTop)] ?? r;
          if (r2 !== g.sel.r1) { g.sel.r1 = r2; paintSelection(g); repaintGrid(g); }
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }
      grid.focus();
      repaintGrid(g);
      syncFormulaBar(g);
      return;
    }

    const fz = e.target.closest(".wb-gr-frozen-top .wb-cell, .wb-gr-frozen-left .wb-cell");
    if (fz) {
      e.preventDefault();
      if (g.editing) commitEdit(g, 0, 0, { refocus: false });
      const fr = +fz.getAttribute("data-r"), fc = +fz.getAttribute("data-c");
      if (e.shiftKey) { g.sel.r1 = fr; g.sel.c1 = fc; paintSelection(g); repaintGrid(g); }
      else setActive(g, fr, fc, { scroll: false });
      grid.focus();
      return;
    }
    const inCanvas = e.target.closest(".wb-gr-scroll");
    if (!inCanvas) return;
    if (e.target.closest(".wb-cell-editor")) return;
    e.preventDefault();
    closeAllPopovers();
    // A click that lands on a rendered hyperlink follows the link (the <a>
    // opens it in a new tab natively). Bail before selecting/dragging so the
    // repaint doesn't detach the anchor before the click lands. Clicking the
    // empty part of the cell (not the link text) still selects as usual.
    if (e.button === 0 && !e.shiftKey && !e.altKey && !g.editing && e.target.closest("a.wb-cell-link")) {
      return;
    }
    const pos = canvasPos(e);
    const di = dispRowAt(g, pos.y);
    const r = g.rows[di] ?? 0;
    const c = colAt(g, pos.x);
    // ── drag-move: grabbing the selection border relocates the cells
    // (Ctrl/Alt-drag copies). Hidden slices make the drop ambiguous, so
    // filtered/hidden states fall through to plain selection.
    if (WB.canEdit && !e.shiftKey && !g.editing && !g.painter
        && !g.filters.size && !(g.sheet.hiddenRows && g.sheet.hiddenRows.size) && !(g.sheet.hiddenCols && g.sheet.hiddenCols.size)
        && selBorderHit(g, pos)) {
      const srcRect = selRect(g);
      if (rectIntersectsMerge(g.sheet, srcRect.r0, srcRect.c0, srcRect.r1, srcRect.c1)) {
        _toast("Unmerge cells before dragging them", "warn");
        return;
      }
      startMoveDrag(g, e, srcRect, canvasPos);
      return;
    }
    // ── a click on the already-active dropdown cell opens its option
    // picker (via the click delegate — opening on mousedown would be
    // undone by the click-away closer, and skipping setActive keeps the
    // node attached so the click actually lands)
    if (WB.canEdit && e.button === 0 && !e.shiftKey && !g.editing) {
      const dvCellEl = e.target.closest(".wb-cell.is-dv");
      if (dvCellEl && +dvCellEl.getAttribute("data-r") === g.active.r && +dvCellEl.getAttribute("data-c") === g.active.c
          && g.sel.r0 === g.sel.r1 && g.sel.c0 === g.sel.c1 && g.active.r === g.sel.r0 && g.active.c === g.sel.c0) {
        e.preventDefault();
        return;
      }
    }
    // Ctrl/Cmd+click on a linked cell opens the link (explicit or auto-detected)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      const url = cellLink(g.sheet.cells.get(cellKey(r, c)));
      if (url) { window.open(url, "_blank", "noopener"); return; }
    }
    if (g.editing) commitEdit(g, 0, 0, { refocus: false });
    if (e.shiftKey) {
      g.sel.r1 = r; g.sel.c1 = c;
      paintSelection(g);
      repaintGrid(g);
    } else {
      setActive(g, r, c, { scroll: false });
      g.dragging = true;
      const onMove = (ev) => {
        if (!g.dragging) return;
        const p = canvasPos(ev);
        const dr = g.rows[dispRowAt(g, p.y)] ?? r;
        const dc = colAt(g, p.x);
        if (dr !== g.sel.r1 || dc !== g.sel.c1) {
          g.sel.r1 = dr; g.sel.c1 = dc;
          paintSelection(g);
          repaintGrid(g);
        }
      };
      const onUp = () => {
        g.dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (g.painter) applyFormatPainter(g);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }
    grid.focus();
  });

  grid.addEventListener("dblclick", (e) => {
    // double-click a column divider → autofit that column (Excel)
    const rz = e.target.closest("[data-wb-rzcol]");
    if (rz && WB.canEdit) { const c = +rz.getAttribute("data-wb-rzcol"); autofitColumns(g, c, c); return; }
    const cell = e.target.closest(".wb-cell");
    if (!cell || !WB.canEdit) return;
    const r = +cell.getAttribute("data-r"), c = +cell.getAttribute("data-c");
    setActive(g, r, c, { scroll: false });
    startEdit(g, r, c);
  });

  grid.addEventListener("contextmenu", (e) => {
    const cellEl = e.target.closest(".wb-cell");
    const hcol = e.target.closest(".wb-hcol");
    const hrow = e.target.closest(".wb-hrow");
    if (!cellEl && !hcol && !hrow) return;
    e.preventDefault();
    let kind = "cell";
    if (hcol) {
      kind = "col";
      const c = +hcol.getAttribute("data-wb-col");
      const rect = selRect(g);
      // right-click inside a multi-column selection keeps it (Excel)
      if (c < rect.c0 || c > rect.c1 || rect.r1 - rect.r0 !== g.sheet.rowCount - 1) {
        g.active = { r: g.rows[0] ?? 0, c };
        g.sel = { r0: 0, c0: c, r1: g.sheet.rowCount - 1, c1: c };
      }
    } else if (hrow) {
      kind = "row";
      const r = +hrow.getAttribute("data-wb-row");
      const rect = selRect(g);
      if (r < rect.r0 || r > rect.r1 || rect.c1 - rect.c0 !== g.sheet.colCount - 1) {
        g.active = { r, c: 0 };
        g.sel = { r0: r, c0: 0, r1: r, c1: g.sheet.colCount - 1 };
      }
    } else {
      const r = +cellEl.getAttribute("data-r"), c = +cellEl.getAttribute("data-c");
      const rect = selRect(g);
      if (r < rect.r0 || r > rect.r1 || c < rect.c0 || c > rect.c1) setActive(g, r, c, { scroll: false });
    }
    repaintGrid(g);
    openCellContextMenu(g, e.clientX, e.clientY, kind);
  });

  // ── keyboard ──
  grid.addEventListener("keydown", (e) => {
    if (g.editing) return; // editor has its own handler
    const k = e.key;
    const meta = e.ctrlKey || e.metaKey;
    // ── cross-sheet point mode: the keyboard builds the pending formula ──
    if (g.xedit && g.sheet.id !== g.xedit.sheetId) {
      const x = g.xedit;
      if (k === "Enter") { e.preventDefault(); commitXedit(g); return; }
      if (k === "Escape") { e.preventDefault(); cancelXedit(g); return; }
      if (k === "Backspace") {
        e.preventDefault();
        x.value = x.value.slice(0, -1);
        x.seg = null;
        x.caret = x.value.length;
        if (g.els.fbarInput) g.els.fbarInput.value = x.value;
        return;
      }
      if (k.length === 1 && !meta && !e.altKey) {
        e.preventDefault();
        x.value += k;
        x.seg = null; // typing "fixes" the last ref; the next click starts a new one
        x.caret = x.value.length;
        if (g.els.fbarInput) g.els.fbarInput.value = x.value;
        return;
      }
      // arrows/paging fall through so the other sheet can be browsed
    }
    if (meta && (k === "z" || k === "Z")) { e.preventDefault(); if (e.shiftKey) redoGrid(g); else undoGrid(g); return; }
    if (meta && (k === "y" || k === "Y")) { e.preventDefault(); redoGrid(g); return; }
    if (meta && (k === "c" || k === "C")) { e.preventDefault(); copySelection(g); return; }
    if (meta && (k === "x" || k === "X")) { e.preventDefault(); copySelection(g, "cut"); return; }
    if (meta && e.shiftKey && (k === "v" || k === "V")) { e.preventDefault(); pasteSpecial(g, "values"); return; } // Sheets' paste-values-only
    if (meta && (k === "v" || k === "V")) {
      // preferred path: the native paste event (fires next tick with
      // clipboardData); fall back to the async clipboard API
      clearTimeout(g.clipboardTimer);
      g.clipboardTimer = setTimeout(() => pasteFromClipboard(g), 250);
      return;
    }
    if (meta && (k === "b" || k === "B")) { e.preventDefault(); toggleFormat(g, "bold"); return; }
    if (meta && (k === "i" || k === "I")) { e.preventDefault(); toggleFormat(g, "italic"); return; }
    if (meta && (k === "u" || k === "U")) { e.preventDefault(); toggleFormat(g, "underline"); return; }
    if (meta && (k === "a" || k === "A")) {
      e.preventDefault();
      const { maxR, maxC } = usedRange(g.sheet);
      const cur = selRect(g);
      const isRegion = maxR >= 0 && cur.r0 === 0 && cur.c0 === 0 && cur.r1 === Math.max(0, maxR) && cur.c1 === Math.max(0, maxC);
      if (maxR >= 0 && !isRegion) g.sel = { r0: 0, c0: 0, r1: maxR, c1: maxC };            // data region first
      else g.sel = { r0: 0, c0: 0, r1: g.sheet.rowCount - 1, c1: g.sheet.colCount - 1 };   // then whole sheet
      paintSelection(g);
      repaintGrid(g);
      return;
    }
    if (meta && (k === "s" || k === "S")) { e.preventDefault(); scheduleCellFlush.flushNow(); return; }
    if (meta && e.altKey && (k === "m" || k === "M")) { e.preventDefault(); openCellComment(g, g.active.r, g.active.c); return; } // Sheets' comment shortcut
    if (meta && k === "`") { e.preventDefault(); g.showFormulas = !g.showFormulas; repaintGrid(g); return; } // View → Show → Formulas
    if (meta && (k === "f" || k === "F")) { e.preventDefault(); openFindPanel(g, false); return; }
    if (meta && (k === "h" || k === "H")) { e.preventDefault(); if (WB.canEdit) openFindPanel(g, true); return; }
    if (meta && k.startsWith("Arrow")) {
      e.preventDefault();
      const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
      const edge = dataEdge(g, e.shiftKey ? { r: g.sel.r1, c: g.sel.c1 } : g.active, dir[0], dir[1]);
      if (e.shiftKey) {
        g.sel.r1 = edge.r; g.sel.c1 = edge.c;
        paintSelection(g); repaintGrid(g); scrollCellIntoView(g, edge.r, edge.c);
      } else setActive(g, edge.r, edge.c);
      return;
    }

    switch (k) {
      case "ArrowUp": e.preventDefault(); moveActive(g, -1, 0, e.shiftKey); return;
      case "ArrowDown": e.preventDefault(); moveActive(g, 1, 0, e.shiftKey); return;
      case "ArrowLeft": e.preventDefault(); moveActive(g, 0, -1, e.shiftKey); return;
      case "ArrowRight": e.preventDefault(); moveActive(g, 0, 1, e.shiftKey); return;
      case "Home": e.preventDefault(); setActive(g, e.ctrlKey ? (g.rows[0] ?? 0) : g.active.r, 0); return;
      case "End": {
        e.preventDefault();
        const { maxC, maxR } = usedRange(g.sheet);
        setActive(g, e.ctrlKey ? Math.max(0, maxR) : g.active.r, Math.max(0, maxC));
        return;
      }
      case "PageDown": e.preventDefault(); moveActive(g, 15, 0, e.shiftKey); return;
      case "PageUp": e.preventDefault(); moveActive(g, -15, 0, e.shiftKey); return;
      case "Enter": e.preventDefault(); if (WB.canEdit) startEdit(g, g.active.r, g.active.c); return;
      case "F2": e.preventDefault(); if (WB.canEdit) startEdit(g, g.active.r, g.active.c); return;
      case "Tab": e.preventDefault(); moveActive(g, 0, e.shiftKey ? -1 : 1, false); return;
      case "Delete":
      case "Backspace": e.preventDefault(); clearSelection(g); return;
      case "Escape": e.preventDefault(); if (g.painter) { cancelFormatPainter(g); return; } closeAllPopovers(); g.sel = { r0: g.active.r, c0: g.active.c, r1: g.active.r, c1: g.active.c }; paintSelection(g); repaintGrid(g); return;
    }
    // type-to-replace: printable character starts an edit
    if (WB.canEdit && k.length === 1 && !meta && !e.altKey) {
      e.preventDefault();
      startEdit(g, g.active.r, g.active.c, k);
    }
  });

  // native paste path (has clipboardData; works without permissions)
  grid.addEventListener("paste", (e) => {
    if (g.editing) return;
    e.preventDefault();
    clearTimeout(g.clipboardTimer);
    const cd = e.clipboardData;
    const text = cd ? cd.getData("text/plain") : "";
    // text wins when both are present (Excel/Sheets put a bitmap of the
    // copied range on the clipboard alongside the TSV); a bare image —
    // a screenshot, a copied photo — pastes into the active cell
    if (!text && cd && cd.items) {
      for (const it of cd.items) {
        if (it.kind === "file" && /^image\//.test(it.type)) {
          const file = it.getAsFile();
          if (file) { insertImageFile(g, file); return; }
        }
      }
    }
    if (text) pasteAt(g, text);
    else if (WB.clipboard && WB.clipboard.rows.length && WB.clipboard.text === "") pasteRich(g, WB.clipboard); // internal copy of image-only cells has an empty TSV
  });

  // ── "Add N more rows at the bottom" (Sheets-style) ──
  const addBar = g.els.body.querySelector("[data-wb-addrows]");
  if (addBar) {
    addBar.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep typing out of the grid's key handling
      if (e.key === "Enter") addBar.querySelector("[data-wb-addbtn]").click();
    });
    addBar.querySelector("[data-wb-addbtn]").addEventListener("click", () => {
      if (!WB.canEdit) return;
      const inp = addBar.querySelector("[data-wb-addn]");
      const n = Math.max(1, Math.min(20000, Math.round(+inp.value || 0)));
      if (!n) return;
      g.sheet.rowCount = Math.min(100000, g.sheet.rowCount + n);
      saveSheetMeta(g.sheet.id);
      computeGeometry(g);
      repaintGrid(g);
      _toast(`Added ${n.toLocaleString()} rows`, "success");
    });
  }

  // move-cursor affordance while hovering the selection border
  grid.addEventListener("mousemove", (e) => {
    if (!WB.canEdit || g.dragging || g.moveDrag || g.editing || g.resize) return;
    const on = e.target.closest(".wb-gr-scroll")
      && !g.filters.size && !(g.sheet.hiddenRows && g.sheet.hiddenRows.size) && !(g.sheet.hiddenCols && g.sheet.hiddenCols.size)
      && selBorderHit(g, canvasPos(e));
    g.els.cells.classList.toggle("is-mv", !!on);
  });

  grid.addEventListener("copy", (e) => {
    if (g.editing) return;
    e.preventDefault();
    captureClipboard(g, "copy");
    e.clipboardData.setData("text/plain", WB.clipboard.text);
  });
  grid.addEventListener("cut", (e) => {
    if (g.editing) return;
    e.preventDefault();
    captureClipboard(g, "cut");
    e.clipboardData.setData("text/plain", WB.clipboard.text);
  });

  // ── formula bar ──
  const fbar = g.els.fbarInput;
  if (fbar) {
    fbar.addEventListener("focus", () => {
      if (!WB.canEdit) return;
      if (!g.editing) {
        const { r, c } = g.active;
        const cell = g.sheet.cells.get(cellKey(r, c));
        g.editing = { r, c, input: null, viaBar: true, orig: cell ? (cell.formula || (cell.value ?? "")) : "" };
      }
    });
    fbar.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitBarEdit(g);
        g.els.grid.focus();
        moveActive(g, 1, 0, false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (g.editing && g.editing.viaBar) { fbar.value = g.editing.orig; g.editing = null; }
        clearFormulaChrome(g);
        g.els.grid.focus();
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitBarEdit(g);
        g.els.grid.focus();
        moveActive(g, 0, e.shiftKey ? -1 : 1, false);
      }
    });
    fbar.addEventListener("input", () => {
      if (g.editing) { g.editing.point = null; g.editing.pointRC = null; g.editing.pointAnchor = null; }
      if (g.editing && g.editing.input) g.editing.input.value = fbar.value;
      paintFormulaRefs(g);
    });
    fbar.addEventListener("blur", () => {
      setTimeout(() => {
        if (g.editing && g.editing.viaBar && document.activeElement !== fbar) commitBarEdit(g);
      }, 0);
    });
  }

  // ── name box: type a ref (e.g. C14) and Enter to jump ──
  const nameBox = g.els.fbarRef;
  if (nameBox && nameBox.tagName === "INPUT") {
    nameBox.addEventListener("focus", () => nameBox.select());
    nameBox.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        if (gotoNameBox(g, nameBox.value.trim())) g.els.grid.focus();
        else { _toast("Type a cell reference like B12, a range, or a named range", "info"); syncFormulaBar(g); }
      } else if (e.key === "Escape") {
        e.preventDefault();
        syncFormulaBar(g);
        g.els.grid.focus();
      }
    });
    nameBox.addEventListener("blur", () => syncFormulaBar(g));
  }

  // ── toolbar ──
  const toolbar = g.els.body.querySelector(".wb-toolbar");
  if (toolbar) toolbar.addEventListener("click", (e) => {
    const numfmt = e.target.closest("[data-wb-numfmt]");
    if (numfmt) { formatSelection(g, { num: numfmt.getAttribute("data-wb-numfmt") || null }); closeAllPopovers(); return; }
    // × on a custom swatch: forget the color, keep the picker open
    const colorDel = e.target.closest("[data-wb-colordel]");
    if (colorDel) {
      e.stopPropagation();
      wbDeleteCustomColor(colorDel.getAttribute("data-wb-colordel"));
      const anchorBtn = colorDel.closest(".popover-anchor")?.querySelector("[data-wb-tb]");
      if (anchorBtn) fillColorPop(g, anchorBtn); // rebuild in place
      return;
    }
    const colorBtn = e.target.closest("[data-wb-color]");
    if (colorBtn) {
      const kind = colorBtn.closest(".wb-color-pop").getAttribute("data-wb-colorkind");
      formatSelection(g, { [kind]: colorBtn.getAttribute("data-wb-color") || null });
      closeAllPopovers();
      return;
    }
    const borderBtn = e.target.closest("[data-wb-border]");
    if (borderBtn) { const v = borderBtn.getAttribute("data-wb-border"); formatSelection(g, { border: v === "none" ? null : v }); closeAllPopovers(); return; }
    const bwBtn = e.target.closest("[data-wb-bw]");
    if (bwBtn) { const w = +bwBtn.getAttribute("data-wb-bw"); formatSelection(g, { bw: w === 1 ? null : w }); closeAllPopovers(); return; }
    const freezeBtn = e.target.closest("[data-wb-freeze]");
    if (freezeBtn) { setFreeze(g, freezeBtn.getAttribute("data-wb-freeze")); closeAllPopovers(); return; }
    const fnItem = e.target.closest("[data-wb-fn]");
    if (fnItem) { const nm = fnItem.getAttribute("data-wb-fn"); closeAllPopovers(); if (WB.canEdit) startEdit(g, g.active.r, g.active.c, "=" + nm + "("); return; }
    const io = e.target.closest("[data-wb-tb2]");
    if (io) {
      closeAllPopovers();
      const ioAct = io.getAttribute("data-wb-tb2");
      if (ioAct === "import-csv") importCsvInto(g);
      else if (ioAct === "export-xlsx") exportBlockXlsx(g);
      else if (ioAct === "print") printSheet(g);
      else exportSheetCsv(g);
      return;
    }
    const btn = e.target.closest("[data-wb-tb]");
    if (!btn) return;
    const act = btn.getAttribute("data-wb-tb");
    // items living inside a dropdown close it before acting (the menu
    // triggers themselves sit outside .popover, so they're unaffected)
    if (btn.closest(".popover")) closeAllPopovers();
    switch (act) {
      case "undo": undoGrid(g); break;
      case "redo": redoGrid(g); break;
      case "autosum": autoSum(g); return; // startEdit needs focus to stay in the editor
      case "paint-format": startFormatPainter(g); return;
      case "fmt-currency": formatSelection(g, { num: "currency" }); break;
      case "fmt-percent": formatSelection(g, { num: "percent" }); break;
      case "bold": toggleFormat(g, "bold"); break;
      case "italic": toggleFormat(g, "italic"); break;
      case "underline": toggleFormat(g, "underline"); break;
      case "strike": toggleFormat(g, "strike"); break;
      case "merge": toggleMergeSelection(g); break;
      case "insert-link": insertLinkPrompt(g); break;
      case "comment-cell": openCellComment(g, g.active.r, g.active.c); return;
      case "insert-chart": openChartDialog(g); return;
      case "align-left": formatSelection(g, { align: "left" }); break;
      case "align-center": formatSelection(g, { align: "center" }); break;
      case "align-right": formatSelection(g, { align: "right" }); break;
      case "valign-top": formatSelection(g, { valign: "top" }); break;
      case "valign-middle": formatSelection(g, { valign: "middle" }); break;
      case "valign-bottom": formatSelection(g, { valign: "bottom" }); break;
      case "wrap": toggleFormat(g, "wrap"); break;
      case "clear-format": clearFormatting(g); break;
      case "dec-minus": adjustDecimals(g, -1); break;
      case "dec-plus": adjustDecimals(g, 1); break;
      case "fs-minus": adjustFontSize(g, -1); break;
      case "fs-plus": adjustFontSize(g, 1); break;
      case "find": openFindPanel(g, false); break;
      case "fill-people": openPeoplePicker(g); return;
      case "panel-toggle": WB.panelOpen = !WB.panelOpen; syncPanelVisibility(); if (WB.panelOpen) renderPanel(); break;
      case "validation": openValidationDialog(g); break;
      case "condfmt": openCondFormatDialog(g); break;
      case "named-ranges": openNamedRangesDialog(g); return;
      case "pivot": openPivotDialog(g); return;
      case "row-add": restructure(g, "row", g.active.r + 1, 1); break;
      case "row-del": restructure(g, "row", g.active.r, -1); break;
      case "col-add": restructure(g, "col", g.active.c + 1, 1); break;
      case "col-del": restructure(g, "col", g.active.c, -1); break;
      case "sort-asc": sortByColumn(g, g.active.c, "asc"); break;
      case "sort-desc": sortByColumn(g, g.active.c, "desc"); break;
      case "sort-custom": openSortDialog(g); return;
      case "filter": toggleFilterMode(g); break;
      case "fn-menu": {
        fnBrowserPop(g, btn);
        togglePopover(btn);
        setTimeout(() => btn.closest(".popover-anchor")?.querySelector(".wb-fn-search")?.focus(), 0);
        return;
      }
      case "numfmt-menu":
      case "fill-menu":
      case "textc-menu":
      case "border-menu":
      case "align-menu":
      case "rowcol-menu":
      case "sort-menu":
      case "freeze-menu":
      case "io-menu": {
        if (act === "fill-menu" || act === "textc-menu") fillColorPop(g, btn);
        togglePopover(btn);
        return;
      }
    }
    g.els.grid.focus();
  });

  // ── sheet tabs ──
  // capture an in-progress formula BEFORE the tab steals focus — otherwise
  // the editor's blur handler commits the half-typed formula (Excel keeps
  // it alive so you can point at cells on the other sheet)
  g.els.tabs.addEventListener("mousedown", (e) => {
    const tab = e.target.closest("[data-wb-sheettab]");
    if (!tab || !g.editing) return;
    const input = g.editing.input;
    if (!input || !input.value.startsWith("=")) return;                 // plain values commit as usual
    if (tab.getAttribute("data-wb-sheettab") === g.sheet.id) return;    // same tab: nothing to do
    const caret = input.selectionStart ?? input.value.length;
    const pt = g.editing.point;
    g.xedit = {
      sheetId: g.sheet.id, r: g.editing.r, c: g.editing.c,
      value: input.value, caret,
      seg: pt && pt.end === caret ? { ...pt } : null,
    };
    g.editing = null; // the blur timeout and switchSheet's cancelEdit become no-ops
    clearFormulaChrome(g);
    input.remove();
  });
  g.els.tabs.addEventListener("click", (e) => {
    const caret = e.target.closest("[data-wb-tabmenu]");
    if (caret) {
      const rect = caret.getBoundingClientRect();
      openSheetTabMenu(g, caret.getAttribute("data-wb-tabmenu"), rect.left - 60, rect.bottom + 4);
      return;
    }
    const allBtn = e.target.closest("[data-wb-allsheets]");
    if (allBtn) {
      const rect = allBtn.getBoundingClientRect();
      openAllSheetsMenu(g, rect.left, rect.bottom + 4);
      return;
    }
    const tab = e.target.closest("[data-wb-sheettab]");
    if (!tab) return;
    switchSheet(g, tab.getAttribute("data-wb-sheettab"));
    if (g.xedit) {
      if (g.sheet.id === g.xedit.sheetId) restoreXeditEditor(g);
      else { syncFormulaBar(g); xeditHint(g); g.els.grid.focus(); }
    }
  });
  g.els.tabs.addEventListener("dblclick", (e) => {
    const tab = e.target.closest("[data-wb-sheettab]");
    if (tab && WB.canEdit) renameSheet(g, tab.getAttribute("data-wb-sheettab"));
  });
  g.els.tabs.addEventListener("contextmenu", (e) => {
    const tab = e.target.closest("[data-wb-sheettab]");
    if (!tab || !WB.canEdit) return;
    e.preventDefault();
    openSheetTabMenu(g, tab.getAttribute("data-wb-sheettab"), e.clientX, e.clientY);
  });

  // ── zoom ──
  const zoomSel = g.els.body.querySelector("[data-wb-zoom]");
  if (zoomSel) zoomSel.addEventListener("change", () => setZoom(g, +zoomSel.value || 1));

  // ── toolbar font controls ──
  const ffSel = g.els.body.querySelector("[data-wb-ffsel]");
  if (ffSel) ffSel.addEventListener("change", () => {
    formatSelection(g, { ff: ffSel.value || null });
    g.els.grid.focus();
  });
  const fsInput = g.els.body.querySelector("[data-wb-fsinput]");
  if (fsInput) {
    fsInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); fsInput.blur(); }
    });
    fsInput.addEventListener("change", () => {
      const v = fsInput.value === "" ? null : Math.min(36, Math.max(8, Math.trunc(+fsInput.value) || 13));
      formatSelection(g, { fs: v });
      syncFontControls(g);
      g.els.grid.focus();
    });
  }
}

function commitBarEdit(g) {
  const ed = g.editing;
  const fbar = g.els.fbarInput;
  if (!ed || !fbar) return;
  if (ed.input) { ed.input.value = fbar.value; commitEdit(g, 0, 0, { refocus: false }); return; }
  g.editing = null;
  if (fbar.value !== ed.orig) {
    const prev = g.sheet.cells.get(cellKey(ed.r, ed.c));
    setCells(g, [{ r: ed.r, c: ed.c, cell: cellFromInput(fbar.value, prev) }]);
  }
}

// Google Sheets' standard color matrix: greyscale, brights, then tint →
// shade rows per hue. Stored as plain hex, so everything round-trips
// through cellStyle and the XLSX exporter.
const WB_COLOR_MATRIX = [
  ["#000000", "#434343", "#666666", "#999999", "#B7B7B7", "#CCCCCC", "#D9D9D9", "#EFEFEF", "#F3F3F3", "#FFFFFF"],
  ["#980000", "#FF0000", "#FF9900", "#FFFF00", "#00FF00", "#00FFFF", "#4A86E8", "#0000FF", "#9900FF", "#FF00FF"],
  ["#E6B8AF", "#F4CCCC", "#FCE5CD", "#FFF2CC", "#D9EAD3", "#D0E0E3", "#C9DAF8", "#CFE2F3", "#D9D2E9", "#EAD1DC"],
  ["#DD7E6B", "#EA9999", "#F9CB9C", "#FFE599", "#B6D7A8", "#A2C4C9", "#A4C2F4", "#9FC5E8", "#B4A7D6", "#D5A6BD"],
  ["#CC4125", "#E06666", "#F6B26B", "#FFD966", "#93C47D", "#76A5AF", "#6D9EEB", "#6FA8DC", "#8E7CC3", "#C27BA0"],
  ["#A61C00", "#CC0000", "#E69138", "#F1C232", "#6AA84F", "#45818E", "#3C78D8", "#3D85C6", "#674EA7", "#A64D79"],
  ["#85200C", "#990000", "#B45F06", "#BF9000", "#38761D", "#134F5C", "#1155CC", "#0B5394", "#351C75", "#741B47"],
  ["#5B0F00", "#660000", "#783F04", "#7F6000", "#274E13", "#0C343D", "#1C4587", "#073763", "#20124D", "#4C1130"],
];

// Saved custom colors — shared by the fill (cell) and text pickers,
// most recent first, per browser.
function wbCustomColors() {
  try {
    const a = JSON.parse(localStorage.getItem("rr-wb-customcolors") || "[]");
    return Array.isArray(a) ? a.filter((h) => HEX_COLOR_RE.test(String(h))).slice(0, 10) : [];
  } catch (_) { return []; }
}
function wbSaveCustomColor(hex) {
  if (!HEX_COLOR_RE.test(String(hex))) return;
  const norm = hex.toUpperCase();
  const list = [norm, ...wbCustomColors().filter((h) => h.toUpperCase() !== norm)].slice(0, 10);
  try { localStorage.setItem("rr-wb-customcolors", JSON.stringify(list)); } catch (_) {}
}
function wbDeleteCustomColor(hex) {
  const norm = String(hex).toUpperCase();
  const list = wbCustomColors().filter((h) => h.toUpperCase() !== norm);
  try { localStorage.setItem("rr-wb-customcolors", JSON.stringify(list)); } catch (_) {}
}

function fillColorPop(g, btn) {
  const pop = btn.closest(".popover-anchor")?.querySelector(".wb-color-pop");
  if (!pop) return;
  // rebuilt on every open so freshly saved custom colors show up
  const kind = pop.getAttribute("data-wb-colorkind");
  const custom = wbCustomColors();
  pop.innerHTML = `
    <button type="button" class="wb-color-reset" data-wb-color="">✕ Reset to default</button>
    <div class="wb-color-grid wb-color-grid-10">${WB_COLOR_MATRIX.flat().map((hex) =>
      `<button type="button" class="wb-swatch" data-wb-color="${hex}" title="${hex}" aria-label="${hex}" style="background:${hex}"></button>`).join("")}</div>
    ${custom.length ? `
    <div class="wb-color-custlbl">Custom</div>
    <div class="wb-color-grid wb-color-grid-10 wb-color-custrow">${custom.map((hex) =>
      `<span class="wb-swatch-wrap"><button type="button" class="wb-swatch" data-wb-color="${hex}" title="${hex}" aria-label="${hex}" style="background:${hex}"></button><button type="button" class="wb-swatch-del" data-wb-colordel="${hex}" title="Remove ${hex} from custom colors" aria-label="Remove ${hex} from custom colors">×</button></span>`).join("")}</div>` : ""}
    <label class="wb-color-custom"><input type="color" data-wb-colorpick value="${kind === "bg" ? "#FFF2CC" : "#1F2937"}" aria-label="Custom color"> Custom…</label>
    <button type="button" class="wb-color-cf" data-wb-colorcf>Conditional formatting…</button>`;
  pop.querySelector("[data-wb-colorpick]").addEventListener("change", (e) => {
    wbSaveCustomColor(e.target.value); // remembered for both pickers
    formatSelection(g, { [kind]: e.target.value });
    closeAllPopovers();
    g.els.grid.focus();
  });
  pop.querySelector("[data-wb-colorcf]").addEventListener("click", () => {
    closeAllPopovers();
    openCondFormatDialog(g);
  });
}

// ─── Context menus ───────────────────────────────────────────────────────────

function ctxMenu(x, y, itemsHtml) {
  closeAllPopovers();
  const m = document.createElement("div");
  m.className = "wb-ctx-menu popover open";
  m.setAttribute("role", "menu");
  m.innerHTML = itemsHtml;
  document.body.appendChild(m);
  const rect = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
  return m;
}

// Sheets-look icon set for the cell context menu (16px, stroke inherits)
const CTX_ICONS = {
  cut: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  paste: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
  history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  comment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  dropdown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="5"/><polyline points="13.5 10.5 16 13 18.5 10.5"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  more: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`,
};

// The cell right-click menu, organized like Google Sheets: clipboard,
// inserts, deletes, filter, history, annotations, then the long tail
// behind "View more cell actions". Drill-in submenus (▸) reuse the
// menu-bar stack pattern.
function openSheetsCellMenu(g, x, y) {
  const ro = !WB.canEdit;
  const { r, c } = g.active;
  const rect0 = selRect(g);
  const nRows = rect0.r1 - rect0.r0 + 1;
  const nCols = rect0.c1 - rect0.c0 + 1;
  const rowsLbl = nRows > 1 ? `${nRows} rows` : "1 row";
  const colsLbl = nCols > 1 ? `${nCols} columns` : "1 column";
  const cell = g.sheet.cells.get(cellKey(r, c));
  const hasLink = !!(cell && cell.format && cell.format.link);
  const hasImg = !!cellImgSrc(cell);
  const sep = "—";
  const it = (icon, label, act, o) => ({ icon, label, act, ...(o || {}) });
  const moreSub = [
    it(null, "Format cells…", "format-cells", { disabled: ro }),
    it(null, "Conditional formatting…", "cond-format", { disabled: ro }),
    it(null, "Data validation…", "data-validation", { disabled: ro }),
    it(null, "Merge / unmerge cells", "merge-toggle", { disabled: ro }),
    sep,
    it(null, "Sort sheet by this column A→Z", "sort-col-asc", { disabled: ro }),
    it(null, "Sort sheet by this column Z→A", "sort-col-desc", { disabled: ro }),
    it(null, "Custom sort…", "sort-custom", { disabled: ro }),
    it(null, "Filter this column…", "filter-col"),
    sep,
    it(null, "Copy cell reference", "copy-ref"),
    it(null, "Highlight precedents", "trace-precedents"),
    it(null, "Highlight dependents", "trace-dependents"),
    sep,
    it(null, "Insert image into cell…", "insert-image", { disabled: ro }),
    ...(hasImg ? [it(null, "View image", "view-image")] : []),
    ...(hasImg ? [it(null, "Remove image", "remove-image", { disabled: ro })] : []),
    ...(hasLink ? [it(null, "Open link", "open-link")] : []),
    ...(hasLink ? [it(null, "Remove link", "remove-link", { disabled: ro })] : []),
  ];
  const items = [
    it(CTX_ICONS.cut, "Cut", "cut", { kbd: "Ctrl+X", disabled: ro }),
    it(CTX_ICONS.copy, "Copy", "copy", { kbd: "Ctrl+C" }),
    it(CTX_ICONS.paste, "Paste", "paste", { kbd: "Ctrl+V", disabled: ro }),
    { icon: CTX_ICONS.paste, label: "Paste special", sub: [
      it(null, "Values only", "paste-values", { disabled: ro }),
      it(null, "Format only", "paste-format", { disabled: ro }),
      it(null, "Formulas only", "paste-formulas", { disabled: ro }),
      it(null, "Transposed", "paste-transpose", { disabled: ro }),
    ] },
    sep,
    it(CTX_ICONS.plus, `Insert ${rowsLbl} above`, "insert-row-above", { disabled: ro }),
    it(CTX_ICONS.plus, `Insert ${colsLbl} left`, "insert-col-left", { disabled: ro }),
    { icon: CTX_ICONS.plus, label: "Insert cells", sub: [
      it(null, `Insert ${rowsLbl} below`, "insert-row-below", { disabled: ro }),
      it(null, `Insert ${colsLbl} right`, "insert-col-right", { disabled: ro }),
      it(null, "New sheet", "insert-sheet", { disabled: ro }),
    ] },
    sep,
    it(CTX_ICONS.trash, `Delete ${nRows > 1 ? nRows + " rows" : "row"}`, "delete-row", { disabled: ro }),
    it(CTX_ICONS.trash, `Delete ${nCols > 1 ? nCols + " columns" : "column"}`, "delete-col", { disabled: ro }),
    { icon: CTX_ICONS.trash, label: "Delete cells", sub: [
      it(null, "Clear contents", "clear-contents", { kbd: "Del", disabled: ro }),
      it(null, "Clear formatting", "clear-format", { disabled: ro }),
    ] },
    sep,
    it(CTX_ICONS.filter, g.filterMode ? "Remove filter" : "Create a filter", "filter-toggle"),
    sep,
    it(CTX_ICONS.history, "Show edit history", "history"),
    sep,
    it(CTX_ICONS.link, hasLink ? "Edit link…" : "Insert link", "insert-link", { disabled: ro }),
    it(CTX_ICONS.comment, "Comment", "comment", { kbd: "Ctrl+Alt+M" }),
    it(CTX_ICONS.dropdown, "Dropdown", "data-validation", { disabled: ro }),
    ...(hasImg ? [] : [it(CTX_ICONS.image, "Image in cell…", "insert-image", { disabled: ro })]),
    sep,
    { icon: CTX_ICONS.more, label: "View more cell actions", sub: moreSub },
  ];
  // driver sheets (Sheet-to-Schedule) get row-level driver actions
  const fillDriverId = fillDriverIdAt(g.sheet, r);
  if (fillDriverId) {
    items.splice(items.length - 2, 0, { icon: CTX_ICONS.dropdown, label: "Driver actions", sub: fillDriverMenuItems(g, fillDriverId) });
  }
  const m = ctxMenu(x, y, "");
  m.classList.add("wb-menu-pop", "wb-cellmenu");
  const stack = [{ title: null, items }];
  const render = () => {
    const top = stack[stack.length - 1];
    m.innerHTML = (stack.length > 1 ? `<button type="button" class="popover-item wb-menu-back" data-menu-back>← ${esc(top.title)}</button><div class="popover-section"></div>` : "")
      + top.items.map((x2, i) => {
        if (x2 === "—") return `<div class="popover-section"></div>`;
        return `<button type="button" class="popover-item ${x2.danger ? "is-danger" : ""}" data-menu-i="${i}" role="menuitem" ${x2.disabled ? "disabled" : ""}><span class="wb-ctx-ic">${x2.icon || ""}</span><span class="wb-ctx-lbl">${esc(x2.label)}</span><span class="wb-menu-kbd">${x2.sub ? "▸" : esc(x2.kbd || "")}</span></button>`;
      }).join("");
    const r2 = m.getBoundingClientRect();
    if (r2.bottom > window.innerHeight - 8) m.style.top = Math.max(8, window.innerHeight - r2.height - 8) + "px";
    if (r2.right > window.innerWidth - 8) m.style.left = Math.max(8, window.innerWidth - r2.width - 8) + "px";
  };
  render();
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-menu-back]")) { stack.pop(); render(); return; }
    const btn = e.target.closest("[data-menu-i]");
    if (!btn || btn.disabled) return;
    const item = stack[stack.length - 1].items[+btn.getAttribute("data-menu-i")];
    if (!item) return;
    if (item.sub) { stack.push({ title: item.label, items: item.sub }); render(); return; }
    closeAllPopovers();
    if (String(item.act || "").startsWith("fill:")) {
      const did = fillDriverIdAt(g.sheet, r);
      if (did) fillDriverAction(g, did, item.act);
      return;
    }
    switch (item.act) {
      case "cut": await copySelection(g, "cut"); break;
      case "copy": await copySelection(g); break;
      case "paste": await pasteFromClipboard(g); break;
      case "paste-values": await pasteValuesOnly(g); break;
      case "paste-format": pasteFormatOnly(g); break;
      case "paste-formulas": pasteSpecial(g, "formulas"); break;
      case "paste-transpose": pasteSpecial(g, "transpose"); break;
      case "insert-row-above": restructure(g, "row", rect0.r0, nRows); break;
      case "insert-row-below": restructure(g, "row", rect0.r1 + 1, nRows); break;
      case "insert-col-left": restructure(g, "col", rect0.c0, nCols); break;
      case "insert-col-right": restructure(g, "col", rect0.c1 + 1, nCols); break;
      case "insert-sheet": addSheetTo(g.blockId); break;
      case "delete-row": restructure(g, "row", rect0.r0, -nRows); break;
      case "delete-col": restructure(g, "col", rect0.c0, -nCols); break;
      case "clear-contents": clearSelection(g); break;
      case "clear-format": clearFormatting(g); break;
      case "filter-toggle": toggleFilterMode(g); break;
      case "history": openPanelTab("activity"); break;
      case "insert-link": insertLinkPrompt(g); break;
      case "comment": openCellComment(g, r, c); break;
      case "data-validation": openValidationDialog(g); break;
      case "format-cells": openFormatCellsDialog(g); break;
      case "cond-format": openCondFormatDialog(g); break;
      case "merge-toggle": toggleMergeSelection(g); break;
      case "sort-col-asc": sortByColumn(g, c, "asc"); break;
      case "sort-col-desc": sortByColumn(g, c, "desc"); break;
      case "sort-custom": openSortDialog(g); break;
      case "filter-col": openFilterPanel(g, c, null, { x, y }); break;
      case "copy-ref": try { await navigator.clipboard.writeText(cellRef(r, c)); _toast(`Copied ${cellRef(r, c)}`, "success"); } catch (_) {} break;
      case "trace-precedents": tracePrecedents(g); break;
      case "trace-dependents": traceDependents(g); break;
      case "insert-image": pickImageInto(g); break;
      case "view-image": { const s = cellImgSrc(g.sheet.cells.get(cellKey(r, c))); if (s) openImageLightbox(s); break; }
      case "remove-image": removeCellImage(g, r, c); break;
      case "open-link": { const l = g.sheet.cells.get(cellKey(r, c))?.format?.link; if (l) window.open(l, "_blank", "noopener"); break; }
      case "remove-link": formatSelection(g, { link: null }); break;
    }
  });
}

function openCellContextMenu(g, x, y, kind) {
  if (kind === "cell") return openSheetsCellMenu(g, x, y);
  const ro = !WB.canEdit;
  const { r, c } = g.active;
  const rect0 = selRect(g);
  const nRows = rect0.r1 - rect0.r0 + 1;
  const nCols = rect0.c1 - rect0.c0 + 1;
  const rowsLabel = kind === "row" && nRows > 1 ? `${nRows} rows` : "row";
  const colsLabel = kind === "col" && nCols > 1 ? `${nCols} columns` : "column";
  const hasHiddenRows = g.sheet.hiddenRows && [...g.sheet.hiddenRows].some((i) => i >= rect0.r0 && i <= rect0.r1);
  const hasHiddenCols = g.sheet.hiddenCols && [...g.sheet.hiddenCols].some((i) => i >= rect0.c0 && i <= rect0.c1);
  const ref = colLabel(c) + (r + 1);
  const item = (act, label, danger, disabled) => `<button type="button" class="popover-item ${danger ? "is-danger" : ""}" data-ctx="${act}" role="menuitem" ${disabled || (ro && act !== "copy" && act !== "copy-ref" && act !== "view-image") ? "disabled" : ""}>${label}</button>`;
  const sep = `<div class="popover-section"></div>`;
  const m = ctxMenu(x, y, [
    item("cut", "Cut"),
    item("copy", "Copy"),
    item("paste", "Paste"),
    sep,
    item("insert-row-above", `Insert ${rowsLabel} above`),
    item("insert-row-below", `Insert ${rowsLabel} below`),
    item("insert-col-left", `Insert ${colsLabel} left`),
    item("insert-col-right", `Insert ${colsLabel} right`),
    sep,
    item("clear-contents", "Clear contents"),
    item("clear-format", "Clear formatting"),
    item("format-cells", "Format cells…"),
    item("merge-toggle", "Merge / unmerge cells"),
    item("comment", "Add comment"),
    item("insert-link", (g.sheet.cells.get(cellKey(r, c))?.format?.link ? "Edit link…" : "Insert link…")),
    g.sheet.cells.get(cellKey(r, c))?.format?.link ? item("open-link", "Open link") : "",
    g.sheet.cells.get(cellKey(r, c))?.format?.link ? item("remove-link", "Remove link") : "",
    item("insert-image", "Insert image into cell…"),
    cellImgSrc(g.sheet.cells.get(cellKey(r, c))) ? item("view-image", "View image") : "",
    g.sheet.cells.get(cellKey(r, c))?.format?.img ? item("remove-image", "Remove image") : "",
    item("copy-ref", "Copy cell reference"),
    item("paste-values", "Paste values only"),
    item("trace-precedents", "Highlight precedents"),
    item("trace-dependents", "Highlight dependents"),
    item("data-validation", "Data validation…"),
    item("cond-format", "Conditional formatting…"),
    sep,
    item("sort-col-asc", "Sort sheet by this column A→Z"),
    item("sort-col-desc", "Sort sheet by this column Z→A"),
    item("sort-custom", "Custom sort…"),
    item("filter-col", "Filter this column…"),
    kind === "col" ? item("autofit-col", nCols > 1 ? `Autofit ${nCols} columns` : "Autofit column width") : "",
    kind === "row" ? item("hide-rows", `Hide ${rowsLabel}`) : "",
    kind === "row" && hasHiddenRows ? item("unhide-rows", "Unhide rows in selection") : "",
    kind === "col" ? item("hide-cols", `Hide ${colsLabel}`) : "",
    kind === "col" && hasHiddenCols ? item("unhide-cols", "Unhide columns in selection") : "",
    kind === "col" ? item("resize-col", "Resize column…") : "",
    kind === "row" ? item("resize-row", "Resize row…") : "",
    kind === "col" ? item("freeze-col", g.sheet.frozenCols ? "Unfreeze first column" : "Freeze first column") : "",
    kind === "row" ? item("freeze-row", g.sheet.frozenRows ? "Unfreeze top row" : "Freeze top row") : "",
    sep,
    item("delete-row", `Delete ${rowsLabel}`, true),
    item("delete-col", `Delete ${colsLabel}`, true),
  ].join(""));
  m.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-ctx]");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-ctx");
    closeAllPopovers();
    switch (act) {
      case "cut": await copySelection(g, "cut"); break;
      case "copy": await copySelection(g); break;
      case "paste": await pasteFromClipboard(g); break;
      case "insert-row-above": restructure(g, "row", rect0.r0, kind === "row" ? nRows : 1); break;
      case "insert-row-below": restructure(g, "row", rect0.r1 + 1, kind === "row" ? nRows : 1); break;
      case "insert-col-left": restructure(g, "col", rect0.c0, kind === "col" ? nCols : 1); break;
      case "insert-col-right": restructure(g, "col", rect0.c1 + 1, kind === "col" ? nCols : 1); break;
      case "clear-contents": clearSelection(g); break;
      case "clear-format": clearFormatting(g); break;
      case "format-cells": openFormatCellsDialog(g); break;
      case "comment": openCellComment(g, r, c); break;
      case "copy-ref": try { await navigator.clipboard.writeText(ref); _toast(`Copied ${ref}`, "success"); } catch (_) {} break;
      case "resize-col": {
        const w = window.prompt(`Column ${colLabel(c)} width (px, ${MIN_COL_W}–${MAX_COL_W}):`, String(colW(g.sheet, c)));
        if (w != null && isFinite(+w)) { g.sheet.colWidths[c] = Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.round(+w))); computeGeometry(g); repaintGrid(g); saveSheetMeta(g.sheet.id); }
        break;
      }
      case "resize-row": {
        const h2 = window.prompt(`Row ${r + 1} height (px, ${MIN_ROW_H}–${MAX_ROW_H}):`, String(rowH(g.sheet, r)));
        if (h2 != null && isFinite(+h2)) { g.sheet.rowHeights[r] = Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, Math.round(+h2))); computeGeometry(g); repaintGrid(g); saveSheetMeta(g.sheet.id); }
        break;
      }
      case "freeze-col": setFreeze(g, "col"); break;
      case "freeze-row": setFreeze(g, "row"); break;
      case "delete-row": restructure(g, "row", rect0.r0, kind === "row" ? -nRows : -1); break;
      case "delete-col": restructure(g, "col", rect0.c0, kind === "col" ? -nCols : -1); break;
      case "hide-rows": setHidden(g, "row", rect0.r0, rect0.r1, true); break;
      case "unhide-rows": setHidden(g, "row", rect0.r0, rect0.r1, false); break;
      case "hide-cols": setHidden(g, "col", rect0.c0, rect0.c1, true); break;
      case "unhide-cols": setHidden(g, "col", rect0.c0, rect0.c1, false); break;
      case "paste-values": await pasteValuesOnly(g); break;
      case "trace-precedents": tracePrecedents(g); break;
      case "trace-dependents": traceDependents(g); break;
      case "data-validation": openValidationDialog(g); break;
      case "cond-format": openCondFormatDialog(g); break;
      case "insert-link": insertLinkPrompt(g); break;
      case "insert-image": pickImageInto(g); break;
      case "view-image": { const s = cellImgSrc(g.sheet.cells.get(cellKey(r, c))); if (s) openImageLightbox(s); break; }
      case "remove-image": removeCellImage(g, r, c); break;
      case "open-link": {
        const cur = g.sheet.cells.get(cellKey(r, c));
        if (cur && cur.format && cur.format.link) window.open(cur.format.link, "_blank", "noopener");
        break;
      }
      case "remove-link": formatSelection(g, { link: null }); break;
      case "merge-toggle": toggleMergeSelection(g); break;
      case "sort-col-asc": sortByColumn(g, c, "asc"); break;
      case "sort-col-desc": sortByColumn(g, c, "desc"); break;
      case "sort-custom": openSortDialog(g); return;
      case "filter-col": openFilterPanel(g, c, null, { x, y }); return;
      case "autofit-col": autofitColumns(g, rect0.c0, rect0.c1); break;
    }
    g.els.grid.focus();
  });
}

function openSheetTabMenu(g, sheetId, x, y) {
  const sheets = WB.sheetsByBlock.get(g.blockId) || [];
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const visibleCount = sheets.filter((s) => !(s.meta && s.meta.hidden)).length;
  const curColor = (sheet.meta && sheet.meta.tabColor) || "";
  const m = ctxMenu(x, y, [
    `<button type="button" class="popover-item" data-ctx="rename" role="menuitem">Rename</button>`,
    `<button type="button" class="popover-item" data-ctx="duplicate" role="menuitem">Duplicate</button>`,
    `<button type="button" class="popover-item" data-ctx="move-left" role="menuitem">Move left</button>`,
    `<button type="button" class="popover-item" data-ctx="move-right" role="menuitem">Move right</button>`,
    `<div class="popover-section"></div>`,
    `<div class="wb-menu-head">Tab color</div>`,
    `<div class="wb-tabcolor-row">${["", ...WB_COLOR_MATRIX[5].slice(0, 8)].map((hex) =>
      `<button type="button" class="wb-swatch" data-tab-color="${hex}" title="${hex || "None"}" aria-label="${hex || "No color"}" style="background:${hex || "var(--surface)"};${hex === curColor || (!hex && !curColor) ? "outline:2px solid var(--accent);" : ""}">${hex ? "" : "×"}</button>`).join("")}</div>`,
    `<div class="popover-section"></div>`,
    `<button type="button" class="popover-item" data-ctx="hide" role="menuitem" ${visibleCount <= 1 ? "disabled" : ""}>Hide sheet</button>`,
    `<button type="button" class="popover-item is-danger" data-ctx="delete" role="menuitem" ${sheets.length <= 1 ? "disabled" : ""}>Delete…</button>`,
  ].join(""));
  m.addEventListener("click", (e) => {
    const swatch = e.target.closest("[data-tab-color]");
    if (swatch) {
      const hex = swatch.getAttribute("data-tab-color");
      sheet.meta = { ...(sheet.meta || {}), tabColor: hex || null };
      saveSheetMeta(sheetId);
      closeAllPopovers();
      renderSheetTabs(g);
      return;
    }
    const btn = e.target.closest("[data-ctx]");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-ctx");
    closeAllPopovers();
    if (act === "rename") renameSheet(g, sheetId);
    else if (act === "duplicate") duplicateSheet(g, sheetId);
    else if (act === "move-left") moveSheet(g, sheetId, -1);
    else if (act === "move-right") moveSheet(g, sheetId, 1);
    else if (act === "hide") {
      sheet.meta = { ...(sheet.meta || {}), hidden: true };
      saveSheetMeta(sheetId);
      if (g.sheet.id === sheetId) {
        const next = sheets.find((s) => s.id !== sheetId && !(s.meta && s.meta.hidden));
        if (next) switchSheet(g, next.id);
      }
      renderSheetTabs(g);
      wbLog("sheet.hidden", `hid sheet “${sheet.name}”`, { target_type: "sheet", target_id: sheetId });
    }
    else if (act === "delete") deleteSheet(g, sheetId);
  });
}

// ─── Comments + mentions ────────────────────────────────────────────────────

function openCellComment(g, r, c) {
  WB.commentDraftTarget = { blockId: g.blockId, sheetId: g.sheet.id, cellRef: colLabel(c) + (r + 1), rowIndex: r, colIndex: c };
  WB.panelOpen = true;
  WB.panelTab = "comments";
  syncPanelVisibility();
  renderPanel();
  setTimeout(() => document.querySelector("#wb-comment-composer textarea")?.focus(), 60);
}

async function submitComment(body, mentions, target, parentId) {
  const wb = WB.wb;
  if (!wb || !body.trim()) return;
  try {
    const row = {
      dsp_id: wb.dsp_id, workbook_id: wb.id,
      author_user_id: _me() ? _me().id : null,
      body: body.trim().slice(0, 4000),
      parent_comment_id: parentId || null,
      block_id: (target && target.blockId) || null,
      sheet_id: (target && target.sheetId) || null,
      cell_ref: (target && target.cellRef) || null,
      row_index: target && target.rowIndex != null ? target.rowIndex : null,
      col_index: target && target.colIndex != null ? target.colIndex : null,
    };
    const ins = await _sb().from("workbook_comments").insert(row).select().single();
    if (ins.error) throw ins.error;
    WB.comments.push(ins.data);
    for (const uid of mentions) {
      if (!uid) continue;
      const mRes = await _sb().from("workbook_mentions").insert({
        dsp_id: wb.dsp_id, workbook_id: wb.id, comment_id: ins.data.id,
        mentioned_user_id: uid, created_by_user_id: _me() ? _me().id : null,
      });
      if (mRes.error) console.warn("mention:", mRes.error.message);
    }
    wbLog("comment.added", target && target.cellRef ? `commented on cell ${target.cellRef}` : parentId ? "replied to a comment" : "commented on the workbook", { target_type: "comment", target_id: ins.data.id });
    WB.commentDraftTarget = null;
    renderPanelBody();
    paintCommentMarkers();
  } catch (e) { _toast("Couldn't post the comment: " + ((e && e.message) || e), "error"); }
}

async function resolveComment(commentId, resolve) {
  try {
    const patch = resolve
      ? { resolved_at: new Date().toISOString(), resolved_by: _me() ? _me().id : null }
      : { resolved_at: null, resolved_by: null };
    const res = await _sb().from("workbook_comments").update(patch).eq("id", commentId);
    if (res.error) throw res.error;
    const c = WB.comments.find((x) => x.id === commentId);
    if (c) Object.assign(c, patch);
    if (resolve) wbLog("comment.resolved", "resolved a comment", { target_type: "comment", target_id: commentId });
    renderPanelBody();
    paintCommentMarkers();
  } catch (e) { _toast("Couldn't update the comment", "error"); }
}

async function deleteComment(commentId) {
  try {
    const res = await _sb().from("workbook_comments").delete().eq("id", commentId);
    if (res.error) throw res.error;
    WB.comments = WB.comments.filter((c) => c.id !== commentId && c.parent_comment_id !== commentId);
    renderPanelBody();
    paintCommentMarkers();
  } catch (e) { _toast("Couldn't delete the comment", "error"); }
}

// Renders @Name tokens in bold; body itself is escaped first.
function commentBodyHtml(body) {
  let html = esc(body);
  for (const u of WB.users) {
    const nm = u.full_name && u.full_name.trim();
    if (!nm) continue;
    html = html.split("@" + esc(nm)).join(`<span class="wb-mention">@${esc(nm)}</span>`);
  }
  return html.replace(/\n/g, "<br>");
}

// Mention picker inside a composer textarea: fires on "@query" before
// the caret, offers matching teammates, records picked ids.
function attachMentionPicker(textarea, picked) {
  let pop = null;
  const close = () => { if (pop) { pop.remove(); pop = null; } };
  const query = () => {
    const upto = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
    const m = /@([\w .-]{0,30})$/.exec(upto);
    return m ? { q: m[1].toLowerCase(), start: upto.length - m[0].length } : null;
  };
  textarea.addEventListener("input", () => {
    const q = query();
    close();
    if (!q) return;
    const matches = WB.users.filter((u) => (u.full_name || "").toLowerCase().includes(q.q)).slice(0, 6);
    if (!matches.length) return;
    pop = document.createElement("div");
    pop.className = "popover open wb-mention-pop";
    pop.setAttribute("role", "listbox");
    pop.innerHTML = matches.map((u) => `<button type="button" class="popover-item" data-mention="${esc(u.id)}" role="option"><span class="wb-avatar wb-avatar-sm">${esc(initialsOf(u.full_name))}</span> ${esc(u.full_name || u.email)}</button>`).join("");
    const rect = textarea.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.left = rect.left + "px";
    pop.style.top = Math.max(8, rect.top - Math.min(240, matches.length * 40 + 12)) + "px";
    pop.style.minWidth = Math.min(280, rect.width) + "px";
    document.body.appendChild(pop);
    pop.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-mention]");
      if (!btn) return;
      e.preventDefault();
      const u = WB.users.find((x) => x.id === btn.getAttribute("data-mention"));
      if (!u) return;
      const qq = query();
      if (qq) {
        const after = textarea.value.slice(textarea.selectionStart ?? textarea.value.length);
        textarea.value = textarea.value.slice(0, qq.start) + "@" + (u.full_name || "teammate") + " " + after;
        picked.add(u.id);
        textarea.focus();
        const pos = qq.start + 1 + (u.full_name || "teammate").length + 1;
        textarea.setSelectionRange(pos, pos);
      }
      close();
    });
  });
  textarea.addEventListener("blur", () => setTimeout(close, 150));
  textarea.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) { e.stopPropagation(); close(); } });
}

// ─── Right panel ─────────────────────────────────────────────────────────────

function syncPanelVisibility() {
  const panel = document.getElementById("wb-panel");
  const detail = document.getElementById("wb-detail");
  if (panel) panel.hidden = !WB.panelOpen;
  if (detail) detail.classList.toggle("is-panel-open", WB.panelOpen);
  // the toggle lives in each sheet toolbar now (the header button is gone)
  document.querySelectorAll('[data-wb-tb="panel-toggle"]').forEach((b) => {
    b.classList.toggle("is-on", WB.panelOpen);
    b.setAttribute("aria-pressed", String(WB.panelOpen));
  });
}

function renderPanel() {
  const panel = document.getElementById("wb-panel");
  if (!panel || !WB.panelOpen) return;
  const tabs = [
    ["comments", "Comments"], ["activity", "Activity"], ["details", "Details"], ["sharing", "Sharing"],
  ];
  panel.innerHTML = `
    <div class="wb-panel-tabs" role="tablist" aria-label="Workbook panel">
      ${tabs.map(([k, label]) => `<button type="button" class="wb-panel-tab ${WB.panelTab === k ? "is-active" : ""}" role="tab" aria-selected="${WB.panelTab === k}" data-wb-paneltab="${k}">${label}</button>`).join("")}
      <button type="button" class="wb-panel-close" data-wb-act="panel-close" title="Close panel" aria-label="Close panel">✕</button>
    </div>
    <div class="wb-panel-body" id="wb-panel-body"></div>`;
  renderPanelBody();
}

function refreshPanel() { if (WB.panelOpen) renderPanel(); }

function renderPanelBody() {
  const body = document.getElementById("wb-panel-body");
  if (!body) return;
  if (WB.panelTab === "comments") return renderCommentsPanel(body);
  if (WB.panelTab === "tasks") return renderTasksPanel(body);
  if (WB.panelTab === "activity") return renderActivityPanel(body);
  if (WB.panelTab === "details") return renderDetailsPanel(body);
  if (WB.panelTab === "sharing") return renderSharingPanel(body);
}

function renderCommentsPanel(body) {
  const top = WB.comments.filter((c) => !c.parent_comment_id);
  const visible = top.filter((c) => (WB.showResolved ? true : !c.resolved_at)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const resolvedCount = top.filter((c) => c.resolved_at).length;
  const target = WB.commentDraftTarget;
  const thread = (c) => {
    const replies = WB.comments.filter((x) => x.parent_comment_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const mine = _me() && c.author_user_id === _me().id;
    return `<div class="wb-thread ${c.resolved_at ? "is-resolved" : ""}" data-wb-thread="${c.id}">
      <div class="wb-comment">
        <span class="wb-avatar wb-avatar-sm">${esc(initialsOf(userName(c.author_user_id)))}</span>
        <div class="wb-comment-main">
          <div class="wb-comment-head">
            <strong>${esc(userName(c.author_user_id))}</strong>
            <span class="wb-comment-when">${esc(relTime(c.created_at))}</span>
            ${c.cell_ref ? `<button type="button" class="wb-comment-anchor" data-wb-act="jump-cell" data-sheet="${esc(c.sheet_id || "")}" data-ref="${esc(c.cell_ref)}" title="Jump to cell">${esc(c.cell_ref)}</button>` : c.block_id ? `<span class="wb-comment-anchor is-static">block</span>` : ""}
          </div>
          <div class="wb-comment-body">${commentBodyHtml(c.body)}</div>
          <div class="wb-comment-actions">
            <button type="button" class="wb-linklike" data-wb-act="comment-reply" data-id="${c.id}">Reply</button>
            <button type="button" class="wb-linklike" data-wb-act="comment-resolve" data-id="${c.id}" data-on="${c.resolved_at ? "0" : "1"}">${c.resolved_at ? "Reopen" : "Resolve"}</button>
            ${mine ? `<button type="button" class="wb-linklike is-danger" data-wb-act="comment-delete" data-id="${c.id}">Delete</button>` : ""}
          </div>
        </div>
      </div>
      ${replies.map((rp) => `<div class="wb-comment is-reply">
        <span class="wb-avatar wb-avatar-sm">${esc(initialsOf(userName(rp.author_user_id)))}</span>
        <div class="wb-comment-main">
          <div class="wb-comment-head"><strong>${esc(userName(rp.author_user_id))}</strong><span class="wb-comment-when">${esc(relTime(rp.created_at))}</span></div>
          <div class="wb-comment-body">${commentBodyHtml(rp.body)}</div>
          ${_me() && rp.author_user_id === _me().id ? `<div class="wb-comment-actions"><button type="button" class="wb-linklike is-danger" data-wb-act="comment-delete" data-id="${rp.id}">Delete</button></div>` : ""}
        </div>
      </div>`).join("")}
      <div class="wb-reply-slot" data-wb-replyslot="${c.id}"></div>
    </div>`;
  };
  body.innerHTML = `
    <div class="wb-composer" id="wb-comment-composer">
      ${target ? `<div class="wb-composer-target">Commenting on <strong>${esc(target.cellRef)}</strong> <button type="button" class="wb-linklike" data-wb-act="comment-target-clear">×</button></div>` : ""}
      <textarea class="wb-input" rows="2" maxlength="4000" placeholder="Add a comment — @ to mention a teammate…" aria-label="New comment"></textarea>
      <div class="wb-composer-foot"><button type="button" class="btn btn-primary btn-sm" data-wb-act="comment-submit">Comment</button></div>
    </div>
    ${visible.length ? visible.map(thread).join("") : `<div class="rr-empty-inline">No ${WB.showResolved ? "" : "open "}comments yet — start the conversation above.</div>`}
    ${resolvedCount ? `<button type="button" class="wb-linklike wb-resolved-toggle" data-wb-act="toggle-resolved">${WB.showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}</button>` : ""}`;
  const ta = body.querySelector("#wb-comment-composer textarea");
  if (ta) {
    const picked = new Set();
    ta._wbPicked = picked;
    attachMentionPicker(ta, picked);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); body.querySelector('[data-wb-act="comment-submit"]').click(); }
    });
  }
}

function renderTasksPanel(body) {
  const checklistBlocks = WB.blocks.filter((b) => b.type === "checklist");
  const all = [];
  for (const b of checklistBlocks) for (const it of WB.itemsByBlock.get(b.id) || []) all.push({ ...it, blockTitle: b.title || "Checklist" });
  const filtered = all.filter((it) => (WB.taskFilter === "open" ? !it.completed_at : WB.taskFilter === "done" ? !!it.completed_at : true));
  filtered.sort((a, b) => (a.completed_at ? 1 : 0) - (b.completed_at ? 1 : 0) || String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")));
  body.innerHTML = `
    <div class="wb-panel-filter">
      <div class="wb-seg" role="group" aria-label="Task filter">
        ${[["open", "Open"], ["done", "Done"], ["all", "All"]].map(([k, l]) => `<button type="button" class="wb-seg-btn ${WB.taskFilter === k ? "is-active" : ""}" data-wb-taskfilter="${k}">${l}</button>`).join("")}
      </div>
      ${WB.canEdit && checklistBlocks.length ? `<button type="button" class="btn btn-ghost btn-sm" data-wb-act="panel-add-task">+ Task</button>` : ""}
    </div>
    ${filtered.length ? filtered.map((it) => `
      <div class="wb-task ${it.completed_at ? "is-done" : ""}" data-wb-item="${it.id}">
        <button type="button" class="wb-cl-check" data-wb-act="item-toggle" role="checkbox" aria-checked="${!!it.completed_at}" ${WB.canEdit ? "" : "disabled"}>
          ${it.completed_at ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
        </button>
        <div class="wb-task-main">
          <span class="wb-cl-label">${esc(it.label)}</span>
          <span class="wb-task-meta">${esc(it.blockTitle)}${it.due_date ? ` · due ${esc(new Date(it.due_date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }))}` : ""}${it.assignee_user_id ? ` · ${esc(userName(it.assignee_user_id))}` : ""}</span>
        </div>
        ${WB.canEdit ? `<button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-act="item-edit" title="Edit task" aria-label="Edit task"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>` : ""}
      </div>`).join("") : `<div class="rr-empty-inline">${checklistBlocks.length ? `No ${WB.taskFilter === "done" ? "completed" : WB.taskFilter === "open" ? "open" : ""} tasks.` : "Add a checklist block to track tasks in this workbook."}</div>`}`;
}

function renderActivityPanel(body) {
  if (!WB.activity.length) {
    body.innerHTML = `<div class="rr-empty-inline">No activity yet — changes to this workbook will show up here.</div>`;
    return;
  }
  body.innerHTML = WB.activity.slice(0, 100).map((a) => `
    <div class="wb-act">
      <span class="wb-avatar wb-avatar-sm">${esc(initialsOf(userName(a.actor_user_id)))}</span>
      <div class="wb-act-main">
        <span class="wb-act-line"><strong>${esc(userName(a.actor_user_id))}</strong> ${esc(a.summary || a.action)}</span>
        <span class="wb-act-when">${esc(relTime(a.created_at))}</span>
      </div>
    </div>`).join("");
}

function renderDetailsPanel(body) {
  const wb = WB.wb;
  const tpl = WB_TEMPLATES.find((t) => t.key === wb.template_key);
  const sheetCount = [...WB.sheetsByBlock.values()].reduce((a, arr) => a + arr.length, 0);
  const row = (label, val) => `<div class="wb-kv"><span class="wb-kv-k">${label}</span><span class="wb-kv-v">${val}</span></div>`;
  body.innerHTML = [
    row("Owner", esc(userName(wb.owner_user_id))),
    row("Visibility", wb.visibility === "private" ? "Private — owner + shared people" : "Everyone at " + esc((_dsp() && _dsp().name) || "this DSP")),
    row("Created", esc(fmtWhen(wb.created_at))),
    row("Last updated", esc(fmtWhen(wb.updated_at))),
    tpl ? row("Template", esc(tpl.name)) : "",
    row("Blocks", `${WB.blocks.length} (${WB.blocks.filter((b) => b.type === "sheet").length} spreadsheet, ${WB.blocks.filter((b) => b.type === "text").length} note, ${WB.blocks.filter((b) => b.type === "checklist").length} checklist)`),
    row("Sheets", String(sheetCount)),
    wb.archived_at ? row("Archived", esc(fmtWhen(wb.archived_at))) : "",
  ].join("");
}

function renderSharingPanel(body) {
  const wb = WB.wb;
  const userPerms = WB.permissions.filter((p) => p.subject_type === "user");
  const canManage = WB.canAdmin;
  const levels = [["view", "View"], ["comment", "Comment"], ["edit", "Edit"], ["admin", "Admin"]];
  body.innerHTML = `
    <div class="wb-share-vis">
      <span class="wb-field-label">Visibility</span>
      ${canManage ? `
        <label class="wb-vis-opt"><input type="radio" name="wb-share-vis" value="org" ${wb.visibility === "org" ? "checked" : ""}> <span><strong>Everyone at ${esc((_dsp() && _dsp().name) || "this DSP")}</strong><br><span class="wb-vis-sub">All staff can view and edit</span></span></label>
        <label class="wb-vis-opt"><input type="radio" name="wb-share-vis" value="private" ${wb.visibility === "private" ? "checked" : ""}> <span><strong>Restricted</strong><br><span class="wb-vis-sub">Only the owner and people below</span></span></label>`
      : `<p class="wb-vis-sub">${wb.visibility === "private" ? "Restricted — only the owner and shared people." : "Everyone at " + esc((_dsp() && _dsp().name) || "this DSP") + " can view and edit."}</p>`}
    </div>
    <div class="wb-share-list">
      <div class="wb-share-row">
        <span class="wb-avatar wb-avatar-sm">${esc(initialsOf(userName(wb.owner_user_id)))}</span>
        <span class="wb-share-name">${esc(userName(wb.owner_user_id))}</span>
        <span class="wb-share-level">Owner</span>
      </div>
      ${userPerms.map((p) => `
        <div class="wb-share-row" data-wb-perm="${p.id}">
          <span class="wb-avatar wb-avatar-sm">${esc(initialsOf(userName(p.subject_id)))}</span>
          <span class="wb-share-name">${esc(userName(p.subject_id))}</span>
          ${canManage ? `<select class="wb-input wb-share-sel" data-wb-permlevel="${p.id}" aria-label="Access level">
            ${levels.map(([k, l]) => `<option value="${k}" ${p.access_level === k ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-permremove="${p.id}" title="Remove access" aria-label="Remove access">×</button>`
          : `<span class="wb-share-level">${esc(p.access_level)}</span>`}
        </div>`).join("")}
      ${!userPerms.length && wb.visibility === "private" ? `<div class="rr-empty-inline">No one else has access yet.</div>` : ""}
    </div>
    ${canManage ? `<div class="wb-share-add">
      <select class="wb-input" id="wb-share-user" aria-label="Add person">
        <option value="">Add a person…</option>
        ${WB.users.filter((u) => u.id !== wb.owner_user_id && !userPerms.some((p) => p.subject_id === u.id)).map((u) => `<option value="${esc(u.id)}">${esc(u.full_name || u.email)}</option>`).join("")}
      </select>
      <select class="wb-input" id="wb-share-level" aria-label="Access level">
        ${levels.map(([k, l]) => `<option value="${k}" ${k === "edit" ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button type="button" class="btn btn-sm" data-wb-act="share-add">Share</button>
    </div>` : ""}`;
  if (canManage) {
    body.querySelectorAll('input[name="wb-share-vis"]').forEach((radio) => radio.addEventListener("change", async () => {
      wb.visibility = radio.value;
      saveWbMeta.flushNow();
      computeAccess();
      wbLog("workbook.shared", radio.value === "org" ? "opened the workbook to everyone at the DSP" : "restricted the workbook");
      renderPanelBody();
    }));
    body.querySelectorAll("[data-wb-permlevel]").forEach((sel) => sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-wb-permlevel");
      try {
        const res = await _sb().from("workbook_permissions").update({ access_level: sel.value }).eq("id", id);
        if (res.error) throw res.error;
        const p = WB.permissions.find((x) => x.id === id);
        if (p) p.access_level = sel.value;
        wbLog("workbook.shared", `changed ${userName(p && p.subject_id)}'s access to ${sel.value}`);
      } catch (e) { _toast("Couldn't change access", "error"); }
    }));
  }
}

// ─── Menu bar ────────────────────────────────────────────────────────────────
// Google Sheets-style File/Edit/View/Insert/Format/Data menus over the
// open workbook. Items dispatch to the same functions as the toolbar and
// context menus; grid actions target the last-focused sheet block.
// Submenus drill in (the row swaps to the child list with a ← back row).

function activeGrid() {
  if (WB.activeGridId && GRIDS.has(WB.activeGridId)) return GRIDS.get(WB.activeGridId);
  return GRIDS.values().next().value || null;
}

function openPanelTab(tab) {
  WB.panelOpen = true;
  WB.panelTab = tab;
  syncPanelVisibility();
  renderPanel();
}

function insertLinkPrompt(g) {
  const { r, c } = g.active;
  const cur = g.sheet.cells.get(cellKey(r, c));
  const url = window.prompt("Link URL (https://… or mailto:…)", (cur && cur.format && cur.format.link) || "https://");
  if (url == null) return;
  const t = url.trim();
  if (t && t !== "https://" && !/^(https?:\/\/|mailto:)/i.test(t)) { _toast("Links must start with http(s):// or mailto:", "warn"); return; }
  formatSelection(g, { link: t && t !== "https://" ? t.slice(0, 2000) : null });
}

const WB_MENUS = ["File", "Edit", "View", "Insert", "Format", "Data"];

function wbMenuItems(menu, g) {
  const ed = WB.canEdit;
  const sep = "—";
  switch (menu) {
    case "File": return [
      { label: "New workbook", act: "file:new" },
      { label: "Make a copy", act: "file:copy", disabled: !ed },
      { label: "Import CSV…", act: "file:import", disabled: !ed || !g },
      sep,
      { label: "Download", sub: [
        { label: "Microsoft Excel (.xlsx)", act: "file:xlsx", disabled: !g },
        { label: "CSV (current sheet)", act: "file:csv", disabled: !g },
      ] },
      { label: "Print…", act: "file:print", disabled: !g },
      sep,
      { label: "Rename", act: "file:rename", disabled: !ed },
      { label: "Share", act: "file:share" },
      { label: "Version history (activity)", act: "file:activity" },
      { label: "Details", act: "file:details" },
      sep,
      { label: WB.wb && WB.wb.archived_at ? "Restore workbook" : "Archive workbook", act: "file:archive", disabled: !WB.canAdmin },
      { label: "Delete workbook…", act: "file:delete", danger: true, disabled: !WB.canAdmin },
    ];
    case "Edit": return [
      { label: "Undo", act: "edit:undo", kbd: "Ctrl+Z", disabled: !ed || !g },
      { label: "Redo", act: "edit:redo", kbd: "Ctrl+Y", disabled: !ed || !g },
      sep,
      { label: "Cut", act: "edit:cut", kbd: "Ctrl+X", disabled: !ed || !g },
      { label: "Copy", act: "edit:copy", kbd: "Ctrl+C", disabled: !g },
      { label: "Paste", act: "edit:paste", kbd: "Ctrl+V", disabled: !ed || !g },
      { label: "Paste values only", act: "edit:paste-values", disabled: !ed || !g },
      sep,
      { label: "Delete selected rows", act: "edit:del-rows", disabled: !ed || !g },
      { label: "Delete selected columns", act: "edit:del-cols", disabled: !ed || !g },
      { label: "Clear contents", act: "edit:clear", kbd: "Del", disabled: !ed || !g },
      sep,
      { label: "Find and replace", act: "edit:find", kbd: "Ctrl+H", disabled: !g },
    ];
    case "View": {
      const hiddenSheets = g ? (WB.sheetsByBlock.get(g.blockId) || []).filter((s) => s.meta && s.meta.hidden) : [];
      const nogrid = !!(g && g.sheet.meta && g.sheet.meta.nogrid);
      const fbarOn = WB.showFbar !== false;
      return [
      { label: "Show", sub: [
        { label: (fbarOn ? "✓ " : "") + "Formula bar", act: "view:show-fbar" },
        { label: (nogrid ? "" : "✓ ") + "Gridlines", act: "view:show-grid", disabled: !ed || !g },
        { label: ((g && g.showFormulas) ? "✓ " : "") + "Formulas", act: "view:show-formulas", kbd: "Ctrl+`", disabled: !g },
      ] },
      { label: "Freeze", sub: [
        { label: "Freeze top row", act: "view:freeze-row", disabled: !ed || !g },
        { label: "Freeze first column", act: "view:freeze-col", disabled: !ed || !g },
        { label: "Unfreeze", act: "view:unfreeze", disabled: !ed || !g },
      ] },
      { label: "Zoom", sub: [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((z) => ({ label: Math.round(z * 100) + "%", act: "view:zoom:" + z, disabled: !g })) },
      sep,
      { label: "Hidden sheets", sub: hiddenSheets.length
        ? hiddenSheets.map((s) => ({ label: s.name, act: "view:unhide-sheet:" + s.id, disabled: !ed }))
        : [{ label: "No hidden sheets", act: "view:noop", disabled: true }] },
      { label: "Unhide all rows & columns", act: "view:unhide", disabled: !ed || !g },
      sep,
      { label: "Full screen", act: "view:fullscreen" },
      sep,
      { label: "Comments panel", act: "view:comments" },
      { label: "Activity panel", act: "view:activity" },
    ];
    }
    case "Insert": return [
      { label: "Row above", act: "ins:row-above", disabled: !ed || !g },
      { label: "Row below", act: "ins:row-below", disabled: !ed || !g },
      { label: "Column left", act: "ins:col-left", disabled: !ed || !g },
      { label: "Column right", act: "ins:col-right", disabled: !ed || !g },
      { label: "New sheet", act: "ins:sheet", disabled: !ed || !g },
      sep,
      { label: "Chart…", act: "ins:chart", disabled: !ed || !g },
      { label: "Pivot table…", act: "ins:pivot", disabled: !ed || !g },
      { label: "Function", sub: [
        ...["SUM", "AVERAGE", "COUNT", "MAX", "MIN", "IF", "COUNTIF", "SUMIF", "VLOOKUP", "XLOOKUP"].map((fn) => ({ label: fn, act: "ins:fn:" + fn, disabled: !ed || !g })),
        sep,
        { label: `All functions… (${FUNCTION_META.length})`, act: "ins:fnbrowse", disabled: !ed || !g },
      ] },
      { label: "Link…", act: "ins:link", disabled: !ed || !g },
      { label: "Image (into cell)…", act: "ins:image", disabled: !ed || !g },
      { label: "Dropdown (data validation)…", act: "ins:dropdown", disabled: !ed || !g },
      { label: "Comment", act: "ins:comment", disabled: !g },
    ];
    case "Format": return [
      { label: "Number", sub: [["", "Automatic"], ["number", "Number"], ["currency", "Currency"], ["accounting", "Accounting"], ["percent", "Percent"], ["scientific", "Scientific"], ["date", "Date"], ["text", "Plain text"]].map(([v, label]) => ({ label, act: "fmt:num:" + v, disabled: !ed || !g })) },
      { label: "Text", sub: [["bold", "Bold", "Ctrl+B"], ["italic", "Italic", "Ctrl+I"], ["underline", "Underline", "Ctrl+U"], ["strike", "Strikethrough", ""]].map(([k, label, kbd]) => ({ label, kbd, act: "fmt:tog:" + k, disabled: !ed || !g })) },
      { label: "Alignment", sub: [["align:left", "Left"], ["align:center", "Center"], ["align:right", "Right"], ["valign:top", "Top"], ["valign:middle", "Middle"], ["valign:bottom", "Bottom"]].map(([v, label]) => ({ label, act: "fmt:" + v, disabled: !ed || !g })) },
      { label: "Wrapping", act: "fmt:tog:wrap", disabled: !ed || !g },
      { label: "Borders", sub: [
        ...[["all", "All borders"], ["outline", "Outline"], ["top", "Top border"], ["bottom", "Bottom border"], ["left", "Left border"], ["right", "Right border"], ["", "No borders"]].map(([v, label]) => ({ label, act: "fmt:border:" + v, disabled: !ed || !g })),
        sep,
        ...[["1", "Thin line"], ["2", "Medium line"], ["3", "Thick line"]].map(([v, label]) => ({ label, act: "fmt:bw:" + v, disabled: !ed || !g })),
      ] },
      { label: "Rotation", sub: [["", "None"], ["45", "Tilt 45°"], ["90", "Vertical"]].map(([v, label]) => ({ label, act: "fmt:rot:" + v, disabled: !ed || !g })) },
      { label: "Font size", sub: [8, 10, 12, 13, 14, 18, 24].map((n) => ({ label: String(n) + " px", act: "fmt:fs:" + n, disabled: !ed || !g })) },
      sep,
      { label: "Merge cells", act: "fmt:merge", disabled: !ed || !g },
      { label: "Conditional formatting…", act: "fmt:cf", disabled: !ed || !g },
      { label: "Format cells…", act: "fmt:cells", disabled: !ed || !g },
      sep,
      { label: "Clear formatting", act: "fmt:clear", disabled: !ed || !g },
    ];
    case "Data": {
      const views = g ? sheetFilterViews(g.sheet) : [];
      return [
        { label: "Load from RouteReady", sub: [
          { label: "Drivers…", act: "data:fill-people", disabled: !ed || !g },
          { label: "Vans", act: "data:fill-vans", disabled: !ed || !g },
          { label: "Schedule (this week)", act: "data:fill-schedule", disabled: !ed || !g },
          { label: "Time off / PTO", act: "data:fill-pto", disabled: !ed || !g },
        ] },
        { label: "Build Schedule from Sheet…", act: "data:fill-build", disabled: !ed || !g },
        { label: "Send selection as checklist to Driver App…", act: "data:checklist-send", disabled: !ed || !g },
        sep,
        { label: "Sort sheet by active column, A→Z", act: "data:sort-asc", disabled: !ed || !g },
        { label: "Sort sheet by active column, Z→A", act: "data:sort-desc", disabled: !ed || !g },
        { label: "Custom sort…", act: "data:sort", disabled: !ed || !g },
        sep,
        { label: g && g.filterMode ? "Remove filter" : "Create a filter", act: "data:filter-toggle", disabled: !g },
        { label: "Filter this column…", act: "data:filter", disabled: !g },
        { label: "Clear filters", act: "data:filter-clear", disabled: !g },
        { label: "Filter views", sub: [
          ...views.map((v) => ({ label: v.name, act: "data:fv:" + v.id })),
          ...(views.length ? [sep] : []),
          { label: "Save current filters as view…", act: "data:fv-save", disabled: !ed || !g },
          ...(views.length ? [{ label: "Delete a view", sub: views.map((v) => ({ label: "✕ " + v.name, act: "data:fv-del:" + v.id, disabled: !ed })) }] : []),
        ] },
        sep,
        { label: "Column stats", act: "data:stats", disabled: !g },
        { label: "Pivot table…", act: "data:pivot", disabled: !ed || !g },
        { label: "Named ranges…", act: "data:names", disabled: !g },
        { label: "Data validation…", act: "data:validation", disabled: !ed || !g },
        { label: "Split text to columns…", act: "data:split", disabled: !ed || !g },
        { label: "Data cleanup", sub: [
          { label: "Remove duplicates…", act: "data:dedupe", disabled: !ed || !g },
          { label: "Trim whitespace", act: "data:trim", disabled: !ed || !g },
        ] },
      ];
    }
  }
  return [];
}

function wbMenuAction(act, g) {
  const parts = String(act || "").split(":");
  const ns = parts[0], verb = parts[1], arg = parts.slice(2).join(":");
  const rect = g ? selRect(g) : null;
  const need = () => { if (!g) _toast("Open a spreadsheet block first", "info"); return !!g; };
  switch (`${ns}:${verb}`) {
    case "file:new": createBlankWorkbookNow(); return;
    case "file:copy": duplicateWorkbook(); return;
    case "file:import": if (need()) importCsvInto(g); return;
    case "file:xlsx": if (need()) exportBlockXlsx(g); return;
    case "file:csv": if (need()) exportSheetCsv(g); return;
    case "file:print": if (need()) printSheet(g); return;
    case "file:rename": { const t = document.getElementById("wb-title-input"); if (t) { t.focus(); t.select(); } return; }
    case "file:share": openPanelTab("sharing"); return;
    case "file:activity": openPanelTab("activity"); return;
    case "file:details": openPanelTab("details"); return;
    case "file:archive": archiveWorkbook(!!(WB.wb && WB.wb.archived_at)); return;
    case "file:delete": deleteWorkbookFlow(); return;
    case "edit:undo": if (need()) undoGrid(g); return;
    case "edit:redo": if (need()) redoGrid(g); return;
    case "edit:cut": if (need()) copySelection(g, "cut"); return;
    case "edit:copy": if (need()) copySelection(g); return;
    case "edit:paste": if (need()) pasteFromClipboard(g); return;
    case "edit:paste-values": if (need()) pasteValuesOnly(g); return;
    case "edit:del-rows": if (need()) restructure(g, "row", rect.r0, -(rect.r1 - rect.r0 + 1)); return;
    case "edit:del-cols": if (need()) restructure(g, "col", rect.c0, -(rect.c1 - rect.c0 + 1)); return;
    case "edit:clear": if (need()) clearSelection(g); return;
    case "edit:find": if (need()) openFindPanel(g, WB.canEdit); return;
    case "view:show-fbar": {
      WB.showFbar = WB.showFbar === false; // toggles (default is on)
      try { localStorage.setItem("rr-wb-fbar", WB.showFbar ? "1" : "0"); } catch (_) {}
      document.querySelectorAll("#wb-blocks .wb-fbar").forEach((el) => { el.hidden = !WB.showFbar; });
      return;
    }
    case "view:show-grid": if (need()) {
      g.sheet.meta = { ...(g.sheet.meta || {}), nogrid: !(g.sheet.meta && g.sheet.meta.nogrid) };
      saveSheetMeta(g.sheet.id);
      g.els.grid.classList.toggle("is-nogrid", !!g.sheet.meta.nogrid);
    } return;
    case "view:show-formulas": if (need()) { g.showFormulas = !g.showFormulas; repaintGrid(g); } return;
    case "view:fullscreen": {
      const el = document.getElementById("wb-detail");
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (el && el.requestFullscreen) el.requestFullscreen();
      } catch (_) { _toast("Full screen isn't available here", "info"); }
      return;
    }
    case "view:noop": return;
    case "view:freeze-row": if (need()) { g.sheet.frozenRows = 1; saveSheetMeta(g.sheet.id); repaintGrid(g); } return;
    case "view:freeze-col": if (need()) { g.sheet.frozenCols = 1; saveSheetMeta(g.sheet.id); repaintGrid(g); } return;
    case "view:unfreeze": if (need()) setFreeze(g, "none"); return;
    case "view:unhide": if (need()) { g.sheet.hiddenRows.clear(); g.sheet.hiddenCols.clear(); saveSheetMeta(g.sheet.id); computeGeometry(g); repaintGrid(g); } return;
    case "view:comments": openPanelTab("comments"); return;
    case "view:tasks": openPanelTab("tasks"); return;
    case "view:activity": openPanelTab("activity"); return;
    case "ins:row-above": if (need()) restructure(g, "row", rect.r0, 1); return;
    case "ins:row-below": if (need()) restructure(g, "row", rect.r1 + 1, 1); return;
    case "ins:col-left": if (need()) restructure(g, "col", rect.c0, 1); return;
    case "ins:col-right": if (need()) restructure(g, "col", rect.c1 + 1, 1); return;
    case "ins:sheet": if (need()) addSheetTo(g.blockId); return;
    case "ins:chart": if (need()) openChartDialog(g); return;
    case "ins:pivot": if (need()) openPivotDialog(g); return;
    case "ins:fnbrowse": if (need()) {
      const fnBtn = document.querySelector(`[data-wb-toolbar="${g.blockId}"] [data-wb-tb="fn-menu"]`);
      if (fnBtn) { fnBrowserPop(g, fnBtn); togglePopover(fnBtn); setTimeout(() => fnBtn.closest(".popover-anchor")?.querySelector(".wb-fn-search")?.focus(), 0); }
    } return;
    case "ins:link": if (need()) insertLinkPrompt(g); return;
    case "ins:image": if (need()) pickImageInto(g); return;
    case "ins:dropdown": if (need()) openValidationDialog(g); return;
    case "ins:comment": if (need()) openCellComment(g, g.active.r, g.active.c); return;
    case "fmt:merge": if (need()) toggleMergeSelection(g); return;
    case "fmt:cf": if (need()) openCondFormatDialog(g); return;
    case "fmt:cells": if (need()) openFormatCellsDialog(g); return;
    case "fmt:clear": if (need()) clearFormatting(g); return;
    case "data:fill-people": if (need()) openPeoplePicker(g); return;
    case "data:fill-vans": if (need()) fillLoadVans(g); return;
    case "data:fill-schedule": if (need()) fillLoadSchedule(g); return;
    case "data:fill-pto": if (need()) fillLoadPto(g); return;
    case "data:fill-build": if (need()) openBuildPanel(g); return;
    case "data:checklist-send": if (need()) openChecklistSendDialog(g); return;
    case "data:sort-asc": if (need()) sortByColumn(g, g.active.c, "asc"); return;
    case "data:sort-desc": if (need()) sortByColumn(g, g.active.c, "desc"); return;
    case "data:sort": if (need()) openSortDialog(g); return;
    case "data:filter-toggle": if (need()) toggleFilterMode(g); return;
    case "data:filter": if (need()) openFilterPanel(g, g.active.c, null, { x: Math.max(16, window.innerWidth / 2 - 132), y: 180 }); return;
    case "data:filter-clear": if (need()) { g.filters = new Map(); computeGeometry(g); repaintGrid(g); persistFilterState(g); } return;
    case "data:fv-save": if (need()) saveFilterView(g); return;
    case "data:stats": if (need()) showColumnStats(g); return;
    case "data:pivot": if (need()) openPivotDialog(g); return;
    case "data:names": if (need()) openNamedRangesDialog(g); return;
    case "data:validation": if (need()) openValidationDialog(g); return;
    case "data:split": if (need()) splitTextToColumns(g); return;
    case "data:dedupe": if (need()) removeDuplicateRows(g); return;
    case "data:trim": if (need()) trimWhitespace(g); return;
  }
  if (!g) { _toast("Open a spreadsheet block first", "info"); return; }
  if (ns === "view" && verb === "zoom") setZoom(g, +arg || 1);
  else if (ns === "view" && verb === "unhide-sheet") {
    const sh = findSheet(arg);
    if (sh && WB.canEdit) {
      sh.meta = { ...(sh.meta || {}), hidden: false };
      saveSheetMeta(sh.id);
      switchSheet(g, sh.id);
      renderSheetTabs(g);
    }
  }
  else if (ns === "ins" && verb === "fn") startEdit(g, g.active.r, g.active.c, `=${arg}(`);
  else if (ns === "fmt" && verb === "num") formatSelection(g, { num: arg || null });
  else if (ns === "fmt" && verb === "tog") toggleFormat(g, arg);
  else if (ns === "fmt" && verb === "align") formatSelection(g, { align: arg });
  else if (ns === "fmt" && verb === "valign") formatSelection(g, { valign: arg });
  else if (ns === "fmt" && verb === "border") formatSelection(g, { border: arg || null });
  else if (ns === "fmt" && verb === "bw") formatSelection(g, { bw: +arg === 1 ? null : +arg });
  else if (ns === "fmt" && verb === "rot") formatSelection(g, { rot: +arg || null });
  else if (ns === "fmt" && verb === "fs") formatSelection(g, { fs: +arg });
  else if (ns === "data" && verb === "fv") applyFilterView(g, arg);
  else if (ns === "data" && verb === "fv-del") { deleteFilterView(g, arg); _toast("Filter view deleted", "success"); }
}

function openWbMenu(name, btn) {
  const g = activeGrid();
  const rect = btn.getBoundingClientRect();
  const m = ctxMenu(rect.left, rect.bottom + 2, "");
  m.classList.add("wb-menu-pop");
  const stack = [{ title: name, items: wbMenuItems(name, g) }];
  const render = () => {
    const top = stack[stack.length - 1];
    m.innerHTML = (stack.length > 1 ? `<button type="button" class="popover-item wb-menu-back" data-menu-back>← ${esc(top.title)}</button><div class="popover-section"></div>` : "")
      + top.items.map((it, i) => {
        if (it === "—") return `<div class="popover-section"></div>`;
        return `<button type="button" class="popover-item ${it.danger ? "is-danger" : ""}" data-menu-i="${i}" role="menuitem" ${it.disabled ? "disabled" : ""}><span>${esc(it.label)}</span><span class="wb-menu-kbd">${it.sub ? "▸" : esc(it.kbd || "")}</span></button>`;
      }).join("");
    const r2 = m.getBoundingClientRect();
    if (r2.bottom > window.innerHeight - 8) m.style.top = Math.max(8, window.innerHeight - r2.height - 8) + "px";
  };
  render();
  m.addEventListener("click", (e) => {
    if (e.target.closest("[data-menu-back]")) { stack.pop(); render(); return; }
    const item = e.target.closest("[data-menu-i]");
    if (!item || item.disabled) return;
    const it = stack[stack.length - 1].items[+item.getAttribute("data-menu-i")];
    if (!it) return;
    if (it.sub) { stack.push({ title: it.label, items: it.sub }); render(); return; }
    closeAllPopovers();
    wbMenuAction(it.act, g);
  });
}

// File → Make a copy: full duplicate (blocks, sheets, cells, checklist
// items) under the current user's ownership.
async function duplicateWorkbook() {
  const src = WB.wb;
  if (!src || !WB.canEdit) return;
  _toast("Copying workbook…", "info");
  try {
    const s = _sb(), dsp = _dsp(), self = _me();
    const ins = await s.from("workbooks").insert({
      dsp_id: dsp.id, owner_user_id: self ? self.id : null,
      title: `Copy of ${src.title}`.slice(0, 200), description: src.description,
      visibility: src.visibility, template_key: src.template_key,
    }).select().single();
    if (ins.error) throw ins.error;
    const nwb = ins.data;
    for (const block of WB.blocks) {
      const bIns = await s.from("workbook_blocks").insert({
        dsp_id: dsp.id, workbook_id: nwb.id, type: block.type, title: block.title || "",
        position: block.position, settings: block.settings || {}, content: block.content || {},
      }).select().single();
      if (bIns.error) throw bIns.error;
      if (block.type === "sheet") {
        for (const sh of WB.sheetsByBlock.get(block.id) || []) {
          const shRow = {
            dsp_id: dsp.id, workbook_id: nwb.id, block_id: bIns.data.id,
            name: sh.name, position: sh.position, row_count: sh.rowCount, col_count: sh.colCount,
            frozen_rows: sh.frozenRows, frozen_cols: sh.frozenCols,
            col_widths: sh.colWidths || {}, row_heights: sh.rowHeights || {},
            meta: { ...(sh.meta || {}), hiddenRows: [...(sh.hiddenRows || [])], hiddenCols: [...(sh.hiddenCols || [])] },
          };
          let shIns = await s.from("workbook_sheets").insert(shRow).select().single();
          if (shIns.error && /meta/i.test(String(shIns.error.message))) {
            delete shRow.meta; // pre-0414 schema
            shIns = await s.from("workbook_sheets").insert(shRow).select().single();
          }
          if (shIns.error) throw shIns.error;
          const rows = [];
          for (const [key, cell] of sh.cells) {
            const rc = keyRC(key);
            rows.push({
              dsp_id: dsp.id, workbook_id: nwb.id, sheet_id: shIns.data.id,
              row_index: rc.r, col_index: rc.c,
              value: cell.value ?? null, formula: cell.formula ?? null,
              value_type: cell.type ?? null, format: cell.format || {},
              updated_by: self ? self.id : null,
            });
          }
          for (let i = 0; i < rows.length; i += 500) {
            const r = await s.from("workbook_cells").insert(rows.slice(i, i + 500));
            if (r.error) throw r.error;
          }
        }
      }
      if (block.type === "checklist") {
        const items = (WB.itemsByBlock.get(block.id) || []).map((it, i) => ({
          dsp_id: dsp.id, workbook_id: nwb.id, block_id: bIns.data.id,
          label: it.label, position: it.position ?? i, note: it.note || null,
          priority: it.priority || null, due_date: it.due_date || null,
          created_by: self ? self.id : null,
        }));
        if (items.length) {
          const r = await s.from("workbook_checklist_items").insert(items);
          if (r.error) throw r.error;
        }
      }
    }
    _toast("Copy created", "success");
    await openWorkbook(nwb.id);
    wbLog("workbook.created", `created this workbook as a copy of “${src.title}”`, { target_type: "workbook", target_id: nwb.id });
  } catch (e) { _toast("Couldn't copy the workbook: " + ((e && e.message) || e), "error"); }
}

// ─── Workbook lifecycle actions ─────────────────────────────────────────────

async function archiveWorkbook(unarchive) {
  const wb = WB.wb;
  if (!wb) return;
  try {
    const patch = { archived_at: unarchive ? null : new Date().toISOString() };
    const res = await _sb().from("workbooks").update(patch).eq("id", wb.id);
    if (res.error) throw res.error;
    Object.assign(wb, patch);
    wbLog(unarchive ? "workbook.restored" : "workbook.archived", unarchive ? "restored this workbook" : "archived this workbook");
    if (unarchive) renderDetailPage();
    else { closeRealtime(); renderListPage(); }
    _toast(unarchive ? "Workbook restored" : "Workbook archived", "success");
  } catch (e) { _toast("Couldn't update the workbook", "error"); }
}

// Card ⋮ on the list page: archive/restore + delete without opening
// the workbook first.
function openWorkbookCardMenu(id, anchor) {
  const w = WB.workbooks.find((x) => x.id === id);
  if (!w) return;
  const noun = isReportWb(w) ? "report" : "workbook";
  const rerender = () => { if (WB.view === "reports") renderReportsBody(); else renderListBody(); };
  const rect = anchor.getBoundingClientRect();
  const m = ctxMenu(rect.right - 190, rect.bottom + 4, [
    `<button type="button" class="popover-item" data-cm="archive" role="menuitem">${w.archived_at ? `Restore ${noun}` : `Archive ${noun}`}</button>`,
    `<button type="button" class="popover-item is-danger" data-cm="delete" role="menuitem">Delete ${noun}…</button>`,
  ].join(""));
  m.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cm]");
    if (!b) return;
    const act = b.getAttribute("data-cm");
    closeAllPopovers();
    if (act === "archive") {
      const next = w.archived_at ? null : new Date().toISOString();
      try {
        const res = await _sb().from("workbooks").update({ archived_at: next }).eq("id", w.id);
        if (res.error) throw res.error;
        w.archived_at = next;
        rerender();
        _toast(next ? `${noun === "report" ? "Report" : "Workbook"} archived` : `${noun === "report" ? "Report" : "Workbook"} restored`, "success");
      } catch (err) { _toast(`Couldn't update the ${noun}: ` + ((err && err.message) || err), "error"); }
    } else if (act === "delete") {
      confirmModal({
        title: `Delete this ${noun}?`,
        body: `“${esc(w.title || (noun === "report" ? "Untitled report" : "Untitled workbook"))}” — every sheet, cell, and comment in it will be permanently deleted. This can't be undone.`,
        confirmLabel: `Delete ${noun}`, danger: true,
        onConfirm: async () => {
          try {
            const res = await _sb().from("workbooks").delete().eq("id", w.id);
            if (res.error) throw res.error;
            WB.workbooks = WB.workbooks.filter((x) => x.id !== w.id);
            rerender();
            _toast(`${noun === "report" ? "Report" : "Workbook"} deleted`, "success");
          } catch (err) { _toast(`Couldn't delete the ${noun}: ` + ((err && err.message) || err), "error"); }
        },
      });
    }
  });
}

function deleteWorkbookFlow() {
  const wb = WB.wb;
  if (!wb) return;
  confirmModal({
    title: "Delete this workbook?",
    body: `“${esc(wb.title)}” — every sheet, cell, note, checklist, and comment in it will be permanently deleted. This can't be undone.`,
    confirmLabel: "Delete workbook", danger: true,
    onConfirm: async () => {
      try {
        const res = await _sb().from("workbooks").delete().eq("id", wb.id);
        if (res.error) throw res.error;
        closeRealtime();
        WB.wb = null;
        renderListPage();
        _toast("Workbook deleted", "success");
      } catch (e) { _toast("Couldn't delete the workbook: " + ((e && e.message) || e), "error"); }
    },
  });
}

// ─── Root delegation ────────────────────────────────────────────────────────

function installRootListeners() {
  if (WB.listenersInstalled) return;
  WB.listenersInstalled = true;

  document.addEventListener("click", (e) => {
    const root = wbRoot();
    if (!root) return;
    // popover discipline: any click outside an open popover/anchor closes it
    if (!e.target.closest(".popover-anchor") && !e.target.closest(".wb-ctx-menu") && !e.target.closest(".popover")) {
      closeAllPopovers();
    }
    if (!root.contains(e.target) && !e.target.closest("#wb-panel") && !e.target.closest("#rr-wb-cmd")) return;

    // strip tabs (schedule-style chrome): each tab is its own screen
    const stripTab = e.target.closest("#rr-wb-cmd [data-wb-tab]");
    if (stripTab) {
      const t = stripTab.getAttribute("data-wb-tab");
      if (t === "vault") {
        if (WB.view !== "vault") renderVaultPage();
      } else if (t === "reports") {
        if (WB.view !== "reports") renderReportsPage();
      } else if (WB.view !== "list") {
        WB.wb = null;
        renderListPage();
      }
      return;
    }

    const menubtn = e.target.closest("[data-wb-menubar]");
    if (menubtn) { openWbMenu(menubtn.getAttribute("data-wb-menubar"), menubtn); return; }

    const dvck = e.target.closest("[data-wb-dvcheck]");
    if (dvck) {
      const gridEl = dvck.closest("[data-wb-gridfocus]");
      const g = gridEl && GRIDS.get(gridEl.getAttribute("data-wb-gridfocus"));
      if (g) {
        const rc = keyRC(dvck.getAttribute("data-wb-dvcheck"));
        setActive(g, rc.r, rc.c, { scroll: false });
        toggleCheckbox(g, rc.r, rc.c);
      }
      return;
    }

    const dvb = e.target.closest("[data-wb-dvchip]");
    if (dvb) {
      const gridEl = dvb.closest("[data-wb-gridfocus]");
      const g = gridEl && GRIDS.get(gridEl.getAttribute("data-wb-gridfocus"));
      if (g) {
        const rc = keyRC(dvb.getAttribute("data-wb-dvchip"));
        setActive(g, rc.r, rc.c, { scroll: false });
        openValidationPicker(g, dvb);
      }
      return;
    }

    // clicking the already-active dropdown cell (not just its ▾ mark)
    // opens the option picker too — a much bigger target
    const dvCell = e.target.closest(".wb-cell.is-dv");
    if (dvCell && WB.canEdit) {
      const gridEl = dvCell.closest("[data-wb-gridfocus]");
      const g = gridEl && GRIDS.get(gridEl.getAttribute("data-wb-gridfocus"));
      if (g) {
        const r = +dvCell.getAttribute("data-r"), c = +dvCell.getAttribute("data-c");
        if (r === g.active.r && c === g.active.c && g.sel.r0 === g.sel.r1 && g.sel.c0 === g.sel.c1) {
          openValidationPicker(g, dvCell);
          return;
        }
      }
    }

    const fltb = e.target.closest("[data-wb-fltbtn]");
    if (fltb) {
      const gridEl = fltb.closest("[data-wb-gridfocus]");
      const g = gridEl && GRIDS.get(gridEl.getAttribute("data-wb-gridfocus"));
      if (g) openFilterPanel(g, +fltb.getAttribute("data-wb-fltbtn"), fltb);
      return;
    }

    const imgEl = e.target.closest("[data-wb-img]");
    if (imgEl) {
      const gridEl = imgEl.closest("[data-wb-gridfocus]");
      const g = gridEl && GRIDS.get(gridEl.getAttribute("data-wb-gridfocus"));
      if (g) {
        const rc = keyRC(imgEl.getAttribute("data-wb-img"));
        setActive(g, rc.r, rc.c, { scroll: false });
        // read the source back off the cell (not the DOM) so only
        // validated data URLs ever reach the lightbox
        const src = cellImgSrc(g.sheet.cells.get(cellKey(rc.r, rc.c)));
        if (src) openImageLightbox(src);
      }
      return;
    }

    // the star sits inside the card button — favorite wins over open
    const favBtn = e.target.closest("[data-wb-fav]");
    if (favBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleWbFav(favBtn.getAttribute("data-wb-fav"));
      if (WB.view === "reports") renderReportsBody(); else renderListBody();
      return;
    }

    // card ⋮: archive / delete straight from the list
    const cardMenu = e.target.closest("[data-wb-cardmenu]");
    if (cardMenu) {
      e.preventDefault();
      e.stopPropagation();
      openWorkbookCardMenu(cardMenu.getAttribute("data-wb-cardmenu"), cardMenu);
      return;
    }

    const open = e.target.closest("[data-wb-open]");
    if (open) { openWorkbook(open.getAttribute("data-wb-open")); return; }

    const tabBtn = e.target.closest("[data-wb-paneltab]");
    if (tabBtn) { WB.panelTab = tabBtn.getAttribute("data-wb-paneltab"); renderPanel(); return; }

    const taskf = e.target.closest("[data-wb-taskfilter]");
    if (taskf) { WB.taskFilter = taskf.getAttribute("data-wb-taskfilter"); renderPanelBody(); return; }

    const permRemove = e.target.closest("[data-wb-permremove]");
    if (permRemove) {
      const id = permRemove.getAttribute("data-wb-permremove");
      _sb().from("workbook_permissions").delete().eq("id", id).then((res) => {
        if (res.error) { _toast("Couldn't remove access", "error"); return; }
        WB.permissions = WB.permissions.filter((p) => p.id !== id);
        computeAccess();
        renderPanelBody();
      });
      return;
    }

    const itemHost = e.target.closest("[data-wb-item]");
    const actBtn = e.target.closest("[data-wb-act]");
    if (!actBtn) return;
    const act = actBtn.getAttribute("data-wb-act");
    const blockEl = e.target.closest("[data-wb-block]");
    const block = blockEl ? WB.blocks.find((b) => b.id === blockEl.getAttribute("data-wb-block")) : null;

    switch (act) {
      case "new-workbook": createBlankWorkbookNow(); break;
      case "toggle-archived": WB.showArchived = !WB.showArchived; renderListPage(); break;
      case "back-to-list": {
        flushCells();
        closeRealtime();
        // a report workbook goes home to the Reports tab
        if (WB.wb && isReportWb(WB.wb.id)) renderReportsPage(); else renderListPage();
        break;
      }
      case "new-report": renderReportBuilderPage(); break;
      case "reports-back": renderReportsPage(); break;
      case "retry-save": flushCells(); break;
      case "toggle-panel": WB.panelOpen = !WB.panelOpen; syncPanelVisibility(); if (WB.panelOpen) renderPanel(); break;
      case "panel-close": WB.panelOpen = false; syncPanelVisibility(); break;
      case "head-menu": togglePopover(actBtn); break;
      case "desc-menu": togglePopover(actBtn); setTimeout(() => document.getElementById("wb-desc-input")?.focus(), 0); break;
      case "block-menu": togglePopover(actBtn); break;
      case "add-block": closeAllPopovers(); addBlock(actBtn.getAttribute("data-type")); break;
      case "block-move": closeAllPopovers(); if (block) moveBlock(block.id, +actBtn.getAttribute("data-dir")); break;
      case "block-delete": closeAllPopovers(); if (block) deleteBlock(block.id); break;
      case "block-comment":
        closeAllPopovers();
        if (block) {
          WB.commentDraftTarget = { blockId: block.id, sheetId: null, cellRef: null };
          WB.panelOpen = true; WB.panelTab = "comments";
          syncPanelVisibility(); renderPanel();
          setTimeout(() => document.querySelector("#wb-comment-composer textarea")?.focus(), 60);
        }
        break;
      case "archive-wb": closeAllPopovers(); archiveWorkbook(false); break;
      case "unarchive-wb": closeAllPopovers(); archiveWorkbook(true); break;
      case "delete-wb": closeAllPopovers(); deleteWorkbookFlow(); break;
      case "sheet-add": addSheetTo(actBtn.getAttribute("data-block")); break;
      case "filter-clear": {
        const g = GRIDS.get(actBtn.getAttribute("data-block"));
        if (g) { g.filters = new Map(); computeGeometry(g); repaintGrid(g); persistFilterState(g); }
        break;
      }
      case "item-toggle": if (itemHost) toggleItem(itemHost.getAttribute("data-wb-item")); break;
      case "item-edit": if (itemHost) openItemEditor(itemHost.getAttribute("data-wb-item")); break;
      case "panel-add-task": {
        const cb = WB.blocks.find((b) => b.type === "checklist");
        if (cb) {
          const label = window.prompt("New task:");
          if (label && label.trim()) addChecklistItem(cb, label.trim());
        }
        break;
      }
      case "toggle-resolved": WB.showResolved = !WB.showResolved; renderPanelBody(); break;
      case "comment-target-clear": WB.commentDraftTarget = null; renderPanelBody(); break;
      case "comment-submit": {
        const composer = document.getElementById("wb-comment-composer");
        const ta = composer && composer.querySelector("textarea");
        if (ta && ta.value.trim()) {
          submitComment(ta.value, ta._wbPicked || new Set(), WB.commentDraftTarget, null);
          ta.value = "";
        }
        break;
      }
      case "comment-reply": {
        const cid = actBtn.getAttribute("data-id");
        const slot = document.querySelector(`[data-wb-replyslot="${cid}"]`);
        if (slot && !slot.querySelector("textarea")) {
          slot.innerHTML = `<div class="wb-composer is-reply"><textarea class="wb-input" rows="2" maxlength="4000" placeholder="Reply — @ to mention…" aria-label="Reply"></textarea>
            <div class="wb-composer-foot"><button type="button" class="btn btn-primary btn-sm" data-wb-reply-submit="${cid}">Reply</button></div></div>`;
          const rta = slot.querySelector("textarea");
          const picked = new Set();
          rta._wbPicked = picked;
          attachMentionPicker(rta, picked);
          rta.focus();
        }
        break;
      }
      case "comment-resolve": resolveComment(actBtn.getAttribute("data-id"), actBtn.getAttribute("data-on") === "1"); break;
      case "comment-delete": deleteComment(actBtn.getAttribute("data-id")); break;
      case "jump-cell": {
        const sheetId = actBtn.getAttribute("data-sheet");
        const rc = parseCellRef(actBtn.getAttribute("data-ref") || "");
        if (!sheetId || !rc) break;
        for (const g of GRIDS.values()) {
          const sheets = WB.sheetsByBlock.get(g.blockId) || [];
          if (sheets.some((s) => s.id === sheetId)) {
            if (g.sheet.id !== sheetId) switchSheet(g, sheetId);
            document.querySelector(`[data-wb-block="${g.blockId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            setActive(g, rc.row, rc.col);
            g.els.grid.focus();
            break;
          }
        }
        break;
      }
      case "share-add": {
        const userSel = document.getElementById("wb-share-user");
        const lvlSel = document.getElementById("wb-share-level");
        if (!userSel || !userSel.value) break;
        _sb().from("workbook_permissions").insert({
          dsp_id: WB.wb.dsp_id, workbook_id: WB.wb.id, subject_type: "user",
          subject_id: userSel.value, access_level: lvlSel.value, created_by: _me() ? _me().id : null,
        }).select().single().then((res) => {
          if (res.error) { _toast("Couldn't share: " + res.error.message, "error"); return; }
          WB.permissions.push(res.data);
          wbLog("workbook.shared", `shared the workbook with ${userName(userSel.value)} (${lvlSel.value})`);
          computeAccess();
          renderPanelBody();
        });
        break;
      }
    }
  });

  // reply submit (separate handler so the composer's Enter shortcut can reuse it)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-wb-reply-submit]");
    if (!btn) return;
    const cid = btn.getAttribute("data-wb-reply-submit");
    const slot = document.querySelector(`[data-wb-replyslot="${cid}"]`);
    const ta = slot && slot.querySelector("textarea");
    if (ta && ta.value.trim()) {
      const parent = WB.comments.find((c) => c.id === cid);
      submitComment(ta.value, ta._wbPicked || new Set(), parent ? { blockId: parent.block_id, sheetId: parent.sheet_id, cellRef: parent.cell_ref, rowIndex: parent.row_index, colIndex: parent.col_index } : null, cid);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const menuOpen = document.querySelector(".popover.open, .wb-ctx-menu");
      if (menuOpen) closeAllPopovers();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if ([...WB.dirtyCells.values()].some((s) => s.size)) {
      flushCells();
      e.preventDefault();
      e.returnValue = "";
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushCells();
  });
  window.addEventListener("resize", () => {
    clearTimeout(WB._resizeT);
    WB._resizeT = setTimeout(() => { for (const g of GRIDS.values()) repaintGrid(g); }, 120);
  });
}

// Wrap window.goto (the app's decorator-chain convention) so leaving
// the Workbooks view flushes pending saves and drops presence.
function wrapGoto() {
  if (WB.gotoWrapped || typeof window.goto !== "function") return;
  WB.gotoWrapped = true;
  const prev = window.goto;
  window.goto = function (view) {
    if (WB.view === "detail" && view !== "workbooks") {
      try { flushCells(); closeRealtime(); } catch (_) {}
    }
    if (view !== "workbooks") { try { restoreVaultNode(); } catch (_) {} }
    return prev.apply(this, arguments);
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function loadWorkbooksView() {
  const root = wbRoot();
  if (!root) return;
  if (!_sb() || !_dsp()) {
    root.innerHTML = wbErrorHtml("Workbooks needs a signed-in session", "Reload the page and sign in, then try again.");
    return;
  }
  installRootListeners();
  wrapGoto();
  if (PENDING_OPEN_ID) {
    const id = PENDING_OPEN_ID;
    PENDING_OPEN_ID = null;
    await openWorkbook(id);
    return;
  }
  if (PENDING_SCREEN === "reports" || WB.view === "reports" || WB.view === "reports-builder") {
    PENDING_SCREEN = null;
    await renderReportsPage();
    return;
  }
  if (WB.view === "vault") {
    renderVaultPage();
    return;
  }
  if (WB.view === "detail" && WB.wb) {
    // returning to the view with a workbook open → re-render in place
    renderDetailPage();
    openRealtime();
    return;
  }
  await renderListPage();
}

// ═════════════════════════════════════════════════════════════════════
// Sheet-to-Schedule · "Build Schedule from Sheet"
// ═════════════════════════════════════════════════════════════════════
// The workbook as the front door to RouteReady's scheduling intelligence:
// load the active roster into a sheet, open the Build Schedule panel,
// and let the SHARED scheduling engine (dashboard/scheduling-engine.js —
// the same rules Smart Fill runs: status, license, certification, PTO,
// availability, max days, weekly cap, WOC consecutive days, min rest,
// pins/ad-hoc constraints) recommend who should work. The sheet is the
// planning surface; rule enforcement stays in the engine. Nothing writes
// to the real schedule without an explicit preview + confirm.
//
// Wiring (same DI pattern as the reports provider — this module never
// imports live.js or the engine directly):
//   live.js:  registerScheduleEngine(planScheduleWeek)
//             registerDriverActions((id, opts) => openDriverDrawer(id, opts))

let SCHED_ENGINE = null;
let DRIVER_ACTIONS = null;
export function registerScheduleEngine(fn) { SCHED_ENGINE = fn; }
export function registerDriverActions(fn) { DRIVER_ACTIONS = fn; }

const FILL_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FILL_GREEN = "#D9EAD3", FILL_AMBER = "#FFF2CC", FILL_RED = "#F4CCCC", FILL_GRAY = "#E8EAED";
// pickable driver fields (People button) — [key, column label, default on]
const FILL_FIELDS = [
  ["status", "Status", true],
  ["phone", "Phone", false],
  ["email", "Email", false],
  ["hire", "Hire date", false],
  ["license", "License expiry", false],
  ["dot", "DOT certified", true],
  ["xl", "XL certified", true],
  ["edv", "EDV certified", true],
  ["avail", "Available days", true],
  ["pref", "Preferred days", true],
  ["risk", "Attendance risk (30d)", true],
  ["calloffs", "Call-offs (30d)", false],
  ["noshows", "No-shows (30d)", false],
  ["lates", "Lates (30d)", false],
];

function fillIsoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function fillWeekDates(weekStart) {
  const out = [];
  const d = new Date(weekStart + "T12:00:00");
  for (let i = 0; i < 7; i++) { out.push(fillIsoDate(d)); d.setDate(d.getDate() + 1); }
  return out;
}
function fillNextWeekStart() {
  // default target week: the upcoming Sunday
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
  return fillIsoDate(d);
}

// The sheet is a driver sheet when row 0 carries a "Driver ID" header;
// the id column is the join key, so sorting/reordering rows stays safe.
function fillSheetInfo(sheet) {
  const { maxC } = usedRange(sheet);
  for (let c = 0; c <= maxC; c++) {
    const cell = sheet.cells.get(cellKey(0, c));
    if (cell && String(cell.value || "").trim() === "Driver ID") return { idCol: c };
  }
  return null;
}
function fillDriverIdAt(sheet, r) {
  const info = fillSheetInfo(sheet);
  if (!info || r <= 0) return null;
  const cell = sheet.cells.get(cellKey(r, info.idCol));
  const id = cell ? String(cell.formula ? (cell.computed ?? "") : (cell.value ?? "")).trim() : "";
  return id || null;
}
function fillSheetDriverIds(sheet) {
  const info = fillSheetInfo(sheet);
  if (!info) return null;
  const ids = new Set();
  const { maxR } = usedRange(sheet);
  for (let r = 1; r <= maxR; r++) {
    const id = fillDriverIdAt(sheet, r);
    if (id) ids.add(id);
  }
  return ids;
}

// ── People: pick fields (report-builder style), then load the roster ────

function fillSavedFieldPicks() {
  try {
    const a = JSON.parse(localStorage.getItem("rr-wb-people-fields") || "null");
    if (Array.isArray(a)) return new Set(a);
  } catch (_) {}
  return new Set(FILL_FIELDS.filter(([, , on]) => on).map(([k]) => k));
}

function openPeoplePicker(g) {
  if (!WB.canEdit) { _toast("You need edit access to load drivers", "info"); return; }
  document.getElementById("wb-people-modal")?.remove();
  const sel = fillSavedFieldPicks();
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-people-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Load drivers" style="width:520px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Load drivers</p><p class="rr-modal-sub">Driver names always load — choose what comes with them</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <div class="wb-people-grid">
          ${FILL_FIELDS.map(([k, label]) => `
            <label class="wb-people-check">
              <input type="checkbox" data-people-field="${k}" ${sel.has(k) ? "checked" : ""}>
              <span>${esc(label)}</span>
            </label>`).join("")}
        </div>
        <p class="wb-people-hint">A Driver ID column is added at the far right — it keeps rows matched to drivers when you sort or edit, and powers the row's Driver actions menu.</p>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-people-none style="margin-right:auto">Clear all</button>
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-people-load>Load drivers</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-people-none]")) {
      wrap.querySelectorAll("[data-people-field]").forEach((i) => { i.checked = false; });
      return;
    }
    if (e.target.closest("[data-people-load]")) {
      const picks = [...wrap.querySelectorAll("[data-people-field]")].filter((i) => i.checked).map((i) => i.getAttribute("data-people-field"));
      try { localStorage.setItem("rr-wb-people-fields", JSON.stringify(picks)); } catch (_) {}
      wrap.remove();
      fillLoadDrivers(g, new Set(picks));
    }
  });
}

async function fillLoadDrivers(g, picks) {
  if (!WB.canEdit) { _toast("You need edit access to load drivers", "info"); return; }
  picks = picks || fillSavedFieldPicks();
  const dsp = _dsp();
  if (!dsp) { _toast("No DSP context", "error"); return; }
  _toast("Loading drivers…", "info");
  try {
    const needAtt = ["risk", "calloffs", "noshows", "lates"].some((k) => picks.has(k));
    const cols = ["id", "full_name", "status", "hire_date", "dl_expires_on", "dot_certified", "xl_certified", "edv_certified", "metadata"];
    if (picks.has("phone")) cols.push("phone");
    if (picks.has("email")) cols.push("email");
    const since = new Date(); since.setDate(since.getDate() - 30);
    const [dRes, aRes] = await Promise.all([
      _sb().from("drivers").select(cols.join(", "))
        .eq("dsp_id", dsp.id).in("status", ["active", "onboarding"]).order("full_name"),
      needAtt
        ? _sb().from("shifts").select("driver_id, status")
            .eq("dsp_id", dsp.id).gte("date", fillIsoDate(since))
            .in("status", ["called_off", "no_show", "late"])
        : Promise.resolve({ data: [] }),
    ]);
    if (dRes.error) throw dRes.error;
    const drivers = dRes.data || [];
    if (!drivers.length) { _toast("No active drivers found", "info"); return; }
    // attendance aggregate (30 days) — same thresholds the report uses
    const agg = new Map();
    for (const s of (aRes.data || [])) {
      const a = agg.get(s.driver_id) || { callOff: 0, noShow: 0, late: 0 };
      if (s.status === "called_off") a.callOff++;
      else if (s.status === "no_show") a.noShow++;
      else a.late++;
      agg.set(s.driver_id, a);
    }
    const riskOf = (id) => {
      const a = agg.get(id);
      if (!a) return "Low";
      if (a.noShow >= 1 || a.callOff >= 3) return "High";
      if (a.callOff >= 1 || a.late >= 2) return "Medium";
      return "Low";
    };
    const dayCodes = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const daysText = (codes) => Array.isArray(codes) && codes.length
      ? codes.map((c) => { const i = dayCodes.indexOf(String(c).toLowerCase()); return i >= 0 ? FILL_DOW[i] : c; }).join(" ")
      : "";
    // one value + optional format per picked field
    const fieldVal = {
      status: (d) => [d.status === "active" ? "Active" : "Onboarding", {}],
      phone: (d) => [d.phone || "", {}],
      email: (d) => [d.email || "", {}],
      hire: (d) => [d.hire_date ? String(d.hire_date).slice(0, 10) : "", {}],
      license: (d) => [d.dl_expires_on ? String(d.dl_expires_on).slice(0, 10) : "", {}],
      dot: (d) => [d.dot_certified ? "✓" : "—", { align: "center" }],
      xl: (d) => [d.xl_certified ? "✓" : "—", { align: "center" }],
      edv: (d) => [d.edv_certified ? "✓" : "—", { align: "center" }],
      avail: (d) => [daysText(d.metadata?.availability?.days) || "Any", {}],
      pref: (d) => [daysText(d.metadata?.availability?.preferred_days) || "—", {}],
      risk: (d) => { const rk = riskOf(d.id); return [rk, { bg: rk === "High" ? FILL_RED : rk === "Medium" ? FILL_AMBER : FILL_GREEN, align: "center" }]; },
      calloffs: (d) => [String(agg.get(d.id)?.callOff || 0), { align: "center" }],
      noshows: (d) => [String(agg.get(d.id)?.noShow || 0), { align: "center" }],
      lates: (d) => [String(agg.get(d.id)?.late || 0), { align: "center" }],
    };
    const fields = FILL_FIELDS.filter(([k]) => picks.has(k));
    const headers = ["Driver", ...fields.map(([, label]) => label), "Driver ID"];
    const sheet = g.sheet;
    if (headers.length > sheet.colCount) sheet.colCount = headers.length + 2;
    const changes = [];
    headers.forEach((h, c) => changes.push({ r: 0, c, cell: { value: h, formula: null, type: "text", format: { bold: true, bg: "header" } } }));
    drivers.forEach((d, i) => {
      const r = i + 1;
      changes.push({ r, c: 0, cell: { value: d.full_name || d.id, formula: null, type: "text", format: {} } });
      fields.forEach(([k], j) => {
        const [v, fmt] = fieldVal[k](d);
        changes.push({ r, c: j + 1, cell: { value: String(v), formula: null, type: "text", format: fmt } });
      });
      changes.push({ r, c: headers.length - 1, cell: { value: d.id, formula: null, type: "text", format: { fg: "muted" } } });
    });
    setCells(g, changes);
    computeGeometry(g);
    WB.fillDrivers = new Map(drivers.map((d) => [d.id, d]));
    g.sheet.frozenRows = 1;
    sheet.meta = { ...(sheet.meta || {}), fill: { ...(sheet.meta?.fill || {}), loadedAt: new Date().toISOString() } };
    saveSheetMeta(sheet.id);
    repaintGrid(g);
    renderFillBar(g);
    _toast(`Loaded ${drivers.length} drivers`, "success");
    wbLog("schedule.fill.loaded", `loaded ${drivers.length} drivers into ${sheet.name}`, {
      target_type: "sheet", target_id: sheet.id,
      detail: { drivers: drivers.length, fields: [...picks] },
    });
  } catch (e) { _toast("Couldn't load drivers: " + ((e && e.message) || e), "error"); }
}

// ── Fleet / Schedule / Time-off loaders ─────────────────────────────────
// Same idea as Load drivers: pull the DSP's live rows straight into the
// active sheet (header row frozen) so the workbook becomes a working
// surface over real RouteReady data. These are read-only snapshots — a
// far-right ID column keeps rows matched to the source record, but editing
// a loaded cell never writes back to the source table. Everything is
// dsp-scoped by the query + RLS.

async function fillDriverNames(dsp) {
  const m = new Map();
  try {
    const res = await _sb().from("drivers").select("id, full_name").eq("dsp_id", dsp.id);
    for (const d of (res.data || [])) m.set(d.id, d.full_name || d.id);
  } catch (_) {}
  return m;
}

// Write a header + rows table into the active sheet from row 0. Each row is
// an array of cells; a cell is either a plain value or a [value, format]
// pair. Grows the sheet if the table is wider/taller than the current grid.
function fillWriteTable(g, headers, rows, meta) {
  const sheet = g.sheet;
  if (headers.length > sheet.colCount) sheet.colCount = headers.length + 2;
  if (rows.length + 1 > sheet.rowCount) sheet.rowCount = rows.length + 50;
  const changes = [];
  headers.forEach((h, c) => changes.push({ r: 0, c, cell: { value: h, formula: null, type: "text", format: { bold: true, bg: "header" } } }));
  rows.forEach((cells, i) => {
    const r = i + 1;
    cells.forEach((cv, c) => {
      const [v, fmt] = Array.isArray(cv) ? cv : [cv, {}];
      changes.push({ r, c, cell: { value: v == null ? "" : String(v), formula: null, type: "text", format: fmt || {} } });
    });
  });
  setCells(g, changes);
  computeGeometry(g);
  sheet.frozenRows = 1;
  sheet.meta = { ...(sheet.meta || {}), fill: { ...(sheet.meta?.fill || {}), loadedAt: new Date().toISOString(), source: (meta && meta.source) || null } };
  saveSheetMeta(sheet.id);
  repaintGrid(g);
}

async function fillLoadVans(g) {
  if (!WB.canEdit) { _toast("You need edit access to load data", "info"); return; }
  const dsp = _dsp();
  if (!dsp) { _toast("No DSP context", "error"); return; }
  _toast("Loading vans…", "info");
  try {
    const [vRes, aRes] = await Promise.all([
      _sb().from("vehicles")
        .select("id, name, van_type, year, make, model, vin, plate, plate_state, mileage, ownership, operational_status, status, next_service_due_at")
        .eq("dsp_id", dsp.id).is("archived_at", null).order("name"),
      _sb().from("vehicle_driver_assignments").select("vehicle_id, driver_id").eq("dsp_id", dsp.id).eq("rank", 0),
    ]);
    if (vRes.error) throw vRes.error;
    const vans = vRes.data || [];
    if (!vans.length) { _toast("No vans found for this DSP", "info"); return; }
    const primary = new Map();
    for (const a of (aRes.data || [])) primary.set(a.vehicle_id, a.driver_id);
    const names = await fillDriverNames(dsp);
    const vanTypeLabel = { edv: "EDV", step_van: "Step van", cargo_van: "Cargo van", box_truck: "Box truck" };
    const ownLabel = { amazon_owned: "Amazon", dsp_owned: "DSP-owned", rental: "Rental", leased: "Leased" };
    const headers = ["Van", "Type", "Year / Make / Model", "VIN", "Plate", "Mileage", "Ownership", "Status", "Next service", "Assigned driver", "Vehicle ID"];
    const rows = vans.map((v) => {
      const grounded = v.operational_status === "grounded" || v.status === "out_of_service";
      const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ");
      const drv = primary.has(v.id) ? (names.get(primary.get(v.id)) || "") : "";
      return [
        v.name || "",
        vanTypeLabel[v.van_type] || v.van_type || "",
        ymm,
        v.vin || "",
        [v.plate, v.plate_state].filter(Boolean).join(" "),
        v.mileage != null ? [String(v.mileage), { align: "right" }] : "",
        ownLabel[v.ownership] || v.ownership || "",
        [grounded ? "Grounded" : "Active", { bg: grounded ? FILL_RED : FILL_GREEN, align: "center" }],
        v.next_service_due_at ? String(v.next_service_due_at).slice(0, 10) : "",
        drv,
        [v.id, { fg: "muted" }],
      ];
    });
    fillWriteTable(g, headers, rows, { source: "vans" });
    _toast(`Loaded ${vans.length} van${vans.length === 1 ? "" : "s"}`, "success");
    wbLog("data.fill.vans", `loaded ${vans.length} vans into ${g.sheet.name}`, { target_type: "sheet", target_id: g.sheet.id, detail: { vans: vans.length } });
  } catch (e) { _toast("Couldn't load vans: " + ((e && e.message) || e), "error"); }
}

async function fillLoadSchedule(g) {
  if (!WB.canEdit) { _toast("You need edit access to load data", "info"); return; }
  const dsp = _dsp();
  if (!dsp) { _toast("No DSP context", "error"); return; }
  const weekStart = fillNextWeekStart();
  const dates = fillWeekDates(weekStart);
  _toast("Loading schedule…", "info");
  try {
    const res = await _sb().from("shifts")
      .select("id, date, driver_id, route_code, status, starts_at, ends_at")
      .eq("dsp_id", dsp.id).gte("date", dates[0]).lte("date", dates[6])
      .order("date").order("route_code");
    if (res.error) throw res.error;
    const shifts = res.data || [];
    if (!shifts.length) { _toast(`No shifts scheduled for the week of ${dates[0]}`, "info"); return; }
    const names = await fillDriverNames(dsp);
    const fmtTime = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (_) { return ""; } };
    const statusLabel = { scheduled: "Scheduled", called_off: "Called off", completed: "Completed", no_show: "No-show" };
    const headers = ["Date", "Day", "Route", "Driver", "Start", "End", "Status", "Shift ID"];
    const rows = shifts.map((s) => {
      const open = !s.driver_id;
      const d = new Date(s.date + "T12:00:00");
      const bad = s.status === "no_show" || s.status === "called_off";
      return [
        s.date,
        FILL_DOW[d.getDay()],
        s.route_code || "",
        open ? ["OPEN", { bg: FILL_AMBER, bold: true }] : (names.get(s.driver_id) || ""),
        fmtTime(s.starts_at),
        fmtTime(s.ends_at),
        [statusLabel[s.status] || s.status || "", bad ? { bg: FILL_RED } : {}],
        [s.id, { fg: "muted" }],
      ];
    });
    fillWriteTable(g, headers, rows, { source: "schedule" });
    const open = shifts.filter((s) => !s.driver_id).length;
    _toast(`Loaded ${shifts.length} shifts (${open} open) for the week of ${dates[0]}`, "success");
    wbLog("data.fill.schedule", `loaded ${shifts.length} shifts into ${g.sheet.name}`, { target_type: "sheet", target_id: g.sheet.id, detail: { shifts: shifts.length, open, week_start: weekStart } });
  } catch (e) { _toast("Couldn't load schedule: " + ((e && e.message) || e), "error"); }
}

async function fillLoadPto(g) {
  if (!WB.canEdit) { _toast("You need edit access to load data", "info"); return; }
  const dsp = _dsp();
  if (!dsp) { _toast("No DSP context", "error"); return; }
  _toast("Loading time off…", "info");
  try {
    const since = new Date(); since.setDate(since.getDate() - 14);
    const res = await _sb().from("time_off_requests")
      .select("id, driver_id, start_date, end_date, reason, status")
      .eq("dsp_id", dsp.id).gte("end_date", fillIsoDate(since)).order("start_date");
    if (res.error) throw res.error;
    const reqs = res.data || [];
    if (!reqs.length) { _toast("No recent time-off requests found", "info"); return; }
    const names = await fillDriverNames(dsp);
    const dayCount = (a, b) => { try { return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000) + 1; } catch (_) { return ""; } };
    const stFmt = { pending: [FILL_AMBER, "Pending"], approved: [FILL_GREEN, "Approved"], denied: [FILL_RED, "Denied"], cancelled: [FILL_GRAY, "Cancelled"] };
    const headers = ["Driver", "Start", "End", "Days", "Reason", "Status", "Request ID"];
    const rows = reqs.map((t) => {
      const [bg, label] = stFmt[t.status] || ["", t.status || ""];
      return [
        names.get(t.driver_id) || "",
        t.start_date, t.end_date,
        [String(dayCount(t.start_date, t.end_date)), { align: "center" }],
        t.reason || "",
        [label, bg ? { bg, align: "center" } : { align: "center" }],
        [t.id, { fg: "muted" }],
      ];
    });
    fillWriteTable(g, headers, rows, { source: "pto" });
    _toast(`Loaded ${reqs.length} time-off request${reqs.length === 1 ? "" : "s"}`, "success");
    wbLog("data.fill.pto", `loaded ${reqs.length} time-off requests into ${g.sheet.name}`, { target_type: "sheet", target_id: g.sheet.id, detail: { requests: reqs.length } });
  } catch (e) { _toast("Couldn't load time off: " + ((e && e.message) || e), "error"); }
}

// ── Send a selection as a checklist to the Driver App ───────────────────
// Reads the selected cells (column-major, de-duplicated) as checklist item
// labels, then creates a driver-facing checklist via the existing
// checklist_forms pipeline (upsert → publish → assign to all active
// drivers) so it lands in every driver's Forms tab. No new tables — this
// bridges the workbook onto the 0415/0416 driver-checklist system.

function fillCellText(sheet, r, c) {
  const cell = sheet.cells.get(cellKey(r, c));
  if (!cell) return "";
  return String(cell.formula ? (cell.computed ?? "") : (cell.value ?? "")).trim();
}

function selectionChecklistItems(g) {
  const { r0, r1, c0, c1 } = selRect(g);
  const items = [];
  const seen = new Set();
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      const t = fillCellText(g.sheet, r, c);
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(t);
      if (items.length >= 100) return items; // sane cap for one checklist
    }
  }
  return items;
}

function openChecklistSendDialog(g) {
  if (!WB.canEdit) { _toast("You need edit access to send checklists", "info"); return; }
  const items = selectionChecklistItems(g);
  if (!items.length) { _toast("Select the cells that hold your checklist items first", "info"); return; }
  document.getElementById("wb-clsend-modal")?.remove();
  const defName = (g.sheet && g.sheet.name && g.sheet.name !== "Sheet 1" ? g.sheet.name : "") || (WB.wb && WB.wb.title && WB.wb.title !== "Untitled workbook" ? WB.wb.title : "") || "Checklist";
  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "wb-clsend-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Send checklist to Driver App" style="width:540px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Send checklist to Driver App</p><p class="rr-modal-sub">${items.length} item${items.length === 1 ? "" : "s"} from your selection · appears in every driver's Forms tab</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <label class="wb-clsend-namelabel">Checklist name
          <input type="text" class="wb-input" id="wb-clsend-name" maxlength="120" value="${esc(defName)}" placeholder="e.g. Van Cleanliness Checklist" style="width:100%;margin-top:6px">
        </label>
        <div class="wb-clsend-preview" role="list" aria-label="Checklist items">
          ${items.map((t) => `<div class="wb-clsend-item" role="listitem"><span class="wb-clsend-box" aria-hidden="true"></span><span>${esc(t)}</span></div>`).join("")}
        </div>
        <label class="wb-people-check" style="margin-top:12px"><input type="checkbox" id="wb-clsend-required" checked><span>Required — drivers must complete it</span></label>
        <p class="wb-people-hint">Assigned to <strong>all active drivers</strong>, due once. Fine-tune audience, schedule, and item types later in Workspaces → Checklists.</p>
      </div>
      <div class="rr-modal-foot">
        <button class="rr-modal-btn" type="button" data-wb-close>Cancel</button>
        <button class="rr-modal-btn primary" type="button" data-clsend-go>Send to Driver App</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") wrap.remove(); });
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap || e.target.closest("[data-wb-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-clsend-go]")) {
      const name = (wrap.querySelector("#wb-clsend-name")?.value || "").trim() || defName;
      const required = !!wrap.querySelector("#wb-clsend-required")?.checked;
      const btn = wrap.querySelector("[data-clsend-go]");
      btn.disabled = true; btn.textContent = "Sending…";
      const ok = await sendChecklistToDriverApp({ name, items, required });
      if (ok) wrap.remove();
      else { btn.disabled = false; btn.textContent = "Send to Driver App"; }
    }
  });
  setTimeout(() => { const n = wrap.querySelector("#wb-clsend-name"); if (n) { n.focus(); n.select(); } }, 30);
}

async function sendChecklistToDriverApp({ name, items, required }) {
  const s = _sb();
  if (!s) { _toast("Not connected", "error"); return false; }
  try {
    const payload = {
      name,
      category: "Driver App Forms",
      description: "Created from a RouteReady workbook",
      items: items.map((label) => ({ label, item_type: "checkbox", required: !!required })),
    };
    const up = await s.rpc("checklist_form_upsert", { p_id: null, p_payload: payload });
    if (up.error) throw up.error;
    const tpl = up.data || {};
    const tplId = tpl.id || (tpl.template && tpl.template.id);
    if (!tplId) throw new Error("No checklist id returned");
    const st = await s.rpc("checklist_form_set_status", { p_id: tplId, p_status: "active" });
    if (st.error) throw st.error;
    const asg = await s.rpc("checklist_form_assign", {
      p_template_id: tplId,
      p_assignments: [{ assignment_scope: "all_active", repeat_rule: { type: "once", due: "none" }, required: !!required }],
    });
    if (asg.error) throw asg.error;
    _toast(`Sent “${name}” to the Driver App`, "success");
    wbLog("checklist.sent_to_driver_app", `sent checklist “${name}” (${items.length} items) to the Driver App`, {
      target_type: "workbook", target_id: WB.wb ? WB.wb.id : null,
      detail: { template_id: tplId, items: items.length, scope: "all_active" },
    });
    return true;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/checklist_form_upsert|PGRST202|could not find|does not exist|schema cache/i.test(msg)) {
      _toast("Driver checklists aren't enabled on this workspace yet", "warn");
    } else if (/forbidden|42501|permission/i.test(msg)) {
      _toast("You need dispatcher access to send checklists to drivers", "warn");
    } else {
      _toast("Couldn't send the checklist: " + msg, "error");
    }
    return false;
  }
}

// ── Build panel ─────────────────────────────────────────────────────────

function fillOptions(g) {
  if (!g.fillOpts) {
    g.fillOpts = {
      weekStart: fillNextWeekStart(),
      mode: "fill_empty_only",            // vs rebuild_unlocked
      routeCounts: [0, 0, 0, 0, 0, 0, 0], // per day of the chosen week
      xlPerDay: 0, dotPerDay: 0, edvPerDay: 0,
      preferred: true, attendance: true, fifthDay: false,
      protectLocked: true, protectStable: true,
      posture: "conservative",            // vs aggressive
    };
  }
  return g.fillOpts;
}

function openBuildPanel(g) {
  if (!fillSheetInfo(g.sheet)) {
    _toast("Load drivers first — click People in the toolbar", "info");
    return;
  }
  document.getElementById("wb-build-panel")?.remove();
  const o = fillOptions(g);
  const wrap = document.createElement("aside");
  wrap.id = "wb-build-panel";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", "Build Schedule from Sheet");
  const dayInputs = FILL_DOW.map((d, i) =>
    `<label class="wb-build-day"><span>${d}</span><input type="number" min="0" max="99" data-fill-day="${i}" value="${o.routeCounts[i]}"></label>`).join("");
  wrap.innerHTML = `
    <div class="wb-build-head">
      <span class="wb-build-title">Build Schedule from Sheet</span>
      <button type="button" class="wb-panel-close" data-fill-close title="Close" aria-label="Close">✕</button>
    </div>
    <div class="wb-build-body">
      <div class="wb-build-sec">
        <label class="wb-build-field"><span>Schedule week (starts Sunday)</span>
          <input type="date" data-fill-week value="${esc(o.weekStart)}"></label>
        <div class="wb-build-field"><span>Mode</span>
          <label class="wb-build-radio"><input type="radio" name="fill-mode" value="fill_empty_only" ${o.mode === "fill_empty_only" ? "checked" : ""}> Fill open routes only</label>
          <label class="wb-build-radio"><input type="radio" name="fill-mode" value="rebuild_unlocked" ${o.mode === "rebuild_unlocked" ? "checked" : ""}> Rebuild entire week</label>
        </div>
      </div>
      <div class="wb-build-sec">
        <span class="wb-build-seclbl">Routes needed per day <button type="button" class="wb-build-link" data-fill-loadcounts>use week's open routes</button></span>
        <div class="wb-build-days">${dayInputs}</div>
        <div class="wb-build-typerow">
          <label class="wb-build-field wb-build-type"><span>XL / day</span><input type="number" min="0" max="99" data-fill-xl value="${o.xlPerDay}"></label>
          <label class="wb-build-field wb-build-type"><span>DOT / day</span><input type="number" min="0" max="99" data-fill-dot value="${o.dotPerDay}"></label>
          <label class="wb-build-field wb-build-type"><span>EDV / day</span><input type="number" min="0" max="99" data-fill-edv value="${o.edvPerDay}"></label>
        </div>
      </div>
      <div class="wb-build-sec">
        <label class="wb-build-check"><input type="checkbox" data-fill-opt="preferred" ${o.preferred ? "checked" : ""}> Respect preferred days</label>
        <label class="wb-build-check"><input type="checkbox" data-fill-opt="attendance" ${o.attendance ? "checked" : ""}> Include attendance risk</label>
        <label class="wb-build-check"><input type="checkbox" data-fill-opt="fifthDay" ${o.fifthDay ? "checked" : ""}> Allow 5th day if needed</label>
        <label class="wb-build-check"><input type="checkbox" data-fill-opt="protectLocked" ${o.protectLocked ? "checked" : ""}> Protect locked / pinned shifts</label>
        <label class="wb-build-check"><input type="checkbox" data-fill-opt="protectStable" ${o.protectStable ? "checked" : ""}> Protect stable schedules</label>
        <div class="wb-build-field"><span>Coverage posture</span>
          <label class="wb-build-radio"><input type="radio" name="fill-posture" value="conservative" ${o.posture === "conservative" ? "checked" : ""}> Conservative — strict rules</label>
          <label class="wb-build-radio"><input type="radio" name="fill-posture" value="aggressive" ${o.posture === "aggressive" ? "checked" : ""}> Aggressive — maximize coverage</label>
        </div>
      </div>
      <div class="wb-build-actions">
        <button type="button" class="btn btn-primary btn-sm" data-fill-generate>Generate Recommendations</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fill-gaps>Explain Gaps</button>
      </div>
      <div class="wb-build-preview" data-fill-preview hidden></div>
      <div class="wb-build-gaps" data-fill-gapsout hidden></div>
      <div class="wb-build-actions wb-build-actions2">
        <button type="button" class="btn btn-ghost btn-sm" data-fill-acceptsel disabled>Accept Selected</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fill-acceptall disabled>Accept All</button>
        <button type="button" class="btn btn-primary btn-sm" data-fill-apply disabled>Apply to Schedule</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fill-undo ${g.sheet.meta?.fill?.applied ? "" : "disabled"}>Undo</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fill-export disabled>Export Recommendation Report</button>
      </div>
      <p class="wb-build-hint">Recommendations are a preview — nothing touches the real schedule until you apply, and every applied change is logged and undoable.</p>
    </div>`;
  document.body.appendChild(wrap);

  const syncButtons = () => {
    const has = !!(g.fillRun && g.fillRun.recs && g.fillRun.recs.size);
    wrap.querySelector("[data-fill-acceptsel]").disabled = !has;
    wrap.querySelector("[data-fill-acceptall]").disabled = !has;
    wrap.querySelector("[data-fill-apply]").disabled = !has;
    wrap.querySelector("[data-fill-export]").disabled = !has;
    wrap.querySelector("[data-fill-undo]").disabled = !(g.sheet.meta?.fill?.applied);
  };
  g.fillSyncButtons = syncButtons;
  syncButtons();
  if (g.fillRun) renderFillPreview(g);

  wrap.addEventListener("keydown", (e) => e.stopPropagation());
  wrap.addEventListener("change", () => {
    const o2 = fillOptions(g);
    o2.weekStart = wrap.querySelector("[data-fill-week]").value || o2.weekStart;
    o2.mode = wrap.querySelector('[name="fill-mode"]:checked')?.value || o2.mode;
    o2.posture = wrap.querySelector('[name="fill-posture"]:checked')?.value || o2.posture;
    wrap.querySelectorAll("[data-fill-day]").forEach((inp) => { o2.routeCounts[+inp.getAttribute("data-fill-day")] = Math.max(0, Math.round(+inp.value || 0)); });
    o2.xlPerDay = Math.max(0, Math.round(+wrap.querySelector("[data-fill-xl]").value || 0));
    o2.dotPerDay = Math.max(0, Math.round(+wrap.querySelector("[data-fill-dot]").value || 0));
    o2.edvPerDay = Math.max(0, Math.round(+wrap.querySelector("[data-fill-edv]").value || 0));
    wrap.querySelectorAll("[data-fill-opt]").forEach((inp) => { o2[inp.getAttribute("data-fill-opt")] = inp.checked; });
  });
  wrap.addEventListener("click", async (e) => {
    if (e.target.closest("[data-fill-close]")) { wrap.remove(); return; }
    if (e.target.closest("[data-fill-loadcounts]")) { await fillPrefillCounts(g, wrap); return; }
    if (e.target.closest("[data-fill-generate]")) { await fillGenerate(g); syncButtons(); return; }
    if (e.target.closest("[data-fill-gaps]")) { fillExplainGaps(g); return; }
    if (e.target.closest("[data-fill-acceptsel]")) { fillAccept(g, "selected"); return; }
    if (e.target.closest("[data-fill-acceptall]")) { fillAccept(g, "all"); return; }
    if (e.target.closest("[data-fill-apply]")) { await fillApply(g); return; }
    if (e.target.closest("[data-fill-undo]")) { await fillUndo(g); return; }
    if (e.target.closest("[data-fill-export]")) { fillExportReport(g); return; }
  });
}

// prefill per-day counts from the chosen week's open (unassigned) shifts
async function fillPrefillCounts(g, wrap) {
  const o = fillOptions(g);
  o.weekStart = wrap.querySelector("[data-fill-week]").value || o.weekStart;
  const dates = fillWeekDates(o.weekStart);
  try {
    const res = await _sb().from("shifts").select("date, driver_id, status")
      .eq("dsp_id", _dsp().id).gte("date", dates[0]).lte("date", dates[6]);
    if (res.error) throw res.error;
    const terminal = new Set(["completed", "no_show", "called_off", "cancelled"]);
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const s of (res.data || [])) {
      if (s.driver_id || terminal.has(s.status)) continue;
      const i = dates.indexOf(s.date);
      if (i >= 0) counts[i]++;
    }
    o.routeCounts = counts;
    wrap.querySelectorAll("[data-fill-day]").forEach((inp) => { inp.value = counts[+inp.getAttribute("data-fill-day")]; });
    _toast(`${counts.reduce((a, b) => a + b, 0)} open routes found that week`, "info");
  } catch (e) { _toast("Couldn't read the week's shifts: " + ((e && e.message) || e), "error"); }
}

// ── Generate: assemble the payload, run the shared engine ──────────────

async function fillGenerate(g) {
  if (typeof SCHED_ENGINE !== "function") { _toast("Scheduling engine isn't available in this session", "error"); return; }
  if (!WB.canEdit) { _toast("You need edit access to build a schedule", "info"); return; }
  const sheet = g.sheet;
  const sheetIds = fillSheetDriverIds(sheet);
  if (!sheetIds || !sheetIds.size) { _toast("No drivers in the sheet — click People first", "info"); return; }
  const o = fillOptions(g);
  const dsp = _dsp();
  const dates = fillWeekDates(o.weekStart);
  _toast("Building schedule…", "info");
  try {
    // ── data pulls (data only — every scheduling RULE runs in the engine)
    const [dRes, sRes, pRes, cRes, ahRes] = await Promise.all([
      _sb().from("drivers")
        .select("id, full_name, status, hire_date, dl_expires_on, dot_certified, xl_certified, edv_certified, metadata")
        .eq("dsp_id", dsp.id).in("status", ["active", "onboarding"]),
      _sb().from("shifts")
        .select("id, date, starts_at, ends_at, status, driver_id, route_code, station_id, service_type_id, is_cushion, shift_kind")
        .eq("dsp_id", dsp.id).gte("date", dates[0]).lte("date", dates[6]),
      _sb().from("time_off_requests").select("driver_id, start_date, end_date, status")
        .eq("dsp_id", dsp.id).eq("status", "approved")
        .lte("start_date", dates[6]).gte("end_date", dates[0]),
      _sb().from("coachings").select("driver_id").eq("dsp_id", dsp.id)
        .eq("severity", "final").is("archived_at", null),
      _sb().from("current_ad_hoc_constraints")
        .select("id, kind, payload, hardness, weight, scope, state")
        .eq("state", "active"),
    ]);
    if (dRes.error) throw dRes.error;
    if (sRes.error) throw sRes.error;
    const allDrivers = dRes.data || [];
    const exclude = sheet.meta?.fill?.exclude || {};
    const roster = allDrivers.filter((d) => sheetIds.has(d.id) && !exclude[d.id]);
    if (!roster.length) { _toast("Every sheet driver is excluded or unknown — nothing to build", "info"); return; }
    const finalIds = new Set((cRes.data || []).map((c) => c.driver_id));
    const dayCodes = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const dowsOf = (codes) => Array.isArray(codes) && codes.length
      ? codes.map((c) => dayCodes.indexOf(String(c).toLowerCase())).filter((i) => i >= 0) : null;

    // fillable + locked shifts (live.js semantics: assigned rows lock,
    // open non-terminal rows fill)
    const terminal = new Set(["completed", "no_show", "called_off", "cancelled"]);
    const shifts = [];
    const realById = new Map();
    const openPerDay = [0, 0, 0, 0, 0, 0, 0];
    for (const sh of (sRes.data || [])) {
      if ((sh.shift_kind || "regular") !== "regular" && !sh.driver_id) continue;
      realById.set(String(sh.id), sh);
      const locked = !!sh.driver_id;
      if (!locked && terminal.has(sh.status)) continue;
      if (!locked) { const i = dates.indexOf(sh.date); if (i >= 0) openPerDay[i]++; }
      shifts.push({
        id: sh.id, date: sh.date, starts_at: sh.starts_at, ends_at: sh.ends_at,
        duration_hours: null, route_type: "standard",
        assigned_driver_id: locked ? sh.driver_id : null,
        is_locked: locked && o.protectLocked,
        station_id: sh.station_id || null, route_code: sh.route_code || null,
      });
    }
    // synthesize virtual routes where the per-day need exceeds the
    // week's open shifts; type quotas carve XL/DOT/EDV out of each day
    const virtualById = new Map();
    dates.forEach((date, i) => {
      const extra = Math.max(0, (o.routeCounts[i] || 0) - openPerDay[i]);
      const types = [];
      for (let k = 0; k < o.xlPerDay; k++) types.push("xl");
      for (let k = 0; k < o.dotPerDay; k++) types.push("step_van");
      for (let k = 0; k < o.edvPerDay; k++) types.push("edv");
      for (let k = 0; k < extra; k++) {
        const id = `virtual:${date}:${k}`;
        const v = {
          id, date, starts_at: `${date}T09:00:00`, ends_at: `${date}T19:00:00`,
          duration_hours: 10, route_type: types[k] || "standard",
          assigned_driver_id: null, is_locked: false, station_id: null, route_code: null,
        };
        virtualById.set(id, v);
        shifts.push(v);
      }
    });
    if (!shifts.some((s) => !s.assigned_driver_id)) {
      _toast("Nothing to fill — no open routes that week. Set routes-per-day or pick another week.", "info");
      return;
    }

    // PTO → flat {driver_id, date}
    const pto = [];
    for (const t of (pRes.data || [])) {
      const d0 = new Date(t.start_date + "T12:00:00"), d1 = new Date(t.end_date + "T12:00:00");
      for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
        const iso = fillIsoDate(d);
        if (iso >= dates[0] && iso <= dates[6]) pto.push({ driver_id: t.driver_id, date: iso });
      }
    }

    // rules: the DSP's saved Smart Fill rules (same source the Schedule
    // page uses) + this panel's choices layered on top
    const savedRules = (typeof window._rrLoadSfRules === "function") ? (window._rrLoadSfRules() || {}) : {};
    const rules = {
      ...savedRules,
      pto_block: true, availability: true,
      run_mode: o.mode,
      preserve_locked_assignments: o.protectLocked,
      preferred_enhancement: o.preferred,
      attendance_penalty: o.attendance,
      attendance_scheduling: o.attendance,
      fifth_day_fill: o.fifthDay,
      fifth_day_override_availability: o.fifthDay && o.posture === "aggressive",
      historical_pattern_protection: o.protectStable ? "medium" : "off",
      fill_priority: o.posture === "aggressive" ? "availability_first" : (savedRules.fill_priority || "seniority"),
      manual_mode: false,
    };
    const payload = {
      schedule_week_start: dates[0],
      max_days: savedRules.max_days ?? 6,
      weekly_hour_cap: savedRules.woc_max_hours ?? 50,
      time_budget_ms: 8000,
      rules,
      drivers: roster.map((d) => ({
        id: d.id, full_name: d.full_name, status: d.status, hire_date: d.hire_date,
        dl_expires_on: d.dl_expires_on,
        dot_certified: d.dot_certified, xl_certified: d.xl_certified, edv_certified: d.edv_certified,
        available_dows: dowsOf(d.metadata?.availability?.days),
        preferred_dows: dowsOf(d.metadata?.availability?.preferred_days),
        final_corrective_action: finalIds.has(d.id),
        weekday_affinity: null,
        fifth_day_ok: o.fifthDay && (o.posture === "aggressive" || d.metadata?.availability?.fifth_day_ok === true),
      })),
      shifts, pto,
      ad_hoc_constraints: (ahRes.data || []),
    };

    const result = SCHED_ENGINE(payload);

    // ── per-driver recommendations (data shaping only)
    const nameOf = new Map(roster.map((d) => [d.id, d.full_name || d.id]));
    const ptoSet = new Set(pto.map((p) => `${p.driver_id}:${p.date}`));
    const explByKey = new Map(((result.explanations && result.explanations.assignments) || []).map((x) => [String(x.shift_id), x]));
    const shiftById = new Map(shifts.map((s) => [String(s.id), s]));
    const recs = new Map(); // driverId → rec
    for (const d of roster) recs.set(d.id, { driverId: d.id, name: nameOf.get(d.id), days: new Map(), blocking: [], accepted: false, locked: false, overridden: false, status: "", reason: "", confidence: 0 });
    for (const a of (result.assigned_shifts || [])) {
      const rec = recs.get(a.driver_id);
      const sh = shiftById.get(String(a.shift_id));
      if (!rec || !sh || sh.is_locked) continue;
      const expl = explByKey.get(String(a.shift_id));
      rec.days.set(sh.date, {
        shiftId: String(a.shift_id), virtual: virtualById.has(String(a.shift_id)),
        routeType: sh.route_type, score: a.total_score || 0,
        warnings: (expl && expl.warnings) || [],
      });
    }
    for (const u of (result.unscheduled_drivers || [])) {
      const rec = recs.get(u.driver_id);
      if (!rec) continue;
      rec.eligibleSomewhere = u.eligible_somewhere === true;
      rec.blocking = (u.block_reasons || []).map((b) => (b && b.rule) ? `${b.rule}: ${b.message}` : String((b && b.message) || b));
    }
    const maxScore = Math.max(1, ...[...recs.values()].flatMap((r) => [...r.days.values()].map((d) => d.score || 0)));
    for (const rec of recs.values()) {
      const n = rec.days.size;
      const ptoDays = dates.filter((dt) => ptoSet.has(`${rec.driverId}:${dt}`));
      if (n > 0) {
        const bits = ["available", ptoDays.length ? `PTO ${ptoDays.length}d respected` : "no PTO", `${n} day${n > 1 ? "s" : ""} under weekly cap`];
        const types = new Set([...rec.days.values()].map((d) => d.routeType));
        if (types.has("xl")) bits.push("XL certified");
        if (types.has("step_van")) bits.push("DOT certified");
        if (types.has("edv")) bits.push("EDV certified");
        const warn = [...rec.days.values()].some((d) => d.warnings.length);
        rec.status = "Recommended";
        rec.reason = `Recommended: ${bits.join(", ")}.` + (warn ? " Warning: scheduled with rule warnings — review." : "");
        const avg = [...rec.days.values()].reduce((a, d) => a + (d.score || 0), 0) / n;
        rec.confidence = Math.max(35, Math.min(99, Math.round((avg / maxScore) * 100)));
      } else if (rec.blocking.length && !rec.eligibleSomewhere) {
        rec.status = "Blocked";
        rec.reason = `Blocked: ${rec.blocking[0]}`;
      } else {
        rec.status = "Not selected";
        rec.reason = "Not selected: eligible, but lower fit than the chosen drivers for this week's routes.";
      }
    }

    const needed = shifts.filter((s) => !s.is_locked).length;
    const filled = (result.assigned_shifts || []).filter((a) => { const sh = shiftById.get(String(a.shift_id)); return sh && !sh.is_locked; }).length;
    const open = (result.uncovered_shifts || []).length;
    const blocked = [...recs.values()].filter((r) => r.status === "Blocked").length;
    g.fillRun = {
      weekStart: dates[0], dates, options: { ...o }, payload, result, recs, virtualById, realById,
      summary: {
        drivers: roster.length, eligible: roster.length - blocked, blocked,
        needed, filled, open,
        coverage: needed ? Math.round((filled / needed) * 100) : 100,
        violations: (result.violations || []).length,
        ptoConflicts: (result.violations || []).filter((v) => v.rule === "R005").length,
        certConflicts: (result.violations || []).filter((v) => v.rule === "R004").length,
        riskWarnings: [...recs.values()].filter((r) => r.status === "Recommended" && r.reason.includes("Warning")).length,
      },
    };

    fillWriteRecColumns(g);
    renderFillBar(g);
    renderFillPreview(g);
    if (g.fillSyncButtons) g.fillSyncButtons();
    sheet.meta = { ...(sheet.meta || {}), fill: { ...(sheet.meta?.fill || {}), lastRun: { at: new Date().toISOString(), week: dates[0], summary: g.fillRun.summary } } };
    saveSheetMeta(sheet.id);
    _toast(`Recommendations ready — ${filled}/${needed} routes filled`, "success");
    wbLog("schedule.fill.generated", `generated schedule recommendations for week of ${dates[0]} (${filled}/${needed} routes filled, ${open} open)`, {
      target_type: "sheet", target_id: sheet.id,
      detail: {
        week: dates[0], drivers_considered: roster.length, routes_needed: needed,
        rules: { mode: o.mode, preferred: o.preferred, attendance: o.attendance, fifth_day: o.fifthDay, protect_locked: o.protectLocked, protect_stable: o.protectStable, posture: o.posture },
        recommendations: filled, conflicts: (result.violations || []).length, uncovered: open,
      },
    });
  } catch (e) {
    console.warn("sheet-to-schedule generate:", e);
    _toast("Build failed: " + ((e && e.message) || e), "error");
  }
}

// write the recommendation columns to the right of the roster
function fillWriteRecColumns(g) {
  const sheet = g.sheet;
  const run = g.fillRun;
  const info = fillSheetInfo(sheet);
  if (!run || !info) return;
  let startC = sheet.meta?.fill?.recStartC;
  if (!Number.isInteger(startC) || startC <= info.idCol) startC = info.idCol + 1;
  if (startC + 10 >= sheet.colCount) { sheet.colCount = startC + 12; }
  const heads = [...run.dates.map((d) => `Rec ${FILL_DOW[new Date(d + "T12:00:00").getDay()]}`), "Rec Status", "Reason", "Blocking Rules", "Confidence"];
  const changes = [];
  heads.forEach((h, i) => changes.push({ r: 0, c: startC + i, cell: { value: h, formula: null, type: "text", format: { bold: true, bg: "header" } } }));
  const typeLbl = { standard: "STD", xl: "XL", step_van: "DOT", edv: "EDV" };
  const ptoSet = new Set(run.payload.pto.map((p) => `${p.driver_id}:${p.date}`));
  const { maxR } = usedRange(sheet);
  for (let r = 1; r <= maxR; r++) {
    const id = fillDriverIdAt(sheet, r);
    if (!id) continue;
    const rec = run.recs.get(id);
    run.dates.forEach((date, i) => {
      let v = "", fmt = {};
      if (rec && rec.days.has(date)) {
        const d = rec.days.get(date);
        v = typeLbl[d.routeType] || "STD";
        fmt = { bg: d.warnings.length ? FILL_AMBER : FILL_GREEN, align: "center" };
      } else if (ptoSet.has(`${id}:${date}`)) {
        v = "PTO"; fmt = { bg: FILL_RED, align: "center" };
      } else if (rec) {
        v = "—"; fmt = { align: "center", fg: "muted" };
      }
      changes.push({ r, c: startC + i, cell: v ? { value: v, formula: null, type: "text", format: fmt } : null });
    });
    const st = rec ? (rec.status === "Recommended" && rec.accepted ? "Accepted" : rec.status) : "Excluded";
    const stBg = !rec ? FILL_GRAY : rec.status === "Recommended" || rec.status === "Applied" ? FILL_GREEN : rec.status === "Blocked" ? FILL_RED : FILL_GRAY;
    changes.push({ r, c: startC + 7, cell: { value: st, formula: null, type: "text", format: { bg: stBg, align: "center" } } });
    changes.push({ r, c: startC + 8, cell: rec ? { value: rec.reason, formula: null, type: "text", format: {} } : null });
    changes.push({ r, c: startC + 9, cell: rec && rec.blocking.length ? { value: rec.blocking.join(" · "), formula: null, type: "text", format: { fg: "red" } } : null });
    changes.push({ r, c: startC + 10, cell: rec && rec.confidence ? { value: `${rec.confidence}%`, formula: null, type: "text", format: { align: "center" } } : null });
  }
  setCells(g, changes);
  computeGeometry(g); // colCount may have grown for the new columns
  repaintGrid(g);
  sheet.meta = { ...(sheet.meta || {}), fill: { ...(sheet.meta?.fill || {}), recStartC: startC } };
  saveSheetMeta(sheet.id);
}

// ── Schedule Intelligence Bar ───────────────────────────────────────────

function renderFillBar(g) {
  const chrome = g.els.body.querySelector(".wb-chrome");
  if (!chrome) return;
  let bar = chrome.querySelector("[data-wb-intel]");
  const s = g.fillRun && g.fillRun.summary;
  const saved = !s && g.sheet.meta?.fill?.lastRun?.summary;
  const sum = s || saved;
  if (!sum) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "wb-intel";
    bar.setAttribute("data-wb-intel", "");
    chrome.appendChild(bar);
  }
  const pill = (txt, cls) => `<span class="wb-intel-pill ${cls || ""}">${esc(txt)}</span>`;
  bar.innerHTML =
    pill(`${sum.drivers} drivers loaded`) +
    pill(`${sum.eligible} eligible`, "is-ok") +
    pill(`${sum.blocked} blocked`, sum.blocked ? "is-warn" : "") +
    pill(`${sum.needed} routes`) +
    pill(`${sum.filled} filled`, "is-ok") +
    pill(`${sum.open} open`, sum.open ? "is-bad" : "is-ok") +
    pill(`${sum.coverage}% coverage`, sum.coverage >= 98 ? "is-ok" : sum.coverage >= 90 ? "is-warn" : "is-bad") +
    pill(`${sum.violations} rule violations`, sum.violations ? "is-bad" : "is-ok") +
    (s ? "" : `<span class="wb-intel-stale">from last run</span>`);
}

function renderFillPreview(g) {
  const box = document.querySelector("#wb-build-panel [data-fill-preview]");
  if (!box || !g.fillRun) return;
  const s = g.fillRun.summary;
  box.hidden = false;
  const row = (label, v, cls) => `<div class="wb-build-stat"><span>${esc(label)}</span><b class="${cls || ""}">${esc(String(v))}</b></div>`;
  box.innerHTML = `<div class="wb-build-seclbl">Preview — week of ${esc(g.fillRun.weekStart)}</div>` +
    row("Drivers loaded", s.drivers) +
    row("Eligible", s.eligible, "is-ok") +
    row("Blocked", s.blocked, s.blocked ? "is-warn" : "") +
    row("Routes needed", s.needed) +
    row("Routes filled", s.filled, "is-ok") +
    row("Open routes remaining", s.open, s.open ? "is-bad" : "is-ok") +
    row("Rule violations", s.violations, s.violations ? "is-bad" : "is-ok") +
    row("PTO conflicts", s.ptoConflicts, s.ptoConflicts ? "is-bad" : "") +
    row("Certification conflicts", s.certConflicts, s.certConflicts ? "is-bad" : "") +
    row("Attendance-risk warnings", s.riskWarnings, s.riskWarnings ? "is-warn" : "");
}

// ── Explain Gaps ────────────────────────────────────────────────────────

const FILL_GAP_ACTIONS = {
  R003: "renew the driver's license record, or clear the expiry protection window",
  R004: "certify another driver for this route type, or run the route as standard",
  R005: "the PTO is approved — plan coverage from other drivers or another day",
  R006: "ask a driver to extend availability for this day",
  R007: "approve a 5th-day assignment (enable “Allow 5th day”) or raise max days",
  R008: "shorten a shift or raise the weekly hour cap",
  R019: "break up a consecutive-day run — move one of this driver's shifts to another day",
};
function fillExplainGaps(g) {
  const box = document.querySelector("#wb-build-panel [data-fill-gapsout]");
  if (!box) return;
  box.hidden = false;
  if (!g.fillRun) { box.innerHTML = `<div class="wb-build-seclbl">Gaps</div><p class="wb-build-gap">Run Generate Recommendations first.</p>`; return; }
  const un = g.fillRun.result.uncovered_shifts || [];
  if (!un.length) {
    box.innerHTML = `<div class="wb-build-seclbl">Gaps</div><p class="wb-build-gap is-ok">No gaps — every route this week is covered. ✓</p>`;
    return;
  }
  const items = un.slice(0, 12).map((u) => {
    const actions = [...new Set((u.top_block_reasons || []).map((r) => FILL_GAP_ACTIONS[r.rule]).filter(Boolean))];
    return `<div class="wb-build-gap">
      <div>${esc(u.summary)}</div>
      ${actions.length ? `<div class="wb-build-gapact">Recommended action: ${esc(actions.join("; or "))}.</div>` : ""}
    </div>`;
  }).join("");
  box.innerHTML = `<div class="wb-build-seclbl">Gaps — ${un.length} uncovered route${un.length > 1 ? "s" : ""}</div>` + items +
    (un.length > 12 ? `<p class="wb-build-gap">…and ${un.length - 12} more (see the exported report).</p>` : "");
  wbLog("schedule.fill.gaps", `explained ${un.length} coverage gaps for week of ${g.fillRun.weekStart}`, { target_type: "sheet", target_id: g.sheet.id });
}

// ── Accept / Apply / Undo / Export ─────────────────────────────────────

function fillAccept(g, which) {
  const run = g.fillRun;
  if (!run) return;
  let ids = [];
  if (which === "all") {
    ids = [...run.recs.values()].filter((r) => r.days.size).map((r) => r.driverId);
  } else {
    const { r0, r1 } = selRect(g);
    for (let r = r0; r <= r1; r++) {
      const id = fillDriverIdAt(g.sheet, r);
      if (id && run.recs.get(id)?.days.size) ids.push(id);
    }
    if (!ids.length) { _toast("Select one or more driver rows first", "info"); return; }
  }
  for (const id of ids) { const rec = run.recs.get(id); if (rec) rec.accepted = true; }
  fillWriteRecColumns(g);
  _toast(`Accepted ${ids.length} recommendation${ids.length > 1 ? "s" : ""}`, "success");
}

async function fillApply(g) {
  const run = g.fillRun;
  if (!run) return;
  const accepted = [...run.recs.values()].filter((r) => r.accepted && r.days.size);
  if (!accepted.length) { _toast("Accept recommendations first (Accept Selected / Accept All)", "info"); return; }
  const updates = [];   // real open shifts → set driver
  const creates = [];   // virtual routes → new shift rows
  const skipped = [];
  // a template shift from the same week donates station/service defaults
  const template = [...run.realById.values()].find((s) => s.station_id) || null;
  for (const rec of accepted) {
    for (const [date, d] of rec.days) {
      if (d.virtual) {
        if (!template) { skipped.push(`${rec.name} ${date} (no station template for a new route)`); continue; }
        creates.push({
          dsp_id: _dsp().id, driver_id: rec.driverId, date,
          starts_at: `${date}T09:00:00`, ends_at: `${date}T19:00:00`,
          status: "scheduled", station_id: template.station_id,
          service_type_id: template.service_type_id || null,
          route_code: null,
        });
      } else {
        const prev = run.realById.get(d.shiftId);
        updates.push({ id: d.shiftId, driver_id: rec.driverId, prev: prev ? prev.driver_id : null });
      }
    }
  }
  confirmModal({
    title: "Apply to the real schedule?",
    body: `Week of ${esc(run.weekStart)}: assign ${updates.length} open route${updates.length === 1 ? "" : "s"}${creates.length ? ` and create ${creates.length} new shift${creates.length === 1 ? "" : "s"}` : ""} for ${accepted.length} driver${accepted.length === 1 ? "" : "s"}.${skipped.length ? ` ${skipped.length} assignment${skipped.length === 1 ? "" : "s"} will be skipped.` : ""} This writes to the live schedule (undo is available).`,
    confirmLabel: "Apply to Schedule",
    onConfirm: async () => {
      try {
        const updatedOk = [];
        for (const u of updates) {
          const res = await _sb().from("shifts").update({ driver_id: u.driver_id }).eq("id", u.id).is("driver_id", null);
          if (!res.error) updatedOk.push(u);
          else skipped.push(`shift ${u.id}: ${res.error.message}`);
        }
        let createdIds = [];
        if (creates.length) {
          const res = await _sb().from("shifts").insert(creates).select("id");
          if (res.error) skipped.push(`new shifts: ${res.error.message}`);
          else createdIds = (res.data || []).map((x) => x.id);
        }
        g.sheet.meta = { ...(g.sheet.meta || {}), fill: { ...(g.sheet.meta?.fill || {}),
          applied: { at: new Date().toISOString(), week: run.weekStart,
            updated: updatedOk.map((u) => ({ id: u.id, prev: u.prev })), created: createdIds } } };
        saveSheetMeta(g.sheet.id);
        for (const rec of accepted) rec.status = "Applied";
        fillWriteRecColumns(g);
        if (g.fillSyncButtons) g.fillSyncButtons();
        _toast(`Applied — ${updatedOk.length + createdIds.length} assignments written${skipped.length ? `, ${skipped.length} skipped` : ""}`, skipped.length ? "warn" : "success");
        wbLog("schedule.fill.applied", `applied schedule recommendations for week of ${run.weekStart}: ${updatedOk.length} assigned, ${createdIds.length} created, ${skipped.length} skipped`, {
          target_type: "sheet", target_id: g.sheet.id,
          detail: {
            week: run.weekStart,
            assignments_created: createdIds.length, assignments_changed: updatedOk.length,
            assignments_skipped: skipped.slice(0, 20),
            overrides_used: accepted.filter((r) => r.overridden).length,
          },
        });
      } catch (e) { _toast("Apply failed: " + ((e && e.message) || e), "error"); }
    },
  });
}

async function fillUndo(g) {
  const applied = g.sheet.meta?.fill?.applied;
  if (!applied) { _toast("Nothing to undo", "info"); return; }
  confirmModal({
    title: "Undo the applied schedule?",
    body: `Reverts the ${applied.updated.length + applied.created.length} assignment${applied.updated.length + applied.created.length === 1 ? "" : "s"} written on ${esc(String(applied.at).slice(0, 16).replace("T", " "))} for the week of ${esc(applied.week)}.`,
    confirmLabel: "Undo apply", danger: true,
    onConfirm: async () => {
      try {
        for (const u of applied.updated) {
          await _sb().from("shifts").update({ driver_id: u.prev ?? null }).eq("id", u.id);
        }
        if (applied.created.length) await _sb().from("shifts").delete().in("id", applied.created);
        const meta = { ...(g.sheet.meta || {}) };
        meta.fill = { ...(meta.fill || {}) };
        delete meta.fill.applied;
        g.sheet.meta = meta;
        saveSheetMeta(g.sheet.id);
        if (g.fillRun) { for (const rec of g.fillRun.recs.values()) if (rec.status === "Applied") rec.status = "Recommended"; fillWriteRecColumns(g); }
        if (g.fillSyncButtons) g.fillSyncButtons();
        _toast("Applied schedule reverted", "success");
        wbLog("schedule.fill.reverted", `undid the applied schedule for week of ${applied.week}`, {
          target_type: "sheet", target_id: g.sheet.id,
          detail: { week: applied.week, reverted: applied.updated.length, deleted: applied.created.length },
        });
      } catch (e) { _toast("Undo failed: " + ((e && e.message) || e), "error"); }
    },
  });
}

function fillExportReport(g) {
  const run = g.fillRun;
  if (!run) return;
  const s = run.summary;
  const rows = [
    ["RouteReady — Schedule Recommendation Report"],
    ["Week", run.weekStart], ["Generated", new Date().toISOString()],
    ["Drivers", s.drivers], ["Eligible", s.eligible], ["Blocked", s.blocked],
    ["Routes needed", s.needed], ["Filled", s.filled], ["Open", s.open],
    ["Coverage", s.coverage + "%"], ["Rule violations", s.violations],
    [],
    ["Driver", ...run.dates, "Status", "Confidence", "Reason", "Blocking rules"],
  ];
  const typeLbl = { standard: "STD", xl: "XL", step_van: "DOT", edv: "EDV" };
  for (const rec of run.recs.values()) {
    rows.push([
      rec.name,
      ...run.dates.map((d) => rec.days.has(d) ? (typeLbl[rec.days.get(d).routeType] || "STD") : ""),
      rec.status, rec.confidence ? rec.confidence + "%" : "", rec.reason, rec.blocking.join("; "),
    ]);
  }
  rows.push([]);
  for (const u of (run.result.uncovered_shifts || [])) rows.push(["GAP", u.summary]);
  const csv = "﻿" + toCsv(rows.map((r) => r.map((x) => csvSafe(x))));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `schedule-recommendations-${run.weekStart}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ── Row-level driver actions (context-menu submenu) ─────────────────────

function fillDriverMenuItems(g, driverId) {
  const excluded = !!(g.sheet.meta?.fill?.exclude || {})[driverId];
  const it = (label, act) => ({ label, act });
  return [
    it("Open Driver Record", "fill:drawer:profile"),
    it("Message Driver", "fill:drawer:messages"),
    it("View Attendance", "fill:drawer:attendance"),
    it("View Availability", "fill:drawer:availability"),
    it("View PTO", "fill:drawer:timeoff"),
    "—",
    it("Override Recommendation", "fill:override"),
    it("Lock Assignment", "fill:lock"),
    it(excluded ? "Include in Build" : "Exclude from Build", "fill:exclude"),
  ];
}
function fillDriverAction(g, driverId, act) {
  const rec = g.fillRun && g.fillRun.recs.get(driverId);
  if (act.startsWith("fill:drawer:")) {
    const tab = act.split(":")[2];
    if (typeof DRIVER_ACTIONS === "function") DRIVER_ACTIONS(driverId, { tab });
    else _toast("Driver records open from the main dashboard", "info");
    return;
  }
  if (act === "fill:exclude") {
    const meta = { ...(g.sheet.meta || {}) };
    meta.fill = { ...(meta.fill || {}), exclude: { ...(meta.fill?.exclude || {}) } };
    if (meta.fill.exclude[driverId]) delete meta.fill.exclude[driverId];
    else meta.fill.exclude[driverId] = true;
    g.sheet.meta = meta;
    saveSheetMeta(g.sheet.id);
    _toast(meta.fill.exclude[driverId] ? "Excluded from the next build" : "Included in the next build", "success");
    return;
  }
  if (!rec) { _toast("Generate recommendations first", "info"); return; }
  if (act === "fill:lock") {
    rec.locked = !rec.locked;
    _toast(rec.locked ? "Assignment locked — future runs keep it" : "Assignment unlocked", "success");
    return;
  }
  if (act === "fill:override") {
    // flip the active day cell for this driver: remove a recommendation,
    // or hand-add one (a virtual standard route) — marked as an override
    const run = g.fillRun;
    const info = fillSheetInfo(g.sheet);
    const startC = g.sheet.meta?.fill?.recStartC ?? (info.idCol + 1);
    const dayIdx = g.active.c - startC;
    if (dayIdx < 0 || dayIdx > 6) { _toast("Click a Rec day cell first, then override", "info"); return; }
    const date = run.dates[dayIdx];
    rec.overridden = true;
    if (rec.days.has(date)) {
      rec.days.delete(date);
      _toast(`Override: removed ${rec.name} from ${date}`, "success");
    } else {
      const id = `virtual:${date}:ovr:${driverId}`;
      run.virtualById.set(id, { id, date, route_type: "standard" });
      rec.days.set(date, { shiftId: id, virtual: true, routeType: "standard", score: 0, warnings: ["manual override"] });
      _toast(`Override: added ${rec.name} on ${date}`, "success");
    }
    rec.reason = (rec.reason || "") + " (manual override)";
    fillWriteRecColumns(g);
  }
}


// ─── Test hook ───────────────────────────────────────────────────────────────
// Exposed for the Node engine tests (scripts/test-formula-engine.mjs) —
// not part of the app surface; live.js imports only the view loaders.

export const __engine = {
  parseFormula, evalFormula, evalAst, extractRefs, bindNames, isValidRangeName, cfScaleColor, buildPasteCell, pasteValueParts, valueSatisfiesRule, dvDateSerial, matchesCriterion, FormulaError, Arr,
  colLabel, colIndex, cellRef, parseCellRef,
  dateToSerial, serialToDate, isoDate, parseDateLoose,
  buildXlsxBytes,
  chartSvg, WB_CHART_TYPES,
  computePivot, pivotAggregate, pivotTableHtml,
  autoLinkFor, cellLink, cellInnerHtml,
  WB_IMG_RE, cellImgSrc,
  planMoveChanges, recalcSheet,
  fillWeekDates, fillSheetInfo, fillDriverIdAt, fillSheetDriverIds,
  FUNCTION_META, fnSearch, fnListHtml,
};
