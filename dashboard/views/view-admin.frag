
      <div class="page">
        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="admin">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
            </div>
            <div>
              <h1 class="page-title">DSP Account Management</h1>
              <p class="page-sub">Manage all RouteReady DSP clients and user access.</p>
            </div>
          </div>
          <div style="display:flex;gap:var(--s-2)">
            <button class="btn btn-ghost" type="button" onclick="openClientErrors()" title="Dashboard JS errors captured in production">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Errors
            </button>
            <button class="btn btn-ghost" id="rr-admin-invite-user" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
              Invite user
            </button>
            <button class="btn btn-primary" id="rr-admin-add-dsp" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add DSP client
            </button>
          </div>
        </div>

        <!-- Stats overview · 4 metric cards backed by admin_kpis(),
             enriched with live context lines computed client-side from
             the in-memory DSP list (_adminRenderInsights). -->
        <div class="kpi-grid">
          <div class="kpi-card" data-rr-admin-stat="total">
            <div class="kpi-label">Total DSP accounts</div>
            <div class="kpi-value" data-rr-admin-stat-value>—</div>
            <div class="kpi-sub" data-rr-admin-substat="total">All registered DSPs</div>
          </div>
          <div class="kpi-card" data-rr-admin-stat="active">
            <div class="kpi-label"><span class="kpi-pip green"></span>Active</div>
            <div class="kpi-value" data-rr-admin-stat-value>—</div>
            <div class="rr-kpi-bar" aria-hidden="true"><span data-rr-admin-bar="active"></span></div>
            <div class="kpi-sub" data-rr-admin-substat="active">Operating normally</div>
          </div>
          <div class="kpi-card" data-rr-admin-stat="pending">
            <div class="kpi-label"><span class="kpi-pip amber"></span>Pending onboarding</div>
            <div class="kpi-value" data-rr-admin-stat-value>—</div>
            <div class="kpi-sub" data-rr-admin-substat="pending">Awaiting owner signup</div>
          </div>
          <div class="kpi-card" data-rr-admin-stat="suspended">
            <div class="kpi-label"><span class="kpi-pip red"></span>Suspended</div>
            <div class="kpi-value" data-rr-admin-stat-value>—</div>
            <div class="kpi-sub" data-rr-admin-substat="suspended">Disabled by admin</div>
          </div>
        </div>

        <!-- ── Control-center band · Needs-attention queue + portfolio
             snapshot.  Both panels are painted by _adminRenderInsights()
             from the same in-memory list that feeds the table, so they
             stay in lock-step with any filter-free view of the data. -->
        <div class="rr-cc-band">
          <section class="rr-cc-panel rr-cc-panel--attention">
            <div class="rr-cc-panel__head">
              <div>
                <h3 class="rr-cc-panel__title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  Needs attention
                </h3>
                <p class="rr-cc-panel__sub">DSPs with a signal worth a look — click to open.</p>
              </div>
              <span class="rr-cc-badge" id="rr-admin-attention-count" hidden>0</span>
            </div>
            <div id="rr-admin-attention" class="rr-cc-attention-list">
              <div class="rr-cc-skel"><span></span><span></span><span></span></div>
            </div>
          </section>

          <section class="rr-cc-panel rr-cc-panel--portfolio">
            <div class="rr-cc-panel__head">
              <div>
                <h3 class="rr-cc-panel__title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7" rx="1"/><rect x="12" y="6" width="3" height="11" rx="1"/><rect x="17" y="13" width="3" height="4" rx="1"/></svg>
                  Portfolio
                </h3>
                <p class="rr-cc-panel__sub">Fleet size and plan mix across all DSPs.</p>
              </div>
            </div>
            <div id="rr-admin-portfolio" class="rr-cc-portfolio">
              <div class="rr-cc-skel"><span></span><span></span></div>
            </div>
          </section>
        </div>

        <div class="section">
          <div class="section-head">
            <div>
              <h3 class="section-title">DSP accounts</h3>
              <p class="section-sub">Search, filter, and manage all DSP clients.</p>
            </div>
            <div id="rr-admin-row-count" class="section-sub" style="font-variant-numeric:tabular-nums">—</div>
          </div>

          <!-- Toolbar · search + filters + sort + export -->
          <div class="rr-admin-toolbar">
            <div class="rr-admin-toolbar__search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="search" id="rr-admin-search" placeholder="Search DSP, owner, station code, email…" autocomplete="off" />
            </div>
            <select class="rr-admin-toolbar__select" id="rr-admin-filter-status" aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="suspended">Suspended</option>
            </select>
            <select class="rr-admin-toolbar__select" id="rr-admin-filter-plan" aria-label="Filter by plan">
              <option value="">All plans</option>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="enterprise">Enterprise</option>
            </select>
            <select class="rr-admin-toolbar__select" id="rr-admin-sort" aria-label="Sort by">
              <option value="created_at:desc">Newest first</option>
              <option value="created_at:asc">Oldest first</option>
              <option value="name:asc">Name (A→Z)</option>
              <option value="name:desc">Name (Z→A)</option>
              <option value="driver_count:desc">Most drivers</option>
              <option value="last_active_at:desc">Recently active</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="rr-admin-export" type="button" title="Export the filtered list as CSV">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export CSV
            </button>
          </div>

          <!-- Table -->
          <div class="table-wrap rr-admin-table-wrap">
            <div class="table-wrap-scroll">
              <table class="table rr-admin-table">
                <thead>
                  <tr>
                    <th>DSP</th>
                    <th>Owner</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Status</th>
                    <th class="u-right">Drivers</th>
                    <th class="u-right">Routes</th>
                    <th>Plan</th>
                    <th>Modules</th>
                    <th>Last active</th>
                    <th style="text-align:right;width:48px">&nbsp;</th>
                  </tr>
                </thead>
                <tbody id="rr-admin-tbody">
                  <!-- Rows are rendered by _renderPlatformAdminTable in live.js.
                       Initial state: skeleton rows so the toolbar isn't sitting
                       on a blank canvas while admin_list_dsps() is in flight. -->
                  <tr><td colspan="11" class="rr-admin-skel"><span></span></td></tr>
                  <tr><td colspan="11" class="rr-admin-skel"><span></span></td></tr>
                  <tr><td colspan="11" class="rr-admin-skel"><span></span></td></tr>
                </tbody>
              </table>
            </div>
            <!-- Pagination footer -->
            <div class="rr-admin-pagination" id="rr-admin-pagination" hidden>
              <div class="rr-admin-pagination__summary" id="rr-admin-pagination-summary"></div>
              <div class="rr-admin-pagination__controls">
                <button class="btn btn-ghost btn-sm" id="rr-admin-page-prev" type="button" disabled>‹ Prev</button>
                <span class="rr-admin-pagination__page" id="rr-admin-page-label">Page 1</span>
                <button class="btn btn-ghost btn-sm" id="rr-admin-page-next" type="button" disabled>Next ›</button>
              </div>
            </div>
            <!-- Empty state -->
            <div class="rr-admin-empty" id="rr-admin-empty" hidden>
              <div class="rr-admin-empty__icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              </div>
              <div class="rr-admin-empty__title">No DSP accounts match</div>
              <div class="rr-admin-empty__sub" id="rr-admin-empty-sub">Try clearing filters or search.</div>
              <button class="btn btn-primary btn-sm" id="rr-admin-empty-cta" type="button">+ Add DSP client</button>
            </div>
          </div>
        </div>

        <!-- ── RouteReady Support inbox · centralized DSP support conversations -->
        <div class="section" id="rr-supadm-section" style="margin-top:var(--s-6)">
          <div class="section-head">
            <div>
              <h3 class="section-title">RouteReady Support inbox</h3>
              <p class="section-sub">Conversations with DSPs — open, search, and respond from one place.</p>
            </div>
            <div id="rr-supadm-count" class="section-sub" style="font-variant-numeric:tabular-nums">—</div>
          </div>
          <div class="rr-admin-toolbar">
            <div class="rr-admin-toolbar__search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="search" id="rr-supadm-search" placeholder="Search DSP name, short code, or message text…" autocomplete="off"/>
            </div>
            <select class="rr-admin-toolbar__select" id="rr-supadm-filter" aria-label="Filter conversations">
              <option value="all">All conversations</option>
              <option value="unread">Unread only</option>
              <option value="active">Active (last 30 days)</option>
            </select>
          </div>
          <div id="rr-supadm-shell" style="display:grid;grid-template-columns:320px 1fr;border:1px solid var(--border);border-radius:var(--r-xl);overflow:hidden;background:var(--surface);height:640px">
            <div id="rr-supadm-list" style="border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column"><div class="rr-loading" style="padding:var(--s-6)">Loading conversations…</div></div>
            <div id="rr-supadm-conv" style="position:relative;display:flex;flex-direction:column;background:var(--canvas)"><div style="margin:auto;color:var(--text-subtle);font-size:var(--fs-sm);padding:40px;text-align:center;max-width:380px"><div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:var(--r-xl);background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:20px;margin-bottom:10px">R</div><div style="font-size:var(--fs-md);font-weight:600;color:var(--text);margin-bottom:4px">Pick a DSP to open their thread</div><div>Conversations are listed left-most by most-recent activity; unread DSP messages rise to the top with a badge.</div></div></div>
          </div>
        </div>
      </div>
    