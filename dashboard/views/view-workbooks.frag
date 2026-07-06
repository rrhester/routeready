      <div class="page">
        <!-- Operations Workbook · list + detail are rendered into
             #rr-wb-root by workbook.js. Chrome is the shared schedule
             pattern (same recipe as Fleet/Onboarding): a .rr-viewseg
             tab row (Workbooks / Reports) + a .rr-ab action bar. The
             legacy .subnav classes are deliberately NOT used here —
             the platform-wide ribbon pass (.view .subnav-item …
             !important) force-sizes their icons to 32px and kills the
             active underline. #rr-wb-cmd hides while a workbook is
             open so the work surface gets the full canvas. -->
        <div class="ws-cmd-shell" id="rr-wb-cmd">
          <div class="rr-viewseg" id="rr-wb-viewseg" role="tablist" aria-label="Workbook pages">
            <button type="button" class="rr-viewseg-btn active" role="tab" aria-selected="true" data-wb-tab="workbooks" aria-label="Workbooks" title="Workbooks">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/></svg>
              <span class="rr-viewseg-label">Workbooks</span>
            </button>
            <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-wb-tab="reports" aria-label="Reports" title="Reports">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
              <span class="rr-viewseg-label">Reports</span>
            </button>
            <!-- Vault · cross-link into the document workspace (#view-drive)
                 via window.openDrive — same destination as the launcher's
                 Vault item, surfaced here as a sibling tab. -->
            <button type="button" class="rr-viewseg-btn" role="tab" aria-selected="false" data-wb-tab="vault" aria-label="Vault" title="Vault — documents">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="rr-viewseg-label">Vault</span>
            </button>
          </div>
          <!-- Action bar · twin of Schedule's .rr-ab (Fleet's recipe).
               The visible lead action follows the tab via syncWbTabs:
               New workbook on Workbooks, New report on Reports. -->
          <div class="rr-ab" id="rr-wb-ab">
            <button type="button" class="rr-ab-btn rr-ab-emph" data-wb-act="new-workbook" aria-label="New workbook" title="New workbook">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New workbook
            </button>
            <button type="button" class="rr-ab-btn" data-wb-act="browse-templates" aria-label="Start from a template" title="Start from a template">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
              Templates
            </button>
            <button type="button" class="rr-ab-btn rr-ab-emph" data-wb-act="new-report" hidden aria-label="New report" title="New report">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New report
            </button>
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
