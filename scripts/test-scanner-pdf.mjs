#!/usr/bin/env node
// Regression tests for the driver document-scanner PDF writer.
//   node scripts/test-scanner-pdf.mjs
//
// The scanner turns phone photos into a PDF entirely on-device with a
// hand-written, dependency-free PDF writer (embeds each page's JPEG via
// /DCTDecode). app/app.js is the PWA entry module — it isn't importable
// in Node — so we extract the pure _scanBuildPdfBlob function from source
// and exercise it against synthetic pages, asserting the container is
// byte-correct: object numbering, xref offsets, trailer, page tree, and
// exact JPEG-stream embedding. A regression here means real drivers get
// a corrupt PDF, which no lenient viewer would necessarily reveal — so we
// parse the bytes ourselves rather than trusting a renderer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "app", "app.js"), "utf8");

// Extract the pure builder: from its declaration to the next top-level
// function. If the surrounding code is reshaped so this slice no longer
// evaluates, the test fails loudly — which is the intended signal.
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name} in app/app.js`);
  const after = src.slice(start + name.length + 10);
  const m = after.search(/\n(?:async )?function /);
  assert.ok(m >= 0, `could not find end of ${name}`);
  return src.slice(start, start + name.length + 10 + m);
}
// The builder closes over the module-level _SCAN_PAGE_SIZES registry;
// pull it in from source so the extracted function resolves it and we
// test the real page-size values (not a duplicate).
function extractConst(name) {
  const start = src.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `could not find const ${name}`);
  const end = src.indexOf("\n};", start);
  assert.ok(end >= 0, `could not find end of const ${name}`);
  return src.slice(start, end + 3);
}
// The builder also calls _scanOcrTextOps (which calls _scanPdfEscapetext)
// to emit the optional invisible OCR text layer; pull those in too so the
// extracted function resolves them.
// eslint-disable-next-line no-eval
const _scanBuildPdfBlob = eval(
  `(function () {
     ${extractConst("_SCAN_PAGE_SIZES")}
     ${extract("_scanPdfEscapeText")}
     ${extract("_scanOcrTextOps")}
     return (${extract("_scanBuildPdfBlob")});
   })()`
);

const _tests = [];
const ok = (name, fn) => { _tests.push([name, fn]); };

// A recognizable fake JPEG (SOI … EOI). The builder embeds raw bytes and
// never decodes them, so structure tests don't need a real image.
const jpegOf = (len, seed) => {
  const u = new Uint8Array(len);
  u[0] = 0xFF; u[1] = 0xD8;
  for (let i = 2; i < len - 2; i++) u[i] = (i * 31 + seed) & 0xFF;
  u[len - 2] = 0xFF; u[len - 1] = 0xD9;
  return u;
};
const pagesOf = (specs) => specs.map((s, i) => ({ jpeg: jpegOf(s.len, i + 1), w: s.w, h: s.h }));

async function bytesFor(pages, opts) {
  const blob = _scanBuildPdfBlob(pages, opts);
  return new Uint8Array(await blob.arrayBuffer());
}
// Latin1 view lets us locate ASCII structure while keeping byte offsets
// identical to the binary (each code unit = one byte).
const latin1 = (u8) => Buffer.from(u8).toString("latin1");

// Parse the xref table into offsets[objNum] = byte position.
function parseXref(s, totalObjs) {
  const xrefAt = s.lastIndexOf("\nxref\n") + 1;
  assert.ok(xrefAt > 0, "no xref table");
  const header = `xref\n0 ${totalObjs + 1}\n`;
  assert.ok(s.startsWith(header, xrefAt), "xref subsection header wrong");
  const base = xrefAt + header.length;
  const offsets = [];
  for (let i = 0; i <= totalObjs; i++) {
    const line = s.substr(base + i * 20, 20);
    offsets[i] = { off: parseInt(line.slice(0, 10), 10), kind: line[17] };
  }
  return { xrefAt, offsets };
}

// ── structural invariants across page counts ─────────────────────────
for (const N of [1, 2, 5]) {
  ok(`${N}-page: header, object count, xref offsets, trailer`, async () => {
    const specs = Array.from({ length: N }, (_, i) => ({ len: 200 + i * 37, w: 1000 + i, h: 1400 + i }));
    const pages = pagesOf(specs);
    const u8 = await bytesFor(pages);
    const s = latin1(u8);

    assert.ok(s.startsWith("%PDF-1."), "missing PDF header");
    assert.ok(s.trimEnd().endsWith("%%EOF"), "missing %%EOF");

    const totalObjs = 2 + N * 3;
    const { xrefAt, offsets } = parseXref(s, totalObjs);

    // Free head + every object offset points exactly at "n 0 obj".
    assert.equal(offsets[0].kind, "f", "object 0 must be free");
    for (let objNum = 1; objNum <= totalObjs; objNum++) {
      const { off, kind } = offsets[objNum];
      assert.equal(kind, "n", `object ${objNum} must be in-use`);
      assert.ok(s.startsWith(`${objNum} 0 obj`, off), `xref offset for obj ${objNum} does not point at its definition`);
    }

    // startxref value equals the xref table's byte position.
    const sx = s.match(/startxref\n(\d+)\n%%EOF/);
    assert.ok(sx, "no startxref");
    assert.equal(Number(sx[1]), xrefAt, "startxref does not match xref position");

    // Trailer.
    assert.ok(s.includes(`/Size ${totalObjs + 1}`), "trailer /Size wrong");
    assert.ok(/\/Root 1 0 R/.test(s), "trailer /Root wrong");

    // Page tree: Count and one Kid ref per page.
    assert.ok(s.includes(`/Type /Pages`), "no Pages node");
    assert.ok(s.includes(`/Count ${N}`), "Pages /Count wrong");
    for (let i = 0; i < N; i++) {
      assert.ok(s.includes(`${3 + i * 3} 0 R`), `missing Kid ref for page ${i}`);
    }
    // Letter MediaBox on every page.
    assert.equal((s.match(/\/MediaBox \[0 0 612 792\]/g) || []).length, N, "MediaBox count wrong");
  });
}

// ── page size opt-in (A4) ────────────────────────────────────────────
ok("pageSize:'a4' emits A4 MediaBox; default stays Letter", async () => {
  const pages = pagesOf([{ len: 256, w: 1000, h: 1400 }]);
  const a4 = latin1(await bytesFor(pages, { pageSize: "a4" }));
  assert.ok(a4.includes("/MediaBox [0 0 595 842]"), "A4 MediaBox not emitted");
  const letter = latin1(await bytesFor(pages, { pageSize: "letter" }));
  assert.ok(letter.includes("/MediaBox [0 0 612 792]"), "Letter MediaBox not emitted");
  // An unknown / missing size must fall back to Letter, never break.
  const dflt = latin1(await bytesFor(pages, { pageSize: "tabloid" }));
  assert.ok(dflt.includes("/MediaBox [0 0 612 792]"), "unknown size did not fall back to Letter");
});

// ── exact JPEG embedding (no binary corruption) ──────────────────────
ok("image streams embed the exact JPEG bytes with a correct /Length", async () => {
  const pages = pagesOf([{ len: 511, w: 800, h: 600 }, { len: 1024, w: 1200, h: 1600 }]);
  const u8 = await bytesFor(pages);
  const s = latin1(u8);

  for (let i = 0; i < pages.length; i++) {
    const imgObj = 5 + i * 3;
    const decl = `${imgObj} 0 obj`;
    const at = s.indexOf(decl);
    assert.ok(at >= 0, `image object ${imgObj} missing`);
    // /Length in the dict must equal the source JPEG length.
    const dict = s.slice(at, s.indexOf("stream\n", at));
    const lenMatch = dict.match(/\/Length (\d+)/);
    assert.ok(lenMatch, "image dict missing /Length");
    assert.equal(Number(lenMatch[1]), pages[i].jpeg.length, `image ${i} /Length mismatch`);
    assert.ok(/\/Filter \/DCTDecode/.test(dict), "image not DCTDecode");
    assert.ok(/\/ColorSpace \/DeviceRGB/.test(dict), "image not DeviceRGB");

    // The bytes between "stream\n" and "\nendstream" must equal the input
    // JPEG exactly — proves binary assembly didn't corrupt or shift them.
    const streamStart = s.indexOf("stream\n", at) + "stream\n".length;
    const embedded = u8.slice(streamStart, streamStart + pages[i].jpeg.length);
    assert.deepEqual([...embedded], [...pages[i].jpeg], `image ${i} bytes corrupted`);
    assert.ok(s.startsWith("\nendstream", streamStart + pages[i].jpeg.length), `image ${i} endstream misplaced`);
  }
});

// ── image is fit within the page, preserving aspect ratio ────────────
ok("content stream scales the image to fit the page margins", async () => {
  const u8 = await bytesFor(pagesOf([{ len: 300, w: 2000, h: 1000 }]));
  const s = latin1(u8);
  // cm operator: "<sx> 0 0 <sy> <tx> <ty> cm"
  const cm = s.match(/q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n\/Im0 Do\nQ/);
  assert.ok(cm, "content stream missing image-placement matrix");
  const sx = +cm[1], sy = +cm[2], tx = +cm[3], ty = +cm[4];
  // Must fit inside 612×792 with the 24pt margin, and stay on-page.
  assert.ok(sx <= 612 - 48 + 0.5 && sy <= 792 - 48 + 0.5, "image exceeds margins");
  assert.ok(tx >= 24 - 0.5 && ty >= 24 - 0.5, "image origin inside margin");
  // Aspect ratio preserved (2000×1000 → 2:1).
  assert.ok(Math.abs(sx / sy - 2) < 0.02, "aspect ratio not preserved");
});

// ── searchable OCR text layer ────────────────────────────────────────
ok("OCR words add a font + invisible text layer, keeping xref valid", async () => {
  const page = { jpeg: jpegOf(400, 3), w: 1000, h: 1400, ocrWords: [
    { text: "INVOICE", x0: 100, y0: 80,  x1: 400, y1: 160 },
    { text: "Total:",  x0: 100, y0: 300, x1: 260, y1: 340 },
    { text: "(cash)",  x0: 280, y0: 300, x1: 420, y1: 340 },   // exercises paren escaping
  ] };
  const u8 = await bytesFor([page]);
  const s = latin1(u8);

  // One shared font object appended after the page's 3 objects (N=1 →
  // font is object 6); total objects = 2 + 3 + 1 = 6.
  const totalObjs = 6;
  const { offsets } = parseXref(s, totalObjs);
  for (let objNum = 1; objNum <= totalObjs; objNum++) {
    assert.ok(s.startsWith(`${objNum} 0 obj`, offsets[objNum].off), `xref offset for obj ${objNum} wrong`);
  }
  assert.ok(s.includes("/Size 7"), "trailer /Size should account for the font object");
  assert.ok(/6 0 obj\n<< \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica/.test(s), "font object missing");
  assert.ok(/\/Font << \/F0 6 0 R >>/.test(s), "page does not reference the font");

  // Invisible render mode + the words are present (parens escaped).
  assert.ok(s.includes("BT\n3 Tr\n"), "text layer not in invisible render mode");
  assert.ok(s.includes("(INVOICE) Tj"), "OCR word INVOICE missing");
  assert.ok(s.includes("(Total:) Tj"), "OCR word Total: missing");
  assert.ok(s.includes("(\\(cash\\)) Tj"), "parentheses in OCR text not escaped");

  // A page with no OCR words must NOT gain a font (backward compatible).
  const plain = latin1(await bytesFor(pagesOf([{ len: 200, w: 800, h: 600 }])));
  assert.ok(!plain.includes("/BaseFont"), "no-OCR PDF should have no font object");
  assert.ok(!plain.includes("3 Tr"), "no-OCR PDF should have no text layer");
});

let n = 0;
for (const [name, fn] of _tests) {
  try { await fn(); n++; }
  catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); }
}
console.log(`✓ scanner PDF writer · ${n} checks passed`);
