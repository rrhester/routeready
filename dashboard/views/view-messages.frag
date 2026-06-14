
      <div class="page" style="padding-bottom:0">
        <!-- Icon header retired per operator request · Messages
             goes straight into the chat shell with no strip card
             above it. The chat shell flexes to fill the page so
             the composer stays anchored at the bottom. -->
        <!-- style block 31 extracted to inline-styles.css -->

        <div class="msg-shell" data-rr-no-drawer>
          <!-- LEFT: conversation list -->
          <aside class="msg-list">
            <div class="msg-list-head">
              <span class="msg-list-title">Conversations</span>
              <button class="icon-btn" title="New direct message" onclick="renderNewDmList('');openModal('modal-new-dm')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
            </div>
            <!-- Inbox segments · Drivers (driver-ops chats) / HR (people
                 chats) / Broadcasts (channels).  Sits directly under the
                 Conversations heading, above search — switching a tab only
                 re-filters the list (see msgListTab in live.js); the viewer,
                 composer, and URL are untouched. -->
            <div class="msg-list-tabs" role="tablist" aria-label="Inbox segments">
              <button class="msg-list-tab active" data-tab="drivers" role="tab" aria-selected="true" onclick="msgListTab(this)">Drivers</button>
              <button class="msg-list-tab" data-tab="hr" role="tab" aria-selected="false" onclick="msgListTab(this)">HR</button>
              <button class="msg-list-tab" data-tab="broadcasts" role="tab" aria-selected="false" onclick="msgListTab(this)">Broadcasts</button>
            </div>
            <div class="msg-list-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input placeholder="Search conversations…" />
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
        </div>
      </div>
    