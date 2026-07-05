// Operations Workbook · workbook.js
//
// A RouteReady-native workbook: spreadsheet blocks with a safe formula
// engine (Excel-compatible date serials, wildcards, approximate lookups,
// A:A ranges, ~80 functions), rich-text note blocks, and checklist/task
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
//   #VALUE (type mismatch), #NAME (unknown function)

class FormulaError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

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

const TOK_NUM = "num", TOK_STR = "str", TOK_ID = "id", TOK_OP = "op", TOK_LP = "(", TOK_RP = ")", TOK_COMMA = ",", TOK_COLON = ":", TOK_PCT = "%";

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
    while (peek() && peek().t === TOK_PCT) { next(); node = { k: "pct", v: node }; }
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
    if (tok.t === TOK_ID) {
      const id = tok.v;
      const up = id.toUpperCase();
      if (up === "TRUE") return { k: "bool", v: true };
      if (up === "FALSE") return { k: "bool", v: false };
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
      throw new FormulaError("#NAME", `unknown name '${id}'`);
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
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const d = typeof v === "string" ? parseDateLoose(v) : null; // dates coerce to serials
  if (d) return dateToSerial(d);
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  if (!isFinite(n)) throw new FormulaError("#VALUE", `'${v}' is not a number`);
  return n;
}

function truthy(v) {
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
  const ast = parseFormula(src);
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
  }
  throw new FormulaError("#ERROR", "bad node");
}

function fmtScalar(v) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function collectArgValues(args, ctx) {
  // flattens refs + ranges + scalars into a value list (for aggregates)
  const out = [];
  for (const a of args) {
    if (a.k === "range") {
      for (const { row, col } of rangeCellsCtx(a, ctx)) out.push(ctx.getCell(row, col, a.sheet));
    } else {
      out.push(evalNode(a, ctx));
    }
  }
  return out;
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
    const d = parseDateLoose(fmtScalar(evalNode(node, ctx)));
    if (d) set.add(dateToSerial(d));
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
      if (args[1].k !== "range") throw new FormulaError("#VALUE", "VLOOKUP needs a range");
      const needle = evalNode(args[0], ctx);
      const idx = Math.trunc(toNum(evalNode(args[2], ctx)));
      // range_lookup TRUE = approximate (largest value ≤ needle, data sorted
      // ascending); omitted stays exact so existing sheets don't shift
      const approx = args.length === 4 && truthy(evalNode(args[3], ctx));
      const { a, b } = boundedRange(args[1], ctx);
      const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
      const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
      if (idx < 1 || c0 + idx - 1 > c1) throw new FormulaError("#REF", "VLOOKUP column index out of range");
      if (r1 - r0 + 1 > MAX_RANGE_CELLS) throw new FormulaError("#REF", "range too large");
      let best = -1;
      for (let r = r0; r <= r1; r++) {
        const v = ctx.getCell(r, c0, args[1].sheet);
        let eq = false, keep = false;
        try {
          eq = cmp("=", v ?? "", needle ?? "");
          keep = approx && v != null && v !== "" && cmp("<=", v, needle ?? "");
        } catch (_) {}
        if (eq) return ctx.getCell(r, c0 + idx - 1, args[1].sheet);
        if (keep) best = r;
      }
      if (approx && best >= 0) return ctx.getCell(best, c0 + idx - 1, args[1].sheet);
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
      return d.getDay() + 1; // WEEKDAY type 1: Sunday=1
    }
    case "INDEX": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "INDEX takes 2-3 args");
      if (args[0].k !== "range") throw new FormulaError("#VALUE", "INDEX needs a range");
      const { a, b } = boundedRange(args[0], ctx);
      const r0 = Math.min(a.row, b.row), c0 = Math.min(a.col, b.col);
      const rIdx = Math.trunc(toNum(evalNode(args[1], ctx)));
      const cIdx = args.length === 3 ? Math.trunc(toNum(evalNode(args[2], ctx))) : 1;
      const r1 = Math.max(a.row, b.row), c1 = Math.max(a.col, b.col);
      if (rIdx < 1 || r0 + rIdx - 1 > r1 || cIdx < 1 || c0 + cIdx - 1 > c1) throw new FormulaError("#REF", "INDEX out of range");
      return ctx.getCell(r0 + rIdx - 1, c0 + cIdx - 1, args[0].sheet);
    }
    case "MATCH": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERROR", "MATCH takes 2-3 args");
      if (args[1].k !== "range") throw new FormulaError("#VALUE", "MATCH needs a range");
      // match type: 0 exact (our default — Excel defaults to 1), 1 = largest
      // value ≤ needle (sorted ascending), -1 = smallest value ≥ needle
      let mt = 0;
      if (args.length === 3) mt = Math.sign(Math.trunc(toNum(evalNode(args[2], ctx))));
      const needle = evalNode(args[0], ctx);
      const cellsIn = [...rangeCellsCtx(args[1], ctx)];
      let best = -1;
      for (let i = 0; i < cellsIn.length; i++) {
        const v = ctx.getCell(cellsIn[i].row, cellsIn[i].col, args[1].sheet);
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
      if (args[1].k !== "range") throw new FormulaError("#VALUE", "HLOOKUP needs a range");
      const needle = evalNode(args[0], ctx);
      const idx = Math.trunc(toNum(evalNode(args[2], ctx)));
      const approx = args.length === 4 && truthy(evalNode(args[3], ctx));
      const { a, b } = boundedRange(args[1], ctx);
      const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
      const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
      if (idx < 1 || r0 + idx - 1 > r1) throw new FormulaError("#REF", "HLOOKUP row index out of range");
      let best = -1;
      for (let c = c0; c <= c1; c++) {
        const v = ctx.getCell(r0, c, args[1].sheet);
        let eq = false, keep = false;
        try {
          eq = cmp("=", v ?? "", needle ?? "");
          keep = approx && v != null && v !== "" && cmp("<=", v, needle ?? "");
        } catch (_) {}
        if (eq) return ctx.getCell(r0 + idx - 1, c, args[1].sheet);
        if (keep) best = c;
      }
      if (approx && best >= 0) return ctx.getCell(r0 + idx - 1, best, args[1].sheet);
      throw new FormulaError("#N/A", "no match found");
    }
    case "XLOOKUP": {
      if (args.length < 3 || args.length > 4) throw new FormulaError("#ERROR", "XLOOKUP takes 3-4 args");
      if (args[1].k !== "range" || args[2].k !== "range") throw new FormulaError("#VALUE", "XLOOKUP needs lookup and return ranges");
      const needle = evalNode(args[0], ctx);
      const look = [...rangeCellsCtx(args[1], ctx)];
      const ret = [...rangeCellsCtx(args[2], ctx)];
      if (ret.length < look.length) throw new FormulaError("#REF", "return range too small");
      for (let i = 0; i < look.length; i++) {
        let eq = false;
        try { eq = cmp("=", ctx.getCell(look[i].row, look[i].col, args[1].sheet) ?? "", needle ?? ""); } catch (_) {}
        if (eq) return ctx.getCell(ret[i].row, ret[i].col, args[2].sheet);
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
        if (a.k === "range") return [...rangeCellsCtx(a, ctx)].map(({ row, col }) => { const v = ctx.getCell(row, col, a.sheet); if (typeof v === "boolean") return 0; const n = cellNumeric(v); return n == null ? 0 : n; });
        return [toNum(evalNode(a, ctx))];
      });
      const len = lists[0].length;
      if (lists.some((l) => l.length !== len)) throw new FormulaError("#VALUE", "SUMPRODUCT ranges must be the same size");
      let total = 0;
      for (let i = 0; i < len; i++) { let prod = 1; for (const l of lists) prod *= l[i]; total += prod; }
      return total;
    }
    case "LARGE": case "SMALL": {
      if (args.length !== 2 || args[0].k !== "range") throw new FormulaError("#ERROR", `${name} takes a range and k`);
      const xs = flatNumeric([...rangeCellsCtx(args[0], ctx)].map(({ row, col }) => ctx.getCell(row, col, args[0].sheet))).sort((x, y) => y - x);
      const k = Math.trunc(toNum(evalNode(args[1], ctx)));
      if (k < 1 || k > xs.length) throw new FormulaError("#VALUE", `${name} k out of range`);
      return name === "LARGE" ? xs[k - 1] : xs[xs.length - k];
    }
    case "RANK": {
      if (args.length < 2 || args.length > 3 || args[1].k !== "range") throw new FormulaError("#ERROR", "RANK takes a value, a range, and an optional order");
      const x = toNum(evalNode(args[0], ctx));
      const xs = flatNumeric([...rangeCellsCtx(args[1], ctx)].map(({ row, col }) => ctx.getCell(row, col, args[1].sheet)));
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
      if (args.length < 1 || args.length > 2 || args[0].k !== "range") throw new FormulaError("#ERROR", "IRR takes a range of cash flows");
      const xs = flatNumeric([...rangeCellsCtx(args[0], ctx)].map(({ row, col }) => ctx.getCell(row, col, args[0].sheet)));
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
      if (args.length < 2 || args.length > 3 || args[1].k !== "range") throw new FormulaError("#ERROR", "LOOKUP takes a value, a lookup range, and an optional result range");
      const needle = evalNode(args[0], ctx);
      const look = [...rangeCellsCtx(args[1], ctx)];
      const res = args.length === 3 && args[2].k === "range" ? [...rangeCellsCtx(args[2], ctx)] : look;
      let best = -1;
      for (let i = 0; i < look.length; i++) {
        const v = ctx.getCell(look[i].row, look[i].col, args[1].sheet);
        if (v == null || v === "") continue;
        try { if (cmp("<=", v, needle ?? "")) best = i; } catch (_) {}
      }
      if (best < 0) throw new FormulaError("#N/A", "no match found");
      const rc = res[Math.min(best, res.length - 1)];
      return ctx.getCell(rc.row, rc.col, args.length === 3 ? args[2].sheet : args[1].sheet);
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
      if (args.length !== 1 || (args[0].k !== "range" && args[0].k !== "ref")) throw new FormulaError("#VALUE", `${name} needs a range`);
      if (args[0].k === "ref") return 1;
      const { a, b } = boundedRange(args[0], ctx);
      return name === "ROWS" ? Math.abs(b.row - a.row) + 1 : Math.abs(b.col - a.col) + 1;
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
      const fn = FUNCS[name];
      if (!fn) throw new FormulaError("#NAME", `unknown function ${name}`);
      return fn(collectArgValues(args, ctx));
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

function extractRefs(src, bounds) {
  let ast;
  try { ast = parseFormula(src); } catch (_) { return []; }
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
    if (n.l) walk(n.l);
    if (n.r) walk(n.r);
    if (n.v && typeof n.v === "object") walk(n.v);
  })(ast);
  return refs;
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
    // second pass: sheets with cross-sheet formulas now see fresh values
    for (const arr of WB.sheetsByBlock.values()) {
      for (const sh of arr) {
        let cross = false;
        for (const cell of sh.cells.values()) if (cell.formula && cell.formula.includes("!")) { cross = true; break; }
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

  // spreadsheet first — sheet blocks lead the workbook regardless of
  // how a template happens to list them (stable sort keeps ties)
  const blockSpecs = (spec ? spec.blocks : [{ type: "sheet", title: "", sheets: [{ name: "Sheet 1", cols: null, rows: [] }] }])
    .slice()
    .sort((a, b) => (a.type === "sheet" ? 0 : 1) - (b.type === "sheet" ? 0 : 1));
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
  const list = WB.workbooks.filter((w) => !w.archived_at && isReportWb(w));
  const card = (w) => {
    const info = WB.reportInfo.get(w.id) || {};
    return `<button type="button" class="wb-card" data-wb-open="${esc(w.id)}">
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
  root.innerHTML = list.length
    ? `<div class="wb-cards">${list.map(card).join("")}</div>`
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
  const asts = new Map();
  const deps = new Map();
  for (const [key, cell] of formulaCells) {
    try {
      const ast = parseFormula(cell.formula);
      asts.set(key, ast);
      deps.set(key, extractRefs(cell.formula, depBounds).map((rc) => cellKey(rc.r ?? rc.row, rc.c ?? rc.col)));
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
  };
  for (const key of order) {
    const cell = sheet.cells.get(key);
    if (!cell || cell.err) continue;
    try {
      ctx.cur = keyRC(key); // ROW()/COLUMN() with no args resolve here
      const v = evalAst(asts.get(key), ctx);
      cell.computed = v;
    } catch (e) {
      cell.err = e instanceof FormulaError ? e.code : "#ERROR";
      cell.computed = null;
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
  for (const s2 of sibs) {
    if (s2.id === sheet.id) continue;
    let cross = false;
    for (const cell of s2.cells.values()) {
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
  // report workbooks live under the Reports tab, not here
  const active = WB.workbooks.filter((w) => !w.archived_at && !isReportWb(w));
  const archived = WB.workbooks.filter((w) => w.archived_at && !isReportWb(w));
  const list = WB.showArchived ? archived : active;

  const card = (w) => {
    const tpl = WB_TEMPLATES.find((t) => t.key === w.template_key);
    return `<button type="button" class="wb-card" data-wb-open="${esc(w.id)}">
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

  // the New workbook action lives in the page strip (schedule-style
  // chrome in view-workbooks.frag) — the list body is just the cards
  root.innerHTML = `
    ${list.length ? `<div class="wb-cards">${list.map(card).join("")}</div>` : WB.showArchived ? `
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
        <div class="wb-head-main">
          <input type="text" class="wb-title-input" id="wb-title-input" value="${esc(wb.title)}" maxlength="200" ${ro ? "readonly" : ""} aria-label="Workbook title">
          <input type="text" class="wb-desc-input" id="wb-desc-input" value="${esc(wb.description || "")}" maxlength="500" placeholder="${ro ? "" : "Add a description…"}" ${ro ? "readonly" : ""} aria-label="Workbook description">
        </div>
        <div class="wb-head-side">
          <span data-wb-savestate></span>
          <span class="wb-presence" id="wb-presence"></span>
          ${ro ? `<span class="wb-badge" title="You can view${canCommentOnly() ? " and comment" : ""}, but not edit">Read-only</span>` : ""}
          <button type="button" class="btn btn-ghost btn-icon ${WB.panelOpen ? "is-on" : ""}" data-wb-act="toggle-panel" title="Comments &amp; activity" aria-label="Toggle workbook panel" aria-pressed="${WB.panelOpen}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
          <span class="popover-anchor">
            <button type="button" class="btn btn-ghost btn-icon" data-wb-act="head-menu" title="Workbook actions" aria-haspopup="menu" aria-label="Workbook actions">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
            </button>
            <div class="popover wb-head-pop" role="menu">
              ${WB.canEdit ? `
                <button type="button" class="popover-item" data-wb-act="add-block" data-type="sheet" role="menuitem">Add spreadsheet block</button>
                <button type="button" class="popover-item" data-wb-act="add-block" data-type="text" role="menuitem">Add note block</button>
                <button type="button" class="popover-item" data-wb-act="add-block" data-type="checklist" role="menuitem">Add checklist block</button>
                <div class="popover-section"></div>` : ""}
              ${WB.canAdmin ? `<button type="button" class="popover-item" data-wb-act="${wb.archived_at ? "unarchive-wb" : "archive-wb"}" role="menuitem">${wb.archived_at ? "Restore workbook" : "Archive workbook"}</button>` : ""}
              ${WB.canAdmin ? `<button type="button" class="popover-item is-danger" data-wb-act="delete-wb" role="menuitem">Delete workbook…</button>` : ""}
            </div>
          </span>
        </div>
      </div>
      <div class="wb-menubar" role="menubar" aria-label="Workbook menus">
        ${WB_MENUS.map((n) => `<button type="button" class="wb-menubtn" data-wb-menubar="${n}" role="menuitem">${n}</button>`).join("")}
      </div>
      ${wb.archived_at ? `<div class="wb-archived-note">This workbook is archived — it's read-only in spirit; restore it from the ⋯ menu to keep working.</div>` : ""}
      <div class="wb-body">
        <div class="wb-blocks" id="wb-blocks"></div>
        <aside class="wb-panel" id="wb-panel" aria-label="Workbook panel" ${WB.panelOpen ? "" : "hidden"}></aside>
      </div>
    </div>`;

  const blocksEl = document.getElementById("wb-blocks");
  if (!WB.blocks.length) {
    blocksEl.innerHTML = `<div class="rr-empty">
      <div class="rr-empty-icon">${WB_ICON_SVG}</div>
      <div class="rr-empty-title">This workbook is empty</div>
      <div class="rr-empty-sub">Start with a spreadsheet, checklist, or note block.</div>
      ${WB.canEdit ? `<div class="rr-empty-action wb-add-row">
        <button type="button" class="btn btn-sm" data-wb-act="add-block" data-type="sheet">+ Spreadsheet</button>
        <button type="button" class="btn btn-sm" data-wb-act="add-block" data-type="text">+ Note</button>
        <button type="button" class="btn btn-sm" data-wb-act="add-block" data-type="checklist">+ Checklist</button>
      </div>` : ""}
    </div>`;
  } else {
    for (const block of WB.blocks) blocksEl.appendChild(buildBlockEl(block));
    if (WB.canEdit) {
      const addRow = document.createElement("div");
      addRow.className = "wb-add-row wb-add-row-foot";
      addRow.innerHTML = `
        <button type="button" class="btn btn-ghost btn-sm" data-wb-act="add-block" data-type="sheet">+ Spreadsheet</button>
        <button type="button" class="btn btn-ghost btn-sm" data-wb-act="add-block" data-type="text">+ Note</button>
        <button type="button" class="btn btn-ghost btn-sm" data-wb-act="add-block" data-type="checklist">+ Checklist</button>`;
      blocksEl.appendChild(addRow);
    }
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
  const el = document.createElement("section");
  const primarySheet = block.type === "sheet" && (WB.blocks.find((b) => b.type === "sheet") || {}).id === block.id;
  el.className = "wb-block wb-block-" + block.type + (primarySheet ? " wb-block-primary" : "");
  el.dataset.wbBlock = block.id;
  const typeLabel = { sheet: "Spreadsheet", text: "Note", checklist: "Checklist" }[block.type] || block.type;
  el.innerHTML = `
    <div class="wb-block-head">
      <input type="text" class="wb-block-title" value="${esc(block.title || "")}" placeholder="${esc(typeLabel)}" maxlength="200" ${WB.canEdit ? "" : "readonly"} aria-label="Block title">
      <div class="wb-block-tools">
        ${WB.canEdit ? `<span class="popover-anchor">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-wb-act="block-menu" title="Block actions" aria-haspopup="menu" aria-label="Block actions">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          <div class="popover wb-block-pop" role="menu">
            <button type="button" class="popover-item" data-wb-act="block-move" data-dir="-1" role="menuitem">Move up</button>
            <button type="button" class="popover-item" data-wb-act="block-move" data-dir="1" role="menuitem">Move down</button>
            <button type="button" class="popover-item" data-wb-act="block-comment" role="menuitem">Comment on block</button>
            <div class="popover-section"></div>
            <button type="button" class="popover-item is-danger" data-wb-act="block-delete" role="menuitem">Delete block…</button>
          </div>
        </span>` : ""}
      </div>
    </div>
    <div class="wb-block-body" data-wb-block-body="${block.id}"></div>`;
  const titleEl = el.querySelector(".wb-block-title");
  titleEl.addEventListener("input", () => {
    if (!WB.canEdit) return;
    block.title = titleEl.value.trim();
    clearTimeout(titleEl._t);
    titleEl._t = setTimeout(() => saveBlock(block, { title: block.title }), 700);
  });
  const body = el.querySelector(".wb-block-body");
  if (block.type === "sheet") mountSheetBlock(block, body);
  else if (block.type === "text") mountTextBlock(block, body);
  else if (block.type === "checklist") mountChecklistBlock(block, body);
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
    ${sheetToolbarHtml(block, ro)}
    <div class="wb-fbar">
      <input type="text" class="wb-fbar-ref" data-wb-fbar-ref value="A1" aria-label="Name box — type a cell reference and press Enter" autocomplete="off" spellcheck="false">
      <span class="wb-fbar-fx" aria-hidden="true">fx</span>
      <input type="text" class="wb-fbar-input" data-wb-fbar-input placeholder="${ro ? "" : "Enter a value or =formula"}" ${ro ? "readonly" : ""} aria-label="Formula bar" autocomplete="off" spellcheck="false">
      <span class="wb-fbar-err" data-wb-fbar-err hidden></span>
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
        </div>
      </div>
      <div class="wb-gr-filterchip" hidden></div>
    </div>
    <div class="wb-charts" data-wb-charts hidden></div>
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
  g.els.charts.addEventListener("click", (e) => {
    const card = e.target.closest("[data-wb-chart]");
    const act = e.target.closest("[data-wb-chartact]");
    if (!card || !act) return;
    const ch = sheetCharts(g.sheet).find((x) => x.id === card.getAttribute("data-wb-chart"));
    if (!ch) return;
    if (act.getAttribute("data-wb-chartact") === "edit") openChartDialog(g, ch);
    else confirmModal({ title: "Delete this chart?", body: "The underlying cells are untouched.", confirmLabel: "Delete chart", danger: true, onConfirm: () => deleteChart(g, ch.id) });
  });
}

function sheetToolbarHtml(block, ro) {
  const btn = (act, title, svg, extra) => `<button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="${act}" ${extra || ""} title="${esc(title)}" aria-label="${esc(title)}" ${ro && act !== "export-csv" && act !== "find" && act !== "comment-cell" ? "disabled" : ""}>${svg}</button>`;
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
    <div class="wb-tgrp">${btn("autosum", "AutoSum — insert =SUM(…) for the selection", `<span class="wb-tb-txt wb-tb-sigma">Σ</span>`)}</div>
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
    <div class="wb-tgrp">${btn("align-left", "Align left", I.alignL)}${btn("align-center", "Align center", I.alignC)}${btn("align-right", "Align right", I.alignR)}<button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="wrap" title="Wrap text" aria-label="Wrap text" ${ro ? "disabled" : ""}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><path d="M3 12h13a4 4 0 0 1 0 8h-3"/><polyline points="15 16 12 20 15 24" transform="translate(0,-4)"/><line x1="3" y1="18" x2="9" y2="18"/></svg></button></div>
    <div class="wb-tgrp">
      <span class="popover-anchor">${btn("fill-menu", "Fill color", I.fill, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop wb-color-pop" role="menu" data-wb-colorkind="bg"></div></span>
      <span class="popover-anchor">${btn("textc-menu", "Text color", I.textc, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop wb-color-pop" role="menu" data-wb-colorkind="fg"></div></span>
      <span class="popover-anchor">${btn("border-menu", "Borders", I.borders, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-border="all" role="menuitem">All borders</button>
          <button type="button" class="popover-item" data-wb-border="outline" role="menuitem">Outline</button>
          <button type="button" class="popover-item" data-wb-border="bottom" role="menuitem">Bottom border</button>
          <button type="button" class="popover-item" data-wb-border="none" role="menuitem">No borders</button>
        </div></span>
      ${btn("clear-format", "Clear formatting", I.clearFmt)}
    </div>
    <div class="wb-tgrp">${btn("merge", "Merge / unmerge cells", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 12h6"/><path d="M7 9l-2 3 2 3"/><path d="M17 9l2 3-2 3"/></svg>`)}${btn("insert-link", "Insert link (Ctrl+click opens)", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`)}${btn("comment-cell", "Comment on the active cell", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`)}${btn("insert-chart", "Insert chart from the selection", `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="10" width="3" height="7"/><rect x="11" y="6" width="3" height="11"/><rect x="16" y="13" width="3" height="4"/></svg>`)}</div>
    <div class="wb-tgrp">${btn("row-add", "Insert row below", I.addRow)}${btn("row-del", "Delete row", I.delRow)}${btn("col-add", "Insert column right", I.addCol)}${btn("col-del", "Delete column", I.delCol)}</div>
    <div class="wb-tgrp">
      <span class="popover-anchor">${btn("freeze-menu", "Freeze", I.freeze, 'aria-haspopup="menu"')}
        <div class="popover wb-tb-pop" role="menu">
          <button type="button" class="popover-item" data-wb-freeze="row" role="menuitem">Freeze top row</button>
          <button type="button" class="popover-item" data-wb-freeze="col" role="menuitem">Freeze first column</button>
          <button type="button" class="popover-item" data-wb-freeze="none" role="menuitem">Unfreeze</button>
        </div></span>
      ${btn("sort-asc", "Sort by active column, A→Z", I.sortAsc)}${btn("sort-desc", "Sort by active column, Z→A", I.sortDesc)}<button type="button" class="btn btn-ghost btn-sm wb-tb" data-wb-tb="sort-custom" title="Custom sort — up to three columns" ${ro ? "disabled" : ""}>Sort…</button>${btn("filter", "Filter by active column", I.filter)}${btn("find", "Find and replace (Ctrl+F)", I.find)}${btn("validation", "Data validation", I.dv)}${btn("condfmt", "Conditional formatting", I.cf)}
    </div>
    <div class="wb-tgrp">
      <span class="popover-anchor">
        <button type="button" class="btn btn-ghost btn-icon btn-sm wb-tb" data-wb-tb="io-menu" title="Import / export" aria-haspopup="menu" aria-label="Import or export">${I.more}</button>
        <div class="popover wb-tb-pop" role="menu">
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
  g.els.canvas.style.height = g.rowY[rows.length] + "px";
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
  if (f.border === "all" || f.border === "outline") s += "box-shadow:inset 0 0 0 1px var(--border-strong);";
  else if (f.border === "bottom") s += "box-shadow:inset 0 -1.5px 0 var(--border-strong);";
  else if (f.border === "top") s += "box-shadow:inset 0 1.5px 0 var(--border-strong);";
  else if (f.border === "left") s += "box-shadow:inset 1.5px 0 0 var(--border-strong);";
  else if (f.border === "right") s += "box-shadow:inset -1.5px 0 0 var(--border-strong);";
  return s;
}

// Cell content wrapper: rotated text renders inside a span so the
// background/borders stay square.
function cellInnerHtml(cell, disp) {
  const f = cell && cell.format;
  if (f && (f.rot === 45 || f.rot === 90)) return `<span class="wb-rot" style="transform:rotate(-${f.rot}deg)">${esc(disp)}</span>`;
  return esc(disp);
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

function repaintGrid(g) {
  if (g.raf) return;
  g.raf = requestAnimationFrame(() => { g.raf = 0; paintNow(g); });
}

function paintNow(g) {
  const sheet = g.sheet;
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
    const disp = cell ? displayValue(sheet, r, c) : "";
    const err = cell && cell.err;
    const inval = cellInvalid(sheet, r, c, cell);
    // list-validated cells render as Sheets-style dropdown chips
    const dvRule = hasDvRules && r > 0 ? findValidationRule(sheet, r, c) : null;
    const chip = dvRule && dvRule.type === "list" && WB.canEdit
      ? `<span class="wb-dv-chip ${inval ? "is-invalid" : ""}" data-wb-dvchip="${r},${c}" title="Pick from list">${disp ? esc(disp) : `<span class="wb-dv-chip-empty">Select</span>`}<span class="wb-dv-caret">▾</span></span>`
      : null;
    return `<div class="wb-cell ${err ? "is-err" : ""} ${cell && cell.formula ? "is-formula" : ""} ${inval ? "is-invalid" : ""} ${cell && cell.format && cell.format.link ? "is-link" : ""}" data-r="${r}" data-c="${c}" style="left:${x}px;top:${top}px;width:${w}px;height:${h}px;${cell ? cellStyle(sheet, r, c, cell) : ""}${condStyleFor(sheet, r, c, cell)}" ${inval ? `title="${esc(validationMsg(findValidationRule(sheet, r, c)))}"` : cell && cell.format && cell.format.link ? `title="Ctrl+click to open ${esc(cell.format.link)}"` : ""}>${commented.has(key) ? `<span class="wb-cmark" title="Has comments"></span>` : ""}${chip != null ? chip : cell ? cellInnerHtml(cell, disp) : ""}${fltBtn(r, c)}</div>`;
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
async function pasteValuesOnly(g) {
  const cb = WB.clipboard;
  if (!cb || !cb.rows.length || !WB.canEdit) { _toast("Copy a range first", "info"); return; }
  const sel = selRect(g);
  const changes = [];
  for (let i = 0; i < cb.rows.length; i++) {
    for (let j = 0; j < cb.rows[i].length; j++) {
      const tr = sel.r0 + i, tc = sel.c0 + j;
      if (tr >= g.sheet.rowCount || tc >= g.sheet.colCount) continue;
      const srcCell = cb.rows[i][j];
      let next = null;
      if (srcCell) {
        const v = srcCell.formula ? (srcCell.computed ?? null) : srcCell.value;
        next = v == null || v === ""
          ? null
          : { value: String(v), formula: null, type: detectType(String(v)).type, format: srcCell.format ? { ...srcCell.format } : {} };
      }
      changes.push({ r: tr, c: tc, cell: next });
    }
  }
  setCells(g, changes);
}

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
    const mWord = /(^=|[^A-Za-z.$])([A-Za-z]{1,12})$/.exec(before);
    const mSig = /([A-Za-z]{2,12})\($/.exec(before);
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
      g.els.fbarErr.textContent = cell.err + (cell.err === "#CIRCULAR" ? " · circular reference" : cell.err === "#DIV/0" ? " · division by zero" : cell.err === "#N/A" ? " · no match found" : cell.err === "#REF" ? " · broken reference" : "");
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
  try {
    const text = await navigator.clipboard.readText();
    if (text) pasteAt(g, text);
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

function pasteRich(g, cb) {
  if (!WB.canEdit) return;
  const sheet = g.sheet;
  const sel = selRect(g);
  const srcR = cb.rows.length, srcC = cb.rows[0].length;
  const selR = sel.r1 - sel.r0 + 1, selC = sel.c1 - sel.c0 + 1;
  // Excel tiling: repeat the block when the target is an exact multiple
  const repR = selR > 1 && selR % srcR === 0 ? selR / srcR : 1;
  const repC = selC > 1 && selC % srcC === 0 ? selC / srcC : 1;
  const changes = [];
  const covered = new Set();
  for (let br = 0; br < repR; br++) for (let bc = 0; bc < repC; bc++) {
    for (let i = 0; i < srcR; i++) for (let j = 0; j < srcC; j++) {
      const tr = sel.r0 + br * srcR + i, tc = sel.c0 + bc * srcC + j;
      if (tr >= sheet.rowCount || tc >= sheet.colCount) continue;
      const srcCell = cb.rows[i][j];
      let next = null;
      if (srcCell) {
        next = cloneCell(srcCell);
        if (srcCell.formula && cb.mode !== "cut") {
          // cut moves formulas verbatim (Excel); copy adjusts refs
          next.formula = shiftFormulaRelative(srcCell.formula, tr - (cb.r0 + i), tc - (cb.c0 + j));
        }
      }
      changes.push({ r: tr, c: tc, cell: next });
      covered.add(cellKey(tr, tc));
    }
  }
  if (cb.mode === "cut") {
    if (cb.sheetId === sheet.id) {
      for (let i = 0; i < srcR; i++) for (let j = 0; j < srcC; j++) {
        const sr = cb.r0 + i, sc = cb.c0 + j;
        if (!covered.has(cellKey(sr, sc))) changes.push({ r: sr, c: sc, cell: null });
      }
    }
    cb.mode = "copy"; // a cut pastes once; further pastes behave as copy
  }
  setCells(g, changes);
  g.sel = { r0: sel.r0, c0: sel.c0, r1: Math.min(sheet.rowCount - 1, sel.r0 + repR * srcR - 1), c1: Math.min(sheet.colCount - 1, sel.c0 + repC * srcC - 1) };
  g.active = { r: sel.r0, c: sel.c0 };
  paintSelection(g);
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

function valueSatisfiesRule(rule, raw) {
  if (raw == null || raw === "") return true;
  if (rule.type === "list") {
    const s = String(raw).trim().toLowerCase();
    return (rule.list || []).some((it) => String(it).trim().toLowerCase() === s);
  }
  const x = cellNumeric(raw);
  if (x == null) return false;
  const a = +rule.v1, b = +rule.v2;
  switch (rule.op) {
    case "between": return x >= Math.min(a, b) && x <= Math.max(a, b);
    case ">": return x > a;
    case ">=": return x >= a;
    case "<": return x < a;
    case "<=": return x <= a;
    case "=": return x === a;
    default: return true;
  }
}

function validationMsg(rule) {
  if (rule.type === "list") {
    const opts = (rule.list || []).slice(0, 6).join(", ");
    return `Value must be one of: ${opts}${(rule.list || []).length > 6 ? ", …" : ""}`;
  }
  const opText = rule.op === "between" ? `between ${rule.v1} and ${rule.v2}` : `${rule.op} ${rule.v1}`;
  return `Value must be a number ${opText}`;
}

// Enforced on typed commits only — paste and fill bypass validation,
// which matches Excel. Formula cells are never blocked; their results
// just get the red invalid marker if they violate the rule.
function validateCommit(sheet, r, c, cell) {
  const rule = findValidationRule(sheet, r, c);
  if (!rule || !cell || cell.formula || cell.value == null || cell.value === "") return { ok: true };
  if (valueSatisfiesRule(rule, cell.value)) return { ok: true };
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
  return !valueSatisfiesRule(rule, raw);
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
};

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
  for (const key of ["validation", "condFormat", "merges", "charts"]) {
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

// Dropdown picker for list-validated cells (the ▾ beside the active cell).
function openValidationPicker(g, btnEl) {
  const { r, c } = g.active;
  const rule = findValidationRule(g.sheet, r, c);
  if (!rule || rule.type !== "list" || !WB.canEdit) return;
  const rect = btnEl.getBoundingClientRect();
  const m = ctxMenu(rect.left - 120, rect.bottom + 2, (rule.list || []).map((opt) =>
    `<button type="button" class="popover-item" data-dv-opt="${esc(String(opt))}" role="menuitem">${esc(String(opt))}</button>`).join("") +
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
              <option value="number" ${cur.type === "number" ? "selected" : ""}>Number</option>
            </select></label>
          <label class="wb-field" style="flex:0 0 168px"><span class="wb-field-label">On invalid input</span>
            <select class="wb-input" id="wb-dv-mode">
              <option value="reject" ${cur.mode !== "warn" ? "selected" : ""}>Reject the input</option>
              <option value="warn" ${cur.mode === "warn" ? "selected" : ""}>Show a warning</option>
            </select></label>
        </div>
        <div id="wb-dv-list-row">
          <label class="wb-field"><span class="wb-field-label">List items (comma-separated)</span>
            <input type="text" class="wb-input" id="wb-dv-list" placeholder="Pending, In progress, Done" value="${esc((cur.list || []).join(", "))}"></label>
        </div>
        <div class="wb-field-row" id="wb-dv-num-row" hidden>
          <label class="wb-field"><span class="wb-field-label">Condition</span>
            <select class="wb-input" id="wb-dv-op">
              ${opSel("between", "Between")}${opSel(">=", "Greater or equal")}${opSel("<=", "Less or equal")}${opSel(">", "Greater than")}${opSel("<", "Less than")}${opSel("=", "Equal to")}
            </select></label>
          <label class="wb-field" style="flex:0 0 100px"><span class="wb-field-label">Value</span>
            <input type="number" class="wb-input" id="wb-dv-v1" value="${cur.v1 ?? ""}"></label>
          <label class="wb-field" style="flex:0 0 100px" id="wb-dv-v2-field"><span class="wb-field-label">and</span>
            <input type="number" class="wb-input" id="wb-dv-v2" value="${cur.v2 ?? ""}"></label>
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
  const syncRows = () => {
    const t = wrap.querySelector("#wb-dv-type").value;
    wrap.querySelector("#wb-dv-list-row").hidden = t !== "list";
    wrap.querySelector("#wb-dv-num-row").hidden = t !== "number";
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
        rule.list = wrap.querySelector("#wb-dv-list").value.split(",").map((s) => s.trim()).filter(Boolean);
        if (!rule.list.length) { _toast("Add at least one list item", "warn"); return; }
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
  const chips = Object.entries(WB_CF_STYLES).map(([k, st], i) =>
    `<button type="button" class="wb-cf-chip ${i === 0 ? "is-on" : ""}" data-cf-style="${k}" style="background:${st.bg};color:${st.fg}" title="${st.label}" aria-pressed="${i === 0}">Aa</button>`).join("");
  wrap.innerHTML = `
    <div class="rr-modal-panel" role="dialog" aria-modal="true" aria-label="Conditional formatting" style="width:520px">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content"><p class="rr-modal-title">Conditional formatting</p><p class="rr-modal-sub">New rules apply to ${esc(refText)}</p></div>
        <button class="rr-modal-close" type="button" data-wb-close aria-label="Close">×</button>
      </div>
      <div class="rr-modal-body">
        <div class="wb-field-row">
          <label class="wb-field"><span class="wb-field-label">Format cells if…</span>
            <select class="wb-input" id="wb-cf-kind">${kindOpts}</select></label>
          <label class="wb-field" style="flex:0 0 110px" id="wb-cf-v1-field"><span class="wb-field-label">Value</span>
            <input type="text" class="wb-input" id="wb-cf-v1"></label>
          <label class="wb-field" style="flex:0 0 110px" id="wb-cf-v2-field"><span class="wb-field-label">and</span>
            <input type="text" class="wb-input" id="wb-cf-v2"></label>
        </div>
        <div class="wb-field"><span class="wb-field-label">Style</span>
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
          const st = WB_CF_STYLES[rule.style] || WB_CF_STYLES.amber;
          const what = rule.kind === "empty" || rule.kind === "notempty" ? WB_CF_KINDS[rule.kind]
            : rule.kind === "between" ? `${WB_CF_KINDS.between} ${rule.v1} and ${rule.v2}`
            : `${WB_CF_KINDS[rule.kind] || rule.kind} ${rule.v1}`;
          return `<div class="wb-cf-rule"><span class="wb-cf-swatch" style="background:${st.bg};color:${st.fg}">Aa</span><span class="wb-cf-what">${esc(ruleRefText(rule))} · ${esc(what)}</span><button type="button" class="wb-cf-del" data-cf-del="${i}" aria-label="Delete rule">×</button></div>`;
        }).join("");
  };
  const syncFields = () => {
    const k = wrap.querySelector("#wb-cf-kind").value;
    wrap.querySelector("#wb-cf-v1-field").style.display = k === "empty" || k === "notempty" ? "none" : "";
    wrap.querySelector("#wb-cf-v2-field").style.display = k === "between" ? "" : "none";
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
      const kind = wrap.querySelector("#wb-cf-kind").value;
      const v1 = wrap.querySelector("#wb-cf-v1").value.trim();
      const v2 = wrap.querySelector("#wb-cf-v2").value.trim();
      if (kind !== "empty" && kind !== "notempty" && v1 === "") { _toast("Enter a value for the condition", "warn"); return; }
      if (kind === "between" && v2 === "") { _toast("Enter both limits", "warn"); return; }
      const style = wrap.querySelector(".wb-cf-chip.is-on")?.getAttribute("data-cf-style") || "green";
      const rules = sheetRules(sheet, "condFormat").slice();
      rules.push({ id: "cf" + Math.random().toString(36).slice(2, 8), r0: rect.r0, c0: rect.c0, r1: rect.r1, c1: rect.c1, kind, v1, v2, style });
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
      tds += `<td${span} style="${style}">${esc(cell ? displayValue(sheet, r, c) : "")}</td>`;
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
  const xfs = [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`];
  const xfIdx = new Map([["0|0|0||0||0", 0]]);

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
    const align = f.align || "";
    const valign = f.valign === "middle" ? "center" : f.valign || "";
    const rot = f.rot === 45 || f.rot === 90 ? f.rot : 0;
    const wrap = f.wrap ? 1 : 0;
    const xfKey = `${numId}|${fontId}|${fillId}|${align}|${wrap}|${valign}|${rot}`;
    let s = xfIdx.get(xfKey);
    if (s == null) {
      s = xfs.length;
      const alignXml = align || wrap || valign || rot
        ? `<alignment${align ? ` horizontal="${align}"` : ""}${valign ? ` vertical="${valign}"` : ""}${wrap ? ` wrapText="1"` : ""}${rot ? ` textRotation="${rot}"` : ""}/>`
        : "";
      xfs.push(`<xf numFmtId="${numId}" fontId="${fontId}" fillId="${fillId}" borderId="0"${numId ? ` applyNumberFormat="1"` : ""}${fontId ? ` applyFont="1"` : ""}${fillId ? ` applyFill="1"` : ""}${alignXml ? ` applyAlignment="1"` : ""}>${alignXml}</xf>`);
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

  const stylesXml = `${XMLH}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs></styleSheet>`;
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
const WB_CHART_TYPES = { column: "Column", bar: "Bar", line: "Line", area: "Area", pie: "Pie" };

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

  // shared cartesian frame
  const W = 480, H = 220, padL = 46, padR = 10, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const horizontal = ch.type === "bar";
  let lo = 0, hi = 1;
  const allVals = series.flatMap((s) => s.values).filter((v) => v != null);
  if (allVals.length) { lo = Math.min(...allVals), hi = Math.max(...allVals); }
  if (ch.type !== "line") { lo = Math.min(0, lo); hi = Math.max(0, hi); } // bars/areas keep a zero baseline
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

  if (ch.type === "column" || ch.type === "bar") {
    const band = (horizontal ? plotH : plotW) / nCat;
    const inner = band * 0.72;
    const bw = Math.max(3, (inner - (series.length - 1) * 2) / series.length);
    categories.forEach((label, i) => {
      series.forEach((s, si) => {
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
  g.chartsT = setTimeout(() => renderCharts(g), 250);
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
  if (!wasOpen) pop.classList.add("open");
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

    // ── dropdown chips + header filter buttons ── (opened from the
    // document click delegate — opening here on mousedown would be undone
    // by the click-away closer)
    if (e.target.closest("[data-wb-dvchip]") || e.target.closest("[data-wb-fltbtn]")) { e.preventDefault(); return; }

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
    const pos = canvasPos(e);
    const di = dispRowAt(g, pos.y);
    const r = g.rows[di] ?? 0;
    const c = colAt(g, pos.x);
    // Ctrl/Cmd+click on a linked cell opens the link
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      const lc = g.sheet.cells.get(cellKey(r, c));
      if (lc && lc.format && lc.format.link) { window.open(lc.format.link, "_blank", "noopener"); return; }
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
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (text) pasteAt(g, text);
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
        const rc = parseCellRef(nameBox.value.trim());
        if (rc && rc.row < g.sheet.rowCount && rc.col < g.sheet.colCount) {
          setActive(g, rc.row, rc.col);
          g.els.grid.focus();
        } else {
          _toast("Type a cell reference like B12", "info");
          syncFormulaBar(g);
        }
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
    const colorBtn = e.target.closest("[data-wb-color]");
    if (colorBtn) {
      const kind = colorBtn.closest(".wb-color-pop").getAttribute("data-wb-colorkind");
      formatSelection(g, { [kind]: colorBtn.getAttribute("data-wb-color") || null });
      closeAllPopovers();
      return;
    }
    const borderBtn = e.target.closest("[data-wb-border]");
    if (borderBtn) { const v = borderBtn.getAttribute("data-wb-border"); formatSelection(g, { border: v === "none" ? null : v }); closeAllPopovers(); return; }
    const freezeBtn = e.target.closest("[data-wb-freeze]");
    if (freezeBtn) { setFreeze(g, freezeBtn.getAttribute("data-wb-freeze")); closeAllPopovers(); return; }
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
      case "wrap": toggleFormat(g, "wrap"); break;
      case "clear-format": clearFormatting(g); break;
      case "dec-minus": adjustDecimals(g, -1); break;
      case "dec-plus": adjustDecimals(g, 1); break;
      case "fs-minus": adjustFontSize(g, -1); break;
      case "fs-plus": adjustFontSize(g, 1); break;
      case "find": openFindPanel(g, false); break;
      case "validation": openValidationDialog(g); break;
      case "condfmt": openCondFormatDialog(g); break;
      case "row-add": restructure(g, "row", g.active.r + 1, 1); break;
      case "row-del": restructure(g, "row", g.active.r, -1); break;
      case "col-add": restructure(g, "col", g.active.c + 1, 1); break;
      case "col-del": restructure(g, "col", g.active.c, -1); break;
      case "sort-asc": sortByColumn(g, g.active.c, "asc"); break;
      case "sort-desc": sortByColumn(g, g.active.c, "desc"); break;
      case "sort-custom": openSortDialog(g); return;
      case "filter": toggleFilterMode(g); break;
      case "numfmt-menu":
      case "fill-menu":
      case "textc-menu":
      case "border-menu":
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

function fillColorPop(g, btn) {
  const pop = btn.closest(".popover-anchor")?.querySelector(".wb-color-pop");
  if (!pop || pop.dataset.filled) return;
  pop.dataset.filled = "1";
  const kind = pop.getAttribute("data-wb-colorkind");
  pop.innerHTML = `
    <button type="button" class="wb-color-reset" data-wb-color="">✕ Reset to default</button>
    <div class="wb-color-grid wb-color-grid-10">${WB_COLOR_MATRIX.flat().map((hex) =>
      `<button type="button" class="wb-swatch" data-wb-color="${hex}" title="${hex}" aria-label="${hex}" style="background:${hex}"></button>`).join("")}</div>
    <label class="wb-color-custom"><input type="color" data-wb-colorpick value="${kind === "bg" ? "#FFF2CC" : "#1F2937"}" aria-label="Custom color"> Custom…</label>
    <button type="button" class="wb-color-cf" data-wb-colorcf>Conditional formatting…</button>`;
  pop.querySelector("[data-wb-colorpick]").addEventListener("change", (e) => {
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

function openCellContextMenu(g, x, y, kind) {
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
  const item = (act, label, danger, disabled) => `<button type="button" class="popover-item ${danger ? "is-danger" : ""}" data-ctx="${act}" role="menuitem" ${disabled || (ro && act !== "copy" && act !== "copy-ref") ? "disabled" : ""}>${label}</button>`;
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
  const toggle = document.querySelector('[data-wb-act="toggle-panel"]');
  if (panel) panel.hidden = !WB.panelOpen;
  if (detail) detail.classList.toggle("is-panel-open", WB.panelOpen);
  if (toggle) { toggle.classList.toggle("is-on", WB.panelOpen); toggle.setAttribute("aria-pressed", String(WB.panelOpen)); }
}

function renderPanel() {
  const panel = document.getElementById("wb-panel");
  if (!panel || !WB.panelOpen) return;
  const tabs = [
    ["comments", "Comments"], ["tasks", "Tasks"], ["activity", "Activity"], ["details", "Details"], ["sharing", "Sharing"],
  ];
  panel.innerHTML = `
    <div class="wb-panel-tabs" role="tablist" aria-label="Workbook panel">
      ${tabs.map(([k, label]) => `<button type="button" class="wb-panel-tab ${WB.panelTab === k ? "is-active" : ""}" role="tab" aria-selected="${WB.panelTab === k}" data-wb-paneltab="${k}">${label}</button>`).join("")}
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
    case "View": return [
      { label: "Freeze", sub: [
        { label: "Freeze top row", act: "view:freeze-row", disabled: !ed || !g },
        { label: "Freeze first column", act: "view:freeze-col", disabled: !ed || !g },
        { label: "Unfreeze", act: "view:unfreeze", disabled: !ed || !g },
      ] },
      { label: "Zoom", sub: [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((z) => ({ label: Math.round(z * 100) + "%", act: "view:zoom:" + z, disabled: !g })) },
      sep,
      { label: "Unhide all rows & columns", act: "view:unhide", disabled: !ed || !g },
      sep,
      { label: "Comments panel", act: "view:comments" },
      { label: "Tasks panel", act: "view:tasks" },
      { label: "Activity panel", act: "view:activity" },
    ];
    case "Insert": return [
      { label: "Row above", act: "ins:row-above", disabled: !ed || !g },
      { label: "Row below", act: "ins:row-below", disabled: !ed || !g },
      { label: "Column left", act: "ins:col-left", disabled: !ed || !g },
      { label: "Column right", act: "ins:col-right", disabled: !ed || !g },
      { label: "New sheet", act: "ins:sheet", disabled: !ed || !g },
      sep,
      { label: "Chart…", act: "ins:chart", disabled: !ed || !g },
      { label: "Function", sub: ["SUM", "AVERAGE", "COUNT", "MAX", "MIN", "COUNTIF", "VLOOKUP"].map((fn) => ({ label: fn, act: "ins:fn:" + fn, disabled: !ed || !g })) },
      { label: "Link…", act: "ins:link", disabled: !ed || !g },
      { label: "Dropdown (data validation)…", act: "ins:dropdown", disabled: !ed || !g },
      { label: "Comment", act: "ins:comment", disabled: !g },
      sep,
      { label: "Note block", act: "ins:note", disabled: !ed },
      { label: "Checklist block", act: "ins:checklist", disabled: !ed },
      { label: "Spreadsheet block", act: "ins:sheetblock", disabled: !ed },
    ];
    case "Format": return [
      { label: "Number", sub: [["", "Automatic"], ["number", "Number"], ["currency", "Currency"], ["accounting", "Accounting"], ["percent", "Percent"], ["scientific", "Scientific"], ["date", "Date"], ["text", "Plain text"]].map(([v, label]) => ({ label, act: "fmt:num:" + v, disabled: !ed || !g })) },
      { label: "Text", sub: [["bold", "Bold", "Ctrl+B"], ["italic", "Italic", "Ctrl+I"], ["underline", "Underline", "Ctrl+U"], ["strike", "Strikethrough", ""]].map(([k, label, kbd]) => ({ label, kbd, act: "fmt:tog:" + k, disabled: !ed || !g })) },
      { label: "Alignment", sub: [["align:left", "Left"], ["align:center", "Center"], ["align:right", "Right"], ["valign:top", "Top"], ["valign:middle", "Middle"], ["valign:bottom", "Bottom"]].map(([v, label]) => ({ label, act: "fmt:" + v, disabled: !ed || !g })) },
      { label: "Wrapping", act: "fmt:tog:wrap", disabled: !ed || !g },
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
    case "file:new": openCreateModal(); return;
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
    case "ins:link": if (need()) insertLinkPrompt(g); return;
    case "ins:dropdown": if (need()) openValidationDialog(g); return;
    case "ins:comment": if (need()) openCellComment(g, g.active.r, g.active.c); return;
    case "ins:note": addBlock("text"); return;
    case "ins:checklist": addBlock("checklist"); return;
    case "ins:sheetblock": addBlock("sheet"); return;
    case "fmt:merge": if (need()) toggleMergeSelection(g); return;
    case "fmt:cf": if (need()) openCondFormatDialog(g); return;
    case "fmt:cells": if (need()) openFormatCellsDialog(g); return;
    case "fmt:clear": if (need()) clearFormatting(g); return;
    case "data:sort-asc": if (need()) sortByColumn(g, g.active.c, "asc"); return;
    case "data:sort-desc": if (need()) sortByColumn(g, g.active.c, "desc"); return;
    case "data:sort": if (need()) openSortDialog(g); return;
    case "data:filter-toggle": if (need()) toggleFilterMode(g); return;
    case "data:filter": if (need()) openFilterPanel(g, g.active.c, null, { x: Math.max(16, window.innerWidth / 2 - 132), y: 180 }); return;
    case "data:filter-clear": if (need()) { g.filters = new Map(); computeGeometry(g); repaintGrid(g); persistFilterState(g); } return;
    case "data:fv-save": if (need()) saveFilterView(g); return;
    case "data:stats": if (need()) showColumnStats(g); return;
    case "data:validation": if (need()) openValidationDialog(g); return;
    case "data:split": if (need()) splitTextToColumns(g); return;
    case "data:dedupe": if (need()) removeDuplicateRows(g); return;
    case "data:trim": if (need()) trimWhitespace(g); return;
  }
  if (!g) { _toast("Open a spreadsheet block first", "info"); return; }
  if (ns === "view" && verb === "zoom") setZoom(g, +arg || 1);
  else if (ns === "ins" && verb === "fn") startEdit(g, g.active.r, g.active.c, `=${arg}(`);
  else if (ns === "fmt" && verb === "num") formatSelection(g, { num: arg || null });
  else if (ns === "fmt" && verb === "tog") toggleFormat(g, arg);
  else if (ns === "fmt" && verb === "align") formatSelection(g, { align: arg });
  else if (ns === "fmt" && verb === "valign") formatSelection(g, { valign: arg });
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

    const fltb = e.target.closest("[data-wb-fltbtn]");
    if (fltb) {
      const gridEl = fltb.closest("[data-wb-gridfocus]");
      const g = gridEl && GRIDS.get(gridEl.getAttribute("data-wb-gridfocus"));
      if (g) openFilterPanel(g, +fltb.getAttribute("data-wb-fltbtn"), fltb);
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
      case "new-workbook": openCreateModal(); break;
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
      case "head-menu": togglePopover(actBtn); break;
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

// ─── Test hook ───────────────────────────────────────────────────────────────
// Exposed for the Node engine tests (scripts/test-formula-engine.mjs) —
// not part of the app surface; live.js imports only the view loaders.

export const __engine = {
  parseFormula, evalFormula, extractRefs, matchesCriterion, FormulaError,
  colLabel, colIndex, cellRef, parseCellRef,
  dateToSerial, serialToDate, isoDate, parseDateLoose,
  buildXlsxBytes,
};
