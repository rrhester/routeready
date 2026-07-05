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

// ══ Google Sheets function-list parity ═══════════════════════════════════════
// Reference values computed in Excel/Google Sheets. A `topOf` helper reads
// the top-left cell of an array result (the value the grid displays).
const topOf = (v) => (v && v.rows ? v.rows[0][0] : v);
const evTop = (src, ctx) => topOf(ev(src, ctx));

// ── in-formula arrays, LET, LAMBDA ──
ok("array literal SUM", () => assert.equal(ev("=SUM({1,2,3;4,5,6})"), 21));
ok("array literal MDETERM", () => assert.equal(ev("=MDETERM({1,2;3,4})"), -2));
ok("array display shows top-left", () => assert.equal(evTop("=SEQUENCE(2,3)"), 1));
ok("LET binds and reuses", () => assert.equal(ev("=LET(x,5,y,10,x+y)"), 15));
ok("LET chains earlier names", () => assert.equal(ev("=LET(x,5,y,x*2,x+y)"), 15));
ok("LAMBDA immediate call", () => assert.equal(ev("=LAMBDA(a,b,a+b)(3,4)"), 7));
ok("LET-bound LAMBDA call", () => assert.equal(ev("=LET(sq,LAMBDA(x,x*x),sq(5))"), 25));
ok("MAP over a range", () => assert.equal(evTop("=MAP(A1:A3,LAMBDA(x,x*2))", sheetCtx({ A1: 1, A2: 2, A3: 3 })), 2));
ok("REDUCE folds", () => assert.equal(ev("=REDUCE(0,A1:A3,LAMBDA(a,x,a+x))", sheetCtx({ A1: 1, A2: 2, A3: 3 })), 6));
ok("SCAN running total", () => { const a = ev("=SCAN(0,A1:A3,LAMBDA(a,x,a+x))", sheetCtx({ A1: 1, A2: 2, A3: 3 })); assert.deepEqual(a.rows, [[1], [3], [6]]); });
ok("BYROW sums each row", () => { const a = ev("=BYROW(A1:B2,LAMBDA(r,SUM(r)))", sheetCtx({ A1: 1, B1: 2, A2: 3, B2: 4 })); assert.deepEqual(a.rows, [[3], [7]]); });
ok("MAKEARRAY builds a grid", () => { const a = ev("=MAKEARRAY(2,2,LAMBDA(r,c,r*c))"); assert.deepEqual(a.rows, [[1, 2], [2, 4]]); });
ok("LAMBDA arity mismatch is #VALUE", () => assert.equal(evErr("=LAMBDA(a,b,a+b)(1)"), "#VALUE"));

// ── math ──
ok("SINH/COSH/TANH", () => { near(ev("=SINH(1)"), Math.sinh(1)); near(ev("=COSH(1)"), Math.cosh(1)); near(ev("=TANH(1)"), Math.tanh(1)); });
ok("SEC/CSC/COT", () => { near(ev("=SEC(0)"), 1); near(ev("=CSC(1.5707963267948966)"), 1); near(ev("=COT(0.7853981633974483)"), 1, 1e-9); });
ok("ACOSH/ASINH/ATANH", () => { near(ev("=ACOSH(1)"), 0); near(ev("=ASINH(0)"), 0); near(ev("=ATANH(0.5)"), Math.atanh(0.5)); });
ok("CEILING.MATH negative mode", () => { assert.equal(ev("=CEILING.MATH(-5.5,2,1)"), -6); assert.equal(ev("=CEILING.MATH(-5.5,2)"), -4); });
ok("FLOOR.MATH negative mode", () => { assert.equal(ev("=FLOOR.MATH(-5.5,2,1)"), -4); assert.equal(ev("=FLOOR.MATH(-5.5,2)"), -6); });
ok("BASE/DECIMAL round-trip", () => { assert.equal(ev("=BASE(255,16)"), "FF"); assert.equal(ev("=DECIMAL(\"FF\",16)"), 255); assert.equal(ev("=BASE(5,2,8)"), "00000101"); });
ok("COMBINA/FACTDOUBLE/MULTINOMIAL", () => { assert.equal(ev("=COMBINA(4,3)"), 20); assert.equal(ev("=FACTDOUBLE(7)"), 105); assert.equal(ev("=MULTINOMIAL(2,3,4)"), 1260); });
ok("GAMMA/GAMMALN", () => { near(ev("=GAMMA(5)"), 24, 1e-6); near(ev("=GAMMALN(5)"), Math.log(24), 1e-9); });
ok("SERIESSUM (e^1 partial)", () => near(ev("=SERIESSUM(1,0,1,A1:A4)", sheetCtx({ A1: 1, A2: 1, A3: 0.5, A4: 1 / 6 })), 1 + 1 + 0.5 + 1 / 6));
ok("SUBTOTAL sum/avg", () => { assert.equal(ev("=SUBTOTAL(9,A1:A3)", sheetCtx({ A1: 1, A2: 2, A3: 3 })), 6); assert.equal(ev("=SUBTOTAL(1,A1:A3)", sheetCtx({ A1: 1, A2: 2, A3: 3 })), 2); });

// ── statistical distributions ──
ok("NORM.DIST cdf", () => near(ev("=NORM.DIST(1,0,1,TRUE)"), 0.8413447460685429, 1e-9));
ok("NORM.S.INV", () => near(ev("=NORM.S.INV(0.975)"), 1.959963984540054, 1e-6));
ok("NORM.INV round-trips NORM.DIST", () => near(ev("=NORM.INV(NORM.DIST(3,2,4,TRUE),2,4)"), 3, 1e-6));
ok("T.DIST / T.INV.2T", () => { near(ev("=T.DIST(2,10,TRUE)"), 0.9633059826146299, 1e-7); near(ev("=T.INV.2T(0.05,10)"), 2.2281388519649385, 1e-5); });
ok("CHISQ.DIST / CHISQ.INV.RT", () => { near(ev("=CHISQ.DIST(3,4,TRUE)"), 0.4421745996289254, 1e-7); near(ev("=CHISQ.INV.RT(0.05,10)"), 18.307038053275146, 1e-4); });
ok("F.DIST.RT / F.INV.RT", () => { near(ev("=F.DIST.RT(2,5,10)"), 0.16419495089974, 1e-7); near(ev("=F.INV.RT(0.16419495089974,5,10)"), 2, 1e-4); });
ok("BINOM.DIST pmf/cdf", () => { near(ev("=BINOM.DIST(3,10,0.5,FALSE)"), 0.1171875, 1e-9); near(ev("=BINOM.DIST(3,10,0.5,TRUE)"), 0.171875, 1e-9); });
ok("BINOM.INV", () => assert.equal(ev("=BINOM.INV(10,0.5,0.5)"), 5));
ok("POISSON.DIST", () => { near(ev("=POISSON.DIST(3,2,FALSE)"), 0.18044704431548356, 1e-9); near(ev("=POISSON.DIST(3,2,TRUE)"), 0.857123460498547, 1e-9); });
ok("HYPGEOM.DIST", () => near(ev("=HYPGEOM.DIST(1,4,8,20,FALSE)"), 0.3632610939112487, 1e-9));
ok("NEGBINOM.DIST", () => near(ev("=NEGBINOM.DIST(10,5,0.25,FALSE)"), 0.05504866037517786, 1e-6));
ok("EXPON.DIST", () => near(ev("=EXPON.DIST(1,2,TRUE)"), 1 - Math.exp(-2), 1e-9));
ok("WEIBULL.DIST", () => near(ev("=WEIBULL.DIST(105,20,100,TRUE)"), 0.9295813900692769, 1e-7));
ok("GAMMA.DIST / GAMMA.INV", () => { near(ev("=GAMMA.DIST(2,3,2,TRUE)"), 0.08030139707139418, 1e-7); near(ev("=GAMMA.INV(0.08030139707139418,3,2)"), 2, 1e-4); });
ok("BETA.DIST / BETA.INV", () => { near(ev("=BETA.DIST(0.5,2,3,TRUE)"), 0.6875, 1e-7); near(ev("=BETA.INV(0.6875,2,3)"), 0.5, 1e-5); });
ok("LOGNORM.DIST", () => near(ev("=LOGNORM.DIST(4,1,1,TRUE)"), 0.65036, 1e-4)); // Φ((ln4−1)/1)
ok("CONFIDENCE.NORM", () => near(ev("=CONFIDENCE.NORM(0.05,2.5,50)"), 0.6929519121748391, 1e-6));
ok("legacy aliases match new", () => { near(ev("=NORMSDIST(1)"), ev("=NORM.S.DIST(1,TRUE)")); near(ev("=POISSON(3,2,TRUE)"), ev("=POISSON.DIST(3,2,TRUE)")); });

// ── statistical: descriptive + regression ──
ok("AVEDEV/DEVSQ", () => { assert.equal(ev("=AVEDEV(A1:A4)", sheetCtx({ A1: 2, A2: 4, A3: 6, A4: 8 })), 2); assert.equal(ev("=DEVSQ(A1:A3)", sheetCtx({ A1: 1, A2: 2, A3: 3 })), 2); });
ok("SKEW/KURT", () => { near(ev("=SKEW(A1:A5)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 10 })), 1.697056274847714, 1e-9); near(ev("=KURT(A1:A5)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 10 })), 3.152, 1e-3); });
ok("TRIMMEAN", () => assert.equal(ev("=TRIMMEAN(A1:A6,0.4)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, A6: 100 })), 3.5));
const regr = sheetCtx({ A1: 1, A2: 2, A3: 3, B1: 2, B2: 4, B3: 6 });
ok("CORREL/RSQ/SLOPE/INTERCEPT", () => { near(ev("=CORREL(A1:A3,B1:B3)", regr), 1); near(ev("=RSQ(B1:B3,A1:A3)", regr), 1); near(ev("=SLOPE(B1:B3,A1:A3)", regr), 2); near(ev("=INTERCEPT(B1:B3,A1:A3)", regr), 0); });
ok("FORECAST/TREND", () => { near(ev("=FORECAST(4,B1:B3,A1:A3)", regr), 8); near(evTop("=TREND(B1:B3,A1:A3,A1:A1)", regr), 2); });
ok("COVARIANCE.P/S", () => { near(ev("=COVARIANCE.P(A1:A3,B1:B3)", regr), 4 / 3, 1e-9); near(ev("=COVARIANCE.S(A1:A3,B1:B3)", regr), 2); });
ok("PERCENTRANK", () => { assert.equal(ev("=PERCENTRANK(A1:A5,3)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 })), 0.5); assert.equal(ev("=PERCENTRANK.EXC(A1:A5,3)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 })), 0.5); });
ok("RANK.AVG ties", () => assert.equal(ev("=RANK.AVG(2,A1:A4)", sheetCtx({ A1: 1, A2: 2, A3: 2, A4: 3 })), 2.5));
ok("PERMUT/STANDARDIZE", () => { assert.equal(ev("=PERMUT(5,2)"), 20); assert.equal(ev("=STANDARDIZE(42,40,1.5)"), (42 - 40) / 1.5); });
ok("T.TEST equal-variance", () => near(ev("=T.TEST(A1:A3,B1:B3,2,2)", sheetCtx({ A1: 3, A2: 4, A3: 5, B1: 1, B2: 2, B3: 3 })), 0.07048399691022023, 1e-9));
ok("T.TEST paired", () => near(ev("=T.TEST(A1:A3,B1:B3,1,1)", sheetCtx({ A1: 5, A2: 6, A3: 7, B1: 1, B2: 3, B3: 2 })), 0.010102051443364402, 1e-9));
ok("MODE.MULT returns all", () => { const a = ev("=MODE.MULT(A1:A5)", sheetCtx({ A1: 1, A2: 1, A3: 2, A4: 2, A5: 3 })); assert.deepEqual(a.rows, [[1], [2]]); });

// ── engineering ──
ok("base conversions", () => { assert.equal(ev("=DEC2BIN(10)"), "1010"); assert.equal(ev("=DEC2HEX(255)"), "FF"); assert.equal(ev("=HEX2DEC(\"FF\")"), 255); assert.equal(ev("=BIN2DEC(1111111111)"), -1); assert.equal(ev("=OCT2DEC(17)"), 15); });
ok("bitwise", () => { assert.equal(ev("=BITAND(12,10)"), 8); assert.equal(ev("=BITOR(12,10)"), 14); assert.equal(ev("=BITXOR(12,10)"), 6); assert.equal(ev("=BITLSHIFT(4,2)"), 16); assert.equal(ev("=BITRSHIFT(16,2)"), 4); });
ok("DELTA/GESTEP", () => { assert.equal(ev("=DELTA(5,5)"), 1); assert.equal(ev("=DELTA(5,4)"), 0); assert.equal(ev("=GESTEP(5,4)"), 1); });
ok("ERF/ERFC", () => { near(ev("=ERF(1)"), 0.8427007929497149, 1e-9); near(ev("=ERFC(1)"), 0.15729920705028513, 1e-9); near(ev("=ERF(0,1)"), 0.8427007929497149, 1e-9); });
ok("COMPLEX build + parts", () => { assert.equal(ev("=COMPLEX(3,4)"), "3+4i"); assert.equal(ev("=COMPLEX(0,1)"), "i"); assert.equal(ev("=IMREAL(\"3+4i\")"), 3); assert.equal(ev("=IMAGINARY(\"3+4i\")"), 4); assert.equal(ev("=IMABS(\"3+4i\")"), 5); });
ok("complex arithmetic", () => { assert.equal(ev("=IMSUM(\"3+4i\",\"1+2i\")"), "4+6i"); assert.equal(ev("=IMPRODUCT(\"3+4i\",\"1+2i\")"), "-5+10i"); assert.equal(ev("=IMCONJUGATE(\"3+4i\")"), "3-4i"); assert.equal(ev("=IMSUB(\"5+3i\",\"2+i\")"), "3+2i"); });
ok("complex transcendental", () => { const e = ev("=IMEXP(\"0+0i\")"); assert.equal(e, "1"); near(topOf(ev("=IMABS(IMSQRT(\"-1\"))")), 1); });

// ── financial ──
ok("RATE solves PMT", () => near(ev("=RATE(60,-193.328,10000)"), 0.005, 1e-4));
ok("IPMT/PPMT split the payment", () => { near(ev("=IPMT(0.005,1,60,10000)"), -50, 1e-9); near(ev("=IPMT(0.005,1,60,10000)") + ev("=PPMT(0.005,1,60,10000)"), ev("=PMT(0.005,60,10000)"), 1e-9); });
ok("CUMIPMT/CUMPRINC", () => { near(ev("=CUMIPMT(0.09/12,360,125000,13,24,0)"), -11135.23, 0.01); near(ev("=CUMPRINC(0.09/12,360,125000,13,24,0)"), -934.1071, 0.01); });
ok("depreciation SYD/DB/DDB/VDB", () => { assert.equal(ev("=SYD(10000,1000,5,1)"), 3000); near(ev("=DB(1000000,100000,6,1)"), 319000, 1); near(ev("=DDB(2400,300,10,1)"), 480, 1e-9); near(ev("=VDB(2400,300,10,0,1)"), 480, 1e-9); });
ok("DOLLARDE/DOLLARFR", () => { assert.equal(ev("=DOLLARDE(1.02,16)"), 1.125); near(ev("=DOLLARFR(1.125,16)"), 1.02, 1e-9); });
ok("MIRR/XNPV/XIRR", () => {
  near(ev("=MIRR(A1:A5,0.1,0.12)", sheetCtx({ A1: -1000, A2: 300, A3: 400, A4: 400, A5: 300 })), 0.11022609322549504, 1e-6);
  const xc = sheetCtx({ A1: -10000, A2: 5000, A3: 6000, B1: "2020-01-01", B2: "2020-06-01", B3: "2020-12-01" });
  near(ev("=XNPV(0.09,A1:A3,B1:B3)", xc), 367.4582501758714, 1e-4);
  near(ev("=XIRR(A1:A3,B1:B3)", xc), 0.14915029, 1e-5);
});
ok("FVSCHEDULE/PDURATION/RRI", () => { near(ev("=FVSCHEDULE(1000,A1:A3)", sheetCtx({ A1: 0.09, A2: 0.11, A3: 0.1 })), 1330.89, 1e-2); near(ev("=PDURATION(0.025,2000,2200)"), 3.859866162622655, 1e-9); near(ev("=RRI(96,10000,11000)"), 0.0009933073762913, 1e-9); });
ok("bond PRICE/YIELD round-trip", () => {
  const price = ev('=PRICE("2008-02-15","2017-11-15",0.0575,0.065,100,2,0)');
  near(price, 94.63436162132, 1e-4);
  near(ev(`=YIELD("2008-02-15","2017-11-15",0.0575,${price},100,2,0)`), 0.065, 1e-5);
});
ok("coupon schedule", () => { assert.equal(ev('=COUPNUM("2007-01-25","2008-11-15",2,1)'), 4); assert.equal(ev('=COUPDAYBS("2007-01-25","2008-11-15",2,1)'), 71); assert.equal(ev('=COUPDAYS("2007-01-25","2008-11-15",2,1)'), 181); assert.equal(ev('=COUPNCD("2007-01-25","2008-11-15",2,1)'), "2007-05-15"); });
ok("DURATION/MDURATION", () => { near(ev('=DURATION("2008-01-01","2016-01-01",0.08,0.09,2,1)'), 5.993774955545, 1e-4); near(ev('=MDURATION("2008-01-01","2016-01-01",0.08,0.09,2,1)'), 5.735669813919, 1e-4); });
ok("T-bill + discount securities", () => { near(ev('=TBILLYIELD("2008-03-31","2008-06-01",98.45)'), 0.09141696, 1e-6); near(ev('=DISC("2018-01-25","2018-06-15",97.975,100,1)'), 0.05242021, 1e-6); near(ev('=ACCRINTM("2008-04-01","2008-06-15",0.1,1000,3)'), 20.5479452, 1e-4); });

// ── text ──
ok("ROMAN/ARABIC round-trip", () => { assert.equal(ev("=ROMAN(1994)"), "MCMXCIV"); assert.equal(ev("=ARABIC(\"MCMXCIV\")"), 1994); assert.equal(ev("=ARABIC(ROMAN(2024))"), 2024); });
ok("REGEXMATCH/EXTRACT/REPLACE", () => { assert.equal(ev("=REGEXMATCH(\"abc123\",\"[0-9]+\")"), true); assert.equal(ev("=REGEXEXTRACT(\"abc123\",\"[0-9]+\")"), "123"); assert.equal(ev("=REGEXREPLACE(\"abc123\",\"[0-9]\",\"X\")"), "abcXXX"); });
ok("REGEXEXTRACT capture groups", () => { const a = ev("=REGEXEXTRACT(\"2026-07-05\",\"(\\d+)-(\\d+)-(\\d+)\")"); assert.deepEqual(a.rows, [["2026", "07", "05"]]); });
ok("byte-width text", () => { assert.equal(ev("=LENB(\"café\")"), 4); assert.equal(ev("=LENB(\"中文\")"), 4); assert.equal(ev("=LEFTB(\"中A\",2)"), "中"); });
ok("UNICHAR/UNICODE/ASC", () => { assert.equal(ev("=UNICHAR(65)"), "A"); assert.equal(ev("=UNICODE(\"A\")"), 65); assert.equal(ev("=ASC(\"ＡＢ\")"), "AB"); });

// ── date/time ──
ok("TIME fraction", () => near(ev("=TIME(14,30,0)"), 0.6041666666666666, 1e-12));
ok("TIME wraps + overflows", () => { near(ev("=TIME(25,0,0)"), 1 / 24, 1e-12); near(ev("=TIME(0,90,0)"), 90 / 1440, 1e-12); });
ok("WEEKDAY types", () => { assert.equal(ev("=WEEKDAY(\"2026-07-05\",1)"), 1); assert.equal(ev("=WEEKDAY(\"2026-07-05\",2)"), 7); assert.equal(ev("=WEEKDAY(\"2026-07-05\",3)"), 6); });
ok("NETWORKDAYS.INTL custom weekend", () => assert.equal(ev("=NETWORKDAYS.INTL(\"2026-07-01\",\"2026-07-07\",1)"), 5));
ok("WORKDAY.INTL", () => assert.equal(ev("=WORKDAY.INTL(\"2026-07-03\",1,1)"), "2026-07-06"));
ok("EPOCHTODATE", () => assert.equal(ev("=EPOCHTODATE(1500000000)").slice(0, 10), "2017-07-14"));

// ── lookup / dynamic references ──
const lu = sheetCtx({ A1: 1, A2: 5, A3: 10, B1: "a", B2: "b", B3: "c" });
ok("XMATCH modes", () => { assert.equal(ev("=XMATCH(5,A1:A3)", lu), 2); assert.equal(ev("=XMATCH(7,A1:A3,-1)", lu), 2); assert.equal(ev("=XMATCH(7,A1:A3,1)", lu), 3); });
ok("INDIRECT A1 + range", () => { assert.equal(ev("=INDIRECT(\"A2\")", lu), 5); assert.equal(topOf(ev("=INDIRECT(\"A1:A3\")", lu)), 1); });
ok("INDIRECT R1C1", () => assert.equal(ev("=INDIRECT(\"R2C1\",FALSE)", lu), 5));
ok("OFFSET single + block", () => { assert.equal(ev("=OFFSET(A1,1,0)", lu), 5); assert.equal(topOf(ev("=OFFSET(A1,1,0,2,1)", lu)), 5); });
ok("OFFSET out of range is #REF", () => assert.equal(evErr("=OFFSET(A1,-1,0)", lu), "#REF"));

// ── array / filter functions ──
const grid = sheetCtx({ A1: 1, B1: 2, A2: 3, B2: 4 });
ok("FILTER keeps rows", () => { const a = ev("=FILTER(A1:A5,B1:B5)", sheetCtx({ A1: 10, A2: 20, A3: 30, A4: 40, A5: 50, B1: true, B2: false, B3: true, B4: false, B5: true })); assert.deepEqual(a.rows, [[10], [30], [50]]); });
ok("FILTER no match is #N/A", () => assert.equal(evErr("=FILTER(A1:A2,B1:B2)", sheetCtx({ A1: 1, A2: 2, B1: false, B2: false })), "#N/A"));
ok("SORT ascending/descending", () => { assert.deepEqual(ev("=SORT(A1:A3)", sheetCtx({ A1: 3, A2: 1, A3: 2 })).rows, [[1], [2], [3]]); assert.deepEqual(ev("=SORT(A1:A3,1,FALSE)", sheetCtx({ A1: 3, A2: 1, A3: 2 })).rows, [[3], [2], [1]]); });
ok("SORTN top-2", () => assert.deepEqual(ev("=SORTN(A1:A5,2,0,1,FALSE)", sheetCtx({ A1: 5, A2: 3, A3: 1, A4: 4, A5: 2 })).rows, [[5], [4]]));
ok("UNIQUE dedupes", () => assert.deepEqual(ev("=UNIQUE(A1:A4)", sheetCtx({ A1: 1, A2: 1, A3: 2, A4: 3 })).rows, [[1], [2], [3]]));
ok("UNIQUE exactly-once", () => assert.deepEqual(ev("=UNIQUE(A1:A4,FALSE,TRUE)", sheetCtx({ A1: 1, A2: 1, A3: 2, A4: 3 })).rows, [[2], [3]]));
ok("SPLIT text", () => assert.deepEqual(ev("=SPLIT(\"a,b,c\",\",\")").rows, [["a", "b", "c"]]));
ok("TRANSPOSE", () => assert.deepEqual(ev("=TRANSPOSE(A1:B2)", grid).rows, [[1, 3], [2, 4]]));
ok("FLATTEN", () => assert.deepEqual(ev("=FLATTEN(A1:B2)", grid).rows, [[1], [2], [3], [4]]));
ok("HSTACK/VSTACK", () => { assert.deepEqual(ev("=HSTACK(A1:A2,B1:B2)", grid).rows, [[1, 2], [3, 4]]); assert.deepEqual(ev("=VSTACK(A1:B1,A2:B2)", grid).rows, [[1, 2], [3, 4]]); });
ok("CHOOSECOLS/CHOOSEROWS", () => { assert.deepEqual(ev("=CHOOSECOLS(A1:B2,2,1)", grid).rows, [[2, 1], [4, 3]]); assert.deepEqual(ev("=CHOOSEROWS(A1:B2,-1)", grid).rows, [[3, 4]]); });
ok("WRAPROWS", () => assert.deepEqual(ev("=WRAPROWS(A1:D1,2)", sheetCtx({ A1: 1, B1: 2, C1: 3, D1: 4 })).rows, [[1, 2], [3, 4]]));
ok("SEQUENCE grid", () => assert.deepEqual(ev("=SEQUENCE(2,2,1,1)").rows, [[1, 2], [3, 4]]));
ok("FREQUENCY buckets", () => assert.deepEqual(ev("=FREQUENCY(A1:A5,B1:B2)", sheetCtx({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, B1: 2, B2: 4 })).rows, [[2], [2], [1]]));
ok("MMULT product", () => assert.deepEqual(ev("=MMULT(A1:B2,D1:E2)", sheetCtx({ A1: 1, B1: 2, A2: 3, B2: 4, D1: 5, E1: 6, D2: 7, E2: 8 })).rows, [[19, 22], [43, 50]]));
ok("MINVERSE", () => { const a = ev("=MINVERSE(A1:B2)", sheetCtx({ A1: 4, B1: 7, A2: 2, B2: 6 })); near(a.rows[0][0], 0.6); near(a.rows[1][1], 0.4); });
ok("MUNIT identity", () => assert.deepEqual(ev("=MUNIT(2)").rows, [[1, 0], [0, 1]]));
ok("SUMX2MY2/SUMXMY2", () => { assert.equal(ev("=SUMX2MY2(A1:A2,B1:B2)", sheetCtx({ A1: 3, A2: 4, B1: 1, B2: 2 })), (9 - 1) + (16 - 4)); assert.equal(ev("=SUMXMY2(A1:A2,B1:B2)", sheetCtx({ A1: 3, A2: 4, B1: 1, B2: 2 })), 4 + 4); });

// ── database ──
const dbCtx = sheetCtx({ A1: "id", B1: "amt", C1: "team", A2: 1, B2: 10, C2: "x", A3: 2, B3: 20, C3: "y", A4: 3, B4: 30, C4: "x", E1: "team", E2: "x" });
ok("DSUM/DAVERAGE/DCOUNT", () => { assert.equal(ev("=DSUM(A1:C4,\"amt\",E1:E2)", dbCtx), 40); assert.equal(ev("=DAVERAGE(A1:C4,\"amt\",E1:E2)", dbCtx), 20); assert.equal(ev("=DCOUNT(A1:C4,\"amt\",E1:E2)", dbCtx), 2); });
ok("DGET one match", () => { assert.equal(ev("=DGET(A1:C4,\"amt\",E1:E2)", sheetCtx({ A1: "id", B1: "amt", C1: "team", A2: 1, B2: 10, C2: "x", A3: 2, B3: 20, C3: "y", A4: 3, B4: 30, C4: "x", E1: "id", E2: 2 })), 20); });
ok("DGET multi match is #NUM", () => assert.equal(evErr("=DGET(A1:C4,\"amt\",E1:E2)", dbCtx), "#NUM"));
ok("DMAX by field index", () => assert.equal(ev("=DMAX(A1:C4,2,E1:E2)", dbCtx), 30));

// ── parser: CONVERT + TO_* ──
ok("CONVERT mass/distance/time", () => { near(ev("=CONVERT(1,\"lbm\",\"kg\")"), 0.45359237, 1e-8); near(ev("=CONVERT(1,\"mi\",\"km\")"), 1.609344, 1e-9); assert.equal(ev("=CONVERT(1,\"day\",\"hr\")"), 24); });
ok("CONVERT temperature", () => { near(ev("=CONVERT(100,\"C\",\"F\")"), 212, 1e-9); near(ev("=CONVERT(32,\"F\",\"C\")"), 0, 1e-9); near(ev("=CONVERT(0,\"C\",\"K\")"), 273.15, 1e-9); });
ok("CONVERT metric prefixes + binary", () => { near(ev("=CONVERT(1,\"km\",\"m\")"), 1000, 1e-9); near(ev("=CONVERT(1024,\"byte\",\"Kibyte\")"), 1, 1e-9); });
ok("CONVERT incompatible is #N/A", () => assert.equal(evErr("=CONVERT(1,\"m\",\"kg\")"), "#N/A"));
ok("TO_PERCENT/TO_DOLLARS/TO_PURE_NUMBER", () => { assert.equal(ev("=TO_PERCENT(0.25)"), "25%"); assert.equal(ev("=TO_DOLLARS(1234.5)"), "$1,234.50"); assert.equal(ev("=TO_PURE_NUMBER(\"42\")"), 42); });

// ── info / logical / operator / web ──
ok("ISEMAIL/ISURL", () => { assert.equal(ev("=ISEMAIL(\"a@b.com\")"), true); assert.equal(ev("=ISEMAIL(\"nope\")"), false); assert.equal(ev("=ISURL(\"https://x.com\")"), true); });
ok("ISBETWEEN", () => { assert.equal(ev("=ISBETWEEN(5,1,10)"), true); assert.equal(ev("=ISBETWEEN(5,1,5,TRUE,FALSE)"), false); });
ok("ERROR.TYPE/ISERR", () => { assert.equal(ev("=ERROR.TYPE(NA())"), 7); assert.equal(ev("=ERROR.TYPE(1/0)"), 2); assert.equal(ev("=ISERR(NA())"), false); assert.equal(ev("=ISERR(1/0)"), true); });
ok("TYPE", () => { assert.equal(ev("=TYPE(5)"), 1); assert.equal(ev("=TYPE(\"x\")"), 2); assert.equal(ev("=TYPE(TRUE)"), 4); });
ok("ISFORMULA/FORMULATEXT", () => { const c = { rowCount: 5, colCount: 5, getCell: () => 3, getFormula: (r, cc) => (r === 0 && cc === 0 ? "=1+2" : null) }; assert.equal(evalFormula("=ISFORMULA(A1)", c), true); assert.equal(evalFormula("=ISFORMULA(B1)", c), false); assert.equal(evalFormula("=FORMULATEXT(A1)", c), "=1+2"); });
ok("TRUE()/FALSE() callable", () => { assert.equal(ev("=TRUE()"), true); assert.equal(ev("=FALSE()"), false); assert.equal(ev("=IF(TRUE(),1,2)"), 1); });
ok("UPLUS/ENCODEURL/HYPERLINK", () => { assert.equal(ev("=UPLUS(5)"), 5); assert.equal(ev("=ENCODEURL(\"a b&c\")"), "a%20b%26c"); assert.equal(ev("=HYPERLINK(\"http://x.com\",\"X\")"), "X"); });

// ── numeric-domain errors surface as #NUM ──
ok("#NUM on bad domains", () => { assert.equal(evErr("=NORM.INV(2,0,1)"), "#NUM"); assert.equal(evErr("=GAMMALN(0)"), "#NUM"); assert.equal(evErr("=COMBINA(0,1)"), "#NUM"); assert.equal(evErr("=DEC2BIN(9999)"), "#NUM"); });

// ── full-sheet recalc: two-pass dynamic refs + array-cell chaining ───────────
// Drives the REAL recalcSheet (not single-shot evalFormula), so the
// topological pass, the INDIRECT/OFFSET second pass, and the array-result
// unwrap all get exercised together the way the grid runs them.
{
  const { recalcSheet } = __engine;
  const mkRecalcSheet = (defs) => {
    const cells = new Map();
    for (const [ref, d] of Object.entries(defs)) {
      const rc = parseCellRef(ref);
      cells.set(rc.row + "," + rc.col, { value: d.formula ? null : d.value, formula: d.formula || null, type: d.formula ? "formula" : "number", format: {}, computed: null, err: null });
    }
    return { id: "s", blockId: "b", rowCount: 50, colCount: 12, cells };
  };
  const cval = (sheet, ref) => { const rc = parseCellRef(ref); const c = sheet.cells.get(rc.row + "," + rc.col); return c ? (c.err ? c.err : c.computed) : null; };

  ok("recalc: topo chain settles in one pass", () => {
    const s = mkRecalcSheet({ A1: { value: 2 }, B1: { formula: "=A1*3" }, C1: { formula: "=B1+A1" } });
    recalcSheet(s);
    assert.equal(cval(s, "B1"), 6);
    assert.equal(cval(s, "C1"), 8);
  });
  ok("recalc: array-returning cell exposes top-left to dependents", () => {
    const s = mkRecalcSheet({ A1: { value: 3 }, A2: { value: 1 }, A3: { value: 2 }, B1: { formula: "=SORT(A1:A3)" }, C1: { formula: "=B1*10" } });
    recalcSheet(s);
    assert.equal(cval(s, "B1"), 1); // SORT's smallest value displays
    assert.equal(cval(s, "C1"), 10); // dependent reads the scalar top-left
  });
  ok("recalc: INDIRECT re-evaluates in the second pass", () => {
    // D1 picks a column by name; the cell it points at is computed by another
    // formula, so only the dynamic second pass sees the settled value.
    const s = mkRecalcSheet({ A1: { value: 5 }, B1: { formula: "=A1*4" }, C1: { value: "B1" }, D1: { formula: "=INDIRECT(C1)" } });
    recalcSheet(s);
    assert.equal(cval(s, "B1"), 20);
    assert.equal(cval(s, "D1"), 20);
  });
  ok("recalc: OFFSET tracks an upstream change through a dependent", () => {
    const s = mkRecalcSheet({ A1: { value: 1 }, A2: { value: 2 }, A3: { value: 9 }, E1: { formula: "=OFFSET(A1,2,0)" }, F1: { formula: "=E1+1" } });
    recalcSheet(s);
    assert.equal(cval(s, "E1"), 9);
    assert.equal(cval(s, "F1"), 10);
  });
  ok("recalc: LET/LAMBDA cell computes a scalar", () => {
    const s = mkRecalcSheet({ A1: { value: 4 }, B1: { formula: "=LET(x,A1,sq,LAMBDA(n,n*n),sq(x))" } });
    recalcSheet(s);
    assert.equal(cval(s, "B1"), 16);
  });
  ok("recalc: circular reference is still flagged", () => {
    const s = mkRecalcSheet({ A1: { formula: "=B1+1" }, B1: { formula: "=A1+1" } });
    recalcSheet(s);
    assert.equal(cval(s, "A1"), "#CIRCULAR");
    assert.equal(cval(s, "B1"), "#CIRCULAR");
  });
}

// ── Functions browser (toolbar fx) search + directory coverage ───────────────
{
  const { FUNCTION_META, fnSearch } = __engine;
  const names = FUNCTION_META.map((f) => f.n);
  ok("fn browser: every autocomplete entry is unique + well-formed", () => {
    assert.ok(names.length > 400, `expected the full directory, got ${names.length}`);
    assert.equal(new Set(names).size, names.length, "no duplicate names");
    for (const f of FUNCTION_META) { assert.ok(f.n && f.sig && f.d, `entry missing fields: ${JSON.stringify(f)}`); }
  });
  ok("fn browser: exact name ranks first", () => { assert.equal(fnSearch("SUM")[0].n, "SUM"); assert.equal(fnSearch("vlookup")[0].n, "VLOOKUP"); });
  ok("fn browser: prefix beats substring beats description", () => {
    const r = fnSearch("SUMI").map((f) => f.n);
    assert.ok(r.indexOf("SUMIF") >= 0 && r.indexOf("SUMIFS") >= 0);
    assert.ok(r.indexOf("SUMIF") < r.indexOf("CONCATENATE") || r.indexOf("CONCATENATE") < 0);
  });
  ok("fn browser: description text is searchable", () => {
    const r = fnSearch("standard deviation").map((f) => f.n);
    assert.ok(r.includes("STDEV") || r.includes("STDEV.S"), "matched a stdev function by its description");
  });
  ok("fn browser: dotted + underscored names are findable", () => {
    assert.ok(fnSearch("NORM.S").some((f) => f.n === "NORM.S.DIST"));
    assert.ok(fnSearch("ARRAY_").some((f) => f.n === "ARRAY_CONSTRAIN"));
  });
  ok("fn browser: no match returns empty", () => assert.equal(fnSearch("ZZZQQQ").length, 0));
  ok("fn browser: newly added functions are in the directory", () => {
    for (const n of ["FILTER", "SORT", "XLOOKUP", "LAMBDA", "LET", "CONVERT", "REGEXMATCH", "XIRR", "NORM.DIST", "IMSUM"]) {
      assert.ok(names.includes(n), `${n} missing from the functions browser`);
    }
  });
  const { fnListHtml } = __engine;
  ok("fn browser: empty query renders the Common shortlist", () => {
    const html = fnListHtml("");
    assert.ok(html.includes("Common"), "has the Common header");
    assert.ok(html.includes('data-wb-fn="SUM"'), "SUM is a clickable item");
    assert.ok(/Type to search all \d+ functions/.test(html), "footer hint");
  });
  ok("fn browser: query renders clickable, escaped items", () => {
    const html = fnListHtml("vlook");
    assert.ok(html.includes('data-wb-fn="VLOOKUP"'), "VLOOKUP item present");
    assert.ok(html.includes("wb-fn-item is-active"), "first result is preselected for Enter/arrow nav");
  });
  ok("fn browser: dotted names survive as valid attributes", () => {
    assert.ok(fnListHtml("norm.s").includes('data-wb-fn="NORM.S.DIST"'));
  });
  ok("fn browser: empty state on no match", () => assert.ok(fnListHtml("zzzqqq").includes("wb-fn-empty")));
}

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

// ── Sheet-to-Schedule helpers (pure sheet↔driver plumbing) ──────────────────
{
  ok("fill: week dates span 7 days from the start", () => {
    const w = __engine.fillWeekDates("2026-07-05"); // a Sunday
    assert.equal(w.length, 7);
    assert.equal(w[0], "2026-07-05");
    assert.equal(w[6], "2026-07-11");
  });
  ok("fill: month rollover in week dates", () => {
    const w = __engine.fillWeekDates("2026-07-29");
    assert.equal(w[6], "2026-08-04");
  });
  const mk = (cells) => {
    const m = new Map();
    for (const [k, v] of Object.entries(cells)) m.set(k, { value: v, formula: null, type: "text", format: {}, computed: null, err: null });
    return { rowCount: 50, colCount: 12, cells: m, hiddenRows: new Set(), hiddenCols: new Set(), meta: {} };
  };
  ok("fill: driver sheet detected via the Driver ID header column", () => {
    const sheet = mk({ "0,0": "Driver", "0,8": "Driver ID", "1,0": "A. Jones", "1,8": "drv-1", "2,8": " drv-2 " });
    assert.deepEqual(__engine.fillSheetInfo(sheet), { idCol: 8 });
    assert.equal(__engine.fillDriverIdAt(sheet, 1), "drv-1");
    assert.equal(__engine.fillDriverIdAt(sheet, 2), "drv-2"); // trimmed
    assert.equal(__engine.fillDriverIdAt(sheet, 0), null);     // header row is never a driver
    assert.deepEqual([...__engine.fillSheetDriverIds(sheet)].sort(), ["drv-1", "drv-2"]);
  });
  ok("fill: non-driver sheets return null", () => {
    const sheet = mk({ "0,0": "Route", "1,0": "CX-14" });
    assert.equal(__engine.fillSheetInfo(sheet), null);
    assert.equal(__engine.fillSheetDriverIds(sheet), null);
  });
}

// ── Sheet-to-Schedule ↔ engine contract ──────────────────────────────────────
// Runs the REAL scheduling engine against a payload in the exact shape
// fillGenerate assembles, so a drift in either side fails here first.
{
  const { planScheduleWeek } = await import("../dashboard/scheduling-engine.js");
  const payload = {
    schedule_week_start: "2026-07-12", // a Sunday
    max_days: 5, weekly_hour_cap: 50, time_budget_ms: 500,
    rules: { pto_block: true, availability: true, run_mode: "fill_empty_only", preserve_locked_assignments: true, manual_mode: false },
    drivers: [
      { id: "drv-a", full_name: "Ada Alvarez", status: "active", hire_date: "2023-01-05", dl_expires_on: "2030-01-01",
        dot_certified: false, xl_certified: true, edv_certified: false,
        available_dows: null, preferred_dows: [1, 2], final_corrective_action: false, weekday_affinity: null, fifth_day_ok: false },
      { id: "drv-b", full_name: "Ben Brooks", status: "active", hire_date: "2024-03-09", dl_expires_on: "2030-01-01",
        dot_certified: false, xl_certified: false, edv_certified: false,
        available_dows: null, preferred_dows: null, final_corrective_action: false, weekday_affinity: null, fifth_day_ok: false },
    ],
    shifts: [
      { id: "s1", date: "2026-07-13", starts_at: "2026-07-13T09:00:00", ends_at: "2026-07-13T19:00:00",
        duration_hours: 10, route_type: "standard", assigned_driver_id: null, is_locked: false, station_id: null, route_code: null },
      { id: "virtual:2026-07-14:0", date: "2026-07-14", starts_at: "2026-07-14T09:00:00", ends_at: "2026-07-14T19:00:00",
        duration_hours: 10, route_type: "xl", assigned_driver_id: null, is_locked: false, station_id: null, route_code: null },
    ],
    pto: [{ driver_id: "drv-b", date: "2026-07-14" }],
    ad_hoc_constraints: [],
  };
  let result;
  ok("fill↔engine: planScheduleWeek accepts the sheet-built payload", () => {
    result = planScheduleWeek(payload);
    assert.ok(result && typeof result === "object");
    assert.ok(Array.isArray(result.assigned_shifts), "assigned_shifts array");
    assert.ok(Array.isArray(result.uncovered_shifts), "uncovered_shifts array");
    assert.ok(Array.isArray(result.unscheduled_drivers), "unscheduled_drivers array");
    assert.ok(result.explanations && Array.isArray(result.explanations.assignments), "explanations.assignments");
  });
  ok("fill↔engine: XL route goes to the XL-certified driver (PTO respected)", () => {
    const xl = result.assigned_shifts.find((a) => a.shift_id === "virtual:2026-07-14:0");
    assert.ok(xl, "XL virtual route was filled");
    assert.equal(xl.driver_id, "drv-a"); // drv-b lacks XL cert AND has PTO that day
    assert.ok(result.assigned_shifts.every((a) => !(a.driver_id === "drv-b" && a.shift_id === "virtual:2026-07-14:0")));
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

// ── named ranges ─────────────────────────────────────────────────────────────
// Build a ctx that carries a names map (UPPERCASE name -> range/ref AST),
// exactly as recalcSheet does, and confirm evalFormula binds them.
const namedCtx = (cells, defs, rows = 100, cols = 26) => {
  const ctx = sheetCtx(cells, rows, cols);
  ctx.names = new Map(Object.entries(defs).map(([k, ref]) => [k.toUpperCase(), __engine.parseFormula("=" + ref)]));
  return ctx;
};
ok("named range: single cell resolves like a ref", () => {
  const ctx = namedCtx({ B2: 7 }, { Tax: "B2" });
  assert.equal(ev("=Tax*2", ctx), 14);
});
ok("named range: multi-cell aggregates", () => {
  const ctx = namedCtx({ A1: 1, A2: 2, A3: 3 }, { Nums: "A1:A3" });
  assert.equal(ev("=SUM(Nums)", ctx), 6);
  assert.equal(ev("=AVERAGE(Nums)", ctx), 2);
  assert.equal(ev("=COUNT(Nums)", ctx), 3);
});
ok("named range: works as a criteria-function range (SUMIF)", () => {
  const ctx = namedCtx({ A1: 1, A2: 8, A3: 3, B1: 10, B2: 20, B3: 30 }, { Vals: "A1:A3", Amts: "B1:B3" });
  assert.equal(ev('=SUMIF(Vals,">2",Amts)', ctx), 50);
  assert.equal(ev('=COUNTIF(Vals,">2")', ctx), 2);
});
ok("named range: usable inside VLOOKUP table", () => {
  const ctx = namedCtx({ A1: "x", B1: 100, A2: "y", B2: 200 }, { Table: "A1:B2" });
  assert.equal(ev('=VLOOKUP("y",Table,2,FALSE)', ctx), 200);
});
ok("named range: extractRefs expands the name to its cells", () => {
  const names = new Map([["NUMS", __engine.parseFormula("=A1:A3")]]);
  const refs = __engine.extractRefs("=SUM(Nums)+1", { rowCount: 100, colCount: 26 }, names);
  const keys = refs.map((r) => (r.row ?? r.r) + "," + (r.col ?? r.c)).sort();
  assert.deepEqual(keys, ["0,0", "1,0", "2,0"]);
});
ok("named range: LET binding shadows a same-named range", () => {
  const ctx = namedCtx({ B2: 7 }, { X: "B2" });
  assert.equal(ev("=LET(x, 5, x*2)", ctx), 10); // local x wins over range X
});
ok("named range: unknown name still errors #NAME", () => {
  assert.equal(evErr("=Bogus+1", sheetCtx({})), "#NAME");
});
ok("isValidRangeName rejects refs, columns, and functions", () => {
  assert.equal(__engine.isValidRangeName("Drivers"), true);
  assert.equal(__engine.isValidRangeName("tax_rate"), true);
  assert.equal(__engine.isValidRangeName("A1"), false);
  assert.equal(__engine.isValidRangeName("AB"), false);
  assert.equal(__engine.isValidRangeName("SUM"), false);
  assert.equal(__engine.isValidRangeName("has space"), false);
  assert.equal(__engine.isValidRangeName("1thing"), false);
});

// ── conditional formatting color scale ───────────────────────────────────────
ok("color scale: endpoints and midpoint interpolate", () => {
  const stops = ["#57BB8A", "#FFD666", "#E67C73"]; // green → yellow → red
  assert.equal(__engine.cfScaleColor(stops, 0), "rgb(87,187,138)");
  assert.equal(__engine.cfScaleColor(stops, 1), "rgb(230,124,115)");
  assert.equal(__engine.cfScaleColor(stops, 0.5), "rgb(255,214,102)"); // exact middle stop
});
ok("color scale: two-stop blends halfway", () => {
  assert.equal(__engine.cfScaleColor(["#000000", "#FFFFFF"], 0.5), "rgb(128,128,128)");
});
ok("color scale: clamps out-of-range t", () => {
  assert.equal(__engine.cfScaleColor(["#000000", "#FFFFFF"], 5), "rgb(255,255,255)");
  assert.equal(__engine.cfScaleColor(["#000000", "#FFFFFF"], -1), "rgb(0,0,0)");
});

// ── paste special ────────────────────────────────────────────────────────────
const { buildPasteCell, pasteValueParts } = __engine;
const fcell = { value: "10", formula: "=A1*2", type: "number", computed: 20, err: null, format: { bold: true } };
const vcell = { value: "hi", formula: null, type: "text", computed: null, err: null, format: { num: "currency" } };
ok("paste values: a formula contributes its computed result, no formula/format-from-source", () => {
  const out = buildPasteCell(fcell, null, { values: true }, 5, 0, "copy");
  assert.equal(out.value, "20");
  assert.equal(out.formula, null);
  assert.equal(out.type, "number");
});
ok("paste values: keeps the target's own format", () => {
  const target = { value: "", formula: null, type: null, computed: null, err: null, format: { num: "percent" } };
  const out = buildPasteCell(vcell, target, { values: true }, 0, 0, "copy");
  assert.equal(out.value, "hi");
  assert.deepEqual(out.format, { num: "percent" }); // target format preserved, not source
});
ok("paste formats: stamps source format, leaves target value", () => {
  const target = { value: "keep", formula: null, type: "text", computed: null, err: null, format: {} };
  const out = buildPasteCell(fcell, target, { formats: true }, 0, 0, "copy");
  assert.equal(out.value, "keep");
  assert.equal(out.formula, null);
  assert.deepEqual(out.format, { bold: true });
});
ok("paste formulas: adjusts refs and drops formatting", () => {
  const out = buildPasteCell(fcell, null, { formulas: true }, 3, 0, "copy"); // 3 rows down
  assert.equal(out.formula, "=A4*2");
  assert.deepEqual(out.format, {});
});
ok("paste (full copy) adjusts refs and keeps format", () => {
  const out = buildPasteCell(fcell, null, {}, 3, 1, "copy"); // 3 down, 1 right
  assert.equal(out.formula, "=B4*2");
  assert.deepEqual(out.format, { bold: true });
});
ok("paste values of an empty source onto an empty target is a no-op cell", () => {
  assert.equal(buildPasteCell(null, null, { values: true }, 0, 0, "copy"), null);
});
ok("pasteValueParts reads value cells and formula results", () => {
  assert.deepEqual(pasteValueParts(vcell), { value: "hi", type: "text" });
  assert.deepEqual(pasteValueParts(fcell), { value: "20", type: "number" });
  assert.deepEqual(pasteValueParts(null), { value: "", type: null });
});

console.log(`✓ formula engine + xlsx: ${n} tests passed`);
