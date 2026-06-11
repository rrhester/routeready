
      <div class="page">

        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="pipeline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="10" y2="18"/><circle cx="17" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/></svg></div>
            <div>
              <h1 class="page-title">Hiring pipeline</h1>
              <p class="page-sub" id="rr-pipeline-page-sub">—</p>
            </div>
          </div>
        </div>

        <!-- Pipeline sub-nav · subnav on left, window toggle on right —
             one rail of controls so the page reads as a single header. -->
        <div class="pipe-subnav-row">
          <div class="subnav" data-rr-tabbar="hiring">
            <button class="subnav-item active" data-pipesub="funnel" onclick="pipeSub('funnel')">Funnel</button>
            <button class="subnav-item" data-pipesub="interview" onclick="pipeSub('interview')">Interview Day</button>
            <button class="subnav-item" data-pipesub="calendar" onclick="pipeSub('calendar')">Calendar</button>
          </div>
        </div>

        <!-- FUNNEL SUB-VIEW · starts hidden like the Interview/Calendar panes
             so it can't flash on first paint when the page lands on (or flips
             to) Calendar. pipeSub('funnel') reveals it when the Funnel tab is
             actually selected. -->
        <div class="pipe-subview" id="pipe-sub-funnel" style="display:none">

        <!-- ─── Hiring KPI banner — mirrors Interview Day visual ─── -->
        <!-- style block 2 extracted to inline-styles.css -->

        <!-- Original window toggle kept in DOM for any JS that binds to
             #hp-window-toggle; visually hidden — the page header version
             above is the live one operators interact with. -->
        <div id="hp-window-toggle" hidden aria-hidden="true" style="display:none">
          <button class="hp-window-btn" data-rr-window="7"    type="button">This week</button>
          <button class="hp-window-btn" data-rr-window="28"   type="button">4 wk</button>
          <button class="hp-window-btn" data-rr-window="3650" type="button">All time</button>
        </div>
        <!-- style block 3 extracted to inline-styles.css -->

        <!-- Funnel KPI banner moved INTO the Onboarding TCP KPI
             bar (#rr-ob-kpis). _obRenderFunnelKpis() in live.js
             rebuilds the pill markup with the same hp-* span IDs,
             so loadPipelineKpis() keeps populating them. The
             Week / 4wk / All window toggle is rendered inline at
             the right edge of the same bar. -->



        <!-- Applicants list header — stage tabs only -->
        <!-- style block 4 extracted to inline-styles.css -->

        <!-- Stage filter tabs moved INTO the white applicant workspace
             header (.pa-ws-header) below; the gray .hp-list-head card was
             removed per operator request. -->

        <!-- Applicant cards — single muted accent for stage; expandable detail -->
        <!-- style block 5 extracted to inline-styles.css -->

        <!-- style block 6 extracted to inline-styles.css -->

        <div class="pipe-shell">
        <div class="pa-workspace">
        <div class="pa-ws-header">
          <div class="pa-ws-head-top">
            <div class="pa-ws-title">Applicants</div>
          </div>
          <div class="hp-stages" id="pipeline-stage-tabs">
            <button class="hp-stage-btn stage-tab active" data-stage="all" onclick="filterPipelineStage(this)"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 19v-1a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18v1"/><circle cx="10" cy="8" r="3.2"/><path d="M20 19v-1a3.5 3.5 0 0 0-2.6-3.38"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6"/></svg>All <span class="hp-stage-btn-count stage-tab-count">28</span></button>
            <button class="hp-stage-btn stage-tab" data-stage="action_needed" onclick="filterPipelineStage(this)" title="Applicants where the next move is yours — send the first screening invite, or send the booking link"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="12.5"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></svg>Action needed <span class="hp-stage-btn-count stage-tab-count">0</span></button>
            <button class="hp-stage-btn stage-tab" data-stage="applied" onclick="filterPipelineStage(this)"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="16.5" x2="13" y2="16.5"/></svg>Applied <span class="hp-stage-btn-count stage-tab-count">9</span></button>
            <button class="hp-stage-btn stage-tab" data-stage="screened" onclick="filterPipelineStage(this)"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><line x1="20" y1="20" x2="14.8" y2="14.8"/></svg>Screening <span class="hp-stage-btn-count stage-tab-count">7</span></button>
            <button class="hp-stage-btn stage-tab" data-stage="booking_pending" onclick="filterPipelineStage(this)"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>Booking pending <span class="hp-stage-btn-count stage-tab-count">5</span></button>
            <button class="hp-stage-btn stage-tab" data-stage="booking_scheduled" onclick="filterPipelineStage(this)"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16.5" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/></svg>Booking scheduled <span class="hp-stage-btn-count stage-tab-count">7</span></button>
            <button class="hp-stage-btn stage-tab" data-stage="hired" onclick="filterPipelineStage(this)"><svg class="hp-stage-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="8.5 12.5 11 15 16 9"/></svg>Hired <span class="hp-stage-btn-count stage-tab-count">0</span></button>
          </div>
        </div>
        <div class="pipe-applicants" id="pipe-applicants">

          <!-- BOOKING SCHEDULED -->
          <div class="pa-card" data-stage="booking_scheduled" data-applicant="marcus-hill">
            <div class="pa-row">
              <div class="pa-card-stage">
                <span class="pa-stage-pill booking_scheduled">Booking scheduled · Fri 9:00 AM</span>
                <span class="pa-card-time">Yesterday</span>
              </div>
              <div class="pa-card-body">
                <div class="pa-card-header">
                  <div class="pa-card-avatar tier-c">MH</div>
                  <div>
                    <div class="pa-card-name">Marcus Hill</div>
                    <div class="pa-card-meta">Springfield, MO · marcus.h@email.com · +1 417 555 0276</div>
                  </div>
                </div>
                <div class="pa-card-tags"><span class="pa-card-tag score score-mid">Score 5</span></div>
              </div>
              <div class="pa-card-actions">
                <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
            </div>
            <div class="pa-detail">
              <div class="pa-detail-grid">
                <div>
                  <div class="pa-detail-section-title">Steps</div>
                  <div class="pa-timeline">
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Applied</div><div class="pa-timeline-time">Apr 28 · 10:14 AM</div></div>
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Screened</div><div class="pa-timeline-time">Apr 29 · 2:42 PM</div></div>
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Booking link sent</div><div class="pa-timeline-time">Apr 30 · 9:08 AM</div></div>
                    <div class="pa-timeline-step current"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></div><div class="pa-timeline-label">Booking scheduled</div><div class="pa-timeline-time">May 1 · 8:14 AM</div></div>
                  </div>
                </div>
                <div>
                  <div class="pa-detail-section-title">Video screen</div>
                  <div class="pa-video" onclick="toast('Plays video answers')">
                    <div class="pa-video-rating">★★★☆☆</div>
                    <div class="pa-video-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
                    <div class="pa-video-meta">3 video answers · 2:14 total</div>
                  </div>
                  <div class="pa-detail-section-title" style="margin-top:14px">Screening answers</div>
                  <div class="pa-qa">
                    <div class="pa-qa-item"><div class="pa-qa-q">Days available</div><div class="pa-qa-a">Mon, Tue, Wed, Thu, Fri</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Earliest start</div><div class="pa-qa-a">Within 2 weeks</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Lift 50 lbs</div><div class="pa-qa-a">Yes</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Prior moving violations</div><div class="pa-qa-a">No</div></div>
                  </div>
                </div>
              </div>
              <div class="pa-actions-bar">
                <button class="pa-disp-btn ghost" type="button" onclick="paAction(this,'call','Marcus Hill')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>
                <button class="pa-disp-btn danger" type="button" onclick="paAction(this,'decline','Marcus Hill')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline</button>
                <button class="pa-disp-btn primary" type="button" onclick="goto('interview')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Open Interview Day</button>
              </div>
            </div>
          </div>

          <!-- BOOKING PENDING -->
          <div class="pa-card" data-stage="booking_pending" data-applicant="brianna-cole">
            <div class="pa-row">
              <div class="pa-card-stage">
                <span class="pa-stage-pill booking_pending">Booking pending</span>
                <span class="pa-card-time">Yesterday</span>
              </div>
              <div class="pa-card-body">
                <div class="pa-card-header">
                  <div class="pa-card-avatar tier-a">BC</div>
                  <div>
                    <div class="pa-card-name">Brianna Cole</div>
                    <div class="pa-card-meta">Carthage, MO · brianna.c@email.com · +1 417 555 0218</div>
                  </div>
                </div>
                <div class="pa-card-tags"><span class="pa-card-tag score">Score 9</span></div>
              </div>
              <div class="pa-card-actions">
                <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
            </div>
            <div class="pa-detail">
              <div class="pa-detail-grid">
                <div>
                  <div class="pa-detail-section-title">Steps</div>
                  <div class="pa-timeline">
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Applied</div><div class="pa-timeline-time">Apr 27 · 6:02 PM</div></div>
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Screened</div><div class="pa-timeline-time">Apr 28 · 11:30 AM</div></div>
                    <div class="pa-timeline-step current"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></div><div class="pa-timeline-label">Booking link sent · awaiting selection</div><div class="pa-timeline-time">Apr 30 · 4:18 PM</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking scheduled</div><div class="pa-timeline-time">—</div></div>
                  </div>
                </div>
                <div>
                  <div class="pa-detail-section-title">Video screen</div>
                  <div class="pa-video" onclick="toast('Plays video answers')">
                    <div class="pa-video-rating">★★★★☆</div>
                    <div class="pa-video-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
                    <div class="pa-video-meta">3 video answers · 2:38 total</div>
                  </div>
                  <div class="pa-detail-section-title" style="margin-top:14px">Screening answers</div>
                  <div class="pa-qa">
                    <div class="pa-qa-item"><div class="pa-qa-q">Days available</div><div class="pa-qa-a">All 7 days</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Earliest start</div><div class="pa-qa-q">Immediately</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Lift 50 lbs</div><div class="pa-qa-a">Yes</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Prior moving violations</div><div class="pa-qa-a">No</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Background check consent</div><div class="pa-qa-a">Yes</div></div>
                  </div>
                </div>
              </div>
              <div class="pa-actions-bar">
                <button class="pa-disp-btn ghost" type="button" onclick="paAction(this,'call','Brianna Cole')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>
                <button class="pa-disp-btn danger" type="button" onclick="paAction(this,'decline','Brianna Cole')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline</button>
                <button class="pa-disp-btn primary" type="button" onclick="paAction(this,'resend_link','Brianna Cole')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Resend booking link</button>
              </div>
            </div>
          </div>

          <!-- SCREENED -->
          <div class="pa-card" data-stage="screened" data-applicant="alicia-monroe">
            <div class="pa-row">
              <div class="pa-card-stage">
                <span class="pa-stage-pill screened">Screened</span>
                <span class="pa-card-time">2h ago</span>
              </div>
              <div class="pa-card-body">
                <div class="pa-card-header">
                  <div class="pa-card-avatar tier-b">AM</div>
                  <div>
                    <div class="pa-card-name">Alicia Monroe</div>
                    <div class="pa-card-meta">Springfield, MO · alicia.m@email.com · +1 417 555 0142</div>
                  </div>
                </div>
                <div class="pa-card-tags"><span class="pa-card-tag score">Score 8</span></div>
              </div>
              <div class="pa-card-actions">
                <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
            </div>
            <div class="pa-detail">
              <div class="pa-detail-grid">
                <div>
                  <div class="pa-detail-section-title">Steps</div>
                  <div class="pa-timeline">
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Applied</div><div class="pa-timeline-time">May 1 · 7:14 AM</div></div>
                    <div class="pa-timeline-step current"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></div><div class="pa-timeline-label">Screened · awaiting your review</div><div class="pa-timeline-time">May 1 · 9:02 AM</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking link sent</div><div class="pa-timeline-time">—</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking scheduled</div><div class="pa-timeline-time">—</div></div>
                  </div>
                </div>
                <div>
                  <div class="pa-detail-section-title">Video screen</div>
                  <div class="pa-video" onclick="toast('Plays video answers')">
                    <div class="pa-video-rating">★★★★☆</div>
                    <div class="pa-video-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
                    <div class="pa-video-meta">3 video answers · 2:51 total</div>
                  </div>
                  <div class="pa-detail-section-title" style="margin-top:14px">Screening answers</div>
                  <div class="pa-qa">
                    <div class="pa-qa-item"><div class="pa-qa-q">Days available</div><div class="pa-qa-a">Mon–Fri + Sat</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Earliest start</div><div class="pa-qa-a">Within 1 week</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Lift 50 lbs</div><div class="pa-qa-a">Yes</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Prior moving violations</div><div class="pa-qa-a">No</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Background check consent</div><div class="pa-qa-a">Yes</div></div>
                  </div>
                </div>
              </div>
              <div class="pa-actions-bar">
                <button class="pa-disp-btn ghost" type="button" onclick="paAction(this,'call','Alicia Monroe')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>
                <button class="pa-disp-btn danger" type="button" onclick="paAction(this,'decline','Alicia Monroe')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline</button>
                <button class="pa-disp-btn primary" type="button" onclick="paAction(this,'send_link','Alicia Monroe')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send booking link</button>
              </div>
            </div>
          </div>

          <!-- APPLIED -->
          <div class="pa-card" data-stage="applied" data-applicant="devon-patterson">
            <div class="pa-row">
              <div class="pa-card-stage">
                <span class="pa-stage-pill applied">Applied</span>
                <span class="pa-card-time">3h ago</span>
              </div>
              <div class="pa-card-body">
                <div class="pa-card-header">
                  <div class="pa-card-avatar tier-c">DP</div>
                  <div>
                    <div class="pa-card-name">Devon Patterson</div>
                    <div class="pa-card-meta">Joplin, MO · devon.p@email.com · +1 417 555 0193</div>
                  </div>
                </div>
                <div class="pa-card-tags"><span class="pa-card-tag score score-mid">Score 6</span></div>
              </div>
              <div class="pa-card-actions">
                <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
            </div>
            <div class="pa-detail">
              <div class="pa-detail-grid">
                <div>
                  <div class="pa-detail-section-title">Steps</div>
                  <div class="pa-timeline">
                    <div class="pa-timeline-step current"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></div><div class="pa-timeline-label">Applied · screening form sent</div><div class="pa-timeline-time">May 1 · 6:02 AM</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Screened</div><div class="pa-timeline-time">—</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking link sent</div><div class="pa-timeline-time">—</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking scheduled</div><div class="pa-timeline-time">—</div></div>
                  </div>
                </div>
                <div>
                  <div class="pa-detail-section-title">Video screen</div>
                  <div class="rr-empty-inline" style="background:var(--surface);border:1px dashed var(--border);border-radius:var(--r-md)">Awaiting screening submission</div>
                  <div class="pa-detail-section-title" style="margin-top:14px">Screening answers</div>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);padding:var(--s-3-5) 0">Form sent · not yet returned</div>
                </div>
              </div>
              <div class="pa-actions-bar">
                <button class="pa-disp-btn ghost" type="button" onclick="paAction(this,'call','Devon Patterson')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>
                <button class="pa-disp-btn danger" type="button" onclick="paAction(this,'decline','Devon Patterson')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline</button>
                <button class="pa-disp-btn primary" type="button" onclick="paAction(this,'resend_screening','Devon Patterson')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Resend screening</button>
              </div>
            </div>
          </div>

          <!-- SCREENED -->
          <div class="pa-card" data-stage="screened" data-applicant="camille-foster">
            <div class="pa-row">
              <div class="pa-card-stage">
                <span class="pa-stage-pill screened">Screened</span>
                <span class="pa-card-time">2 days ago</span>
              </div>
              <div class="pa-card-body">
                <div class="pa-card-header">
                  <div class="pa-card-avatar tier-b">CF</div>
                  <div>
                    <div class="pa-card-name">Camille Foster</div>
                    <div class="pa-card-meta">Branson, MO · camille.f@email.com · +1 417 555 0408</div>
                  </div>
                </div>
                <div class="pa-card-tags"><span class="pa-card-tag score">Score 7</span></div>
              </div>
              <div class="pa-card-actions">
                <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
            </div>
            <div class="pa-detail">
              <div class="pa-detail-grid">
                <div>
                  <div class="pa-detail-section-title">Steps</div>
                  <div class="pa-timeline">
                    <div class="pa-timeline-step done"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="pa-timeline-label">Applied</div><div class="pa-timeline-time">Apr 29 · 3:48 PM</div></div>
                    <div class="pa-timeline-step current"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></div><div class="pa-timeline-label">Screened · awaiting your review</div><div class="pa-timeline-time">Apr 30 · 10:24 AM</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking link sent</div><div class="pa-timeline-time">—</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking scheduled</div><div class="pa-timeline-time">—</div></div>
                  </div>
                </div>
                <div>
                  <div class="pa-detail-section-title">Video screen</div>
                  <div class="pa-video" onclick="toast('Plays video answers')">
                    <div class="pa-video-rating">★★★★★</div>
                    <div class="pa-video-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
                    <div class="pa-video-meta">3 video answers · 3:08 total</div>
                  </div>
                  <div class="pa-detail-section-title" style="margin-top:14px">Screening answers</div>
                  <div class="pa-qa">
                    <div class="pa-qa-item"><div class="pa-qa-q">Days available</div><div class="pa-qa-a">Mon–Fri</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Earliest start</div><div class="pa-qa-a">Within 2 weeks</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Lift 50 lbs</div><div class="pa-qa-a">Yes</div></div>
                    <div class="pa-qa-item"><div class="pa-qa-q">Prior moving violations</div><div class="pa-qa-a">No</div></div>
                  </div>
                </div>
              </div>
              <div class="pa-actions-bar">
                <button class="pa-disp-btn ghost" type="button" onclick="paAction(this,'call','Camille Foster')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>
                <button class="pa-disp-btn danger" type="button" onclick="paAction(this,'decline','Camille Foster')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline</button>
                <button class="pa-disp-btn primary" type="button" onclick="paAction(this,'send_link','Camille Foster')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send booking link</button>
              </div>
            </div>
          </div>

          <!-- APPLIED -->
          <div class="pa-card" data-stage="applied" data-applicant="sasha-underwood">
            <div class="pa-row">
              <div class="pa-card-stage">
                <span class="pa-stage-pill applied">Applied</span>
                <span class="pa-card-time">2 days ago</span>
              </div>
              <div class="pa-card-body">
                <div class="pa-card-header">
                  <div class="pa-card-avatar tier-d">SU</div>
                  <div>
                    <div class="pa-card-name">Sasha Underwood</div>
                    <div class="pa-card-meta">Nixa, MO · sasha.u@email.com · +1 417 555 0341</div>
                  </div>
                </div>
                <div class="pa-card-tags"><span class="pa-card-tag score score-low">Score 3</span></div>
              </div>
              <div class="pa-card-actions">
                <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
            </div>
            <div class="pa-detail">
              <div class="pa-detail-grid">
                <div>
                  <div class="pa-detail-section-title">Steps</div>
                  <div class="pa-timeline">
                    <div class="pa-timeline-step current"><div class="pa-timeline-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></div><div class="pa-timeline-label">Applied · screening form sent</div><div class="pa-timeline-time">Apr 29 · 9:18 AM</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Screened</div><div class="pa-timeline-time">—</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking link sent</div><div class="pa-timeline-time">—</div></div>
                    <div class="pa-timeline-step pending"><div class="pa-timeline-dot"></div><div class="pa-timeline-label">Booking scheduled</div><div class="pa-timeline-time">—</div></div>
                  </div>
                </div>
                <div>
                  <div class="pa-detail-section-title">Video screen</div>
                  <div class="rr-empty-inline" style="background:var(--surface);border:1px dashed var(--border);border-radius:var(--r-md)">Awaiting screening submission</div>
                  <div class="pa-detail-section-title" style="margin-top:14px">Screening answers</div>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);padding:var(--s-3-5) 0">Form sent · not yet returned (2 days)</div>
                </div>
              </div>
              <div class="pa-actions-bar">
                <button class="pa-disp-btn ghost" type="button" onclick="paAction(this,'call','Sasha Underwood')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>
                <button class="pa-disp-btn danger" type="button" onclick="paAction(this,'decline','Sasha Underwood')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline</button>
                <button class="pa-disp-btn primary" type="button" onclick="paAction(this,'resend_screening','Sasha Underwood')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Resend screening</button>
              </div>
            </div>
          </div>

          <div class="rr-empty" id="pipeline-empty-row" style="display:none">
            <div class="rr-empty-title">No applicants in this stage</div>
            <div class="rr-empty-sub">Try a different stage tab.</div>
          </div>
        </div><!-- /pipe-applicants -->
        </div><!-- /pa-workspace -->

        <!-- Import applicants · right rail. Drop a candidate export (CSV) to
             add people straight to the funnel — works for any source (Indeed,
             Workday, ADP, any ATS): download the export like normal, drop it
             here. No portal login, no crawling. The desktop box can watch a
             folder to do this automatically. -->
        <aside class="rr-indeed-log rr-funnel-rail" id="rr-funnel-panel" aria-label="Onboarding funnel">
          <div class="rr-funnel-head">
            <span class="rr-funnel-title">Onboarding funnel</span>
            <div id="hp-window-toggle-side" class="pipe-window-toggle" role="group" aria-label="Time window">
              <button class="hp-window-btn" data-rr-window="7"    type="button">Week</button>
              <button class="hp-window-btn" data-rr-window="28"   type="button">4 wk</button>
              <button class="hp-window-btn" data-rr-window="3650" type="button">All</button>
            </div>
          </div>
          <div id="rr-funnel-body" class="rr-funnel-body"><!-- rendered by _renderFunnelSidebar() --></div>
        </aside>
        </div><!-- /pipe-shell -->

        </div><!-- /pipe-sub-funnel -->

        <!-- INTERVIEW DAY SUB-VIEW -->
        <div class="pipe-subview" id="pipe-sub-interview" style="display:none">

        <!-- Day stats banner -->
        <div class="iv-stats-banner">
          <div class="iv-stat">
            <div class="iv-stat-label">Booked today</div>
            <div class="iv-stat-value"><span id="iv-booked">7</span></div>
          </div>
          <div class="iv-stat ok">
            <div class="iv-stat-label">Hired</div>
            <div class="iv-stat-value"><span id="iv-hired">0</span></div>
          </div>
          <div class="iv-stat warn">
            <div class="iv-stat-label">No hire</div>
            <div class="iv-stat-value"><span id="iv-nohire">0</span></div>
          </div>
          <div class="iv-stat bad">
            <div class="iv-stat-label">No show</div>
            <div class="iv-stat-value"><span id="iv-noshow">0</span></div>
          </div>
          <div class="iv-stat">
            <div class="iv-stat-label">Remaining</div>
            <div class="iv-stat-value"><span id="iv-remaining">7</span></div>
          </div>
          <div class="iv-stats-progress">
            <div class="iv-stats-progress-fill" id="iv-progress-fill" style="width:0%"></div>
          </div>
        </div>

        <!-- Candidate cards -->
        <div class="iv-candidates" id="iv-candidates">
          <div class="rr-loading">Loading interviews</div>
        </div>

        <!-- Day done state -->
        <div class="iv-done" id="iv-done" style="display:none">
          <div class="iv-done-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="iv-done-title">Interview day complete</div>
          <div class="iv-done-sub" id="iv-done-sub"></div>
          <button class="btn btn-primary" onclick="goto('pipeline')">Back to pipeline</button>
        </div>
        </div><!-- /pipe-sub-interview -->


        <!-- CALENDAR SUB-VIEW · two-column layout · Upcoming bookings
             on the left, Interview availability editor on the right.
             Collapses to a single column under 1100px so neither
             card gets too narrow on a laptop screen. -->
        <div class="pipe-subview" id="pipe-sub-calendar" style="display:none">
          <!-- style block 7 extracted to inline-styles.css -->

          <!-- Native RouteReady interview calendar · Day / Week / Month toggle.
               Shows your interview availability (shaded) plus booked interviews,
               orientations, and group sessions. No Google account required. -->
          <!-- Outlook-style calendar (Phase 1: dense desktop grid, reading pane,
               context menu, quick-create, hover preview, keyboard, categories). -->
          <!-- style block 8 extracted to inline-styles.css -->
          <div id="rr-ivcal" tabindex="0">
            <!-- Shared gradient for the blue→purple camera "video link" glyph. -->
            <div id="rr-ivcal-body"><div class="rr-loading">Loading calendar…</div></div>
          </div>

          <!-- Native RouteReady interview availability editor styles · GLOBAL
               (selectors un-scoped) because the editor itself now lives in the
               Calendar "Rules" → Interview availability popover (#rr-iv-rules-popover),
               which is outside #pipe-sub-calendar. -->
          <!-- style block 9 extracted to inline-styles.css -->

          <div class="pipe-cal-shell">
            <!-- "Upcoming bookings" list removed — the native calendar above is
                 the source of truth; this section made the page scroll past the
                 pinned calendar header. -->

            <!-- Legacy Cal.com availability editor removed — the native
                 "Interview availability" editor (above) is the source of
                 truth. The .cal-edit-card styles below are KEPT because the
                 Funnel rules popover reuses that class. -->
          <!-- style block 10 extracted to inline-styles.css -->
          </div><!-- /pipe-cal-shell -->
        </div><!-- /pipe-sub-calendar -->

      </div>
    