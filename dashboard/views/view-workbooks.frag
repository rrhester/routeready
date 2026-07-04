      <div class="page">
        <!-- Operations Workbook · list + detail are rendered into
             #rr-wb-root by workbook.js. The cmd strip carries only the
             page title (no Forms/Workflows/Checklists cross-tiles —
             operator direction 2026-07-04: Workbooks stands alone) and
             is hidden by JS while a workbook is open so the work
             surface gets the full canvas. -->
        <div class="ws-cmd-shell" id="rr-wb-cmd">
          <div class="ws-strip">
            <div class="ws-strip-title">
              <h1 class="page-title">Operations Workbook</h1>
              <p class="page-sub">Plan, track, and document operational work in durable workbooks</p>
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
