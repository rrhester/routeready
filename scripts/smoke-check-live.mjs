#!/usr/bin/env node
// Smoke-check for dashboard/live.js and app/app.js.  Catches the
// silent failure mode that has bitten us repeatedly: an auto-resolve
// drops a function header, leaving the function body running at
// module top level.  Top-level `if (foo)` / `return foo;` then
// references identifiers that don't exist in module scope, throws
// ReferenceError at import time, and the whole dashboard reverts to
// the static mockup.
//
// node --check passes such files (top-level if/return are valid
// syntax) so we need an AST walk instead.  Run as part of any
// pre-merge / pre-push hook.
//
//   node scripts/smoke-check-live.mjs
//
// Exits non-zero on any orphan, conflict marker, or syntax error.

import fs from "node:fs";
import path from "node:path";

// acorn is a devDependency. On a fresh clone it isn't present until
// `npm install`, and a bare `import { Parser } from "acorn"` throws a
// raw ERR_MODULE_NOT_FOUND stack trace that buries the real fix. Load
// it dynamically so we can fail with a clear, actionable message.
let Parser;
try {
  ({ Parser } = await import("acorn"));
} catch (e) {
  if (e && e.code === "ERR_MODULE_NOT_FOUND") {
    console.error("✗ smoke-check: dependency 'acorn' is not installed.");
    console.error("  Run `npm install` first, then re-run `npm run smoke`.");
    process.exit(1);
  }
  throw e;
}

const targets = [
  path.join(import.meta.dirname, "..", "dashboard", "live.js"),
  path.join(import.meta.dirname, "..", "app",       "app.js"),
];

let total = 0;

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const code = fs.readFileSync(file, "utf8");
  console.log(`\n→ ${path.relative(process.cwd(), file)}`);

  // 1. Conflict markers anywhere → instant fail.
  const cm = code.match(/^(<<<<<<< |>>>>>>> |=======)$/m);
  if (cm) {
    console.error(`  ✗ unresolved conflict marker found`);
    total += 1;
    continue;
  }

  // 2. Parse — surfaces real syntax errors that node --check might miss.
  let ast;
  try {
    ast = Parser.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (e) {
    console.error(`  ✗ parse error · ${e.message}`);
    total += 1;
    continue;
  }

  // 3. Walk top-level statements and flag orphans.  The orphan
  //    signature: a top-level `if`/`return` whose identifier reads
  //    aren't bound ANYWHERE in the file (or are bound only inside
  //    another function's body, which means the orphan can never
  //    legitimately resolve them).  Build the "names ever bound in
  //    this module" set up front, then compare references.

  const everBound = new Set([
    "window","document","location","console","Math","Date","Number","String",
    "Object","Array","Map","Set","Promise","JSON","URL","Error","Boolean",
    "undefined","null","setTimeout","setInterval","clearInterval","clearTimeout",
    "fetch","navigator","localStorage","sessionStorage","NaN","Infinity",
    "TextEncoder","TextDecoder","Blob","FormData","File","FileReader","atob","btoa",
    "indexedDB","crypto","Headers","Request","Response","WebSocket","Audio","Image",
    "queueMicrotask","structuredClone","performance","alert","confirm","prompt",
    "self","globalThis","CSS","Element","Node","Event","CustomEvent","DOMParser",
    "MutationObserver","IntersectionObserver","ResizeObserver","Symbol","RegExp",
    "Reflect","Proxy","WeakMap","WeakSet","BigInt","Intl","ArrayBuffer","DataView",
    "Uint8Array","Int8Array","Uint16Array","Int16Array","Uint32Array","Int32Array",
    "Float32Array","Float64Array","require","module","exports","process",
    "AbortController","URLSearchParams","Storage","CSSStyleDeclaration",
    "encodeURIComponent","decodeURIComponent","encodeURI","decodeURI",
    "isNaN","isFinite","parseInt","parseFloat",
  ]);

  // Recursively collect every binding name introduced anywhere in
  // the file — params, destructuring, function/class declarations,
  // catch parameters, for-loop bindings, etc.
  function collectBindings(n) {
    if (!n || typeof n !== "object") return;
    switch (n.type) {
      case "Identifier":
        // Only useful when reached via patterns; the recursion below
        // handles those cases.  Bare identifiers shouldn't be
        // declared by themselves at this level.
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        if (n.id?.name) everBound.add(n.id.name);
        for (const p of n.params || []) bindPattern(p);
        // Recurse into body to catch nested functions / declarations.
        collectBindings(n.body);
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression":
        if (n.id?.name) everBound.add(n.id.name);
        break;
      case "VariableDeclaration":
        for (const d of n.declarations) bindPattern(d.id);
        break;
      case "CatchClause":
        if (n.param) bindPattern(n.param);
        break;
      case "ImportDeclaration":
        for (const s of n.specifiers || []) if (s.local?.name) everBound.add(s.local.name);
        return;
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(collectBindings);
      else if (v && typeof v === "object") collectBindings(v);
    }
  }
  function bindPattern(p) {
    if (!p) return;
    switch (p.type) {
      case "Identifier": everBound.add(p.name); return;
      case "AssignmentPattern": bindPattern(p.left); return;
      case "RestElement": bindPattern(p.argument); return;
      case "ArrayPattern": (p.elements || []).forEach(e => e && bindPattern(e)); return;
      case "ObjectPattern":
        for (const prop of p.properties || []) {
          if (prop.type === "RestElement") bindPattern(prop.argument);
          else if (prop.value)             bindPattern(prop.value);
        }
        return;
    }
  }
  collectBindings(ast);

  // Now flag top-level if/return/break/continue whose references
  // include identifiers nobody ever binds anywhere.
  let issues = 0;
  function collectReads(n, into) {
    if (!n || typeof n !== "object") return;
    if (n.type === "Identifier") { into.add(n.name); return; }
    if (n.type === "MemberExpression") {
      collectReads(n.object, into);
      if (n.computed) collectReads(n.property, into);
      return;
    }
    if (n.type === "Property") {
      // Only the value side is a read; the key is just a name.
      if (n.computed) collectReads(n.key, into);
      collectReads(n.value, into);
      return;
    }
    if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression"
        || n.type === "FunctionDeclaration") return;
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(c => collectReads(c, into));
      else if (v && typeof v === "object" && v.type) collectReads(v, into);
    }
  }

  for (const node of ast.body) {
    if (node.type !== "IfStatement" && node.type !== "ReturnStatement"
        && node.type !== "BreakStatement" && node.type !== "ContinueStatement") continue;
    const refs = new Set();
    collectReads(node, refs);
    const undef = [...refs].filter(name => !everBound.has(name)
      && !/^[A-Z][A-Z0-9_]*$/.test(name));
    if (undef.length > 0) {
      console.error(`  ✗ orphaned ${node.type} at line ${node.loc?.start?.line} — references ${undef.slice(0, 6).join(", ")}`);
      issues += 1;
    }
  }

  if (issues === 0) console.log(`  ✓ ok`);
  total += issues;
}

console.log("");
if (total === 0) {
  console.log("All clear.");
  process.exit(0);
} else {
  console.error(`✗ ${total} issue(s) — fix before pushing.`);
  process.exit(1);
}
