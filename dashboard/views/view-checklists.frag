
      <div class="page">
        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="forms"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>
            <div>
              <h1 class="page-title">Workspaces</h1>
              <p class="page-sub">Recurring task lists for opening, closing, vehicle prep, onboarding</p>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" onclick="openModal('modal-checklist-builder')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Build a checklist
            </button>
          </div>
        </div>

        <div class="subnav" data-rr-tabbar="checklists">
          <button class="subnav-item" data-sub="forms" onclick="goto('forms')">Forms</button>
          <!-- Workflows (boards) tab hidden — fleet assignment
               board moved to the Schedule view. -->
          <button class="subnav-item" data-sub="workflows" onclick="goto('workspaces')" style="display:none" aria-hidden="true">Workflows</button>
          <button class="subnav-item active" data-sub="checklists" onclick="checklistSub('my')">Checklists</button>
        </div>

        <div class="cl-subtabs" role="tablist" aria-label="Checklist sections">
          <button class="cl-subtab active" data-sub="my" onclick="checklistSub('my')">All checklists</button>
          <button class="cl-subtab" data-sub="status" onclick="checklistSub('status')">Today's status</button>
          <button class="cl-subtab" data-sub="templates" onclick="checklistSub('templates')">Templates</button>
        </div>

        <!-- MY CHECKLISTS -->
        <!-- Real instances list, rendered into #rr-cl-my-root by
             loadChecklistInstances() in live.js. -->
        <div class="checklist-tab" id="checklist-tab-my">
          <div id="rr-cl-my-root">
            <div class="cl-skel-list" aria-busy="true">
              <div class="cl-skel-card"><span class="rr-skel rr-skel-md" style="width:48%"></span><span class="rr-skel rr-skel-sm" style="width:74%"></span></div>
              <div class="cl-skel-card"><span class="rr-skel rr-skel-md" style="width:56%"></span><span class="rr-skel rr-skel-sm" style="width:62%"></span></div>
              <div class="cl-skel-card"><span class="rr-skel rr-skel-md" style="width:42%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span></div>
              <div class="cl-skel-card"><span class="rr-skel rr-skel-md" style="width:50%"></span><span class="rr-skel rr-skel-sm" style="width:70%"></span></div>
            </div>
          </div>
        </div>

        <!-- TODAY'S STATUS — live operational rollup -->
        <div class="checklist-tab" id="checklist-tab-status" style="display:none">
          <div id="rr-cl-status-root">
            <div class="rr-loading">Loading status</div>
          </div>
        </div>

        <div class="checklist-tab" id="checklist-tab-templates" style="display:none">
          <div id="rr-cb-root">
            <div class="rr-loading">Loading templates</div>
          </div>
        </div>

      </div>
    