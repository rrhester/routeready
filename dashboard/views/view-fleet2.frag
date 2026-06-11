
      <!-- style block 33 (#rr-fleet2-style) extracted to inline-styles.css -->

      <div class="page">
        <!-- Header + command icon strip (Schedule chrome replica).
             Tiles are visual placeholders; nothing is wired. -->
        <div class="f2-strip" role="toolbar" aria-label="Fleet ribbon">

          <!-- Command-mode tabs · moved INSIDE the strip card and
               absolutely anchored to its top-left edge, exactly like
               Schedule's .sched-v2-cmd-tabs (position:absolute,
               top:-28px, left:0 on the position:relative strip). This
               is what puts the Fleet strip card at the SAME Y as
               Schedule's: the tabs no longer take flow space above it. -->
          <div class="f2-cmd-tabs" role="tablist" aria-label="Fleet command strip mode">
            <button class="f2-cmd-tab active" type="button" data-f2-cmd-tab="fleet" role="tab" aria-selected="true">Fleet</button>
          </div>

          <!-- Header · title + subtitle. -->
          <div class="f2-title">
            <h1 class="page-title"><span>Fleet</span></h1>
            <p class="page-sub" id="rr-fleet-page-sub">Fleet overview</p>
          </div>

          <!-- Fleet command tiles · the REAL Fleet sub-view switchers.
               Each tile calls fleetSub() (live.js), which toggles the
               matching #fl-sub-* container + active tile and runs the
               sub-view's loader. Add van reuses #rr-fleet-add so the
               existing delegated handler (openFleetDrawer(null)) fires.
               Group layout (operator-specified):
                 | Vehicles Calendar Issues | Van Rotation Assignments | Add van |
               .f2-divides on the split that STARTS each group +
               .f2-divides-end on the last one — the same pattern as
               Schedule's dividers (schedule-rrx.css:2318: border-left on
               the group-starting split, border-right on the trailing
               split, 16px margin+padding, var(--border-strong)). The first divider
               lands at the same x as Schedule's first divider because
               both pages hard-lock the title block to 240px. -->
          <div class="f2-split f2-divides">
            <button type="button" class="f2-tile active" data-sub="vehicles" onclick="fleetSub('vehicles')" aria-label="Vehicles">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="4" height="4"/><rect x="3" y="10" width="4" height="4"/><rect x="3" y="16" width="4" height="4"/><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/></svg>
              <span>Vehicles</span>
            </button>
          </div>
          <div class="f2-split">
            <button type="button" class="f2-tile" data-sub="calendar" onclick="fleetSub('calendar')" aria-label="Calendar" title="Calendar — schedule events per van">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="22"/><line x1="15" y1="9" x2="15" y2="22"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
              <span>Calendar</span>
            </button>
          </div>
          <div class="f2-split">
            <button type="button" class="f2-tile" data-sub="issues" onclick="fleetSub('issues')" aria-label="Issues">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Issues</span>
            </button>
          </div>

          <div class="f2-split f2-divides">
            <button type="button" class="f2-tile" data-sub="rotation" onclick="fleetSub('rotation')" aria-label="Van rotation" title="Van rotation — utilization &amp; readiness">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L21 9"/><polyline points="21 4 21 9 16 9"/><path d="M20 12a8 8 0 0 1-13.7 5.6L3 15"/><polyline points="3 20 3 15 8 15"/></svg>
              <span>Van Rotation</span>
            </button>
          </div>
          <div class="f2-split">
            <button type="button" class="f2-tile" data-sub="assign" onclick="fleetSub('assign')" aria-label="Assignments" title="Assignments — van / driver chains">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M8 4H4v18h16V4h-4"/><rect x="8" y="2" width="8" height="4"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="8" y1="19" x2="12" y2="19"/></svg>
              <span>Assignments</span>
            </button>
          </div>

          <div class="f2-split f2-divides f2-divides-end">
            <button type="button" class="f2-tile" id="rr-fleet-add" aria-label="Add van" title="Add van">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="3" width="18" height="18"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
              <span>Add van</span>
            </button>
          </div>

        </div>

        <!-- Print / Download mode · shown only when the "Print/Download"
             cmd-tab above the strip is active. Wired to the same handlers
             the old Fleet ribbon used (_flPrintActive / _flDownloadActive /
             _flOpenProofModal). -->
        <div class="f2-print-actions" id="rr-f2-print-actions" hidden>
          <button type="button" class="fl-ribbon-btn fl-print-btn" id="rr-fl-print-btn" aria-label="Print the active view" title="Print the active view">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            <span>Print</span>
          </button>
          <button type="button" class="fl-ribbon-btn fl-print-btn" id="rr-fl-download-btn" aria-label="Download as a spreadsheet" title="Download the active view as CSV">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Download Excel</span>
          </button>
          <button type="button" class="fl-ribbon-btn fl-print-btn" id="rr-fl-proof-btn" aria-label="Proof of Use report" title="Generate a DVIC proof-of-use report for a van">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/><polyline points="9 9 11 9"/></svg>
            <span>Proof of Use</span>
          </button>
        </div>

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
              <span class="fl-kpi-sub" id="rr-fem-sub">Loading…</span>
            </span>
          </div>
          <div class="fl-kpi-pill" id="rr-vorr-card" role="button" tabindex="0"
               aria-label="Open Vehicle Operational Readiness drill-down">
            <span class="fl-kpi-dot green" id="rr-vorr-pip"></span>
            <span class="fl-kpi-text">
              <span class="fl-kpi-line"><span class="fl-kpi-value" id="rr-vorr-value">—</span><span class="fl-kpi-frac" id="rr-vorr-frac"></span><span class="fl-kpi-name">Operational Readiness · VORR</span></span>
              <span class="fl-kpi-sub" id="rr-vorr-sub">Loading…</span>
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
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:32px;height:24px;flex:0 0 auto;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:160px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:80%"></span></td><td><span class="rr-skel rr-skel-md" style="width:60%"></span></td><td><span class="rr-skel rr-skel-md" style="width:74%"></span></td><td><span class="rr-skel rr-skel-md" style="width:58%"></span></td><td><span class="rr-skel rr-skel-md" style="width:46%"></span></td><td><span class="rr-skel rr-skel-md" style="width:50%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:32px;height:24px;flex:0 0 auto;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:140px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:84%"></span></td><td><span class="rr-skel rr-skel-md" style="width:55%"></span></td><td><span class="rr-skel rr-skel-md" style="width:80%"></span></td><td><span class="rr-skel rr-skel-md" style="width:54%"></span></td><td><span class="rr-skel rr-skel-md" style="width:42%"></span></td><td><span class="rr-skel rr-skel-md" style="width:46%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:32px;height:24px;flex:0 0 auto;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:170px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:78%"></span></td><td><span class="rr-skel rr-skel-md" style="width:64%"></span></td><td><span class="rr-skel rr-skel-md" style="width:70%"></span></td><td><span class="rr-skel rr-skel-md" style="width:62%"></span></td><td><span class="rr-skel rr-skel-md" style="width:48%"></span></td><td><span class="rr-skel rr-skel-md" style="width:52%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:32px;height:24px;flex:0 0 auto;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:130px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:82%"></span></td><td><span class="rr-skel rr-skel-md" style="width:58%"></span></td><td><span class="rr-skel rr-skel-md" style="width:76%"></span></td><td><span class="rr-skel rr-skel-md" style="width:56%"></span></td><td><span class="rr-skel rr-skel-md" style="width:40%"></span></td><td><span class="rr-skel rr-skel-md" style="width:48%"></span></td></tr>
              <tr class="fl-skel-row"><td><div class="fl-skel-veh"><span class="rr-skel" style="width:32px;height:24px;flex:0 0 auto;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:150px"></span></div></td><td><span class="rr-skel rr-skel-md" style="width:80%"></span></td><td><span class="rr-skel rr-skel-md" style="width:62%"></span></td><td><span class="rr-skel rr-skel-md" style="width:72%"></span></td><td><span class="rr-skel rr-skel-md" style="width:60%"></span></td><td><span class="rr-skel rr-skel-md" style="width:44%"></span></td><td><span class="rr-skel rr-skel-md" style="width:54%"></span></td></tr>
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
                  <tr><td colspan="4" style="padding:var(--s-8);text-align:center;color:var(--text-subtle)">Loading van rotation…</td></tr>
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
      </div>
    