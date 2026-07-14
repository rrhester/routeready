
      <div class="page">
        <!-- ═══════════════════════════════════════════════════════════
             Repair Center · Phase 2 (repair-case foundation).
             Chrome is the Schedule/Fleet recipe: a .rr-viewseg tab row
             over a .rr-ab action bar (both restyled for #view-repair in
             inline-styles.css — the recipes are view-scoped, so each
             page carries its own copy, exactly like #rr-fleet-viewseg).
             All behavior lives in dashboard/repair/repair-ui.js
             (window.RRRepair), the parts-ui.js module pattern — NOT in
             live.js.
             ═══════════════════════════════════════════════════════════ -->

        <!-- Row 1 · view tabs.  Each tab calls RRRepair.sub() which
             toggles the matching .rp-sub container + active tab. -->
        <div class="rr-viewseg" id="rr-repair-viewseg" role="tablist" aria-label="Repair Center views">
          <button type="button" class="rr-viewseg-btn active" role="tab" aria-selected="true" data-sub="overview"
                  onclick="if(window.RRRepair)RRRepair.sub('overview')" aria-label="Overview" title="Overview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
            <span class="rr-viewseg-label">Overview</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="queue"
                  onclick="if(window.RRRepair)RRRepair.sub('queue')" aria-label="Repair Queue" title="Repair Queue — every open case">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>
            <span class="rr-viewseg-label">Repair Queue</span>
            <span class="rp-tab-count" id="rr-repair-tab-count" hidden>0</span>
          </button>
          <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-sub="shops"
                  onclick="if(window.RRRepair)RRRepair.sub('shops')" aria-label="Shop Directory" title="Shop Directory — repair shops, contacts &amp; performance">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg>
            <span class="rr-viewseg-label">Shop Directory</span>
          </button>
        </div>

        <!-- Row 2 · action bar (.rr-ab twin). -->
        <div class="rr-ab" id="rr-repair-ab">
          <button type="button" class="rr-ab-btn rp-ab-primary" id="rr-repair-new" aria-label="New repair case"
                  title="Open a repair case for a van" onclick="if(window.RRRepair)RRRepair.newCase()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>New repair case</span>
          </button>
          <button type="button" class="rr-ab-btn" id="rr-repair-refresh" aria-label="Refresh"
                  title="Refresh cases" onclick="if(window.RRRepair)RRRepair.loadView(true)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L21 9"/><polyline points="21 4 21 9 16 9"/><path d="M20 12a8 8 0 0 1-13.7 5.6L3 15"/><polyline points="3 20 3 15 8 15"/></svg>
            <span>Refresh</span>
          </button>
          <!-- Vans-out stat · twin of Fleet's coverage card, painted by
               RRRepair from repair_center_summary(). -->
          <div class="rp-ab-coverage" id="rr-repair-coverage" aria-live="polite" hidden>
            <span class="rp-ab-cov-main"><span class="rp-ab-cov-num" id="rr-repair-cov-num">—</span><span class="rp-ab-cov-unit">vans out</span></span>
            <span class="rp-ab-coverage-sub" id="rr-repair-cov-sub"></span>
          </div>
          <span class="rp-ab-chrome-host" id="rr-repair-chrome-host"></span>
        </div>

        <!-- Summary strip · compact operational pills (Fleet KPI-pill
             pattern), visible on every sub-view.  Painted by RRRepair;
             hidden until first paint so there's no dead chrome. -->
        <div class="rp-kpi-pills" id="rr-repair-sum" hidden></div>

        <!-- OVERVIEW sub-view · needs-attention queue + activity -->
        <div class="rp-sub active" id="rp-sub-overview">
          <div class="rp-overview-grid">
            <div class="table-wrap rp-attention-wrap">
              <div class="rp-card-head">
                <span class="rp-card-title">Needs attention</span>
                <span class="rp-card-spacer"></span>
                <button type="button" class="rp-link-btn" onclick="if(window.RRRepair)RRRepair.sub('queue')">Open queue →</button>
              </div>
              <table class="table">
                <tbody id="rr-repair-attention">
                  <tr><td class="rp-table-empty">Loading repair cases…</td></tr>
                </tbody>
              </table>
            </div>
            <div class="table-wrap rp-activity-wrap">
              <div class="rp-card-head">
                <span class="rp-card-title">Activity</span>
              </div>
              <div class="rp-activity" id="rr-repair-activity">
                <div class="rp-table-empty">Loading activity…</div>
              </div>
            </div>
          </div>
        </div>

        <!-- REPAIR QUEUE sub-view · the working list -->
        <div class="rp-sub" id="rp-sub-queue">
          <div class="table-wrap">
            <div class="rp-toolbar">
              <div class="rp-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input id="rr-repair-search" type="search" placeholder="Unit, VIN, case #, WO #, shop…" autocomplete="off" aria-label="Search repair cases">
              </div>
              <div class="rp-bar-spacer"></div>
              <label class="rp-check" for="rr-repair-f-grounded"><input type="checkbox" id="rr-repair-f-grounded">Grounded</label>
              <label class="rp-check" for="rr-repair-f-overdue"><input type="checkbox" id="rr-repair-f-overdue">Overdue</label>
              <select id="rr-repair-f-stage" class="rp-filter" aria-label="Filter by stage">
                <option value="">Stage: All</option>
              </select>
              <select id="rr-repair-f-station" class="rp-filter" aria-label="Filter by station">
                <option value="">Station: All</option>
              </select>
              <select id="rr-repair-f-open" class="rp-filter" aria-label="Open or all cases">
                <option value="open">Open cases</option>
                <option value="all">All cases</option>
              </select>
            </div>
            <div class="rp-table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Vehicle</th>
                    <th>Issue</th>
                    <th>Stage</th>
                    <th>Availability</th>
                    <th>Shop / WO#</th>
                    <th>Promised</th>
                    <th class="num">Down</th>
                    <th class="num">Est. / Appr.</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody id="rr-repair-tbody">
                  <tr class="rp-skel-row"><td colspan="10"><span class="rr-skel rr-skel-md"></span></td></tr>
                  <tr class="rp-skel-row"><td colspan="10"><span class="rr-skel rr-skel-md"></span></td></tr>
                  <tr class="rp-skel-row"><td colspan="10"><span class="rr-skel rr-skel-md"></span></td></tr>
                  <tr class="rp-skel-row"><td colspan="10"><span class="rr-skel rr-skel-md"></span></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- SHOP DIRECTORY sub-view · vendors + Repair Center activity -->
        <div class="rp-sub" id="rp-sub-shops">
          <div class="table-wrap">
            <div class="rp-toolbar">
              <button type="button" class="rp-btn rp-btn-primary" id="rr-repair-shop-add"
                      onclick="if(window.RRRepair)RRRepair.newShop()">+ Add shop</button>
              <div class="rp-bar-spacer"></div>
              <span class="rp-cell-sub" id="rr-repair-shops-count"></span>
            </div>
            <div class="rp-table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>Shop</th>
                    <th>Type &amp; services</th>
                    <th>Contact</th>
                    <th class="num">Response</th>
                    <th class="num">Quotes</th>
                    <th class="num">Open</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="rr-repair-shops-tbody">
                  <tr class="rp-skel-row"><td colspan="8"><span class="rr-skel rr-skel-md"></span></td></tr>
                  <tr class="rp-skel-row"><td colspan="8"><span class="rr-skel rr-skel-md"></span></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
