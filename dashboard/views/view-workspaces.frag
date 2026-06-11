
      <div class="page">
        <!-- style block 36 extracted to inline-styles.css -->
        <!-- style block 37 extracted to inline-styles.css -->
        <!-- TCP chrome · cmd-tabs above the strip, strip card with
             title + action tiles, KPI strip below. The legacy
             .page-header + .subnav were replaced by this block on
             2026-05-26 to match Schedule / Onboarding / Fleet /
             Fleet Bridge. The Forms / Workflows / Checklists nav
             targets stayed the same (goto handlers preserved). -->
        <div class="ws-cmd-shell">
          <div class="ws-cmd-tabs" role="tablist" aria-label="Workspaces mode">
            <button class="ws-cmd-tab active" type="button" data-ws-cmd-tab="workflows" role="tab" aria-selected="true">Workflows</button>
            <button class="ws-cmd-tab" type="button" data-ws-cmd-tab="print" role="tab" aria-selected="false">Print/Download</button>
          </div>
          <div class="ws-strip">
            <div class="ws-strip-title">
              <h1 class="page-title">Workspaces</h1>
              <p class="page-sub">Operational boards, forms, and recurring checklists</p>
            </div>
            <div class="ws-strip-actions" role="group" aria-label="Workspaces sections">
              <button type="button" class="ws-strip-tile" onclick="goto('forms')" title="Forms">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>
                <span>Forms</span>
              </button>
              <button type="button" class="ws-strip-tile active" onclick="goto('workspaces')" title="Workflows">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                <span>Workflows</span>
              </button>
              <button type="button" class="ws-strip-tile" onclick="goto('checklists')" title="Checklists">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><polyline points="8 9 10 11 13 8"/><polyline points="8 14 10 16 13 13"/><line x1="15" y1="9" x2="17" y2="9"/><line x1="15" y1="14" x2="17" y2="14"/></svg>
                <span>Checklists</span>
              </button>
            </div>
          </div>
        </div>
        <!-- KPI strip · empty placeholder for now; populated later
             via live.js when workspace counts are wired up. -->
        <div id="rr-ws-kpis" class="ws-kpis is-empty" role="group" aria-label="Workspace metrics"></div>
        <div id="rr-ws-root">
          <!-- Skeleton workspaces grid — six card placeholders so
               the layout doesn't reflow when the boards arrive. -->
          <div class="ws-skel-grid" aria-busy="true">
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:60%"></span><span class="rr-skel rr-skel-sm" style="width:90%"></span><span class="rr-skel rr-skel-sm" style="width:74%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:55%"></span><span class="rr-skel rr-skel-sm" style="width:85%"></span><span class="rr-skel rr-skel-sm" style="width:68%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:68%"></span><span class="rr-skel rr-skel-sm" style="width:92%"></span><span class="rr-skel rr-skel-sm" style="width:72%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:50%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span><span class="rr-skel rr-skel-sm" style="width:65%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:64%"></span><span class="rr-skel rr-skel-sm" style="width:88%"></span><span class="rr-skel rr-skel-sm" style="width:70%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:58%"></span><span class="rr-skel rr-skel-sm" style="width:82%"></span><span class="rr-skel rr-skel-sm" style="width:66%"></span></div>
          </div>
        </div>
      </div>
    