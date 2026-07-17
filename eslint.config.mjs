// Minimal ESLint gate (project-review PR#85).
//
// Deliberately narrow: `no-undef` (+ a few no-op-detector rules) over the
// shipped no-build-step JS. This is the class of bug the codebase keeps
// hand-guarding against with `typeof X === "function"` checks — a renamed
// or half-deleted global silently turning features into no-ops. It is NOT
// a style linter; don't add formatting rules.
//
// Cross-file globals: the dashboard is a set of classic scripts + module
// scripts sharing one window (live.js defines ~270 window.* + bare
// globals that mock-wiring/frags call, and vice versa). Anything shared
// cross-file is listed in SHARED_APP_GLOBALS below — if you add a new
// cross-file global, add it here too (prefer window.RR.* namespacing so
// you don't have to).
//
//   npx eslint .            # what CI runs
//   npx eslint --fix .      # never needed for no-undef; here for parity

import globals from "globals";

// Globals defined by one shipped file and consumed by another (or by
// inline scripts in dashboard/index.html / views/*.frag). Writable
// because several are assigned in more than one file.
const SHARED_APP_GLOBALS = Object.fromEntries([
  // mock-wiring.js scaffolding still referenced from live.js/frags
  "goto", "toast", "toastAction", "openModal", "closeModal",
  // supabase client + config handles (config.js / live.js)
  "sb", "RR_CONFIG", "RR",
  // capacitor bridge (app/comms-native.js → app/app.js)
  "RRNative", "Capacitor",
  // vendored / CDN libraries attached to window at runtime
  "supabase", "L", "QRCode", "pdfjsLib", "PDFLib", "Tesseract", "XLSX",
  "mammoth", "LiveKit", "MediaPipe",
  // window.*-assigned view/sub-tab switchers + modal openers shared between
  // live.js, mock-wiring.js, and views/*.frag inline scripts (each verified
  // window-assigned at lint-adoption time — if you delete one, delete it
  // here too so the linter can catch stale callers)
  "pipeSub", "obSub", "schedSub", "drSub", "fleetSub",
  "openAiSchedule", "loadComplianceWorkspace", "openPdfUploadPicker",
  "openAddApplicantModal", "setSettingsSection", "_ddMessageDriver",
  "attStatusPillFor", "attActionFor",
].map((n) => [n, "writable"]));

export default [
  {
    // Generated bundle — checked by engine-tests.yml freshness gate, not lint.
    ignores: [
      "node_modules/**",
      "dashboard/scheduling-engine.js",
      "desktop/node_modules/**",
      "engine/**",        // TS packages have tsc, the stronger tool
      "flex-capacity/**",
      "services/**",
      "design/**",        // mockups, not shipped
      "tests/**",         // playwright configs/suites — separate runtimes
      "scripts/**",       // node tooling, exercised directly by npm test
      "apps-script/**",   // Google Apps Script runtime
      "desktop/**",       // electron main/renderer — own globals; follow-up
    ],
  },
  {
    files: ["dashboard/**/*.js", "dashboard/**/*.mjs", "app/*.js"],
    ignores: ["dashboard/sw.js", "app/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...SHARED_APP_GLOBALS },
    },
    rules: {
      "no-undef": "error",
      // The silent-no-op detectors — cheap, high-signal.
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-compare-neg-zero": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
  {
    files: ["dashboard/sw.js", "app/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.serviceworker },
    },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
    },
  },
];
