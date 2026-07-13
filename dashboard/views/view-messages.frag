
      <div class="page" style="padding-bottom:0">
        <!-- Icon header retired per operator request · Messages
             goes straight into the chat shell with no strip card
             above it. The chat shell flexes to fill the page so
             the composer stays anchored at the bottom. -->
        <!-- style block 31 extracted to inline-styles.css -->

        <div class="msg-shell" data-rr-no-drawer>
          <!-- LEFT: messaging navigation + conversation list -->
          <aside class="msg-list">
            <div class="msg-list-head">
              <span class="msg-list-title">Messages</span>
              <div class="msg-head-actions">
                <button class="msg-headbtn" data-rr-call-history title="Recent calls" aria-label="Recent calls"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg></button>
                <button class="msg-headbtn" data-rr-call-teammate title="Call a teammate" aria-label="Call a teammate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button>
                <button class="msg-newbtn" title="New message" aria-label="New message" onclick="renderNewDmList('');openModal('modal-new-dm')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
              </div>
            </div>
            <div class="msg-list-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="rr-msg-search" type="search" placeholder="Search messages…" aria-label="Search messages" autocomplete="off" />
            </div>
            <!-- Restrained enterprise quick actions — compose a direct
                 message, or spin up a RouteReady meeting. -->
            <div class="msg-quick-actions">
              <button type="button" class="msg-quick-btn" onclick="renderNewDmList('');openModal('modal-new-dm')">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                New message
              </button>
              <button type="button" class="msg-quick-btn" onclick="rrOpenMeetWindow('meet.html')">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                Start meeting
              </button>
            </div>
            <!-- Inbox filter · Drivers (driver-ops chats) / HR (people
                 chats) / Rooms (broadcast channels).  Compact segmented
                 filter — switching a segment only re-filters the list (see
                 msgListTab in live.js); the viewer + composer are untouched. -->
            <div class="msg-list-tabs" role="tablist" aria-label="Filter conversations">
              <button class="msg-list-tab active" data-tab="drivers" role="tab" aria-selected="true" onclick="msgListTab(this)">Drivers</button>
              <button class="msg-list-tab" data-tab="hr" role="tab" aria-selected="false" onclick="msgListTab(this)">HR</button>
              <button class="msg-list-tab" data-tab="broadcasts" role="tab" aria-selected="false" onclick="msgListTab(this)">Rooms</button>
            </div>
            <div class="msg-list-items" id="rr-msg-driver-list">
              <!-- Conversation list skeleton — matches the .msg-item
                   grid (32px avatar | name/preview | time) so the list
                   doesn't reflow when the real rows arrive. -->
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:62%"></span><span class="rr-skel rr-skel-sm" style="width:88%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:48%"></span><span class="rr-skel rr-skel-sm" style="width:75%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:70%"></span><span class="rr-skel rr-skel-sm" style="width:92%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:55%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:65%"></span><span class="rr-skel rr-skel-sm" style="width:84%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:60%"></span><span class="rr-skel rr-skel-sm" style="width:90%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:50%"></span><span class="rr-skel rr-skel-sm" style="width:78%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:67%"></span><span class="rr-skel rr-skel-sm" style="width:86%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
            </div>
          </aside>

          <!-- RIGHT: active conversation -->
          <section class="msg-conv" id="rr-msg-conv">
            <!-- Empty pane — rendered while no conversation is selected.
                 Canonical rr-empty primitive so this reads the same as
                 every other "nothing selected yet" surface. -->
            <div class="rr-empty msg-conv-empty">
              <div class="rr-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <div class="rr-empty-title">Pick a conversation</div>
              <div class="rr-empty-sub">Select a driver, channel, or broadcast from the list to open the thread.</div>
            </div>
          </section>

          <!-- RIGHT RAIL: collapsible driver details panel.  Populated by
               _renderDriverDetails when a driver thread opens; the column
               collapses to zero width (desktop) or slides away (medium /
               small) when closed. -->
          <aside class="msg-details" id="rr-msg-details" aria-hidden="true" aria-label="Driver details"></aside>
        </div>
      </div>
    