
      <div class="page">
        <!-- Documents · refactored header per operator. The previous
             verbose description + standalone trust strip were eating
             the top half of the card; consolidated to a tight title
             row with the trust facts behind a small (i) tooltip. -->
        <div class="page-header docs-page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="forms"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg></div>
            <div>
              <h1 class="page-title">Documents
                <button type="button" class="docs-trust-info" id="docs-trust-info" aria-label="Compliance details" title="ESIGN / UETA compliant · RFC 3161 timestamped · Tamper-evident &amp; independently verifiable">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                </button>
              </h1>
              <p class="page-sub">Reusable PDFs · onboarding packets, policies, sealed e-signatures.</p>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" id="docs-upload-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Upload PDF
            </button>
            <input type="file" id="docs-file-input" accept="application/pdf" hidden>
          </div>
        </div>

        <div class="subnav" id="docs-subnav">
          <button class="subnav-item active" data-docs-sub="templates">Templates</button>
          <button class="subnav-item" data-docs-sub="envelopes">Signature records</button>
          <button class="subnav-item" data-docs-sub="i9">Form I-9</button>
        </div>

        <!-- style block 39 extracted to inline-styles.css -->

        <div id="docs-templates-tab">
          <div id="docs-templates-list" class="docs-list">
            <!-- Skeleton cards mirroring the .docs-template-card layout
                 so the templates list doesn't reflow when data arrives. -->
            <div class="docs-skel-card"><span class="docs-skel-tile rr-skel"></span><div class="docs-skel-text"><span class="rr-skel rr-skel-md" style="width:42%"></span><span class="docs-skel-meta"><span class="rr-skel rr-skel-sm" style="width:70px"></span><span class="rr-skel rr-skel-sm" style="width:160px"></span><span class="rr-skel rr-skel-sm" style="width:110px"></span></span></div></div>
            <div class="docs-skel-card"><span class="docs-skel-tile rr-skel"></span><div class="docs-skel-text"><span class="rr-skel rr-skel-md" style="width:55%"></span><span class="docs-skel-meta"><span class="rr-skel rr-skel-sm" style="width:70px"></span><span class="rr-skel rr-skel-sm" style="width:200px"></span><span class="rr-skel rr-skel-sm" style="width:96px"></span></span></div></div>
            <div class="docs-skel-card"><span class="docs-skel-tile rr-skel"></span><div class="docs-skel-text"><span class="rr-skel rr-skel-md" style="width:38%"></span><span class="docs-skel-meta"><span class="rr-skel rr-skel-sm" style="width:70px"></span><span class="rr-skel rr-skel-sm" style="width:180px"></span><span class="rr-skel rr-skel-sm" style="width:90px"></span></span></div></div>
          </div>
        </div>
        <div id="docs-envelopes-tab" style="display:none">
          <div id="docs-envelopes-list">
            <!-- Envelope list lands as a table — render a matching
                 skeleton grid so the header row doesn't jump in. -->
            <div class="docs-skel-table">
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:28%"></span><span class="rr-skel rr-skel-md" style="width:22%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:32%"></span><span class="rr-skel rr-skel-md" style="width:20%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:24%"></span><span class="rr-skel rr-skel-md" style="width:26%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:28%"></span><span class="rr-skel rr-skel-md" style="width:22%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
            </div>
          </div>
        </div>
        <div id="docs-i9-tab" style="display:none">
          <div id="docs-i9-list">
            <div class="docs-skel-table">
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:30%"></span><span class="rr-skel rr-skel-md" style="width:22%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:26%"></span><span class="rr-skel rr-skel-md" style="width:24%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
              <div class="docs-skel-row"><span class="rr-skel rr-skel-circle" style="width:24px;height:24px;flex:0 0 auto"></span><span class="rr-skel rr-skel-md" style="width:32%"></span><span class="rr-skel rr-skel-md" style="width:22%"></span><span class="rr-skel rr-skel-md" style="width:14%"></span><span class="rr-skel rr-skel-md" style="width:12%"></span><span class="rr-skel rr-skel-md" style="width:14%;margin-left:auto"></span></div>
            </div>
          </div>
        </div>
      </div>
    