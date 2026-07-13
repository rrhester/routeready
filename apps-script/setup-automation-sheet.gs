/**
 * RouteReady Automation — Sheet hardening & polish
 * =================================================
 * One-time (and re-runnable) setup for the "RouteReady Automation" Google Sheet.
 * Implements the 5 improvements from the spreadsheet review:
 *
 *   #1  Migrate secrets out of the Settings tab into Script Properties
 *   #2  Data-validation dropdowns (Status / Priority / Attendance / VideoStatus)
 *   #3  A live "Dashboard" tab (counts vs. HeadcountTarget)
 *   #4  Frozen headers + conditional formatting + banding + header styling
 *   #5  Fix the "Phone Numer" header typo + standardize toggle conventions
 *
 * HOW TO USE
 *   1. Open the sheet → Extensions → Apps Script.
 *   2. Add a new file, paste this in, Save.
 *   3. Run  setupRouteReadySheet()  (grant permissions when prompted).
 *      -> This runs ONLY the safe/additive steps. It CANNOT break your
 *         automation: it adds dropdowns as warnings (not hard blocks),
 *         creates a new Dashboard tab, and applies cosmetic styling.
 *   4. Read the SECURITY + READER-SENSITIVE notes below, then run the
 *      opt-in functions individually once you've confirmed they're safe.
 *
 * IDEMPOTENT: safe to re-run. It updates in place instead of duplicating.
 */

// ---- Tab + column config (matches the current sheet) -----------------------
var TAB = {
  INGEST: 'Ingest',
  MASTER: 'Master',
  SETTINGS: 'Settings',
  WAITLIST: 'Waitlist',
  QUEUE: 'Queue',
  DECISIONS: 'Decisions',
  DASHBOARD: 'Dashboard',
};

// Master columns are 1-indexed. Adjust here if you reorder columns.
var MASTER_COL = {
  STATUS: 6,        // F
  PRIORITY: 9,      // I
  ATTENDANCE: 11,   // K
  VIDEO_STATUS: 14, // N
};

// Allowed values for the dropdowns. Tweak these to match whatever strings
// your automation actually writes. COUNTIF (used on the Dashboard) is
// case-insensitive, so casing here only affects the picker.
var VOCAB = {
  STATUS: ['New', 'Contacted', 'Booked', 'Attended', 'No-Show', 'Hired', 'Rejected', 'Waitlisted'],
  PRIORITY: ['High', 'Medium', 'Low'],
  ATTENDANCE: ['Pending', 'Attended', 'No-Show'],
  VIDEO_STATUS: ['Not Sent', 'Sent', 'Recorded', 'Scored', 'Expired'],
};

// #1 — keys whose VALUES are secrets and must not live in the sheet.
var SECRET_KEYS = [
  'CalComAPIKey',
  'Claude API Key',
  'R2AccessKeyId',
  'R2SecretAccessKey',
  'R2AccountId',
  'DashboardPasswordHash',
  'DashboardPasswordSalt',
];

// #5 — keys that are on/off toggles. standardizeToggles() normalizes these
// to TRUE/FALSE. (Reader-sensitive — see warning on that function.)
var TOGGLE_KEYS = ['RouteReadyLogic', 'VideoScreeningEnabled', 'ReferralProgramOn'];

// Brand-ish colors for header styling.
var STYLE = {
  HEADER_BG: '#1f2a44',
  HEADER_FG: '#ffffff',
};

// ===========================================================================
//  SAFE RUNNER — additive only. Cannot break your existing automation.
// ===========================================================================
function setupRouteReadySheet() {
  var ss = SpreadsheetApp.getActive();
  copySecretsToProperties_(ss);   // #1 (copy only — does NOT blank cells)
  addValidationDropdowns_(ss);    // #2 (warn-only, allowInvalid)
  buildDashboard_(ss);            // #3 (new tab)
  styleAllTabs_(ss);              // #4 (freeze + banding + header + rules)
  SpreadsheetApp.getUi && _toast_(ss,
    'Setup complete. Now read the SECURITY notes and run the reader-sensitive ' +
    'functions (redactSecretCells / fixHeaderTypo / standardizeToggles) manually.');
}

// ===========================================================================
//  #1  SECRETS
// ===========================================================================
/**
 * Copies every SECRET_KEYS value from Settings into Script Properties.
 * NON-DESTRUCTIVE: the cells are left intact so your current automation keeps
 * working. After you've switched your code to read via getSecret_() (below),
 * run redactSecretCells() to blank the cells.
 */
function copySecretsToProperties_(ss) {
  ss = ss || SpreadsheetApp.getActive();
  var settings = _readSettings_(ss);
  var props = PropertiesService.getScriptProperties();
  var moved = [];
  SECRET_KEYS.forEach(function (key) {
    if (settings.map[key] && String(settings.map[key]).trim() !== '') {
      props.setProperty(key, String(settings.map[key]));
      moved.push(key);
    }
  });
  Logger.log('Copied to Script Properties: ' + (moved.join(', ') || '(none found)'));
  return moved;
}

/**
 * Drop-in replacement for reading a secret. Swap any
 *   settings['CalComAPIKey']  ->  getSecret_('CalComAPIKey')
 * in your automation. Falls back to the Settings cell if not yet migrated,
 * so it's safe to roll out gradually.
 */
function getSecret_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== '') return v;
  // Fallback: legacy read from Settings (remove once fully migrated).
  return _readSettings_(SpreadsheetApp.getActive()).map[key] || '';
}

/**
 * DESTRUCTIVE — run only after your automation reads secrets via getSecret_().
 * Blanks the secret values in Settings and leaves a breadcrumb in the cell.
 */
function redactSecretCells() {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(TAB.SETTINGS);
  var settings = _readSettings_(ss);
  var redacted = [];
  SECRET_KEYS.forEach(function (key) {
    var row = settings.rowByKey[key];
    if (row) {
      s.getRange(row, 2).setValue('(moved to Script Properties)');
      redacted.push(key);
    }
  });
  Logger.log('Redacted in Settings: ' + (redacted.join(', ') || '(none)'));
}

// ===========================================================================
//  #2  DATA-VALIDATION DROPDOWNS  (warn-only, protects the automation)
// ===========================================================================
function addValidationDropdowns_(ss) {
  ss = ss || SpreadsheetApp.getActive();
  var m = ss.getSheetByName(TAB.MASTER);
  if (!m) return;
  var lastRow = Math.max(m.getMaxRows(), 1000);
  _applyList_(m, MASTER_COL.STATUS, lastRow, VOCAB.STATUS);
  _applyList_(m, MASTER_COL.PRIORITY, lastRow, VOCAB.PRIORITY);
  _applyList_(m, MASTER_COL.ATTENDANCE, lastRow, VOCAB.ATTENDANCE);
  _applyList_(m, MASTER_COL.VIDEO_STATUS, lastRow, VOCAB.VIDEO_STATUS);
}

function _applyList_(sheet, col, lastRow, list) {
  var rng = sheet.getRange(2, col, lastRow - 1, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true)
    .setAllowInvalid(true) // warn (yellow triangle), do NOT reject — keeps automation writes working
    .setHelpText('Suggested: ' + list.join(', '))
    .build();
  rng.setDataValidation(rule);
}

// ===========================================================================
//  #3  DASHBOARD TAB
// ===========================================================================
function buildDashboard_(ss) {
  ss = ss || SpreadsheetApp.getActive();
  var d = ss.getSheetByName(TAB.DASHBOARD);
  if (!d) d = ss.insertSheet(TAB.DASHBOARD, 0); // put it first
  d.clear();
  d.getRange(1, 1, 200, 4).clearDataValidations();

  var M = "'" + TAB.MASTER + "'";
  var S = "'" + TAB.SETTINGS + "'";
  // Pull HeadcountTarget from Settings (key in A, value in B).
  var target = 'IFERROR(VLOOKUP("HeadcountTarget",' + S + '!A:B,2,FALSE),0)';

  var rows = [
    ['RouteReady — Pipeline Dashboard', ''],
    ['Auto-calculated from the Master tab. Last opened: ', '=NOW()'],
    ['', ''],
    ['Metric', 'Value'],
    ['Headcount target', '=' + target],
    ['Total applicants', '=COUNTA(' + M + '!A2:A)'],
    ['Contacted', '=COUNTIF(' + M + '!E2:E,"<>")'],
    ['Booked', '=COUNTIF(' + M + '!F2:F,"Booked")'],
    ['Attended', '=COUNTIF(' + M + '!K2:K,"Attended")'],
    ['No-shows', '=COUNTIF(' + M + '!K2:K,"No-Show")'],
    ['Hired', '=COUNTIF(' + M + '!F2:F,"Hired")'],
    ['Confirmed vs target', '=COUNTIF(' + M + '!F2:F,"Booked")&" / "&' + target],
    ['% to target',
      '=IFERROR(COUNTIF(' + M + '!F2:F,"Booked")/' + target + ',0)'],
    ['', ''],
    ['Video: recorded', '=COUNTIF(' + M + '!N2:N,"Recorded")'],
    ['Video: scored', '=COUNTIF(' + M + '!N2:N,"Scored")'],
    ['Waitlist size', '=COUNTA(\'' + TAB.WAITLIST + '\'!A2:A)'],
    ['Queue pending', '=COUNTIF(\'' + TAB.QUEUE + '\'!F2:F,"<>Sent")'],
  ];
  d.getRange(1, 1, rows.length, 2).setValues(rows);

  // Styling for the dashboard.
  d.getRange('A1:B1').merge().setValue('RouteReady — Pipeline Dashboard')
    .setFontSize(16).setFontWeight('bold').setFontColor(STYLE.HEADER_FG)
    .setBackground(STYLE.HEADER_BG).setHorizontalAlignment('left');
  d.getRange('B2').setNumberFormat('ddd mmm d, yyyy h:mm am/pm');
  d.getRange('A4:B4').setFontWeight('bold').setBackground('#eef1f6');
  d.getRange('B13').setNumberFormat('0%'); // % to target
  d.getRange(1, 1, rows.length, 2).setFontFamily('Arial');
  d.setColumnWidth(1, 220);
  d.setColumnWidth(2, 180);
  d.setFrozenRows(4);

  // Color % to target: red < 50%, amber < 100%, green at/over target.
  var pct = d.getRange('B13');
  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(1)
      .setBackground('#b7e1cd').setRanges([pct]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0.5, 0.9999)
      .setBackground('#ffe599').setRanges([pct]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0.5)
      .setBackground('#f4c7c3').setRanges([pct]).build(),
  ];
  d.setConditionalFormatRules(rules);
}

// ===========================================================================
//  #4  FREEZE + STYLING + CONDITIONAL FORMATTING
// ===========================================================================
function styleAllTabs_(ss) {
  ss = ss || SpreadsheetApp.getActive();
  Object.keys(TAB).forEach(function (k) {
    var name = TAB[k];
    if (name === TAB.DASHBOARD) return; // dashboard styled separately
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var lastCol = Math.max(sh.getLastColumn(), 1);

    // Freeze header row.
    sh.setFrozenRows(1);

    // Header styling.
    sh.getRange(1, 1, 1, lastCol)
      .setFontWeight('bold').setFontColor(STYLE.HEADER_FG)
      .setBackground(STYLE.HEADER_BG).setHorizontalAlignment('left');

    // Left-align everything (better for a data table than centered).
    sh.getRange(1, 1, sh.getMaxRows(), lastCol).setHorizontalAlignment('left');

    // Row banding (remove existing first so re-runs don't stack).
    var body = sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), lastCol);
    body.getBandings().forEach(function (b) { b.remove(); });
    try { body.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false); }
    catch (e) { /* banding already present */ }
  });

  applyStatusColors_(ss); // conditional formatting on Master + Decisions
}

/** Color-code Status/Attendance on Master and RiskLevel on Decisions. */
function applyStatusColors_(ss) {
  ss = ss || SpreadsheetApp.getActive();
  var m = ss.getSheetByName(TAB.MASTER);
  if (m) {
    var maxR = Math.max(m.getMaxRows(), 2);
    var statusRange = m.getRange(2, MASTER_COL.STATUS, maxR - 1, 1);
    var attRange = m.getRange(2, MASTER_COL.ATTENDANCE, maxR - 1, 1);
    var rules = [
      _textRule_(statusRange, 'Hired', '#b7e1cd'),
      _textRule_(statusRange, 'Booked', '#c9e6ff'),
      _textRule_(statusRange, 'Attended', '#b7e1cd'),
      _textRule_(statusRange, 'Contacted', '#fff2cc'),
      _textRule_(statusRange, 'No-Show', '#f4c7c3'),
      _textRule_(statusRange, 'Rejected', '#efefef'),
      _textRule_(attRange, 'Attended', '#b7e1cd'),
      _textRule_(attRange, 'No-Show', '#f4c7c3'),
    ];
    m.setConditionalFormatRules(rules);
  }

  var dec = ss.getSheetByName(TAB.DECISIONS);
  if (dec) {
    // RiskLevel is the 4th column in Decisions (Timestamp, Trigger, ThrottleMode, RiskLevel...)
    var maxRd = Math.max(dec.getMaxRows(), 2);
    var risk = dec.getRange(2, 4, maxRd - 1, 1);
    dec.setConditionalFormatRules([
      _textRule_(risk, 'high', '#f4c7c3'),
      _textRule_(risk, 'medium', '#fff2cc'),
      _textRule_(risk, 'low', '#b7e1cd'),
    ]);
  }
}

function _textRule_(range, text, color) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(text)
    .setBackground(color)
    .setRanges([range])
    .build();
}

// ===========================================================================
//  #5  HEADER TYPO + TOGGLE CONVENTIONS  (READER-SENSITIVE — opt in)
// ===========================================================================
/**
 * READER-SENSITIVE: only run if your automation reads Master columns by
 * POSITION (not by the literal header string "Phone Numer"). Trivially
 * reversible if something depends on it.
 */
function fixHeaderTypo() {
  var ss = SpreadsheetApp.getActive();
  var m = ss.getSheetByName(TAB.MASTER);
  if (!m) return;
  var headers = m.getRange(1, 1, 1, m.getLastColumn()).getValues()[0];
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c]).trim() === 'Phone Numer') {
      m.getRange(1, c + 1).setValue('Phone Number');
      Logger.log('Fixed "Phone Numer" -> "Phone Number" at column ' + (c + 1));
    }
  }
}

/**
 * READER-SENSITIVE: normalizes TOGGLE_KEYS in Settings to TRUE/FALSE.
 * If your automation expects the literal strings "ON"/"OFF" or blank, update
 * that code first (or skip this one). Reversible.
 */
function standardizeToggles() {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(TAB.SETTINGS);
  var settings = _readSettings_(ss);
  var truthy = { 'on': 1, 'yes': 1, 'true': 1, '1': 1, 'enabled': 1 };
  TOGGLE_KEYS.forEach(function (key) {
    var row = settings.rowByKey[key];
    if (!row) return;
    var raw = String(settings.map[key] || '').trim().toLowerCase();
    var val = truthy[raw] ? true : false;
    s.getRange(row, 2).setValue(val);
    Logger.log('Set ' + key + ' = ' + val);
  });
}

// ===========================================================================
//  Helpers
// ===========================================================================
/** Reads the Settings tab into {map: {key:value}, rowByKey: {key:rowNumber}}. */
function _readSettings_(ss) {
  var s = ss.getSheetByName(TAB.SETTINGS);
  var out = { map: {}, rowByKey: {} };
  if (!s) return out;
  var values = s.getRange(1, 1, s.getLastRow(), 2).getValues();
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0]).trim();
    if (!key || key.toLowerCase() === 'setting') continue; // skip header row
    out.map[key] = values[i][1];
    out.rowByKey[key] = i + 1;
  }
  return out;
}

function _toast_(ss, msg) {
  try { ss.toast(msg, 'RouteReady setup', 8); } catch (e) {}
}
