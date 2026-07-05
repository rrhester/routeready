#!/usr/bin/env node
// Unit tests for the workbook formula engine (dashboard/workbook.js).
// Pure Node — the engine has no DOM dependencies, so we import the
// module directly and drive evalFormula with a tiny in-memory sheet.
//
//   node scripts/test-formula-engine.mjs
//
// Exits non-zero on the first failure.

import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";

const { evalFormula, extractRefs, matchesCriterion, parseCellRef, dateToSerial, FormulaError } = __engine;

function sheetCtx(cells, rows = 100, cols = 26) {
  const map = new Map();
  for (const [ref, v] of Object.entries(cells || {})) {
    const rc = parseCellRef(ref);
    map.set(rc.row + "," + rc.col, v);
  }
  return { rowCount: rows, colCount: cols, getCell: (r, c) => (map.has(r + "," + c) ? map.get(r + "," + c) : null) };
}

let n = 0;
function ok(name, fn) {
  try { fn(); n++; }
  catch (e) {
    console.error(`✗ ${name}`);
    console.error("  " + (e && e.message));
    process.exit(1);
  }
}
const ev = (src, ctx) => evalFormula(src, ctx || sheetCtx({}));
const evErr = (src, ctx) => {
  try { ev(src, ctx); } catch (e) { if (e instanceof FormulaError) return e.code; throw e; }
  return null;
};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ── operators & scalars ──────────────────────────────────────────────────────
ok("arithmetic precedence", () => assert.equal(ev("=1+2*3"), 7));
ok("power is right-assoc", () => assert.equal(ev("=2^3^2"), 512));
ok("percent postfix", () => assert.equal(ev("=50%"), 0.5));
ok("concat", () => assert.equal(ev('="a"&"b"&1'), "ab1"));
ok("comparison", () => assert.equal(ev('=IF(3>2,"y","n")'), "y"));

// ── date serials ─────────────────────────────────────────────────────────────
ok("Excel serial anchor (2026-07-05 = 46208)", () => assert.equal(dateToSerial(new Date(2026, 6, 5)), 46208));
ok("serial→weekday mapping matches the calendar", () => {
  for (const d of [new Date(2026, 6, 5), new Date(2024, 1, 29), new Date(2030, 11, 31), new Date(1999, 0, 1)]) {
    assert.equal(dateToSerial(d) % 7, (d.getDay() + 1) % 7);
  }
});
ok("date subtraction", () => assert.equal(ev('="2026-07-10"-"2026-07-01"'), 9));
ok("date plus days", () => assert.equal(ev('="2026-07-01"+30'), dateToSerial(new Date(2026, 6, 31))));
ok("m/d/y dates parse in math", () => assert.equal(ev('="7/10/2026"-"7/1/2026"'), 9));
ok("DATEDIF days", () => assert.equal(ev('=DATEDIF("2026-01-15","2026-07-05","D")'), 171));
ok("DATEDIF months", () => assert.equal(ev('=DATEDIF("2026-01-15","2026-07-05","M")'), 5));
ok("DATEDIF years", () => assert.equal(ev('=DATEDIF("2024-06-01","2026-07-05","Y")'), 2));
ok("DAYS", () => assert.equal(ev('=DAYS("2026-07-05","2026-07-01")'), 4));
ok("DATEVALUE", () => assert.equal(ev('=DATEVALUE("2026-07-05")'), 46208));
ok("EDATE clamps to month end", () => assert.equal(ev('=EDATE("2026-01-31",1)'), "2026-02-28"));
ok("EOMONTH", () => assert.equal(ev('=EOMONTH("2026-02-10",0)'), "2026-02-28"));
ok("NETWORKDAYS", () => assert.equal(ev('=NETWORKDAYS("2026-07-01","2026-07-05")'), 3));
ok("NETWORKDAYS with holiday", () => assert.equal(ev('=NETWORKDAYS("2026-07-01","2026-07-05","2026-07-03")'), 2));
ok("WORKDAY skips the weekend", () => assert.equal(ev('=WORKDAY("2026-07-02",2)'), "2026-07-06"));
ok("WEEKNUM", () => assert.equal(ev('=WEEKNUM("2026-01-01")'), 1));
ok("YEAR of a serial result", () => assert.equal(ev('=YEAR("2026-07-01"+30)'), 2026));
ok("date comparison across formats", () => assert.equal(ev('=IF("7/10/2026">"2026-07-01",1,0)'), 1));

// ── wildcards & criteria ─────────────────────────────────────────────────────
ok("wildcard * matches", () => assert.equal(matchesCriterion("V-101", "V-1*"), true));
ok("wildcard ? matches one char", () => assert.equal(matchesCriterion("Alpha", "?lpha"), true));
ok("wildcard negation", () => assert.equal(matchesCriterion("x", "<>*a*"), true));
ok("tilde escapes a literal star", () => assert.equal(matchesCriterion("a*b", "a~*b"), true));
ok("COUNTIF with wildcard", () => {
  const ctx = sheetCtx({ A1: "V-101", A2: "V-202", A3: "V-110" });
  assert.equal(ev('=COUNTIF(A1:A3,"V-1*")', ctx), 2);
});
ok("COUNTIF with date criterion", () => {
  const ctx = sheetCtx({ A1: "2026-06-01", A2: "2026-07-04", A3: "2026-08-01" });
  assert.equal(ev('=COUNTIF(A1:A3,">2026-07-01")', ctx), 2);
});

// ── open-ended ranges ────────────────────────────────────────────────────────
ok("SUM(A:A)", () => assert.equal(ev("=SUM(A:A)", sheetCtx({ A1: 1, A2: 2, A3: 3, B1: 9 })), 6));
ok("SUM(1:1)", () => assert.equal(ev("=SUM(1:1)", sheetCtx({ A1: 1, B1: 2, A2: 9 })), 3));
ok("COUNTIF over A:A", () => assert.equal(ev('=COUNTIF(A:A,">1")', sheetCtx({ A1: 1, A2: 2, A3: 3 })), 2));
ok("extractRefs clamps open ranges", () => assert.equal(extractRefs("=SUM(A:A)", { rowCount: 5, colCount: 3 }).length, 5));

// ── lookups ──────────────────────────────────────────────────────────────────
const lookCtx = sheetCtx({ A1: 1, B1: "a", A2: 5, B2: "b", A3: 10, B3: "c" });
ok("VLOOKUP exact still exact", () => assert.equal(ev("=VLOOKUP(5,A1:B3,2)", lookCtx), "b"));
ok("VLOOKUP exact miss is #N/A", () => assert.equal(evErr("=VLOOKUP(7,A1:B3,2)", lookCtx), "#N/A"));
ok("VLOOKUP approximate", () => assert.equal(ev("=VLOOKUP(7,A1:B3,2,TRUE)", lookCtx), "b"));
ok("VLOOKUP approximate below range is #N/A", () => assert.equal(evErr("=VLOOKUP(0,A1:B3,2,TRUE)", lookCtx), "#N/A"));
ok("MATCH type 1", () => assert.equal(ev("=MATCH(7,A1:A3,1)", lookCtx), 2));
ok("MATCH type -1", () => assert.equal(ev("=MATCH(7,A3:A1,-1)", sheetCtx({ A1: 10, A2: 5, A3: 1 })), 1));
ok("MATCH exact default", () => assert.equal(evErr("=MATCH(7,A1:A3)", lookCtx), "#N/A"));
ok("HLOOKUP approximate", () => {
  const ctx = sheetCtx({ A1: 1, B1: 5, C1: 10, A2: "x", B2: "y", C2: "z" });
  assert.equal(ev("=HLOOKUP(7,A1:C2,2,TRUE)", ctx), "y");
});

// ── new functions ────────────────────────────────────────────────────────────
ok("SUMPRODUCT", () => assert.equal(ev("=SUMPRODUCT(A1:A2,B1:B2)", sheetCtx({ A1: 1, A2: 2, B1: 3, B2: 4 })), 11));
ok("TEXTJOIN ignores empties", () => assert.equal(ev('=TEXTJOIN(", ",TRUE,A1:A3)', sheetCtx({ A1: "a", A3: "c" })), "a, c"));
ok("TEXTJOIN keeps empties when told", () => assert.equal(ev('=TEXTJOIN("-",FALSE,A1:A3)', sheetCtx({ A1: "a", A3: "c" })), "a--c"));
const statCtx = sheetCtx({ A1: 5, A2: 1, A3: 9, A4: 7 });
ok("LARGE", () => assert.equal(ev("=LARGE(A1:A4,2)", statCtx), 7));
ok("SMALL", () => assert.equal(ev("=SMALL(A1:A4,2)", statCtx), 5));
ok("RANK", () => assert.equal(ev("=RANK(7,A1:A4)", statCtx), 2));
ok("RANK ascending", () => assert.equal(ev("=RANK(7,A1:A4,1)", statCtx), 3));
ok("STDEV", () => near(ev("=STDEV(A1:A8)", sheetCtx({ A1: 2, A2: 4, A3: 4, A4: 4, A5: 5, A6: 5, A7: 7, A8: 9 })), Math.sqrt(32 / 7), 1e-9));
ok("COUNTBLANK", () => assert.equal(ev("=COUNTBLANK(A1:A4)", sheetCtx({ A1: 1, A3: "x" })), 2));
ok("CHOOSE", () => assert.equal(ev('=CHOOSE(2,"a","b","c")'), "b"));
ok("SWITCH match", () => assert.equal(ev('=SWITCH(2,1,"one",2,"two","other")'), "two"));
ok("SWITCH default", () => assert.equal(ev('=SWITCH(9,1,"one","fallback")'), "fallback"));
ok("MAXIFS", () => assert.equal(ev('=MAXIFS(A1:A3,B1:B3,"x")', sheetCtx({ A1: 1, A2: 2, A3: 3, B1: "x", B2: "y", B3: "x" })), 3));
ok("MINIFS", () => assert.equal(ev('=MINIFS(A1:A3,B1:B3,"x")', sheetCtx({ A1: 1, A2: 2, A3: 3, B1: "x", B2: "y", B3: "x" })), 1));
ok("CEILING", () => assert.equal(ev("=CEILING(4.3)"), 5));
ok("CEILING with step", () => near(ev("=CEILING(4.3,0.5)"), 4.5));
ok("FLOOR", () => assert.equal(ev("=FLOOR(4.7)"), 4));
ok("TRUNC", () => near(ev("=TRUNC(4.789,2)"), 4.78));
ok("SEARCH is case-insensitive", () => assert.equal(ev('=SEARCH("b","ABC")'), 2));
ok("FIND stays case-sensitive", () => assert.equal(evErr('=FIND("b","ABC")'), "#VALUE"));
ok("PROPER", () => assert.equal(ev('=PROPER("van fleet-week")'), "Van Fleet-Week"));
ok("REPT", () => assert.equal(ev('=REPT("ab",3)'), "ababab"));
ok("EXACT", () => assert.equal(ev('=EXACT("a","A")'), false));
ok("VALUE", () => assert.equal(ev('=VALUE("$1,250.50")'), 1250.5));
ok("XOR", () => assert.equal(ev("=XOR(TRUE,TRUE,TRUE)"), true));
ok("LN/EXP/LOG", () => { near(ev("=LN(EXP(2))"), 2); near(ev("=LOG(1000)"), 3); near(ev("=LOG(8,2)"), 3); });
ok("ISBLANK", () => assert.equal(ev("=ISBLANK(Z9)"), true));
ok("ISNUMBER", () => assert.equal(ev("=ISNUMBER(5)"), true));
ok("ISTEXT", () => assert.equal(ev('=ISTEXT("x")'), true));
ok("ISERROR catches #DIV/0", () => assert.equal(ev("=ISERROR(1/0)"), true));
ok("RANDBETWEEN bounds", () => { const v = ev("=RANDBETWEEN(3,5)"); assert.ok(v >= 3 && v <= 5 && Number.isInteger(v)); });

// ── Sheets function-list expansion ───────────────────────────────────────────
ok("math batch", () => {
  assert.equal(ev("=SIGN(-9)"), -1);
  assert.equal(ev("=EVEN(3)"), 4);
  assert.equal(ev("=ODD(4)"), 5);
  assert.equal(ev("=PRODUCT(A1:A3)", sheetCtx({ A1: 2, A2: 3, A3: 4 })), 24);
  assert.equal(ev("=SUMSQ(A1:A2)", sheetCtx({ A1: 3, A2: 4 })), 25);
  assert.equal(ev("=QUOTIENT(17,5)"), 3);
  assert.equal(ev("=GCD(12,18)"), 6);
  assert.equal(ev("=LCM(4,6)"), 12);
  assert.equal(ev("=FACT(5)"), 120);
  assert.equal(ev("=COMBIN(5,2)"), 10);
  near(ev("=MROUND(7.3,0.5)"), 7.5);
  near(ev("=DEGREES(PI())"), 180);
  near(ev("=SIN(RADIANS(90))"), 1);
  near(ev("=ATAN2(1,1)"), Math.PI / 4);
  near(ev("=LOG10(1000)"), 3);
});
ok("stat batch", () => {
  const ctx = sheetCtx({ A1: 2, A2: 4, A3: 4, A4: "x" });
  near(ev("=AVERAGEA(A1:A4)", ctx), 2.5); // text counts as 0
  assert.equal(ev("=COUNTUNIQUE(A1:A4)", ctx), 3);
  assert.equal(ev("=MODE(A1:A3)", ctx), 4);
  near(ev("=STDEVP(A1:A2)", sheetCtx({ A1: 2, A2: 4 })), 1);
  near(ev("=VARP(A1:A2)", sheetCtx({ A1: 2, A2: 4 })), 1);
  near(ev("=GEOMEAN(A1:A2)", sheetCtx({ A1: 2, A2: 8 })), 4);
  near(ev("=HARMEAN(A1:A2)", sheetCtx({ A1: 2, A2: 6 })), 3);
  near(ev("=PERCENTILE(A1:A5,0.5)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 })), 3);
  near(ev("=QUARTILE(A1:A5,2)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 })), 3);
});
ok("text/info batch", () => {
  assert.equal(ev("=CHAR(65)"), "A");
  assert.equal(ev('=CODE("A")'), 65);
  assert.equal(ev('=REPLACE("routeready",6,5,"READY")'), "routeREADY");
  assert.equal(ev('=JOIN("-","a","b","c")'), "a-b-c");
  assert.equal(ev("=DOLLAR(-1234.567)"), "($1,234.57)");
  assert.equal(ev("=FIXED(1234.567,1)"), "1,234.6");
  assert.equal(ev('=T("x")&N(5)'), "x5");
  assert.equal(ev("=ISEVEN(4)"), true);
  assert.equal(ev("=ISODD(-3)"), true);
  assert.equal(ev('=ISDATE("2026-07-05")'), true);
  assert.equal(ev("=ISLOGICAL(TRUE)"), true);
  assert.equal(ev("=IFNA(NA(),\"safe\")"), "safe");
  assert.equal(ev("=ISNA(NA())"), true);
  assert.equal(ev("=ISNA(1/0)"), false);
});
ok("date/time batch", () => {
  assert.equal(ev('=DAYS360("2026-01-01","2027-01-01")'), 360);
  near(ev('=YEARFRAC("2026-01-01","2027-01-01")'), 1);
  assert.equal(ev('=ISOWEEKNUM("2026-01-01")'), 1);
  assert.equal(ev('=HOUR("14:30")'), 14);
  assert.equal(ev('=MINUTE("2:45 PM")'), 45);
  near(ev('=TIMEVALUE("6:00")'), 0.25);
});
ok("financial batch", () => {
  near(ev("=PMT(0.05/12,60,10000)"), -188.71, 0.05);
  near(ev("=FV(0,10,-100)"), 1000);
  near(ev("=PV(0,10,-100)"), 1000);
  near(ev("=NPER(0,-100,1000)"), 10);
  near(ev("=NPV(0.1,100,100)"), 173.55, 0.01);
  near(ev("=IRR(A1:A3)", sheetCtx({ A1: -100, A2: 60, A3: 60 })), 0.1307, 1e-3);
  near(ev("=SLN(1000,100,9)"), 100);
  near(ev("=EFFECT(0.12,12)"), 0.1268, 1e-3);
});
ok("lookup/positional batch", () => {
  const ctx = sheetCtx({ A1: 1, A2: 5, A3: 10, B1: "a", B2: "b", B3: "c" });
  assert.equal(ev("=LOOKUP(7,A1:A3,B1:B3)", ctx), "b");
  assert.equal(ev("=ROW(B7)"), 7);
  assert.equal(ev("=COLUMN(B7)"), 2);
  assert.equal(ev("=ROWS(A1:C4)"), 4);
  assert.equal(ev("=COLUMNS(A1:C4)"), 3);
  assert.equal(ev("=ADDRESS(3,2)"), "$B$3");
  assert.equal(ev("=ADDRESS(3,2,4)"), "B3");
});
ok("operator functions", () => {
  assert.equal(ev("=ADD(2,MULTIPLY(3,4))"), 14);
  assert.equal(ev("=DIVIDE(10,4)"), 2.5);
  assert.equal(ev("=EQ(2,2)"), true);
  assert.equal(ev("=GTE(3,4)"), false);
  near(ev("=UNARY_PERCENT(50)"), 0.5);
});

// ── regressions on the existing surface ──────────────────────────────────────
const regCtx = sheetCtx({ A1: 10, A2: 20, A3: 30, B1: "x", B2: "y", B3: "x" });
ok("SUM", () => assert.equal(ev("=SUM(A1:A3)", regCtx), 60));
ok("AVERAGE", () => assert.equal(ev("=AVERAGE(A1:A3)", regCtx), 20));
ok("SUMIF", () => assert.equal(ev('=SUMIF(B1:B3,"x",A1:A3)', regCtx), 40));
ok("SUMIFS", () => assert.equal(ev('=SUMIFS(A1:A3,B1:B3,"x")', regCtx), 40));
ok("COUNTIFS", () => assert.equal(ev('=COUNTIFS(B1:B3,"x",A1:A3,">15")', regCtx), 1));
ok("AVERAGEIF", () => assert.equal(ev('=AVERAGEIF(B1:B3,"x",A1:A3)', regCtx), 20));
ok("INDEX/MATCH", () => assert.equal(ev('=INDEX(A1:A3,MATCH("y",B1:B3,0))', regCtx), 20));
ok("XLOOKUP", () => assert.equal(ev('=XLOOKUP("y",B1:B3,A1:A3)', regCtx), 20));
ok("IFERROR", () => assert.equal(ev('=IFERROR(1/0,"safe")'), "safe"));
ok("IFS", () => assert.equal(ev('=IFS(FALSE,1,TRUE,2)'), 2));
ok("text functions", () => { assert.equal(ev('=LEFT("hello",2)'), "he"); assert.equal(ev('=MID("hello",2,3)'), "ell"); assert.equal(ev('=SUBSTITUTE("aaa","a","b",2)'), "aba"); });
ok("ROUND family", () => { assert.equal(ev("=ROUND(2.675,2)"), 2.68); assert.equal(ev("=ROUNDDOWN(2.679,2)"), 2.67); });
ok("MOD", () => assert.equal(ev("=MOD(-3,5)"), 2));
ok("unknown function is #NAME", () => assert.equal(evErr("=FOO(1)"), "#NAME"));
ok("parse error is #ERROR", () => assert.equal(evErr("=1+"), "#ERROR"));
ok("bare cell math with $ anchors", () => assert.equal(ev("=$A$1+A2", regCtx), 30));

// ── XLSX export ──────────────────────────────────────────────────────────────
// Parse the produced zip back (stored entries only) and verify structure,
// CRCs, and the cell/style XML we care about.

function testCrc32(bytes) {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readStoredZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdPos = bytes.length - 22;
  assert.equal(dv.getUint32(eocdPos, true), 0x06054b50, "EOCD signature");
  const count = dv.getUint16(eocdPos + 10, true);
  let pos = dv.getUint32(eocdPos + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(pos, true), 0x02014b50, "central header signature");
    const crc = dv.getUint32(pos + 16, true);
    const size = dv.getUint32(pos + 20, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const cmtLen = dv.getUint16(pos + 32, true);
    const lho = dv.getUint32(pos + 42, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    assert.equal(dv.getUint32(lho, true), 0x04034b50, "local header signature");
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + size);
    assert.equal(testCrc32(data), crc, `crc for ${name}`);
    out.set(name, dec.decode(data));
    pos += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function mkSheet(name, defs, extra = {}) {
  const cells = new Map();
  for (const [ref, cell] of Object.entries(defs)) {
    const rc = parseCellRef(ref);
    cells.set(rc.row + "," + rc.col, { value: null, formula: null, type: null, format: {}, computed: null, err: null, ...cell });
  }
  return { id: name, name, position: 0, rowCount: 50, colCount: 8, frozenRows: 0, frozenCols: 0, colWidths: {}, rowHeights: {}, hiddenRows: new Set(), hiddenCols: new Set(), meta: {}, cells, ...extra };
}

const shA = mkSheet("Ops?", {
  A1: { value: "Route", type: "text", format: { bold: true, bg: "header" } },
  B1: { value: "Cost", type: "text", format: { bold: true, bg: "header" } },
  A2: { value: "R & D <east>", type: "text" },
  B2: { value: "18", type: "number" },
  C2: { formula: "=B2*2", type: "formula", computed: 36 },
  D2: { value: "$1,250.50", type: "currency" },
  E2: { value: "12%", type: "percent" },
  F2: { value: "2026-07-05", type: "date" },
  G2: { value: "note", type: "text", format: { bg: "#ABCDEF", fg: "#112233", align: "center", wrap: true } },
  A3: { value: "styled", type: "text", format: { strike: true, fs: 18, ff: "courier", valign: "top", rot: 45 } },
  B3: { value: "site", type: "text", format: { link: "https://example.com/x?a=1&b=2" } },
  C3: { value: "boxed", type: "text", format: { border: "all" } },
  D3: { value: "underlined", type: "text", format: { border: "bottom" } },
  E3: { value: "heavy", type: "text", format: { border: "all", bw: 3 } },
}, { frozenRows: 1, colWidths: { 0: 140 }, meta: { merges: [{ r0: 4, c0: 0, r1: 5, c1: 2 }] } });
const shB = mkSheet("Ops?", { A1: { value: "x", type: "text" } });

const xbytes = __engine.buildXlsxBytes([shA, shB]);
let parts;
ok("xlsx: zip parses and CRCs check out", () => {
  assert.equal(xbytes[0], 0x50);
  assert.equal(xbytes[1], 0x4b);
  parts = readStoredZip(xbytes);
});
ok("xlsx: all package parts present", () => {
  for (const p of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
    assert.ok(parts.has(p), `missing ${p}`);
  }
});
ok("xlsx: sheet names sanitized and unique", () => {
  const wb = parts.get("xl/workbook.xml");
  assert.ok(wb.includes('name="Ops"'), "first sheet name");
  assert.ok(wb.includes('name="Ops 2"'), "deduped second sheet name");
});
ok("xlsx: formulas, date serials, numeric types, escaping, freeze, widths", () => {
  const s1 = parts.get("xl/worksheets/sheet1.xml");
  assert.ok(s1.includes("<f>B2*2</f>"), "live formula");
  assert.ok(s1.includes("<v>36</v>"), "cached formula value");
  assert.ok(s1.includes("<v>46208</v>"), "date exported as a real Excel serial");
  assert.ok(s1.includes("<v>1250.5</v>"), "currency exported as a number");
  assert.ok(s1.includes("<v>0.12</v>"), "percent exported as a fraction");
  assert.ok(s1.includes("R &amp; D &lt;east&gt;"), "XML escaping");
  assert.ok(s1.includes('state="frozen"'), "frozen header row");
  assert.ok(s1.includes('customWidth="1"'), "column width");
});
ok("xlsx: styles carry number formats and custom hex colors", () => {
  const st = parts.get("xl/styles.xml");
  assert.ok(st.includes('numFmtId="164"'), "currency format");
  assert.ok(st.includes('rgb="FFABCDEF"'), "custom fill hex");
  assert.ok(st.includes('rgb="FF112233"'), "custom text hex");
  assert.ok(st.includes("<b/>"), "bold font variant");
});
ok("xlsx: strike/size/family fonts + rotation/valign alignment", () => {
  const st = parts.get("xl/styles.xml");
  assert.ok(st.includes("<strike/>"), "strikethrough font");
  assert.ok(st.includes('<sz val="14"/>'), "18px → 14pt font size");
  assert.ok(st.includes('<name val="Courier New"/>'), "mono font name");
  assert.ok(st.includes('textRotation="45"'), "rotation");
  assert.ok(st.includes('vertical="top"'), "vertical align");
});
ok("xlsx: black borders exported per edge set and weight", () => {
  const st = parts.get("xl/styles.xml");
  assert.ok(st.includes('<left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom>'), "all-edges border");
  assert.ok(st.includes('<left/><right/><top/><bottom style="thin"><color rgb="FF000000"/></bottom>'), "bottom-only border");
  assert.ok(st.includes('<left style="thick">'), "thick weight (bw:3) maps to OOXML thick");
  assert.ok(/borders count="4"/.test(st), "default + 3 border variants");
  assert.ok(st.includes('applyBorder="1"'), "xf applies border");
});
ok("xlsx: merged ranges and hyperlinks with rels", () => {
  const s1 = parts.get("xl/worksheets/sheet1.xml");
  assert.ok(s1.includes('<mergeCell ref="A5:C6"/>'), "merge range");
  assert.ok(s1.includes('<hyperlink ref="B3" r:id="rlk1"/>'), "hyperlink ref");
  const rels = parts.get("xl/worksheets/_rels/sheet1.xml.rels");
  assert.ok(rels && rels.includes("https://example.com/x?a=1&amp;b=2") && rels.includes('TargetMode="External"'), "hyperlink relationship");
});

// ── drag-move planning (pure change-list math) ───────────────────────────────
{
  const mkMoveSheet = () => ({
    rowCount: 20, colCount: 10,
    cells: new Map([
      ["0,0", { value: "a", formula: null, type: "text", format: { bold: true } }],
      ["0,1", { value: 2, formula: null, type: "number", format: {} }],
      ["1,0", { value: null, formula: "=B1+1", type: null, format: {} }],
    ]),
  });
  const at = (chs, r, c) => chs.find((x) => x.r === r && x.c === c);
  ok("move: values/formats relocate, source clears, formulas move verbatim", () => {
    const chs = __engine.planMoveChanges(mkMoveSheet(), { r0: 0, c0: 0, r1: 1, c1: 1 }, 2, 3, false);
    assert.equal(at(chs, 2, 3).cell.value, "a");
    assert.equal(at(chs, 2, 3).cell.format.bold, true);
    assert.equal(at(chs, 3, 3).cell.formula, "=B1+1"); // cut keeps refs verbatim
    assert.equal(at(chs, 0, 0).cell, null); // source cleared
    assert.equal(at(chs, 1, 1).cell, null);
  });
  ok("move: overlapping destination doesn't clear reused cells", () => {
    const chs = __engine.planMoveChanges(mkMoveSheet(), { r0: 0, c0: 0, r1: 1, c1: 1 }, 1, 0, false);
    assert.equal(at(chs, 1, 0).cell.value, "a"); // dest write from snapshot
    assert.equal(at(chs, 2, 0).cell.formula, "=B1+1");
    assert.equal(at(chs, 0, 0).cell, null); // top row of source clears
    assert.equal(chs.filter((x) => x.r === 1 && x.c === 0).length, 1); // no clear for overlap
  });
  ok("copy-drag: source stays, relative refs shift", () => {
    const chs = __engine.planMoveChanges(mkMoveSheet(), { r0: 0, c0: 0, r1: 1, c1: 1 }, 2, 1, true);
    assert.equal(at(chs, 3, 1).cell.formula, "=C3+1"); // B1 shifted by (2,1)
    assert.ok(!at(chs, 0, 0), "source untouched on copy");
  });
  ok("move: out-of-bounds destination is rejected", () => {
    assert.equal(__engine.planMoveChanges(mkMoveSheet(), { r0: 0, c0: 0, r1: 1, c1: 1 }, 19, 0, false), null);
    assert.equal(__engine.planMoveChanges(mkMoveSheet(), { r0: 0, c0: 0, r1: 1, c1: 1 }, 0, -1, false), null);
    assert.deepEqual(__engine.planMoveChanges(mkMoveSheet(), { r0: 0, c0: 0, r1: 1, c1: 1 }, 0, 0, false), []);
  });
}

// ── cell images: the data-URL shape check is the injection guard ────────────
ok("cell image: valid base64 data URLs pass", () => {
  const px = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=";
  assert.ok(__engine.WB_IMG_RE.test(px), "webp accepted");
  assert.equal(__engine.cellImgSrc({ format: { img: px } }), px);
  assert.ok(__engine.WB_IMG_RE.test("data:image/png;base64,iVBORw0KGgo="), "png accepted");
});
ok("cell image: markup-capable or malformed sources are rejected", () => {
  const bad = [
    'data:image/svg+xml,<svg onload="x"></svg>',            // svg carries markup
    'data:image/png;base64,abc" onerror="alert(1)',         // attribute breakout
    "data:text/html;base64,PGI+aGk8L2I+",                   // wrong media type
    "https://example.com/x.png",                            // remote URLs never render
    "data:image/png;base64,",                               // empty payload
  ];
  for (const s of bad) {
    assert.ok(!__engine.WB_IMG_RE.test(s), `rejected: ${s.slice(0, 40)}`);
    assert.equal(__engine.cellImgSrc({ format: { img: s } }), null);
  }
  assert.equal(__engine.cellImgSrc({ format: {} }), null);
  assert.equal(__engine.cellImgSrc(null), null);
});

console.log(`✓ formula engine + xlsx: ${n} tests passed`);
