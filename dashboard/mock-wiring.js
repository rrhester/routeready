// mock-wiring.js · the dashboard's mockup-era wiring script,
// extracted verbatim from dashboard/index.html (monolith split
// phase 2). Defines ~226 global functions (goto, fleetSub, drawer
// openers, mockup decorators…) consumed by inline onclick handlers
// and live.js. Loaded as a CLASSIC script by the view-partial
// injector AFTER the views are injected — mirroring the original
// order (views parsed, then this script) — so its top-level
// declarations stay global and its view-DOM writes find their
// targets. Three DOMContentLoaded-only callbacks are invoked
// explicitly by the injector after load (DCL has already fired by
// injection time).

  // ─── DASHBOARD ACTION QUEUE — clearable inbox pattern ─────
  // ─── ACTION PROPAGATION ───────────────────────────────────
  // Each clear affects multiple surfaces. Apply hides/decrements; revert restores.
  // We snapshot every touched DOM node's outerHTML before mutating so revert is safe.
  var _actionSnapshots = {};
  function _snap(action, key, el){
    if (!el) return;
    if (!_actionSnapshots[action]) _actionSnapshots[action] = {};
    if (_actionSnapshots[action][key] === undefined) _actionSnapshots[action][key] = el.innerHTML;
  }
  function _restore(action){
    var snap = _actionSnapshots[action];
    if (!snap) return;
    Object.keys(snap).forEach(function(k){
      var el = document.querySelector(k);
      if (el) el.innerHTML = snap[k];
    });
    delete _actionSnapshots[action];
  }
  function _hideBadge(action, key, sel){
    var el = document.querySelector(sel);
    if (!el) return;
    _snap(action, key, el.parentNode); // snap parent so we restore the badge child
    el.style.display = 'none';
  }
  function _zeroBadge(action, key, sel){
    var el = document.querySelector(sel);
    if (!el) return;
    _snap(action, key, el);
    el.textContent = '0';
    el.style.opacity = '.5';
  }
  function _replaceText(action, key, sel, newHtml){
    var el = document.querySelector(sel);
    if (!el) return;
    _snap(action, key, el);
    el.innerHTML = newHtml;
  }

  var ACTION_EFFECTS = {
    pipeline: function(action){
      _hideBadge(action, 'nav-pipeline', '.nav-item[data-view="pipeline"] .nav-badge');
    },
    underperformer: function(action){
      // Retention propensity health card text + Drivers/Insights at-risk val
      _replaceText(action, 'health-retention',
        '.health-card .health-label:contains("Retention")',
        ''); // CSS :contains isn't supported — use direct lookup
      // Workaround: find the retention card by its label text
      document.querySelectorAll('.health-card').forEach(function(card){
        var lbl = card.querySelector('.health-label');
        if (lbl && lbl.textContent.indexOf('Retention') !== -1) {
          var trend = card.querySelector('.health-trend');
          if (trend) {
            _snap(action, 'health-retention-trend', trend);
            trend.innerHTML = '<span class="up" style="color:var(--green)">✓</span> all reviewed today';
          }
          var val = card.querySelector('.health-value');
          if (val) {
            _snap(action, 'health-retention-val', val);
            val.innerHTML = '78<span class="frac"> / 78 healthy</span>';
          }
        }
        if (lbl && lbl.textContent.indexOf('Driver Composite') !== -1) {
          var trend = card.querySelector('.health-trend');
          if (trend) {
            _snap(action, 'health-composite-trend', trend);
            trend.innerHTML = '<span class="up" style="color:var(--green)">▲ 2</span> vs last week · all coached ✓';
          }
        }
      });
      // Drivers/Insights at-risk count
      var di = document.querySelector('.di-val.bad');
      if (di) { _snap(action, 'di-bad', di); di.textContent = '0'; di.classList.remove('bad'); di.classList.add('ok'); }
      // Drivers stage tab "At risk"
      var atrisk = document.querySelector('.stage-tab[data-stage="atrisk"] .stage-tab-count');
      if (atrisk) _zeroBadge(action, 'stagetab-atrisk', '.stage-tab[data-stage="atrisk"] .stage-tab-count');
      // Drivers sidebar nav badge
      _hideBadge(action, 'nav-drivers', '.nav-item[data-view="drivers"] .nav-badge');
    },
    safety: function(action){
      var meta = document.querySelector('#safety-drawer .detail-meta');
      if (meta) { _snap(action, 'safety-meta', meta); meta.textContent = '0 events · all acknowledged today'; }
    },
    quality: function(action){
      var meta = document.querySelector('#quality-drawer .detail-meta');
      if (meta) { _snap(action, 'quality-meta', meta); meta.textContent = '0 items · all reviewed today'; }
    },
    schedule: function(action){
      _hideBadge(action, 'nav-schedule', '.nav-item[data-view="schedule"] .nav-badge');
      _hideBadge(action, 'subnav-timeoff', '#view-schedule .subnav-item[data-sub="timeoff"] span');
    },
    disputes: function(action){
      _hideBadge(action, 'nav-finances', '.nav-item[data-view="finances"] .nav-badge');
      var sub = document.querySelector('#view-finances .subnav-item[data-sub="disputes"] span');
      if (sub) _hideBadge(action, 'subnav-disputes', '#view-finances .subnav-item[data-sub="disputes"] span');
    },
    coaching: function(action){
      _hideBadge(action, 'nav-workflows', '.nav-item[data-view="forms"] .nav-badge');
    },
    documents: function(action){
      _hideBadge(action, 'nav-fleet', '.nav-item[data-view="fleet"] .nav-badge');
    }
  };

  function clearAction(linkEl){
    var card = linkEl.closest('.action-card');
    if (!card || card.classList.contains('cleared')) return;
    card.classList.add('cleared');
    var actionKey = card.getAttribute('data-action');
    if (ACTION_EFFECTS[actionKey]) {
      try { ACTION_EFFECTS[actionKey](actionKey); } catch (e) { /* swallow — demo */ }
    }
    updateQueueProgress();
    recomputeStaffingRisk();
    var name = card.querySelector('.action-card-title').textContent.trim();
    toast(name + ' · cleared');
  }

  // ─── STAFFING RISK ENGINE ─────────────────────────────────
  // Reads live state, computes risk, paints hero + sidebar dot + cards.
  function recomputeStaffingRisk(){
    // Read inputs from current DOM state
    var active = 78; // hardcoded fleet size for the mock
    var okamiNeed = 90;
    var attrition = 1; // baseline this cycle
    var terminations = 0;
    // At-risk: derived from underperformer card state (cleared = 0)
    var underperfCleared = !!document.querySelector('.action-card[data-action="underperformer"].cleared');
    var atRisk = underperfCleared ? 0 : 5;
    var atRiskHigh = underperfCleared ? 0 : 3;
    // Pipeline applicants — read live from "All" stage tab count
    var appsEl = document.querySelector('.stage-tab[data-stage="all"] .stage-tab-count');
    var applicants = appsEl ? (parseInt(appsEl.textContent, 10) || 48) : 48;
    var showRate = 0.72;
    var hireRate = 0.31;
    var predictedHires = Math.round(applicants * showRate * hireRate);
    var predictedClosing = active - attrition - terminations + predictedHires;
    var gap = predictedClosing - okamiNeed; // negative = short
    var ratio = gap / okamiNeed;

    // Determine band
    var band, bandLabel, bandSub;
    if (ratio >= 0) {
      band = 'healthy';
      bandLabel = 'Healthy — you can hold drivers accountable';
      bandSub = atRisk > 0
        ? 'You can release flagged underperformers without breaking coverage. Pipeline + bench cover the gap.'
        : 'No at-risk drivers flagged. Pipeline is tracking ahead of OKAMI need. Focus on retention.';
    } else if (ratio >= -0.05) {
      band = 'cautious';
      bandLabel = 'Cautious — coach, don\'t release';
      bandSub = 'You\'re ' + Math.abs(gap) + ' short of OKAMI need after predicted hires. Hold accountability actions until the cycle\'s hires close.';
    } else {
      band = 'critical';
      bandLabel = 'Critical — hands tied';
      bandSub = 'Halt accountability actions. You\'re ' + Math.abs(gap) + ' short of OKAMI need. Accelerate pipeline or expand sourcing.';
    }

    // Paint hero
    var hero = document.getElementById('staffing-hero');
    if (hero) {
      hero.classList.remove('healthy','cautious','critical');
      hero.classList.add(band);
    }
    var titleEl = document.getElementById('staffing-hero-title');
    if (titleEl) titleEl.textContent = bandLabel;
    var subEl = document.getElementById('staffing-hero-sub');
    if (subEl) subEl.textContent = bandSub;
    var meterNum = document.getElementById('staffing-meter-num');
    if (meterNum) meterNum.textContent = (gap >= 0 ? '+' : '') + gap;

    // Paint cards
    var setText = function(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; };
    setText('staffing-active', active);
    setText('staffing-need', okamiNeed);
    setText('staffing-atrisk', atRisk);
    setText('staffing-applicants', applicants);
    setText('staffing-predicted', predictedHires);
    setText('staffing-closing', predictedClosing);
    var gapLine = document.getElementById('staffing-gap-line');
    if (gapLine) {
      gapLine.textContent = (active >= okamiNeed ? 'Covered · ' : '−' + (okamiNeed - active) + ' gap · ') + '13-week target';
      gapLine.classList.remove('bad','warn');
      if (active < okamiNeed - 5) gapLine.classList.add('bad');
      else if (active < okamiNeed) gapLine.classList.add('warn');
    }
    var erosionLine = document.getElementById('staffing-erosion-line');
    if (erosionLine) {
      erosionLine.textContent = atRisk === 0
        ? 'No drivers flagged · all coached'
        : atRiskHigh + ' high probability · ' + (atRisk - atRiskHigh) + ' watch';
      erosionLine.classList.remove('bad','warn');
      if (atRisk >= 5) erosionLine.classList.add('warn');
      if (atRiskHigh >= 4) erosionLine.classList.add('bad');
    }
    var throughputLine = document.getElementById('staffing-throughput-line');
    if (throughputLine) throughputLine.innerHTML = applicants + ' applicants × 72% show × 31% hire';
    var closingLine = document.getElementById('staffing-closing-line');
    if (closingLine) {
      closingLine.innerHTML = 'Predicted closing: <strong>' + predictedClosing + '</strong> drivers · <strong>' +
        (gap >= 0 ? '+' + gap + ' over' : gap + ' short') + '</strong>';
    }
    var headcountBar = document.getElementById('staffing-bar-headcount');
    if (headcountBar) headcountBar.style.width = Math.min(100, Math.round(active/okamiNeed*100)) + '%';

    // Sidebar dot color
    var dot = document.getElementById('staffing-status-dot');
    if (dot) {
      var col = (band === 'healthy') ? 'var(--green)' : (band === 'cautious' ? 'var(--amber)' : 'var(--red)');
      dot.style.background = col;
      dot.title = bandLabel;
    }

    // Pipeline KPI strip predicted line — keep in sync
    var pipePred = document.getElementById('pipeline-kpi-predicted');
    if (pipePred) pipePred.textContent = predictedHires;
    var pipePredLine = document.getElementById('pipeline-kpi-predicted-line');
    if (pipePredLine) pipePredLine.textContent = applicants + ' × 72% × 31% · feeds Staffing Risk →';
  }
  // Recompute on first load
  document.addEventListener('DOMContentLoaded', recomputeStaffingRisk);
  function updateQueueProgress(){
    var queue = document.getElementById('action-queue');
    if (!queue) return;
    // Visible cards = total - dismissed
    var visible = queue.querySelectorAll('.action-card:not(.deleted)');
    var total = visible.length;
    var cleared = queue.querySelectorAll('.action-card:not(.deleted).cleared').length;
    var open = total - cleared;
    var clearedEl = document.getElementById('queue-cleared');
    var totalEl = document.getElementById('queue-total');
    var subEl = document.getElementById('dashboard-sub');
    var allClear = document.getElementById('all-clear-state');
    if (clearedEl) clearedEl.textContent = cleared;
    if (totalEl) totalEl.textContent = open;
    if (subEl) {
      if (open === 0) subEl.textContent = 'All clear · You\'re done for the day.';
      else if (cleared === 0) subEl.textContent = open + ' tasks waiting.';
      else subEl.textContent = open + ' waiting · ' + cleared + ' cleared.';
    }
    if (allClear) {
      if (open === 0 && total > 0) { allClear.classList.add('show'); allClear.style.display = 'block'; }
      else { allClear.classList.remove('show'); allClear.style.display = 'none'; }
    }
  }
  function resetActionQueue(){
    document.querySelectorAll('#action-queue .action-card.cleared').forEach(function(c){
      c.classList.remove('cleared');
      var actionKey = c.getAttribute('data-action');
      _restore(actionKey);
    });
    updateQueueProgress();
    recomputeStaffingRisk();
    toast('Queue reset · all tasks restored');
  }


  function goto(view){
    // The legacy Fleet page (#view-fleet) was retired; its content now
    // lives on the new sidebar Fleet page (#view-fleet2). Redirect every
    // 'fleet' entry point to 'fleet2' so old callers land on the real page.
    if (view === 'fleet') view = 'fleet2';
    // Interview Day is now a sub-tab inside the Pipeline view.
    if (view === 'interview') {
      goto('pipeline');
      if (typeof pipeSub === 'function') pipeSub('interview');
      return;
    }
    // The Fleet calendar is one shared node hosted by either the
    // Fleet or the Schedule view; this opens it on the Fleet page.
    if (view === 'fleet-calendar') {
      goto('fleet');
      if (typeof fleetSub === 'function') fleetSub('calendar');
      return;
    }
    // If the operator parked #dr-sub-roster inside Onboarding via
    // the Roster cmd-tab and is now navigating to Drivers, return
    // the roster node to Drivers BEFORE Drivers paints — otherwise
    // Drivers would render with an empty Roster sub-view.
    if (view === 'drivers' && typeof window._obUnmountDriverRoster === 'function') {
      try { window._obUnmountDriverRoster(); } catch (_) {}
    }
    // Leaving any view: if the shared roster mount is currently borrowed
    // by a Schedule roster/attendance sub-view, return the embedded
    // Drivers node to #view-drivers and park #ob-roster-mount back in its
    // Onboarding home, so the single relocatable node isn't left inside a
    // now-hidden Schedule host. No-op when it was never borrowed.
    if (typeof window._schedUnmountRosterSub === 'function') {
      try { window._schedUnmountRosterSub(); } catch (_) {}
    }
    document.querySelectorAll('.view').forEach(function(v){ v.classList.remove('active'); });
    var target = document.getElementById('view-' + view);
    if (target) target.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); });
    // Forms / Checklists live under the Workspaces sidebar icon now.
    var navView = (view === 'forms' || view === 'checklists') ? 'workspaces' : view;
    var navBtn = document.querySelector('.nav-item[data-view="' + navView + '"]');
    if (navBtn) navBtn.classList.add('active');
    var titles = {
      dashboard: 'Dashboard',
      pipeline: 'Hiring Pipeline',
      drivers: 'Drivers',
      'onboarding-ops': 'Onboarding',
      interview: 'Interview Day',
      staffing: 'Performance Management',
      fleet: 'Fleet',
      fleet2: 'Fleet',
      compliance: 'Compliance',
      schedule: 'Schedule',
      overtime: 'Overtime Intelligence',
      outlook: 'Staffing outlook',
      analytics: 'Analytics',
      okami: 'OKAMI',
      messages: 'Messages',
      email: 'Fleet Bridge',
      workspaces: 'Workspaces',
      forms: 'Workspaces',
      checklists: 'Workspaces',
      documents: 'Documents',
      finances: 'Finances',
      build: 'Build Your Own Tool',
      settings: 'Settings',
      checkin: "Today's Check-in"
    };
    var contexts = {
      dashboard: 'Cycle 14 · Day 3 of 28',
      pipeline: 'Cycle 14 · 48 applicants',
      drivers: '78 active · 5 at risk',
      interview: 'Friday, May 4 · 7 booked · auto-SMS on every action',
      staffing: 'Live · headcount + bench + pipeline = accountability budget',
      fleet: 'Van roster · drivers · service history',
      fleet2: 'Van roster · drivers · service history',
      compliance: 'Live operational risk · continuous monitoring across fleet, drivers, vendors, DOT',
      schedule: 'Week of May 1–7 · 5 pending approvals',
      overtime: 'Operational labor exposure · projected before payroll closes',
      okami: '13-week strategic capacity plan',
      messages: '7 unread · 12 active drivers',
      workspaces: 'Operational boards · assign to drivers, track to done',
      forms: '12 forms · 47 submissions this week',
      checklists: '14 checklists · 4 due now',
      finances: '$14,420 recovered YTD · 3 invoices pending review',
      build: 'No-code tool builder · 5 saved tools',
      settings: 'Cardinal Logistics · KMO1',
      checkin: 'Tuesday, May 1 · 78 expected'
    };
    // tb-title / tb-context were removed from the topbar — page-level h1 carries the title now.
    // (titles[] / contexts[] kept for future use, e.g. document.title updates.)
    if (titles[view]) document.title = titles[view] + ' · RouteReady';
    // Compliance · re-anchor to the Active Risks pane on (re-)entry.
    if (view === 'compliance' && typeof coPane === 'function') {
      var openPane = document.querySelector('#co-rail .co-rail-item.is-active');
      if (!openPane) coPane('risks');
    }
    window.scrollTo({top:0,behavior:'instant'});
  }

  // ─── BUILD YOUR OWN TOOL ───────────────────────────────────
  var BUILD_PROMPT_TEMPLATES = {
    'Analyze time theft': 'I want to analyze time theft by comparing paid hours, route activity, and delivery scan timestamps.',
    'Track call-outs': 'I want to track driver call-outs by date, reason, day-of-week, and notice given so I can spot patterns.',
    'Identify van damage patterns': 'I want to identify van damage patterns by driver, vehicle, damage type, and route to find repeat issues.',
    'Build a driver coaching tracker': 'I want a coaching tracker that logs every conversation by driver, category, outcome, and follow-up date.',
    'Monitor training completion': 'I want to monitor training completion by driver, course, due date, and overdue status.',
    'Flag repeat safety issues': 'I want to flag repeat safety issues — Mentor events, accidents, complaints — by driver and severity.',
    'Compare route assignments to actual hours': 'I want to compare scheduled route assignments to actual hours worked to find variance and overage.'
  };
  function setBuildPrompt(btn){
    var label = (btn.textContent || '').trim();
    var ta = document.getElementById('build-prompt');
    if (!ta) return;
    ta.value = BUILD_PROMPT_TEMPLATES[label] || label;
    ta.focus();
    document.querySelectorAll('.bb-suggest').forEach(function(s){ s.classList.remove('active'); });
    btn.classList.add('active');
  }

  // ─── COACH DRAWER ──────────────────────────────────────────
  var MOCK_DRIVERS = [
    {name:'Marcus Davidson', meta:'KMO1 · Score 62 · 18 mo tenure'},
    {name:'Tasha Reyes',     meta:'KMO2 · Score 68 · 9 mo tenure'},
    {name:'Kerwin Whitfield',meta:'KMO1 · Score 71 · 24 mo tenure'},
    {name:'Jordan Beckett',  meta:'KMO3 · Score 73 · 6 mo tenure'},
    {name:'Asha Thornton',   meta:'KMO2 · Score 74 · 14 mo tenure'},
    {name:'Devon Patterson', meta:'KMO3 · Score 79 · 11 mo tenure'},
    {name:'Camille Foster',  meta:'KMO1 · Score 82 · 22 mo tenure'},
  ];

  function openCoachDrawer(driverName, category, contextText){
    var drawer = document.getElementById('cd-drawer');
    var backdrop = document.getElementById('cd-backdrop');
    drawer.classList.add('open');
    backdrop.classList.add('open');
    document.body.style.overflow = 'hidden';

    if (driverName) {
      cdSelectDriver(driverName);
    } else {
      cdShowSearch();
    }
    if (category) cdSetCategoryByValue(category);
    if (contextText) {
      document.getElementById('cd-context').style.display = 'flex';
      document.getElementById('cd-context-text').textContent = contextText;
    } else {
      document.getElementById('cd-context').style.display = 'none';
    }
  }
  function closeCoachDrawer(){
    document.getElementById('cd-drawer').classList.remove('open');
    document.getElementById('cd-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }
  function cdSelectDriver(name){
    var d = MOCK_DRIVERS.find(function(x){ return x.name === name; }) || {name:name, meta:'Driver record'};
    var initials = d.name.split(' ').map(function(p){ return p[0]; }).join('').slice(0,2).toUpperCase();
    document.getElementById('cd-driver-initials').textContent = initials;
    document.getElementById('cd-driver-name').textContent = d.name;
    document.getElementById('cd-driver-meta').textContent = d.meta;
    document.getElementById('cd-driver-selected').style.display = 'flex';
    document.getElementById('cd-driver-search-wrap').style.display = 'none';
  }
  function cdShowSearch(){
    document.getElementById('cd-driver-selected').style.display = 'none';
    document.getElementById('cd-driver-search-wrap').style.display = 'block';
    var input = document.querySelector('.cd-driver-search');
    input.value = '';
    setTimeout(function(){ input.focus(); }, 50);
  }
  function cdSearchInput(q){
    var results = document.getElementById('cd-search-results');
    if (!q) { results.style.display = 'none'; return; }
    var matches = MOCK_DRIVERS.filter(function(d){ return d.name.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
    results.style.display = matches.length ? 'block' : 'none';
    results.innerHTML = matches.slice(0,5).map(function(d){
      return '<div style="padding:var(--s-2-5) var(--s-3);border-bottom:1px solid var(--border);cursor:pointer" onmouseover="this.style.background=\'var(--canvas)\'" onmouseout="this.style.background=\'\'" onclick="cdSelectDriver(\'' + d.name + '\')"><div style="font-weight:600;color:var(--text)">' + d.name + '</div><div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:1px">' + d.meta + '</div></div>';
    }).join('');
  }
  function cdSetSegment(seg){
    document.querySelectorAll('.cd-segment').forEach(function(s){ s.classList.remove('active'); });
    document.querySelector('.cd-segment[data-seg="' + seg + '"]').classList.add('active');
    ['sms','inperson','pull','suspend'].forEach(function(s){
      document.getElementById('cd-view-' + s).style.display = (s === seg) ? 'block' : 'none';
    });
    var sendBtn = document.getElementById('cd-send-btn');
    if (seg === 'sms') sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send SMS';
    else if (seg === 'inperson') sendBtn.innerHTML = 'Log 1:1';
    else if (seg === 'pull') sendBtn.innerHTML = 'Pull from route';
    else if (seg === 'suspend') {
      sendBtn.innerHTML = 'Suspend driver';
      if (window.cdPopulateSuspendForm) {
        var nameEl = document.getElementById('cd-driver-name');
        if (nameEl) cdPopulateSuspendForm(nameEl.textContent.trim());
      }
    }
  }
  function cdSetPill(el, group){
    el.parentElement.querySelectorAll('.cd-pill').forEach(function(p){ p.classList.remove('active'); });
    el.classList.add('active');
  }
  function cdTogglePill(el){ el.classList.toggle('active'); }
  function cdSetCategoryByValue(cat){
    var el = document.querySelector('.cd-pill[data-cat="' + cat + '"]');
    if (el) cdSetPill(el, 'cat');
  }

  // Keyboard: 'C' opens drawer, Esc closes
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closeCoachDrawer();
    if (e.key === 'c' && !e.metaKey && !e.ctrlKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      openCoachDrawer();
    }
  });

  // ─── SCHEDULE SUB-NAV ───────────────────────────────────────
  function schedSub(sub){
    document.querySelectorAll('#view-schedule .subnav-item').forEach(function(b){ b.classList.remove('active'); });
    var tab = document.querySelector('#view-schedule .subnav-item[data-sub="' + sub + '"]');
    if (tab) tab.classList.add('active');
    document.querySelectorAll('.sched-subview').forEach(function(v){ v.style.display = 'none'; });
    var panel = document.getElementById('sched-sub-' + sub);
    if (panel) panel.style.display = 'block';
    // Roster / Attendance sub-views host the shared portable Drivers
    // node (#ob-roster-mount). Mount it into the matching schedule host
    // when entering, and restore it to its Onboarding home (returning
    // the embedded Drivers sub-view to #view-drivers) when switching to
    // any other schedule sub-view — so the single relocatable node is
    // never orphaned or left in two places.
    if (sub === 'roster' || sub === 'attendance') {
      if (typeof window._schedMountRosterSub === 'function') window._schedMountRosterSub(sub);
    } else if (typeof window._schedUnmountRosterSub === 'function') {
      window._schedUnmountRosterSub();
    }
    // Targets sub-view swaps the schedule KPI strip for its own
    // Block / Cushion / Report-time KPI strip (same size + spot).
    var kpisSched   = document.getElementById('rr-sched-kpis');
    var kpisTargets = document.getElementById('rr-sched-targets-kpis');
    var isRosterSub = (sub === 'roster' || sub === 'attendance');
    if (kpisTargets) kpisTargets.style.display = (sub === 'targets') ? '' : 'none';
    // The Schedule KPI board (#rr-sched-kpis) stays visible for Roster /
    // Attendance — the ROSTER pills are rendered directly ONTO it
    // (operator request) instead of swapping in a separate strip. Only
    // Targets hides it (it shows its own board).
    if (kpisSched) kpisSched.style.display = (sub === 'targets' || sub === 'week') ? 'none' : '';
    if (isRosterSub) {
      // Paint the roster pills onto the board now (data is usually already
      // loaded from a prior mount); refreshDriverStatRow keeps it live on
      // any later data refresh. Cache the board's own pills on first swap.
      var rosterKpisEl = document.getElementById('rr-roster-kpis');
      if (kpisSched && rosterKpisEl && rosterKpisEl.innerHTML.trim()) {
        if (window._schedKpiSavedHtml == null) window._schedKpiSavedHtml = kpisSched.innerHTML;
        kpisSched.innerHTML = rosterKpisEl.innerHTML;
      }
    } else if (kpisSched && window._schedKpiSavedHtml != null) {
      // Leaving roster/attendance for another schedule sub · restore the
      // board's own schedule pills.
      kpisSched.innerHTML = window._schedKpiSavedHtml;
      window._schedKpiSavedHtml = null;
    }
  }

  // ─── DRIVERS SUB-NAV ───────────────────────────────────────
  function drSub(sub){
    document.querySelectorAll('.subnav-item').forEach(function(b){ b.classList.remove('active'); });
    document.querySelector('.subnav-item[data-sub="' + sub + '"]').classList.add('active');
    document.querySelectorAll('.dr-subview').forEach(function(v){ v.classList.remove('active'); });
    document.getElementById('dr-sub-' + sub).classList.add('active');
  }
  // ─── RECOGNITION SUB-NAV ───────────────────────────────────
  // Scoped to #view-recognition so it doesn't fight with drSub (both
  // share the .subnav-item class).  Sub-panels use the .rg-sub class
  // and IDs of the form recog-sub-<sub>.
  function recogSub(sub){
    document.querySelectorAll('#view-recognition .subnav-item').forEach(function(b){ b.classList.remove('active'); });
    var btn = document.querySelector('#view-recognition .subnav-item[data-sub="' + sub + '"]');
    if (btn) btn.classList.add('active');
    document.querySelectorAll('#view-recognition .rg-sub').forEach(function(v){ v.classList.remove('active'); });
    var pane = document.getElementById('recog-sub-' + sub);
    if (pane) pane.classList.add('active');
    if (typeof window.loadRecognitionSubPane === 'function') window.loadRecognitionSubPane(sub);
  }
  function pipeSub(sub){
    document.querySelectorAll('#view-pipeline .subnav-item').forEach(function(b){ b.classList.remove('active'); });
    var btn = document.querySelector('#view-pipeline .subnav-item[data-pipesub="' + sub + '"]');
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.pipe-subview').forEach(function(v){ v.style.display = 'none'; v.classList.remove('active'); });
    var view = document.getElementById('pipe-sub-' + sub);
    if (view) { view.style.display = ''; view.classList.add('active'); }
    // Render coverage panel when funnel sub-view becomes active
    if (sub === 'funnel') setTimeout(pipeRenderForecast, 30);
  }

  // ── Compliance · pane router + risk drawer toggle.
  //   The workspace is one view with a left rail; coPane swaps the
  //   active pane and keeps the rail in sync.  coRiskToggle is plain
  //   progressive disclosure on a risk row — no modal, context stays
  //   in place.
  function coPane(pane){
    document.querySelectorAll('#co-rail .co-rail-item').forEach(function(b){ b.classList.remove('is-active'); });
    var btn = document.querySelector('#co-rail .co-rail-item[data-co-pane="' + pane + '"]');
    if (btn) btn.classList.add('is-active');
    document.querySelectorAll('#view-compliance .co-pane').forEach(function(p){ p.classList.remove('is-active'); });
    var panel = document.getElementById('co-pane-' + pane);
    if (panel) panel.classList.add('is-active');
    if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.coPane = coPane;

  // Legacy alias from the previous Risks/Monitoring two-tab build —
  // keep alive for any deep link emitted before the rebuild.
  function complianceSub(sub){
    if (sub === 'monitoring') return coPane('library');
    if (sub === 'risks') return coPane('risks');
    return coPane(sub);
  }
  window.complianceSub = complianceSub;

  function coRiskToggle(card){
    if (!card) return;
    card.classList.toggle('is-open');
  }
  window.coRiskToggle = coRiskToggle;

  // ═══════════════════════════════════════════════════════════════
  // PIPELINE COVERAGE — 5-week demand vs pipeline projection
  //   - Reads OKAMI demand (drivers needed per week) from the OKAMI
  //     table or a static seed if not yet rendered
  //   - Reads pipeline counts from the stage-tab badges
  //   - Reads show + hire rates from the existing KPI inputs
  //   - Distributes projected hires across weeks based on stage
  //     (booked → ~week 0–1, passed → ~week 1–2, screening → 2–3,
  //      new → 3–4) using cycle velocity as the driver
  //   - Surfaces per-week verdict + a single recommendation:
  //     "Add X applicants this week to cover Week N"
  // ═══════════════════════════════════════════════════════════════

  // Seed values for OKAMI weeks 0..12, taken from the static okami-tbody.
  // First 3 entries get overridden by RR_OKAMI_DAILY[0..2] when the user
  // edits daily targets; weeks 3+ stay static unless OKAMI table is edited.
  var RR_OKAMI_FORECAST_SEED = [
    { idx:0,  label:'W19', dateLabel:'May 1–7',     routesMax:38, driversNeeded:85,  driversAvail:78 },
    { idx:1,  label:'W20', dateLabel:'May 8–14',    routesMax:40, driversNeeded:90,  driversAvail:81 },
    { idx:2,  label:'W21', dateLabel:'May 15–21',   routesMax:42, driversNeeded:94,  driversAvail:86 },
    { idx:3,  label:'W22', dateLabel:'May 22–28',   routesMax:45, driversNeeded:101, driversAvail:90 },
    { idx:4,  label:'W23', dateLabel:'May 29–Jun 4',routesMax:72, driversNeeded:161, driversAvail:90, hve:true }
  ];

  // Read live values from the OKAMI table where possible; otherwise use seed.
  function pipeReadOkamiWeek(idx){
    var seed = RR_OKAMI_FORECAST_SEED[idx];
    if (!seed) return null;
    var row = document.querySelectorAll('#okami-tbody tr[id^="okami-row-"]')[idx]
            || document.querySelectorAll('#okami-tbody tr:not(.okami-detail)')[idx];
    if (!row) return Object.assign({}, seed);
    var cells = row.querySelectorAll('td');
    var routesInput = cells[1] && cells[1].querySelector('input.plan-route-input');
    var routesMax = routesInput ? (parseInt(routesInput.value, 10) || seed.routesMax) : seed.routesMax;
    var driversNeededEl = cells[2] && cells[2].querySelector('.plan-calc');
    var driversAvailEl = cells[3] && cells[3].querySelector('.plan-calc');
    var driversNeeded = driversNeededEl ? (parseInt(driversNeededEl.textContent, 10) || seed.driversNeeded) : seed.driversNeeded;
    var driversAvail = driversAvailEl ? (parseInt(driversAvailEl.textContent, 10) || seed.driversAvail) : seed.driversAvail;
    return { idx:idx, label:seed.label, dateLabel:seed.dateLabel, routesMax:routesMax, driversNeeded:driversNeeded, driversAvail:driversAvail, hve:seed.hve };
  }

  // Read pipeline stage counts from the stage-tab badges
  function pipeReadStageCounts(){
    var counts = { all:0, new:0, screening:0, passed:0, booked:0, hired:0 };
    document.querySelectorAll('#pipeline-stage-tabs .stage-tab').forEach(function(b){
      var stage = b.getAttribute('data-stage');
      var cn = b.querySelector('.stage-tab-count');
      if (stage && cn) counts[stage] = parseInt(cn.textContent, 10) || 0;
    });
    return counts;
  }

  function pipeReadRates(){
    // New banner IDs (post-redesign); old IDs removed.
    var s = document.getElementById('hp-show-rate');
    var h = document.getElementById('hp-hire-rate');
    return {
      showPct: (s ? parseFloat(s.textContent) : 72) / 100,
      hirePct: (h ? parseFloat(h.textContent) : 31) / 100,
      cycleDays: 9.2
    };
  }

  // Distribute projected hires across the 5 weeks based on stage.
  // The math: each stage has a typical "days-to-hire" remaining. Booked
  // candidates can convert in ~3 days, passed ~5, screening ~7, new ~9.
  // We bucket those time-to-hire estimates into week buckets (0–7, 8–14,
  // 15–21, 22–28, 29–35) and apply combined show × hire conversion.
  function pipeProjectHiresByWeek(){
    var counts = pipeReadStageCounts();
    var rates = pipeReadRates();
    // Combined conversion = show × hire (already-booked applicants only need hire interview to convert; rest needs both)
    var convPostBook = rates.hirePct;                     // booked already passed screening + showed
    var convFromPassed = rates.showPct * rates.hirePct;   // passed → still need to show + hire
    var convFromScreening = 0.85 * rates.showPct * rates.hirePct; // ~85% pass screening
    var convFromNew = 0.55 * rates.showPct * rates.hirePct;       // ~55% engage and reach screening
    // Expected hires from each stage
    var hBooked = counts.booked * convPostBook;
    var hPassed = counts.passed * convFromPassed;
    var hScreening = counts.screening * convFromScreening;
    var hNew = counts['new'] * convFromNew;
    // Distribute across weeks (smoothed over 2 buckets each, with stage center)
    // Returns array of length 5
    var byWeek = [0, 0, 0, 0, 0];
    function dist(total, centerWeek){
      // 70% in centerWeek, 20% in centerWeek-1, 10% in centerWeek+1
      var idx = Math.max(0, Math.min(4, centerWeek));
      byWeek[idx] += total * 0.7;
      if (idx - 1 >= 0) byWeek[idx - 1] += total * 0.2;
      if (idx + 1 <= 4) byWeek[idx + 1] += total * 0.1;
    }
    dist(hBooked, 0);    // Booked → land mostly week 0
    dist(hPassed, 1);    // Passed → week 1
    dist(hScreening, 2); // Screening → week 2
    dist(hNew, 3);       // New → week 3
    return byWeek;
  }

  function pipeForecast(){
    var weeks = [0,1,2,3,4].map(pipeReadOkamiWeek).filter(Boolean);
    var byWeek = pipeProjectHiresByWeek();
    // Cumulative drivers expected to be live by start of each week
    var startingActive = weeks[0] ? weeks[0].driversAvail : 78;
    var cumHires = 0;
    return weeks.map(function(w, i){
      cumHires += byWeek[i] || 0;
      var projectedActive = startingActive + Math.floor(cumHires);
      var gap = projectedActive - w.driversNeeded;
      var verdict = w.hve ? 'hve' : (gap >= 0 ? 'ok' : Math.abs(gap) <= 5 ? 'warn' : 'bad');
      return {
        idx: w.idx, label: w.label, dateLabel: w.dateLabel,
        routesMax: w.routesMax, driversNeeded: w.driversNeeded, driversAvail: w.driversAvail,
        projectedHires: byWeek[i] || 0,
        cumulativeHires: Math.floor(cumHires),
        projectedActive: projectedActive,
        gap: gap, verdict: verdict, hve: w.hve
      };
    });
  }

  function pipeRenderForecast(){
    var grid = document.getElementById('pipe-coverage-grid');
    if (!grid) return;
    var rows = pipeForecast();

    grid.innerHTML = rows.map(function(r, i){
      var cardClass = i === 0 ? 'today' : (r.verdict === 'bad' || r.verdict === 'hve' ? 'critical' : (r.verdict === 'warn' ? 'short' : ''));
      var gapNum   = r.hve ? 'HVE'      : (r.gap >= 0 ? '+' + r.gap : r.gap.toString());
      var gapLabel = r.hve ? 'absorb'   : (r.gap >= 0 ? 'covered'   : 'short');
      var gapCls   = r.hve ? 'bad' : (r.gap >= 0 ? 'ok' : Math.abs(r.gap) <= 5 ? 'warn' : 'bad');
      var weekLabel = i === 0 ? 'This week' : '+' + i + (i === 1 ? ' wk' : ' wks');
      var tooltip = 'Routes max ' + r.routesMax
                  + ' · drivers needed ' + r.driversNeeded
                  + ' · active+projected ' + r.projectedActive
                  + ' · pipeline delivers +' + (Math.round(r.projectedHires * 10) / 10);
      return '<div class="pipe-week-card ' + cardClass + '" title="' + tooltip + '">'
        + '<div class="pipe-week-head">'
          + '<span class="pipe-week-label">' + weekLabel + '</span>'
          + '<span class="pipe-week-date">' + r.label + '</span>'
        + '</div>'
        + '<div class="pipe-week-gap-big ' + gapCls + '">'
          + '<div class="pipe-week-gap-num">' + gapNum + '</div>'
          + '<div class="pipe-week-gap-lbl">' + gapLabel + '</div>'
        + '</div>'
        + '<div class="pipe-week-foot">' + r.driversNeeded + ' needed · ' + r.projectedActive + ' projected</div>'
      + '</div>';
    }).join('');

    // Overall verdict: count weeks short
    var shortCount = rows.filter(function(r){ return r.gap < 0 && !r.hve; }).length;
    var hveCount = rows.filter(function(r){ return r.hve; }).length;
    var verdictEl = document.getElementById('pipe-coverage-overall');
    if (verdictEl) {
      if (shortCount === 0 && hveCount === 0) {
        verdictEl.className = 'pipe-coverage-verdict ok';
        verdictEl.textContent = '✓ All 5 weeks covered';
      } else if (shortCount <= 1 && hveCount === 0) {
        verdictEl.className = 'pipe-coverage-verdict warn';
        verdictEl.textContent = shortCount + ' week short';
      } else {
        verdictEl.className = 'pipe-coverage-verdict bad';
        verdictEl.textContent = shortCount + ' week' + (shortCount === 1 ? '' : 's') + ' short' + (hveCount > 0 ? ' · ' + hveCount + ' HVE' : '');
      }
    }

    // Recommendation
    var recText = document.getElementById('pipe-coverage-rec-text');
    if (recText) recText.innerHTML = pipeRecommend(rows);

    // Math line
    var math = document.getElementById('pipe-coverage-math');
    if (math) {
      var rates = pipeReadRates();
      var counts = pipeReadStageCounts();
      math.innerHTML = '<strong style="color:var(--text)">Math:</strong> Show rate ' + Math.round(rates.showPct * 100) + '% · Hire rate '
        + Math.round(rates.hirePct * 100) + '% · Cycle ' + rates.cycleDays.toFixed(1) + ' days · Pipeline today: '
        + counts['new'] + ' new · ' + counts.screening + ' screening · ' + counts.passed + ' passed · '
        + counts.booked + ' booked. Conversion modeled per stage based on remaining funnel steps.';
    }
  }

  function pipeRecommend(rows){
    var rates = pipeReadRates();
    // Find the largest gap among non-HVE weeks
    var worst = rows.filter(function(r){ return !r.hve && r.gap < 0; }).sort(function(a, b){ return a.gap - b.gap; })[0];
    if (!worst) {
      return 'Pipeline is adequate for the next 5 weeks. Maintain inflow at current Indeed spend; no acceleration needed.';
    }
    // Hires needed = absolute gap in worst week
    var hiresNeeded = Math.abs(worst.gap);
    // To net X hires, you need X / overall conversion. Assume new applicants enter as "new" stage (lowest conversion).
    var convFromNew = 0.55 * rates.showPct * rates.hirePct;
    var applicantsNeeded = Math.ceil(hiresNeeded / Math.max(convFromNew, 0.05));
    return '<strong>Add ~' + applicantsNeeded + ' applicants to the funnel this week</strong> to cover ' + worst.label
      + ' (' + worst.dateLabel + ', short ' + Math.abs(worst.gap) + ' driver' + (Math.abs(worst.gap) === 1 ? '' : 's') + '). '
      + 'New applicants entering today convert at ~' + Math.round(convFromNew * 100) + '% (after screening, show, and hire). '
      + 'Boost Indeed spend or open referral payouts to accelerate inflow.';
  }
  window.pipeRenderForecast = pipeRenderForecast;

  // Re-render whenever OKAMI changes affect demand
  if (typeof okamiRenderDailyPanel === 'function' && !okamiRenderDailyPanel._wrappedForPipe) {
    var _origOkamiPanel = okamiRenderDailyPanel;
    okamiRenderDailyPanel = function(weekIdx){
      _origOkamiPanel(weekIdx);
      // If pipeline funnel is currently visible, refresh it
      var visible = document.querySelector('#pipe-sub-funnel.active') || document.querySelector('#pipe-sub-funnel:not([style*="display: none"])');
      if (visible && document.getElementById('view-pipeline').classList.contains('active')) {
        setTimeout(pipeRenderForecast, 30);
      }
    };
    okamiRenderDailyPanel._wrappedForPipe = true;
  }

  // Render on view nav
  if (typeof goto === 'function' && !goto._wrappedForPipeForecast) {
    var _origGotoForPipeForecast = goto;
    goto = function(view){
      _origGotoForPipeForecast(view);
      if (view === 'pipeline') setTimeout(pipeRenderForecast, 60);
    };
    goto._wrappedForPipeForecast = true;
  }

  document.addEventListener('DOMContentLoaded', pipeRenderForecast);
  if (document.readyState !== 'loading') pipeRenderForecast();
  function sgToggle(btn){
    btn.classList.toggle('on');
    if (btn.classList.contains('on')) {
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    } else {
      btn.innerHTML = '';
    }
  }
  // ─── AI AUTO-SCHEDULE ──────────────────────────────────────
  function openAiSchedule(){ openModal('modal-ai-schedule'); }

  // ─── SCHEDULE LIFECYCLE — Draft → Review → Posted ─────────
  var _scheduleStage = 'draft';
  function setLifecycleStage(stage){
    _scheduleStage = stage;
    const cta = document.getElementById('schedule-cta');
    if (!cta) return;
    if (stage === 'draft') {
      cta.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Finalize draft';
    } else if (stage === 'review') {
      cta.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Continue to post';
    } else if (stage === 'posted') {
      cta.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Make changes';
      toast('Schedule posted · 78 drivers notified by SMS + push');
    }
  }
  function advanceSchedule(){
    if (_scheduleStage === 'draft') {
      setLifecycleStage('review');
      openModal('modal-schedule-review');
    } else if (_scheduleStage === 'review') {
      openModal('modal-schedule-post');
    } else {
      setLifecycleStage('draft');
      toast('Reopened as draft · changes will require re-post');
    }
  }

  // ─── SCHEDULE BUILDER — click-to-assign + drag-drop sim ───
  function wireBuilder(){
    // Click any open shift placeholder → assign from pool
    document.querySelectorAll('#sched-sub-week .shift-chip.open').forEach(function(chip){
      if (chip.dataset.builderWired) return;
      chip.dataset.builderWired = '1';
      chip.addEventListener('click', function(e){
        e.stopPropagation();
        const txt = chip.textContent.trim();
        toast('Pick a driver from the pool to assign to ' + txt);
      });
    });
    // Click a filled shift → reassign
    document.querySelectorAll('#sched-sub-week .shift-chip:not(.open):not(.off):not(.timeoff)').forEach(function(chip){
      if (chip.dataset.builderWired) return;
      chip.dataset.builderWired = '1';
      chip.addEventListener('click', function(e){
        e.stopPropagation();
        const route = chip.querySelector('.shift-chip-route');
        toast('Reassign · move · or remove ' + (route ? route.textContent : 'shift'));
      });
    });
    // Pool drag start → set ghost
    document.querySelectorAll('.pool-driver[draggable="true"]').forEach(function(d){
      if (d.dataset.dndWired) return;
      d.dataset.dndWired = '1';
      d.addEventListener('dragstart', function(e){
        const name = d.querySelector('.pool-driver-name');
        e.dataTransfer.setData('text/plain', name ? name.textContent : 'driver');
      });
    });
    document.querySelectorAll('#sched-sub-week .cal-cell').forEach(function(cell){
      if (cell.dataset.dndWired) return;
      cell.dataset.dndWired = '1';
      cell.addEventListener('dragover', function(e){ e.preventDefault(); cell.style.background = 'var(--accent-soft)'; });
      cell.addEventListener('dragleave', function(){ cell.style.background = ''; });
      cell.addEventListener('drop', function(e){
        e.preventDefault();
        cell.style.background = '';
        const name = e.dataTransfer.getData('text/plain') || 'Driver';
        toast(name + ' assigned to this shift');
        // bump gauge
        const fill = document.getElementById('builder-gauge-fill');
        const pct = document.getElementById('builder-gauge-pct');
        const filled = document.getElementById('builder-filled');
        if (fill && pct && filled) {
          const newCount = Math.min(45, parseInt(filled.textContent) + 1);
          filled.textContent = newCount;
          const newPct = Math.round(newCount / 45 * 100);
          fill.style.width = newPct + '%';
          pct.textContent = newPct + '%';
        }
      });
    });
  }
  setTimeout(wireBuilder, 250);
  // Re-wire after sub-view switch
  const _origSchedSubB = (typeof schedSub === 'function') ? schedSub : null;
  if (_origSchedSubB) {
    schedSub = function(s){ _origSchedSubB(s); setTimeout(wireBuilder, 80); };
  }

  // ─── OKAMI ────────────────────────────────────────────────
  var okamiAvail = [78,81,86,90,90,94,96,100,104,108,112,112,115];
  // Mockup recalcOkami removed. live.js owns the OKAMI table via
  // window.renderOkamiLive — real driver count, real OKAMI demand, no
  // hardcoded okamiAvail[] overwrites.
  function recalcOkami(){
    if (typeof window.renderOkamiLive === 'function') {
      window.renderOkamiLive();
    }
  }
  function toggleSeasonal(input){
    const lbl = input.closest('.okami-knob').querySelector('.okami-knob-value');
    if (lbl) lbl.textContent = input.checked ? 'On' : 'Off';
    toast(input.checked ? 'Seasonal hiring enabled — Oct 15 – Jan 5' : 'Seasonal hiring disabled');
  }

  // ─── ROUTE PLAN — live recalc ──────────────────────────────
  var planAvailable = [78, 81, 86, 90, 90, 94, 100, 108]; // adjusted by week
  function recalcPlan(){
    const cushion = (parseFloat(document.getElementById('cushion-range').value) || 12) / 100;
    const tbody = document.getElementById('plan-tbody');
    if (!tbody) return;
    let totalGap = 0;
    tbody.querySelectorAll('tr').forEach(function(row, i){
      const input = row.querySelector('.plan-route-input');
      if (!input) return;
      const routes = parseInt(input.value) || 0;
      const base = routes * 2;
      const cush = Math.ceil(base * cushion);
      const needed = base + cush;
      const available = planAvailable[i] || 78;
      const gap = available - needed;

      const cells = row.querySelectorAll('td');
      // Drivers needed
      cells[2].innerHTML = '<div class="plan-calc">' + needed + '</div><div class="plan-calc-sub">' + base + ' base + ' + cush + ' cushion</div>';
      // Gap
      const gapEl = cells[4].querySelector('.plan-gap');
      if (gapEl) {
        gapEl.textContent = (gap >= 0 ? '+' : '') + gap;
        gapEl.classList.remove('ok','warn','bad');
        gapEl.classList.add(gap >= 0 ? 'ok' : (gap >= -10 ? 'warn' : 'bad'));
      }
      // Status pill
      const pill = cells[6].querySelector('.plan-status-pill');
      if (pill) {
        pill.classList.remove('ok','warn','bad');
        if (gap >= 0) { pill.classList.add('ok'); pill.innerHTML = '<span class="dot"></span>On track'; }
        else if (gap >= -10) { pill.classList.add('warn'); pill.innerHTML = '<span class="dot"></span>At risk'; }
        else { pill.classList.add('bad'); pill.innerHTML = '<span class="dot"></span>Critical'; }
      }
      if (gap < 0) totalGap += -gap;
    });
    // Update summary headline
    const headline = document.querySelector('.plan-summary-headline');
    if (headline) {
      const screenRate = 0.21;
      const applicantsNeeded = Math.ceil(totalGap / screenRate);
      headline.textContent = 'Hire ' + totalGap + ' drivers by Jun 16';
    }
  }
  function updateCushion(v){
    const valEl = document.querySelector('.plan-controls .plan-control-value');
    // find the cushion control (2nd one)
    const ctrls = document.querySelectorAll('.plan-controls > div');
    if (ctrls[1]) {
      const v2 = ctrls[1].querySelector('.plan-control-value');
      if (v2) v2.innerHTML = v + '<span class="frac">%</span>';
    }
    recalcPlan();
  }

  // ─── SMART DROP — multi-stage modal flow ─────────────────
  function openSmartDrop(){
    sdReset();
    openModal('modal-smart-drop');
    setTimeout(function(){ const t = document.getElementById('sd-paste'); if (t) t.focus(); }, 100);
  }
  function sdReset(){
    document.getElementById('sd-step-1').style.display = 'block';
    document.getElementById('sd-step-2').style.display = 'none';
    document.getElementById('sd-step-3').style.display = 'none';
    document.querySelectorAll('.sd-stage').forEach(function(s){ s.classList.remove('active','done'); });
    document.querySelector('.sd-stage[data-step="1"]').classList.add('active');
    const back = document.getElementById('sd-back-btn');
    const next = document.getElementById('sd-next-btn');
    if (back) back.style.display = 'none';
    if (next) {
      next.style.display = 'inline-flex';
      next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8 22 9 17 14 18 21 12 18 6 21 7 14 2 9 9 8 12 2"/></svg> Analyze with AI';
      next.onclick = sdAnalyze;
    }
    const paste = document.getElementById('sd-paste');
    if (paste) paste.value = '';
  }
  function sdAnalyze(){
    const paste = document.getElementById('sd-paste').value.trim();
    if (paste.length < 10) { toast('Paste some content first (or click an example)', 'warn'); return; }
    document.getElementById('sd-step-1').style.display = 'none';
    document.getElementById('sd-step-2').style.display = 'block';
    document.querySelectorAll('.sd-stage').forEach(function(s){ s.classList.remove('active'); });
    document.querySelector('.sd-stage[data-step="1"]').classList.add('done');
    document.querySelector('.sd-stage[data-step="2"]').classList.add('active');
    document.getElementById('sd-next-btn').style.display = 'none';
    setTimeout(function(){ sdShowResults(); }, 1800);
  }
  function sdShowResults(){
    document.getElementById('sd-step-2').style.display = 'none';
    document.getElementById('sd-step-3').style.display = 'block';
    document.querySelectorAll('.sd-stage').forEach(function(s){ s.classList.remove('active'); });
    document.querySelector('.sd-stage[data-step="2"]').classList.add('done');
    document.querySelector('.sd-stage[data-step="3"]').classList.add('active');
    const back = document.getElementById('sd-back-btn');
    const next = document.getElementById('sd-next-btn');
    if (back) back.style.display = 'inline-flex';
    if (next) {
      next.style.display = 'inline-flex';
      next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Confirm import (4 types · 5 rows)';
      next.onclick = function(){
        closeModal('modal-smart-drop');
        toast('Imported · 5 time entries → Time Integrity · 1 pay record → Driver record · 1 callout → Attendance · 1 bonus → Recognition');
        sdReset();
      };
    }
  }
  function sdBack(){
    sdReset();
    document.getElementById('sd-step-2').style.display = 'none';
    document.getElementById('sd-step-3').style.display = 'none';
  }
  function sdLoadExample(type){
    const examples = {
      payroll: 'Driver: Marcus Davidson\nPosition: Driver · KMO1\nPay period: Apr 22 – Apr 28\n\nClock activity:\n  Mon Apr 22  In: 6:42 AM  Sched: 7:00 AM  Out: 6:18 PM  Sched out: 6:00 PM  +18 min\n  Tue Apr 23  In: 6:55 AM  Sched: 7:00 AM  Out: 5:58 PM  Sched out: 6:00 PM  OK\n  Wed Apr 24  In: 6:50 AM  Sched: 7:00 AM  Out: 6:42 PM  Sched out: 6:00 PM  +42 min\n  Thu Apr 25  CALLOUT\n  Fri Apr 26  In: 7:08 AM  Sched: 7:00 AM  Out: 6:35 PM  Sched out: 6:00 PM  +35 min\n\nHours worked: 47.2\nRegular: 40.0   OT: 7.2\n\nEarnings:\n  Regular wages       $720.00  ($18.00 × 40h)\n  Overtime           $194.40  ($27.00 × 7.2h)\n  Performance bonus   $50.00\n  Gross               $964.40\n  Federal withhold   −$87.45\n  State withhold     −$32.10\n  FICA               −$73.78\n  Net               $771.07\n\nDepartment code: KMO1-DLV-23 · ref-2487-A',
      roster: 'Active Drivers — KMO1\n\nName, Phone, Hire Date, Station\nMarcus Davidson, 417-555-0100, Nov 12 2024, KMO1\nTasha Reyes, 417-555-0142, Aug 4 2025, KMO2\nKerwin Whitfield, 417-555-0193, May 1 2023, KMO1\nJordan Beckett, 417-555-0218, Nov 1 2024, KMO3',
      scorecard: 'Amazon DSP Weekly Scorecard · Cycle 14 Week 3\nDSP: Cardinal Logistics · Station KMO1\n\nOverall: Fantastic\nDCR: 99.6%\nSWC: Fantastic\nDelivered: 4,672 packages\nNo show: 1.1%\nSafety events: 4\n  • Marcus Davidson — hard brake event\n  • Tasha Reyes — speed event (×2)\n  • Jordan Beckett — late return',
      invoice: 'INVOICE · Springfield Truck Service\nDate: April 15, 2025\nVehicle: VAN-04 (5HXXX12345)\n\nServices:\n  Oil change & filter      $45.00\n  Tire rotation             $40.00\n  Air filter replacement    $25.00\n  Labor                     $35.00\n\nSubtotal: $145.00\nTax: $11.60\nTotal: $156.60\n\nNext service due: May 15, 2025 (5,000 mi)'
    };
    document.getElementById('sd-paste').value = examples[type] || '';
    toast('Example loaded · click "Analyze with AI" to see what gets extracted');
  }

  // ─── VEHICLE DETAIL ──────────────────────────────────────
  function openVehicleDetail(name, model, miles, status, driver){
    document.getElementById('veh-name').textContent = name || 'Vehicle';
    if (model) document.getElementById('veh-meta').textContent = model;
    if (miles) document.getElementById('veh-miles').textContent = miles;
    if (status) {
      const el = document.getElementById('veh-status');
      el.textContent = status;
      el.style.color = status === 'Active' ? 'var(--green)' : status === 'In maintenance' ? 'var(--amber)' : 'var(--red)';
    }
    if (driver) document.getElementById('veh-driver').textContent = driver;
    document.getElementById('vehicle-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeVehicleDetail(){
    document.getElementById('vehicle-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── PER-DRIVER SCHEDULE EDITOR ──────────────────────────
  function openScheduleEdit(name){
    const initials = (name || '').split(/\s+/).map(function(p){return p[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('se-initials').textContent = initials || 'DR';
    document.getElementById('se-name').textContent = name || 'Driver schedule';
    document.getElementById('se-meta').textContent = 'Standing weekly pattern · current week May 1–7';
    document.getElementById('sched-edit-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeScheduleEdit(){
    document.getElementById('sched-edit-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── CHECKLIST DETAIL / RUNNER ────────────────────────────
  function openChecklistDetail(name, meta, iconClass){
    if (name) document.getElementById('cl-d-name').textContent = name;
    if (meta) document.getElementById('cl-d-meta').textContent = meta;
    if (iconClass) {
      const ic = document.getElementById('cl-d-icon');
      ic.className = 'cl-card-icon ' + iconClass;
      ic.style.width = '44px'; ic.style.height = '44px';
    }
    document.getElementById('checklist-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeChecklistDetail(){
    document.getElementById('checklist-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }
  function cdRunToggle(row){
    row.classList.toggle('done');
    const check = row.querySelector('.run-task-check');
    if (row.classList.contains('done')) {
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    } else {
      check.innerHTML = '';
    }
    // recalc progress
    const all = document.querySelectorAll('#cl-d-tasks .run-task');
    const done = document.querySelectorAll('#cl-d-tasks .run-task.done').length;
    const pct = Math.round(done / all.length * 100);
    document.getElementById('cl-d-progress').textContent = done;
    document.getElementById('cl-d-bar').style.width = pct + '%';
  }

  // ─── FORM DETAIL/EDITOR ───────────────────────────────────
  function openFormEdit(name, meta){
    if (name) document.getElementById('form-d-name').textContent = name;
    if (meta) document.getElementById('form-d-meta').textContent = meta;
    document.getElementById('form-edit-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeFormEdit(){
    document.getElementById('form-edit-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── SUBMISSION DETAIL ────────────────────────────────────
  function openSubmission(name, status){
    document.getElementById('sub-name').textContent = 'Pre-trip · ' + (name || 'Driver');
    const flagBtn = document.getElementById('sub-action-btn');
    if (status === 'flagged') {
      document.getElementById('sub-tire').textContent = 'One or more tires need attention';
      document.getElementById('sub-tire').style.color = 'var(--amber)';
      flagBtn.style.display = 'inline-flex';
    } else {
      document.getElementById('sub-tire').textContent = 'All four inflated, no damage';
      document.getElementById('sub-tire').style.color = 'var(--green)';
      flagBtn.style.display = 'none';
    }
    document.getElementById('submission-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeSubmission(){
    document.getElementById('submission-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── MAINTENANCE WORK ORDER ──────────────────────────────
  function openWorkOrder(){
    closeVehicleDetail();
    setTimeout(function(){ openModal('modal-work-order'); }, 200);
  }

  // ─── DOCUMENT PREVIEW ────────────────────────────────────
  function openDocPreview(name){
    document.getElementById('doc-preview-name').textContent = name || 'Document';
    openModal('modal-doc-preview');
  }

  // ─── SAFETY QUEUE ─────────────────────────────────────────
  function openSafetyQueue(){
    document.getElementById('safety-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeSafetyQueue(){
    document.getElementById('safety-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── QUALITY QUEUE ────────────────────────────────────────
  function openQualityQueue(){
    document.getElementById('quality-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeQualityQueue(){
    document.getElementById('quality-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── ASSET CATEGORY DRAWER ────────────────────────────────
  var ASSET_CAT_DATA = {
    'Phones':       { meta:'42 assigned · 3 in stock',   prefix:'A1-' },
    'Gas cards':    { meta:'48 assigned · 0 in stock',   prefix:'GC-' },
    'Toll tags':    { meta:'24 assigned · 6 in stock',   prefix:'TT-' },
    'Key fobs':     { meta:'24 assigned · 4 in stock',   prefix:'KF-' },
    'Uniforms':     { meta:'78 assigned · stock varies', prefix:'UN-' },
    'Scanners':     { meta:'42 assigned · 5 in stock',   prefix:'SC-' }
  };
  function openAssetCategory(catName, count){
    var meta = (ASSET_CAT_DATA[catName] && ASSET_CAT_DATA[catName].meta) || (count + ' assets · drilldown');
    document.getElementById('asset-cat-name').textContent = catName || 'Asset category';
    document.getElementById('asset-cat-meta').textContent = meta;
    // Update serial prefixes in the table for visual consistency
    var prefix = (ASSET_CAT_DATA[catName] && ASSET_CAT_DATA[catName].prefix) || 'A1-';
    document.querySelectorAll('#asset-cat-rows tr td:nth-child(2)').forEach(function(td, i){
      var seq = String(4821 + i);
      td.textContent = prefix + '0' + seq;
    });
    document.getElementById('asset-cat-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeAssetCategory(){
    document.getElementById('asset-cat-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── NEW DIRECT MESSAGE PICKER ────────────────────────────
  function renderNewDmList(filter){
    var list = document.getElementById('new-dm-list');
    if (!list) return;
    var q = (filter || '').trim().toLowerCase();
    var html = '';
    (typeof MOCK_DRIVERS !== 'undefined' ? MOCK_DRIVERS : []).forEach(function(d){
      if (q && d.name.toLowerCase().indexOf(q) === -1 && d.meta.toLowerCase().indexOf(q) === -1) return;
      var initials = d.name.split(' ').map(function(p){return p[0];}).join('').slice(0,2);
      html += '<button class="popover-item" style="width:100%;justify-content:flex-start;gap:var(--s-2-5);padding:var(--s-2-5) var(--s-3-5);border-bottom:1px solid var(--border)" onclick="closeModal(\'modal-new-dm\');toast(\'Conversation opened with ' + d.name + '\')">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:var(--canvas);display:inline-flex;align-items:center;justify-content:center;font-size:var(--fs-xs);font-weight:700;color:var(--text-muted)">' + initials + '</div>' +
        '<div style="text-align:left"><div style="font-weight:600;font-size:var(--fs-md);color:var(--text)">' + d.name + '</div><div class="u-xs-subtle">' + d.meta + '</div></div>' +
        '</button>';
    });
    list.innerHTML = html || '<div class="rr-empty-inline">No drivers match "' + filter + '"</div>';
  }
  function filterNewDm(v){ renderNewDmList(v); }
  // Render once on load + whenever the modal opens
  document.addEventListener('DOMContentLoaded', function(){ renderNewDmList(''); });

  // ─── OKAMI STRATEGY PILL CYCLING ─────────────────────────
  function cycleStrategy(pill){
    const opts = ['hire','adw','ot','seasonal'];
    const labels = { hire:'Hire', adw:'ADW 5.5', ot:'+8h OT', seasonal:'Seasonal' };
    let cur = '';
    opts.forEach(function(c){ if (pill.classList.contains(c)) cur = c; });
    const next = opts[(opts.indexOf(cur) + 1) % opts.length];
    opts.forEach(function(c){ pill.classList.remove(c); });
    pill.classList.add(next, 'active');
    pill.textContent = labels[next];
    toast('Strategy switched to ' + labels[next]);
  }

  // ─── MESSAGE QUICK REPLY → fill textarea ─────────────────
  function fillQuickReply(text){
    const ta = document.querySelector('.msg-input');
    if (ta) {
      ta.value = text;
      ta.focus();
    }
  }

  // ─── CONVERSATION SWITCHING (Messages) ────────────────────
  // Already partially wired via selectConversation — extend to swap header
  const _origSelect = (typeof selectConversation === 'function') ? selectConversation : null;
  if (_origSelect) {
    selectConversation = function(el, id){
      _origSelect(el, id);
      const name = el.querySelector('.msg-item-name');
      const headerName = document.querySelector('.msg-conv-name');
      if (name && headerName) headerName.textContent = name.textContent;
    };
  }

  // ─── CHECKLISTS ───────────────────────────────────────────
  // Top tabs (Forms / Workflows / Checklists) keep the Checklists button
  // active whenever we're inside this view.  Inner cl-subtab row toggles
  // between All / Today's status / Templates.
  function checklistSub(sub){
    document.querySelectorAll('#view-checklists .cl-subtab').forEach(function(b){ b.classList.remove('active'); });
    var btn = document.querySelector('#view-checklists .cl-subtab[data-sub="' + sub + '"]');
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.checklist-tab').forEach(function(v){ v.style.display = 'none'; });
    var pane = document.getElementById('checklist-tab-' + sub);
    if (pane) pane.style.display = 'block';
  }

  // ─── FORMS ─────────────────────────────────────────────────
  function formsTab(btn, sub){
    document.querySelectorAll('#view-forms .forms-side-item').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.forms-tab').forEach(function(v){ v.style.display = 'none'; });
    const target = document.getElementById('forms-tab-' + sub);
    if (target) target.style.display = 'block';
  }

  // ─── MESSAGES ──────────────────────────────────────────────
  function msgListTab(btn){
    document.querySelectorAll('.msg-list-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
  }
  function selectConversation(el, id){
    document.querySelectorAll('.msg-item').forEach(function(i){ i.classList.remove('active'); });
    el.classList.add('active');
    // For mockup, just toast — real impl would swap the conversation panel content
    const name = el.querySelector('.msg-item-name');
    if (name) toast('Opened: ' + name.textContent);
  }

  // ─── COVERAGE CONFIDENCE DEEP-DIVE ─────────────────────────
  function openCoverageDetail(){
    document.getElementById('coverage-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeCoverageDetail(){
    document.getElementById('coverage-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── APPLICANT DETAIL DRAWER ───────────────────────────────
  function openApplicantDetail(name, meta, score, source, stage){
    document.getElementById('ap-initials').textContent = (name || '').split(/\s+/).map(function(p){return p[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('ap-name').textContent = name || 'Applicant';
    document.getElementById('ap-meta').textContent = meta || '';
    document.getElementById('ap-score').textContent = score || '—';
    document.getElementById('ap-tier').textContent = (+score >= 7) ? 'Priority' : (+score >= 4) ? 'Standard' : 'Low';
    document.getElementById('ap-source').textContent = source || 'Indeed';
    document.getElementById('ap-stage').textContent = stage || 'New';
    document.getElementById('applicant-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeApplicantDetail(){
    ['applicant-drawer','driver-drawer','coverage-drawer','vehicle-drawer','sched-edit-drawer','checklist-drawer','form-edit-drawer','submission-drawer','recon-drawer'].forEach(function(id){
      const el = document.getElementById(id);
      if (el) el.classList.remove('open');
    });
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
    // The driver record is an inline pane, not a backdrop overlay —
    // collapse the split too so it closes alongside the other drawers.
    var drSplit = document.getElementById('rr-roster-split');
    if (drSplit) drSplit.classList.remove('has-record');
  }

  // ─── FINANCES sub-nav + reconciliation drawer ───────────
  function finSub(sub){
    document.querySelectorAll('#view-finances .subnav-item').forEach(function(b){ b.classList.remove('active'); });
    document.querySelector('#view-finances .subnav-item[data-sub="' + sub + '"]').classList.add('active');
    document.querySelectorAll('.finances-tab').forEach(function(v){ v.style.display = 'none'; });
    document.getElementById('finances-tab-' + sub).style.display = 'block';
  }
  function openReconciliation(id){
    document.getElementById('recon-drawer').classList.add('open');
    document.getElementById('ap-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeReconciliation(){
    document.getElementById('recon-drawer').classList.remove('open');
    document.getElementById('ap-backdrop').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── TIME INTEGRITY drill-down toggle ────────────────────
  function toggleTiDetail(row){
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains('ti-detail')) {
      detail.classList.toggle('open');
    }
  }

  // ─── DRIVER RECORD TABS ───────────────────────────────────
  function drTab(btn){
    document.querySelectorAll('.dr-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    const id = btn.getAttribute('data-tab');
    document.querySelectorAll('.dr-tabview').forEach(function(v){ v.classList.remove('active'); });
    const target = document.getElementById('dr-tabview-' + id);
    if (target) target.classList.add('active');
  }

  // ─── DRIVER DETAIL DRAWER ──────────────────────────────────
  function openDriverDetail(name, station, tenure, score, attendance){
    const setText = function(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('dr-initials', (name || '').split(/\s+/).map(function(p){return p[0];}).join('').slice(0,2).toUpperCase());
    setText('dr-name', name || 'Driver');
    setText('dr-meta', (station ? station + ' · ' : '') + (tenure || '') + ' tenure');
    setText('dr-score', score || '—');
    setText('dr-att', attendance || '100%');
    setText('dr-fullname', name || '—');
    // Reset to Overview tab
    document.querySelectorAll('.dr-tab').forEach(function(b){ b.classList.remove('active'); });
    const overviewTab = document.querySelector('.dr-tab[data-tab="overview"]');
    if (overviewTab) overviewTab.classList.add('active');
    document.querySelectorAll('.dr-tabview').forEach(function(v){ v.classList.remove('active'); });
    const overviewView = document.getElementById('dr-tabview-overview');
    if (overviewView) overviewView.classList.add('active');
    // Inline workspace: dock the record beside the roster list instead
    // of opening a page-blocking overlay. No backdrop, no blur, no body
    // scroll-lock — the header / KPI strip / sub-nav stay usable.
    var drEl = document.getElementById('driver-drawer');
    var drMount = document.getElementById('driver-record-mount');
    var rosterSub = document.getElementById('dr-sub-roster');
    // Only navigate to Drivers → Roster when the roster (and thus the
    // inline mount) isn't already on-screen — e.g. opening a driver from
    // global search on another page. offsetParent is null while the
    // sub-view is display:none. When the roster is visible (including the
    // onboarding-embedded copy) we dock in place without switching views.
    if (!(rosterSub && rosterSub.offsetParent !== null)) {
      var driversView = document.getElementById('view-drivers');
      if (driversView && !driversView.classList.contains('active') && typeof goto === 'function') {
        try { goto('drivers'); } catch (_e) {}
      }
      if (rosterSub && !rosterSub.classList.contains('active') && typeof drSub === 'function') {
        try { drSub('roster'); } catch (_e) {}
      }
    }
    if (drMount && drEl && drEl.parentNode !== drMount) drMount.appendChild(drEl);
    var drSplit = document.getElementById('rr-roster-split');
    if (drSplit) drSplit.classList.add('has-record');
    if (drEl) {
      drEl.classList.add('open');
      var drBody = drEl.querySelector('.detail-body');
      if (drBody) drBody.scrollTop = 0;
    }
    // Topbar reflects the driver in focus
    var tbTitle = document.getElementById('tb-title');
    var tbContext = document.getElementById('tb-context');
    if (tbTitle) {
      tbTitle.dataset.driverPrev = tbTitle.dataset.driverPrev || tbTitle.textContent;
      tbTitle.textContent = name || 'Driver';
    }
    if (tbContext) {
      tbContext.dataset.driverPrev = tbContext.dataset.driverPrev || tbContext.textContent;
      tbContext.textContent = (station || '') + (tenure ? ' · ' + tenure + ' tenure' : '') + (score ? ' · score ' + score : '');
    }
  }
  function closeDriverDetail(){
    document.getElementById('driver-drawer').classList.remove('open');
    var drSplit = document.getElementById('rr-roster-split');
    if (drSplit) drSplit.classList.remove('has-record');
    // Restore topbar
    var tbTitle = document.getElementById('tb-title');
    var tbContext = document.getElementById('tb-context');
    if (tbTitle && tbTitle.dataset.driverPrev) {
      tbTitle.textContent = tbTitle.dataset.driverPrev;
      delete tbTitle.dataset.driverPrev;
    }
    if (tbContext && tbContext.dataset.driverPrev) {
      tbContext.textContent = tbContext.dataset.driverPrev;
      delete tbContext.dataset.driverPrev;
    }
  }

  // ─── POPOVERS (notifications, account, filters) ───────────
  function togglePopover(id){
    const el = document.getElementById(id);
    const wasOpen = el.classList.contains('open');
    closePopovers();
    if (!wasOpen) el.classList.add('open');
  }
  function closePopovers(){
    document.querySelectorAll('.popover').forEach(function(p){ p.classList.remove('open'); });
  }
  document.addEventListener('click', function(e){
    // Close popovers when clicking outside
    if (!e.target.closest('.popover') && !e.target.closest('.icon-btn') && !e.target.closest('.account') && !e.target.closest('.filter-chip') && !e.target.closest('.popover-anchor')) {
      closePopovers();
    }
  });

  // ─── TOPBAR SEARCH ─────────────────────────────────────────
  const SEARCH_INDEX = [
    {name:'Marcus Davidson', meta:'Driver · KMO1 · score 62', tag:'driver', kind:'driver', score:62, station:'KMO1', tenure:'18 mo'},
    {name:'Tasha Reyes', meta:'Driver · KMO2 · score 68', tag:'driver', kind:'driver', score:68, station:'KMO2', tenure:'9 mo'},
    {name:'Kerwin Whitfield', meta:'Driver · KMO1 · score 71', tag:'driver', kind:'driver', score:71, station:'KMO1', tenure:'24 mo'},
    {name:'Jordan Beckett', meta:'Driver · KMO3 · score 73', tag:'driver', kind:'driver', score:73, station:'KMO3', tenure:'6 mo'},
    {name:'Devon Patterson', meta:'Driver · KMO3 · score 79', tag:'driver', kind:'driver', score:79, station:'KMO3', tenure:'11 mo'},
    {name:'Camille Foster', meta:'Driver · KMO1 · score 88', tag:'driver', kind:'driver', score:88, station:'KMO1', tenure:'22 mo'},
    {name:'Alicia Monroe', meta:'Applicant · screening · score 8', tag:'applicant', kind:'applicant', score:8, source:'Indeed', stage:'Screening'},
    {name:'Brianna Cole', meta:'Applicant · passed · score 9', tag:'applicant', kind:'applicant', score:9, source:'Referral', stage:'Passed'},
    {name:'Marcus Hill', meta:'Applicant · booked Fri · score 5', tag:'applicant', kind:'applicant', score:5, source:'Indeed', stage:'Booked'},
    {name:'Sasha Underwood', meta:'Applicant · new · score 3', tag:'applicant', kind:'applicant', score:3, source:'Walk-in', stage:'New'},
    {name:'Trevor Anders', meta:'Applicant · hired · score 8', tag:'applicant', kind:'applicant', score:8, source:'Referral', stage:'Hired'}
  ];
  function onTopbarSearch(q){
    const wrap = document.getElementById('search-results');
    if (!q || q.length < 1) { wrap.classList.remove('open'); return; }
    const matches = SEARCH_INDEX.filter(function(r){ return r.name.toLowerCase().indexOf(q.toLowerCase()) >= 0; }).slice(0,8);
    if (matches.length === 0) {
      wrap.innerHTML = '<div class="popover-empty">No matches for "' + q + '"</div>';
    } else {
      wrap.innerHTML = matches.map(function(r){
        const initials = r.name.split(/\s+/).map(function(p){return p[0];}).join('').slice(0,2).toUpperCase();
        return '<div class="search-result" data-kind="' + r.kind + '" data-name="' + r.name + '">'
          + '<div class="avatar-sm tier-b">' + initials + '</div>'
          + '<div><div class="search-result-name">' + r.name + '</div><div class="search-result-meta">' + r.meta + '</div></div>'
          + '<span class="search-result-tag">' + r.tag + '</span>'
          + '</div>';
      }).join('');
      wrap.querySelectorAll('.search-result').forEach(function(el, i){
        el.addEventListener('click', function(){
          const r = matches[i];
          if (r.kind === 'driver') openDriverDetail(r.name, r.station, r.tenure, r.score, '100%');
          else openApplicantDetail(r.name, r.source + ' · ' + r.stage, r.score, r.source, r.stage);
          closeSearch();
          document.getElementById('topbar-search').value = '';
        });
      });
    }
    wrap.classList.add('open');
  }
  function closeSearch(){ document.getElementById('search-results').classList.remove('open'); }
  document.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const s = document.getElementById('topbar-search');
      if (s) s.focus();
    }
  });

  // ─── SETTINGS NAV ──────────────────────────────────────────
  const SETTINGS_SECTIONS = {
    workspace: { title:'Workspace', sub:'Basic information about your DSP.' },
    team: { title:'Team', sub:'Manage team members and roles.' },
    'hiring-messages': { title:'Hiring messages', sub:'SMS + email templates applicants and drivers receive at every step.' },
    referrals: { title:'Hiring referrals', sub:'KPIs, leaderboard, auto-invite, milestone payouts.' },
    // sms section moved to Onboarding → Funnel ▸ Rules popover
    video: { title:'Video screening', sub:'Recorded video introductions from applicants.' },
    recognition: { title:'Recognition', sub:'Per-celebration auto-fire toggles and copy overrides.' },
    billing: { title:'Billing', sub:'Subscription, invoices, payment method.' }
  };
  function setSettingsSection(btn){
    const id = btn.getAttribute('data-set');
    document.querySelectorAll('.settings-nav-item').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.settings-section[data-set]').forEach(function(s){ s.classList.add('hidden'); });
    let target = document.querySelector('.settings-section[data-set="' + id + '"]');
    // Fallback: if the section we want isn't in the DOM (an old build,
    // a missing pane, anything), don't leave the page blank — show
    // the first available section so the operator always sees content.
    if (!target) {
      target = document.querySelector('.settings-section[data-set]');
      console.warn('Settings pane not found for', id, '— falling back to', target?.getAttribute('data-set'));
    }
    if (target) target.classList.remove('hidden');
  }
  // Belt-and-suspenders: expose globally so inline onclicks always
  // resolve, even if a later script body shadows the local binding.
  window.setSettingsSection = setSettingsSection;

  // ─── ALERT TABS FILTER ─────────────────────────────────────
  function filterAlertTab(btn){
    document.querySelectorAll('.alert-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    const text = btn.textContent.split(/\s+/)[0];
    toast('Filtered to: ' + text);
  }

  // ─── REPORT DETAIL VIEWS ───────────────────────────────────
  function openReport(reportId){
    const wrap = document.getElementById('reports-grid-wrap');
    if (wrap) wrap.classList.add('hidden');
    document.querySelectorAll('.report-detail-view').forEach(function(v){ v.classList.remove('active'); });
    const target = document.getElementById('report-detail-' + reportId);
    if (target) target.classList.add('active');
    window.scrollTo({top:0,behavior:'instant'});
  }
  function closeReportDetail(){
    document.querySelectorAll('.report-detail-view').forEach(function(v){ v.classList.remove('active'); });
    const wrap = document.getElementById('reports-grid-wrap');
    if (wrap) wrap.classList.remove('hidden');
    window.scrollTo({top:0,behavior:'instant'});
  }

  // ─── UNIVERSAL ACTION FALLBACK ─────────────────────────────
  // Catches any remaining buttons that don't have explicit handlers,
  // gives them a helpful toast so the user knows the click was registered.
  function wireFallbackActions(){
    document.querySelectorAll('.btn, .filter-chip, .row-action, .stage-week-arrow, .sched-week-arrow, .alert-tab').forEach(function(b){
      if (b.dataset.fbWired) return;
      // skip if already wired or has onclick / handler
      if (b.onclick || b.dataset.wired || b.dataset.wiredAction) return;
      b.dataset.fbWired = '1';
      b.addEventListener('click', function(e){
        const text = (b.textContent || '').trim();
        if (!text) return;
        // alert tabs
        if (b.classList.contains('alert-tab')) { filterAlertTab(b); return; }
        // filter chips show coming-soon style
        if (b.classList.contains('filter-chip')) { toast(text + ' filter — dropdown would open here'); return; }
        // row actions
        if (b.classList.contains('row-action')) { toast('Row menu — would show edit/delete/details'); return; }
        // generic
        toast(text + (text.endsWith('…') ? '' : ''));
      });
    });
    // applicant rows clickable
    document.querySelectorAll('#view-pipeline tbody tr').forEach(function(r){
      if (r.id === 'pipeline-empty-row' || r.dataset.detailWired) return;
      r.dataset.detailWired = '1';
      r.style.cursor = 'pointer';
      r.addEventListener('click', function(e){
        if (e.target.closest('.row-action')) return;
        const nameEl = r.querySelector('.cell-name');
        const subEl = r.querySelector('.cell-name-sub');
        const scoreEl = r.querySelector('.cell-score');
        const sourceEl = r.querySelector('.cell-source');
        const stageEl = r.querySelector('.stage-pill');
        if (!nameEl) return;
        openApplicantDetail(
          nameEl.textContent.trim(),
          (subEl ? subEl.textContent.trim() : ''),
          scoreEl ? scoreEl.textContent.trim() : '',
          sourceEl ? sourceEl.textContent.trim() : '',
          stageEl ? stageEl.textContent.replace(/^\W+/, '').trim() : ''
        );
      });
    });
    // driver rows clickable
    document.querySelectorAll('#dr-sub-roster tbody tr').forEach(function(r){
      if (r.dataset.detailWired) return;
      r.dataset.detailWired = '1';
      r.style.cursor = 'pointer';
      r.addEventListener('click', function(e){
        if (e.target.closest('.coach-row-btn') || e.target.closest('.row-action')) return;
        const nameEl = r.querySelector('.cell-name');
        const subEl = r.querySelector('.cell-name-sub');
        const station = r.children[1] ? r.children[1].textContent.trim() : '';
        const tenure = r.children[2] ? r.children[2].textContent.trim() : '';
        const score = r.querySelector('.score-bar') ? r.querySelector('.score-bar').nextElementSibling.textContent.trim() : '';
        const att = r.querySelector('.att-pill strong') ? r.querySelector('.att-pill strong').textContent.trim() : '100%';
        if (!nameEl) return;
        openDriverDetail(nameEl.textContent.trim(), station, tenure, score, att);
      });
    });
    // report card clicks
    document.querySelectorAll('.report-card').forEach(function(card){
      if (card.dataset.detailWired) return;
      card.dataset.detailWired = '1';
      card.addEventListener('click', function(){
        const reportId = card.getAttribute('data-report');
        if (reportId) openReport(reportId);
        else {
          const t = card.querySelector('.report-title');
          toast('Opening: ' + (t ? t.textContent : 'Report'));
        }
      });
    });
    // Vehicle rows in Fleet > Vehicles
    document.querySelectorAll('#fleet-tab-vehicles tbody tr').forEach(function(r){
      if (r.dataset.detailWired) return;
      r.dataset.detailWired = '1';
      r.style.cursor = 'pointer';
      r.addEventListener('click', function(e){
        if (e.target.closest('.row-action')) return;
        const cells = r.children;
        const nameEl = r.querySelector('.cell-name');
        const subEl = r.querySelector('.cell-name-sub');
        const model = cells[1] ? cells[1].textContent.trim() : '';
        const miles = cells[2] ? cells[2].textContent.replace(/\s*mi.*/,'').trim() : '';
        const statusEl = r.querySelector('.veh-status');
        const status = statusEl ? statusEl.textContent.trim() : '';
        const driverCell = cells[4] ? cells[4].textContent.trim() : '';
        if (nameEl) {
          const meta = (subEl ? subEl.textContent + ' · ' : '') + model;
          openVehicleDetail(nameEl.textContent.trim(), meta, miles, status, driverCell);
        }
      });
    });
    // Schedule > By driver "Edit" buttons
    document.querySelectorAll('#sched-sub-drivers .actions-cell .btn').forEach(function(b){
      if (b.dataset.editWired) return;
      b.dataset.editWired = '1';
      b.addEventListener('click', function(e){
        e.stopPropagation();
        const row = b.closest('tr');
        if (!row) return;
        const nameEl = row.querySelector('.cell-name');
        if (nameEl) openScheduleEdit(nameEl.textContent.trim());
      });
    });
    // Checklist cards in Checklists > My checklists
    document.querySelectorAll('#checklist-tab-my .cl-card').forEach(function(card){
      if (card.dataset.detailWired) return;
      card.dataset.detailWired = '1';
      card.onclick = null;
      card.addEventListener('click', function(){
        const name = card.querySelector('.cl-card-name');
        const meta = card.querySelector('.cl-card-meta');
        const icon = card.querySelector('.cl-card-icon');
        let iconClass = 'opening';
        if (icon) {
          ['opening','closing','vehicle','onboard','compliance','shift'].forEach(function(c){
            if (icon.classList.contains(c)) iconClass = c;
          });
        }
        openChecklistDetail(name ? name.textContent : 'Checklist', meta ? meta.textContent : '', iconClass);
      });
    });
    // Form cards in Forms > My forms
    document.querySelectorAll('#forms-tab-my .form-card').forEach(function(card){
      if (card.dataset.detailWired) return;
      card.dataset.detailWired = '1';
      card.onclick = null;
      card.addEventListener('click', function(){
        const name = card.querySelector('.form-card-title');
        const meta = card.querySelector('.form-card-desc');
        openFormEdit(name ? name.textContent : 'Form', meta ? meta.textContent : '');
      });
    });
    // Submission rows
    document.querySelectorAll('#forms-tab-subm .subm-row').forEach(function(row){
      if (row.dataset.detailWired) return;
      // skip header row
      if (row.style.cursor === 'default') return;
      row.dataset.detailWired = '1';
      row.onclick = null;
      row.addEventListener('click', function(){
        const name = row.querySelector('.subm-form-name');
        const status = row.querySelector('.subm-status');
        let s = 'complete';
        if (status && (status.classList.contains('flagged') || status.textContent.toLowerCase().includes('action') || status.textContent.toLowerCase().includes('open'))) s = 'flagged';
        if (name) {
          const driver = name.textContent.split('·')[1] || 'Driver';
          openSubmission(driver.trim(), s);
        }
      });
    });
    // Asset category cards
    document.querySelectorAll('#fleet-tab-assets .asset-cat').forEach(function(card){
      if (card.dataset.detailWired) return;
      card.dataset.detailWired = '1';
      card.onclick = null;
      card.addEventListener('click', function(){
        const name = card.querySelector('.asset-cat-name');
        const stats = card.querySelector('.asset-cat-stats');
        openAssetCategory(name ? name.textContent : 'Assets', stats ? stats.textContent : '');
      });
    });
    // Maintenance "Schedule" / "View work order" buttons
    document.querySelectorAll('#fleet-tab-maint .btn').forEach(function(b){
      if (b.dataset.workWired) return;
      const t = b.textContent.trim();
      if (t === 'Schedule' || t === 'View work order') {
        b.dataset.workWired = '1';
        b.addEventListener('click', function(){ openModal('modal-work-order'); });
      }
    });
    // Documents in Fleet > Documents
    document.querySelectorAll('#fleet-tab-docs .doc-card').forEach(function(card){
      if (card.dataset.detailWired) return;
      card.dataset.detailWired = '1';
      card.addEventListener('click', function(){
        const name = card.querySelector('.doc-card-name');
        openDocPreview(name ? name.textContent : 'Document');
      });
    });
    // OKAMI strategy pills — cycle on click
    document.querySelectorAll('#view-okami .strategy-pill').forEach(function(pill){
      if (pill.dataset.cycleWired) return;
      pill.dataset.cycleWired = '1';
      pill.addEventListener('click', function(e){
        e.stopPropagation();
        cycleStrategy(pill);
      });
    });
    // Quick reply chips in Messages
    document.querySelectorAll('.msg-quick-reply').forEach(function(chip){
      if (chip.dataset.qrWired) return;
      chip.dataset.qrWired = '1';
      chip.addEventListener('click', function(){
        const text = chip.textContent.replace(/^[^a-zA-Z]+/,'').trim();
        if (text === '+ More') { toast('More quick replies — would expand library'); return; }
        fillQuickReply(text);
      });
    });
  }
  setTimeout(wireFallbackActions, 200);
  // Re-wire after any view switch
  const _origGoto = goto;
  goto = function(v){ _origGoto(v); setTimeout(wireFallbackActions, 50); };
  const _origSchedSub2 = schedSub;
  schedSub = function(s){ _origSchedSub2(s); setTimeout(wireFallbackActions, 50); };
  const _origDrSub = drSub;
  drSub = function(s){ _origDrSub(s); setTimeout(wireFallbackActions, 50); };

  // ─── DRIVER-MANAGED AVAILABILITY MASTER TOGGLE ─────────────
  function toggleDriverManaged(input){
    const body = document.getElementById('rules-availability-body');
    const sub = document.getElementById('rules-availability-sub');
    if (input.checked) {
      body.style.opacity = '1';
      body.style.pointerEvents = 'auto';
      sub.textContent = 'Driver-managed mode is ON. Rules below apply to what drivers can declare in their app.';
      toast('Driver-managed availability ON');
    } else {
      body.style.opacity = '.4';
      body.style.pointerEvents = 'none';
      sub.textContent = 'Driver-managed mode is OFF. You set each driver\'s availability manually from the Availability tab — drivers cannot edit it themselves. Rules below are inactive.';
      toast('Driver-managed availability OFF · you set per-driver from the Availability tab', 'warn');
    }
  }

  // ─── PIPELINE STAGE FILTER ─────────────────────────────────
  function filterPipelineStage(btn){
    const stage = btn.getAttribute('data-stage');
    document.querySelectorAll('#pipeline-stage-tabs .stage-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    // Card-based filter (replaces the prior table)
    const cards = document.querySelectorAll('#view-pipeline .pa-card');
    let visible = 0;
    cards.forEach(function(c){
      if (stage === 'all') { c.style.display = ''; visible++; return; }
      if (c.getAttribute('data-stage') === stage) { c.style.display = ''; visible++; }
      else { c.style.display = 'none'; }
    });
    const empty = document.getElementById('pipeline-empty-row');
    if (empty) empty.style.display = (visible === 0 ? '' : 'none');
  }

  // ─── PIPELINE APPLICANT EXPAND/COLLAPSE ───────────────────────
  function paToggle(btn){
    var card = btn.closest('.pa-card');
    if (!card) return;
    var wasOpen = card.classList.contains('expanded');
    // Collapse any other open cards (one-at-a-time keeps the page calm)
    document.querySelectorAll('#view-pipeline .pa-card.expanded').forEach(function(c){
      if (c !== card) c.classList.remove('expanded');
    });
    card.classList.toggle('expanded', !wasOpen);
    if (!wasOpen) {
      // Smooth scroll the card into view if expanding pushes it off-screen
      setTimeout(function(){ card.scrollIntoView({behavior:'smooth', block:'nearest'}); }, 50);
    }
  }

  // ─── PIPELINE APPLICANT DISPOSITION ACTIONS ───────────────────
  // Mockup: each action shows a toast and visually progresses the card stage.
  function paAction(btn, action, name){
    var card = btn.closest('.pa-card');
    var msgs = {
      send_link: 'Booking link sent · ' + name,
      resend_link: 'Booking link resent · ' + name,
      resend_screening: 'Screening form resent · ' + name,
      decline: name + ' declined · removed from pipeline',
      call: 'Calling ' + name + '…'
    };
    toast(msgs[action] || action, action === 'decline' ? 'warn' : 'success');
    if (action === 'send_link' && card) {
      // applied → screened → booking_pending visual progression
      card.setAttribute('data-stage', 'booking_pending');
      var pill = card.querySelector('.pa-stage-pill');
      if (pill) { pill.className = 'pa-stage-pill booking_pending'; pill.textContent = 'Booking pending'; }
      card.classList.remove('expanded');
    } else if (action === 'decline' && card) {
      // Rejected applicants leave the list entirely
      card.style.transition = 'opacity .25s, transform .25s';
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      setTimeout(function(){ card.remove(); }, 260);
    }
  }

  // ─── HIRING PIPELINE KPI RECOMPUTE ────────────────────────────
  // Show rate = (booked - noShow) / booked
  // Hire rate = hired / (hired + noHire)   ← of those who showed
  // Falls back to hardcoded values if interview day hasn't run.
  function recomputePipelineKPIs(){
    var booked = parseInt((document.getElementById('iv-booked')||{}).textContent, 10) || 0;
    var noshow = parseInt((document.getElementById('iv-noshow')||{}).textContent, 10) || 0;
    var hired  = parseInt((document.getElementById('iv-hired')||{}).textContent, 10) || 0;
    var nohire = parseInt((document.getElementById('iv-nohire')||{}).textContent, 10) || 0;
    var showRate, hireRate;
    if (booked > 0 && (hired + nohire + noshow) > 0) {
      showRate = Math.round(((booked - noshow) / booked) * 100);
      var showed = hired + nohire;
      hireRate = showed > 0 ? Math.round((hired / showed) * 100) : 0;
    } else {
      // Cycle baseline (no actions logged yet today)
      showRate = 72; hireRate = 31;
    }
    var srEl = document.getElementById('hp-show-rate'); if (srEl) srEl.textContent = showRate;
    var hrEl = document.getElementById('hp-hire-rate'); if (hrEl) hrEl.textContent = hireRate;
    // Coverage progress bar fill: actual / plan
    var actual = parseInt((document.getElementById('hp-actual')||{}).textContent, 10) || 78;
    var plan = parseInt((document.getElementById('hp-plan')||{}).textContent, 10) || 82;
    var fill = document.getElementById('hp-stats-fill');
    if (fill) fill.style.width = Math.min(100, Math.round(actual / plan * 100)) + '%';
  }
  document.addEventListener('DOMContentLoaded', recomputePipelineKPIs);

  // ─── DRIVERS STAGE FILTER (Roster sub-view) ────────────────
  function filterDriversStage(btn){
    const stage = btn.getAttribute('data-stage');
    document.querySelectorAll('#dr-sub-roster .stage-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    // For now just toast since the roster doesn't have stage classes per row yet
    toast('Filtered to: ' + btn.textContent.split(/\s+/)[0]);
  }

  // ─── TOASTS ────────────────────────────────────────────────
  function toast(msg, kind){
    kind = kind || 'success';
    // Routine success / info confirmations are suppressed per operator
    // request — they were too noisy (e.g. "Shift added" on every action).
    // Warnings and errors still show so failures are never silent.
    if (kind === 'success' || kind === 'info') return;
    const stack = document.getElementById('toast-stack');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    const icon = kind === 'success'
      ? '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : kind === 'warn'
      ? '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
      : '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    el.innerHTML = icon + '<span>' + msg + '</span>';
    stack.appendChild(el);
    setTimeout(function(){ el.classList.add('fade'); setTimeout(function(){ el.remove(); }, 250); }, 2800);
  }

  // ─── GENERIC MODAL OPEN/CLOSE ──────────────────────────────
  function openModal(id){
    document.getElementById(id).classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id){
    document.getElementById(id).classList.remove('open');
    // Only release the scroll lock once nothing is left open — a few
    // surfaces stack a confirm modal over a primary one.
    if (!document.querySelector('.modal-backdrop.open')){
      document.body.style.overflow = '';
    }
  }
  // Global Escape handler — close the topmost open .modal-backdrop.
  // Covers every modal that uses openModal/closeModal (~30 dialogs).
  // Bespoke modals that manage their own keydown (rr-modal-backdrop,
  // DVIC compare, etc.) keep their own handler; this one only fires
  // when there's an .open backdrop in the DOM.
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    // Inline driver record closes on Escape too (it has no backdrop to click).
    var drSplit = document.getElementById('rr-roster-split');
    if (drSplit && drSplit.classList.contains('has-record')) { closeDriverDetail(); return; }
    var open = document.querySelectorAll('.modal-backdrop.open');
    if (!open.length) return;
    var top = open[open.length - 1];
    if (top && top.id) closeModal(top.id);
  });

  // ─── ADD APPLICANT ─────────────────────────────────────────
  function openAddApplicantModal(){
    document.getElementById('aa-fn').value = '';
    document.getElementById('aa-ln').value = '';
    document.getElementById('aa-phone').value = '';
    document.getElementById('aa-email').value = '';
    openModal('modal-add-applicant');
    setTimeout(function(){ document.getElementById('aa-fn').focus(); }, 50);
  }

  // ─── PDF UPLOAD (Onboarding ribbon) ────────────────────────
  // Stub for now — clicks the hidden file input + surfaces a toast
  // with the picked filenames. Backend wiring (OCR / parse / route)
  // lands in a follow-up; this gets the UI affordance in place.
  function openPdfUploadPicker(){
    var input = document.getElementById('rr-ob-pdf-upload-input');
    if (!input) return;
    input.value = '';
    input.onchange = function(){
      var files = Array.from(input.files || []);
      if (files.length === 0) return;
      var msg = files.length === 1
        ? 'Picked ' + files[0].name + ' — upload wiring coming soon.'
        : 'Picked ' + files.length + ' PDFs — upload wiring coming soon.';
      if (typeof toast === 'function') toast(msg);
      else console.info('[PDF Upload]', files.map(function(f){ return f.name; }));
    };
    input.click();
  }
  window.openPdfUploadPicker = openPdfUploadPicker;
  // ─── MARK ALL NOTIFICATIONS READ ──────────────────────────
  function markAllNotifsRead(){
    var pop = document.getElementById('popover-notif');
    if (!pop) return;
    var list = pop.querySelector('div:nth-child(2)');
    if (list) {
      list.innerHTML = '<div style="padding:var(--s-8) 16px;text-align:center;color:var(--text-subtle);font-size:var(--fs-sm)">✓ You\'re all caught up</div>';
    }
    // Also hide the bell dot indicator
    var dot = document.querySelector('.icon-btn[aria-label="Notifications"] .dot');
    if (dot) dot.style.display = 'none';
    toast('Notifications cleared');
  }

  function _bumpPipelineCounts(n){
    n = n || 1;
    var nb = document.querySelector('.nav-item[data-view="pipeline"] .nav-badge');
    if (nb) {
      var cur = parseInt(nb.textContent, 10) || 0;
      nb.textContent = cur + n;
      nb.style.display = '';
    }
    var all = document.querySelector('.stage-tab[data-stage="all"] .stage-tab-count');
    if (all) { var a = parseInt(all.textContent, 10) || 0; all.textContent = a + n; }
    var newSt = document.querySelector('.stage-tab[data-stage="new"] .stage-tab-count');
    if (newSt) { var s = parseInt(newSt.textContent, 10) || 0; newSt.textContent = s + n; }
    if (typeof recomputeStaffingRisk === 'function') recomputeStaffingRisk();
  }
  function submitAddApplicant(){
    const fn = document.getElementById('aa-fn').value.trim();
    const ln = document.getElementById('aa-ln').value.trim();
    const phone = document.getElementById('aa-phone').value.trim();
    const email = document.getElementById('aa-email').value.trim();
    if (!fn && !ln) { toast('Add a name first', 'warn'); return; }
    if (!phone && !email) { toast('Phone or email required', 'warn'); return; }
    closeModal('modal-add-applicant');
    _bumpPipelineCounts(1);
    toast((fn || ln) + ' added to pipeline · screening SMS sent');
  }

  // ─── BULK INGEST ───────────────────────────────────────────
  function openBulkIngest(){
    document.getElementById('bi-paste').value = '';
    document.getElementById('bi-preview').style.display = 'none';
    const btn = document.getElementById('bi-import-btn');
    btn.disabled = true;
    btn.textContent = 'Paste rows above';
    openModal('modal-bulk-ingest');
    setTimeout(function(){ document.getElementById('bi-paste').focus(); }, 50);
  }
  document.addEventListener('input', function(e){
    if (e.target && e.target.id === 'bi-paste') {
      const rows = e.target.value.split(/\r?\n/).filter(function(l){ return l.trim().length > 0; });
      const data = rows.length > 1 ? rows.length - 1 : 0; // assume header
      const preview = document.getElementById('bi-preview');
      const btn = document.getElementById('bi-import-btn');
      if (data > 0) {
        preview.style.display = 'block';
        preview.innerHTML = '<strong>' + data + '</strong> rows ready to import · 0 duplicates detected';
        btn.disabled = false;
        btn.textContent = 'Import ' + data + ' applicant' + (data === 1 ? '' : 's');
      } else {
        preview.style.display = 'none';
        btn.disabled = true;
        btn.textContent = 'Paste rows above';
      }
    }
  });
  function submitBulkIngest(){
    const text = document.getElementById('bi-paste').value;
    const rows = text.split(/\r?\n/).filter(function(l){ return l.trim().length > 0; });
    const count = rows.length > 1 ? rows.length - 1 : 0;
    if (count === 0) { toast('Paste rows first', 'warn'); return; }
    closeModal('modal-bulk-ingest');
    _bumpPipelineCounts(count);
    toast(count + ' applicants imported · screening SMS sent to all');
  }

  // ─── ADD DRIVER (single) ──────────────────────────────────
  function submitAddDriver(){
    var fn = document.getElementById('ad-fn').value.trim();
    var ln = document.getElementById('ad-ln').value.trim();
    var phone = document.getElementById('ad-phone').value.trim();
    var email = document.getElementById('ad-email').value.trim();
    var station = document.getElementById('ad-station').value;
    var status = document.getElementById('ad-status').value;
    if (!fn && !ln) { toast('Add a name first', 'warn'); return; }
    if (!phone && !email) { toast('Phone or email required', 'warn'); return; }
    closeModal('modal-add-driver');
    var fullName = (fn + ' ' + ln).trim();
    // Append a row to the drivers roster
    var tbody = document.querySelector('#dr-sub-roster tbody');
    if (tbody) {
      var initials = (fn[0] || '?') + (ln[0] || '?');
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><div class="cell-driver"><div class="avatar-sm tier-b">' + initials.toUpperCase() + '</div><div><div class="cell-name">' + fullName + '</div><div class="cell-name-sub">' + (phone || email) + '</div></div></div></td>' +
        '<td>' + station + '</td>' +
        '<td>0 days</td>' +
        '<td><span class="score-bar"><span class="score-bar-fill" style="width:80%"></span></span><span style="font-weight:600">—</span></td>' +
        '<td><span class="att-pill"><span class="att-pill-dot"></span><strong>0 callouts</strong> · 100%</span></td>' +
        '<td><span class="tag" style="background:var(--accent-soft);color:var(--accent-text)">' + (status === 'onboarding' ? 'Onboarding' : status === 'inactive' ? 'Inactive' : 'New') + '</span></td>' +
        '<td class="cell-time">Just added</td>' +
        '<td><button class="coach-row-btn" onclick="openCoachDrawer(\'' + fullName + '\',\'behavior\',\'New driver — welcome check-in\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Coach</button></td>';
      tbody.insertBefore(tr, tbody.firstChild);
      tr.style.background = 'rgba(16,185,129,.08)';
      setTimeout(function(){ tr.style.transition = 'background .8s'; tr.style.background = ''; }, 50);
    }
    // Reset form
    ['ad-fn','ad-ln','ad-phone','ad-email'].forEach(function(id){ var el = document.getElementById(id); if (el) el.value = ''; });
    if (typeof recomputeStaffingRisk === 'function') recomputeStaffingRisk();
    toast(fullName + ' added to roster · welcome SMS sent to ' + (phone || email));
  }

  // Bulk driver ingest is now wired in dashboard/live.js — see
  // bulkDriverIngest_* helpers + the real submitBulkDriverIngest()
  // exposed on window.

  // ─── APPROVE / DENY / SWAP / PUBLISH ───────────────────────
  // Helper: decrement a numeric badge or hide it at 0; supports nested span counts
  function _decrementBadge(sel){
    var el = document.querySelector(sel);
    if (!el) return 0;
    var match = el.textContent.match(/\d+/);
    if (!match) return 0;
    var n = Math.max(0, parseInt(match[0], 10) - 1);
    el.textContent = el.textContent.replace(/\d+/, n);
    if (n === 0) el.style.display = 'none';
    return n;
  }
  // Helper: append empty-state inside a container if no children of selector remain
  function _maybeEmpty(containerSel, childSel, html){
    var c = document.querySelector(containerSel);
    if (!c) return;
    if (!c.querySelector(childSel)) {
      var existing = c.querySelector('.empty-state');
      if (!existing) {
        var div = document.createElement('div');
        div.className = 'empty-state';
        div.style.cssText = 'padding:var(--s-8);text-align:center;color:var(--text-subtle);font-size:var(--fs-md)';
        div.innerHTML = html || 'All caught up · nothing pending';
        c.appendChild(div);
      }
    }
  }

  function approveTimeOff(btn, name){
    const card = btn.closest('.approval-card');
    if (card) {
      card.style.transition = 'opacity .25s, transform .25s';
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      setTimeout(function(){
        card.remove();
        // After removal: decrement badges + render empty state if list is empty
        _decrementBadge('#view-schedule .subnav-item[data-sub="timeoff"] span');
        _decrementBadge('.nav-item[data-view="schedule"] .nav-badge');
        _maybeEmpty('#sched-sub-timeoff', '.approval-card', '✓ All caught up · no pending time-off requests');
      }, 250);
    }
    toast('Time off approved for ' + (name || 'driver') + ' · SMS sent');
  }
  function denyRequest(btn, name){
    const card = btn.closest('.approval-card');
    if (card) {
      card.style.transition = 'opacity .25s';
      card.style.opacity = '0';
      setTimeout(function(){
        card.remove();
        _decrementBadge('#view-schedule .subnav-item[data-sub="timeoff"] span');
        _decrementBadge('.nav-item[data-view="schedule"] .nav-badge');
        _maybeEmpty('#sched-sub-timeoff', '.approval-card', '✓ All caught up · no pending time-off requests');
      }, 250);
    }
    toast('Request denied · ' + (name || 'driver') + ' notified', 'warn');
  }
  function approveSwap(btn, names){
    const card = btn.closest('.approval-card');
    if (card) {
      card.style.transition = 'opacity .25s, transform .25s';
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      setTimeout(function(){
        card.remove();
        // Visually update calendar cells for the named drivers
        if (names) {
          var firstName = names.split(/[↔&]/)[0].trim().split(' ')[0];
          document.querySelectorAll('.cal-row-label-name').forEach(function(n){
            if (n.textContent.indexOf(firstName) !== -1) {
              var row = n.closest('.cal-grid');
              if (row) {
                var cells = row.querySelectorAll('.cal-cell .shift-chip');
                if (cells.length > 4 && cells[4]) cells[4].style.outline = '2px solid var(--accent)';
              }
            }
          });
        }
        _decrementBadge('#view-schedule .subnav-item[data-sub="swaps"] span');
        _decrementBadge('.nav-item[data-view="schedule"] .nav-badge');
        // Remove matching swap notification
        document.querySelectorAll('#popover-notif .notif-item').forEach(function(item){
          var t = item.querySelector('.notif-title');
          if (t && t.textContent.toLowerCase().indexOf('swap') !== -1) {
            item.style.transition = 'opacity .2s';
            item.style.opacity = '0';
            setTimeout(function(){ item.remove(); }, 200);
          }
        });
        _maybeEmpty('#sched-sub-swaps', '.approval-card', '✓ All caught up · no pending swap requests');
      }, 250);
    }
    toast('Swap approved · ' + (names || 'both drivers') + ' notified');
  }
  // ─── HIRE APPLICANT ───────────────────────────────────────
  // ─── INTERVIEW DAY — Hire / No Hire / No Show ─────────────
  function ivAction(btn, action, candidateName, extra){
    var card = btn.closest('.iv-card');
    if (!card || card.classList.contains('processed')) return;
    card.classList.add('processed');
    // Disable all buttons in this card
    card.querySelectorAll('.iv-action-btn').forEach(function(b){ b.disabled = true; });
    // Visually mark the chosen action
    btn.style.outline = '2px solid currentColor';
    btn.style.outlineOffset = '2px';
    // Stamp a result tag onto the card
    var stamp = document.createElement('div');
    stamp.style.cssText = 'font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:6px;color:' + (action==='Hired'?'var(--green)':action==='No Show'?'var(--amber)':'var(--text-muted)');
    stamp.textContent = '✓ ' + action + ' · SMS sent';
    btn.parentNode.parentNode.querySelector('.iv-card-tags').appendChild(stamp);
    // Update day stats
    var hiredEl = document.getElementById('iv-hired');
    var nohireEl = document.getElementById('iv-nohire');
    var noshowEl = document.getElementById('iv-noshow');
    var remainEl = document.getElementById('iv-remaining');
    var bookedEl = document.getElementById('iv-booked');
    var bumped;
    if (action === 'Hired') bumped = hiredEl;
    else if (action === 'No Hire') bumped = nohireEl;
    else if (action === 'No Show') bumped = noshowEl;
    if (bumped) bumped.textContent = (parseInt(bumped.textContent,10) || 0) + 1;
    var rem = (parseInt(remainEl.textContent, 10) || 0) - 1;
    remainEl.textContent = rem;
    var booked = parseInt(bookedEl.textContent, 10) || 7;
    var processed = booked - rem;
    var fill = document.getElementById('iv-progress-fill');
    if (fill) fill.style.width = Math.round(processed/booked*100) + '%';
    // Side effects per action
    if (action === 'Hired') {
      // Auto-SMS welcome + create driver record stub + decrement pipeline + bump Hired stage
      _decrementBadge('.nav-item[data-view="pipeline"] .nav-badge');
      var allCount = document.querySelector('.stage-tab[data-stage="all"] .stage-tab-count');
      if (allCount) { var n = parseInt(allCount.textContent, 10); if (!isNaN(n)) allCount.textContent = (n - 1); }
      var hiredCount = document.querySelector('.stage-tab[data-stage="hired"] .stage-tab-count');
      if (hiredCount) { var h = parseInt(hiredCount.textContent, 10); if (!isNaN(h)) hiredCount.textContent = (h + 1); }
      // Push notification
      var notifList = document.querySelector('#popover-notif > div:nth-child(2)');
      if (notifList) {
        var notif = document.createElement('div');
        notif.className = 'notif-item';
        notif.onclick = function(){ goto('drivers'); closePopovers(); };
        var refLine = (extra && extra.indexOf('referred:') === 0)
          ? ' · $250 referral payout queued for ' + extra.replace('referred:','')
          : '';
        notif.innerHTML = '<div class="notif-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
          '<div><div class="notif-title">' + candidateName + ' hired</div><div class="notif-msg">Welcome SMS sent · driver record created' + refLine + '</div><div class="notif-time">Just now</div></div>';
        notifList.insertBefore(notif, notifList.firstChild);
      }
      var refToast = (extra && extra.indexOf('referred:') === 0)
        ? ' · $250 referral payout queued'
        : '';
      toast(candidateName + ' hired · welcome SMS sent · driver record created' + refToast);
      if (typeof recomputeStaffingRisk === 'function') recomputeStaffingRisk();
    } else if (action === 'No Hire') {
      _decrementBadge('.nav-item[data-view="pipeline"] .nav-badge');
      var allCount2 = document.querySelector('.stage-tab[data-stage="all"] .stage-tab-count');
      if (allCount2) { var n2 = parseInt(allCount2.textContent, 10); if (!isNaN(n2)) allCount2.textContent = (n2 - 1); }
      toast(candidateName + ' marked No Hire · polite rejection SMS sent');
      if (typeof recomputeStaffingRisk === 'function') recomputeStaffingRisk();
    } else if (action === 'No Show') {
      toast(candidateName + ' marked No Show · "missed your interview, want to rebook?" SMS sent');
    }
    // Refresh hiring pipeline Show/Hire rate KPIs from updated counts
    if (typeof recomputePipelineKPIs === 'function') recomputePipelineKPIs();
    // Day done check
    if (rem === 0) {
      setTimeout(function(){
        document.getElementById('iv-candidates').style.display = 'none';
        document.getElementById('iv-done').style.display = 'block';
        document.getElementById('iv-done-sub').textContent =
          hiredEl.textContent + ' hired · ' + nohireEl.textContent + ' no hire · ' + noshowEl.textContent + ' no show';
      }, 400);
    }
  }

  function markApplicantHired(){
    var nameEl = document.getElementById('ap-name');
    var name = nameEl ? nameEl.textContent.trim() : 'Applicant';
    closeApplicantDetail();
    // 1. Decrement Pipeline sidebar nav badge
    _decrementBadge('.nav-item[data-view="pipeline"] .nav-badge');
    // 2. Decrement "All" stage count, increment "Hired" stage count
    var allCount = document.querySelector('.stage-tab[data-stage="all"] .stage-tab-count');
    if (allCount) {
      var n = parseInt(allCount.textContent, 10);
      if (!isNaN(n)) allCount.textContent = (n - 1);
    }
    var hiredCount = document.querySelector('.stage-tab[data-stage="hired"] .stage-tab-count');
    if (hiredCount) {
      var h = parseInt(hiredCount.textContent, 10);
      if (!isNaN(h)) hiredCount.textContent = (h + 1);
    }
    // 3. Prepend a notification
    var notifList = document.querySelector('#popover-notif > div:nth-child(2)');
    if (notifList) {
      var notif = document.createElement('div');
      notif.className = 'notif-item';
      notif.onclick = function(){ goto('drivers'); closePopovers(); };
      notif.innerHTML = '<div class="notif-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
        '<div><div class="notif-title">' + name + ' hired</div><div class="notif-msg">Welcome SMS sent · onboarding starts next cycle</div><div class="notif-time">Just now</div></div>';
      notifList.insertBefore(notif, notifList.firstChild);
    }
    if (typeof recomputeStaffingRisk === 'function') recomputeStaffingRisk();
    toast(name + ' marked as hired · welcome email + SMS sent');
  }

  // ─── ACKNOWLEDGE ALL SAFETY ───────────────────────────────
  function acknowledgeAllSafety(){
    closeSafetyQueue();
    var clearLink = document.querySelector('.action-card[data-action="safety"] .clear-link');
    if (clearLink) clearLink.click();
    else toast('All 3 safety events marked acknowledged');
  }
  function markAllQualityReviewed(){
    closeQualityQueue();
    var clearLink = document.querySelector('.action-card[data-action="quality"] .clear-link');
    if (clearLink) clearLink.click();
    else toast('All 8 quality items marked reviewed');
  }

  // ─── SUBMIT DISPUTE ───────────────────────────────────────
  function submitDispute(){
    closeReconciliation();
    // 1. Decrement disputes pending count on Finances Inbox KPIs
    var pending = document.querySelector('#view-finances .kpi-card .kpi-value');
    if (pending) {
      var match = pending.textContent.match(/\d+/);
      if (match) {
        var n = Math.max(0, parseInt(match[0], 10) - 1);
        pending.textContent = pending.textContent.replace(/\d+/, n);
      }
    }
    // 2. Decrement Disputes subnav badge
    _decrementBadge('#view-finances .subnav-item[data-sub="disputes"] span');
    // 3. Decrement Finances sidebar badge text-number portion
    _decrementBadge('.nav-item[data-view="finances"] .nav-badge');
    // 4. Decrement dashboard disputes action card count
    var dc = document.querySelector('.action-card[data-action="disputes"] .action-count');
    if (dc && !dc.textContent.match(/\$/)) {
      var match = dc.textContent.match(/\d+/);
      if (match) {
        var n = Math.max(0, parseInt(match[0], 10) - 1);
        dc.textContent = dc.textContent.replace(/\d+/, n);
      }
    }
    toast('Dispute submitted to Amazon · evidence attached · tracking thread created');
  }

  function publishWeek(btn){
    const pill = document.querySelector('.sched-status-pill');
    if (pill) {
      pill.classList.remove('draft');
      pill.innerHTML = '<span class="status-dot"></span>Published · drivers notified';
    }
    if (btn) {
      btn.textContent = 'Published ✓';
      btn.disabled = true;
      setTimeout(function(){
        btn.textContent = 'Publish week';
        btn.disabled = false;
      }, 3000);
    }
    toast('Week published · 78 drivers notified by SMS');
  }
  function notifyBackup(btn){
    if (btn) { btn.textContent = 'Backup notified ✓'; btn.disabled = true; setTimeout(function(){ btn.textContent = 'Notify backup'; btn.disabled = false; }, 2500); }
    toast('Backup pool notified · 4 drivers');
  }
  function assignOpenShift(btn, name){
    const row = btn.closest('.open-shift');
    if (row) {
      row.style.transition = 'opacity .3s';
      row.style.opacity = '0';
      setTimeout(function(){ row.remove(); }, 300);
    }
    toast('Shift assigned to ' + (name || 'driver'));
  }
  function submitTimeOff(){
    closeModal('modal-add-timeoff');
    toast('Time off request submitted · pending approval');
  }
  function applyTemplate(name){
    toast('"' + name + '" template applied to selected drivers');
  }

  // Hook the existing buttons that previously did nothing
  document.addEventListener('DOMContentLoaded', wireMockupButtons);
  setTimeout(wireMockupButtons, 100); // fallback in case DOMContentLoaded already fired

  function wireMockupButtons(){
    // Add Applicant — every instance
    document.querySelectorAll('.btn.btn-primary').forEach(function(b){
      const text = b.textContent.trim();
      if (text === 'Add applicant' && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', openAddApplicantModal);
      }
      if (text === 'Bulk ingest' && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', openBulkIngest);
      }
    });
    document.querySelectorAll('.btn').forEach(function(b){
      const text = b.textContent.trim();
      if (text === 'Bulk ingest' && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', openBulkIngest);
      }
    });

    // Approve / Deny on time-off & swaps
    document.querySelectorAll('#sched-sub-timeoff .approval-card').forEach(function(card){
      const title = card.querySelector('.approval-title');
      const name = title ? title.textContent.split('·')[0].trim() : 'Driver';
      const btns = card.querySelectorAll('.approval-actions .btn');
      btns.forEach(function(b){
        if (b.dataset.wired) return;
        b.dataset.wired = '1';
        if (b.textContent.trim() === 'Approve') b.addEventListener('click', function(){ approveTimeOff(b, name); });
        if (b.textContent.trim() === 'Deny') b.addEventListener('click', function(){ denyRequest(b, name); });
      });
    });
    document.querySelectorAll('#sched-sub-swaps .approval-card').forEach(function(card){
      const title = card.querySelector('.approval-title');
      const name = title ? title.textContent.replace('·', '').trim() : 'swap';
      const btns = card.querySelectorAll('.approval-actions .btn');
      btns.forEach(function(b){
        if (b.dataset.wired) return;
        b.dataset.wired = '1';
        const t = b.textContent.trim();
        if (t === 'Approve swap' || t === 'Choose driver') b.addEventListener('click', function(){ approveSwap(b, name); });
        if (t === 'Deny' || t === 'Decline') b.addEventListener('click', function(){ denyRequest(b, name); });
      });
    });

    // Publish week
    document.querySelectorAll('.btn.btn-primary').forEach(function(b){
      if (b.textContent.trim() === 'Publish week' && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', function(){ publishWeek(b); });
      }
    });

    // Open shifts: notify / assign
    document.querySelectorAll('#sched-sub-open .open-shift').forEach(function(row){
      const route = row.querySelector('.open-shift-route');
      const routeName = route ? route.textContent : 'route';
      row.querySelectorAll('.btn').forEach(function(b){
        if (b.dataset.wired) return;
        b.dataset.wired = '1';
        const t = b.textContent.trim();
        if (t === 'Notify backup' || t === 'Send reminder') b.addEventListener('click', function(){ notifyBackup(b); });
        if (t.indexOf('Assign') === 0) b.addEventListener('click', function(){ assignOpenShift(b, t.replace('Assign','').trim()); });
      });
    });
    // "Notify backup pool" button at top of Open shifts
    document.querySelectorAll('#sched-sub-open .btn.btn-primary').forEach(function(b){
      if (b.textContent.trim().indexOf('Notify backup') >= 0 && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', function(){ notifyBackup(b); });
      }
    });

    // Add time off
    document.querySelectorAll('.btn.btn-primary').forEach(function(b){
      if (b.textContent.trim() === 'Add time off' && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', function(){ openModal('modal-add-timeoff'); });
      }
    });

    // Templates
    document.querySelectorAll('.template-card').forEach(function(card){
      if (card.dataset.wired) return;
      card.dataset.wired = '1';
      const name = card.querySelector('.template-card-name');
      const nameText = name ? name.textContent : 'Template';
      card.addEventListener('click', function(){ applyTemplate(nameText); });
    });

    // Settings save buttons (any "Save" action)
    document.querySelectorAll('.btn.btn-primary').forEach(function(b){
      const t = b.textContent.trim();
      if ((t === 'Save' || t === 'Save changes') && !b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', function(){ toast('Settings saved'); });
      }
    });

    // Coach drawer Save / Send buttons (override the close-only behavior with toast)
    var cdSaveBtn = document.getElementById('cd-save-btn');
    if (cdSaveBtn && !cdSaveBtn.dataset.wiredAction) {
      cdSaveBtn.dataset.wiredAction = '1';
      cdSaveBtn.addEventListener('click', function(){ toast('Saved to driver record'); });
    }
    var cdSendBtn = document.getElementById('cd-send-btn');
    if (cdSendBtn && !cdSendBtn.dataset.wiredAction) {
      cdSendBtn.dataset.wiredAction = '1';
      cdSendBtn.addEventListener('click', function(){
        var seg = document.querySelector('.cd-segment.active');
        var segVal = seg ? seg.getAttribute('data-seg') : 'sms';
        var segLabel = ({sms:'Coaching SMS sent', inperson:'1:1 conversation logged', pull:'Driver pulled from route', suspend:'Driver suspended'})[segVal] || 'Coaching action logged';
        var driverNameEl = document.getElementById('cd-driver-name');
        var driverName = driverNameEl ? driverNameEl.textContent.trim() : '';
        // 1. Append to driver record coaching timeline if drawer is open for same driver
        var drNameEl = document.getElementById('dr-name');
        if (drNameEl && drNameEl.textContent.trim() === driverName) {
          var tl = document.querySelector('#dr-tabview-perf .detail-timeline');
          if (tl) {
            var item = document.createElement('div');
            item.className = 'detail-timeline-item';
            item.innerHTML = '<div class="detail-timeline-dot green"></div>' +
              '<div class="detail-timeline-text"><strong>' + segLabel + '</strong><small>Just logged</small></div>' +
              '<div class="detail-timeline-time">now</div>';
            tl.insertBefore(item, tl.firstChild);
          }
        }
        // 2. Decrement dashboard "Coaching follow-ups" count
        var cc = document.querySelector('.action-card[data-action="coaching"] .action-count');
        if (cc) {
          var match = cc.textContent.match(/\d+/);
          if (match) {
            var n = Math.max(0, parseInt(match[0], 10) - 1);
            cc.textContent = n + ' due';
            if (n === 0) cc.classList.add('zero');
          }
        }
        // 3. Toast + persist
        if (segVal === 'sms') toast('Coaching SMS sent · saved to driver record');
        else if (segVal === 'inperson') toast('1:1 logged to driver record');
        else if (segVal === 'pull') toast('Driver pulled from route · backup notified');
        else if (segVal === 'suspend') {
          // Real suspension: validate, write records, fire cascade
          if (window.cdReadSuspendForm && window.suspendDriver) {
            var opts = cdReadSuspendForm();
            if (!opts.detail || !opts.detail.trim()) {
              toast('Reason detail is required for the HR record');
              return;
            }
            suspendDriver(driverName, opts);
          } else {
            toast('Driver suspended · HR record created');
          }
        }
      });
    }

    // Stale "Open" buttons on dashboard
    document.querySelectorAll('.hs-stale-act, .row-action').forEach(function(b){
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('click', function(){ /* row-action menu would open */ });
    });
  }

  // Re-wire when sub-views switch (in case new buttons appear)
  const _origSchedSub = (typeof schedSub === 'function') ? schedSub : null;
  if (_origSchedSub) {
    schedSub = function(s){ _origSchedSub(s); setTimeout(wireMockupButtons, 50); };
  }

  // ─── ATTENDANCE CHECK-IN ───────────────────────────────────
  function ciMark(btn){
    var row = btn.closest('.checkin-row');
    var status = btn.getAttribute('data-s');
    var wasCallout = row.classList.contains('marked-callout') || row.classList.contains('marked-noshow');
    // Reset row
    row.classList.remove('marked-present','marked-late','marked-callout','marked-noshow','marked-vto');
    row.querySelectorAll('.status-btn').forEach(function(b){
      b.classList.remove('active','s-present','s-late','s-callout','s-noshow','s-vto');
    });
    // Apply
    btn.classList.add('active','s-' + status);
    row.classList.add('marked-' + status);
    ciUpdateCounts();
    // Log attendance event (skip 'present' — non-event)
    var nameEl = row.querySelector('.checkin-driver-name');
    if (nameEl && status !== 'present') {
      window.attLogFromCheckin && window.attLogFromCheckin(nameEl.textContent.trim(), status);
    } else if (nameEl && status === 'present') {
      window.attClearCheckinForToday && window.attClearCheckinForToday(nameEl.textContent.trim());
    }
    // If newly callout/noshow, increment Open shifts subnav badge
    var becameCallout = (status === 'callout' || status === 'noshow');
    if (becameCallout && !wasCallout) {
      var open = document.querySelector('#view-schedule .subnav-item[data-sub="open"] span');
      if (open) {
        var n = parseInt(open.textContent, 10) || 0;
        open.textContent = (n + 1);
        open.style.display = '';
      }
    } else if (!becameCallout && wasCallout) {
      _decrementBadge('#view-schedule .subnav-item[data-sub="open"] span');
    }
  }
  function ciUpdateCounts(){
    var counts = { present:0, late:0, callout:0, noshow:0, vto:0 };
    document.querySelectorAll('#view-checkin .checkin-row').forEach(function(r){
      var active = r.querySelector('.status-btn.active');
      if (active) {
        var s = active.getAttribute('data-s');
        if (counts[s] != null) counts[s]++;
      }
    });
    document.getElementById('ci-c-present').textContent = counts.present;
    document.getElementById('ci-c-late').textContent    = counts.late;
    document.getElementById('ci-c-callout').textContent = counts.callout;
    document.getElementById('ci-c-noshow').textContent  = counts.noshow;
    var vtoEl = document.getElementById('ci-c-vto'); if (vtoEl) vtoEl.textContent = counts.vto;
    var marked = counts.present + counts.late + counts.callout + counts.noshow + counts.vto;
    document.getElementById('ci-marked').textContent = marked;
    document.getElementById('ci-progress').style.width = (marked / 78 * 100) + '%';
  }

  // ═══════════════════════════════════════════════════════════════
  // ATTENDANCE — policy + event log + report
  // Data source: ciMark() in Today's check-in writes to RR_ATTENDANCE_LOG.
  // Report is computed live from policy + log.
  // ═══════════════════════════════════════════════════════════════
  function _isoFromNow(n){ var d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0,10); }
  var RR_DRIVERS = [];

  function _daysAgo(n){ var d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); }
  function _fmtDate(iso){
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US',{ month:'short', day:'numeric' });
  }
  function _fmtRel(iso){
    var d = new Date(iso + 'T12:00:00');
    var diff = Math.round((Date.now() - d.getTime()) / 86400000);
    if (diff <= 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 14) return diff + 'd ago';
    if (diff < 60) return Math.round(diff/7) + 'w ago';
    return Math.round(diff/30) + 'mo ago';
  }

  // Empty by default — live data fills these.  Static seed rows used to
  // flash through here on every page load before the live attendance
  // RPCs returned, briefly painting fake attendance events into the
  // log/history panes and the report KPIs.
  var RR_ATTENDANCE_LOG = [];

  var RR_ATTENDANCE_POLICY = _attDefaultPolicy();
  var _attWindow = 30;
  var _attSeq = RR_ATTENDANCE_LOG.length;

  function _attDefaultPolicy(){
    return {
      mode: 'hybrid',
      events: {
        late:     { points: 0.5, occurrence: false, label: 'Late' },
        callout:  { points: 1.0, occurrence: true,  label: 'Call-out' },
        earlyout: { points: 0.5, occurrence: false, label: 'Early out' },
        noshow:   { points: 3.0, occurrence: true,  label: 'No-show' },
        // VTO is a manager-offered opt-out — never counts against attendance.
        // Tracked here so it appears in reports and feeds the cushion recommendation.
        vto:      { points: 0,   occurrence: false, label: 'VTO (voluntary time off)' }
      },
      callout_window_hours: 4,
      late_grace_minutes: 10,
      decay_days: 90,
      reset: 'rolling',
      thresholds: {
        verbal:  { points: 2, occ: 2, label: 'Verbal warning' },
        written: { points: 4, occ: 4, label: 'Written warning' },
        final:   { points: 6, occ: 6, label: 'Final warning' },
        term:    { points: 8, occ: 8, label: 'Termination eligible' }
      },
      exempt_categories: ['Approved PTO','Jury duty','Bereavement','FMLA','Workplace injury'],
      notify_driver: true,
      notify_owner: true,
      auto_coach: true
    };
  }

  // ─── TAB SWITCHING ──────────────────────────────────────────────
  function attTab(name){
    document.querySelectorAll('#dr-sub-attendance .att-tab').forEach(function(b){ b.classList.remove('active'); });
    document.querySelector('#dr-sub-attendance .att-tab[data-att="' + name + '"]').classList.add('active');
    document.querySelectorAll('#dr-sub-attendance .att-pane').forEach(function(p){ p.classList.remove('active'); });
    document.getElementById('att-pane-' + name).classList.add('active');
    if (name === 'log') attRenderLog();
  }

  // ─── POLICY MUTATION ────────────────────────────────────────────
  function attSetMode(mode){
    RR_ATTENDANCE_POLICY.mode = mode;
    document.querySelectorAll('#att-pane-policy .pol-mode-btn').forEach(function(b){ b.classList.remove('active'); });
    document.querySelector('#att-pane-policy .pol-mode-btn[data-mode="' + mode + '"]').classList.add('active');
    attRender();
  }
  function attToggleChip(el){
    el.classList.toggle('active');
    var cat = el.getAttribute('data-cat');
    var arr = RR_ATTENDANCE_POLICY.exempt_categories;
    var idx = arr.indexOf(cat);
    if (el.classList.contains('active') && idx < 0) arr.push(cat);
    if (!el.classList.contains('active') && idx >= 0) arr.splice(idx, 1);
    attRender();
  }
  function attReadPolicyFromDom(){
    var p = RR_ATTENDANCE_POLICY;
    function num(id, dflt){ var v = parseFloat(document.getElementById(id).value); return isNaN(v) ? dflt : v; }
    function bool(id){ return !!document.getElementById(id).checked; }
    p.events.late.points     = num('pol-pts-late', 0.5);
    p.events.callout.points  = num('pol-pts-callout', 1);
    p.events.earlyout.points = num('pol-pts-earlyout', 0.5);
    p.events.noshow.points   = num('pol-pts-noshow', 3);
    if (p.events.vto)        p.events.vto.points = num('pol-pts-vto', 0);
    p.events.late.occurrence     = bool('pol-occ-late');
    p.events.callout.occurrence  = bool('pol-occ-callout');
    p.events.earlyout.occurrence = bool('pol-occ-earlyout');
    p.events.noshow.occurrence   = bool('pol-occ-noshow');
    if (p.events.vto)            p.events.vto.occurrence = bool('pol-occ-vto');
    p.callout_window_hours = num('pol-callout-window', 4);
    p.late_grace_minutes   = num('pol-late-grace', 10);
    p.decay_days           = num('pol-decay-days', 90);
    p.reset                = document.getElementById('pol-reset').value;
    p.thresholds.verbal.points  = num('pol-th-verbal-pts', 2);
    p.thresholds.verbal.occ     = num('pol-th-verbal-occ', 2);
    p.thresholds.written.points = num('pol-th-written-pts', 4);
    p.thresholds.written.occ    = num('pol-th-written-occ', 4);
    p.thresholds.final.points   = num('pol-th-final-pts', 6);
    p.thresholds.final.occ      = num('pol-th-final-occ', 6);
    p.thresholds.term.points    = num('pol-th-term-pts', 8);
    p.thresholds.term.occ       = num('pol-th-term-occ', 8);
    p.notify_driver = bool('pol-notify-driver');
    p.notify_owner  = bool('pol-notify-owner');
    p.auto_coach    = bool('pol-auto-coach');
  }
  function attWritePolicyToDom(){
    var p = RR_ATTENDANCE_POLICY;
    function set(id, v){ var el = document.getElementById(id); if (el) el.value = v; }
    function chk(id, v){ var el = document.getElementById(id); if (el) el.checked = !!v; }
    set('pol-pts-late', p.events.late.points);
    set('pol-pts-callout', p.events.callout.points);
    set('pol-pts-earlyout', p.events.earlyout.points);
    set('pol-pts-noshow', p.events.noshow.points);
    if (p.events.vto) set('pol-pts-vto', p.events.vto.points);
    chk('pol-occ-late', p.events.late.occurrence);
    chk('pol-occ-callout', p.events.callout.occurrence);
    chk('pol-occ-earlyout', p.events.earlyout.occurrence);
    chk('pol-occ-noshow', p.events.noshow.occurrence);
    if (p.events.vto) chk('pol-occ-vto', p.events.vto.occurrence);
    set('pol-callout-window', p.callout_window_hours);
    set('pol-late-grace', p.late_grace_minutes);
    set('pol-decay-days', p.decay_days);
    set('pol-reset', p.reset);
    set('pol-th-verbal-pts', p.thresholds.verbal.points);
    set('pol-th-verbal-occ', p.thresholds.verbal.occ);
    set('pol-th-written-pts', p.thresholds.written.points);
    set('pol-th-written-occ', p.thresholds.written.occ);
    set('pol-th-final-pts', p.thresholds.final.points);
    set('pol-th-final-occ', p.thresholds.final.occ);
    set('pol-th-term-pts', p.thresholds.term.points);
    set('pol-th-term-occ', p.thresholds.term.occ);
    chk('pol-notify-driver', p.notify_driver);
    chk('pol-notify-owner', p.notify_owner);
    chk('pol-auto-coach', p.auto_coach);
    document.querySelectorAll('#att-pane-policy .pol-mode-btn').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-mode') === p.mode);
    });
    document.querySelectorAll('#pol-exempt-chips .pol-chip').forEach(function(c){
      c.classList.toggle('active', p.exempt_categories.indexOf(c.getAttribute('data-cat')) >= 0);
    });
  }
  function attResetPolicy(){
    RR_ATTENDANCE_POLICY = _attDefaultPolicy();
    attWritePolicyToDom();
    attRender();
    _toast('Policy reset to defaults');
  }
  function attSavePolicy(){
    attReadPolicyFromDom();
    attRender();
    var s = document.getElementById('pol-foot-status');
    if (s) { s.textContent = 'Saved · applied to all drivers'; s.style.color = 'var(--green)';
      setTimeout(function(){ s.textContent = 'Editing draft · changes preview live in Report'; s.style.color = ''; }, 2400);
    }
    _toast('Attendance policy saved');
  }
  function _toast(msg){
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:var(--s-2-5) 16px;border-radius:8px;font-size:var(--fs-md);z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.2)';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 1800);
    setTimeout(function(){ t.remove(); }, 2300);
  }

  // ─── COMPUTATION ────────────────────────────────────────────────
  function attEventsForDriver(driverId, windowDays){
    var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
    return RR_ATTENDANCE_LOG.filter(function(e){
      if (e.driverId !== driverId) return false;
      if (new Date(e.date + 'T00:00:00') < cutoff) return false;
      return true;
    });
  }
  function attComputeDriver(driver, windowDays){
    var p = RR_ATTENDANCE_POLICY;
    var events = attEventsForDriver(driver.id, windowDays);
    var counts = { late:0, callout:0, noshow:0, earlyout:0, vto:0 };
    var points = 0, occ = 0, lastIncident = null;
    events.forEach(function(e){
      // Always tally counts so the report shows what happened
      counts[e.type] = (counts[e.type] || 0) + 1;
      // VTO + exempt events skip points/occurrences/lastIncident
      if (e.exempt) return;
      if (e.type === 'vto') return;
      var cfg = p.events[e.type];
      if (!cfg) return;
      points += cfg.points || 0;
      if (cfg.occurrence) occ += 1;
      if (!lastIncident || e.date > lastIncident) lastIncident = e.date;
    });
    var status = attDriverStatus(points, occ);
    // VTO doesn't reduce attendance % — driver was offered the day off
    var present = Math.max(0, driver.scheduled30 - counts.callout - counts.noshow);
    var rate = driver.scheduled30 > 0 ? Math.round(present / driver.scheduled30 * 100) : 100;
    return {
      counts: counts, points: Math.round(points * 10) / 10, occ: occ,
      lastIncident: lastIncident, status: status,
      scheduled: driver.scheduled30, present: present, rate: rate
    };
  }
  function attDriverStatus(points, occ){
    var t = RR_ATTENDANCE_POLICY.thresholds;
    var mode = RR_ATTENDANCE_POLICY.mode;
    function hits(level){
      if (mode === 'points')      return points >= t[level].points;
      if (mode === 'occurrence')  return occ >= t[level].occ;
      return points >= t[level].points || occ >= t[level].occ;
    }
    if (hits('term'))    return 'term';
    if (hits('final'))   return 'final';
    if (hits('written')) return 'written';
    if (hits('verbal'))  return 'verbal';
    return 'good';
  }
  function attStatusLabel(s){
    return ({ good:'Good standing', verbal:'Verbal warning', written:'Written warning', final:'Final warning', term:'Termination eligible' })[s] || s;
  }

  // ─── RENDERING ──────────────────────────────────────────────────
  function attCycleWindow(el){
    var seq = [30, 60, 90];
    _attWindow = seq[(seq.indexOf(_attWindow) + 1) % seq.length];
    el.textContent = 'Window: ' + _attWindow + ' days';
    attRender();
  }
  function attRender(){
    var rows = RR_DRIVERS.map(function(d){
      return { d: d, c: attComputeDriver(d, _attWindow) };
    });
    rows.sort(function(a, b){
      if (b.c.points !== a.c.points) return b.c.points - a.c.points;
      return b.c.occ - a.c.occ;
    });

    // KPIs
    var totalScheduled = 0, totalPresent = 0, inAction = 0, totalIncidents = 0;
    rows.forEach(function(r){
      totalScheduled += r.c.scheduled;
      totalPresent   += r.c.present;
      totalIncidents += r.c.counts.callout + r.c.counts.noshow;
      if (r.c.status !== 'good') inAction++;
    });
    var avgRate = totalScheduled > 0 ? Math.round(totalPresent / totalScheduled * 100) : 100;
    var rateEl = document.getElementById('att-kpi-rate');
    if (rateEl) {
      rateEl.textContent = avgRate + '%';
      rateEl.className = 'di-val ' + (avgRate >= 95 ? 'ok' : avgRate >= 90 ? 'warn' : 'bad');
    }
    var actionEl = document.getElementById('att-kpi-action');
    if (actionEl) {
      actionEl.textContent = inAction;
      actionEl.className = 'di-val ' + (inAction === 0 ? 'ok' : inAction <= 2 ? 'warn' : 'bad');
    }
    var incEl = document.getElementById('att-kpi-incidents');
    if (incEl) incEl.textContent = totalIncidents;
    var modeEl = document.getElementById('att-kpi-mode');
    if (modeEl) modeEl.textContent = ({ points:'Points-based', occurrence:'Occurrence-based', hybrid:'Hybrid' })[RR_ATTENDANCE_POLICY.mode];
    var modeSubEl = document.getElementById('att-kpi-mode-sub');
    if (modeSubEl) modeSubEl.textContent = RR_ATTENDANCE_POLICY.decay_days + '-day ' + RR_ATTENDANCE_POLICY.reset + ' · 4 thresholds';
    var rateSubEl = document.getElementById('att-kpi-rate-sub');
    if (rateSubEl) rateSubEl.textContent = totalPresent + ' / ' + totalScheduled + ' shifts · last ' + _attWindow + 'd';
    var incSubEl = document.getElementById('att-kpi-incidents-sub');
    if (incSubEl) incSubEl.textContent = 'Last ' + _attWindow + ' days · across ' + RR_DRIVERS.length + ' drivers';

    // Subnav badge — show count if any in action
    var badge = document.getElementById('att-subnav-badge');
    if (badge) {
      if (inAction > 0) { badge.textContent = inAction; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }

    // Table
    var body = document.getElementById('att-report-body');
    if (!body) return;
    body.innerHTML = '';
    rows.forEach(function(r){
      var tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.onclick = function(){ attToggleDetail(r.d.id); };
      var statusClass = r.c.status;
      var pointsCls = r.c.points >= RR_ATTENDANCE_POLICY.thresholds.written.points ? 'bad'
                     : r.c.points >= RR_ATTENDANCE_POLICY.thresholds.verbal.points ? 'warn' : '';
      tr.innerHTML =
        '<td><div class="cell-driver"><div class="avatar-sm ' + r.d.tier + '">' + r.d.id + '</div>'
        + '<div><div class="cell-name">' + r.d.name + '</div>'
        + '<div class="cell-name-sub">' + (r.c.lastIncident ? 'Last: ' + _fmtRel(r.c.lastIncident) : 'Clean record') + '</div></div></div></td>'
        + '<td>' + r.d.station + '</td>'
        + '<td class="att-num">' + r.c.scheduled + '</td>'
        + '<td class="att-num">' + r.c.present + '</td>'
        + '<td class="att-num' + (r.c.counts.late ? ' warn' : '') + '">' + (r.c.counts.late || '–') + '</td>'
        + '<td class="att-num' + (r.c.counts.callout ? ' warn' : '') + '">' + (r.c.counts.callout || '–') + '</td>'
        + '<td class="att-num' + (r.c.counts.noshow ? ' bad' : '') + '">' + (r.c.counts.noshow || '–') + '</td>'
        + '<td class="att-num" style="color:var(--sky)">' + (r.c.counts.vto || '–') + '</td>'
        + '<td class="att-num ' + pointsCls + '">' + r.c.points.toFixed(1) + '</td>'
        + '<td class="att-num">' + r.c.occ + '</td>'
        + '<td>' + attStatusPillFor(r.d, r.c) + '</td>'
        + '<td class="cell-time">' + (r.c.lastIncident ? _fmtDate(r.c.lastIncident) : '—') + '</td>'
        + '<td>' + attActionFor(r.d, r.c) + '</td>';
      body.appendChild(tr);

      // Detail row (timeline)
      var detail = document.createElement('tr');
      detail.className = 'att-detail-row';
      detail.id = 'att-detail-' + r.d.id;
      var events = attEventsForDriver(r.d.id, _attWindow).sort(function(a,b){ return b.date.localeCompare(a.date); });
      var timelineHtml = events.length === 0
        ? '<div style="color:var(--text-subtle);font-style:italic">No events in this window. Clean record.</div>'
        : '<div class="att-timeline">' + events.map(function(e){
            var pts = (RR_ATTENDANCE_POLICY.events[e.type] || {}).points || 0;
            var counted = !e.exempt;
            return '<span class="att-timeline-date">' + _fmtDate(e.date) + '</span>'
              + '<span><span class="att-event-dot ' + e.type + '"></span><strong>' + (RR_ATTENDANCE_POLICY.events[e.type] || {label:e.type}).label + '</strong>'
              + (e.note ? ' <span class="u-subtle">· ' + e.note + '</span>' : '')
              + (e.exempt ? ' <span class="tag" style="background:var(--green-soft);color:var(--green);font-size:var(--fs-xs);margin-left:6px">Exempt: ' + e.category + '</span>' : '')
              + '</span>'
              + '<span class="att-timeline-pts">' + (counted ? '+' + pts.toFixed(1) + ' pt' : '0 pt') + '</span>'
              + '<button class="btn btn-sm" onclick="event.stopPropagation();attToggleExempt(\'' + e.id + '\')">' + (e.exempt ? 'Un-exempt' : 'Exempt') + '</button>';
          }).join('') + '</div>';
      detail.innerHTML = '<td colspan="13" class="att-detail-cell"><div style="font-weight:600;font-size:var(--fs-sm);margin-bottom:var(--s-2);color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Timeline · ' + r.d.name + '</div>' + timelineHtml + '</td>';
      body.appendChild(detail);
    });

    // Log count badge
    var logCount = document.getElementById('att-log-count');
    if (logCount) logCount.textContent = RR_ATTENDANCE_LOG.length;
  }

  function attToggleDetail(driverId){
    document.querySelectorAll('#att-report-body .att-detail-row').forEach(function(r){
      if (r.id === 'att-detail-' + driverId) r.classList.toggle('open');
      else r.classList.remove('open');
    });
  }

  function attToggleExempt(eventId){
    var ev = RR_ATTENDANCE_LOG.find(function(e){ return e.id === eventId; });
    if (!ev) return;
    ev.exempt = !ev.exempt;
    if (ev.exempt && !ev.category) ev.category = 'Approved PTO';
    attRender();
    if (document.getElementById('att-pane-log').classList.contains('active')) attRenderLog();
  }

  function attRenderLog(){
    var body = document.getElementById('att-log-body');
    if (!body) return;
    var sorted = RR_ATTENDANCE_LOG.slice().sort(function(a, b){ return b.date.localeCompare(a.date); });
    if (sorted.length === 0) {
      body.innerHTML = '<div style="padding:var(--s-4);text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">No events logged yet. Mark drivers in Today\'s check-in to populate.</div>';
      return;
    }
    body.innerHTML = sorted.map(function(e){
      var d = RR_DRIVERS.find(function(x){ return x.id === e.driverId; });
      if (!d) return '';
      var cfg = RR_ATTENDANCE_POLICY.events[e.type] || { label:e.type, points:0 };
      return '<div class="att-log-row">'
        + '<span style="color:var(--text-muted);font-variant-numeric:tabular-nums">' + _fmtDate(e.date) + ' <span style="color:var(--text-subtle);font-size:var(--fs-xs)">· ' + _fmtRel(e.date) + '</span></span>'
        + '<span><strong>' + d.name + '</strong> <span class="u-subtle">· ' + d.station + '</span></span>'
        + '<span><span class="att-event-dot ' + e.type + '"></span>' + cfg.label + (e.note ? ' <span class="u-subtle">· ' + e.note + '</span>' : '') + (e.exempt ? ' <span class="tag" style="background:var(--green-soft);color:var(--green);font-size:var(--fs-xs);margin-left:6px">Exempt</span>' : '') + '</span>'
        + '<span style="text-align:right;font-variant-numeric:tabular-nums" class="' + (e.exempt ? '' : 'att-num') + '">' + (e.exempt ? '0.0' : cfg.points.toFixed(1)) + '</span>'
        + '<button class="btn btn-sm" onclick="attToggleExempt(\'' + e.id + '\')">' + (e.exempt ? 'Un-exempt' : 'Exempt') + '</button>'
        + '</div>';
    }).join('');
  }

  function attExportCsv(){
    var rows = [['Driver','Station','Scheduled','Present','Late','Callouts','No-shows','VTO','Points','Occurrences','Status','Last incident']];
    RR_DRIVERS.forEach(function(d){
      var c = attComputeDriver(d, _attWindow);
      rows.push([d.name, d.station, c.scheduled, c.present, c.counts.late, c.counts.callout, c.counts.noshow, c.counts.vto, c.points.toFixed(1), c.occ, attStatusLabel(c.status), c.lastIncident || '']);
    });
    var csv = rows.map(function(r){ return r.map(function(x){ return '"' + String(x).replace(/"/g,'""') + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type:'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'attendance-report-' + _attWindow + 'd.csv';
    document.body.appendChild(a); a.click(); a.remove();
    _toast('Exported attendance-report-' + _attWindow + 'd.csv');
  }

  // ─── HOOKS FROM CHECK-IN FLOW ───────────────────────────────────
  // ciMark() calls these when a driver is marked Late / Callout / No-show / Present.
  window.attLogFromCheckin = function(driverName, status){
    var driver = RR_DRIVERS.find(function(d){ return d.name === driverName; });
    if (!driver) return;
    var today = _daysAgo(0);
    // Replace any same-day event for this driver to keep the log idempotent during demo
    RR_ATTENDANCE_LOG = RR_ATTENDANCE_LOG.filter(function(e){
      return !(e.driverId === driver.id && e.date === today && (e.type === 'late' || e.type === 'callout' || e.type === 'noshow'));
    });
    _attSeq++;
    RR_ATTENDANCE_LOG.push({
      id: 'a' + _attSeq,
      driverId: driver.id,
      date: today,
      type: status === 'noshow' ? 'noshow' : status,  // map check-in status → event type
      category: null,
      exempt: false,
      note: 'From morning check-in'
    });
    attRender();
  };
  window.attClearCheckinForToday = function(driverName){
    var driver = RR_DRIVERS.find(function(d){ return d.name === driverName; });
    if (!driver) return;
    var today = _daysAgo(0);
    RR_ATTENDANCE_LOG = RR_ATTENDANCE_LOG.filter(function(e){
      return !(e.driverId === driver.id && e.date === today && (e.type === 'late' || e.type === 'callout' || e.type === 'noshow'));
    });
    attRender();
  };

  // Initial render
  document.addEventListener('DOMContentLoaded', function(){ attRender(); });
  // Also render now in case DOMContentLoaded already fired (script is at end of body)
  if (document.readyState !== 'loading') attRender();

  // ═══════════════════════════════════════════════════════════════
  // SUSPENSION + HR FILE
  // ═══════════════════════════════════════════════════════════════
  var RR_SUSPENSIONS = []; // {id, driverId, startDate, returnDate, type, category, detail, evidence[], suspendedBy, timestamp, status, endedAt, endedReason}
  var RR_HR_EVENTS   = []; // {id, driverId, type, severity, date, by, summary, detail, links, immutable, timestamp}
  var _susSeq = 0, _hrSeq = 0;

  function _findDriver(idOrName){
    if (!window.RR_DRIVERS) return null;
    return RR_DRIVERS.find(function(d){ return d.id === idOrName || d.name === idOrName; });
  }
  function _daysFromNow(n){ var d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0,10); }
  function isDriverSuspended(driverId){
    return RR_SUSPENSIONS.some(function(s){ return s.driverId === driverId && s.status === 'active'; });
  }
  function getActiveSuspension(driverId){
    return RR_SUSPENSIONS.find(function(s){ return s.driverId === driverId && s.status === 'active'; });
  }
  window.isDriverSuspended = isDriverSuspended;
  window.getActiveSuspension = getActiveSuspension;

  // ─── SUSPEND FORM HELPERS (used by coach drawer) ────────────────
  function cdSusToggleReturn(){
    var t = document.getElementById('cd-sus-type');
    var row = document.getElementById('cd-sus-return-row');
    if (!t || !row) return;
    row.style.display = (t.value === 'custom') ? '' : 'none';
  }
  function cdPopulateSuspendForm(driverName){
    var driver = _findDriver(driverName);
    var startEl = document.getElementById('cd-sus-start');
    if (startEl) startEl.value = _daysFromNow(0);
    var ev = document.getElementById('cd-sus-evidence');
    if (!ev) return;
    if (!driver) {
      ev.innerHTML = '<div style="color:var(--text-subtle);font-style:italic">No matching driver found.</div>';
      return;
    }
    var events = (window.RR_ATTENDANCE_LOG || [])
      .filter(function(e){ return e.driverId === driver.id; })
      .slice().sort(function(a, b){ return b.date.localeCompare(a.date); })
      .slice(0, 6);
    if (events.length === 0) {
      ev.innerHTML = '<div style="color:var(--text-subtle);font-style:italic">No attendance events on file for ' + driver.name + '.</div>';
      return;
    }
    ev.innerHTML = events.map(function(e){
      var label = ({ late:'Late arrival', callout:'Call-out', noshow:'No-call no-show', earlyout:'Early clock-out' })[e.type] || e.type;
      return '<label style="display:flex;align-items:center;gap:var(--s-2);cursor:pointer">'
        + '<input type="checkbox" data-evidence-id="' + e.id + '" ' + (e.exempt ? '' : 'checked') + ' />'
        + '<span><strong>' + _fmtDate(e.date) + '</strong> — ' + label
        + (e.note ? ' <span class="u-subtle">(' + e.note + ')</span>' : '')
        + (e.exempt ? ' <span style="color:var(--green);font-size:var(--fs-xs);font-weight:600;margin-left:4px">EXEMPT</span>' : '')
        + '</span></label>';
    }).join('');
  }
  function cdReadSuspendForm(){
    function v(id){ var el = document.getElementById(id); return el ? el.value : ''; }
    function c(id){ var el = document.getElementById(id); return el ? !!el.checked : false; }
    return {
      startDate: v('cd-sus-start') || _daysFromNow(0),
      type: v('cd-sus-type'),
      returnDate: v('cd-sus-return') || null,
      category: v('cd-sus-category'),
      detail: v('cd-sus-detail'),
      evidence: Array.from(document.querySelectorAll('#cd-sus-evidence input[type=checkbox]:checked'))
                  .map(function(c){ return c.getAttribute('data-evidence-id'); }),
      notifyDriver: c('cd-sus-notify-driver'),
      notifyOwner: c('cd-sus-notify-owner'),
      genDoc: c('cd-sus-gen-doc'),
      releaseShifts: c('cd-sus-release-shifts'),
      revokeApp: c('cd-sus-revoke-app')
    };
  }
  window.cdSusToggleReturn = cdSusToggleReturn;
  window.cdPopulateSuspendForm = cdPopulateSuspendForm;
  window.cdReadSuspendForm = cdReadSuspendForm;

  // ─── CORE: suspendDriver ────────────────────────────────────────
  function suspendDriver(driverIdOrName, opts){
    var driver = _findDriver(driverIdOrName);
    if (!driver) { _toast('Could not find driver "' + driverIdOrName + '"'); return; }
    if (isDriverSuspended(driver.id)) { _toast(driver.name + ' is already suspended'); return; }
    var startDate = opts.startDate || _daysFromNow(0);
    var returnDate = null;
    if (opts.type === 'indef' || opts.type === 'term') returnDate = null;
    else if (opts.type === 'custom') returnDate = opts.returnDate;
    else { var n = parseInt(opts.type, 10); if (!isNaN(n)) returnDate = _daysFromNow(n); }
    _susSeq++;
    var sus = {
      id: 'sus_' + _susSeq,
      driverId: driver.id,
      startDate: startDate,
      returnDate: returnDate,
      type: opts.type,
      category: opts.category || 'other',
      detail: opts.detail || '',
      evidence: opts.evidence || [],
      suspendedBy: 'You (Owner)',
      timestamp: Date.now(),
      status: 'active'
    };
    RR_SUSPENSIONS.push(sus);
    _hrSeq++;
    RR_HR_EVENTS.push({
      id: 'hr_' + _hrSeq,
      driverId: driver.id,
      type: opts.type === 'term' ? 'pending_term' : 'suspension',
      severity: opts.type === 'term' ? 'critical' : 'major',
      date: startDate,
      by: 'You (Owner)',
      summary: (opts.type === 'term' ? 'Pending termination · ' : 'Suspended · ') + _categoryLabel(opts.category),
      detail: opts.detail,
      links: { suspensionId: sus.id, evidence: opts.evidence },
      immutable: true,
      timestamp: Date.now()
    });
    cascadeSuspension();
    var msg = driver.name + ' suspended · HR record created';
    if (opts.notifyDriver) msg += ' · driver SMS sent';
    if (opts.releaseShifts) msg += ' · shifts released';
    _toast(msg);
  }
  function reinstateDriver(driverId, opts){
    opts = opts || {};
    var s = getActiveSuspension(driverId);
    if (!s) return;
    s.status = 'ended';
    s.endedAt = _daysFromNow(0);
    s.endedReason = opts.reason || '';
    _hrSeq++;
    var driver = _findDriver(driverId);
    RR_HR_EVENTS.push({
      id: 'hr_' + _hrSeq,
      driverId: driverId,
      type: 'reinstate',
      severity: 'info',
      date: _daysFromNow(0),
      by: 'You (Owner)',
      summary: 'Reinstated to active duty',
      detail: opts.reason || '',
      links: { suspensionId: s.id },
      immutable: true,
      timestamp: Date.now()
    });
    cascadeSuspension();
    _toast((driver ? driver.name : 'Driver') + ' reinstated · HR record updated');
  }
  window.suspendDriver = suspendDriver;
  window.reinstateDriver = reinstateDriver;

  function _categoryLabel(cat){
    return ({ attendance:'Attendance policy', safety:'Safety', conduct:'Conduct', scorecard:'Performance', theft:'Theft / time fraud', other:'Other' })[cat] || cat;
  }

  // ─── CASCADE ────────────────────────────────────────────────────
  function cascadeSuspension(){
    applySuspensionToRoster();
    applySuspensionToCheckin();
    applySuspensionToScheduleBanner();
    if (window.attRender) attRender();
  }
  window.cascadeSuspension = cascadeSuspension;

  function applySuspensionToRoster(){
    var tbody = document.querySelector('#dr-sub-roster .table tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(function(tr){
      var nameEl = tr.querySelector('.cell-name');
      if (!nameEl) return;
      var driver = _findDriver(nameEl.textContent.trim());
      if (!driver) return;
      var s = getActiveSuspension(driver.id);
      var cells = tr.children;
      if (cells.length < 8) return;
      var statusCell = cells[5];
      var actionCell = cells[7];
      if (s) {
        if (!tr.dataset.origStatus) tr.dataset.origStatus = statusCell.innerHTML;
        if (!tr.dataset.origAction) tr.dataset.origAction = actionCell.innerHTML;
        tr.classList.add('row-suspended');
        var returnTxt = s.returnDate ? 'returns ' + _fmtDate(s.returnDate) : (s.type === 'term' ? 'pending term.' : 'indefinite');
        statusCell.innerHTML = '<span class="att-status-pill term">Suspended</span><br>'
          + '<span style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px;display:inline-block">' + returnTxt + '</span>';
        actionCell.innerHTML = '<button class="btn btn-sm" onclick="openReinstateModal(\'' + driver.id + '\')">Reinstate</button>'
          + ' <button class="btn btn-sm" style="margin-top:4px" onclick="openHrFile(\'' + driver.id + '\')">HR file</button>';
      } else if (tr.dataset.origStatus !== undefined) {
        tr.classList.remove('row-suspended');
        statusCell.innerHTML = tr.dataset.origStatus;
        actionCell.innerHTML = tr.dataset.origAction;
        delete tr.dataset.origStatus;
        delete tr.dataset.origAction;
      }
    });
  }

  function applySuspensionToCheckin(){
    var rows = document.querySelectorAll('#view-checkin .checkin-row');
    if (!rows.length) return;
    var hidden = 0;
    rows.forEach(function(row){
      var nameEl = row.querySelector('.checkin-driver-name');
      if (!nameEl) return;
      var driver = _findDriver(nameEl.textContent.trim());
      if (!driver) return;
      if (isDriverSuspended(driver.id)) { row.classList.add('checkin-suspended'); hidden++; }
      else row.classList.remove('checkin-suspended');
    });
    var sub = document.querySelector('#view-checkin .page-sub');
    if (sub) {
      var totalRows = rows.length;
      var expected = totalRows - hidden;
      sub.textContent = sub.textContent.replace(/\d+ drivers expected/, expected + ' drivers expected');
    }
    var marked = document.getElementById('ci-marked');
    if (marked && hidden > 0) {
      var prog = document.getElementById('ci-progress');
      if (prog) {
        var n = parseInt(marked.textContent, 10) || 0;
        var denom = (rows.length - hidden) || 1;
        prog.style.width = Math.min(100, n / denom * 100) + '%';
        // Update the surrounding text "0 of 78 marked" → "0 of 77 marked"
        var metaSpan = marked.parentNode;
        if (metaSpan) {
          metaSpan.lastChild && metaSpan.lastChild.nodeType === 3
            ? metaSpan.lastChild.nodeValue = ' of ' + denom + ' marked'
            : null;
        }
      }
    }
  }

  function applySuspensionToScheduleBanner(){
    var anchor = document.querySelector('#sched-sub-week');
    if (!anchor) return;
    var existing = document.getElementById('sched-suspended-banner');
    var active = RR_SUSPENSIONS.filter(function(s){ return s.status === 'active'; });
    if (active.length === 0) {
      if (existing) existing.remove();
      var openBadge = document.querySelector('#view-schedule .subnav-item[data-sub="open"] span');
      if (openBadge && openBadge.dataset.origCount !== undefined) {
        openBadge.textContent = openBadge.dataset.origCount;
        delete openBadge.dataset.origCount;
      }
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'sched-suspended-banner';
      existing.style.cssText = 'background:var(--red-soft);border:1px solid var(--red-border);color:var(--red-dark);border-radius:8px;padding:var(--s-2-5) var(--s-3-5);margin-bottom:var(--s-3);font-size:var(--fs-md);display:flex;align-items:center;gap:var(--s-2-5)';
      anchor.insertBefore(existing, anchor.firstChild);
    }
    var names = active.map(function(s){ var d = _findDriver(s.driverId); return d ? d.name : '?'; }).join(', ');
    var releasedShifts = active.length * 3; // demo estimate
    existing.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>'
      + '<div style="flex:1"><strong>' + active.length + ' suspended:</strong> ' + names + ' · <strong>' + releasedShifts + ' shifts</strong> released to Open Shifts pool, need backfill</div>'
      + '<button class="btn btn-sm" onclick="openSuspendedListModal()" style="background:#fff;color:var(--red-dark);border-color:var(--red-border)">View</button>';
    var openBadge = document.querySelector('#view-schedule .subnav-item[data-sub="open"] span');
    if (openBadge) {
      if (openBadge.dataset.origCount === undefined) openBadge.dataset.origCount = parseInt(openBadge.textContent, 10) || 0;
      openBadge.textContent = parseInt(openBadge.dataset.origCount, 10) + releasedShifts;
    }
  }

  // ─── ATTENDANCE PILL OVERRIDE (called by attRender via attStatusPillFor) ──
  window.attStatusPillFor = function(driver, comp){
    if (isDriverSuspended(driver.id)) {
      var s = getActiveSuspension(driver.id);
      var sub = s.returnDate ? ' · returns ' + _fmtDate(s.returnDate) : (s.type === 'term' ? ' · pending term.' : ' · indefinite');
      return '<span class="att-status-pill term">Suspended</span>'
        + '<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">' + _categoryLabel(s.category) + sub + '</div>';
    }
    return '<span class="att-status-pill ' + comp.status + '">' + attStatusLabel(comp.status) + '</span>';
  };
  window.attActionFor = function(driver, comp){
    if (isDriverSuspended(driver.id)) {
      return '<button class="btn btn-sm" onclick="event.stopPropagation();openReinstateModal(\'' + driver.id + '\')">Reinstate</button>';
    }
    if (comp.status !== 'good') {
      return '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openCoachDrawer(\'' + driver.name.replace(/\x27/g, "\\\x27") + '\',\x27attendance\x27,\x27Attendance policy: ' + attStatusLabel(comp.status) + ' · ' + comp.points.toFixed(1) + ' pts · ' + comp.occ + ' occ\x27)">Coach</button>';
    }
    return '<span style="color:var(--text-subtle);font-size:var(--fs-sm)">—</span>';
  };

  // ─── REINSTATE MODAL ────────────────────────────────────────────
  function openReinstateModal(driverId){
    var driver = _findDriver(driverId);
    var s = getActiveSuspension(driverId);
    if (!driver || !s) return;
    var sumEl = document.getElementById('reinstate-summary');
    var subEl = document.getElementById('reinstate-sub');
    var btn = document.getElementById('reinstate-confirm-btn');
    var startedDays = Math.round((Date.now() - new Date(s.startDate + 'T12:00:00').getTime()) / 86400000);
    sumEl.innerHTML =
      '<div style="font-weight:600;color:var(--text);font-size:var(--fs-md);margin-bottom:4px">' + driver.name + ' · ' + driver.station + '</div>'
      + 'Suspended <strong>' + _fmtRel(s.startDate) + '</strong> for <strong>' + _categoryLabel(s.category) + '</strong>'
      + (s.returnDate ? ' · scheduled return <strong>' + _fmtDate(s.returnDate) + '</strong>' : ' · indefinite')
      + (startedDays >= 0 ? ' · ' + Math.max(0, startedDays) + ' days suspended' : '');
    subEl.textContent = 'Restore active status, schedule eligibility, and app access for ' + driver.name + '.';
    document.getElementById('reinstate-reason').value = '';
    btn.onclick = function(){
      var reason = document.getElementById('reinstate-reason').value.trim();
      reinstateDriver(driverId, { reason: reason });
      closeModal('modal-reinstate');
    };
    openModal('modal-reinstate');
  }
  window.openReinstateModal = openReinstateModal;

  // ─── SUSPENDED LIST MODAL ───────────────────────────────────────
  function openSuspendedListModal(){
    var body = document.getElementById('suspended-list-body');
    if (!body) return;
    var active = RR_SUSPENSIONS.filter(function(s){ return s.status === 'active'; });
    if (active.length === 0) {
      body.innerHTML = '<div style="padding:var(--s-4);text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">No drivers currently suspended.</div>';
    } else {
      body.innerHTML = active.map(function(s){
        var d = _findDriver(s.driverId);
        if (!d) return '';
        var returnTxt = s.returnDate ? 'returns ' + _fmtDate(s.returnDate) : (s.type === 'term' ? 'pending term.' : 'indefinite');
        return '<div class="susp-list-row">'
          + '<div class="avatar-sm ' + d.tier + '">' + d.id + '</div>'
          + '<div><div style="font-weight:600;font-size:var(--fs-md)">' + d.name + '</div>'
          + '<div class="u-xs-subtle">' + d.station + ' · ' + _categoryLabel(s.category) + ' · ' + returnTxt + ' · suspended ' + _fmtRel(s.startDate) + '</div></div>'
          + '<button class="btn btn-sm" onclick="closeModal(\'modal-suspended-list\');openHrFile(\'' + d.id + '\')">HR file</button>'
          + '<button class="btn btn-sm btn-primary" onclick="closeModal(\'modal-suspended-list\');openReinstateModal(\'' + d.id + '\')">Reinstate</button>'
          + '</div>';
      }).join('');
    }
    openModal('modal-suspended-list');
  }
  window.openSuspendedListModal = openSuspendedListModal;

  // ─── HR FILE MODAL ──────────────────────────────────────────────
  function openHrFile(driverId){
    var driver = _findDriver(driverId);
    if (!driver) return;
    document.getElementById('hr-file-name').textContent = 'HR file · ' + driver.name;
    var events = RR_HR_EVENTS.filter(function(e){ return e.driverId === driverId; })
                  .slice().sort(function(a, b){ return b.timestamp - a.timestamp; });
    var body = document.getElementById('hr-file-body');
    if (events.length === 0) {
      body.innerHTML = '<div style="padding:var(--s-4);text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">No HR events on file. Suspensions, written warnings, and termination actions appear here.</div>';
    } else {
      body.innerHTML =
        '<div style="font-size:var(--fs-xs);color:var(--text-subtle);background:var(--canvas);padding:var(--s-2) var(--s-3);border-radius:var(--r-md);margin-bottom:var(--s-3);line-height:1.5"><strong style="color:var(--text)">About this file:</strong> Every entry below is timestamped and immutable. This is the documentation a court, unemployment officer, or HR vendor will request if termination is challenged.</div>'
        + events.map(function(e){
          var typeLabel = ({ suspension:'Suspension', reinstate:'Reinstatement', warning:'Written warning', pending_term:'Pending termination' })[e.type] || e.type;
          var evidenceTxt = '';
          if (e.links && e.links.evidence && e.links.evidence.length) {
            evidenceTxt = '<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">Evidence: ' + e.links.evidence.length + ' attendance event(s) attached</div>';
          }
          return '<div class="hr-event">'
            + '<div class="hr-event-date">' + _fmtDate(e.date) + '<br>' + _fmtRel(e.date) + '</div>'
            + '<div class="hr-event-dot ' + e.type + '"></div>'
            + '<div>'
              + '<div class="hr-event-summary">' + typeLabel + ' — ' + e.summary + '</div>'
              + '<div class="hr-event-meta">By ' + e.by + ' · ' + new Date(e.timestamp).toLocaleString() + (e.immutable ? ' · 🔒 immutable' : '') + '</div>'
              + (e.detail ? '<div class="hr-event-detail">' + e.detail + '</div>' : '')
              + evidenceTxt
            + '</div>'
          + '</div>';
        }).join('');
    }
    openModal('modal-hr-file');
  }
  window.openHrFile = openHrFile;

  // ═══════════════════════════════════════════════════════════════
  // PERFORMANCE MANAGEMENT — bottom-N + suggested action × staffing risk
  //   - Reads composite score from RR_DRIVERS, attendance points from
  //     attComputeDriver, suspension status from RR_SUSPENSIONS
  //   - Suggested action = base action(score, points) capped by staffing
  //     risk ceiling (Healthy / Cautious / Critical)
  //   - Performance Distribution KPI rendered here (moved from Insights)
  //   - Bottom-N selector: by count or by percent
  // ═══════════════════════════════════════════════════════════════

  // Pull staffing-risk level from the existing hero band's title.
  // recomputeStaffingRisk() already maintains this — we just consume.
  function perfStaffingLevel(){
    var t = document.getElementById('staffing-hero-title');
    var txt = (t && t.textContent || '').toLowerCase();
    if (txt.indexOf('critical') >= 0 || txt.indexOf('hold') >= 0) return 'critical';
    if (txt.indexOf('healthy') >= 0 || txt.indexOf('release') >= 0) return 'healthy';
    return 'cautious';
  }

  // Termination ceiling per staffing level.
  // 'keep' < 'coach' < 'verbal' < 'written' < 'final' < 'suspend' < 'term'
  var PERF_RANK = { keep:0, coach:1, verbal:2, written:3, final:4, suspend:5, term:6 };
  var PERF_LABEL = {
    keep: 'Top performer · recognize',
    coach: 'Coach',
    verbal: 'Verbal warning',
    written: 'Written warning',
    final: 'Final warning',
    suspend: 'Suspend',
    term: 'Term-eligible'
  };
  function perfCeiling(level){
    if (level === 'healthy')  return 'term';     // No constraint — everything on the table
    if (level === 'critical') return 'coach';    // Hold the line; only coaching
    return 'final';                               // Cautious — final warning ok, no termination
  }
  function _perfCap(action, ceiling){
    if (PERF_RANK[action] > PERF_RANK[ceiling]) return ceiling;
    return action;
  }

  // Per-driver "what should we do" before any ceiling cap.
  function perfBaseAction(driver){
    var score = driver.score || 0;
    var comp = (window.attComputeDriver && window.RR_ATTENDANCE_POLICY)
      ? attComputeDriver(driver, 30) : null;
    var points = comp ? comp.points : 0;
    var attStatus = comp ? comp.status : 'good';

    // Attendance status escalates regardless of score
    if (attStatus === 'term')    return 'term';
    if (attStatus === 'final')   return 'final';
    if (attStatus === 'written') return 'written';
    if (attStatus === 'verbal')  return 'verbal';

    if (score < 60) return 'term';
    if (score < 65) return 'final';
    if (score < 70) return 'written';
    if (score < 75) return 'coach';
    if (score < 85) return 'keep';
    return 'keep';
  }
  function perfSuggestedAction(driver){
    if (window.isDriverSuspended && isDriverSuspended(driver.id)) return 'suspend'; // already suspended
    var base = perfBaseAction(driver);
    var ceiling = perfCeiling(perfStaffingLevel());
    return _perfCap(base, ceiling);
  }

  // ─── PERFORMANCE DISTRIBUTION ───────────────────────────────────
  function perfRenderDistribution(){
    var body = document.getElementById('perf-distribution-body');
    if (!body || !window.RR_DRIVERS) return;
    var roster = RR_DRIVERS.slice();
    var bands = [
      { label: 'Top tier (85+)',     min: 85, max: 200, klass: 'tier-a' },
      { label: 'Strong (75–84)',     min: 75, max: 84,  klass: 'tier-b' },
      { label: 'Coachable (65–74)',  min: 65, max: 74,  klass: 'tier-c' },
      { label: 'At risk (< 65)',     min: 0,  max: 64,  klass: 'tier-d' }
    ];
    var total = roster.length;
    var maxBandSize = bands.reduce(function(m, b){
      var n = roster.filter(function(d){ return (d.score||0) >= b.min && (d.score||0) <= b.max; }).length;
      return Math.max(m, n);
    }, 1);
    body.innerHTML = bands.map(function(b){
      var n = roster.filter(function(d){ return (d.score||0) >= b.min && (d.score||0) <= b.max; }).length;
      var pct = total > 0 ? Math.round(n / total * 100) : 0;
      var barWidth = maxBandSize > 0 ? Math.round(n / maxBandSize * 100) : 0;
      return '<div class="di-bar-row">'
        + '<span class="di-bar-label">' + b.label + '</span>'
        + '<div class="di-bar-track"><div class="di-bar-fill ' + b.klass + '" style="width:' + barWidth + '%"></div></div>'
        + '<div class="di-bar-count">' + n + '</div>'
      + '</div>';
    }).join('');
    var status = document.getElementById('perf-dist-status');
    if (status) status.textContent = 'Across ' + total + ' active driver' + (total === 1 ? '' : 's');
  }

  // ─── ACTION BADGE STYLING ───────────────────────────────────────
  function perfActionBadge(action, capped){
    var color = ({
      keep:    { bg: 'var(--green-soft)',  fg: 'var(--green)' },
      coach:   { bg: '#DBEAFE',            fg: '#1D4ED8' },
      verbal:  { bg: '#FEF3C7',            fg: '#A16207' },
      written: { bg: 'var(--amber-soft)',  fg: 'var(--amber)' },
      final:   { bg: '#FFEDD5',            fg: '#C2410C' },
      suspend: { bg: '#FEE2E2',            fg: 'var(--red-dark)' },
      term:    { bg: 'var(--red)',         fg: '#fff' }
    })[action] || { bg: 'var(--canvas)', fg: 'var(--text)' };
    var capNote = capped ? '<span style="font-size:9px;font-weight:500;opacity:.85;display:block;margin-top:1px;letter-spacing:0;text-transform:none">capped by staffing</span>' : '';
    return '<span style="display:inline-block;padding:var(--s-1) 10px;border-radius:var(--r-md);font-size:var(--fs-xs);font-weight:700;background:' + color.bg + ';color:' + color.fg + '">' + (PERF_LABEL[action] || action) + capNote + '</span>';
  }

  // ─── GUIDANCE BAND ─────────────────────────────────────────────
  function perfRenderGuidance(){
    var level = perfStaffingLevel();
    var iconWrap = document.getElementById('perf-guidance-icon');
    var titleEl = document.getElementById('perf-guidance-title');
    var msgEl = document.getElementById('perf-guidance-msg');
    var ceilEl = document.getElementById('perf-guidance-ceiling');
    if (!titleEl || !msgEl || !ceilEl) return;
    var copy = ({
      healthy: {
        title: 'Healthy — terminate underperformers without holding back',
        msg: 'Bench is deep. You can release bottom performers and Coverage Confidence will hold. Suggested actions below go up to Term-eligible.',
        ceilLabel: 'Term-eligible',
        ceilColor: 'var(--green)',
        iconBg: 'var(--green-soft)', iconFg: 'var(--green)'
      },
      cautious: {
        title: 'Cautious — terminate selectively, hold most',
        msg: 'You\'re short of OKAMI need after predicted hires. Reserve termination for egregious cases — final-warning instead. Suggestions are capped at Final warning.',
        ceilLabel: 'Final warning',
        ceilColor: 'var(--amber)',
        iconBg: 'var(--amber-soft)', iconFg: 'var(--amber)'
      },
      critical: {
        title: 'Critical — hold the line, coach hard',
        msg: 'Coverage is at risk. Terminations would put you below operational floor. Suggested actions are capped at Coach — the goal is to recover these drivers, not lose them.',
        ceilLabel: 'Coach',
        ceilColor: 'var(--red)',
        iconBg: '#FEE2E2', iconFg: 'var(--red-dark)'
      }
    })[level] || {};
    titleEl.textContent = copy.title || '';
    msgEl.textContent = copy.msg || '';
    ceilEl.textContent = copy.ceilLabel || '';
    ceilEl.style.color = copy.ceilColor || 'var(--text)';
    if (iconWrap) {
      iconWrap.style.background = copy.iconBg || 'var(--canvas)';
      iconWrap.style.color = copy.iconFg || 'var(--text-muted)';
    }
  }

  // ─── BOTTOM-N + ACCOUNTABILITY LIST ────────────────────────────
  function perfRender(){
    perfRenderGuidance();
    perfRenderDistribution();
    var body = document.getElementById('perf-decision-list-dynamic');
    if (!body || !window.RR_DRIVERS) return;
    var sel = document.getElementById('perf-bottom-n');
    var spec = sel ? sel.value : 'n:10';
    var parts = spec.split(':');
    var mode = parts[0]; var v = parseInt(parts[1], 10);
    var rosterSorted = RR_DRIVERS.slice().sort(function(a, b){ return (a.score||0) - (b.score||0); });
    var n = mode === 'p' ? Math.max(1, Math.ceil(rosterSorted.length * v / 100)) : v;
    n = Math.min(n, rosterSorted.length);
    var rows = rosterSorted.slice(0, n);

    var ceiling = perfCeiling(perfStaffingLevel());
    var countEl = document.getElementById('staffing-decisions-count');
    if (countEl) countEl.textContent = rows.length + ' driver' + (rows.length === 1 ? '' : 's') + ' shown · ceiling: ' + (PERF_LABEL[ceiling] || ceiling);

    if (rows.length === 0) {
      body.innerHTML = '<div style="padding:var(--s-4);text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">No drivers in roster.</div>';
      return;
    }

    body.innerHTML = '<div class="card card-flush" style="border-radius:var(--r-md)">'
      + '<div style="display:grid;grid-template-columns:1.6fr 80px 100px 110px 1.4fr auto;gap:var(--s-3-5);padding:var(--s-2-5) 16px;background:var(--canvas);font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">'
        + '<span>Driver</span>'
        + '<span class="u-right">Score</span>'
        + '<span class="u-right" title="Attendance points last 30d">Att. pts</span>'
        + '<span>Flags</span>'
        + '<span>Suggested action</span>'
        + '<span></span>'
      + '</div>'
      + rows.map(function(d){
        var comp = (window.attComputeDriver && window.RR_ATTENDANCE_POLICY) ? attComputeDriver(d, 30) : null;
        var points = comp ? comp.points.toFixed(1) : '0.0';
        var pointsCls = comp && comp.points >= (RR_ATTENDANCE_POLICY.thresholds.written.points) ? 'color:var(--red)'
                      : comp && comp.points >= (RR_ATTENDANCE_POLICY.thresholds.verbal.points) ? 'color:var(--amber)' : 'color:var(--text-muted)';
        var flags = [];
        if (comp && comp.counts.callout > 0) flags.push('<span class="flag attendance">Attendance</span>');
        if (comp && comp.counts.noshow > 0)  flags.push('<span class="flag attendance">No-show</span>');
        if ((d.score || 0) < 65) flags.push('<span class="flag scorecard">Scorecard</span>');
        if (window.isDriverSuspended && isDriverSuspended(d.id)) flags.push('<span class="flag" style="background:var(--red);color:#fff">Suspended</span>');
        if (flags.length === 0) flags.push('<span style="color:var(--text-subtle);font-size:var(--fs-xs);font-style:italic">none</span>');
        var base = perfBaseAction(d);
        var capped = _perfCap(base, ceiling);
        var wasCapped = capped !== base;
        var scoreClass = (d.score||0) < 65 ? 'tier-d' : (d.score||0) < 75 ? 'tier-c' : (d.score||0) < 85 ? 'tier-b' : 'tier-a';
        return '<div style="display:grid;grid-template-columns:1.6fr 80px 100px 110px 1.4fr auto;gap:var(--s-3-5);padding:var(--s-3) 16px;border-top:1px solid var(--border);align-items:center">'
          + '<div style="display:flex;align-items:center;gap:var(--s-2)">'
            + '<div class="avatar-sm ' + d.tier + '">' + d.id + '</div>'
            + '<div><div style="font-weight:600;font-size:var(--fs-md)">' + d.name + '</div>'
            + '<div class="u-xs-subtle">' + d.station + ' · ' + (d.tenureMonths || '?') + ' mo</div></div>'
          + '</div>'
          + '<div style="text-align:right;font-weight:700;font-size:var(--fs-base);font-variant-numeric:tabular-nums" class="' + scoreClass + '">' + (d.score || '—') + '</div>'
          + '<div style="text-align:right;font-weight:600;font-size:var(--fs-md);font-variant-numeric:tabular-nums;' + pointsCls + '">' + points + '</div>'
          + '<div style="display:flex;gap:var(--s-1);flex-wrap:wrap">' + flags.join('') + '</div>'
          + '<div>' + perfActionBadge(capped, wasCapped) + (wasCapped ? '<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:3px;line-height:1.3">Without cap: ' + (PERF_LABEL[base] || base) + '</div>' : '') + '</div>'
          + '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">'
            + (window.isDriverSuspended && isDriverSuspended(d.id)
                ? '<button class="btn btn-sm btn-primary" onclick="openReinstateModal(\'' + d.id + '\')">Reinstate</button>'
                : '<button class="btn btn-sm btn-primary" onclick="openCoachDrawer(\'' + d.name.replace(/\x27/g, "\\\x27") + '\',\'attendance\',\'Performance review · score ' + (d.score||0) + ' · ' + points + ' att. pts · suggested ' + (PERF_LABEL[capped] || capped) + '\')">Coach</button>')
            + (window.openHrFile ? '<button class="btn btn-sm" onclick="openHrFile(\'' + d.id + '\')">HR file</button>' : '')
          + '</div>'
        + '</div>';
      }).join('') + '</div>';

    // Update dashboard underperformer card count + msg
    var card = document.getElementById('underperf-card-count');
    var msg = document.getElementById('underperf-card-msg');
    var below = RR_DRIVERS.filter(function(d){ return (d.score || 0) < 75; });
    if (card) card.textContent = below.length + ' driver' + (below.length === 1 ? '' : 's');
    if (msg) {
      var names = below.slice(0, 5).map(function(d){ return d.name.split(' ').slice(-1)[0]; }).join(', ');
      msg.textContent = (below.length === 0
        ? 'Roster is clean — no drivers below score 75.'
        : names + (below.length > 5 ? ' + ' + (below.length - 5) + ' more' : '') + ' — score below 75. Review under Performance Management.');
    }
  }
  window.perfRender = perfRender;

  // Re-render when navigation lands on staffing
  if (typeof goto === 'function' && !goto._wrappedForPerf) {
    var _origGotoForPerf = goto;
    goto = function(view){
      _origGotoForPerf(view);
      if (view === 'staffing') setTimeout(perfRender, 60);
    };
    goto._wrappedForPerf = true;
  }

  document.addEventListener('DOMContentLoaded', perfRender);
  if (document.readyState !== 'loading') perfRender();

  // ═══════════════════════════════════════════════════════════════
  // LICENSE RENEWALS — auto-text + schedule flag + Insights panel
  // ═══════════════════════════════════════════════════════════════
  var RR_LICENSE_POLICY = {
    enabled: true,
    daysBefore: [30, 14],
    template: 'Hi {{name}} — your driver license expires in {{days}} days ({{date}}). Please renew ASAP and send a photo of your new license. Reply HELP if you need help. — Cardinal Logistics',
    notifyOwner: true,
    blockScheduling: true
  };
  var RR_LICENSE_REMINDERS = []; // {id, driverId, threshold, sentDate, expiryDate, channel:'sms'}
  var _licSeq = 0;

  function _daysUntil(iso){
    if (!iso) return Infinity;
    var d = new Date(iso + 'T12:00:00');
    return Math.ceil((d.getTime() - Date.now()) / 86400000);
  }
  function _expiryStatus(days){
    if (days < 0) return 'expired';
    if (days <= 14) return 'urgent';
    if (days <= 30) return 'soon';
    return 'ok';
  }
  function _expiryLabel(days){
    if (days < 0) return 'Expired ' + Math.abs(days) + 'd ago';
    if (days === 0) return 'Expires today';
    if (days === 1) return 'Expires tomorrow';
    return 'Expires in ' + days + 'd';
  }
  function _renderTemplate(tpl, vars){
    return tpl.replace(/\{\{(\w+)\}\}/g, function(_, k){ return vars[k] != null ? vars[k] : ''; });
  }

  // ─── DAILY SCHEDULER (simulated on load) ────────────────────────
  // Seeds reminders that "should have already fired" based on each driver's current
  // expiry date and the configured thresholds. In production this is a daily cron.
  function licSeedRemindersHistory(){
    RR_LICENSE_REMINDERS = [];
    if (!window.RR_DRIVERS) return;
    RR_DRIVERS.forEach(function(d){
      if (!d.licenseExpiry) return;
      var daysToExpiry = _daysUntil(d.licenseExpiry);
      RR_LICENSE_POLICY.daysBefore.forEach(function(threshold){
        // If we're past this threshold (i.e. days remaining <= threshold), it has fired
        if (daysToExpiry <= threshold) {
          var firedDaysAgo = threshold - daysToExpiry; // 0 = fired today
          _licSeq++;
          RR_LICENSE_REMINDERS.push({
            id: 'lic_' + _licSeq,
            driverId: d.id,
            threshold: threshold,
            sentDate: _isoFromNow(-firedDaysAgo),
            expiryDate: d.licenseExpiry,
            channel: 'sms'
          });
        }
      });
    });
  }

  function licFireRemindersToday(){
    // For any driver whose days-to-expiry equals a threshold today AND no reminder logged for that threshold yet, fire it.
    if (!RR_LICENSE_POLICY.enabled || !window.RR_DRIVERS) return [];
    var fired = [];
    RR_DRIVERS.forEach(function(d){
      if (!d.licenseExpiry) return;
      var daysToExpiry = _daysUntil(d.licenseExpiry);
      RR_LICENSE_POLICY.daysBefore.forEach(function(threshold){
        if (daysToExpiry !== threshold) return;
        var alreadyFired = RR_LICENSE_REMINDERS.some(function(r){
          return r.driverId === d.id && r.threshold === threshold && r.expiryDate === d.licenseExpiry;
        });
        if (alreadyFired) return;
        _licSeq++;
        var rem = {
          id: 'lic_' + _licSeq, driverId: d.id, threshold: threshold,
          sentDate: _isoFromNow(0), expiryDate: d.licenseExpiry, channel: 'sms'
        };
        RR_LICENSE_REMINDERS.push(rem);
        // Add to HR file (informational)
        if (window.RR_HR_EVENTS) {
          RR_HR_EVENTS.push({
            id: 'hr_lic_' + Date.now() + '_' + _licSeq,
            driverId: d.id,
            type: 'warning',
            severity: 'info',
            date: _isoFromNow(0),
            by: 'System (auto)',
            summary: 'License renewal reminder sent (' + threshold + 'd before expiry)',
            detail: _renderTemplate(RR_LICENSE_POLICY.template, { name: d.name.split(' ')[0], days: threshold, date: _fmtDate(d.licenseExpiry) }),
            links: { reminderId: rem.id },
            immutable: true,
            timestamp: Date.now()
          });
        }
        fired.push({ driver: d, threshold: threshold });
      });
    });
    if (fired.length > 0) {
      _toast('Auto-text sent to ' + fired.length + ' driver(s) re: license renewal');
    }
    return fired;
  }

  // ─── SETTINGS HANDLERS ──────────────────────────────────────────
  function licReadSettingsFromDom(){
    var en = document.getElementById('lic-enabled');
    if (!en) return;
    RR_LICENSE_POLICY.enabled = en.checked;
    var daysStr = (document.getElementById('lic-days').value || '').trim();
    var days = daysStr.split(/[, ]+/).map(function(s){ return parseInt(s, 10); }).filter(function(n){ return !isNaN(n) && n > 0; });
    if (days.length) RR_LICENSE_POLICY.daysBefore = days.sort(function(a, b){ return b - a; });
    RR_LICENSE_POLICY.template = document.getElementById('lic-template').value;
    RR_LICENSE_POLICY.notifyOwner = document.getElementById('lic-notify-owner').checked;
    RR_LICENSE_POLICY.blockScheduling = document.getElementById('lic-block-scheduling').checked;
  }
  function licWriteSettingsToDom(){
    var en = document.getElementById('lic-enabled'); if (!en) return;
    en.checked = RR_LICENSE_POLICY.enabled;
    document.getElementById('lic-days').value = RR_LICENSE_POLICY.daysBefore.join(', ');
    document.getElementById('lic-template').value = RR_LICENSE_POLICY.template;
    document.getElementById('lic-notify-owner').checked = RR_LICENSE_POLICY.notifyOwner;
    document.getElementById('lic-block-scheduling').checked = RR_LICENSE_POLICY.blockScheduling;
  }
  function licSaveSettings(){
    licReadSettingsFromDom();
    licSeedRemindersHistory();   // recompute history with new thresholds
    licApplyAll();
    _toast('License renewal settings saved');
  }
  function licResetSettings(){
    RR_LICENSE_POLICY = {
      enabled: true,
      daysBefore: [30, 14],
      template: 'Hi {{name}} — your driver license expires in {{days}} days ({{date}}). Please renew ASAP and send a photo of your new license. Reply HELP if you need help. — Cardinal Logistics',
      notifyOwner: true,
      blockScheduling: true
    };
    licWriteSettingsToDom();
    licSeedRemindersHistory();
    licApplyAll();
    _toast('Reset to defaults');
  }
  window.licSaveSettings = licSaveSettings;
  window.licResetSettings = licResetSettings;

  // ─── RENEWALS PANEL (Drivers → Insights) ────────────────────────
  function renderRenewalsPanel(){
    var body = document.getElementById('lic-renewals-body');
    if (!body || !window.RR_DRIVERS) return;
    var rows = RR_DRIVERS.map(function(d){
      return { driver: d, days: _daysUntil(d.licenseExpiry) };
    }).filter(function(r){ return r.days <= 60; })
      .sort(function(a, b){ return a.days - b.days; });

    var status = document.getElementById('lic-panel-status');
    var firedCount = RR_LICENSE_REMINDERS.filter(function(r){ return r.sentDate === _isoFromNow(0); }).length;
    if (status) {
      status.innerHTML = (firedCount > 0)
        ? '<span style="color:var(--accent-text)">●</span> ' + firedCount + ' auto-SMS sent today'
        : 'No auto-SMS due today · ' + RR_LICENSE_REMINDERS.length + ' total this cycle';
    }

    if (rows.length === 0) {
      body.innerHTML = '<div style="padding:var(--s-3);color:var(--text-subtle);font-size:var(--fs-md);font-style:italic">No drivers expiring in the next 60 days. ✓</div>';
      return;
    }

    body.innerHTML = '<div class="card card-flush" style="border-radius:var(--r-md)">'
      + '<div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1.2fr auto;gap:var(--s-3);padding:var(--s-2) 14px;background:var(--canvas);font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">'
      + '<span>Driver</span><span>License expires</span><span>Days remaining</span><span>Reminders sent</span><span></span>'
      + '</div>'
      + rows.map(function(r){
        var d = r.driver;
        var st = _expiryStatus(r.days);
        var color = st === 'expired' ? 'var(--red)' : st === 'urgent' ? 'var(--red)' : st === 'soon' ? 'var(--amber)' : 'var(--text-muted)';
        var bg = st === 'expired' ? '#FEE2E2' : st === 'urgent' ? '#FEE2E2' : st === 'soon' ? '#FEF3C7' : 'transparent';
        var sentReminders = RR_LICENSE_REMINDERS
          .filter(function(rem){ return rem.driverId === d.id && rem.expiryDate === d.licenseExpiry; })
          .sort(function(a, b){ return b.threshold - a.threshold; });
        var sentTxt = sentReminders.length === 0
          ? '<span class="u-subtle">none yet</span>'
          : sentReminders.map(function(rem){
              return '<span style="font-size:var(--fs-xs);color:var(--text-muted)" title="Sent ' + _fmtRel(rem.sentDate) + '">' + rem.threshold + 'd ✓</span>';
            }).join(' · ');
        return '<div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1.2fr auto;gap:var(--s-3);padding:var(--s-2-5) var(--s-3-5);border-top:1px solid var(--border);align-items:center;background:' + bg + '">'
          + '<div style="display:flex;align-items:center;gap:var(--s-2)"><div class="avatar-sm ' + d.tier + '">' + d.id + '</div><div><div style="font-weight:600;font-size:var(--fs-md)">' + d.name + '</div><div class="u-xs-subtle">' + d.station + '</div></div></div>'
          + '<div style="font-size:var(--fs-md);color:var(--text);font-variant-numeric:tabular-nums">' + _fmtDate(d.licenseExpiry) + '</div>'
          + '<div style="font-weight:600;font-size:var(--fs-md);color:' + color + '">' + _expiryLabel(r.days) + '</div>'
          + '<div style="display:flex;gap:var(--s-2);flex-wrap:wrap">' + sentTxt + '</div>'
          + '<div style="display:flex;gap:6px"><button class="btn btn-sm" onclick="licResendNow(\'' + d.id + '\')">Resend</button><button class="btn btn-sm btn-primary" onclick="licMarkRenewed(\'' + d.id + '\')">Mark renewed</button></div>'
          + '</div>';
      }).join('') + '</div>';
  }

  function licResendNow(driverId){
    var d = _findDriver && _findDriver(driverId);
    if (!d || !d.licenseExpiry) return;
    var days = _daysUntil(d.licenseExpiry);
    _licSeq++;
    var rem = { id: 'lic_' + _licSeq, driverId: d.id, threshold: 'manual', sentDate: _isoFromNow(0), expiryDate: d.licenseExpiry, channel: 'sms' };
    RR_LICENSE_REMINDERS.push(rem);
    if (window.RR_HR_EVENTS) {
      RR_HR_EVENTS.push({
        id: 'hr_lic_m_' + Date.now(), driverId: d.id, type: 'warning', severity: 'info',
        date: _isoFromNow(0), by: 'You (Owner)',
        summary: 'License renewal reminder sent manually',
        detail: _renderTemplate(RR_LICENSE_POLICY.template, { name: d.name.split(' ')[0], days: days, date: _fmtDate(d.licenseExpiry) }),
        links: { reminderId: rem.id }, immutable: true, timestamp: Date.now()
      });
    }
    _toast('SMS sent to ' + d.name);
    renderRenewalsPanel();
  }
  window.licResendNow = licResendNow;

  function licMarkRenewed(driverId){
    var d = _findDriver && _findDriver(driverId);
    if (!d) return;
    // Move expiry out 1 year (typical CDL renewal)
    d.licenseExpiry = _isoFromNow(365);
    if (window.RR_HR_EVENTS) {
      RR_HR_EVENTS.push({
        id: 'hr_lic_r_' + Date.now(), driverId: d.id, type: 'reinstate', severity: 'info',
        date: _isoFromNow(0), by: 'You (Owner)',
        summary: 'License renewed · new expiry on file',
        detail: 'New license uploaded and verified. New expiry: ' + _fmtDate(d.licenseExpiry) + '. Reminder cycle reset.',
        links: {}, immutable: true, timestamp: Date.now()
      });
    }
    // Reset reminders for this driver
    RR_LICENSE_REMINDERS = RR_LICENSE_REMINDERS.filter(function(r){ return r.driverId !== d.id; });
    _toast(d.name + ' license renewed · new expiry ' + _fmtDate(d.licenseExpiry));
    licApplyAll();
  }
  window.licMarkRenewed = licMarkRenewed;

  // ─── SCHEDULE FLAG (driver row badges in week grid) ─────────────
  function licApplyToSchedule(){
    var rows = document.querySelectorAll('#sched-sub-week .cal-row-label');
    if (!rows.length) return;
    // Determine the schedule's visible week (read from header label)
    var wkLabelEl = document.querySelector('#sched-sub-week .sched-week-label');
    // Default: assume the visible week is "today + 7 days"
    var weekStart = _isoFromNow(0);
    var weekEnd = _isoFromNow(7);
    rows.forEach(function(row){
      var nameEl = row.querySelector('.cal-row-label-name');
      if (!nameEl) return;
      var driver = _findDriver && _findDriver(nameEl.textContent.trim());
      if (!driver || !driver.licenseExpiry) return;
      // Remove any previous badge
      var existing = row.querySelector('.lic-sched-badge');
      if (existing) existing.remove();
      var days = _daysUntil(driver.licenseExpiry);
      // Flag if expiry is within the visible 7-day window
      if (driver.licenseExpiry >= weekStart && driver.licenseExpiry <= weekEnd) {
        var badge = document.createElement('div');
        badge.className = 'lic-sched-badge';
        badge.title = 'License expires ' + _fmtDate(driver.licenseExpiry) + ' — auto-block-scheduling ' + (RR_LICENSE_POLICY.blockScheduling ? 'ON' : 'OFF');
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:var(--s-1);background:var(--red-soft);color:var(--red-dark);font-size:var(--fs-xs);font-weight:700;padding:2px 6px;border-radius:var(--r-md);margin-top:4px;cursor:help';
        badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="width:10px;height:10px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>License expires ' + _fmtDate(driver.licenseExpiry);
        var inner = row.querySelector(':scope > div:last-child') || row.lastElementChild;
        if (inner && inner.classList && !inner.classList.contains('avatar-sm')) inner.appendChild(badge);
        else row.appendChild(badge);
      }
    });
    // Also: top-of-week banner if anyone expires this week
    var anchor = document.querySelector('#sched-sub-week');
    if (!anchor) return;
    var existingBanner = document.getElementById('sched-license-banner');
    var inWeek = RR_DRIVERS.filter(function(d){
      return d.licenseExpiry && d.licenseExpiry >= weekStart && d.licenseExpiry <= weekEnd;
    });
    if (inWeek.length === 0) {
      if (existingBanner) existingBanner.remove();
      return;
    }
    if (!existingBanner) {
      existingBanner = document.createElement('div');
      existingBanner.id = 'sched-license-banner';
      existingBanner.style.cssText = 'background:var(--amber-soft);border:1px solid var(--amber-border);color:var(--amber-dark);border-radius:8px;padding:var(--s-2-5) var(--s-3-5);margin-bottom:var(--s-3);font-size:var(--fs-md);display:flex;align-items:center;gap:var(--s-2-5)';
      // Insert AFTER suspended banner if present, else at top
      var susBanner = document.getElementById('sched-suspended-banner');
      if (susBanner) susBanner.parentNode.insertBefore(existingBanner, susBanner.nextSibling);
      else anchor.insertBefore(existingBanner, anchor.firstChild);
    }
    var names = inWeek.map(function(d){ return d.name + ' (' + _fmtDate(d.licenseExpiry) + ')'; }).join(', ');
    existingBanner.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>'
      + '<div style="flex:1"><strong>' + inWeek.length + ' license(s) expire this week:</strong> ' + names + (RR_LICENSE_POLICY.blockScheduling ? ' · scheduling will be blocked past expiry date' : '') + '</div>'
      + '<button class="btn btn-sm" onclick="goto(\'drivers\');setTimeout(function(){drSub(\'insights\');document.getElementById(\'lic-renewals-panel\').scrollIntoView({behavior:\'smooth\'});},80)" style="background:#fff;color:var(--amber-dark);border-color:var(--amber-border)">View renewals</button>';
  }

  // ─── ROSTER INDICATOR (small license pill on rows expiring ≤30d) ──
  function licApplyToRoster(){
    var tbody = document.querySelector('#dr-sub-roster .table tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(function(tr){
      var nameEl = tr.querySelector('.cell-name');
      if (!nameEl) return;
      var existing = tr.querySelector('.lic-roster-pill');
      if (existing) existing.remove();
      var driver = _findDriver && _findDriver(nameEl.textContent.trim());
      if (!driver || !driver.licenseExpiry) return;
      var days = _daysUntil(driver.licenseExpiry);
      if (days > 30) return;
      var pill = document.createElement('span');
      pill.className = 'lic-roster-pill';
      var st = _expiryStatus(days);
      var bg = st === 'expired' || st === 'urgent' ? '#FEE2E2' : '#FEF3C7';
      var fg = st === 'expired' || st === 'urgent' ? 'var(--red-dark)' : 'var(--amber-dark)';
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:3px;font-size:var(--fs-xs);font-weight:600;padding:2px 6px;border-radius:var(--r-md);margin-left:6px;background:' + bg + ';color:' + fg;
      pill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="width:9px;height:9px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>License ' + _expiryLabel(days);
      pill.title = 'License expires ' + _fmtDate(driver.licenseExpiry);
      var nameWrap = tr.querySelector('.cell-driver');
      if (nameWrap) nameWrap.appendChild(pill);
    });
  }

  // ─── APPLY ALL ──────────────────────────────────────────────────
  function licApplyAll(){
    licApplyToSchedule();
    licApplyToRoster();
    renderRenewalsPanel();
  }
  window.licApplyAll = licApplyAll;

  // ─── HOOKS ──────────────────────────────────────────────────────
  if (typeof goto === 'function' && !goto._wrappedForLicense) {
    var _origGotoForLic = goto;
    goto = function(view){ _origGotoForLic(view); setTimeout(licApplyAll, 50); };
    goto._wrappedForLicense = true;
  }
  if (typeof drSub === 'function' && !drSub._wrappedForLicense) {
    var _origDrSubForLic = drSub;
    drSub = function(sub){ _origDrSubForLic(sub); setTimeout(licApplyAll, 50); };
    drSub._wrappedForLicense = true;
  }

  // ─── INIT (seed reminder history → fire today's due reminders → render) ──
  function licInit(){
    licWriteSettingsToDom();        // hydrate settings UI from policy
    licSeedRemindersHistory();      // back-fill all should-have-fired entries
    licFireRemindersToday();        // fire any threshold hit today (toast)
    licApplyAll();
  }
  document.addEventListener('DOMContentLoaded', licInit);
  if (document.readyState !== 'loading') licInit();

  // ═══════════════════════════════════════════════════════════════
  // OKAMI DAILY PLANNING — daily route targets + cushion + recommendation
  //   - First 3 weeks of the 13-week OKAMI strip get a daily breakdown
  //   - Cushion (over-plan) configurable as % or headcount per week
  //   - Recommendation pulled from RR_ATTENDANCE_LOG callout/no-show rate
  //   - Daily plan + cushion drive the Schedule's daily shift count
  // ═══════════════════════════════════════════════════════════════

  // Inject scoped CSS for new OKAMI elements
  (function _injectOkamiDailyCss(){
    var css = ''
      + '.okami-expand-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;background:var(--canvas);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text-muted);cursor:pointer;margin-right:6px;vertical-align:middle;padding:0;transition:transform var(--t-smooth),background .15s}'
      + '.okami-expand-btn:hover{background:var(--surface);color:var(--text)}'
      + '.okami-expand-btn svg{width:11px;height:11px}'
      + '.okami-expand-btn.expanded{transform:rotate(90deg);background:var(--accent);color:#fff;border-color:var(--accent)}'
      + 'tr.okami-detail{display:none}'
      + 'tr.okami-detail.open{display:table-row}'
      + 'tr.okami-detail > td{padding:0 !important;background:var(--canvas);border-bottom:2px solid var(--border)}'
      + '.okami-daily-panel{padding:var(--s-4) var(--s-4);display:grid;grid-template-columns:1fr 280px;gap:var(--s-4)}'
      + '.okami-daily-grid{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}'
      + '.okami-daily-grid-head{display:grid;grid-template-columns:120px repeat(7,1fr);background:var(--canvas);border-bottom:1px solid var(--border);font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase}'
      + '.okami-daily-grid-head > div{padding:var(--s-2) 6px;text-align:center}'
      + '.okami-daily-grid-head > div:first-child{text-align:left;padding-left:14px}'
      + '.okami-daily-row{display:grid;grid-template-columns:120px repeat(7,1fr);border-top:1px solid var(--border);align-items:center}'
      + '.okami-daily-row:first-child{border-top:0}'
      + '.okami-daily-row .okami-daily-label{padding:var(--s-2-5) var(--s-3-5);font-size:var(--fs-sm);color:var(--text-muted);font-weight:500}'
      + '.okami-daily-cell{padding:var(--s-2) 6px;text-align:center;border-left:1px solid var(--border)}'
      + '.okami-daily-cell input{width:100%;max-width:60px;padding:6px 4px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);text-align:center;font:inherit;font-size:var(--fs-md);font-weight:600;font-variant-numeric:tabular-nums;color:var(--text)}'
      + '.okami-daily-cell input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft-strong)}'
      + '.okami-daily-cell-shifts{font-size:var(--fs-md);font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}'
      + '.okami-daily-cell-shifts .frac{color:var(--text-subtle);font-weight:500;font-size:var(--fs-xs);display:block;margin-top:1px}'
      + '.okami-daily-row.is-today{background:#EFF6FF}'
      + '.okami-cushion-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:var(--s-3-5);display:flex;flex-direction:column;gap:var(--s-2-5)}'
      + '.okami-cushion-card h4{margin:0;font-size:var(--fs-sm);font-weight:600;color:var(--text);letter-spacing:.04em;text-transform:uppercase}'
      + '.okami-cushion-mode{display:flex;background:var(--canvas);border-radius:var(--r-md);padding:3px;gap:2px}'
      + '.okami-cushion-mode button{flex:1;border:0;background:transparent;font:inherit;font-size:var(--fs-sm);font-weight:500;color:var(--text-muted);padding:6px 8px;border-radius:var(--r-sm);cursor:pointer}'
      + '.okami-cushion-mode button.active{background:var(--surface);color:var(--text);font-weight:600;box-shadow:var(--shadow-sm)}'
      + '.okami-cushion-input-row{display:flex;align-items:center;gap:var(--s-2)}'
      + '.okami-cushion-input-row input{flex:1;padding:var(--s-2) var(--s-2-5);border:1px solid var(--border);border-radius:var(--r-md);font:inherit;font-size:var(--fs-base);font-weight:600;font-variant-numeric:tabular-nums;text-align:center}'
      + '.okami-cushion-input-row input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft-strong)}'
      + '.okami-cushion-input-row .unit{font-size:var(--fs-sm);color:var(--text-muted);font-weight:500;min-width:54px}'
      + '.okami-recommend{background:var(--accent-soft);color:var(--accent-text);border-radius:var(--r-md);padding:var(--s-2) var(--s-2-5);font-size:var(--fs-xs);line-height:1.5}'
      + '.okami-recommend strong{color:var(--accent-text);font-weight:700}'
      + '.okami-recommend .apply-link{display:inline-block;margin-top:6px;font-size:var(--fs-xs);font-weight:600;color:#fff;background:var(--accent);padding:var(--s-1) 10px;border-radius:var(--r-md);cursor:pointer;border:0;font-family:inherit}'
      + '.okami-recommend .apply-link:hover{background:var(--indigo)}'
      + '.okami-totals{display:flex;justify-content:space-between;align-items:baseline;font-size:var(--fs-xs);color:var(--text-subtle);padding-top:6px;border-top:1px solid var(--border)}'
      + '.okami-totals strong{color:var(--text);font-weight:700;font-size:var(--fs-md);font-variant-numeric:tabular-nums}'
      // Schedule day-header shift count (driven by OKAMI daily targets + cushion)
      + '.cal-cell-head .day-shifts{display:block;font-size:var(--fs-xs);font-weight:600;color:var(--accent-text);margin-top:3px;letter-spacing:0;text-transform:none}'
      + '.cal-cell-head:not(.today) .day-shifts{color:var(--text-muted)}'
      // Lineup quality KPI per day header
      + '.cal-cell-head .day-quality{display:inline-flex;align-items:center;gap:3px;font-size:var(--fs-xs);font-weight:700;padding:1px 6px;border-radius:var(--r-md);margin-top:3px;letter-spacing:0;text-transform:none}'
      + '.cal-cell-head .day-quality.q-good{background:var(--green-soft);color:var(--green)}'
      + '.cal-cell-head .day-quality.q-mid{background:var(--amber-soft);color:var(--amber)}'
      + '.cal-cell-head .day-quality.q-low{background:var(--red-soft);color:var(--red-dark)}'
      // Driver-score indicator on schedule rows
      + '.cal-row-score{display:inline-flex;align-items:center;gap:var(--s-1);margin-top:3px;padding:1px 6px;border-radius:var(--r-sm);font-size:var(--fs-xs);font-weight:700;letter-spacing:0;text-transform:none}'
      + '.cal-row-score.s-tier-a{background:var(--green-soft);color:var(--green)}'
      + '.cal-row-score.s-tier-b{background:var(--accent-soft);color:var(--accent-text)}'
      + '.cal-row-score.s-tier-c{background:var(--amber-soft);color:var(--amber)}'
      + '.cal-row-score.s-tier-d{background:var(--red-soft);color:var(--red-dark)}'
      + '.cal-row-label.row-low-score::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--red);border-radius:var(--r-sm) 0 0 3px}'
      + '.cal-row-label{position:relative}'
      // Pool sort toggle
      + '.pool-sort-row{display:flex;gap:var(--s-1);margin:0 var(--s-3) 8px}'
      + '.pool-sort-row{display:flex;gap:0;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden}'
      + '.pool-sort-btn{flex:1;background:var(--canvas);border:0;color:var(--text-muted);font:inherit;font-size:var(--fs-xs);font-weight:600;height:24px;padding:0 8px;cursor:pointer}'
      + '.pool-sort-btn+.pool-sort-btn{border-left:1px solid var(--border)}'
      + '.pool-sort-btn.active{background:var(--surface);color:var(--text)}'
      + '.pool-driver .pool-driver-score{display:inline-block;font-size:var(--fs-xs);font-weight:700;padding:1px 5px;border-radius:var(--r-sm);margin-left:6px;font-variant-numeric:tabular-nums}'
      // VTO suggestion banner in check-in
      + '#ci-vto-suggest{background:#F0F9FF;border:1px solid var(--accent-border);color:#0C4A6E;border-radius:8px;padding:var(--s-2-5) var(--s-3-5);margin:0 0 var(--s-3) 0;font-size:var(--fs-md);display:flex;align-items:center;gap:var(--s-2-5)}'
      + '#ci-vto-suggest .vto-chips{display:flex;gap:var(--s-1);flex-wrap:wrap}'
      + '#ci-vto-suggest .vto-chip{display:inline-flex;align-items:center;gap:var(--s-1);background:#fff;border:1px solid var(--accent-border);color:#0369A1;padding:2px 8px;border-radius:var(--r-md);font-size:var(--fs-xs);font-weight:600;cursor:pointer}'
      + '#ci-vto-suggest .vto-chip:hover{background:#E0F2FE}'
      + '.checkin-row.vto-suggested{box-shadow:inset 4px 0 0 var(--sky)}';
    var s = document.createElement('style');
    s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  })();

  // ─── STATE ──────────────────────────────────────────────────────
  // Per-week daily plan + cushion. Indexed by OKAMI week index (0 = W19).
  // Only weeks 0..2 (next 3 weeks) get a daily breakdown.
  var RR_OKAMI_DAILY = {
    0: {
      weekStart: '2026-05-01', weekLabel: 'W19', dateLabel: 'May 1–7',
      // Default daily targets sum to ~38 (the W19 routes-max value); shape mirrors typical Amazon volume curve
      daily: { mon: 35, tue: 38, wed: 38, thu: 40, fri: 38, sat: 28, sun: 18 },
      cushionMode: 'percent',  // 'percent' | 'count'
      cushionValue: 10
    },
    1: {
      weekStart: '2026-05-08', weekLabel: 'W20', dateLabel: 'May 8–14',
      daily: { mon: 38, tue: 40, wed: 40, thu: 42, fri: 42, sat: 30, sun: 20 },
      cushionMode: 'percent',
      cushionValue: 10
    },
    2: {
      weekStart: '2026-05-15', weekLabel: 'W21', dateLabel: 'May 15–21',
      daily: { mon: 40, tue: 42, wed: 42, thu: 44, fri: 44, sat: 32, sun: 22 },
      cushionMode: 'percent',
      cushionValue: 10
    }
  };
  var RR_OKAMI_DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
  var RR_OKAMI_DAY_LABELS = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };

  // ─── RECOMMENDATION ENGINE ──────────────────────────────────────
  // Pulls callout + no-show rate from RR_ATTENDANCE_LOG; recommends a cushion
  // % so that historical absence doesn't put you below your daily route target.
  function okamiRecommendCushion(){
    if (!window.RR_ATTENDANCE_LOG || !window.RR_DRIVERS) {
      return { percent: 8, source: 'No data — using DSP default' };
    }
    var windowDays = 30;
    var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
    var absences = 0;
    RR_ATTENDANCE_LOG.forEach(function(e){
      if (e.exempt) return;
      if (new Date(e.date + 'T00:00:00') < cutoff) return;
      if (e.type === 'callout' || e.type === 'noshow') absences++;
    });
    var totalScheduled = RR_DRIVERS.reduce(function(s, d){ return s + (d.scheduled30 || 22); }, 0);
    if (totalScheduled === 0) return { percent: 8, source: 'No scheduled shifts in window' };
    var absenceRate = absences / totalScheduled;
    // Recommended = absence rate × 1.5 safety factor, floor 5%, ceiling 20%
    var recommended = Math.max(5, Math.min(20, Math.round(absenceRate * 100 * 1.5)));
    return {
      percent: recommended,
      absences: absences,
      totalScheduled: totalScheduled,
      absenceRate: absenceRate,
      source: absences + ' callout(s) + no-show(s) over ' + totalScheduled + ' scheduled shifts last ' + windowDays + 'd = '
              + (absenceRate * 100).toFixed(1) + '% absence rate · recommended cushion ' + recommended + '% (1.5× safety)'
    };
  }

  // ─── COMPUTATIONS ───────────────────────────────────────────────
  function okamiCushionShiftsForRoutes(routes, cushionMode, cushionValue){
    if (cushionMode === 'count') return routes + (cushionValue || 0);
    return Math.round(routes * (1 + (cushionValue || 0) / 100));
  }
  function okamiWeekTotalRoutes(weekIdx){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return 0;
    return RR_OKAMI_DAY_KEYS.reduce(function(s, k){ return s + (w.daily[k] || 0); }, 0);
  }
  function okamiWeekTotalShifts(weekIdx){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return 0;
    return RR_OKAMI_DAY_KEYS.reduce(function(s, k){
      return s + okamiCushionShiftsForRoutes(w.daily[k] || 0, w.cushionMode, w.cushionValue);
    }, 0);
  }
  function okamiWeekMaxRoutes(weekIdx){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return 0;
    return Math.max.apply(null, RR_OKAMI_DAY_KEYS.map(function(k){ return w.daily[k] || 0; }));
  }

  // ─── RENDER DAILY PANEL ─────────────────────────────────────────
  // Mockup drill-down panel removed. live.js owns the OKAMI drill-down
  // via window.renderOkamiDailyPanel — clean per-day grid, no cushion
  // card, no Routes (max) overwrite.
  function okamiRenderDailyPanel(weekIdx){
    if (typeof window.renderOkamiDailyPanel === 'function') {
      window.renderOkamiDailyPanel(weekIdx);
    }
  }

  // ─── INTERACTIONS ───────────────────────────────────────────────
  function okamiToggleDaily(weekIdx){
    var detail = document.getElementById('okami-detail-' + weekIdx);
    var btn = document.querySelector('#okami-row-' + weekIdx + ' .okami-expand-btn');
    if (!detail || !btn) return;
    var isOpen = detail.classList.toggle('open');
    btn.classList.toggle('expanded', isOpen);
    if (isOpen) okamiRenderDailyPanel(weekIdx);
  }
  window.okamiToggleDaily = okamiToggleDaily;

  function okamiUpdateDaily(weekIdx, dayKey, value){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return;
    var n = parseInt(value, 10); if (isNaN(n) || n < 0) n = 0;
    w.daily[dayKey] = n;
    okamiRenderDailyPanel(weekIdx);
    okamiRenderScheduleDayHeaders();
  }
  window.okamiUpdateDaily = okamiUpdateDaily;

  function okamiSetCushionMode(weekIdx, mode){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return;
    if (mode === w.cushionMode) return;
    // Sensible defaults when switching
    if (mode === 'percent') w.cushionValue = 10;
    else w.cushionValue = Math.max(2, Math.round(okamiWeekTotalRoutes(weekIdx) * 0.10 / 7));
    w.cushionMode = mode;
    okamiRenderDailyPanel(weekIdx);
    okamiRenderScheduleDayHeaders();
  }
  window.okamiSetCushionMode = okamiSetCushionMode;

  function okamiSetCushionValue(weekIdx, value){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return;
    var n = parseFloat(value); if (isNaN(n) || n < 0) n = 0;
    w.cushionValue = n;
    okamiRenderDailyPanel(weekIdx);
    okamiRenderScheduleDayHeaders();
  }
  window.okamiSetCushionValue = okamiSetCushionValue;

  function okamiApplyRecommended(weekIdx){
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return;
    var rec = okamiRecommendCushion();
    w.cushionMode = 'percent';
    w.cushionValue = rec.percent;
    okamiRenderDailyPanel(weekIdx);
    okamiRenderScheduleDayHeaders();
    _toast('Applied recommended cushion: ' + rec.percent + '%');
  }
  window.okamiApplyRecommended = okamiApplyRecommended;

  function okamiApplyToSchedule(weekIdx){
    okamiRenderScheduleDayHeaders();
    _toast('Daily plan applied · Schedule will populate ' + okamiWeekTotalShifts(weekIdx) + ' shifts');
  }
  window.okamiApplyToSchedule = okamiApplyToSchedule;

  // ─── SCHEDULE DAY HEADERS — populate "shifts needed" per day from OKAMI ──
  // The schedule week (Tue→Mon) shows day numbers; we add an OKAMI-derived
  // shift count under each day header, plus update the week subtitle's
  // shifts-needed denominator.
  function okamiRenderScheduleDayHeaders(){
    var heads = document.querySelectorAll('#sched-sub-week .cal-cell-head');
    if (!heads || heads.length < 2) return;
    var weekIdx = 0; // current week = W19
    var w = RR_OKAMI_DAILY[weekIdx]; if (!w) return;

    // The schedule grid renders Tue, Wed, Thu, Fri, Sat, Sun, Mon
    // Map each schedule position to the matching OKAMI day key
    var schedDayOrder = ['tue','wed','thu','fri','sat','sun','mon'];
    var totalShifts = 0;

    // heads[0] is the "Driver" column; days start at heads[1]
    schedDayOrder.forEach(function(dayKey, i){
      var head = heads[i + 1];
      if (!head) return;
      var routes = w.daily[dayKey] || 0;
      var shifts = okamiCushionShiftsForRoutes(routes, w.cushionMode, w.cushionValue);
      totalShifts += shifts;
      var existing = head.querySelector('.day-shifts');
      if (existing) existing.remove();
      if (shifts > 0) {
        var span = document.createElement('span');
        span.className = 'day-shifts';
        span.textContent = shifts + ' shifts';
        span.title = routes + ' route(s) + ' + (w.cushionMode === 'percent' ? w.cushionValue + '% cushion' : '+' + w.cushionValue + '/day cushion') + ' = ' + shifts + ' shifts to schedule';
        head.appendChild(span);
      }
    });

    // Update week subtitle's "X/Y shifts" denominator with OKAMI total
    var sub = document.querySelector('#sched-sub-week .sched-week-sub');
    if (sub) {
      // Existing pattern: "Cycle 14 · 82% filled (37/45 shifts) · OKAMI Week 19 · …"
      // Pull current "filled" number, replace denominator with totalShifts, recompute %
      var html = sub.innerHTML;
      var match = html.match(/(\d+)% filled \((\d+)\/(\d+) shifts\)/);
      if (match) {
        var filled = parseInt(match[2], 10);
        var pct = totalShifts > 0 ? Math.round(filled / totalShifts * 100) : 0;
        var newFilled = pct + '% filled (' + filled + '/' + totalShifts + ' shifts)';
        sub.innerHTML = html.replace(/\d+% filled \(\d+\/\d+ shifts\)/, newFilled);
      }
    }
  }
  window.okamiRenderScheduleDayHeaders = okamiRenderScheduleDayHeaders;

  // Re-render whenever schedule view becomes active
  if (typeof goto === 'function' && !goto._wrappedForOkami) {
    var _origGotoForOkami = goto;
    goto = function(view){
      _origGotoForOkami(view);
      if (view === 'schedule') setTimeout(okamiRenderScheduleDayHeaders, 50);
    };
    goto._wrappedForOkami = true;
  }

  // Initial paint (in case schedule is the first view shown)
  document.addEventListener('DOMContentLoaded', okamiRenderScheduleDayHeaders);
  if (document.readyState !== 'loading') okamiRenderScheduleDayHeaders();

  // ═══════════════════════════════════════════════════════════════
  // SCORE-AWARE SCHEDULING — visual flags + driver-pool sort + VTO
  //   - Color the cal-row-label score (A/B/C/D) so dispatchers see who
  //     to nudge first when there's discretion
  //   - Compute Lineup Quality (avg score of scheduled drivers per day)
  //     and surface as a small badge in the day header
  //   - Driver pool gets a Score↔Alphabetical sort toggle
  //   - Check-in flow gets a VTO suggestion banner: when over-scheduled
  //     today (per OKAMI), suggest VTO offers bottom-up by score
  //
  //   Hard rule (per design discussion): score never *blocks* a driver
  //   from being scheduled — only orders positive choices. See PR
  //   discussion for legal reasoning.
  // ═══════════════════════════════════════════════════════════════

  function _scoreBand(score){
    if (score >= 85) return { tier: 'tier-a', label: 'Top' };
    if (score >= 75) return { tier: 'tier-b', label: 'Strong' };
    if (score >= 65) return { tier: 'tier-c', label: 'Coachable' };
    return { tier: 'tier-d', label: 'At risk' };
  }

  // ─── Schedule grid: per-row score badge + lineup quality per day ──
  function schedScoreOverlay(){
    if (!window.RR_DRIVERS) return;
    var rows = document.querySelectorAll('#sched-sub-week .cal-grid:not(.head)');
    if (!rows.length) return;

    // 7 day positions: Tue, Wed, Thu, Fri, Sat, Sun, Mon
    var dayAgg = [0,0,0,0,0,0,0].map(function(){ return { sum:0, count:0 }; });

    rows.forEach(function(row){
      var labelEl = row.querySelector('.cal-row-label');
      var nameEl = row.querySelector('.cal-row-label-name');
      if (!labelEl || !nameEl) return;
      var driver = RR_DRIVERS.find(function(d){ return d.name === nameEl.textContent.trim(); });
      if (!driver || typeof driver.score !== 'number') return;

      // Add or update the score badge in the row label
      var existingBadge = labelEl.querySelector('.cal-row-score');
      if (existingBadge) existingBadge.remove();
      labelEl.classList.toggle('row-low-score', driver.score < 65);
      var band = _scoreBand(driver.score);
      var inner = labelEl.querySelector(':scope > div:last-child') || labelEl.lastElementChild;
      if (inner && !inner.classList.contains('avatar-sm')) {
        var badge = document.createElement('span');
        badge.className = 'cal-row-score s-' + band.tier;
        badge.textContent = driver.score + ' · ' + band.label;
        badge.title = driver.name + ' · score ' + driver.score
          + (driver.score < 65 ? ' (bottom band — flagged for coaching)' : '')
          + (driver.score >= 85 ? ' (top performer — favorable assignment)' : '');
        inner.appendChild(badge);
      }

      // Walk the 7 day cells; count this driver toward each day's avg
      // when the cell has a real shift (not Off, not PTO).
      var children = row.children;
      // children[0] is the label, [1..7] are day cells
      for (var i = 1; i <= 7 && i < children.length; i++) {
        var cell = children[i];
        var chip = cell.querySelector('.shift-chip');
        if (!chip) continue;
        if (chip.classList.contains('off')) continue;
        if (chip.classList.contains('timeoff')) continue;
        var dayIdx = i - 1;
        if (dayAgg[dayIdx]) {
          dayAgg[dayIdx].sum += driver.score;
          dayAgg[dayIdx].count += 1;
        }
      }
    });

    // Render the lineup quality badge in each day header
    var heads = document.querySelectorAll('#sched-sub-week .cal-cell-head');
    // heads[0] is "Driver" col; heads[1..7] are day cells
    dayAgg.forEach(function(agg, idx){
      var head = heads[idx + 1];
      if (!head) return;
      var existing = head.querySelector('.day-quality');
      if (existing) existing.remove();
      if (agg.count === 0) return;
      var avg = Math.round(agg.sum / agg.count);
      var qClass = avg >= 80 ? 'q-good' : avg >= 70 ? 'q-mid' : 'q-low';
      var span = document.createElement('span');
      span.className = 'day-quality ' + qClass;
      span.textContent = '⌀ ' + avg;
      span.title = 'Lineup quality — average score of ' + agg.count + ' driver(s) scheduled this day';
      head.appendChild(span);
    });
  }
  window.schedScoreOverlay = schedScoreOverlay;

  // ─── Driver pool: Score ↔ Alphabetical sort ─────────────────────
  // Score sort uses tier classes on the avatar (a > b > c > d).
  function poolInjectSortToggle(){
    var pool = document.querySelector('.driver-pool');
    if (!pool || pool.dataset.sortInjected === '1') return;
    var head = pool.querySelector('.pool-head');
    if (!head) return;
    pool.dataset.sortInjected = '1';
    var row = document.createElement('div');
    row.className = 'pool-sort-row';
    row.innerHTML = ''
      + '<button class="pool-sort-btn active" data-sort="score" onclick="poolSort(\'score\')" title="Highest score first">Score</button>'
      + '<button class="pool-sort-btn" data-sort="alpha" onclick="poolSort(\'alpha\')" title="Alphabetical">A–Z</button>';
    head.parentNode.insertBefore(row, head.nextSibling.nextSibling); // after pool-head + pool-search

    // Initial sort
    poolSort('score');
  }
  function poolSort(mode){
    var pool = document.querySelector('.driver-pool');
    if (!pool) return;
    pool.querySelectorAll('.pool-sort-btn').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-sort') === mode);
    });
    var section = pool.querySelector('.pool-section-label') ? pool.querySelector('.pool-section-label').parentNode : null;
    if (!section) return;
    var drivers = Array.from(section.querySelectorAll('.pool-driver'));
    if (mode === 'alpha') {
      drivers.sort(function(a, b){
        var an = (a.querySelector('.pool-driver-name') || {}).textContent || '';
        var bn = (b.querySelector('.pool-driver-name') || {}).textContent || '';
        return an.localeCompare(bn);
      });
    } else {
      // Score: A > B > C > D, fall back to alpha within tier
      var tierOrder = { 'tier-a':0, 'tier-b':1, 'tier-c':2, 'tier-d':3 };
      drivers.sort(function(a, b){
        var aTier = (a.querySelector('.avatar-sm') || {}).className || '';
        var bTier = (b.querySelector('.avatar-sm') || {}).className || '';
        var aRank = 9, bRank = 9;
        Object.keys(tierOrder).forEach(function(k){ if (aTier.indexOf(k) >= 0) aRank = tierOrder[k]; });
        Object.keys(tierOrder).forEach(function(k){ if (bTier.indexOf(k) >= 0) bRank = tierOrder[k]; });
        if (aRank !== bRank) return aRank - bRank;
        var an = (a.querySelector('.pool-driver-name') || {}).textContent || '';
        var bn = (b.querySelector('.pool-driver-name') || {}).textContent || '';
        return an.localeCompare(bn);
      });
    }
    drivers.forEach(function(el){ section.appendChild(el); });
  }
  window.poolSort = poolSort;

  // ─── VTO suggestion banner on check-in ──────────────────────────
  // Shows when today is over-scheduled (OKAMI cushion ≥ shifts > today's
  // routes). Suggested candidates are the bottom-N by score (positive
  // selection — get-the-day-off, not deny-work).
  function ciRenderVtoSuggestion(){
    if (!window.RR_DRIVERS || !window.RR_OKAMI_DAILY) return;
    var anchor = document.querySelector('#view-checkin .checkin-list');
    if (!anchor) return;
    var existing = document.getElementById('ci-vto-suggest');
    if (existing) existing.remove();

    // Today = Tue in the demo schedule (W19, day 0)
    var w = RR_OKAMI_DAILY[0];
    if (!w) return;
    var routes = w.daily.tue || 0;
    var shifts = okamiCushionShiftsForRoutes(routes, w.cushionMode, w.cushionValue);
    var surplus = shifts - routes;
    if (surplus <= 0) return; // No over-schedule, no VTO suggestion

    // Bottom-N by score from the visible check-in roster
    var visibleNames = Array.from(document.querySelectorAll('#view-checkin .checkin-row .checkin-driver-name')).map(function(el){ return el.textContent.trim(); });
    var visibleDrivers = RR_DRIVERS.filter(function(d){ return visibleNames.indexOf(d.name) >= 0; });
    if (!visibleDrivers.length) return;
    var candidates = visibleDrivers.slice().sort(function(a, b){ return (a.score||0) - (b.score||0); }).slice(0, surplus);

    var banner = document.createElement('div');
    banner.id = 'ci-vto-suggest';
    banner.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0;color:var(--sky)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 13 11 15 15 11"/></svg>'
      + '<div style="flex:1"><strong>Over-scheduled by ' + surplus + ' today</strong> · ' + shifts + ' shifts vs ' + routes + ' routes (OKAMI plan + ' + (w.cushionMode === 'percent' ? w.cushionValue + '% cushion' : '+' + w.cushionValue + ' cushion') + '). Suggest VTO bottom-up by score:</div>'
      + '<div class="vto-chips">'
      + candidates.map(function(d){
        return '<span class="vto-chip" onclick="ciHighlightVtoCandidate(\'' + d.name.replace(/\x27/g, "\\\x27") + '\')" title="Score ' + d.score + ' · click to highlight row">' + d.name + ' <span style="font-size:var(--fs-xs);font-weight:500;opacity:.7">' + d.score + '</span></span>';
      }).join('')
      + '</div>';
    anchor.insertBefore(banner, anchor.firstChild);
  }
  function ciHighlightVtoCandidate(name){
    document.querySelectorAll('#view-checkin .checkin-row.vto-suggested').forEach(function(r){ r.classList.remove('vto-suggested'); });
    var rows = document.querySelectorAll('#view-checkin .checkin-row');
    rows.forEach(function(row){
      var nameEl = row.querySelector('.checkin-driver-name');
      if (nameEl && nameEl.textContent.trim() === name) {
        row.classList.add('vto-suggested');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Pulse the VTO button
        var btn = row.querySelector('.status-btn[data-s="vto"]');
        if (btn) {
          btn.style.transition = 'transform .2s';
          btn.style.transform = 'scale(1.3)';
          setTimeout(function(){ btn.style.transform = ''; }, 250);
        }
      }
    });
  }
  window.ciHighlightVtoCandidate = ciHighlightVtoCandidate;

  // ─── HOOKS ──────────────────────────────────────────────────────
  function _applyScoreUx(){
    schedScoreOverlay();
    poolInjectSortToggle();
    ciRenderVtoSuggestion();
  }
  if (typeof goto === 'function' && !goto._wrappedForScoreUx) {
    var _origGotoForScoreUx = goto;
    goto = function(view){ _origGotoForScoreUx(view); setTimeout(_applyScoreUx, 60); };
    goto._wrappedForScoreUx = true;
  }
  document.addEventListener('DOMContentLoaded', _applyScoreUx);
  if (document.readyState !== 'loading') _applyScoreUx();

  // ─── HOOK: re-apply cascade after navigation (non-destructive wrap) ──
  if (typeof goto === 'function' && !goto._wrappedForSuspension) {
    var _origGotoForSus = goto;
    goto = function(view){
      _origGotoForSus(view);
      setTimeout(cascadeSuspension, 30);
    };
    goto._wrappedForSuspension = true;
  }
  if (typeof drSub === 'function' && !drSub._wrappedForSuspension) {
    var _origDrSubForSus = drSub;
    drSub = function(sub){
      _origDrSubForSus(sub);
      setTimeout(cascadeSuspension, 30);
    };
    drSub._wrappedForSuspension = true;
  }

  // Initial cascade (no-op until first suspension)
  document.addEventListener('DOMContentLoaded', cascadeSuspension);
  if (document.readyState !== 'loading') cascadeSuspension();

  // ═══════════════════════════════════════════════════════════════
  // VTO BUTTON INJECTION + OKAMI RECOMMENDATION ENHANCEMENT
  //   - The check-in flow's status-row HTML was authored before VTO
  //     existed; inject a 5th button into every row at init so we don't
  //     have to touch the static markup.
  //   - Enhance the OKAMI cushion recommendation with a VTO signal:
  //     high VTO rate ⇒ cushion is too high ⇒ recommend lowering it.
  // ═══════════════════════════════════════════════════════════════
  var VTO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 13 11 15 15 11"/></svg>';
  function injectVtoButtons(){
    document.querySelectorAll('#view-checkin .status-row').forEach(function(row){
      if (row.querySelector('.status-btn[data-s="vto"]')) return; // already injected
      var btn = document.createElement('button');
      btn.className = 'status-btn';
      btn.setAttribute('data-s', 'vto');
      btn.setAttribute('title', 'VTO — voluntary time off (offered, accepted)');
      btn.setAttribute('onclick', 'ciMark(this)');
      btn.innerHTML = VTO_SVG;
      row.appendChild(btn);
    });
  }
  document.addEventListener('DOMContentLoaded', injectVtoButtons);
  if (document.readyState !== 'loading') injectVtoButtons();

  // ─── OKAMI cushion recommendation: include VTO signal ───────────
  // If VTO rate is high, you scheduled too many shifts → recommend a
  // LOWER cushion. Wraps the existing recommendation function.
  if (typeof okamiRecommendCushion === 'function' && !okamiRecommendCushion._vtoEnhanced) {
    var _origRecommend = okamiRecommendCushion;
    window.okamiRecommendCushion = function(){
      var base = _origRecommend();
      if (!window.RR_ATTENDANCE_LOG || !window.RR_DRIVERS) return base;
      var windowDays = 30;
      var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
      var vtoCount = 0;
      RR_ATTENDANCE_LOG.forEach(function(e){
        if (e.type !== 'vto') return;
        if (new Date(e.date + 'T00:00:00') < cutoff) return;
        vtoCount++;
      });
      var totalScheduled = RR_DRIVERS.reduce(function(s, d){ return s + (d.scheduled30 || 22); }, 0);
      var vtoRate = totalScheduled > 0 ? vtoCount / totalScheduled : 0;
      // VTO rate > 4% suggests cushion is too high (you offered too many opt-outs).
      // Subtract the excess from the recommendation, but never recommend below 5%.
      var adjusted = base.percent;
      var note = '';
      if (vtoRate > 0.04) {
        var excess = Math.round((vtoRate - 0.04) * 100 * 1.5); // soft taper
        adjusted = Math.max(5, base.percent - excess);
        note = ' · ' + vtoCount + ' VTO event(s) over ' + totalScheduled + ' shifts ('
             + (vtoRate * 100).toFixed(1) + '%) suggests cushion is too high — lowered ' + excess + '%';
      } else if (vtoRate > 0 && vtoRate <= 0.04) {
        note = ' · ' + vtoCount + ' VTO event(s) (' + (vtoRate * 100).toFixed(1) + '% rate) within healthy band';
      }
      base.percent = adjusted;
      base.vtoCount = vtoCount;
      base.vtoRate = vtoRate;
      base.source = base.source + note;
      return base;
    };
    window.okamiRecommendCushion._vtoEnhanced = true;
  }
