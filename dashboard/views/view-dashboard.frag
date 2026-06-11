
      <div class="page">

        <!-- First-run welcome zone · revealed by live.js for newly-
             activated DSPs (within 14 days of activation, until the
             owner dismisses).  Hidden by default so existing
             workspaces never see it. -->
        <div class="rr-firstrun" id="rr-firstrun" hidden>
          <div class="rr-firstrun-banner">
            <div class="rr-firstrun-banner-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div class="rr-firstrun-banner-text">
              <div class="rr-firstrun-banner-title">Welcome to RouteReady<span id="rr-firstrun-name-suffix"></span>.</div>
              <div class="rr-firstrun-banner-sub">Your workspace is live. Four quick steps below get you up and running — about 20 minutes.</div>
            </div>
            <button class="rr-firstrun-dismiss" id="rr-firstrun-dismiss" type="button" aria-label="Dismiss welcome message">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <!-- Get-started card · 4 quick-link tiles -->
          <div class="rr-firstrun-card">
            <div class="rr-firstrun-card-head">
              <h3 class="section-title">Get RouteReady running</h3>
              <p class="section-sub">Each step opens the right page — finish them in any order.</p>
            </div>
            <div class="rr-firstrun-tiles">
              <!-- Steps 1–3 carry data-fr-step: _initFirstRunZone checks
                   the matching table and flips the tile to .done when
                   real data exists — the checklist tracks actual setup
                   progress, not clicks. Step 4 has no reliable data
                   signal (team membership is RLS-scoped), so it stays a
                   plain link. -->
              <button type="button" class="rr-firstrun-tile" data-fr-step="drivers" onclick="window._rrGotoSubIntent={view:'schedule',sub:'roster'};goto('schedule')">
                <span class="rr-firstrun-tile-num">1</span>
                <div class="rr-firstrun-tile-text">
                  <div class="rr-firstrun-tile-title">Add your drivers</div>
                  <div class="rr-firstrun-tile-sub">Start the roster.  Drivers also self-onboard via the PWA.</div>
                </div>
                <svg class="rr-firstrun-tile-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button type="button" class="rr-firstrun-tile" data-fr-step="vans" onclick="goto('fleet2')">
                <span class="rr-firstrun-tile-num">2</span>
                <div class="rr-firstrun-tile-text">
                  <div class="rr-firstrun-tile-title">Add your vans</div>
                  <div class="rr-firstrun-tile-sub">Track service, inspections, and assignments.</div>
                </div>
                <svg class="rr-firstrun-tile-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button type="button" class="rr-firstrun-tile" data-fr-step="schedule" onclick="goto('schedule')">
                <span class="rr-firstrun-tile-num">3</span>
                <div class="rr-firstrun-tile-text">
                  <div class="rr-firstrun-tile-title">Build your first week</div>
                  <div class="rr-firstrun-tile-sub">Assign shifts by hand or let Smart Fill draft it.</div>
                </div>
                <svg class="rr-firstrun-tile-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button type="button" class="rr-firstrun-tile" onclick="goto('settings')">
                <span class="rr-firstrun-tile-num">4</span>
                <div class="rr-firstrun-tile-text">
                  <div class="rr-firstrun-tile-title">Invite a dispatcher</div>
                  <div class="rr-firstrun-tile-sub">From Settings → Team.  Magic-link invites.</div>
                </div>
                <svg class="rr-firstrun-tile-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          </div>
        </div>

        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="dashboard"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
            <div>
              <h1 class="page-title">Today's Plan</h1>
              <p class="page-sub" id="rr-today-date">—</p>
            </div>
          </div>
          <!-- Day nav lives inside #rr-today-plan-shell as .tp-daystrip
               so it travels with the shell into the schedule's Today
               sub-view. See _tpRenderDayStrip() in live.js. -->
        </div>

        <div id="rr-today-plan-anchor">
          <div id="rr-today-plan-shell">
            <div class="rr-plan-skel" aria-hidden="true" style="padding:var(--s-4) 0">
              <div class="rrx-skeleton rrx-skeleton--text" style="width:34%"></div>
              <div class="rrx-skeleton rrx-skeleton--block" style="height:54px;margin-top:12px"></div>
              <div class="rrx-skeleton rrx-skeleton--block" style="height:54px;margin-top:8px"></div>
              <div class="rrx-skeleton rrx-skeleton--block" style="height:54px;margin-top:8px"></div>
            </div>
          </div>
        </div>

      </div>
    