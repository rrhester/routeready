      <div class="page">
        <!-- Operations Workbook · list + detail are rendered into
             #rr-wb-root by workbook.js. The cmd strip mirrors the
             Workspaces hub chrome (ws-* classes are shared) and is
             hidden by JS while a workbook is open so the work surface
             gets the full canvas. -->
        <div class="ws-cmd-shell" id="rr-wb-cmd">
          <div class="ws-strip">
            <div class="ws-strip-title">
              <h1 class="page-title">Operations Workbook</h1>
              <p class="page-sub">Plan, track, and document operational work — spreadsheets, notes, and checklists in one workbook</p>
            </div>
            <div class="ws-strip-actions" role="group" aria-label="Workspaces sections">
              <button type="button" class="ws-strip-tile" onclick="goto('forms')" title="Forms">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>
                <span>Forms</span>
              </button>
              <button type="button" class="ws-strip-tile" onclick="goto('workspaces')" title="Workflows">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                <span>Workflows</span>
              </button>
              <button type="button" class="ws-strip-tile" onclick="goto('checklists')" title="Checklists">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><polyline points="8 9 10 11 13 8"/><polyline points="8 14 10 16 13 13"/><line x1="15" y1="9" x2="17" y2="9"/><line x1="15" y1="14" x2="17" y2="14"/></svg>
                <span>Checklists</span>
              </button>
              <button type="button" class="ws-strip-tile active" onclick="goto('workbooks')" title="Workbooks">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/><line x1="3" y1="14.5" x2="21" y2="14.5"/></svg>
                <span>Workbooks</span>
              </button>
            </div>
          </div>
        </div>
        <div id="rr-wb-root">
          <!-- Skeleton cards so the layout doesn't reflow when the
               workbook list arrives. -->
          <div class="ws-skel-grid" aria-busy="true">
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:62%"></span><span class="rr-skel rr-skel-sm" style="width:88%"></span><span class="rr-skel rr-skel-sm" style="width:70%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:54%"></span><span class="rr-skel rr-skel-sm" style="width:84%"></span><span class="rr-skel rr-skel-sm" style="width:66%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:68%"></span><span class="rr-skel rr-skel-sm" style="width:90%"></span><span class="rr-skel rr-skel-sm" style="width:74%"></span></div>
            <div class="ws-skel-card"><span class="rr-skel rr-skel-md" style="width:58%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span><span class="rr-skel rr-skel-sm" style="width:62%"></span></div>
          </div>
        </div>
      </div>
