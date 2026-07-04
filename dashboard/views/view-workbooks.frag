      <div class="page">
        <!-- Operations Workbook · list + detail are rendered into
             #rr-wb-root by workbook.js. The cmd strip carries the
             schedule-style chrome: a subnav tab bar (Workbooks /
             Reports — Reports launches the Reports Builder) plus the
             New workbook action. It is hidden by JS while a workbook
             is open so the work surface gets the full canvas. -->
        <div class="ws-cmd-shell" id="rr-wb-cmd">
          <div class="rr-wb-strip">
            <div class="subnav rr-wb-subnav" role="tablist" aria-label="Workbook pages">
              <button class="subnav-item active" type="button" data-wb-tab="workbooks" role="tab" aria-selected="true">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/></svg>
                <span>Workbooks</span>
              </button>
              <button class="subnav-item" type="button" data-wb-tab="reports" role="tab" aria-selected="false">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
                <span>Reports</span>
              </button>
            </div>
            <div class="rr-wb-strip-actions">
              <button type="button" class="btn btn-primary btn-sm" data-wb-act="new-workbook">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New workbook
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
