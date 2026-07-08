
      <div class="page">
        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="drivers"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
            <div>
              <h1 class="page-title">Roster</h1>
              <p class="page-sub" id="rr-drivers-page-sub">Manage drivers, attendance, credentials and employment records.</p>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn" id="rr-roster-export-btn" type="button" title="Export CSV">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export
            </button>
            <div class="popover-anchor" id="rr-roster-add-anchor">
              <button class="btn btn-primary" id="rr-roster-add-btn" type="button" aria-haspopup="menu" aria-expanded="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add driver
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="popover" id="rr-roster-add-menu" role="menu" aria-labelledby="rr-roster-add-btn">
                <div class="popover-section">
                  <button class="popover-item" type="button" role="menuitem" data-rr-add-action="single">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                    <span>Add a driver</span>
                  </button>
                  <button class="popover-item" type="button" role="menuitem" data-rr-add-action="bulk">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    <span>Bulk import</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Driver KPIs · the top KPI strip — same physical position
             as #rr-ob-kpis on Onboarding and #rr-sched-kpis on
             Schedule, so there's effectively one shared KPI bar
             across every page in the Schedule sidebar slot, whose
             contents swap per page. Three pills:
             Active drivers · Drivers on LOA · Avg tenure. -->
        <div id="rr-roster-kpis" class="sched-kpi-pills tcp-kpi" aria-label="Roster metrics"></div>

        <!-- Drivers sub-nav: Roster · Insights · Attendance -->
        <div class="subnav" data-rr-tabbar="drivers">
          <button class="subnav-item active" data-sub="roster" onclick="drSub('roster')">Roster</button>
          <button class="subnav-item" data-sub="licenses" onclick="drSub('licenses')">Licenses</button>
          <button class="subnav-item" data-sub="attendance" onclick="drSub('attendance')">Attendance</button>
          <button class="subnav-item" data-sub="coaching" onclick="drSub('coaching')">Coaching <span id="rr-coach-feed-badge" class="subnav-pill-badge" style="display:none">0</span></button>
          <button class="subnav-item" data-sub="availability" onclick="drSub('availability')">Availability <span id="rr-avail-req-badge" class="subnav-pill-badge" style="display:none">0</span></button>
        </div>

        <!-- ROSTER SUB-VIEW -->
        <div class="dr-subview active" id="dr-sub-roster">

        <!-- Stage tabs are kept in the DOM (hidden) so the
             filterDriversStage() handler still has buttons it can flip
             the .active class on.  The new toolbar Stage dropdown
             drives them via a click delegate. -->
        <div class="stage-tabs" data-rr-tabbar="drivers-stage" hidden>
          <button class="stage-tab active" data-stage="active" onclick="filterDriversStage(this)">Active</button>
          <button class="stage-tab" data-stage="onleave" onclick="filterDriversStage(this)">On leave</button>
          <button class="stage-tab" data-stage="inactive" onclick="filterDriversStage(this)">Inactive</button>
        </div>

        <!-- Roster KPI drill-down panel · opens when an operator clicks
             one of the clickable KPI tiles above. -->
        <div id="rr-roster-kpi-detail" style="display:none"></div>

        <!-- style block 16 extracted to inline-styles.css -->

        <div class="dr-roster-bar">
          <div class="popover-anchor">
            <button class="dr-bar-btn" id="rr-roster-filters-btn" type="button" aria-haspopup="true" aria-expanded="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              Filters
              <span class="dr-filters-badge" id="rr-roster-filters-badge" hidden></span>
            </button>
            <div class="popover popover-filters" id="rr-roster-filters-popover" role="dialog" aria-labelledby="rr-roster-filters-btn">
              <div class="popover-head">
                <div class="popover-head-title">Filters</div>
                <button class="rr-text-link" id="rr-roster-filters-reset" type="button">Reset</button>
              </div>
              <div class="popover-section">
                <label class="popover-field-label" for="rr-roster-tenure">Tenure</label>
                <select id="rr-roster-tenure" class="popover-field">
                  <option value="">Any tenure</option>
                  <option value="0-30">0–30 days</option>
                  <option value="31-90">31–90 days</option>
                  <option value="91-365">91–365 days</option>
                  <option value="365+">Over a year</option>
                </select>
              </div>
              <!-- (Score filter removed — drivers.score is not computed
                   anywhere yet. Reintroduce only when a real score source
                   ships, otherwise the filter always returns nothing.) -->
            </div>
          </div>
          <div class="dr-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" id="rr-roster-search" placeholder="Search name, email, or phone…" autocomplete="off" spellcheck="false">
          </div>
          <select id="rr-roster-stage-select" class="dr-bar-select" aria-label="Filter by stage">
            <option value="active">Active</option>
            <option value="onleave">On leave</option>
            <option value="inactive">Inactive</option>
          </select>
          <select id="rr-roster-station" class="dr-bar-select" aria-label="Filter by location">
            <option value="">All locations</option>
          </select>
          <button class="dr-bar-btn" id="rr-roster-columns-btn" type="button" aria-haspopup="true" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
            Columns
          </button>
        </div>
        <div class="dr-roster-bar-overflow">
          <a href="#" role="button" class="rr-text-link" id="rr-roster-insights-toggle" aria-pressed="false">Insights</a>
          <a href="#" role="button" class="rr-text-link" id="rr-roster-inactive-link">Inactive drivers</a>
        </div>

        <div class="dr-bulkbar" id="rr-roster-bulkbar" hidden>
          <span class="cnt" id="rr-roster-bulk-count">0 selected</span>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="rr-roster-bulk-msg">Send message</button>
          <button class="btn btn-sm btn-ghost" id="rr-roster-bulk-export">Export CSV</button>
          <button class="btn btn-sm btn-ghost" id="rr-roster-bulk-clear">Clear</button>
        </div>

        <!-- Saved-view chips · quick-filter presets above the table.
             "All" is the at-rest selection (no filter); the rest set a
             single filter combo via the click handler in live.js
             (_rrApplyRosterView). -->
        <div class="rr-roster-views" id="rr-roster-views" data-rr-no-drawer>
          <button type="button" class="rr-roster-view-chip is-active" data-rr-view="all" aria-pressed="true">All drivers</button>
          <button type="button" class="rr-roster-view-chip" data-rr-view="atrisk" aria-pressed="false" title="Active drivers with an open corrective action (Watch or At Risk)">At risk</button>
          <button type="button" class="rr-roster-view-chip" data-rr-view="newhires" aria-pressed="false" title="Hired in the last 30 days">New hires</button>
          <button type="button" class="rr-roster-view-chip" data-rr-view="onleave" aria-pressed="false" title="Drivers on leave of absence">On leave</button>
        </div>

        <!-- Roster toolbar · controls live here, not in the column header,
             so the table header only identifies columns (enterprise data-grid
             pattern). Search on the left; status filter + Add driver on the
             right. Sits inside #dr-sub-roster so it travels with the roster
             into the Onboarding / Schedule embeds. -->
        <div class="rr-roster-toolbar" id="rr-roster-toolbar" data-rr-no-drawer>
          <div class="rr-roster-toolbar-search"></div>
          <div class="rr-roster-toolbar-actions">
            <!-- Status filter + Add driver live in the top KPI strip; the
                 bell + avatar chrome is appended to the KPI strip's top-right
                 corner (by refreshDriverStatRow / _rrMoveChromeToRoster). -->
          </div>
        </div>

        <!-- Split workspace · roster list (left) + inline driver record
             pane (right). The record docks here instead of opening as a
             modal/drawer overlay, so the header, KPI strip, sub-nav and
             roster stay visible and usable while editing a driver. -->
        <div class="roster-split" id="rr-roster-split">
        <div class="roster-split-list">
        <div class="table-wrap" id="rr-roster-table-wrap" style="max-height:calc(100vh - 360px);overflow-y:auto">
          <table class="table table-clickable">
            <thead id="rr-roster-thead">
              <tr>
                <th class="dr-cb" data-rr-no-drawer></th>
                <th>Driver</th>
                <th>Risk</th>
                <th>Tenure</th>
                <th>App</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="drivers-tbody">
              <tr><td colspan="6" style="padding:0"></td></tr>
            </tbody>
          </table>
        </div>
        </div><!-- /roster-split-list -->
        <aside class="roster-record-pane" id="driver-record-mount" aria-label="Driver record" aria-live="polite">
          <div id="rr-dd-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M14 9h4"/><path d="M14 13h4"/><path d="M6 16c.8-1.4 2-2 3-2s2.2.6 3 2"/></svg>
            <div class="rr-dd-empty-title">No driver selected</div>
            <div class="rr-dd-empty-sub">Pick a driver from the roster to view and edit their record here.</div>
          </div>
        </aside>
        </div><!-- /roster-split -->

        </div><!-- /dr-sub-roster -->


        <!-- ═══════════════════════════════════════════════════════
             LICENSES SUB-VIEW — DL renewals (live)
             ═══════════════════════════════════════════════════════ -->
        <div class="dr-subview" id="dr-sub-licenses">
          <div id="lic-renewals-body"><div class="rr-loading">Loading license renewals</div></div>
        </div><!-- /dr-sub-licenses -->


        <!-- ═══════════════════════════════════════════════════════
             ATTENDANCE SUB-VIEW — Report + Policy Builder + Log
             Data source: Today's check-in flow (manual mark).
             Computed live from RR_ATTENDANCE_POLICY + RR_ATTENDANCE_LOG.
             ═══════════════════════════════════════════════════════ -->
        <!-- style block 17 extracted to inline-styles.css -->

        <div class="dr-subview" id="dr-sub-attendance">

          <!-- Tab strip removed — the report is the page. Event log is
               reachable via a small text link to the right above the
               table (matches the Insights pattern). -->
          <div class="att-tabstrip" id="rr-att-tabstrip" hidden></div>

          <!-- ─── REPORT PANE ─────────────────────────────────── -->
          <div class="att-pane active" id="att-pane-report">

            <!-- KPI insights · hidden by default, opened by the small
                 Insights text link to the right of the table. Matches
                 the Onboarding / Roster Insights pattern. -->
            <div id="rr-att-insights" style="display:none;margin-bottom:var(--s-4)">
              <div class="di-grid">
                <div class="di-card di-card-clickable" data-rr-att-kpi="rate" role="button" tabindex="0" aria-label="Open attendance rate detail">
                  <div class="di-label">Avg attendance</div>
                  <div class="di-val ok" id="att-kpi-rate">—</div>
                  <div class="di-sub" id="att-kpi-rate-sub">Callouts + no-shows ÷ scheduled</div>
                </div>
                <div class="di-card di-card-clickable" data-rr-att-kpi="vto" role="button" tabindex="0" aria-label="Open VTO detail">
                  <div class="di-label">VTO</div>
                  <div class="di-val" id="att-kpi-vto">—</div>
                  <div class="di-sub" id="att-kpi-vto-sub">Voluntary time off ÷ scheduled</div>
                </div>
                <div class="di-card di-card-clickable" data-rr-att-kpi="excused" role="button" tabindex="0" aria-label="Open Excused detail">
                  <div class="di-label">Excused</div>
                  <div class="di-val" id="att-kpi-excused">—</div>
                  <div class="di-sub" id="att-kpi-excused-sub">Absences forgiven by dispatch</div>
                </div>
              </div>
              <!-- KPI detail panel · populated by _renderAttKpiDetail.  Toggled
                   by clicking one of the three KPI cards above. -->
              <div id="rr-att-kpi-detail" style="display:none;margin-top:var(--s-3)"></div>
            </div>

            <!-- The pill-style filter row was retired (#823); the table
                 itself handles sorting + segmentation now. The Insights
                 text link sits quietly above the table. -->
            <div id="rr-att-filters" role="tablist" hidden>
              <button type="button" class="att-filter-chip active" data-rr-att-filter="all" hidden>All drivers</button>
            </div>
            <!-- Insights / Event log text links removed per operator
                 request. Kept in DOM (display:none) so the existing
                 toggle handlers don't hit null. -->
            <div style="display:none">
              <a href="#" role="button" class="rr-text-link" id="rr-att-insights-toggle" aria-pressed="false">Insights</a>
              <a href="#" role="button" class="rr-text-link" id="rr-att-log-toggle" aria-pressed="false">Event log</a>
            </div>

            <div class="table-wrap" style="max-height:calc(100vh - 360px);overflow-y:auto">
              <table class="table table-compact" id="att-report-table">
                <thead id="att-report-thead">
                  <tr>
                    <th data-rr-att-sort="driver"     style="cursor:pointer;user-select:none">Driver</th>
                    <th data-rr-att-sort="station"    style="cursor:pointer;user-select:none">Station</th>
                    <th data-rr-att-sort="status"     style="cursor:pointer;user-select:none">Standing</th>
                    <th data-rr-att-sort="points"     style="cursor:pointer;user-select:none;text-align:right">Points</th>
                    <th data-rr-att-sort="last"       style="cursor:pointer;user-select:none">Last event</th>
                    <th data-rr-att-sort="lastcoach"  style="cursor:pointer;user-select:none">Last coaching</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="att-report-body"><!-- populated by loadAttendanceLive --></tbody>
              </table>
            </div>

            <div style="margin-top:var(--s-3);font-size:var(--fs-xs);color:var(--text-muted);line-height:1.5">
              Click any row to open the driver's full attendance report.
            </div>

          </div><!-- /att-pane-report -->

          <!-- Policy builder moved to Settings → Scheduling. -->


          <!-- ─── EVENT LOG PANE ──────────────────────────────── -->
          <div class="att-pane" id="att-pane-log">
            <div class="toolbar">
              <div class="toolbar-left">
                <span class="filter-chip">Last 90 days</span>
                <span class="filter-chip">All event types</span>
                <span class="filter-chip">All drivers</span>
              </div>
            </div>
            <div class="card card-flush">
              <div class="att-log-row" style="background:var(--canvas);font-weight:600;font-size:var(--fs-xs);letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">
                <span>Date</span><span>Driver</span><span>Event</span><span class="u-right">Points</span><span></span>
              </div>
              <div id="att-log-body"><!-- populated --></div>
            </div>
            <p style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:var(--s-3);line-height:1.5">Each entry was created from Today's check-in. To exempt an event (e.g. retroactive jury duty), click "Exempt" — points and occurrences will recompute everywhere.</p>
          </div><!-- /att-pane-log -->

        </div><!-- /dr-sub-attendance -->

        <!-- COACHING — global feed across all drivers. Search keeps the
             text input; the inline severity / topic / status / sort
             dropdowns were removed in favor of click-to-sort headers. -->
        <div class="dr-subview" id="dr-sub-coaching">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--s-3);margin-bottom:var(--s-3);flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="rr-coach-cta" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Coach a driver
            </button>
            <input id="rr-coach-search" type="text" class="form-input" placeholder="Search summary, notes, driver…" style="flex:1;min-width:200px;max-width:340px"/>
          </div>
          <div id="rr-coach-feed" class="card card-flush">
            <div class="rr-loading">Loading coaching feed</div>
          </div>
        </div><!-- /dr-sub-coaching -->

        <!-- AVAILABILITY REQUESTS SUB-VIEW -->
        <div class="dr-subview" id="dr-sub-availability">

          <!-- KPI insights · hidden by default; toggled by the small
               Insights text link above the request list. -->
          <div id="rr-avail-insights" style="display:none;margin-bottom:var(--s-4)">
            <div data-rr-avail-kpis style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--s-3)"></div>
            <!-- KPI drilldown panel — populated when an operator clicks
                 one of the four cards above; closed by default + on
                 navigation away from this subview. -->
            <div id="rr-avail-kpi-detail" style="display:none;margin-top:var(--s-3)"></div>
          </div>

          <div style="display:flex;justify-content:flex-end;align-items:center;margin-bottom:var(--s-2)">
            <a href="#" role="button" class="rr-text-link" id="rr-avail-insights-toggle" aria-pressed="false">Insights</a>
          </div>

          <div class="card card-flush">
            <div style="padding:var(--s-4) var(--s-5);border-bottom:1px solid var(--border)">
              <div style="font-size:var(--fs-base);font-weight:700">Pending availability requests</div>
              <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Approvals stay in effect for 3 weeks from approval date. Tweak lead-time, auto-responses, or blackout windows in Settings → Scheduling (gear icon, top-right of the page).</div>
            </div>
            <div id="rr-avail-req-list">
              <div class="rr-loading">Loading requests</div>
            </div>
          </div>

        </div><!-- /dr-sub-availability -->

      </div>
    