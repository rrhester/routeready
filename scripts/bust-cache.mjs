#!/usr/bin/env node
/**
 * bust-cache.mjs · rewrites every static-asset cache-bust query string
 * (e.g. live.js?v=20260523-fauxscroll, styles.css?v=92) to a single
 * deploy-unique token so a fresh deploy invalidates every browser cache
 * in one shot.
 *
 * Why this exists:
 *   The dashboard ships HTML with `Cache-Control: no-cache` so the
 *   shell is always fresh, then relies on `?v=...` to bust the cached
 *   JS / CSS the HTML imports. The tokens were maintained by hand —
 *   meaning a PR that edits live.js but forgets to bump the token
 *   silently ships HTML pointing at JS the browser still has cached
 *   for the old version. Operators saw "old dummy data" after every
 *   such PR, and the deploy looked successful from our end.
 *
 *   Auto-bumping at build time (using COMMIT_REF on Netlify, falling
 *   back to the local git SHA, falling back to a timestamp) makes
 *   "deploy = invalidate every cached static asset" hold by
 *   construction. No more manual ?v= bumps; no more stale dashboards.
 *
 * Adding new HTML or JS that imports other versioned assets: just
 * append the path to FILES below. Any `<something>.js?v=…`,
 * `<something>.mjs?v=…`, or `<something>.css?v=…` pattern is rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function deriveToken() {
  // Netlify sets COMMIT_REF on every build; Cloudflare Pages sets
  // CF_PAGES_COMMIT_SHA. Preview deploys on both get the PR head SHA
  // so previews also bust caches against each other.
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF;
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return String(Date.now());
  }
}

const token = deriveToken().slice(0, 12) || String(Date.now());

// Files we rewrite. Add new entries if you create new HTML or JS that
// imports other JS/CSS with a `?v=...` cache-bust query.
const FILES = [
  "dashboard/index.html",
  "dashboard/live.js",
  "dashboard/meet.html",
  "dashboard/meet.js",
  "dashboard/repair/repair-ui.js",
  "dashboard/shop.html",
  "app/index.html",
  "terms.html",
  "privacy.html",
];

// Match any local asset reference with a ?v=... cache-bust. The
// extension anchor (.js / .mjs / .css / .frag) is what limits us to
// assets we control; everything after `?v=` up to the next quote /
// space / angle bracket / ampersand is the version we replace.
// (.frag = the view partials under dashboard/views/, fetched by the
// injector in index.html — monolith split phase 2.)
const PATTERN = /(\.(?:js|mjs|css|frag))\?v=[^"'\s>&]+/g;

let touched = 0;
let replacements = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.warn(`[bust-cache] skip · missing ${rel}`);
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  let localCount = 0;
  const after = before.replace(PATTERN, (_m, ext) => {
    localCount++;
    return `${ext}?v=${token}`;
  });
  if (before !== after) {
    fs.writeFileSync(abs, after);
    touched++;
    replacements += localCount;
    console.log(`[bust-cache] ${rel} · ${localCount} ref(s) → ?v=${token}`);
  }
}
// The driver service worker versions its precached app shell by the
// SHELL_CACHE *name* (rr-app-shell-…), NOT by ?v= — it serves the shell with
// ignoreSearch, so a ?v= bump alone never refreshes an installed PWA. Stamp
// the SW cache name with the same deploy token so every build that runs
// bust-cache also invalidates the precached shell. (A CI ratchet,
// scripts/check-cache-bump.mjs, separately guarantees the *committed* SW is
// bumped for hosts that don't run this build step.)
const swAbs = path.join(ROOT, "app/sw.js");
if (fs.existsSync(swAbs)) {
  const before = fs.readFileSync(swAbs, "utf8");
  const after = before.replace(/(rr-app-shell-)[A-Za-z0-9._-]+/g, `$1${token}`);
  if (before !== after) {
    fs.writeFileSync(swAbs, after);
    touched++;
    console.log(`[bust-cache] app/sw.js · SHELL_CACHE → rr-app-shell-${token}`);
  }
}

console.log(`[bust-cache] done · ${touched} file(s) · ${replacements} ref(s) · token=${token}`);
