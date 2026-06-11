
      <div class="page">
        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="drivers"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h2a2 2 0 0 1 2 2 5 5 0 0 1-5 5"/><path d="M7 5H5a2 2 0 0 0-2 2 5 5 0 0 0 5 5"/></svg></div>
            <div>
              <h1 class="page-title">Recognition</h1>
              <p class="page-sub" id="rr-recog-page-sub">Birthdays, work anniversaries, and custom celebrations</p>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" id="rr-recog-send-cta" type="button" title="Send a custom celebration to a driver">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2"/></svg>
              Send celebration
            </button>
          </div>
        </div>

        <!-- Sub-nav · Upcoming · History · Safety milestones -->
        <div class="subnav" data-rr-tabbar="recognition">
          <button class="subnav-item active" data-sub="upcoming" onclick="recogSub('upcoming')">Upcoming</button>
          <button class="subnav-item" data-sub="history"  onclick="recogSub('history')">Sent &amp; scheduled</button>
          <button class="subnav-item" data-sub="safety"   onclick="recogSub('safety')">Safety milestones</button>
        </div>

        <!-- style block 32 extracted to inline-styles.css -->

        <!-- UPCOMING sub-view -->
        <div class="rg-sub active" id="recog-sub-upcoming">

          <div class="rg-roster-bar">
            <div class="rg-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="rr-recog-up-search" type="search" placeholder="Search by driver name…" autocomplete="off">
            </div>
            <div class="rg-spacer"></div>
            <select id="rr-recog-window" class="rg-filter" aria-label="Window">
              <option value="30">Next 30 days</option>
              <option value="60">Next 60 days</option>
              <option value="90">Next 90 days</option>
              <option value="14">Next 14 days</option>
              <option value="7">Next 7 days</option>
            </select>
            <select id="rr-recog-kindfilter" class="rg-filter" aria-label="Filter by kind">
              <option value="">All occasions</option>
              <option value="birthday">Birthdays</option>
              <option value="work_anniversary">Work anniversaries</option>
            </select>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Occasion</th>
                  <th>Date</th>
                  <th>When</th>
                  <th style="text-align:right">Action</th>
                </tr>
              </thead>
              <tbody id="rr-recog-up-tbody">
                <tr><td colspan="5" style="padding:var(--s-6);text-align:center;color:var(--text-subtle)">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- HISTORY sub-view -->
        <div class="rg-sub" id="recog-sub-history">
          <div class="rg-roster-bar">
            <div class="rg-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="rr-recog-hist-search" type="search" placeholder="Search by driver name or title…" autocomplete="off">
            </div>
            <div class="rg-spacer"></div>
            <select id="rr-recog-status" class="rg-filter" aria-label="Filter by status">
              <option value="all">All status</option>
              <option value="sent">Sent</option>
              <option value="scheduled">Scheduled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Kind</th>
                  <th>Title</th>
                  <th>When</th>
                  <th>Status</th>
                  <th style="text-align:right">Action</th>
                </tr>
              </thead>
              <tbody id="rr-recog-hist-tbody">
                <tr><td colspan="6" style="padding:var(--s-6);text-align:center;color:var(--text-subtle)">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- SAFETY MILESTONES sub-view (stub until Performance ships) -->
        <div class="rg-sub" id="recog-sub-safety">
          <div class="rg-stub">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-subtle);margin-bottom:var(--s-3)"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
            <h3>Safety milestones · coming with Performance</h3>
            <p>This tab automatically populates with milestones like “30 days incident-free” and “First 100 routes” once the Performance scoring layer is wired up. In the meantime you can still recognise individual drivers via <strong>Send celebration</strong> at the top right — pick the <em>Safety milestone</em> kind to record one manually.</p>
          </div>
        </div>

      </div>
    