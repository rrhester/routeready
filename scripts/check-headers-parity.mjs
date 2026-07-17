#!/usr/bin/env node
// Security/caching header parity between the two host configs
// (project-review PR#1). The full header set is maintained twice —
// netlify.toml (Netlify) and _headers (Cloudflare Pages) — and a change
// to one silently leaves the other host unhardened. This asserts:
//   1. every security header in the site-wide "/*" block is present with
//      an IDENTICAL value in both files, and
//   2. the set of paths given the immutable long-cache rule matches.
// Runs as part of `npm run smoke`.

import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const cf = fs.readFileSync(path.join(root, "_headers"), "utf8");
const nt = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");

// ── Cloudflare "/*" block ────────────────────────────────────────────
function cfSiteWide() {
  const out = {};
  const lines = cf.split("\n");
  let inBlock = false;
  for (const l of lines) {
    if (/^\/\*\s*$/.test(l)) { inBlock = true; continue; }
    if (inBlock) {
      const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(l);
      if (m) { out[m[1]] = m[2].trim(); continue; }
      if (l.trim() !== "") inBlock = false; // next path pattern ends the block
    }
  }
  return out;
}

// ── Netlify for = "/*" block ─────────────────────────────────────────
function ntSiteWide() {
  const out = {};
  const m = /\[\[headers\]\]\s*\n\s*for\s*=\s*"\/\*"\s*\n\s*\[headers\.values\]\s*\n([\s\S]*?)(?=\n\[\[|$)/.exec(nt);
  if (!m) return out;
  for (const l of m[1].split("\n")) {
    const kv = /^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/.exec(l);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// ── Immutable path sets ──────────────────────────────────────────────
function cfImmutablePaths() {
  const out = new Set();
  const lines = cf.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].startsWith("/")) {
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
        if (/Cache-Control:.*immutable/.test(lines[j])) out.add(lines[i].trim());
      }
    }
  }
  return out;
}
function ntImmutablePaths() {
  const out = new Set();
  const re = /\[\[headers\]\]\s*\n\s*for\s*=\s*"([^"]+)"\s*\n\s*\[headers\.values\]\s*\n([\s\S]*?)(?=\n\[\[|$)/g;
  let m;
  while ((m = re.exec(nt))) {
    if (/Cache-Control\s*=\s*".*immutable/.test(m[2])) out.add(m[1]);
  }
  return out;
}

let failed = false;
const a = cfSiteWide();
const b = ntSiteWide();
const names = new Set([...Object.keys(a), ...Object.keys(b)]);
for (const n of names) {
  if (!(n in a)) { console.error(`✗ ${n} set in netlify.toml but missing from _headers`); failed = true; continue; }
  if (!(n in b)) { console.error(`✗ ${n} set in _headers but missing from netlify.toml`); failed = true; continue; }
  if (a[n] !== b[n]) {
    console.error(`✗ ${n} differs between hosts:\n    _headers:     ${a[n]}\n    netlify.toml: ${b[n]}`);
    failed = true;
  }
}

const ci = cfImmutablePaths();
const ni = ntImmutablePaths();
for (const p of ci) if (!ni.has(p)) { console.error(`✗ immutable path ${p} in _headers but not netlify.toml`); failed = true; }
for (const p of ni) if (!ci.has(p)) { console.error(`✗ immutable path ${p} in netlify.toml but not _headers`); failed = true; }

if (failed) process.exit(1);
console.log(`✓ header parity ok (${names.size} site-wide headers, ${ci.size} immutable paths, both hosts identical)`);
