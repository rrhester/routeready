#!/usr/bin/env node
/**
 * check-cache-bump.mjs · CI ratchet that makes "ship an app change that
 * nobody can see" impossible to merge.
 *
 * Why this exists: the driver PWA's service worker (app/sw.js) precaches the
 * app shell under SHELL_CACHE = "rr-app-shell-vNNN" and serves those files
 * with `ignoreSearch`, so a `?v=` bump does NOT refresh an installed PWA —
 * ONLY bumping SHELL_CACHE does. That was missed twice, shipping the voice-
 * note UI invisibly to installed apps. This check fails a PR that changes any
 * SW-precached shell asset without bumping SHELL_CACHE.
 *
 * Runs in CI (see .github/workflows/cache-bump-check.yml). Base ref comes from
 * CACHE_CHECK_BASE (default origin/main).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

// The files app/sw.js precaches in SHELL_FILES (minus sw.js itself, which IS
// where the version lives). Keep in sync with SHELL_FILES.
const SHELL_ASSETS = [
  "app/app.js",
  "app/comms-native.js",
  "app/styles.css",
  "app/rr-system.css",
  "app/form-validation.js",
];

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const tokenOf = (s) => {
  const m = s && s.match(/rr-app-shell-([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
};

const base = process.env.CACHE_CHECK_BASE || "origin/main";
let mergeBase;
try {
  mergeBase = sh(`git merge-base ${base} HEAD`);
} catch {
  console.log("cache-bump check: no merge base available — skipping.");
  process.exit(0);
}

const changed = sh(`git diff --name-only ${mergeBase} HEAD`).split("\n").filter(Boolean);
const shellChanged = changed.filter((f) => SHELL_ASSETS.includes(f));
if (shellChanged.length === 0) {
  console.log("cache-bump check: no service-worker-precached assets changed. OK.");
  process.exit(0);
}

const headSw = fs.readFileSync("app/sw.js", "utf8");
const headTok = tokenOf(headSw);
let baseSw = "";
try { baseSw = sh(`git show ${mergeBase}:app/sw.js`); } catch { /* new file */ }
const baseTok = tokenOf(baseSw);

if (!headTok) {
  console.error("✗ cache-bump check: app/sw.js has no rr-app-shell-<version> SHELL_CACHE.");
  process.exit(1);
}
if (baseTok && baseTok === headTok) {
  const next = /^(.*?)(\d+)$/.exec(headTok);
  const hint = next ? `${next[1]}${Number(next[2]) + 1}` : `${headTok}-2`;
  console.error("✗ cache-bump check FAILED.\n");
  console.error("  These service-worker-precached shell files changed:");
  shellChanged.forEach((f) => console.error(`    • ${f}`));
  console.error(`\n  …but app/sw.js SHELL_CACHE is still "rr-app-shell-${headTok}".`);
  console.error("  Installed PWAs serve the shell from precache (ignoreSearch), so");
  console.error("  without a SHELL_CACHE bump they keep the OLD app.js/CSS — the change");
  console.error("  ships invisibly.\n");
  console.error(`  Fix: bump SHELL_CACHE in app/sw.js to "rr-app-shell-${hint}".`);
  process.exit(1);
}
console.log(`cache-bump check OK: SHELL_CACHE ${baseTok || "(new)"} → ${headTok}.`);
