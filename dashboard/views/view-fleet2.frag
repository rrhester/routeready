
      <!-- style block 33 (#rr-fleet2-style) extracted to inline-styles.css -->

      <div class="page">
        <!-- ═══════════════════════════════════════════════════════════
             Fleet chrome · 1:1 with the Schedule page's VISIBLE chrome
             generation: a flat view-switcher tab row (#rr-sched-viewseg
             twin) over a .rr-ab action bar. The retired strip-card
             replica (.f2-strip) is gone — Schedule hides that whole
             generation (inline-styles.css hide rules), so Fleet now
             mirrors what Schedule actually renders.
             ═══════════════════════════════════════════════════════════ -->

        <!-- Row 1 · Fleet view tabs. Each tab calls fleetSub() (live.js),
             which toggles the matching #fl-sub-* container + active tab
             and runs the sub-view's loader. Recipe cloned from
             #rr-sched-viewseg (schedule-rrx.css:435-491). -->
        <div class="rr-viewseg" id="rr-fleet-viewseg" role="tablist" aria-label="Fleet views">
          <button type="button" class="rr-viewseg-btn active" role="tab" aria-selected="true" data-sub="vehicles" onclick="fleetSub('vehicles')" aria-label="Vehicles" title="Vehicles">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17h2l1-4h12l1 4h2"/><path d="M5 13v4M19 13v4"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/></svg>
            <span class="rr-viewseg-label">Vehicles</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="calendar" onclick="fleetSub('calendar')" aria-label="Calendar" title="Calendar — schedule events per van">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span class="rr-viewseg-label">Calendar</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="issues" onclick="fleetSub('issues')" aria-label="Issues" title="Issues">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span class="rr-viewseg-label">Issues</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="rotation" onclick="fleetSub('rotation')" aria-label="Van rotation" title="Van rotation — utilization &amp; readiness">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L21 9"/><polyline points="21 4 21 9 16 9"/><path d="M20 12a8 8 0 0 1-13.7 5.6L3 15"/><polyline points="3 20 3 15 8 15"/></svg>
            <span class="rr-viewseg-label">Van Rotation</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="parts" onclick="fleetSub('parts')" aria-label="Parts" title="Parts — find, verify &amp; buy replacement parts">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>
            <span class="rr-viewseg-label">Parts</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="assign" onclick="fleetSub('assign')" aria-label="Assignments" title="Assignments — van / driver chains">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4H4v18h16V4h-4"/><rect x="8" y="2" width="8" height="4"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="8" y1="19" x2="12" y2="19"/></svg>
            <span class="rr-viewseg-label">Assignments</span>
          </button>
        </div>

        <!-- Row 2 · action bar (.rr-ab twin, schedule-rrx.css:4910-4956).
             Add van keeps #rr-fleet-add so the existing delegated handler
             (openFleetDrawer(null)) fires; Proof of Use keeps its id for
             the _flOpenProofModal delegated handler. The fleet status
             stat (painted by _flPaintTabCounts) and the shared-chrome
             host ride the right edge like Schedule's action bar. -->
        <div class="rr-ab" id="rr-fleet-ab">
          <!-- Add van · schedule-style SPLIT button. The main body opens
               the add-van drawer (the delegated #rr-fleet-add handler);
               the .rr-ab-caret segment opens a small dropdown of related
               roster actions. Mirrors the Schedule page's Build Schedule /
               Assign Fleet .rr-ab-caret split exactly — same markup + a
               view-scoped .rr-ab-menu recipe (inline-styles.css). -->
          <div class="rr-ab-split-wrap">
            <button type="button" class="rr-ab-btn" id="rr-fleet-add" aria-label="Add van" title="Add van">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Add van</span>
              <span class="rr-ab-caret" id="rr-fleet-add-caret" role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" title="More van actions">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </span>
            </button>
            <div class="rr-ab-menu" id="rr-fleet-add-menu" role="menu" aria-label="Van actions" hidden>
              <button type="button" role="menuitem" data-fl-menu="add">Add a van</button>
              <button type="button" role="menuitem" data-fl-menu="export">Export roster (CSV)</button>
            </div>
          </div>
          <!-- Print / Download Excel retired outright (operator
               2026-07-04). Proof of Use keeps its own in-modal print +
               CSV download, which still render through
               #rr-fleet-print-area below. -->
          <!-- Proof of Use · schedule-style SPLIT button. Main body opens
               the proof-of-use report modal; the caret drops a menu of the
               page's other fleet reports (van rotation / open issues). -->
          <div class="rr-ab-split-wrap">
            <button type="button" class="rr-ab-btn" id="rr-fl-proof-btn" aria-label="Proof of Use report" title="Generate a DVIC proof-of-use report for a van">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/><polyline points="9 9 11 9"/></svg>
              <span>Proof of Use</span>
              <span class="rr-ab-caret" id="rr-fl-proof-caret" role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" title="More fleet reports">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </span>
            </button>
            <div class="rr-ab-menu" id="rr-fl-proof-menu" role="menu" aria-label="Fleet reports" hidden>
              <button type="button" role="menuitem" data-fl-menu="proof">Proof of Use report</button>
              <button type="button" role="menuitem" data-fl-menu="rotation">Van rotation &amp; readiness</button>
              <button type="button" role="menuitem" data-fl-menu="issues">Open issues</button>
            </div>
          </div>
          <!-- Fleet status stat · twin of Schedule's coverage card
               (.rr-ab-coverage + the premium floating-card pass):
               van count leads, the sub line reads grounded exposure —
               red when vans are down, quiet green check when clean.
               Painted by _flPaintTabCounts; hidden until first paint. -->
          <div class="fl-ab-coverage" id="rr-fleet-coverage" aria-live="polite" hidden>
            <span class="fl-ab-coverage-main"><span class="fl-ab-cov-num" id="rr-fleet-cov-num">—</span><span class="fl-ab-cov-unit">vans</span></span>
            <span class="fl-ab-coverage-sub is-ok" id="rr-fleet-page-sub"></span>
          </div>
          <!-- Shared-chrome host · the global bell parks here while Fleet
               is active (_rrMoveChromeToFleet), and the app launcher
               auto-docks just left of the bell — the exact top-right
               arrangement the Schedule action bar has. -->
          <span class="fl-ab-chrome-host" id="rr-fleet-chrome-host"></span>
        </div>
        <!-- Hidden CSV-export trigger · the #rr-fleet-export delegated
             handler (live.js → _flExportCsv) lost its visible button when
             Print/Download retired. The "Export roster (CSV)" item in the
             Add van split menu fires this inert button so the handler
             resolves without exposing the module-local _flExportCsv. -->
        <button type="button" id="rr-fleet-export" hidden aria-hidden="true" tabindex="-1"></button>
        <script>
          // Fleet action-bar SPLIT buttons · same idea as the Schedule
          // action bar (view-schedule.frag inline script): the pill body
          // fires the primary action through the existing delegated
          // handlers, while each .rr-ab-caret segment opens a small
          // .rr-ab-menu of related actions. The caret's own listener calls
          // stopPropagation so the main button's delegated click never
          // fires when only the caret is clicked. The menu is a CSS
          // position:absolute card anchored to its .rr-ab-split-wrap.
          (function () {
            var bar = document.getElementById("rr-fleet-ab");
            if (!bar || bar.__rrSplitWired) return;
            bar.__rrSplitWired = true;
            var PAIRS = [
              { caret: "rr-fleet-add-caret", menu: "rr-fleet-add-menu" },
              { caret: "rr-fl-proof-caret",  menu: "rr-fl-proof-menu" }
            ];
            function closeAll() {
              PAIRS.forEach(function (p) {
                var m = document.getElementById(p.menu);
                var c = document.getElementById(p.caret);
                if (m) m.hidden = true;
                if (c) c.setAttribute("aria-expanded", "false");
              });
            }
            // openFleetDrawer / _flExportCsv are module-local in live.js
            // (not on window), so fire their EXISTING delegated handlers by
            // clicking the real DOM buttons instead of calling the funcs.
            // fleetSub / _flOpenProofModal ARE global, so call them direct.
            var fire = function (id) { var b = document.getElementById(id); if (b) b.click(); };
            function act(key) {
              switch (key) {
                case "add":      fire("rr-fleet-add"); break;
                case "export":   fire("rr-fleet-export"); break;
                case "proof":    if (typeof _flOpenProofModal === "function") _flOpenProofModal(); break;
                case "rotation": if (typeof fleetSub === "function") fleetSub("rotation"); break;
                case "issues":   if (typeof fleetSub === "function") fleetSub("issues"); break;
              }
            }
            PAIRS.forEach(function (p) {
              var caret = document.getElementById(p.caret);
              var menu  = document.getElementById(p.menu);
              if (!caret || !menu) return;
              var toggle = function (e) {
                e.preventDefault();
                e.stopPropagation();
                var willOpen = menu.hidden;
                closeAll();
                if (willOpen) {
                  menu.hidden = false;
                  caret.setAttribute("aria-expanded", "true");
                }
              };
              caret.addEventListener("click", toggle);
              caret.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") toggle(e);
              });
              menu.addEventListener("click", function (e) {
                var b = e.target.closest("[data-fl-menu]");
                if (!b) return;
                e.preventDefault();
                e.stopPropagation();
                closeAll();
                act(b.getAttribute("data-fl-menu"));
              });
            });
            document.addEventListener("click", function (e) {
              if (!e.target.closest(".rr-ab-split-wrap")) closeAll();
            });
            document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(); });
          })();
        </script>

        <!-- Print mount · receives a clone of the active sub-view when
             the operator hits Print. -->
        <div id="rr-fleet-print-area" aria-hidden="true"></div>

        <!-- ═══════════════════════════════════════════════════════════
             Fleet content (moved from the retired #view-fleet). Every id
             and class is preserved so the live.js loaders still resolve.
             ═══════════════════════════════════════════════════════════ -->

        <!-- Fleet Execution KPI strip · FEM (Amazon's 14-day rolling
             deploy compliance) + VORR (branded-fleet readiness rate).
             Painted by _flRenderExecKpis() in live.js from the
             fleet_execution_summary RPC (migration 0301).  Cards reuse
             the dashboard's stock .kpi-card pattern and open a
             slide-over drill-down on click — at-risk vans for FEM,
             grounded vans for VORR.
             Lives outside the sub-tabs so the slim KPI board shows on
             every Fleet view — Vehicles, Issues and Fleet calendar. -->
        <div class="fl-kpi-pills" id="rr-fleet-exec-strip" hidden>
          <div class="fl-kpi-pill" id="rr-fem-card" role="button" tabindex="0"
               aria-label="Open Fleet Execution Metric drill-down">
            <span class="fl-kpi-dot green" id="rr-fem-pip"></span>
            <span class="fl-kpi-text">
              <span class="fl-kpi-line"><span class="fl-kpi-value" id="rr-fem-value">—</span><span class="fl-kpi-frac" id="rr-fem-frac"></span><span class="fl-kpi-name">Fleet Execution · 14-day</span></span>
              <span class="fl-kpi-sub" id="rr-fem-sub">—</span>
            </span>
          </div>
          <div class="fl-kpi-pill" id="rr-vorr-card" role="button" tabindex="0"
               aria-label="Open Vehicle Operational Readiness drill-down">
            <span class="fl-kpi-dot green" id="rr-vorr-pip"></span>
            <span class="fl-kpi-text">
              <span class="fl-kpi-line"><span class="fl-kpi-value" id="rr-vorr-value">—</span><span class="fl-kpi-frac" id="rr-vorr-frac"></span><span class="fl-kpi-name">Operational Readiness · VORR</span></span>
              <span class="fl-kpi-sub" id="rr-vorr-sub">—</span>
            </span>
          </div>
        </div>
        <!-- Inline drill-down panel for the FEM / VORR KPI strip ·
             expands beneath the cards, in line with the page (not a
             side slide-over). -->
        <div id="rr-fleet-exec-detail" hidden></div>

        <!-- MY VEHICLES sub-tab — roster. The .fl-roster-bar +
             .table are siblings inside .table-wrap; the bar pins
             at top via flex:0 0 auto and the table sits inside
             .fl-table-scroll which carries overflow:auto so only
             the rows scroll (matches the Schedule view's pattern
             where chrome is locked and only the body scrolls). -->
        <div class="fl-sub active" id="fl-sub-vehicles">
        <div class="table-wrap">
          <!-- Search + filters live in the table card's header. -->
          <div class="fl-roster-bar">
            <div class="fl-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="rr-fleet-search" type="search" placeholder="Search by name, plate, VIN, driver…" autocomplete="off">
            </div>
            <div class="fl-bar-spacer"></div>
            <select id="rr-fleet-status" class="fl-filter" aria-label="Filter by status">
              <option value="">Status: All</option>
              <option value="active">Active</option>
              <option value="spare">Spare</option>
              <option value="out_of_service">Out of service</option>
              <option value="retired">Retired</option>
            </select>
            <select id="rr-fleet-station" class="fl-filter" aria-label="Filter by station">
              <option value="">Station: All</option>
            </select>
            <select id="rr-fleet-docs" class="fl-filter" aria-label="Filter by document exception">
              <option value="">Docs: All</option>
              <option value="any">Any exception</option>
              <option value="expired">Expired</option>
              <option value="expiring_soon">Expiring soon</option>
              <option value="missing">Missing</option>
            </select>
          </div>
          <div id="rr-fleet-unground-alerts"></div>
          <div class="fl-table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>VIN</th>
                <th>Ownership &amp; type</th>
                <th>Operational status</th>
                <th>Documents</th>
                <th>Driver reports</th>
                <th>Repair status</th>
              </tr>
            </thead>
            <tbody id="fleet-tbody">
              <!-- Skeleton rows · painted before loadFleetRoster()
                   replaces them.  Matches the 7-col table head rhythm
                   so the layout doesn't reflow when real vans arrive. -->
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:40px;height:40px;flex:0 0 auto;border-radius:var(--r-md)"></span><span class="rr-skel rr-skel-md" style="width:160px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:80%"></span></td><td><span class="rr-skel rr-skel-md" style="width:60%"></span></td><td><span class="rr-skel rr-skel-md" style="width:74%"></span></td><td><span class="rr-skel rr-skel-md" style="width:58%"></span></td><td><span class="rr-skel rr-skel-md" style="width:46%"></span></td><td><span class="rr-skel rr-skel-md" style="width:50%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:40px;height:40px;flex:0 0 auto;border-radius:var(--r-md)"></span><span class="rr-skel rr-skel-md" style="width:140px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:84%"></span></td><td><span class="rr-skel rr-skel-md" style="width:55%"></span></td><td><span class="rr-skel rr-skel-md" style="width:80%"></span></td><td><span class="rr-skel rr-skel-md" style="width:54%"></span></td><td><span class="rr-skel rr-skel-md" style="width:42%"></span></td><td><span class="rr-skel rr-skel-md" style="width:46%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:40px;height:40px;flex:0 0 auto;border-radius:var(--r-md)"></span><span class="rr-skel rr-skel-md" style="width:170px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:78%"></span></td><td><span class="rr-skel rr-skel-md" style="width:64%"></span></td><td><span class="rr-skel rr-skel-md" style="width:70%"></span></td><td><span class="rr-skel rr-skel-md" style="width:62%"></span></td><td><span class="rr-skel rr-skel-md" style="width:48%"></span></td><td><span class="rr-skel rr-skel-md" style="width:52%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:40px;height:40px;flex:0 0 auto;border-radius:var(--r-md)"></span><span class="rr-skel rr-skel-md" style="width:130px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:82%"></span></td><td><span class="rr-skel rr-skel-md" style="width:58%"></span></td><td><span class="rr-skel rr-skel-md" style="width:76%"></span></td><td><span class="rr-skel rr-skel-md" style="width:56%"></span></td><td><span class="rr-skel rr-skel-md" style="width:40%"></span></td><td><span class="rr-skel rr-skel-md" style="width:48%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:40px;height:40px;flex:0 0 auto;border-radius:var(--r-md)"></span><span class="rr-skel rr-skel-md" style="width:150px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:80%"></span></td><td><span class="rr-skel rr-skel-md" style="width:62%"></span></td><td><span class="rr-skel rr-skel-md" style="width:72%"></span></td><td><span class="rr-skel rr-skel-md" style="width:60%"></span></td><td><span class="rr-skel rr-skel-md" style="width:44%"></span></td><td><span class="rr-skel rr-skel-md" style="width:54%"></span></td></tr>
            </tbody>
          </table>
          </div><!-- /.fl-table-scroll -->
        </div>
        </div><!-- /#fl-sub-vehicles -->

        <!-- ISSUES sub-tab — open + completed -->
        <div class="fl-sub" id="fl-sub-issues">
          <div class="table-wrap">
            <!-- Search + filters live in the table card's header. -->
            <div class="fl-roster-bar">
              <div class="fl-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input id="rr-fleet-issues-search" type="search" placeholder="Search by van, plate, title…" autocomplete="off">
              </div>
              <div class="fl-bar-spacer"></div>
              <select id="rr-fleet-issues-state" class="fl-filter" aria-label="Filter by state">
                <option value="open">Open</option>
                <option value="completed">Completed</option>
                <option value="all">All</option>
              </select>
              <select id="rr-fleet-issues-sev" class="fl-filter" aria-label="Filter by severity">
                <option value="">Severity: All</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <table class="table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Issue</th>
                  <th>Severity</th>
                  <th>Category</th>
                  <th>Reported</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th>Repair order</th>
                </tr>
              </thead>
              <tbody id="fleet-issues-tbody"></tbody>
            </table>
          </div>
        </div>

        <!-- FLEET CALENDAR sub-tab — hosts the one shared calendar
             node (.rr-fc-shell), relocated here from #view-schedule
             by _mountFleetCalendar() so both pages drive the exact
             same calendar, state and listeners. -->
        <div class="fl-sub" id="fl-sub-calendar"></div>

        <!-- FLEET ASSIGNMENT sub-tab — hosts the one shared van /
             driver chain editor (#rr-sched-vans-chain-body), relocated
             here from #view-schedule by _mountAssignPortal() so both
             pages drive the exact same assignment portal. -->
        <div class="fl-sub" id="fl-sub-assign"></div>

        <!-- VAN ROTATION sub-tab — utilization / readiness for every
             van, with a hover-driven Van Details panel showing recent
             route history. -->
        <div class="fl-sub" id="fl-sub-rotation">
          <div class="fl-rotation-layout">
            <div class="table-wrap fl-rotation-main">
              <!-- Ownership-type filter · only Amazon-branded vans count
                   toward VORR / fleet rotation, but operators still want
                   to track every type. -->
              <div class="fl-rotation-bar">
                <label class="fl-rotation-bar-lbl" for="rr-rotation-type">Type</label>
                <select id="rr-rotation-type" class="fl-filter" aria-label="Filter by ownership / type">
                  <option value="all">All vans</option>
                  <option value="branded">Branded (counts for VORR)</option>
                  <option value="non_branded">Non-branded</option>
                  <option value="amazon_owned">Amazon-owned</option>
                  <option value="dsp_owned">DSP-owned</option>
                  <option value="rental">Rental</option>
                  <option value="leased">Leased</option>
                </select>
                <span class="fl-rotation-bar-count" id="rr-rotation-count" aria-live="polite"></span>
              </div>
              <table class="table">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>VIN</th>
                    <th>Ownership &amp; type</th>
                    <th class="fl-util-th">
                      <div class="rr-heatmap-headtitle">Utilization / Readiness<span class="rr-heatmap-info" title="Past 14 days of van usage, a marker for today, then the next 14 days of scheduled readiness. Green = used · amber = scheduled service · red = grounded."><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span></div>
                      <div class="rr-heatmap-headsub"><span class="rr-heatmap-hs hs-past">Past 14 days</span><span class="rr-heatmap-hs hs-today">TODAY</span><span class="rr-heatmap-hs hs-future hs-future-14">Next 14 days</span></div>
                    </th>
                  </tr>
                </thead>
                <tbody id="fl-rotation-tbody">
                  <tr><td colspan="4" class="fl-table-empty">Loading van rotation…</td></tr>
                </tbody>
              </table>
            </div>
            <aside class="fl-vandetails" id="fl-vandetails" aria-label="Van details">
              <div class="fl-vandetails-head">Van Details</div>
              <div class="fl-vandetails-body" id="fl-vandetails-body">
                <div class="fl-vandetails-empty">Hover over a van to see which days it ran a route and who drove it.</div>
              </div>
            </aside>
          </div>
        </div>

        <!-- PARTS sub-tab — Parts Intelligence. The whole page is rendered by
             dashboard/parts/parts-ui.js (window.RRParts.mount) into this host,
             mirroring how Calendar / Assignments mount shared nodes. -->
        <div class="fl-sub" id="fl-sub-parts"></div>
      </div>
