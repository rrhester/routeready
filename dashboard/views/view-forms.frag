
      <div class="page">
        <!-- style block 38 extracted to inline-styles.css -->
        <!-- TCP chrome · matches Schedule / Fleet / Workspaces.
             Title now correctly reads "Workflows" (the legacy
             .page-header had a stale "Workspaces" label). -->
        <div class="wf-cmd-shell">
          <div class="wf-cmd-tabs" role="tablist" aria-label="Workflows mode">
            <!-- Unified strip · all non-local tabs navigate back to
                 the Schedule hub. Workflows + Print stay as local
                 mode-switches. -->
            <button class="wf-cmd-tab" type="button" data-wf-cmd-tab="schedule" role="tab" aria-selected="false">Schedule</button>
            <button class="wf-cmd-tab" type="button" data-wf-cmd-tab="onboarding" role="tab" aria-selected="false">Onboarding</button>
            <button class="wf-cmd-tab" type="button" data-wf-cmd-tab="fleet" role="tab" aria-selected="false">Fleet</button>
            <button class="wf-cmd-tab active" type="button" data-wf-cmd-tab="workflows" role="tab" aria-selected="true">Workflows</button>
            <button class="wf-cmd-tab" type="button" data-wf-cmd-tab="print" role="tab" aria-selected="false">Print/Download</button>
          </div>
          <div class="wf-strip">
            <div class="wf-strip-title">
              <h1 class="page-title">Workflows</h1>
              <p class="page-sub" id="rr-forms-page-sub">Forms, automation, and recurring checklists</p>
            </div>
            <div class="wf-strip-actions">
              <div class="wf-strip-group" role="group" aria-label="Sections">
                <button type="button" class="wf-strip-tile active" title="Forms">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>
                  <span>Forms</span>
                </button>
                <button type="button" class="wf-strip-tile" onclick="goto('checklists')" title="Checklists">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><polyline points="8 9 10 11 13 8"/><polyline points="8 14 10 16 13 13"/><line x1="15" y1="9" x2="17" y2="9"/><line x1="15" y1="14" x2="17" y2="14"/></svg>
                  <span>Checklists</span>
                </button>
              </div>
              <div class="wf-strip-group" role="group" aria-label="Actions">
                <button type="button" class="wf-strip-tile" id="rr-forms-import-btn" title="Import a form definition">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <span>Import</span>
                </button>
                <button type="button" class="wf-strip-tile" data-rr-install-concerns-form title="Install the Vehicle Concerns form so drivers can proactively report damage, mechanical issues, and other van concerns. Submissions auto-flag the van on the Fleet roster.">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18l-8-4-8 4z"/></svg>
                  <span>Install</span>
                </button>
                <button type="button" class="wf-strip-tile" data-rr-form-new title="Build a new form">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  <span>Build</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- TCP KPI strip · joined-pill row matching Schedule. The
             value spans below still carry the original ids so
             live.js's KPI renderer keeps working unchanged. -->
        <div class="wf-kpis" role="group" aria-label="Workflows metrics">
          <div class="wf-kpi">
            <span class="wf-kpi-dot"></span>
            <span class="wf-kpi-value" id="rr-forms-kpi-published">—</span>
            <span class="wf-kpi-name">Forms published</span>
          </div>
          <div class="wf-kpi">
            <span class="wf-kpi-dot"></span>
            <span class="wf-kpi-value" id="rr-forms-kpi-subs">—</span>
            <span class="wf-kpi-name">Submissions this week</span>
          </div>
          <div class="wf-kpi">
            <span class="wf-kpi-dot"></span>
            <span class="wf-kpi-value" id="rr-forms-kpi-rate">—</span>
            <span class="wf-kpi-name">Completion rate · 7d</span>
          </div>
          <div class="wf-kpi">
            <span class="wf-kpi-dot"></span>
            <span class="wf-kpi-value" id="rr-forms-kpi-drivers">—</span>
            <span class="wf-kpi-name">Drivers completed · 7d</span>
          </div>
        </div>

        <!-- Legacy .forms-kpi card row removed · the TCP KPI strip
             above carries the same IDs (rr-forms-kpi-published /
             -subs / -rate / -drivers) so live.js's KPI renderer
             keeps working without changes. -->


        <div class="forms-shell">
          <aside class="forms-side">
            <div class="forms-side-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="search" id="rr-forms-side-search" placeholder="Search forms" autocomplete="off" spellcheck="false">
            </div>
            <div class="forms-side-section">Forms</div>
            <button class="forms-side-item active" data-rr-forms-scope="active" onclick="formsTab(this,'my')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
              My forms <span class="count" id="rr-forms-count-my">0</span>
            </button>
            <button class="forms-side-item" data-rr-forms-scope="all" onclick="formsTab(this,'my')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
              All forms <span class="count" id="rr-forms-count-all">0</span>
            </button>
            <button class="forms-side-item" data-rr-forms-scope="archived" onclick="formsTab(this,'my')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
              Archived <span class="count" id="rr-forms-count-archived">0</span>
            </button>
            <button class="forms-side-item" onclick="formsTab(this,'subm')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              Submissions
            </button>
            <div class="forms-side-section" id="rr-forms-cat-section" hidden>Categories</div>
            <div id="rr-forms-cat-list"></div>
          </aside>

          <main>
            <div class="forms-tab" id="forms-tab-my">
              <div class="forms-toolbar">
                <select id="rr-forms-sort" class="forms-toolbar-select" aria-label="Sort forms">
                  <option value="updated-desc">Newest first</option>
                  <option value="updated-asc">Oldest first</option>
                  <option value="title-asc">Title · A–Z</option>
                  <option value="title-desc">Title · Z–A</option>
                </select>
                <div class="forms-view-toggle" role="group" aria-label="View mode">
                  <button class="forms-view-btn active" type="button" data-rr-forms-view="grid" aria-label="Grid view" title="Grid view">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                  </button>
                  <button class="forms-view-btn" type="button" data-rr-forms-view="list" aria-label="List view" title="List view">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                  </button>
                </div>
              </div>
              <div class="forms-grid" id="rr-forms-grid">
                <!-- Skeleton cards mirroring the .form-card shape so
                     the grid doesn't render empty before the list
                     RPC lands. -->
                <div class="form-skel-card"><span class="rr-skel rr-skel-sm" style="width:60px;align-self:flex-start;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:64%"></span><span class="rr-skel rr-skel-sm" style="width:88%"></span></div>
                <div class="form-skel-card"><span class="rr-skel rr-skel-sm" style="width:60px;align-self:flex-start;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:56%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span></div>
                <div class="form-skel-card"><span class="rr-skel rr-skel-sm" style="width:60px;align-self:flex-start;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:70%"></span><span class="rr-skel rr-skel-sm" style="width:92%"></span></div>
                <div class="form-skel-card"><span class="rr-skel rr-skel-sm" style="width:60px;align-self:flex-start;border-radius:var(--r-sm)"></span><span class="rr-skel rr-skel-md" style="width:50%"></span><span class="rr-skel rr-skel-sm" style="width:74%"></span></div>
              </div>
              <div class="rr-empty-inline" id="rr-forms-empty" style="display:none">No forms yet. Click <strong>Build a form</strong> to create your first one.</div>
            </div>

            <div class="forms-tab" id="forms-tab-subm" style="display:none">
              <div id="rr-subm-list"><div class="rr-empty-inline">Submissions will appear here once drivers start filling out published forms.</div></div>
            </div>
          </main>
          <!-- Right rail (Recent submissions / Form activity /
               Need-help card) removed per operator request. The
               main column now spans the full width of the workflow
               shell. -->
        </div>
      </div>
    