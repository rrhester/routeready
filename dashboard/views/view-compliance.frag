
      <div class="page co-page">

        <!-- style block 35 extracted to inline-styles.css -->

        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="compliance">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><path d="M12 12 L19.6 7.5"/></svg>
            </div>
            <div>
              <h1 class="page-title">Compliance</h1>
              <p class="page-sub">Exceptions only · the rules below run continuously, and any match surfaces here as a row.</p>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" type="button" id="co-run-sweep">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/></svg>
              Run sweep
            </button>
          </div>
        </div>

        <div class="subnav" id="co-subnav">
          <button class="subnav-item active" data-co-tab="exceptions" onclick="coTab('exceptions')" type="button">
            Exceptions
            <span class="subnav-count" data-co-count="exceptions" hidden>0</span>
          </button>
          <button class="subnav-item" data-co-tab="rules" onclick="coTab('rules')" type="button">
            Rules
            <span class="subnav-count" data-co-count="rules" hidden>0</span>
          </button>
        </div>

        <div class="co-tab is-active" id="co-tab-exceptions">
          <div data-co-render="exceptions-table" style="flex:1;display:flex;flex-direction:column;min-height:0">
            <!-- Skeleton table — matches the eventual .co-row shape so
                 the layout doesn't reflow when the sweep returns. -->
            <div class="co-empty is-loading" aria-busy="true">
              <div class="co-loading-row"><span class="rr-skel rr-skel-md" style="width:24%"></span><span class="rr-skel rr-skel-md" style="width:18%"></span><span class="rr-skel rr-skel-md" style="width:30%"></span><span class="rr-skel rr-skel-md" style="width:12%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-md" style="width:28%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:34%"></span><span class="rr-skel rr-skel-md" style="width:12%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-md" style="width:22%"></span><span class="rr-skel rr-skel-md" style="width:20%"></span><span class="rr-skel rr-skel-md" style="width:28%"></span><span class="rr-skel rr-skel-md" style="width:12%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-md" style="width:26%"></span><span class="rr-skel rr-skel-md" style="width:16%"></span><span class="rr-skel rr-skel-md" style="width:32%"></span><span class="rr-skel rr-skel-md" style="width:12%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-md" style="width:24%"></span><span class="rr-skel rr-skel-md" style="width:18%"></span><span class="rr-skel rr-skel-md" style="width:30%"></span><span class="rr-skel rr-skel-md" style="width:12%;margin-left:auto"></span></div>
            </div>
          </div>
        </div>

        <div class="co-tab" id="co-tab-rules">
          <div data-co-render="rules-list" style="flex:1;display:flex;flex-direction:column;min-height:0">
            <div class="co-empty is-loading" aria-busy="true">
              <div class="co-loading-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:38%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:46%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:32%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="co-loading-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:42%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
            </div>
          </div>
        </div>

      </div>
    