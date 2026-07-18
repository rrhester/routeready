
      <!-- .tcp-shell makes the .page a viewport-tall flex column.
           Chrome rows (.tcp-strip and .tcp-kpi below) are flex:0
           and lock their own heights via tcp.css tokens. The
           .tcp-body wrapper below them is flex:1 with its own
           overflow — body content scrolls inside that, NEVER
           pushing the chrome. This is what fully isolates the
           KPI band + icon strip from anything in the body. -->
      <div class="page tcp-shell">
        <!-- Navigation heading — the schedule's single horizontal
             ribbon. Title sits on the left, the full icon cluster
             (nav tabs + commands + week nav) rides the same line,
             Outlook-style. Replaces the old two-row header. -->
        <!-- TopControlPlane: this wrapper IS the TCP for Schedule.
             Tokens + class contract live in tcp.css. Future pages
             may opt in by adopting the same .tcp / .tcp-strip /
             .tcp-kpi class scaffold around their own chrome. -->
        <div class="sched-cmd-shell tcp" id="rr-sched-cmd">
        <!-- cmd-tabs (Schedule / Print/Download) relocated to the
             top-right of the V2 strip. The `_schedCmdTab` handler
             still toggles `.is-print` on this #rr-sched-cmd shell,
             so the existing print flow keeps working. -->
        <div class="page-header sched-nav-heading">
          <!-- Title block moved to the far left of the V2 strip below.
               The original .page-header-l slot is kept empty so the
               existing flex layout doesn't collapse the ribbon to the
               left edge. -->
          <div class="page-header-l" aria-hidden="true"></div>

          <div class="sched-nav-heading-actions sched-ribbon-grouped">
          <!-- VIEWS group · Week first, then Today. Quiet utility
               buttons with the same monoline calendar glyph family. -->
          <div class="sched-ribbon-group" data-group="views">
            <div class="subnav sched-ribbon-subnav" data-rr-tabbar="schedule-views">
              <div class="sched-week-split" data-rr-tile="week">
                <button class="subnav-item active" data-sub="week" data-rr-tile="week" onclick="schedSub('week')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  <span>Schedule View</span>
                </button>
                <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-week-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-week-rules-popover" title="Week view display rules">
                  Rules
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                </button>
                <div class="sched-vans-rules-popover" id="rr-sched-week-rules-popover" role="dialog" aria-modal="false" aria-label="Week view display rules" hidden>
                  <div class="sched-vans-rules-head">
                    <span class="sched-vans-rules-head-title">Week view display</span>
                  </div>
                  <!-- Single-column override · the shared .sched-smartfill-rules-body
                       uses BOTH a 2-col grid AND a CSS multi-column flow (two
                       separate rules layered). For Week-view we want sections
                       to stack top-to-bottom, so we neutralize both:
                       - column-count:1 disables the multi-col flow
                       - display:flex+flex-direction:column overrides the grid
                       Inline scoped to this popover only; Smart Fill popover
                       still uses its 2-col layout via the same class. -->
                  <div class="sched-smartfill-rules-body" style="column-count:1;display:flex;flex-direction:column;gap:14px;padding:12px 14px">
                    <!-- Grid density picker REMOVED from the Week rules box —
                         the DRIVER-header icon (#rr-sched-compact-toggle) now
                         cycles Standard → Compact → Ultra-compact, so the
                         picker here was redundant. The <style> below is kept
                         (it also styles the Fleet calendar's density picker)
                         and the <script> below is kept (it applies the saved
                         `rr-sched-density` on page load — the header icon only
                         runs on click). -->

                    <!-- style block 22 extracted to inline-styles.css -->

                    <script>
                      (function () {
                        if (window.__rrSchedDensityWired) return;
                        window.__rrSchedDensityWired = true;
                        var KEY = "rr-sched-density";
                        function apply(mode) {
                          var b = document.body.classList;
                          b.remove("rr-sched-compact");
                          b.remove("rr-sched-ultra-compact");
                          b.remove("rr-sched-super-compact");
                          if (mode === "compact") b.add("rr-sched-compact");
                          else if (mode === "ultra") b.add("rr-sched-ultra-compact");
                          else if (mode === "super") b.add("rr-sched-super-compact");
                          // Mirror to the existing binary toggle's
                          // aria-pressed so the icon-strip button still
                          // reflects the right state when density is set
                          // from the popover.
                          var btn = document.getElementById("rr-sched-compact-toggle");
                          if (btn) btn.setAttribute("aria-pressed", (mode === "standard") ? "false" : "true");
                        }
                        function syncRadios(mode) {
                          var ins = document.querySelectorAll('input[name="rr-sched-density"]');
                          for (var i = 0; i < ins.length; i++) ins[i].checked = (ins[i].value === mode);
                        }
                        var stored = null;
                        try { stored = localStorage.getItem(KEY); } catch (e) {}
                        if (stored !== "standard" && stored !== "compact" && stored !== "ultra" && stored !== "super") stored = "standard";
                        apply(stored);
                        setTimeout(function () { syncRadios(stored); }, 0);
                        document.addEventListener("change", function (e) {
                          var t = e.target;
                          if (!t || t.name !== "rr-sched-density") return;
                          var v = t.value;
                          if (v !== "standard" && v !== "compact" && v !== "ultra" && v !== "super") return;
                          try { localStorage.setItem(KEY, v); } catch (er) {}
                          apply(v);
                          syncRadios(v);
                        });
                      })();
                    </script>

                    <!-- Card style · toggle between off-white cards (with a
                         service-type-colored side bar) and solid blue cards.
                         Toggles body.rr-sched-cards-blue, persisted in
                         localStorage('rr-sched-card-style'). -->
                    <fieldset class="rr-sched-cardstyle-fset" style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
                      <legend style="font:600 13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-primary,#111827);margin-bottom:6px">Card style</legend>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-cardstyle" value="white" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">White</span>
                          <span class="rr-sched-density-opt-sub">Off-white cards with a colored side bar per service type.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-cardstyle" value="blue" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Blue</span>
                          <span class="rr-sched-density-opt-sub">Solid blue cards.</span>
                        </span>
                      </label>
                    </fieldset>
                    <script>
                      (function () {
                        if (window.__rrSchedCardStyleWired) return;
                        window.__rrSchedCardStyleWired = true;
                        var KEY = "rr-sched-card-style";
                        function apply(style) {
                          document.body.classList.toggle("rr-sched-cards-blue", style === "blue");
                        }
                        function syncRadios(style) {
                          var ins = document.querySelectorAll('input[name="rr-sched-cardstyle"]');
                          for (var i = 0; i < ins.length; i++) ins[i].checked = (ins[i].value === style);
                        }
                        var stored = null;
                        try { stored = localStorage.getItem(KEY); } catch (e) {}
                        if (stored !== "white" && stored !== "blue") stored = "white";
                        apply(stored);
                        setTimeout(function () { syncRadios(stored); }, 0);
                        document.addEventListener("change", function (e) {
                          var t = e.target;
                          if (!t || t.name !== "rr-sched-cardstyle") return;
                          var v = (t.value === "blue") ? "blue" : "white";
                          try { localStorage.setItem(KEY, v); } catch (er) {}
                          apply(v);
                          syncRadios(v);
                        });
                      })();
                    </script>

                    <script>
                      (function () {
                        if (window.__rrRouteColorWired) return;
                        window.__rrRouteColorWired = true;
                        var ON_KEY = "rr-sched-routecolor";
                        var HEX_KEY = "rr-sched-routecolor-hex";
                        // Curated palette · Fluent accent family. Picked to
                        // stay on-brand with the dashboard so no DSP can
                        // choose a clashing neon. Every route shows this
                        // same set; default per-route picks one of these.
                        // Muted rainbow (operator 2026-06-12): every hue
                        // offered is the soft, desaturated version that sits
                        // naturally next to the standard soft-blue card —
                        // distinct hues, one calm lightness family.
                        var PALETTE = [
                          { name: "Red",     hex: "#EFCECD" },
                          { name: "Orange",  hex: "#EFDCCD" },
                          { name: "Amber",   hex: "#EFE6CD" },
                          { name: "Green",   hex: "#DBEFCD" },
                          { name: "Teal",    hex: "#CDEFE6" },
                          { name: "Blue",    hex: "#CDDAEF" },
                          { name: "Violet",  hex: "#D7CDEF" },
                          { name: "Magenta", hex: "#EFCDEF" },
                          { name: "Berry",   hex: "#EFCDDB" },
                          { name: "Slate",   hex: "#D6DAE0" },
                        ];
                        // Bold companions (operator 2026-07-08: colors
                        // must read "sharp, clear and crisp — even small
                        // differences matter"). Same 10 hues at full
                        // saturation, straight from the dashboard's own
                        // accent vocabulary (the Tailwind-600 family the
                        // UI already uses), so a route can pop at a
                        // glance while staying on-brand. Chips pick
                        // white/ink text automatically (textOn below),
                        // so every one of these stays readable.
                        var PALETTE_BOLD = [
                          { name: "Red",     hex: "#DC2626" },
                          { name: "Orange",  hex: "#EA580C" },
                          { name: "Amber",   hex: "#D97706" },
                          { name: "Green",   hex: "#16A34A" },
                          { name: "Teal",    hex: "#0D9488" },
                          { name: "Blue",    hex: "#2563EB" },
                          { name: "Violet",  hex: "#7C3AED" },
                          { name: "Magenta", hex: "#C026D3" },
                          { name: "Berry",   hex: "#DB2777" },
                          { name: "Slate",   hex: "#475569" },
                        ];
                        // Defaults map each route to one palette entry so
                        // first-time DSPs see a sensible default. These
                        // also override the :root --rr-route-c-* vars so
                        // the palette + chip colors stay in sync.
                        // Route types the operator can color-code. "Other" is
                        // the catch-all; the legacy reduction / cycle_1 /
                        // cycle_2 / backup types were retired from the picker.
                        var DEFAULTS = {
                          rescue:         "#EFCECD",
                          nursery:        "#CDEFE6",
                          other:          "#D6DAE0",
                          class_training: "#CDEFE6",
                          road_training:  "#EFDCCD",
                          pto:            "#EFDCCD",
                          xl:             "#EFDCCD",
                          hub:            "#D7CDEF",
                          trainer_trainee:"#DBEFCD",
                        };
                        function loadHex() {
                          // Account (dsps.metadata.route_colors) wins so the
                          // palette syncs across devices; localStorage is a
                          // fast per-device cache; DEFAULTS underpin both.
                          var acct = (window.RR && window.RR.dsp && window.RR.dsp.metadata && window.RR.dsp.metadata.route_colors) || null;
                          var local = null;
                          try {
                            var raw = localStorage.getItem(HEX_KEY);
                            if (raw) local = JSON.parse(raw);
                          } catch (e) {}
                          return Object.assign({}, DEFAULTS,
                            (local && typeof local === "object") ? local : {},
                            (acct && typeof acct === "object") ? acct : {});
                        }
                        function saveHex(map) {
                          // Per-device cache for instant paint on next load.
                          try { localStorage.setItem(HEX_KEY, JSON.stringify(map)); } catch (e) {}
                          // Persist to the DSP account so the colors follow the
                          // operator across devices (same pattern as the other
                          // dsps.metadata settings).
                          try {
                            var dsp = window.RR && window.RR.dsp;
                            if (dsp && dsp.id && window.sb) {
                              var newMeta = Object.assign({}, dsp.metadata || {}, { route_colors: map });
                              dsp.metadata = newMeta;
                              window.sb.from("dsps").update({ metadata: newMeta }).eq("id", dsp.id)
                                .then(function (r) { if (r && r.error) console.warn("route color save:", r.error.message); });
                            }
                          } catch (e) {}
                        }
                        // Auto-contrast text for a picked chip color:
                        // white for dark picks, the dashboard ink
                        // (#111827) for light picks — whichever wins on
                        // WCAG contrast — so ANY pick stays readable.
                        function textOn(hex) {
                          var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
                          if (!m) return "";
                          var n = parseInt(m[1], 16);
                          function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
                          var L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
                          // 0.0592 = luminance of #111827 (ink) + 0.05
                          return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.0592) ? "#FFFFFF" : "#111827";
                        }
                        // Retired route types (kept for old shifts) color
                        // from :root in inline-styles.css — mirror those
                        // hexes here so they get text vars too (their
                        // violet/pink fills need white text, not ink).
                        var LEGACY_TEXT = {
                          reduction: "#EA580C",
                          cycle_1:   "#7C3AED",
                          cycle_2:   "#DB2777",
                          backup:    "#6B7280",
                        };
                        function applyColor(route, hex) {
                          document.documentElement.style.setProperty("--rr-route-c-" + route, hex);
                          // Publish the matching auto-contrast text color
                          // (consumed as --rr-route-t-* by schedule-rrx.css).
                          var t = textOn(hex);
                          if (t) document.documentElement.style.setProperty("--rr-route-t-" + route, t);
                        }
                        function applyAll(map) {
                          Object.keys(DEFAULTS).forEach(function (k) {
                            applyColor(k, map[k] || DEFAULTS[k]);
                          });
                          Object.keys(LEGACY_TEXT).forEach(function (k) {
                            var t = textOn(LEGACY_TEXT[k]);
                            if (t) document.documentElement.style.setProperty("--rr-route-t-" + k, t);
                          });
                        }
                        function renderSwatches(route, current) {
                          var host = document.querySelector('[data-rr-route-swatches="' + route + '"]');
                          if (!host) return;
                          host.innerHTML = "";
                          // Two rows per route: soft (calm tints) over
                          // bold (full-saturation, crisp). Inline
                          // flex-direction wins over the skin's row
                          // layout without touching its !important gap.
                          host.style.flexDirection = "column";
                          [["soft", PALETTE], ["bold", PALETTE_BOLD]].forEach(function (set) {
                            var row = document.createElement("div");
                            row.style.display = "flex";
                            row.style.gap = "2px";
                            set[1].forEach(function (entry) {
                              var b = document.createElement("button");
                              b.type = "button";
                              b.className = "rr-rcp-swatch";
                              b.style.background = entry.hex;
                              b.setAttribute("data-rr-route", route);
                              b.setAttribute("data-rr-hex", entry.hex);
                              b.setAttribute("title", entry.name + " · " + set[0]);
                              if (entry.hex.toUpperCase() === String(current).toUpperCase()) {
                                b.classList.add("is-active");
                              }
                              row.appendChild(b);
                            });
                            host.appendChild(row);
                          });
                        }
                        function renderAllSwatches(map) {
                          Object.keys(DEFAULTS).forEach(function (k) {
                            renderSwatches(k, map[k] || DEFAULTS[k]);
                          });
                        }
                        function applyToggle(on) {
                          document.body.classList.toggle("rr-sched-color-routes", !!on);
                          var legend = document.getElementById("rr-sched-routecolor-legend");
                          if (legend) legend.hidden = !on;
                        }
                        var current = loadHex();
                        applyAll(current);
                        // Re-apply once the DSP account loads (this IIFE runs
                        // at parse time, before window.RR.dsp exists) so the
                        // account's saved colors win over local/defaults.
                        window._rrReapplyRouteColors = function () {
                          current = loadHex();
                          applyAll(current);
                          renderAllSwatches(current);
                        };
                        var stored = null;
                        try { stored = localStorage.getItem(ON_KEY); } catch (e) {}
                        var on = stored === "1";
                        var cb = document.getElementById("rr-sched-routecolor-on");
                        if (cb) cb.checked = on;
                        applyToggle(on);
                        setTimeout(function () { renderAllSwatches(current); }, 0);
                        // Toggle on/off
                        document.addEventListener("change", function (e) {
                          var t = e.target;
                          if (t && t.id === "rr-sched-routecolor-on") {
                            var v = !!t.checked;
                            try { localStorage.setItem(ON_KEY, v ? "1" : "0"); } catch (er) {}
                            applyToggle(v);
                          }
                        });
                        // Swatch click = pick that color for that route
                        document.addEventListener("click", function (e) {
                          var sw = e.target && e.target.closest && e.target.closest(".rr-rcp-swatch");
                          if (sw) {
                            e.preventDefault();
                            var route = sw.getAttribute("data-rr-route");
                            var hex   = sw.getAttribute("data-rr-hex");
                            if (!route || !hex || !DEFAULTS[route]) return;
                            current[route] = hex;
                            saveHex(current);
                            applyColor(route, hex);
                            renderSwatches(route, hex);
                            return;
                          }
                          var btn = e.target && e.target.closest && e.target.closest("[data-rr-route-reset]");
                          if (btn) {
                            e.preventDefault();
                            var r = btn.getAttribute("data-rr-route-reset");
                            if (!DEFAULTS[r]) return;
                            current[r] = DEFAULTS[r];
                            saveHex(current);
                            applyColor(r, DEFAULTS[r]);
                            renderSwatches(r, DEFAULTS[r]);
                          }
                        });
                      })();
                    </script>
                  </div>
                </div>
              </div>
              <div class="sched-week-split" data-rr-tile="today">
                <button class="subnav-item" data-sub="today" data-rr-tile="today" onclick="schedSub('today')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="15" r="2.2" fill="currentColor"/></svg>
                  <span>Today</span>
                  <span class="sched-today-indicator" id="rr-sched-today-att-badge" style="display:none" aria-label="Attendance tasks need attention" title="Attendance tasks need attention"></span>
                </button>
                <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-today-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-today-rules-popover" title="Today view display rules">
                  Rules
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                </button>
                <div class="sched-vans-rules-popover" id="rr-sched-today-rules-popover" role="dialog" aria-modal="false" aria-label="Today view display rules" hidden>
                  <div class="sched-vans-rules-head">
                    <span class="sched-vans-rules-head-title">Today view display</span>
                  </div>
                  <div class="sched-smartfill-rules-body">
                    <fieldset class="rr-sched-density-fset" role="radiogroup" aria-label="Grid density">
                      <legend style="font:600 13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-primary, #111827);margin-bottom:6px">Grid density</legend>
                      <p style="font:13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-secondary, #6B7280);margin:0 0 12px">Same density choice as the Week view — flipping it here also affects Week and Fleet calendar.</p>

                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="standard" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Standard</span>
                          <span class="rr-sched-density-opt-sub">Square cells. Fewest drivers per screen, fullest shift-chip detail.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="compact" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Compact</span>
                          <span class="rr-sched-density-opt-sub">Rectangular cells, ~25% shorter. ~50% more drivers visible at once.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="ultra" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Ultra-compact</span>
                          <span class="rr-sched-density-opt-sub">Slimmest rows. Maximum drivers per screen for a planning-week overview.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="super" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Super-compact</span>
                          <span class="rr-sched-density-opt-sub">Tightest rows — the most drivers on screen at once. Keeps every shift detail (time, wave, van).</span>
                        </span>
                      </label>
                    </fieldset>
                  </div>
                </div>
              </div>
              <!-- Targets sub-tab · per-week route-planning editor,
                   same pattern as Week view / Today view. The
                   ribbon's Targets icon (#rr-sched-okami-open-h)
                   ALSO triggers schedSub('targets') so both entry
                   points land on this sub-view. -->
              <button class="subnav-item" data-sub="targets" data-rr-tile="targets" onclick="schedSub('targets')" title="Per-week route targets · plan daily route count by wave + service type">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="8 16 11 19 16 14"/></svg>
                <span>Targets</span>
              </button>
              <div class="sched-week-split" data-rr-tile="calendar">
                <button class="subnav-item" data-sub="calendar" data-rr-tile="calendar" onclick="schedSub('calendar')" title="Fleet calendar — schedule events per van">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="14.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="14.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>
                  <span>Fleet</span>
                </button>
                <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-cal-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-cal-rules-popover" title="Fleet calendar display rules">
                  Rules
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                </button>
                <div class="sched-vans-rules-popover" id="rr-sched-cal-rules-popover" role="dialog" aria-modal="false" aria-label="Fleet calendar display rules" hidden>
                  <div class="sched-vans-rules-head">
                    <span class="sched-vans-rules-head-title">Fleet calendar display</span>
                  </div>
                  <div class="sched-smartfill-rules-body">
                    <fieldset class="rr-sched-density-fset" role="radiogroup" aria-label="Grid density">
                      <legend style="font:600 13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-primary, #111827);margin-bottom:6px">Grid density</legend>
                      <p style="font:13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-secondary, #6B7280);margin:0 0 12px">Same density choice as the Week view — flipping it here also affects Week and Today.</p>

                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="standard" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Standard</span>
                          <span class="rr-sched-density-opt-sub">Square cells. Fewest drivers per screen, fullest shift-chip detail.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="compact" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Compact</span>
                          <span class="rr-sched-density-opt-sub">Rectangular cells, ~25% shorter. ~50% more drivers visible at once.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="ultra" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Ultra-compact</span>
                          <span class="rr-sched-density-opt-sub">Slimmest rows. Maximum drivers per screen for a planning-week overview.</span>
                        </span>
                      </label>
                      <label class="rr-sched-density-opt">
                        <input type="radio" name="rr-sched-density" value="super" />
                        <span class="rr-sched-density-opt-body">
                          <span class="rr-sched-density-opt-title">Super-compact</span>
                          <span class="rr-sched-density-opt-sub">Tightest rows — the most drivers on screen at once. Keeps every shift detail (time, wave, van).</span>
                        </span>
                      </label>
                    </fieldset>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- PLANNING group · Requests (Staff cmd-tab removed per
               operator request — staff access now lives entirely on
               the Week view via the DRIVER-header staff toggle). -->
          <div class="sched-ribbon-group" data-group="planning">
            <div class="subnav sched-ribbon-subnav" data-rr-tabbar="schedule-planning">
              <button class="subnav-item" data-sub="requests" data-rr-tile="requests" onclick="schedSub('requests')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                <span>Requests</span>
                <span class="sched-requests-indicator" id="rr-sched-time-off-badge" style="display:none" aria-label="Active requests" title="Active requests"></span>
              </button>
            </div>
          </div>

          <!-- Page-level actions grouped visually via CSS `order:`
               (see #rr-sched-page-actions rules). Logical DOM order
               is unchanged so click handlers + popovers + drag
               reorder all keep working. Group boundaries:
                 · AUTOMATION  → Smart Fill, Targets
                 · WORKFLOW    → Finalize (primary accent)
                 · SECONDARY   → Unassign, Kudos -->
          <div class="sched-ribbon-actions sched-ribbon-actions--grouped" id="rr-sched-page-actions">
            <div class="sched-smartfill-split">
              <button class="sched-page-btn" id="rr-sched-smartfill-h" data-rr-tile="smartfill" draggable="true" type="button" title="Auto-staff this week from your rules + OKAMI demand">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <span class="sf-btn-label">Smart Fill</span>
              </button>
              <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-smartfill-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-smartfill-rules-popover" title="Staffing Policy — rules used by Smart Fill when building schedules">
                Policy
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </button>
              <!-- What-if simulation · runs Smart Fill with overrides
                   (drivers marked unavailable, etc.) and never writes
                   back to the shifts table. Powered by the audit spine
                   (trigger_kind='what_if'). -->
              <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-whatif-toggle" title="Simulate a Smart Fill run with overrides — never writes to the live schedule">
                What if…
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><line x1="6" y1="3.5" x2="6" y2="6.5"/><line x1="6" y1="8" x2="6" y2="8.5"/></svg>
              </button>
              <!-- Schedule Colors popover (operator 2026-06-12) · the route
                   color-coding rules, moved out of the Week display popover.
                   Opened from the Smart Fill caret menu. All wiring is
                   document-delegated / id-based, so the rows work unchanged
                   in their new home. -->
              <div class="rr-colors-popover" id="rr-sched-colors-popover" role="dialog" aria-modal="false" aria-label="Schedule Colors" hidden>
                <div class="rr-pol-head">
                  <div class="rr-pol-title">Schedule Colors</div>
                  <button type="button" class="rr-pol-close" id="rr-colors-close" aria-label="Close Schedule Colors">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div class="rr-colors-body">
                    <!-- Route color coding · master toggle. When ON,
                         shift chips paint themselves per route_classification:
                         rescue=red, nursery=teal, other=gray.
                         Standard (NULL) keeps the existing brand-blue chip. -->
                    <fieldset class="rr-sched-routecolor-fset" style="border:0;padding:14px 0 0;margin:14px 0 0;border-top:1px solid var(--border)">
                      <legend style="font:600 13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-primary,#111827);margin-bottom:6px">Route color coding</legend>
                      <p style="font:13px/18px var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-secondary,#6B7280);margin:0 0 10px">Tint each shift chip by its route type (Rescue, Nursery, etc.) so the schedule reads at a glance. Set a shift's type from its Edit drawer.</p>

                      <label class="rr-sched-routecolor-opt" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:#FFF;cursor:pointer;font-family:var(--rr-font-family,'Segoe UI')">
                        <input type="checkbox" id="rr-sched-routecolor-on" style="margin:0;accent-color:var(--accent)" />
                        <span style="font-size:13px;font-weight:600;color:#111827">Color-code chips by route type</span>
                      </label>

                      <!-- Curated palette · the 8 Fluent-family accents
                           below cover the dashboard's tonal range without
                           clashing. Each route row shows the route name +
                           the same 8 swatches; the active one gets a
                           ring. No free-form color picker — the DSP can
                           still personalize but only from the on-brand
                           palette. -->
                      <div id="rr-sched-routecolor-legend" hidden style="display:flex;flex-direction:column;gap:8px;margin-top:10px;font:12px/1.4 var(--rr-font-family, 'Inter','Segoe UI');color:var(--rr-fg-secondary,#6B7280)">
                        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <span style="width:14px;height:14px;border-radius:3px;background:rgba(37,99,235,.22);border:1.5px solid rgba(37,99,235,.55);flex-shrink:0"></span>
                          <span style="flex:1">Standard</span>
                          <span style="color:#9CA3AF;font-size:11px">(no override)</span>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="rescue"    style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Rescue</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="rescue" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="nursery"   style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Nursery</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="nursery" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="other"     style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Other</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="other" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="class_training" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Class training</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="class_training" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="road_training" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Road training</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="road_training" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="pto" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">PTO / time off</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="pto" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="xl" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">XL</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="xl" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="hub" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">HUB</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="hub" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="trainer_trainee" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Trainer (trainee riding along)</span></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="trainer_trainee" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                      </div>
                      <!-- style block 23 extracted to inline-styles.css -->
                    </fieldset>
                </div>
              </div>
              <!-- Staffing Policy drawer · the Smart Fill rules popover
                   rebuilt as a compact right-side drawer. Same element id
                   + body id so every existing rule handler (delegated on
                   #rr-sched-smartfill-rules-body) keeps working. The main
                   pane is a dense set of DSP-language policy controls
                   that read/write the same localStorage rule blob; the
                   full expert controls live under Advanced / Van Rules.
                   State persists in localStorage per browser and is
                   synced to dsps.metadata.staffing_policy on Save. -->
              <div class="sched-smartfill-rules-popover rr-policy-drawer" id="rr-sched-smartfill-rules-popover" role="dialog" aria-modal="false" aria-label="Smart Fill Rules" hidden>
                <div class="sched-smartfill-rules-head rr-pol-head">
                  <div class="rr-pol-title">Smart Fill Rules</div>
                  <button type="button" class="rr-pol-close" id="rr-pol-close" aria-label="Close Smart Fill Rules">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div class="sched-smartfill-rules-body" id="rr-sched-smartfill-rules-body" style="column-count:1;display:flex;flex-direction:column;gap:10px">
                  <!-- Localized styles for the v2 popover. Scoped to the
                       body element so they don't bleed into anything else. -->
                  <!-- style block 24 extracted to inline-styles.css -->

                  <!-- ── MAIN POLICY CONTROLS ── one plain text line per
                       rule, checkbox or compact input on the right. Each
                       control reads/writes existing rule-blob keys via the
                       rr-pol module in live.js; the expert versions of the
                       same knobs stay under Advanced and repaint via
                       _restoreSmartFillRules after every write. -->
                  <div class="pol-section">
                  <h3 class="pol-section-title">Workload limits</h3>
                  <p class="pol-section-sub">The hard ceilings Smart Fill never crosses when it builds a week — a driver is never scheduled past these.</p>
                  <div class="rr-pol-rows">
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-consec">Max Consecutive Days <button type="button" class="rr-pol-info" data-rr-pol-info="Hard ceiling — Smart Fill never schedules a driver more than this many days in a row. Rolling count, so it catches streaks across week boundaries; a day off or approved PTO resets it." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <select class="rr-pol-select" id="rr-pol-consec" title="Hard ceiling — Smart Fill never schedules a driver past this many days in a row">
                          <option value="4">4 days</option>
                          <option value="5">5 days</option>
                          <option value="6">6 days</option>
                        </select>
                      </div>
                    </div>
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-maxdays">Max Days Per Week <button type="button" class="rr-pol-info" data-rr-pol-info="How many days a driver can be scheduled in a week. This also sets the weekly hour budget — days × your default block hours." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <select class="rr-pol-select" id="rr-pol-maxdays">
                          <option value="4">4 days</option>
                          <option value="5">5 days</option>
                          <option value="6">6 days</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  </div>

                  <div class="pol-section">
                  <h3 class="pol-section-title">Fifth day</h3>
                  <p class="pol-section-sub">Whether Smart Fill hands out a fifth day, and who gets a heads-up when it does.</p>
                  <div class="rr-pol-rows">
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-fifth">5th Day <button type="button" class="rr-pol-info" data-rr-pol-info="Off: never. Allow If Needed: drivers who opted in on the availability tool can pick up a 5th day when coverage needs it. Required: Smart Fill aims to give every eligible driver a 5th day — common for DSPs that run 5-day weeks." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <select class="rr-pol-select" id="rr-pol-fifth" title="Off: never. Allow If Needed: drivers who opted in via the availability tool can pick up a 5th day when coverage needs it. Required: Smart Fill schedules a 5th day for every eligible driver.">
                          <option value="off">Off</option>
                          <option value="allow">Allow If Needed</option>
                          <option value="require">Required</option>
                        </select>
                      </div>
                    </div>
                    <div class="rr-pol-row">
                      <label class="rr-pol-label">Message each driver who picks up a 5th day</label>
                      <div class="rr-pol-control">
                        <input type="checkbox" class="rr-pol-check" data-rr-sf-rule="fifth_day_notify">
                      </div>
                    </div>
                  </div>
                  </div>

                  <div class="pol-section">
                  <h3 class="pol-section-title">Call-off coverage</h3>
                  <p class="pol-section-sub">Get ahead of call-offs — Smart Fill can add standby backup drivers on the days your call-off risk tool flags.</p>
                  <div class="rr-pol-rows">
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-calloff-backups">Auto-add call-off backups <button type="button" class="rr-pol-info" data-rr-pol-info="When Smart Fill finishes, it proactively schedules extra standby drivers on days the Callout Exposure tool flags — where at-risk drivers outnumber the cushion, or the weather forecast predicts call-offs. Backups are low-risk, available drivers picked with the same Max Days / consecutive-days / rest / hour-cap rules Smart Fill already enforces, and are added as new seats (nobody loses a shift). It only adds what the risk tool recommends, and never more than there are available drivers." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <input type="checkbox" class="rr-pol-check" id="rr-pol-calloff-backups" title="After Smart Fill runs, automatically add standby backup drivers on days flagged by the call-off risk tool">
                      </div>
                    </div>
                  </div>
                  </div>

                  <div class="pol-section">
                  <h3 class="pol-section-title">Scheduling order</h3>
                  <p class="pol-section-sub">Steer who Smart Fill picks when more than one driver fits.</p>
                  <div class="rr-pol-rows">
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-corrective">Schedule Final-corrective drivers last <button type="button" class="rr-pol-info" data-rr-pol-info="Drivers on a Final coaching ladder only get shifts nobody else can cover: drivers in good standing fill first — even picking up extra days past their weekly target — before a Final-corrective driver is scheduled at all. Coverage always wins, though: a route is never left open (XL routes above all) when a Final-corrective driver is the only one certified and available to run it." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <input type="checkbox" class="rr-pol-check" id="rr-pol-corrective" title="Final-corrective drivers only get shifts no other eligible driver can cover — XL and route coverage always come first">
                      </div>
                    </div>
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-preferred">Favor drivers' preferred days <button type="button" class="rr-pol-info" data-rr-pol-info="Lean toward the days drivers asked for. A soft preference — it never blocks an assignment." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <input type="checkbox" class="rr-pol-check" id="rr-pol-preferred" title="Lean toward the days drivers asked for — a soft preference, never a block">
                      </div>
                    </div>
                  </div>
                  </div>

                  <!-- ── ADVANCED ── the full expert rule sections, collapsed.
                       These are the original popover zones, untouched — same
                       ids + data attributes, same delegated handlers. -->
                  <details class="sf2-section rr-pol-bucket" id="rr-pol-advanced">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Advanced</div>
                        <div class="sf2-section-sub">Presets, rest &amp; targets, license window, custom rules, engine tuning</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="rr-pol-bucket-body">

                  <!-- Expert quick-rows (operator 2026-06-12): Preset
                       bundles, Min Rest, Target Days and Goal were demoted
                       from the main box — same ids, same rr-pol wiring. -->
                  <div class="pol-section">
                  <h3 class="pol-section-title">Rest &amp; stability</h3>
                  <p class="pol-section-sub">Recovery time between shifts and how hard Smart Fill sticks to each driver's usual days.</p>
                  <div class="rr-pol-rows" style="padding:0 10px">
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-rest">Minimum Rest <button type="button" class="rr-pol-info" data-rr-pol-info="Minimum hours between the end of one shift and the start of the next." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <select class="rr-pol-select" id="rr-pol-rest">
                          <option value="8">8 hrs</option>
                          <option value="10">10 hrs</option>
                          <option value="12">12 hrs</option>
                        </select>
                      </div>
                    </div>
                    <div class="rr-pol-row">
                      <label class="rr-pol-label" for="rr-pol-stability">Schedule Stability <button type="button" class="rr-pol-info" data-rr-pol-info="How strongly Smart Fill keeps drivers on their usual days. Lock Existing only fills open shifts; Flexible optimizes coverage first. Pinned shifts always stay put regardless." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                      <div class="rr-pol-control">
                        <select class="rr-pol-select" id="rr-pol-stability" title="How strongly RouteReady keeps drivers on their normal schedules">
                          <option value="lock">Lock Existing</option>
                          <option value="strong">Strong</option>
                          <option value="moderate">Moderate</option>
                          <option value="flexible">Flexible</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  </div>

                  <!-- ── 1 · WHO CAN WORK ── eligibility. The license/cert/
                       service-type gates are ALWAYS enforced (the engine
                       never auto-assigns an unqualified driver), so they no
                       longer have on/off toggles — only the genuine choices
                       (include onboarding drivers, license buffer) remain. -->
                  <details class="sf2-section" data-rr-sf-section="eligibility">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="rr-sf-mini-ic rr-sf-ic-safety rr-sf-sec-ic" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5l6 2.3v4.4c0 3.9-2.5 6.6-6 8.3-3.5-1.7-6-4.4-6-8.3V4.8z"/><path d="M7.4 10l1.8 1.8L13 8"/></svg></span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Who can work</div>
                        <div class="sf2-section-sub">License, certs &amp; service types — always enforced</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <p class="sf2-row-help" style="margin:2px 10px 6px">The right certs (DOT / XL / EDV) for each route's service type and an active service type are always required — the engine never auto-assigns a driver who doesn't qualify.</p>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="include_onboarding" checked> <span class="sf-rule-name">Include onboarding drivers <button type="button" class="rr-pol-info" data-rr-pol-info="activated trainees can take regular shifts" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="dl_valid" checked> <span class="sf-rule-name">DL valid required <button type="button" class="rr-pol-info" data-rr-pol-info="skip drivers with an expired license" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-dl-protection-days">License protection window <button type="button" class="rr-pol-info" data-rr-pol-info="Block drivers within N days of their license expiring (0 = only block once expired). Catches expirations before they bite." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-set-dl-protection-days" min="0" max="365" step="1" value="0">
                          <span style="font-size:11px;color:#6B7280">days before expiry</span>
                        </div>
                        <p class="sf2-row-help">Block drivers within N days of their license expiring (0 = only block once expired). Catches expirations before they bite.</p>
                      </div>
                      <label class="sched-smartfill-rule"><input type="checkbox" id="rr-sf-dl-msg-enable"> <span class="sf-rule-name">Message drivers before expiry <button type="button" class="rr-pol-info" data-rr-pol-info="text / notify drivers ahead of their license renewal" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-dl-msg-days">Message window <button type="button" class="rr-pol-info" data-rr-pol-info="How many days before expiry a driver gets a message. Also sets the “DL” flag window on driver cards." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-sf-dl-msg-days" min="1" max="365" step="1" value="30">
                          <span style="font-size:11px;color:#6B7280">days before expiry</span>
                        </div>
                        <p class="sf2-row-help">How many days before expiry a driver gets a message. Also sets the “DL” flag window on driver cards.</p>
                      </div>
                    </div>
                  </details>

                  <!-- ── 3 · PROTECTIONS ── per-shift / per-driver protections. -->
                  <details class="sf2-section" data-rr-sf-section="protections">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="rr-sf-mini-ic rr-sf-ic-limits rr-sf-sec-ic" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.6"/></svg></span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Limits &amp; compliance</div>
                        <div class="sf2-section-sub">Time off, rest, day &amp; hour caps, WOC</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <p class="sf2-row-help" style="margin:2px 10px 6px">Approved PTO and each driver's saved availability are always respected — the engine never auto-assigns a driver on a day they're off or marked unavailable.</p>
                      <div class="sf2-group-label">Days &amp; hours caps</div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-pto-default-hours">PTO hours per day</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-sf-pto-default-hours" min="0" max="24" step="1" value="10" data-rr-sf-num="pto_default_hours">
                          <span style="font-size:11px;color:#6B7280">hours</span>
                        </div>
                        <p class="sf2-row-help">How many hours an approved-PTO day counts as when the cap is being calculated.</p>
                      </div>
                      <div class="sf2-group-label">Working Hours Compliance (WOC)</div>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="woc" checked> <span class="sf-rule-name">Enforce WOC <button type="button" class="rr-pol-info" data-rr-pol-info="cap consecutive working days + weekly hours" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-woc-max-days">Max consecutive days <button type="button" class="rr-pol-info" data-rr-pol-info="Hard ceiling — Smart Fill never schedules a driver more than this many days in a row. Rolling count, so it catches streaks across week boundaries; a day off or approved PTO resets it." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-set-woc-max-days" min="1" max="7" step="1" value="6">
                          <span style="font-size:11px;color:#6B7280">days in a row</span>
                        </div>
                        <p class="sf2-row-help">The same setting as Max Consecutive Days under Workload limits — shown here too because WOC enforces it.</p>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-woc-max-hours">Max weekly hours <button type="button" class="rr-pol-info" data-rr-pol-info="Cap on scheduled hours per driver per week when WOC is enforced." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-set-woc-max-hours" min="1" max="168" step="1" value="40">
                          <span style="font-size:11px;color:#6B7280">hours per week</span>
                        </div>
                        <p class="sf2-row-help">Cap on scheduled hours per driver per week when WOC is enforced.</p>
                      </div>
                      <div class="sf2-group-label">Same-day shifts</div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-same-day">Same-day policy <button type="button" class="rr-pol-info" data-rr-pol-info="Block = one shift per driver per day. Allow = a driver can work two shifts the same day." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                        <div class="sf2-row-control">
                          <select class="rr-pol-select" id="rr-sf-same-day" data-rr-sf-select="same_day_multi_shift" aria-label="Same-day policy">
                            <option value="block">Block</option>
                            <option value="allow">Allow</option>
                          </select>
                        </div>
                        <p class="sf2-row-help">Block = one shift per driver per day. Allow = a driver can work two shifts the same day.</p>
                      </div>
                    </div>
                  </details>

                  <!-- ── 4 · PREFERENCES ── soft nudges; never block. -->
                  <details class="sf2-section" data-rr-sf-section="prefs">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="rr-sf-mini-ic rr-sf-ic-prefs rr-sf-sec-ic" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="2.6"/><path d="M2.5 16c0-2.5 2-4.2 4.5-4.2S11.5 13.5 11.5 16"/><path d="M13 5.2a2.4 2.4 0 0 1 0 4.4"/><path d="M14 11.9c1.9.3 3.5 1.8 3.5 4.1"/></svg></span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Preferences</div>
                        <div class="sf2-section-sub">Soft nudges — who to favor when there's a choice</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-att-scheduling">Reward good attendance</label>
                        <div class="sf2-row-control">
                          <select class="rr-pol-select" id="rr-sf-att-scheduling" data-rr-sf-select="attendance_weight_combined" aria-label="Reward good attendance">
                            <option value="off" selected>Off</option>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                          </select>
                        </div>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-affinity-weeks">History to look back on</label>
                        <div class="sf2-row-control">
                          <select class="rr-pol-select" id="rr-set-affinity-weeks" aria-label="History to look back on">
                            <option value="4" selected>4 weeks</option>
                            <option value="6">6 weeks</option>
                            <option value="8">8 weeks</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </details>

                  <!-- ── 6 · CUSTOM RULES ── ad-hoc constraints (preserved). -->
                  <details class="sf2-section sf-zone--adhoc" id="rr-sf-adhoc-disclosure" data-rr-sf-section="custom">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="rr-sf-mini-ic rr-sf-ic-custom rr-sf-sec-ic" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6.5" x2="16" y2="6.5"/><circle cx="8" cy="6.5" r="2.1"/><line x1="4" y1="13.5" x2="16" y2="13.5"/><circle cx="13" cy="13.5" r="2.1"/></svg></span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Custom rules</div>
                        <div class="sf2-section-sub">DSP-specific constraints (pair-forbidden, lock-to-day, blackouts)</div>
                      </span>
                      <span class="sf-adhoc-count-pill" style="margin-right:8px"><span id="rr-sf-adhoc-count">0</span> active</span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <div id="rr-sf-adhoc-list" class="sf-adhoc-list" aria-live="polite">
                        <div class="sf-adhoc-loading" style="font-size:12px;color:var(--text-subtle);padding:8px 0">Loading…</div>
                      </div>
                    </div>
                  </details>

                  <!-- ── 7 · ENGINE TUNING ── CP-SAT controls (preserved). -->
                  <details class="sf2-section sf-zone--engine" id="rr-sf-engine-expander" data-rr-sf-section="engine">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="rr-sf-mini-ic rr-sf-ic-optimization rr-sf-sec-ic" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.4"/><path d="M10 2.5v2.2M10 15.3v2.2M17.5 10h-2.2M4.7 10H2.5M15.3 4.7l-1.6 1.6M6.3 13.7l-1.6 1.6M15.3 15.3l-1.6-1.6M6.3 6.3 4.7 4.7"/></svg></span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Engine tuning</div>
                        <div class="sf2-section-sub">Priorities, data sources &amp; compute — fine-tuning</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sched-smartfill-engine-body">
                      <div class="sf-engine-group">
                        <div class="sf-engine-group-label">Priorities</div>
                        <div class="sf-engine-priorities" id="rr-sf-engine-priorities">
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-coverage" class="sf-engine-prio-name">Coverage <button type="button" class="rr-pol-info" data-rr-pol-info="How aggressively to fill open shifts. Higher leaves fewer gaps but may push overtime or break other preferences." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-coverage" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="coverage" class="sf-engine-prio-slider" aria-label="Coverage priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">How aggressively to fill open shifts. Higher leaves fewer gaps but may push overtime or break other preferences.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-fairness" class="sf-engine-prio-name">Fairness <button type="button" class="rr-pol-info" data-rr-pol-info="Spread hours evenly across drivers. Higher balances paychecks week to week; lower lets seniority and preferences win." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-fairness" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="fairness" class="sf-engine-prio-slider" aria-label="Fairness priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Spread hours evenly across drivers. Higher balances paychecks week to week; lower lets seniority and preferences win.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-ot_avoidance" class="sf-engine-prio-name">Overtime avoidance <button type="button" class="rr-pol-info" data-rr-pol-info="Penalty for crossing 40h. Higher leaves shifts open before pushing a driver into OT; lower fills the gap regardless." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-ot_avoidance" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="ot_avoidance" class="sf-engine-prio-slider" aria-label="Overtime avoidance priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Penalty for crossing 40h. Higher leaves shifts open before pushing a driver into OT; lower fills the gap regardless.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-stability" class="sf-engine-prio-name">Schedule stability <button type="button" class="rr-pol-info" data-rr-pol-info="Mirror last week&#x27;s pattern. Higher keeps drivers on the same days each week; lower lets the engine reshuffle freely." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-stability" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="stability" class="sf-engine-prio-slider" aria-label="Schedule stability priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Mirror last week's pattern. Higher keeps drivers on the same days each week; lower lets the engine reshuffle freely.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-van_continuity" class="sf-engine-prio-name">Van continuity <button type="button" class="rr-pol-info" data-rr-pol-info="Stick to a driver&#x27;s paired van. Higher keeps the primary/backup chain together; lower lets the engine swap vans to optimize other goals." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-van_continuity" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="van_continuity" class="sf-engine-prio-slider" aria-label="Van continuity priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Stick to a driver's paired van. Higher keeps the primary/backup chain together; lower lets the engine swap vans to optimize other goals.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-preferred_days" class="sf-engine-prio-name">Preferred days <button type="button" class="rr-pol-info" data-rr-pol-info="Honor driver day-of-week availability picks. Higher treats their picks as hard; lower treats them as hints the engine can override." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-preferred_days" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="preferred_days" class="sf-engine-prio-slider" aria-label="Preferred days priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Honor driver day-of-week availability picks. Higher treats their picks as hard; lower treats them as hints the engine can override.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-attendance_penalty" class="sf-engine-prio-name">Attendance penalty <button type="button" class="rr-pol-info" data-rr-pol-info="Weight on past attendance. Higher steers shifts away from drivers with recent no-shows or late points; lower ignores attendance history." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></label>
                            <input id="rr-sf-prio-attendance_penalty" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="attendance_penalty" class="sf-engine-prio-slider" aria-label="Attendance penalty priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Weight on past attendance. Higher steers shifts away from drivers with recent no-shows or late points; lower ignores attendance history.</p>
                          </div>
                        </div>
                      </div>
                      <div class="sf-engine-group">
                        <div class="sf-engine-group-label">Data sources</div>
                        <div class="sf-engine-datasources">
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="pto" checked> <span>Use approved PTO <button type="button" class="rr-pol-info" data-rr-pol-info="Feed approved PTO into the engine — drivers are never scheduled on an approved day off. Turn off only to diagnose coverage problems." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="affinity" checked> <span>Use affinity history <button type="button" class="rr-pol-info" data-rr-pol-info="Let the engine read past schedules to learn each driver&#x27;s usual days. The window length is set under Compute budget." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="van_pairings" checked> <span>Use van pairings <button type="button" class="rr-pol-info" data-rr-pol-info="Use saved driver-van pairings when assigning vans, keeping drivers in their usual van." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="attendance" checked> <span>Use attendance score <button type="button" class="rr-pol-info" data-rr-pol-info="Give the engine each driver&#x27;s attendance score so the Attendance penalty priority can act on it." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="fifth_day_optin" checked> <span>Use 5th-day opt-in flags <button type="button" class="rr-pol-info" data-rr-pol-info="Respect the availability tool&#x27;s 5th-day opt-ins — only opted-in drivers are considered for a 5th day." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="ad_hoc_rules" checked> <span>Use ad-hoc custom rules <button type="button" class="rr-pol-info" data-rr-pol-info="Apply the Custom rules section (pair-forbidden, lock-to-day, blackouts) when the engine builds the week." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                        </div>
                      </div>
                      <div class="sf-engine-group">
                        <div class="sf-engine-group-label">Compute budget</div>
                        <div class="sf-engine-budget">
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Solve time <button type="button" class="rr-pol-info" data-rr-pol-info="How long the engine may search before returning its best schedule. Longer finds better answers on big rosters; Quick is fine for small ones." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span>
                            <select class="rr-pol-select sf-engine-budget-select" id="rr-sf-solve-time" aria-label="Solve time" data-rr-sf-budget="solveTimeMs">
                              <option value="3000">Quick (3s)</option>
                              <option value="8000" selected>Normal (8s)</option>
                              <option value="30000">Thorough (30s)</option>
                            </select>
                          </div>
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Affinity history window <button type="button" class="rr-pol-info" data-rr-pol-info="How many weeks of past schedules the engine reads when learning each driver&#x27;s usual days." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span>
                            <select class="rr-pol-select sf-engine-budget-select" id="rr-sf-affinity-weeks" aria-label="Affinity history window" data-rr-sf-budget="affinityWeeks">
                              <option value="2">2 weeks</option>
                              <option value="4" selected>4 weeks</option>
                              <option value="8">8 weeks</option>
                            </select>
                          </div>
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Max days per week <button type="button" class="rr-pol-info" data-rr-pol-info="Solver-side cap on how many days one driver can be scheduled this week — the same setting as Max Days Per Week under Workload limits." aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span>
                            <select class="rr-pol-select sf-engine-budget-select" id="rr-sf-max-days-override" aria-label="Max days per week" data-rr-sf-budget="maxDaysOverride">
                              <option value="3">3 days</option>
                              <option value="4">4 days</option>
                              <option value="5" selected>5 days</option>
                              <option value="6">6 days</option>
                              <option value="7">7 days</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      <div class="sf-engine-foot">
                        <button type="button" class="sf-engine-reset" id="rr-sf-engine-reset">Reset to defaults</button>
                      </div>
                    </div>
                  </details>

                  <!-- Reset-all escape hatch · the data-rr-sf-preset
                       delegation in live.js owns the confirm + wipe. -->
                  <div class="rr-pol-resetall-row">
                    <button type="button" class="sf-engine-reset" data-rr-sf-preset="reset" title="Clear every saved rule. Equivalent to a fresh install.">Reset all rules…</button>
                  </div>

                    </div>
                  </details>

                </div>
                <div class="rr-pol-foot">
                  <button type="button" class="rr-pol-btn" id="rr-pol-cancel" title="Revert every change made since the drawer was opened">Cancel</button>
                  <button type="button" class="rr-pol-btn rr-pol-btn-primary" id="rr-pol-save" title="Save this policy for your DSP">Save Policy</button>
                </div>
              </div>
            </div>
            <div class="sched-vans-rules-split">
              <button class="sched-page-btn sched-page-btn--split" id="rr-sched-vans-h" data-rr-tile="vans" draggable="true" type="button" title="Auto-assign vans for this week using the standing primary / backup chain" aria-label="Assign vans">
                <!-- Side-view delivery van · cargo box on the left,
                     stubby cab on the right with windshield, two
                     wheels along the base. The .rr-van-cargo /
                     .rr-van-cab classes are preserved so the
                     existing JS "assigned" state-color logic keeps
                     working.
                     Content shifted up 5px from its original
                     position so the visible top aligns with the
                     other ribbon icons (calendar / star / checkbox
                     etc. all start at viewBox y=2). -->
                <svg class="rr-van-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <!-- Cargo box (left) -->
                  <rect class="rr-van-cargo" x="2" y="2" width="13" height="10" rx="1.2"/>
                  <!-- Cab (right): hood + windshield -->
                  <path class="rr-van-cab" d="M15 5h4l3 3v4h-7z"/>
                  <line x1="15.5" y1="5.5" x2="18.5" y2="5.5"/>
                  <!-- Ground line under the body -->
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <!-- Wheels -->
                  <circle cx="6.5" cy="13.5" r="1.6"/>
                  <circle cx="17.5" cy="13.5" r="1.6"/>
                </svg>
                Assign
                <span class="sched-page-btn-split-toggle" id="rr-sched-vans-chain-toggle" role="button" tabindex="0" aria-haspopup="true" aria-controls="sched-sub-vans-chain" title="Open the van / driver chain editor">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                </span>
              </button>
              <!-- Van rules popover · resurrected (operator 2026-06-12):
                   van-assignment rules moved OUT of Staffing Policy into
                   the Assign Fleet dropdown. Same data attributes, same
                   localStorage state — _toggleSchedVanRules / the
                   delegated checkbox handlers were never removed. -->
              <div class="sched-vans-rules-popover" id="rr-sched-vans-rules-popover" role="dialog" aria-modal="false" aria-label="Van rules" hidden>
                <div class="sched-vans-rules-head">
                  <span class="sched-vans-rules-head-title">Van rules</span>
                </div>
                <div class="sched-smartfill-rules-body sf-zone--vans" style="column-count:1;display:flex;flex-direction:column;gap:8px;padding:12px 14px">
                  <div class="sf-vans-subzone-label">When to assign</div>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-vans="assign" checked> <span class="sf-rule-name">Assign vans during Smart Fill <button type="button" class="rr-pol-info" data-rr-pol-info="when off, the van column stays empty for new assignments" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-auto-rescue checked> <span class="sf-rule-name">Auto-rescue at-risk vans <button type="button" class="rr-pol-info" data-rr-pol-info="run van assignment automatically when FEM flags a van approaching the 14-day rotation rule" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                  <div class="sf-vans-subzone-label">Who gets which van</div>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-vans="prefer_paired" checked> <span class="sf-rule-name">Prefer driver's paired van <button type="button" class="rr-pol-info" data-rr-pol-info="use the standing primary / backup chain when possible" aria-label="What this rule does"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><line x1="6" y1="5.4" x2="6" y2="8.6"/><circle cx="6" cy="3.3" r="0.6" fill="currentColor" stroke="none"/></svg></button></span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="primary_chain" checked> <span class="sf-rule-name">Each van's primary driver keeps their van when they're scheduled</span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="secondary_chain" checked> <span class="sf-rule-name">When the primary is off, the backup driver takes the van</span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="pool_fill" checked> <span class="sf-rule-name">Match remaining drivers with any leftover vans</span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="branded_first" checked> <span class="sf-rule-name">Assign branded (Amazon-wrapped) vans first</span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="fem_priority" checked> <span class="sf-rule-name">Prioritize branded vans approaching the 14-day rotation rule</span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="rescue_secondary" checked> <span class="sf-rule-name">Move a backup driver onto an at-risk van to prevent a VERO defect</span></label>
                  <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="rescue_primary" checked> <span class="sf-rule-name">Move a primary driver onto an at-risk van as a last resort</span></label>
                  <button type="button" class="sf-engine-reset" id="rr-van-rules-chain-link" style="margin-top:4px">Open the van / driver chain editor…</button>
                </div>
              </div>
              <!-- Standalone "Van rules" footer + popover retired
                   (Path B). All van assignment rules now live in
                   the Smart Fill rules popover under the "Van
                   assignment" section. The Fleet Assignment tile
                   stays as a one-click "Re-run van assignment now"
                   button. -->

            </div>
            <div class="sched-settings-split">
              <button class="sched-page-btn sched-page-btn--okami" id="rr-sched-okami-open-h" data-rr-tile="okami" draggable="true" type="button" title="Targets for this week" aria-label="Targets">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect class="rp-cal" x="3" y="4" width="18" height="18" rx="2"/><line class="rp-cal" x1="16" y1="2" x2="16" y2="6"/><line class="rp-cal" x1="8" y1="2" x2="8" y2="6"/><line class="rp-cal" x1="3" y1="10" x2="21" y2="10"/><polyline class="rp-check" points="8 16 11 19 16 14"/></svg>
                Targets
              </button>
              <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-settings-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-quick-settings-popover" title="Targets rules · block / cushion / max-days / report-time for this week">
                Rules
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </button>
              <!-- Inline quick-edit popover · per-week values that
                   drive Smart Fill + shift regeneration. Anchored to
                   the Route planning tile's split-toggle chevron
                   (the standalone Settings tile was removed; the
                   popover is the operator's only entry point for
                   block / cushion / max-days / report-time edits
                   from the action strip). Auto-save runs on change
                   and triggers the same regen path as the drawer's
                   Save button. -->
              <div class="sched-quick-settings-popover" id="rr-sched-quick-settings-popover" role="dialog" aria-modal="false" aria-label="Schedule quick settings" hidden>
                <div class="sched-quick-settings-head">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
                  <span class="sched-quick-settings-title">This week's settings</span>
                  <button type="button" class="sched-quick-settings-close" id="rr-sched-quick-settings-close" aria-label="Close">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div class="sched-quick-settings-body">
                  <label class="sched-quick-setting">
                    <span class="sched-quick-setting-label">Block length</span>
                    <span class="sched-quick-setting-help">Hours per shift</span>
                    <span class="sched-quick-setting-control">
                      <input class="sched-quick-setting-input" id="rr-set-block-hours" type="number" min="1" max="14" step="1" autocomplete="off"/>
                      <span class="sched-quick-setting-unit">h</span>
                    </span>
                  </label>
                  <label class="sched-quick-setting">
                    <span class="sched-quick-setting-label">Cushion</span>
                    <span class="sched-quick-setting-help">Extra shifts above the route plan</span>
                    <span class="sched-quick-setting-control">
                      <input class="sched-quick-setting-input" id="rr-set-cushion-pct" type="number" min="0" max="50" step="1" autocomplete="off"/>
                      <span class="sched-quick-setting-unit">%</span>
                    </span>
                  </label>
                  <!-- Max days per week moved to the Smart Fill rules
                       popover (it gates an auto-fill rule, not a Targets
                       demand-shaping value). -->
                  <label class="sched-quick-setting">
                    <span class="sched-quick-setting-label">Report time</span>
                    <span class="sched-quick-setting-help">Driver clock-in lead before the wave</span>
                    <span class="sched-quick-setting-control">
                      <input class="sched-quick-setting-input" id="rr-set-report-lead" type="number" min="0" max="120" step="5" autocomplete="off"/>
                      <span class="sched-quick-setting-unit">min</span>
                    </span>
                  </label>
                </div>
                <div class="sched-quick-settings-foot">
                  <span class="sched-quick-settings-status" id="rr-sched-nav-settings-status" aria-live="polite"></span>
                  <button type="button" class="sched-quick-settings-advanced" id="rr-sched-quick-settings-advanced">Advanced settings…</button>
                </div>
                <!-- Inline-expand advanced section · revealed when the
                     popover's .is-advanced class is set. Lives inside
                     the popover so it stays an "inline adjustment"
                     rather than a full-page sub-view. -->
                <div class="sched-quick-advanced">
                  <div class="rr-drawer-section">
                    <div class="rr-drawer-section-head">
                      <div class="rr-drawer-section-title">Wave start times</div>
                      <button class="btn btn-sm" id="rr-set-add-wave" type="button">+ Add wave</button>
                    </div>
                    <div id="rr-set-waves" class="rr-drawer-waves"></div>
                  </div>
                  <div class="rr-drawer-section">
                    <div class="rr-drawer-section-head">
                      <div class="rr-drawer-section-title">Service types</div>
                    </div>
                    <div class="rr-drawer-section-help">Activate the route categories your DSP runs. Inactive types are hidden in OKAMI; activating one adds a demand row per wave.</div>
                    <div id="rr-set-service-types" class="rr-drawer-service-types"></div>
                  </div>
                  <div class="sched-quick-advanced-foot">
                    <span id="rr-set-sched-status" class="rr-drawer-status"></span>
                    <button class="btn btn-primary btn-sm" id="rr-set-sched-save" type="button">Save changes</button>
                  </div>
                </div>
              </div>
            </div>
            <button class="sched-page-btn" id="rr-sched-finalize-h" data-rr-tile="finalize" draggable="true" type="button" title="Push this week's schedule to drivers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="7.5 12.5 11 16 16.5 9"/></svg>
              Finalize
            </button>
            <!-- Kudos · opens the Send Kudos modal (live.js). Below
                 it sits a Rules footer that lets the DSP toggle
                 which milestone banners appear on the schedule. -->
            <div class="sched-kudos-split">
              <button class="sched-page-btn" id="rr-sched-kudos-h" data-rr-tile="kudos" draggable="true" type="button" title="Kudos">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2.5 14.95 8.5 21.5 9.5 16.75 14.05 17.9 20.5 12 17.5 6.1 20.5 7.25 14.05 2.5 9.5 9.05 8.5"/></svg>
                Kudos
              </button>
              <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-milestone-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-milestone-rules-popover" title="Recognition rules · toggle birthday + anniversary banners">
                Rules
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </button>
              <!-- Milestone rules popover · DSP picks which
                   recognition banners to surface on the schedule.
                   State persists in localStorage; renderScheduleWeek
                   reads it through _rrLoadMilestoneRules(). -->
              <div class="sched-milestone-rules-popover" id="rr-sched-milestone-rules-popover" role="dialog" aria-modal="false" aria-label="Recognition rules" hidden>
                <div class="sched-milestone-rules-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="6"/><polyline points="8.5 13 7 22 12 19 17 22 15.5 13"/></svg>Recognition rules</div>
                <div class="sched-milestone-rules-body">
                  <label class="sched-smartfill-rule">
                    <input type="checkbox" data-rr-milestone-rule="birthday" checked>
                    <span class="sf-rule-name">Show birthday banner on the schedule</span>
                  </label>
                  <label class="sched-smartfill-rule">
                    <input type="checkbox" data-rr-milestone-rule="anniversary" checked>
                    <span class="sf-rule-name">Show work anniversary banner on the schedule</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Week navigator was here; relocated to the far right
               of the V2 icon strip below. IDs preserved so all JS
               handlers (rr-sched-week-prev / -today / -next /
               -range / -range-label) keep working. -->
          <!-- Print actions (Print schedule, Download Excel) relocated
               to the V2 strip below. IDs preserved so the existing
               click handlers (_schedPrint, _schedDownloadSchedule) keep
               working. -->
          <div class="sched-print-actions" aria-hidden="true" style="display:none"></div>
          </div><!-- /sched-nav-heading-actions -->
        </div><!-- /page-header.sched-nav-heading -->
        </div><!-- /sched-cmd-shell -->

        <!-- ───────────────────────────────────────────────────────
             V2 icon strip · sharp-edged Fluent placeholders, not
             wired. Sits beneath the existing ribbon at the same
             visual size as the Onboarding strip so you can see
             both side-by-side and decide which sticks. Every tile
             is `pointer-events: none` so clicks don't fire.
             ─────────────────────────────────────────────────────── -->
        <div class="sched-v2-strip tcp-strip" role="toolbar" aria-label="Schedule ribbon">
          <!-- Schedule / Print/Download tabs — moved from the old
               cmd-shell to the top-right of this strip. The
               `_schedCmdTab` JS handler still toggles `.is-print`
               on #rr-sched-cmd so the existing print flow runs
               unchanged. -->
          <div class="sched-cmd-tabs sched-v2-cmd-tabs" role="tablist" aria-label="Command strip mode">
            <button class="sched-cmd-tab active" type="button" data-cmd-tab="schedule" role="tab" aria-selected="true">Schedule</button>
            <!-- Onboarding + Fleet moved to standalone sidebar icons — no
                 longer tabs on the Schedule command strip. -->
            <button class="sched-cmd-tab" type="button" data-cmd-tab="workflows" role="tab" aria-selected="false">Workflows</button>
            <button class="sched-cmd-tab" type="button" data-cmd-tab="print" role="tab" aria-selected="false">Print/Download</button>
          </div>

          <!-- Print actions · shown only when Print/Download tab is
               active (driven by `.sched-cmd-shell.is-print` ancestor
               class via sibling CSS selectors below). IDs preserved
               so _schedPrint + _schedDownloadSchedule keep working. -->
          <div class="sched-v2-print-actions" aria-label="Print actions">
            <button class="sched-print-btn" type="button" id="rr-sched-print-btn" aria-label="Print the schedule">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              <span>Print schedule</span>
            </button>
            <button class="sched-print-btn" type="button" id="rr-sched-download-btn" aria-label="Download the schedule as a spreadsheet">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Download Excel</span>
            </button>
            <!-- PTO report · relocated from Onboarding's print
                 actions (operator preference — PTO/time-off is
                 schedule-relevant). Keeps the original handler
                 id `rr-ob-pto-print-btn` so the live.js handler
                 finds the same element wherever it lives in the
                 DOM. -->
            <button class="sched-print-btn" type="button" id="rr-ob-pto-print-btn" aria-label="Print the PTO / time-off report">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h3M8 17h6"/></svg>
              <span>PTO report</span>
            </button>
          </div>

          <!-- Intelligence actions · shown only when the Intelligence
               tab is active (driven by `.sched-cmd-shell.is-intel`
               ancestor class via sibling CSS selectors below). Five
               placeholder intel/forecast tiles — wiring lands in a
               follow-up; today the tiles render and accept click but
               do not change page state (the page contents under the
               ribbon stay exactly as they were on the Schedule tab).
               Each tile carries data-rr-intel so the future click
               handler can dispatch by name without re-matching the
               DOM structure. -->
          <div class="sched-v2-intel-actions" aria-label="Intelligence actions">
            <span class="sched-v2-intel-label">Intelligence</span>
            <div class="sched-v2-intel-tiles">
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="risk-forecast" title="Risk forecast · which weeks will break before they break">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="3 17 9 11 13 15 21 7"/>
                  <polyline points="14 7 21 7 21 14"/>
                  <circle cx="9" cy="11" r="1.2" fill="currentColor" stroke="none"/>
                  <circle cx="13" cy="15" r="1.2" fill="currentColor" stroke="none"/>
                </svg>
                <span>Risk forecast</span>
              </button>
              <button type="button" class="sched-v2-intel-tile sched-v2-intel-tile-soon" data-rr-intel="compliance-watch" disabled aria-disabled="true" title="Compliance watch — coming soon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <circle cx="12" cy="12" r="3"/>
                  <line x1="12" y1="10" x2="12" y2="12"/>
                  <line x1="12" y1="12" x2="13.5" y2="13.5"/>
                </svg>
                <span>Compliance watch</span>
              </button>
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="hiring-pulse" title="Hiring pulse · how many applicants your plan needs in the funnel, and by when">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  <polyline points="18 4 22 4 22 8"/>
                  <line x1="22" y1="4" x2="18.5" y2="7.5"/>
                </svg>
                <span>Hiring pulse</span>
              </button>
              <button type="button" class="sched-v2-intel-tile sched-v2-intel-tile-soon" data-rr-intel="peak-days" disabled aria-disabled="true" title="Peak days — coming soon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="18" rx="1"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <polyline points="13 13 9 18 12 18 10 22 14 17 11 17 14 13"/>
                </svg>
                <span>Peak days</span>
              </button>
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="what-if" title="What-if · stress-test a week: extra routes, Prime-Week demand, callouts, attrition">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="6" y1="3" x2="6" y2="13"/>
                  <circle cx="6" cy="17" r="2"/>
                  <circle cx="18" cy="6" r="2"/>
                  <circle cx="18" cy="18" r="2"/>
                  <path d="M6 13c0-4 6-4 6-7v-2"/>
                  <path d="M18 8v8"/>
                </svg>
                <span>What-if</span>
              </button>
              <!-- Simulate · action tile, not a view-opener. Refreshes
                   the PTO-aware projection that feeds Risk forecast (and
                   future intel views). Visual separator on the left to
                   distinguish it from the 5 forecast views. -->
              <button type="button" class="sched-v2-intel-tile sched-v2-intel-tile-action" id="rr-tgt-sim-btn" data-rr-intel-action="simulate" title="Project drivers available for each of the next 13 weeks, accounting for approved time-off requests">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                <span>Simulate</span>
                <span class="sched-v2-intel-tile-status" id="rr-tgt-sim-status" aria-live="polite"></span>
              </button>
            </div>
          </div>

          <!-- Title block · relocated from the legacy sched-nav-heading.
               Same h1.page-title + p.page-sub structure with the
               #rr-sched-page-sub id preserved so the JS that writes
               the "Week of …" subtitle keeps working untouched. -->
          <div class="sched-v2-title">
            <h1 class="page-title"><span id="rr-sched-page-title-text">Schedule</span>
              <!-- Status pill · "Draft" by default; flips to "Live"
                   when Finalize is clicked. The Finalize click handler
                   (V2 forwards to #rr-sched-finalize-h) updates the
                   data-state attribute via the click listener in
                   live.js below. On the Monthly (Forecast) view the title
                   reads "Forecast" and this pill is hidden (live.js). -->
              <span class="sched-v2-status-pill" id="rr-sched-v2-status" data-state="draft" title="Draft — changes are only visible to you until you hit Finalize.">
                <svg class="sched-v2-status-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 12 10 16 18 8"/></svg>
                <span class="sched-v2-status-label">Draft</span>
              </span>
            </h1>
            <p class="page-sub" id="rr-sched-page-sub"></p>
          </div>
          <!-- Today / Weekly / Monthly · one view-selector group. The
               per-tile "Rules" chevrons were consolidated into a single
               dialog-launcher chevron at the bottom-right of the group
               (Outlook-style), which opens the Week view display rules. -->
          <div class="sched-v2-viewgroup">
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="today" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="7" y1="2" x2="7" y2="6"/>
              <line x1="17" y1="2" x2="17" y2="6"/>
              <rect x="10" y="13" width="4" height="4" fill="currentColor" stroke="none"/>
            </svg>
            <span>Today</span>
          </button>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="week" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="9" x2="9" y2="22"/>
              <line x1="15" y1="9" x2="15" y2="22"/>
              <line x1="7" y1="2" x2="7" y2="6"/>
              <line x1="17" y1="2" x2="17" y2="6"/>
            </svg>
            <span>Schedule View</span>
          </button>
            <!-- Group label · centered under the Weekly (middle) tile, on
                 the card's bottom line. -->
            <span class="sched-v2-group-label" aria-hidden="true">Go To</span>
          </div>
          <!-- Dialog-launcher · box + diagonal arrow, pinned to the
               group's bottom-right next to the hairline divider; opens the
               Week display-rules dialog. -->
          <button type="button" class="sched-v2-group-launcher" tabindex="-1"
                  aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-week-rules-popover"
                  title="View display options"
                  onclick="(function(b,ev){ev.preventDefault();ev.stopPropagation();var pop=document.getElementById('rr-sched-week-rules-popover');var host=b.closest('.sched-v2-strip');if(pop&&host&&pop.parentElement!==host){host.appendChild(pop);}var t=document.getElementById('rr-sched-week-rules-toggle');if(t)t.click();})(this,event)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/><line x1="8" y1="8" x2="13.5" y2="13.5"/><polyline points="13.5 10 13.5 13.5 10 13.5"/></svg>
          </button>
          </div>
          <!-- Roster + Attendance · in-page Schedule sub-views.
               They stay ON the Schedule view and swap only the content
               area below the command + KPI strips (exactly like Week /
               Today / Requests), routing through the canonical schedule
               sub-view switcher schedSub(). schedSub('roster' /
               'attendance') hides the other #sched-sub-* panels, shows
               #sched-sub-roster / #sched-sub-attendance, and mounts the
               shared portable Drivers node into it via _schedMountRosterSub.
               data-rr-v2 carries the key so the V2 dispatch + right-click
               machinery treats them like the other tiles; the inline
               onclick is what drives the switch. The leading group
               hairline sits on Roster (divider rule in schedule-rrx.css
               ~2142). No rules-foot — no rules popover for these. -->
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="roster" tabindex="-1"
                    title="Driver roster"
                    onclick="if(typeof schedSub==='function')schedSub('roster');">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/><line x1="7" y1="18" x2="13" y2="18"/></svg>
            <span>Roster</span>
          </button>
            <!-- Rules chevron · opens the Attendance policy builder under
                 the Roster icon (same hover-revealed chevron format as the
                 other tiles). The popover is opaque (NO backdrop blur) and
                 emerges; the builder DOM (#att-pane-policy) loads via
                 loadAttendancePolicy(), lazy-fired on first open by
                 _toggleSchedRosterRules(). -->
            <button type="button" class="sched-v2-rules-foot" id="rr-sched-roster-rules-toggle"
                    aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-roster-rules-popover"
                    title="Attendance policy · occurrence rules, thresholds, auto-coaching">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
            <div id="rr-sched-roster-rules-popover" role="dialog" aria-modal="false" aria-label="Attendance policy" hidden>
              <div class="rr-srr-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                <span class="rr-srr-head-title">Attendance policy</span>
              </div>
              <div class="rr-srr-body">
                <div style="font-size:13px;color:var(--text-subtle);margin:0 0 12px;line-height:1.5">
                  Master toggle, occurrence rules (callout / no-show / late point weights), thresholds, auto-coaching ladder, and tardy / NCNS timing.
                </div>
                <div id="att-pane-policy">
                  <div class="rr-loading">Loading policy</div>
                </div>
              </div>
            </div>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="attendance" tabindex="-1"
                    title="Driver attendance"
                    onclick="if(typeof schedSub==='function')schedSub('attendance');">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 15 11 17 16 12"/></svg>
            <span>Attendance</span>
          </button>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="requests" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="2" y="3" width="20" height="18"/>
              <polyline points="2 13 7 13 9 16 15 16 17 13 22 13"/>
            </svg>
            <span>Requests</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
          </div>
          <!-- Targets / Smart Fill / Finalize · grouped like the view
               selector. A single "Rules" dialog-launcher (bottom-right, by
               the divider) consolidates the scheduling rules; the "Rules"
               label sits centered under the middle (Smart Fill) tile. The
               per-tile hover "Rules" chevrons are hidden inside the group
               (right-click a tile still opens its own rules). -->
          <div class="sched-v2-viewgroup">
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="targets" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18"/>
              <rect x="7" y="7" width="10" height="10"/>
              <rect x="11" y="11" width="2" height="2" fill="currentColor" stroke="none"/>
            </svg>
            <span>Targets</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="smartfill" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <polygon points="13 2 4 13 11 13 10 22 20 11 13 11"/>
            </svg>
            <span>Smart Fill</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
            <!-- Group label · centered under the middle (Smart Fill) tile. -->
            <span class="sched-v2-group-label" aria-hidden="true">Rules</span>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="finalize" tabindex="-1" title="Publish this week — the schedule flips from Draft to Live and drivers see it. You can keep editing afterward.">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18"/>
              <polyline points="7 12 11 16 17 8"/>
            </svg>
            <span>Finalize</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
          </div>
          <!-- Dialog-launcher · opens the Smart Fill scheduling rules (the
               group's consolidated rules). Box + diagonal arrow, next to the
               hairline divider. -->
          <button type="button" class="sched-v2-group-launcher" tabindex="-1"
                  aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-smartfill-rules-popover"
                  title="Scheduling rules"
                  onclick="window._rrOpenSchedRules && window._rrOpenSchedRules(this,event)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/><line x1="8" y1="8" x2="13.5" y2="13.5"/><polyline points="13.5 10 13.5 13.5 10 13.5"/></svg>
          </button>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="calendar" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="7" y1="2" x2="7" y2="6"/>
              <line x1="17" y1="2" x2="17" y2="6"/>
              <rect x="6" y="12" width="2" height="2" fill="currentColor" stroke="none"/>
              <rect x="11" y="12" width="2" height="2" fill="currentColor" stroke="none"/>
              <rect x="16" y="12" width="2" height="2" fill="currentColor" stroke="none"/>
              <rect x="6" y="17" width="2" height="2" fill="currentColor" stroke="none"/>
              <rect x="11" y="17" width="2" height="2" fill="currentColor" stroke="none"/>
            </svg>
            <span>Fleet</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="unassign" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="2" y="6" width="13" height="10"/>
              <polygon points="15 8 19 8 22 11 22 16 15 16"/>
              <rect x="5" y="15" width="3" height="3"/>
              <rect x="16" y="15" width="3" height="3"/>
            </svg>
            <span>Unassign</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="kudos" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <polygon points="12 2 15 9 22 10 17 15 18 22 12 18 6 22 7 15 2 10 9 9"/>
            </svg>
            <span>Kudos</span>
          </button>
            <button type="button" class="sched-v2-rules-foot" tabindex="-1">Rules <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg></button>
          </div>
          <!-- Week navigator · relocated from the top ribbon to the
               far right of the V2 strip. All IDs preserved so the
               JS handlers (`rr-sched-week-prev / -today / -next /
               -range / -range-label`) keep working unchanged. -->
          <div class="hdr-undo-wrap">
        <button type="button" id="rr-undo-btn" class="hdr-undo" disabled title="Nothing to undo" aria-label="Undo last action">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a6 6 0 0 1 0 12h-4"/></svg>
          <span>Undo</span>
        </button>
        <button type="button" id="rr-undo-caret" class="hdr-undo-caret" disabled aria-label="Undo history" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div id="rr-undo-menu" class="hdr-undo-menu" hidden></div>
      </div>
          <div class="sched-week-nav" id="rr-sched-week-nav" role="group" aria-label="Week navigation">
            <button type="button" class="sched-week-nav-btn" id="rr-sched-week-prev" title="Previous week" aria-label="Previous week">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button type="button" class="sched-week-nav-today" id="rr-sched-week-today" title="Jump to this week">Today</button>
            <button type="button" class="sched-week-nav-range" id="rr-sched-week-range" title="Cycle through the next four weeks">
              <span id="rr-sched-week-range-label">This week</span>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button type="button" class="sched-week-nav-btn" id="rr-sched-week-next" title="Next week" aria-label="Next week">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>

        <!-- KPI pill row · populated by renderScheduleWeek. -->
        <div id="rr-sched-kpis" class="sched-kpi-pills tcp-kpi"></div>
        <!-- Targets KPI strip · swapped in when the Targets sub-view
             is active. Same dimensions + position as #rr-sched-kpis;
             the Targets rules (Block / Cushion / Report time) become
             individual KPI pills with inline number inputs. -->
        <div id="rr-sched-targets-kpis" class="sched-kpi-pills tcp-kpi" role="group" aria-label="Targets rules" style="display:none">
          <div class="rr-tgt-kpi">
            <div class="rr-tgt-kpi-text">
              <div class="rr-tgt-kpi-label">Block</div>
              <div class="rr-tgt-kpi-val">
                <input class="rr-tgt-kpi-input" id="rr-sched-targets-block-hours" type="number" min="1" max="14" step="1" autocomplete="off" aria-label="Block hours"/>
                <span class="rr-tgt-kpi-unit">h</span>
              </div>
            </div>
          </div>
          <div class="rr-tgt-kpi" title="Cushion adds extra SHIFTS when the week's schedule is built — it is not the staffing Plan Pad (extra hires), which lives on the OKAMI page">
            <div class="rr-tgt-kpi-text">
              <div class="rr-tgt-kpi-label">Cushion</div>
              <div class="rr-tgt-kpi-val">
                <input class="rr-tgt-kpi-input" id="rr-sched-targets-cushion-pct" type="number" min="0" max="50" step="1" autocomplete="off" aria-label="Cushion percent — extra shifts added at schedule build"/>
                <span class="rr-tgt-kpi-unit">%</span>
              </div>
            </div>
          </div>
          <div class="rr-tgt-kpi">
            <div class="rr-tgt-kpi-text">
              <div class="rr-tgt-kpi-label">Report time</div>
              <div class="rr-tgt-kpi-val">
                <input class="rr-tgt-kpi-input" id="rr-sched-targets-report-lead" type="number" min="0" max="120" step="5" autocomplete="off" aria-label="Report time minutes"/>
                <span class="rr-tgt-kpi-unit">min</span>
              </div>
            </div>
          </div>
          <!-- Wave times · pill button opening a dropdown with the wave
               start-times editor (the live node moved here from the
               quick-settings popover by _rrMoveSchedDemandToTargets). -->
          <div class="rr-tgt-kpi-menu-wrap">
            <button type="button" class="rr-tgt-kpi rr-tgt-kpi-btn" id="rr-tgt-waves-btn" aria-haspopup="true" aria-expanded="false" title="Adjust dispatch wave start times">
              <span class="rr-tgt-kpi-label">Wave times</span>
              <span class="rr-tgt-kpi-caret" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4 6 8 10 4"/></svg></span>
            </button>
            <div class="rr-tgt-kpi-menu" id="rr-tgt-waves-menu" role="group" aria-label="Wave start times" hidden>
              <div id="rr-sched-targets-waves-host"></div>
            </div>
          </div>
          <!-- Service types · pill button opening a dropdown with the
               service-type editor (also the live node from the popover). -->
          <div class="rr-tgt-kpi-menu-wrap">
            <button type="button" class="rr-tgt-kpi rr-tgt-kpi-btn" id="rr-tgt-st-btn" aria-haspopup="true" aria-expanded="false" title="Activate and rename the service types your DSP runs">
              <span class="rr-tgt-kpi-label">Service types</span>
              <span class="rr-tgt-kpi-caret" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4 6 8 10 4"/></svg></span>
            </button>
            <div class="rr-tgt-kpi-menu" id="rr-tgt-st-menu" role="group" aria-label="Service types" hidden>
              <div id="rr-sched-targets-st-host"></div>
            </div>
          </div>
          <!-- Status pill removed per operator. The per-week save status still
               surfaces via toasts / the Save Plan flow. -->
          <span id="rr-sched-targets-rules-status" aria-live="polite" hidden></span>
          <!-- Right side · Gap status card + Save Plan, then the shared
               top-right chrome (⋯ / bell / avatar) which is moved in from the
               Schedule action bar on Targets entry by _rrMoveChromeToTargets. -->
          <div class="rr-tgt-toolbar-right">
            <div class="rr-tgt-gap-card" id="rr-tgt-gap-card" hidden title="Largest weekly driver shortfall across the plan">
              <span class="rr-tgt-gap-card-label">Forecast gap</span>
              <span class="rr-tgt-gap-card-value" id="rr-tgt-gap-card-main">—</span>
              <span class="rr-tgt-gap-card-sub" id="rr-tgt-gap-card-sub" hidden></span>
            </div>
            <button type="button" class="rr-tgt-save-plan" id="rr-tgt-save-plan">Save Plan</button>
            <span class="rr-tgt-chrome-host" id="rr-tgt-chrome-host"></span>
          </div>
        </div><!-- /#rr-sched-targets-kpis -->

        <!-- TCP body · everything below this point is body content
             that scrolls inside its own container. The chrome above
             (.tcp-strip + .tcp-kpi) stays locked in place no matter
             how much body content exists or how the operator
             scrolls/interacts. -->
        <div class="tcp-body">
        <!-- Print-only mount · the Print tab clones the week grid +
             heading here, then window.print() shows just this. -->
        <div id="rr-sched-print-area" aria-hidden="true"></div>
        <!-- Quiet auto-rescue banner. Populated by
             _rrRenderAutoRescueBanner() after the auto-rescue
             trigger inside renderScheduleWeek finishes a run
             that actually displaced anyone. Calm Outlook tone —
             one sentence, lowercase verb, no exclamation. -->
        <div id="rr-sched-auto-rescue-banner" class="sched-fem-banner" hidden></div>
        <!-- Weekly recap link · opens a modal with the FEM
             digest for the visible week (audit #15). -->
        <div id="rr-sched-recap-link-wrap" class="sched-recap-link-wrap" hidden>
          <a href="#" role="button" class="sched-recap-link" id="rr-sched-recap-link">View weekly recap →</a>
        </div>
        <a href="#" role="button" class="rr-text-link" id="rr-sched-kpis-toggle" aria-pressed="true" style="display:none">Insights</a>

        <!-- INTELLIGENCE VIEWS · activated when a tile in the
             Intelligence ribbon is clicked. Each tile's
             data-rr-intel value matches the suffix of the view's
             id (e.g. data-rr-intel="risk-forecast" →
             #rr-intel-view-risk-forecast). When an intel view is
             visible, the active .sched-subview is hidden and the
             schedule's KPI strip stays in place (the intel view
             owns its own header). Click the Schedule tab to
             restore the normal schedule surfaces. -->
        <section class="rr-intel-host" id="rr-intel-host" aria-live="polite" hidden>
          <article class="rr-intel-view" id="rr-intel-view-risk-forecast" data-rr-intel-view="risk-forecast" hidden></article>
          <article class="rr-intel-view" id="rr-intel-view-hiring-pulse" data-rr-intel-view="hiring-pulse" hidden></article>
          <article class="rr-intel-view" id="rr-intel-view-what-if" data-rr-intel-view="what-if" hidden></article>
        </section>

        <!-- WEEK VIEW SUB-VIEW -->
        <div class="sched-subview active" id="sched-sub-week">

        <!-- style block 25 extracted to inline-styles.css -->
        <!-- style block 26 extracted to inline-styles.css -->

        <!-- style block 27 extracted to inline-styles.css -->

          <!-- Hidden offset-tabs strip — week selection moved to the
               sched-week-nav navigator next to the subnav, but renderScheduleWeek
               + a few helpers still read .sched-week-tab[data-rr-week-offset]
               to know which week is active, and the page-header buttons proxy
               their clicks down to the originals here. Keep the buttons in the
               DOM so those code paths continue to work; visually they're hidden. -->
          <div class="sched-toolbar-rail" hidden aria-hidden="true" style="display:none">
            <div class="sched-toolbar-cluster sched-week-tabs" id="rr-sched-week-tabs">
              <button type="button" class="sched-week-tab active" data-rr-week-offset="0">This week</button>
              <button type="button" class="sched-week-tab" data-rr-week-offset="1">Next week</button>
              <button type="button" class="sched-week-tab" data-rr-week-offset="2">In 2 weeks</button>
              <button type="button" class="sched-week-tab" data-rr-week-offset="3">In 3 weeks</button>
            </div>
            <div class="sched-toolbar-cluster">
              <button class="sched-tool-btn" id="rr-sched-smartfill" type="button" onclick="openAiSchedule()" title="Auto-staff this week from your rules + OKAMI demand">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Smart Fill
              </button>
              <button class="sched-tool-btn" id="rr-sched-okami-open" type="button" title="Route planning for this week" aria-label="Route planning">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="8 16 11 19 16 14"/></svg>
                Route planning
              </button>
              <button class="sched-tool-btn" id="rr-sched-settings-open" type="button" title="Schedule settings for this week" aria-label="Schedule settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                Settings
              </button>
              <button class="sched-tool-btn" id="schedule-cta" type="button" title="Push this week's schedule to drivers">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                Finalize
              </button>
            </div>
          </div>

          <!-- ── Header action bar (operator mockup 2026-06-12) ──────────
               Pill actions above the week grid. Every button drives the
               SAME hidden legacy controls the sidebar children use (see
               the rrSchedNav BTN map in index.html) — no new action code
               paths:
                 Smart Fill     → #rr-sched-smartfill-h (badge = open routes)
                 Assign Fleet   → #rr-sched-vans-h when the week is unassigned
                 Unassign Fleet → #rr-sched-vans-h when assignments exist
                 Finalize       → #rr-sched-finalize-h
                 ⋯ menu         → #rr-sched-print-btn / #rr-sched-download-btn
               The coverage card + Smart Fill badge are painted by
               renderScheduleWeek (live.js) alongside the day-header
               coverage pass, from the same fillByDate data. -->
          <div class="rr-ab" id="rr-sched-actionbar" role="toolbar" aria-label="Schedule actions">
            <!-- DRIVER label + week navigator lead the bar (mockup). The
                 Today / prev / next buttons are live nodes — live.js
                 re-parents #rr-sched-week-nav into #rr-ab-weeknav (its
                 bound listeners ride along), the same relocation it
                 previously did into the grid's corner cell. -->
            <!-- DRIVER label removed (operator request 2026-06-12) — the
                 bar leads with the week navigator, all controls
                 left-justified. -->
            <span class="rr-ab-weeknav" id="rr-ab-weeknav"></span>
            <button type="button" class="rr-ab-btn" id="rr-ab-smartfill" title="Build this week's schedule from your rules + OKAMI demand">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="13" y2="17"/></svg>
              Build Schedule
              <span class="rr-ab-badge" id="rr-ab-sf-badge" hidden>0</span>
              <span class="rr-ab-caret" id="rr-ab-smartfill-caret" role="button" tabindex="0" title="Schedule rules" aria-haspopup="dialog">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </span>
            </button>
            <button type="button" class="rr-ab-btn" id="rr-ab-assign" title="Auto-assign vans for this week using the standing primary / backup chain">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="13" height="10" rx="1.2"/><path d="M15 8h4l3 3v4h-7z"/><line x1="2" y1="15" x2="22" y2="15"/><circle cx="6.5" cy="16.5" r="1.6"/><circle cx="17.5" cy="16.5" r="1.6"/></svg>
              Assign Fleet
              <span class="rr-ab-caret" id="rr-ab-assign-caret" role="button" tabindex="0" title="Open the van / driver chain editor" aria-haspopup="true">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </span>
            </button>
            <div class="rr-ab-coverage" id="rr-ab-coverage" hidden>
              <span class="rr-ab-coverage-main" id="rr-ab-coverage-main"></span>
              <span class="rr-ab-coverage-sub" id="rr-ab-coverage-sub"></span>
            </div>
            <button type="button" class="rr-ab-btn rr-ab-primary" id="rr-ab-finalize" title="Push this week's schedule to drivers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Finalize
            </button>
            <div class="rr-ab-more-wrap">
              <button type="button" class="rr-ab-btn rr-ab-more" id="rr-ab-more" aria-haspopup="menu" aria-expanded="false" title="More schedule actions">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
              </button>
              <div class="rr-ab-menu" id="rr-ab-menu" role="menu" hidden>
                <button type="button" role="menuitem" data-rr-ab-fire="rr-sched-print-btn">Print schedule</button>
                <button type="button" role="menuitem" data-rr-ab-fire="rr-sched-download-btn">Download Excel</button>
              </div>
            </div>
          </div>
          <script>
            // Action-bar wiring · delegates to the proven hidden legacy
            // buttons (the same path the sidebar children use). Assign /
            // Unassign split the #rr-sched-vans-h toggle by checking its
            // rrAssigned state so each pill always does what it says.
            (function () {
              var fire = function (id) { var b = document.getElementById(id); if (b) b.click(); };
              var say  = function (msg) { if (typeof window.toast === "function") window.toast(msg); };
              var on   = function (id, fn) { var b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
              on("rr-ab-smartfill", function (e) {
                if (e.target.closest("#rr-ab-smartfill-caret")) return; // caret owns its click
                fire("rr-sched-smartfill-h");
              });
              on("rr-ab-smartfill-caret", function (e) {
                e.stopPropagation();
                // Small menu first (Smart Rules / Schedule Colors); each
                // entry re-parents its box under the action bar and opens
                // it anchored to the Smart Fill button.
                if (window._rrShowSfMenu) window._rrShowSfMenu(document.getElementById("rr-ab-smartfill"));
              });
              on("rr-ab-finalize",  function () { fire("rr-sched-finalize-h"); });
              on("rr-ab-assign", function (e) {
                if (e.target.closest("#rr-ab-assign-caret")) return; // caret owns its click
                // Single toggle: #rr-sched-vans-h assigns when the week is clear
                // and unassigns when vans are already assigned. The pill label
                // (Assign / Unassign Fleet) is kept in sync by
                // _refreshAssignVansLabel in live.js.
                fire("rr-sched-vans-h");
              });
              on("rr-ab-assign-caret", function (e) {
                e.stopPropagation();
                // Open the Van rules dropdown under this button (the
                // chain editor stays reachable via the link inside it).
                var ab = document.getElementById("rr-sched-actionbar");
                var pop = document.getElementById("rr-sched-vans-rules-popover");
                if (ab && pop && pop.parentElement !== ab) ab.appendChild(pop);
                var anchorBtn = document.getElementById("rr-ab-assign");
                if (pop && anchorBtn) {
                  // Anchor the popout directly under the Assign/Unassign Fleet
                  // button. Fixed coords set with !important so they beat the
                  // stylesheet's `right:0 !important`, which otherwise pinned
                  // the popout to the far right of the action bar.
                  var r = anchorBtn.getBoundingClientRect();
                  pop.style.setProperty("position", "fixed", "important");
                  pop.style.setProperty("top", (r.bottom + 6) + "px", "important");
                  pop.style.setProperty("left", r.left + "px", "important");
                  pop.style.setProperty("right", "auto", "important");
                }
                if (window._rrToggleSchedVanRules) window._rrToggleSchedVanRules();
              });
              var more = document.getElementById("rr-ab-more");
              var menu = document.getElementById("rr-ab-menu");
              if (more && menu) {
                more.addEventListener("click", function (e) {
                  e.stopPropagation();
                  menu.hidden = !menu.hidden;
                  more.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
                });
                menu.addEventListener("click", function (e) {
                  var b = e.target.closest("[data-rr-ab-fire]");
                  if (!b) return;
                  menu.hidden = true;
                  fire(b.getAttribute("data-rr-ab-fire"));
                });
                document.addEventListener("click", function (e) {
                  if (!menu.hidden && !e.target.closest(".rr-ab-more-wrap")) menu.hidden = true;
                });
              }
            })();
          </script>

          <div class="builder-shell">
          <!-- Calendar grid -->
          <div class="cal-wrap">
            <div class="cal-grid head">
              <div class="cal-cell-head" style="display:flex;align-items:center;gap:6px;position:relative">
                <span id="rr-sched-row-label">Driver</span>
                <!-- 4-column · 2-row icon grid · operator wanted the
                     header icons laid out 4 across, with a second
                     row that will fill in as more icons land. Items
                     flow row-first (4 → next row), so the existing
                     5 icons render as 4 on top + 1 on the bottom
                     until more are added. -->
                <div class="rr-sched-driver-actions" style="display:grid;grid-template-columns:repeat(4, auto);grid-auto-rows:auto;gap:4px;margin-left:auto;align-items:center;justify-items:center">
                  <!-- Focus mode · hides page chrome so the grid + open
                       shifts fill the screen (Esc exits). Toggles
                       body.rr-sched-focus; the click handler (live.js
                       #rr-sched-focus-toggle) and styling (schedule-rrx.css)
                       are already live. The .ic-focus-on/-off SVGs swap when
                       focus engages. Restored to the driver header with the
                       other subtle icons per operator request. -->
                  <button class="rr-tf-icon" id="rr-sched-focus-toggle" type="button"
                          title="Focus mode — hide page chrome so the schedule fills the screen (Esc to exit)"
                          aria-label="Focus mode" aria-pressed="false"
                          style="position:relative;top:0;right:0">
                    <svg class="ic-focus-on" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
                    <svg class="ic-focus-off" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>
                  </button>
                  <!-- Hide / show the Open shifts rail. Unlike Focus mode
                       (which hides all page chrome), this only collapses the
                       right-hand Open shifts box so the grid fills that space.
                       Toggles body.rr-sched-hide-openshifts; persisted in
                       localStorage('rr-sched-hide-openshifts'). -->
                  <!-- Operations Health show/hide moved to the right utility
                       rail's shield button (data-rr-ophealth-toggle). -->

                  <button class="rr-tf-icon" id="rr-sched-compact-toggle" type="button"
                          title="Grid density — click to cycle Standard / Compact / Ultra-compact"
                          aria-label="Grid density (click to cycle)" aria-pressed="false"
                          style="position:relative;top:0;right:0">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="15" x2="20" y2="15"/></svg>
                  </button>
                  <button class="rr-tf-icon" id="rr-sched-driver-sort-toggle" type="button"
                          title="Sort drivers" aria-label="Sort drivers"
                          style="position:relative;top:0;right:0">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="13" y2="6"/><line x1="3" y1="12" x2="11" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/><polyline points="17 8 21 12 17 16"/><line x1="14" y1="12" x2="21" y2="12"/></svg>
                  </button>
                  <!-- "Show pinned only" filter · dims everything except
                       pinned (locked) shifts so the fixed schedule pops.
                       Toggles via _rrToggleSchedPinnedOnly (live.js);
                       state persists in localStorage('rr-sched-pinned-only'). -->
                  <button class="rr-tf-icon" id="rr-sched-pinned-only-btn" type="button"
                          title="Show pinned only — dim everything except pinned shifts"
                          aria-label="Show pinned only" aria-pressed="false"
                          style="position:relative;top:0;right:0">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6"/><path d="M10 4v5.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 6 14.24V15h12v-.76a2 2 0 0 0-1.11-1.8l-1.78-.89A2 2 0 0 1 14 9.76V4"/><line x1="12" y1="15" x2="12" y2="21"/></svg>
                  </button>
                  <!-- Staff view toggle · flips the grid from "every
                       driver" to "only drivers with at least one
                       assigned shift this week" so the operator can
                       see just the staff actually working. Same grid,
                       same chips, just a row-level filter. Click
                       again to flip back. State stored in
                       localStorage('rr-sched-staff-only'). -->
                  <button class="rr-tf-icon" id="rr-sched-staff-view-toggle" type="button"
                          title="Staff view — show only drivers with at least one shift this week"
                          aria-label="Staff view" aria-pressed="false"
                          style="position:relative;top:0;right:0">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11l-3-3"/><path d="M22 8l-3 3"/></svg>
                  </button>
                  <!-- Unassign all shifts this week · header-icon twin of the
                       Open-shifts pool button. Clears every driver assignment
                       for the visible week (shifts stay; only the driver
                       assignments are cleared). Handler in live.js keys on
                       #rr-sched-unassign-week-icon → _runUnassignAllShiftsForWeek. -->
                  <button class="rr-tf-icon" id="rr-sched-unassign-week-icon" type="button"
                          title="Unassign all shifts this week — clears every driver assignment (shifts stay)"
                          aria-label="Unassign all shifts this week"
                          style="position:relative;top:0;right:0">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/></svg>
                  </button>
                  <!-- Weather forecast overlay · flips each day header from the
                       date + coverage/route counts to a single forecast glyph
                       (sun / cloud / rain / storm / snow / heat / cold / wind)
                       so the operator can read the week's weather at a glance.
                       Toggles body.rr-sched-weather; state persists in
                       localStorage('rr-sched-weather'). Forecast comes from the
                       DSP's NWS point (same source as the dashboard weather
                       card); handler + rendering live in live.js keyed on
                       #rr-sched-weather-toggle. -->
                  <button class="rr-tf-icon" id="rr-sched-weather-toggle" type="button"
                          title="Weather forecast — show each day's forecast instead of the date and route counts"
                          aria-label="Show weather forecast on day headers" aria-pressed="false"
                          style="position:relative;top:0;right:0">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/><path d="M17.5 20H10a3.5 3.5 0 0 1-.3-6.98A5 5 0 0 1 19 14.2a3 3 0 0 1-1.5 5.8z"/></svg>
                  </button>
                </div>
              </div>
              <div class="cal-cell-head today">Tue<span class="day-num">1</span></div>
              <div class="cal-cell-head">Wed<span class="day-num">2</span></div>
              <div class="cal-cell-head">Thu<span class="day-num">3</span></div>
              <div class="cal-cell-head">Fri<span class="day-num">4</span></div>
              <div class="cal-cell-head">Sat<span class="day-num">5</span></div>
              <div class="cal-cell-head">Sun<span class="day-num">6</span></div>
              <div class="cal-cell-head">Mon<span class="day-num">7</span></div>
            </div>

            <!-- Grid rows render here. renderScheduleWeek owns everything
                 below the .head row (driver rows, open-shift rows, coverage
                 strip); _clearScheduleMockup shows a loading skeleton until
                 the first paint. No static sample rows may ship here. -->
          </div>

          <!-- Right rail: Open Shifts panel lives inside the Driver pool footer;
               the Driver pool keeps its existing click-to-assign markup. -->
          <div class="sched-right-rail">
          <!-- DRIVER POOL — drag-to-assign or click to insert -->
          <aside class="driver-pool">
            <div class="pool-head">
              <span>Driver pool</span>
            </div>
            <input class="pool-search" placeholder="Search drivers…" />

            <!-- Pre-render placeholder only. renderSchedOpenShiftsPool /
                 renderScheduleWeek replace this aside's contents with the
                 real pool as soon as schedule data loads — no sample
                 drivers may ever appear here. -->
            <div>
              <div class="pool-section-label">Loading drivers…</div>
            </div>

            <!-- Open-shifts footer · status-aware. renderScheduleWeek
                 rewrites the inner markup based on totalAllOpen so it
                 shows either the "All shifts are covered" empty state
                 from the mockup or a count + manage button. -->
            <!-- Operations Health · weekly KPIs as compact rows (replaces the
                 old horizontal strip + Open-shifts box). Populated by
                 renderScheduleWeek; rows keep data-rr-kpi so the KPI
                 drill-downs still fire. -->
            <div class="sched-ophealth" id="rr-sched-ophealth">
              <div class="sched-ophealth-head">
                <div class="sched-ophealth-title">Operations Health</div>
                <div class="sched-ophealth-sub" id="rr-sched-ophealth-sub"></div>
              </div>
              <div class="sched-ophealth-rows" id="rr-sched-ophealth-rows"></div>
            </div>
          </aside>
          </div><!-- /sched-right-rail -->
          </div><!-- /builder-shell -->

        </div><!-- /sched-sub-week -->

        <!-- ADVANCED SETTINGS · inline sub-view holding the per-week
             advanced controls (Availability override, Preferred-day
             tiebreaker, Wave start times, Service types).  Reached
             from the "Advanced settings…" link in the inline quick-
             settings popover. -->
        <!-- (Advanced settings now expand inline inside the Settings
             tile's quick-edit popover, not as a full sub-view. The
             previous #sched-sub-advanced is removed.) -->

        <!-- Legacy drawer aside kept hidden in the DOM so old click
             handlers (#rr-sched-settings-backdrop, #rr-sched-settings-close)
             don't throw. Nothing renders inside it anymore. -->
        <div id="rr-sched-settings-backdrop" class="rr-drawer-backdrop" hidden></div>
        <aside id="sched-sub-settings" class="rr-drawer" hidden aria-hidden="true" aria-label="Schedule settings (legacy)"></aside>

        <!-- SMART FILL SUB-VIEW · audit page listing every rule Smart Fill
             reads when staffing the week.  Edit the underlying values
             in their respective surfaces (Settings / Rules / DSP defaults). -->
        <div class="sched-subview" id="sched-sub-smartfill" style="display:none">
          <div class="card" style="padding:var(--s-5);max-width:920px">
            <div class="u-mb-4">
              <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">Smart Fill · rules in effect</div>
              <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Every constraint Smart Fill consults when assigning drivers to shifts. Edit values in the linked surfaces; Smart Fill picks them up on the next run.</div>
            </div>

            <!-- 1. Hard gates (skip a driver if they fail) -->
            <div class="u-mb-4">
              <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:var(--s-2)">Hard gates · skip a driver who fails any of these</div>
              <div class="rules-sub-body" style="display:flex;flex-direction:column;gap:var(--s-2)">
                <div class="rule-row"><div><div class="rule-label">Driver status = active or onboarding</div><div class="rule-help">Inactive / on leave / terminated drivers never auto-fill.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Driver's license valid through the shift date</div><div class="rule-help">Drivers whose DL expires before the shift are skipped. Always enforced — see <a href="#" onclick="gotoSettingsScheduling();return false;">Settings → Scheduling</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">DOT certification — required for Step Van routes</div><div class="rule-help">A driver without <code>dot_certified</code> on their record cannot be auto-filled into a shift whose service type carries <code>requires_dot</code>. Step Vans is the seeded example. Set the flag in the driver record's DOT tab.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">XL certification — required for Extra-Large routes</div><div class="rule-help">A driver without <code>xl_certified</code> on their record cannot be auto-filled into a shift whose service type carries <code>requires_xl</code>. XL is the seeded example. Set the flag in the driver record's DOT tab (XL toggle).</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">EDV certification — required for Electric Vans</div><div class="rule-help">A driver without <code>edv_certified</code> on their record cannot be auto-filled into a shift whose service type carries <code>requires_edv</code>. Electric Vans is the seeded example. Set the flag in the driver record's DOT tab (EDV toggle).</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Driver hasn't already worked the max days this week</div><div class="rule-help">Cap from <a href="#" onclick="openSchedSettingsDrawer();return false;">Settings → Max days per week</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Driver's saved availability includes this day-of-week</div><div class="rule-help">Bypass via the <em>Allow availability override</em> toggle in <a href="#" onclick="openSchedSettingsDrawer();return false;">Settings</a> for tight weeks.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Driver isn't on approved time-off for this date</div><div class="rule-help">Approved PTO blocks the auto-fill from picking the driver. Live data from time-off requests.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
              </div>
            </div>

            <!-- 2. Soft preferences (tie-breakers) -->
            <div class="u-mb-4">
              <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:var(--s-2)">Tie-breakers · when multiple drivers qualify</div>
              <div class="rules-sub-body" style="display:flex;flex-direction:column;gap:var(--s-2)">
                <div class="rule-row"><div><div class="rule-label">Driver priority list</div><div class="rule-help">Tier · tenure · attendance · fewest hours. Reordering UI lands in an upcoming release.</div></div><span class="rules-sub-badge">Preview</span></div>
                <div class="rule-row"><div><div class="rule-label">Cushion %</div><div class="rule-help">Smart Fill staffs the OKAMI demand × (1 + cushion %). Edit in <a href="#" onclick="openSchedSettingsDrawer();return false;">Settings → Cushion</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Default block length (hours)</div><div class="rule-help">Per-shift duration. Edit in <a href="#" onclick="openSchedSettingsDrawer();return false;">Settings → Default block length</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Wave start times</div><div class="rule-help">Each shift's start time follows the active wave list in <a href="#" onclick="openSchedSettingsDrawer();return false;">Settings → Wave start times</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Active service types</div><div class="rule-help">Only the route categories you've activated in <a href="#" onclick="openSchedSettingsDrawer();return false;">Settings → Service types</a> are auto-filled.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
              </div>
            </div>

            <!-- 3. Working-hour limits -->
            <div class="u-mb-4">
              <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:var(--s-2)">Working-hour limits · safety + compliance</div>
              <div class="rules-sub-body" style="display:flex;flex-direction:column;gap:var(--s-2)">
                <div class="rule-row"><div><div class="rule-label">Max hours per driver per week</div><div class="rule-help">Hard cap. Default <strong>55h</strong>. Edit in <a href="#" onclick="gotoSettingsScheduling();return false;">Settings → Scheduling → Working hour limits</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Max consecutive working days · rolling</div><div class="rule-help">Default <strong>6 days</strong>. Walks back into the prior week.</div></div><span class="rules-sub-badge">Preview</span></div>
                <div class="rule-row"><div><div class="rule-label">Minimum rest between shifts</div><div class="rule-help">Default <strong>10 hours</strong>.</div></div><span class="rules-sub-badge">Preview</span></div>
              </div>
            </div>

            <!-- 4. Attendance + geofence (Rules tab) -->
            <div>
              <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:var(--s-2)">Attendance &amp; check-in</div>
              <div class="rules-sub-body" style="display:flex;flex-direction:column;gap:var(--s-2)">
                <div class="rule-row"><div><div class="rule-label">Attendance windows</div><div class="rule-help">Tardy / no-show grace times for check-in. <a href="#" onclick="gotoSettingsScheduling();return false;">Edit in Settings → Scheduling</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
                <div class="rule-row"><div><div class="rule-label">Station geofence radius</div><div class="rule-help">Drivers can only check in inside the geofence. <a href="#" onclick="gotoSettingsScheduling();return false;">Edit in Settings → Scheduling</a>.</div></div><span class="rules-sub-badge ok">Enforced</span></div>
              </div>
            </div>
          </div>
        </div><!-- /sched-sub-smartfill -->

        <!-- BY DRIVER SUB-VIEW (full driver list with current week summary) -->
        <!-- The legacy static "By driver" and "Availability matrix" mockup
             sub-views were removed: nothing routes to them and they only
             contained sample data. -->

        <!-- SWAPS · the static mock "Pending swaps" subview (fake names/data,
             nothing routed to it) was removed 2026-07-17. The LIVE swaps &
             covers queue renders inside the Requests subview
             (#rr-sched-swaps-panel, _renderSchedSwapsPanel in live.js). -->

        <!-- AVAILABILITY MATRIX -->
        <!-- (Static "4-week coverage forecast" mockup removed — unreachable,
             sample data only. The live forecast lives on Targets/OKAMI.) -->

        <div class="sched-subview" id="sched-sub-templates" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:var(--s-4);margin-bottom:var(--s-4);flex-wrap:wrap">
            <div>
              <h2 style="margin:0;font-size:18px;font-weight:700;color:var(--text)">Templates</h2>
              <p style="margin:4px 0 0;font-size:var(--fs-sm);color:var(--text-muted);max-width:560px;line-height:1.55">Save a week you're happy with as a template, then paste it into any future week. Skipped automatically when a date/driver pair already has a shift. Use <em>overwrite</em> only to re-paste over previously template-sourced shifts — your manual edits are preserved either way.</p>
            </div>
            <button class="btn btn-primary btn-sm" id="rr-tpl-capture-btn" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Save this week as template
            </button>
          </div>
          <div id="rr-tpl-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--s-3)"></div>
        </div><!-- /sched-sub-templates -->

        <!-- REQUESTS · unified request stream (PTO + Unpaid + Availability)
             on the left, three operational reports on the right.
             Rendered by _renderSchedRequestsActive. -->
        <div class="sched-subview" id="sched-sub-requests" style="display:none">
          <!-- Inline drill-down panel for the Requests KPI strip.
               Hidden by default; _renderSchedReqDrilldown unhides it
               when a KPI pill is clicked. -->
          <div id="rr-sched-req-drilldown" class="rr-sched-req-drilldown" hidden></div>
          <!-- Filter controls + PTO report (Type / Status / Location). Populated
               by _renderSchedRequestsKpis; lives here (not the shared KPI strip)
               so the schedule's display:none on that strip can't hide it. -->
          <div class="req-toolbar-bar" id="rr-req-toolbar-bar"></div>
          <!-- Split screen · LEFT = one unified request stream (PTO,
               Unpaid time off and Availability changes merged into a
               single chronological queue). RIGHT = three equally-sized
               operational reports. Both render at once via
               _renderSchedRequestsActive. -->
          <div class="sched-requests-split">
            <section class="sched-requests-card" id="rr-sched-req-stream-panel">
              <div class="sched-requests-card-body" id="rr-sched-req-stream"><div class="rr-loading">Loading requests…</div></div>
            </section>
          </div>
        </div><!-- /sched-sub-requests -->

        <!-- ROSTER + ATTENDANCE · in-page schedule sub-views.
             These host the same portable Drivers sub-views
             (#dr-sub-roster / #dr-sub-attendance) that the
             Onboarding-ops roster mode embeds. On schedSub('roster')
             / schedSub('attendance') the shared #ob-roster-mount node
             is relocated into the matching host below and
             _obMountDriverSub() moves the live Drivers sub-view into
             it (with its CSS alias intact). Switching to any other
             schedule sub-view (or leaving Schedule) restores the
             Drivers node and parks #ob-roster-mount back in
             Onboarding. The mount itself is a single relocatable node,
             so it can never live in two places at once. -->
        <div class="sched-subview" id="sched-sub-roster" style="display:none"></div>
        <div class="sched-subview" id="sched-sub-attendance" style="display:none"></div>

        <!-- (Legacy time-off sub-view, kept hidden so any older callers
             that still target #sched-sub-time-off don't throw.) -->
        <div class="sched-subview" id="sched-sub-time-off" style="display:none"></div>

        <!-- Smart Fill · full-page settings view. Hidden until the
             "Smart Fill" sidebar item opens it (live.js _rrOpenSmartFillPage).
             The Rules + Schedule Colors popovers are re-homed into
             #rr-smartfill-page-body as inline sections (.rr-as-page) and
             returned to the action bar when the page closes. -->
        <div id="rr-smartfill-page" class="rr-smartfill-page" hidden>
          <div class="rr-sf-page-head">
            <div class="rr-sf-page-headings">
              <div class="rr-sf-page-title">Smart Fill Policy</div>
              <div class="rr-sf-page-sub">Tell Smart Fill how to build the best schedules for your DSP.</div>
            </div>
            <button type="button" class="rr-sf-page-done" onclick="window._rrCloseSmartFillPage && window._rrCloseSmartFillPage()">Done</button>
          </div>
          <div class="rr-sf-page-body" id="rr-smartfill-page-body">

            <!-- 1 · Preset cards. Each control is a thin facade over the same
                 policy blob the detailed editor writes (new rr-sfp-* ids, wired
                 in live.js _rrPaintSmartFillCards + its change handler). -->
            <div class="rr-sf-cards3">

              <!-- Work Limits -->
              <div class="rr-sf-card rr-sf-mini">
                <div class="rr-sf-mini-head">
                  <span class="rr-sf-mini-ic rr-sf-ic-limits" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="12.5" rx="2"/><line x1="3" y1="8" x2="17" y2="8"/><line x1="7" y1="2.5" x2="7" y2="6"/><line x1="13" y1="2.5" x2="13" y2="6"/></svg></span>
                  <div class="rr-sf-mini-titles">
                    <div class="rr-sf-mini-title">Work Limits</div>
                    <div class="rr-sf-mini-sub">Set the boundaries for driver work schedules.</div>
                  </div>
                </div>
                <div class="rr-sf-field">
                  <label for="rr-sfp-maxdays">Max Days Per Week</label>
                  <select id="rr-sfp-maxdays" class="rr-sf-input">
                    <option value="4">4 days</option>
                    <option value="5">5 days</option>
                    <option value="6">6 days</option>
                  </select>
                </div>
                <div class="rr-sf-field">
                  <label for="rr-sfp-consec">Max Consecutive Days</label>
                  <select id="rr-sfp-consec" class="rr-sf-input">
                    <option value="4">4 days</option>
                    <option value="5">5 days</option>
                    <option value="6">6 days</option>
                  </select>
                </div>
                <div class="rr-sf-field">
                  <label for="rr-sfp-fifth">5th Day Overtime</label>
                  <select id="rr-sfp-fifth" class="rr-sf-input">
                    <option value="off">Off</option>
                    <option value="allow">Allow If Needed</option>
                    <option value="require">Required</option>
                  </select>
                </div>
                <button type="button" class="rr-sf-edit" data-rr-sf-edit="limits">Edit <span aria-hidden="true">›</span></button>
              </div>

              <!-- Driver Preferences -->
              <div class="rr-sf-card rr-sf-mini">
                <div class="rr-sf-mini-head">
                  <span class="rr-sf-mini-ic rr-sf-ic-prefs" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="2.6"/><path d="M2.5 16c0-2.5 2-4.2 4.5-4.2S11.5 13.5 11.5 16"/><path d="M13 5.2a2.4 2.4 0 0 1 0 4.4"/><path d="M14 11.9c1.9.3 3.5 1.8 3.5 4.1"/></svg></span>
                  <div class="rr-sf-mini-titles">
                    <div class="rr-sf-mini-title">Driver Preferences</div>
                    <div class="rr-sf-mini-sub">Control how strongly Smart Fill respects requests.</div>
                  </div>
                </div>
                <div class="rr-sf-field">
                  <label for="rr-sfp-preferred">Preferred Days Off</label>
                  <select id="rr-sfp-preferred" class="rr-sf-input">
                    <option value="prefer">Prefer</option>
                    <option value="ignore">Ignore</option>
                  </select>
                </div>
                <button type="button" class="rr-sf-edit" data-rr-sf-edit="prefs">Edit <span aria-hidden="true">›</span></button>
              </div>

              <!-- Safety & Compliance -->
              <div class="rr-sf-card rr-sf-mini">
                <div class="rr-sf-mini-head">
                  <span class="rr-sf-mini-ic rr-sf-ic-safety" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5l6 2.3v4.4c0 3.9-2.5 6.6-6 8.3-3.5-1.7-6-4.4-6-8.3V4.8z"/><path d="M7.4 10l1.8 1.8L13 8"/></svg></span>
                  <div class="rr-sf-mini-titles">
                    <div class="rr-sf-mini-title">Safety &amp; Compliance</div>
                    <div class="rr-sf-mini-sub">Ensure schedules follow safety and policy rules.</div>
                  </div>
                </div>
                <div class="rr-sf-field">
                  <label for="rr-sfp-rest">Minimum Rest Between Shifts</label>
                  <select id="rr-sfp-rest" class="rr-sf-input">
                    <option value="8">8 hours</option>
                    <option value="10">10 hours</option>
                    <option value="12">12 hours</option>
                  </select>
                </div>
                <button type="button" class="rr-sf-edit" data-rr-sf-edit="safety">Edit <span aria-hidden="true">›</span></button>
              </div>

            </div><!-- /rr-sf-cards3 -->

            <!-- Advanced rule cards — promoted onto the page at the same level
                 and card style as the preset row above (no "Advanced Rules"
                 box). Per-card "N active" counts come from _rrSfAdvCounts();
                 each card's Edit opens that section's settings inline. -->
            <div class="rr-sf-cards3">

                  <!-- Schedule Quality -->
                  <div class="rr-sf-card rr-sf-mini">
                    <div class="rr-sf-mini-head">
                      <span class="rr-sf-mini-ic rr-sf-ic-quality" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5l2.2 4.4 4.8.7-3.5 3.4.8 4.8L10 13.9l-4.3 2.3.8-4.8L3 8l4.8-.7z"/></svg></span>
                      <div class="rr-sf-mini-titles">
                        <div class="rr-sf-mini-title">Schedule Quality</div>
                        <div class="rr-sf-mini-sub">Stability, preferred days, and corrective-driver ordering.</div>
                      </div>
                    </div>
                    <span class="rr-sf-active-pill" data-rr-sf-count="quality">0 active</span>
                    <button type="button" class="rr-sf-edit" data-rr-sf-edit="quality">Edit <span aria-hidden="true">›</span></button>
                  </div>

                  <!-- Route Assignment -->
                  <div class="rr-sf-card rr-sf-mini">
                    <div class="rr-sf-mini-head">
                      <span class="rr-sf-mini-ic rr-sf-ic-route" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16c-1.7 0-3-1.3-3-3s1.3-3 3-3h8c1.7 0 3-1.3 3-3s-1.3-3-3-3H5"/><circle cx="5" cy="5" r="1.9"/><circle cx="15" cy="15" r="1.9"/></svg></span>
                      <div class="rr-sf-mini-titles">
                        <div class="rr-sf-mini-title">Route Assignment</div>
                        <div class="rr-sf-mini-sub">Driver eligibility and van-assignment gates.</div>
                      </div>
                    </div>
                    <span class="rr-sf-active-pill" data-rr-sf-count="route">0 active</span>
                    <button type="button" class="rr-sf-edit" data-rr-sf-edit="route">Edit <span aria-hidden="true">›</span></button>
                  </div>

                  <!-- Optimization -->
                  <div class="rr-sf-card rr-sf-mini">
                    <div class="rr-sf-mini-head">
                      <span class="rr-sf-mini-ic rr-sf-ic-optimization" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 10a7 7 0 1 1-2.2-5.1"/><polyline points="17 3 17 7 13 7"/></svg></span>
                      <div class="rr-sf-mini-titles">
                        <div class="rr-sf-mini-title">Optimization</div>
                        <div class="rr-sf-mini-sub">Engine priorities and overtime balance.</div>
                      </div>
                    </div>
                    <span class="rr-sf-active-pill" data-rr-sf-count="optimization">0 active</span>
                    <button type="button" class="rr-sf-edit" data-rr-sf-edit="optimization">Edit <span aria-hidden="true">›</span></button>
                  </div>

            </div><!-- /rr-sf-cards3 (advanced) -->

            <!-- Detailed editor — the existing Rules + Schedule Colors
                 popovers are re-homed here (live.js _rrOpenSmartFillPage) and
                 stay hidden until an Edit / View-all link reveals them. -->
            <div class="rr-sf-detail" id="rr-sf-detail" hidden></div>

          </div><!-- /rr-sf-page-body -->

          <!-- Sticky footer — save state + actions. -->
          <div class="rr-sf-page-foot">
            <div class="rr-sf-foot-saved">
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="7"/><polyline points="5.8 9.2 8 11.4 12.4 6.6"/></svg>
              <span id="rr-sf-saved-label">All changes saved locally</span>
            </div>
            <div class="rr-sf-foot-actions">
              <button type="button" class="rr-sf-foot-reset" id="rr-sf-reset">Reset to Default</button>
              <button type="button" class="rr-sf-foot-save" id="rr-sf-save">Save Policy</button>
            </div>
          </div>
        </div>


        <!-- TODAY VIEW — single-day roster.  Left-justified vertical
             list of every driver scheduled for the selected day.  No
             right rail / open-shifts panel.  Populated by
             renderSchedTodayView() in live.js. -->
        <div class="sched-subview" id="sched-sub-today" style="display:none">
          <!-- Schedule's Today sub-view is a mount-point for the
               dashboard's "Today's Plan" shell. When this sub-view
               becomes active, renderSchedTodayView moves the same
               #rr-today-plan-shell node here so the operator sees
               the canonical today's roster with all the dashboard's
               logic + auto-refresh + realtime hooks intact. When the
               sub-view is left, the shell returns to its anchor in
               #view-dashboard. -->
          <div id="rr-sched-today-plan-host">
            <div class="rr-loading">Loading today's plan…</div>
          </div>
        </div><!-- /sched-sub-today -->

        <!-- TARGETS · in-page per-week route-planning editor. Hosts
             the same OKAMI daily-detail panel that #view-okami shows
             for week-0, rendered here so the operator stays on the
             schedule page. Three Block / Cushion / Report-time
             inputs at the top mirror the schedule's quick-settings
             popover + the OKAMI page's embedded toolbar (all three
             surfaces share scheduling_settings_for_week). Body
             populated by renderScheduleTargetsSubView() in live.js
             on schedSub('targets'). -->
        <div class="sched-subview" id="sched-sub-targets" style="display:none">
          <!-- style block 28 extracted to inline-styles.css -->
          <!-- The wave start-times + service-type editors live in the
               "Wave times" / "Service types" pill dropdowns up in the
               #rr-sched-targets-kpis strip (moved there from the
               quick-settings popover by _rrMoveSchedDemandToTargets). -->
          <!-- 13-week OKAMI planner host · the live OKAMI table is
               moved here at runtime by _rrMoveOkami13Week() on entry
               and returned to #view-okami on exit. -->
          <section class="rr-tgt-13w" id="rr-sched-targets-13week" aria-label="13-week route planner">
            <div class="rr-tgt-13w-head">
              <div>
                <div class="rr-tgt-13w-title">
                  Targets
                  <span class="rr-tgt-13w-badge" title="Amazon's term for the 13-week DSP route plan horizon">13-week plan</span>
                </div>
                <p class="rr-tgt-13w-sub">Model route demand and staffing requirements.</p>
              </div>
            </div>
            <div id="rr-sched-targets-13week-host">
              <div class="rr-tgt-13w-empty">Loading 13-week plan…</div>
            </div>
          </section>

        </div><!-- /sched-sub-targets -->

        <!-- VAN ASSIGNMENTS · auto-assign result view. The action-
             strip Assign Vans tile triggers today_roster_auto_assign
             for each day in the week and populates this view with a
             summary + per-day cards. -->
        <div class="sched-subview" id="sched-sub-vans" style="display:none">
          <div id="rr-sched-vans-body">
            <div class="rr-loading">Loading van assignments…</div>
          </div>
        </div><!-- /sched-sub-vans -->

        <!-- FLEET CALENDAR · month grid for free-form scheduled events.
             Populated by renderFleetCalendar() in live.js; events are
             DSP-scoped and persist via the fleet_calendar_events table
             (migration 0306). -->
        <!-- ── MONTHLY VIEW · weeks-down-the-left, days-across-the-top
             month-at-a-glance grid. Filled by renderSchedMonthlyView
             in live.js when schedSub('monthly') runs. The grid is
             sized to fill the viewport without scrolling — cells
             flex evenly within the available row height. -->
        <div class="sched-subview" id="sched-sub-monthly" style="display:none">
          <!-- Forecast action bar — same pill style/size as the Schedule view's
               action bar (.rr-ab / .rr-ab-btn). The Forecast button runs the
               staffing forecast (sizes Required Drivers / Driver Gap); wired by
               a delegated handler on #rr-fc-run in live.js. -->
          <div class="rr-ab" role="toolbar" aria-label="Forecast actions">
            <button type="button" class="rr-ab-btn" id="rr-fc-run" title="Run the staffing forecast to size required drivers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>
              Forecast
            </button>
          </div>
          <!-- Workforce planner: the 13-week table with the Driver Gap chart. -->
          <div class="rr-fc-layout" id="rr-fc-layout">
            <div class="sched-monthly-shell" id="rr-sched-monthly-shell">
              <div class="sched-monthly-grid" id="rr-sched-monthly-grid">
                <div class="sched-monthly-loading">Loading forecast…</div>
              </div>
            </div>
          </div>
        </div>
        <div class="sched-subview" id="sched-sub-calendar" style="display:none">
          <!-- style block 29 extracted to inline-styles.css -->
          <div class="rr-fc-shell">
            <div id="rr-fleet-cal-host" class="rr-fleet-cal">
              <div class="rr-loading">Loading calendar…</div>
            </div>
            <div class="rr-fc-rail-space" id="rr-fc-providers"></div>
          </div>
        </div><!-- /sched-sub-calendar -->

        <!-- VAN ↔ DRIVER CHAIN EDITOR · the editable Fleet Assignment
             tool (Van · Status · Primary · Backup · Notes). Reached
             from the chevron split-toggle on the Assign Vans tile.
             Populated by renderSchedVanAssignmentsBoard() in
             live.js (reuses _wsRenderVehicles internally). -->
        <div class="sched-subview" id="sched-sub-vans-chain" style="display:none">
          <!-- No inline header: the page-title in the ribbon swaps to
               "Van assignments" while this view is active. Operators
               navigate back via the Week / Today / Staff tabs in the
               same ribbon. -->
          <div id="rr-sched-vans-chain-body">
            <div class="rr-loading">Loading van / driver chains…</div>
          </div>
        </div><!-- /sched-sub-vans-chain -->

        <!-- STAFF SCHEDULE — support roles (dispatchers, fleet, HR, ops, other).
             Standalone roster + weekly grid, completely separate from the
             driver schedule.  Backed by migration 0220's staff_members /
             staff_shifts tables.  Rendered by loadStaffSchedule() in live.js. -->
        <div class="sched-subview" id="sched-sub-staff" style="display:none">
          <!-- style block 30 extracted to inline-styles.css -->

          <div class="stf-bar">
            <div class="stf-week-nav">
              <button type="button" data-rr-staff-week-prev aria-label="Previous week">‹</button>
              <span class="lbl" id="rr-staff-week-label">—</span>
              <button type="button" data-rr-staff-week-next aria-label="Next week">›</button>
            </div>
            <button type="button" class="btn btn-sm" data-rr-staff-week-today>This week</button>
            <div class="stf-bar-spacer"></div>
            <button type="button" class="btn btn-sm" data-rr-staff-manage>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Manage staff
            </button>
          </div>

          <div id="rr-staff-grid"><div class="rr-loading" style="padding:var(--s-8);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-xl)">Loading staff schedule…</div></div>

          <!-- Manage staff modal -->
          <div id="rr-staff-manage" role="dialog" aria-modal="true" aria-labelledby="rr-staff-manage-title">
            <div class="card">
              <div class="h"><h3 id="rr-staff-manage-title">Manage staff</h3><button type="button" data-rr-staff-manage-close aria-label="Close">×</button></div>
              <div class="b" id="rr-staff-manage-list"></div>
              <div class="f">
                <button type="button" class="btn btn-sm btn-primary" data-rr-staff-new>+ Add staff member</button>
                <button type="button" class="btn btn-sm" data-rr-staff-manage-close>Close</button>
              </div>
            </div>
          </div>

          <!-- Add/edit shift modal -->
          <div id="rr-staff-shift-modal" role="dialog" aria-modal="true" aria-labelledby="rr-staff-shift-title">
            <div class="card">
              <div class="h"><h3 id="rr-staff-shift-title">Add shift</h3><button type="button" data-rr-staff-shift-close aria-label="Close">×</button></div>
              <div class="b">
                <label>Staff member<select id="rr-staff-shift-staff"></select></label>
                <label>Date<input type="date" id="rr-staff-shift-date"></label>
                <div class="grid2">
                  <label>Start<input type="time" id="rr-staff-shift-start"></label>
                  <label>End<input type="time" id="rr-staff-shift-end"></label>
                </div>
                <label>Role override (optional)
                  <select id="rr-staff-shift-role">
                    <option value="">— Use staff member's role</option>
                    <option value="dispatcher">Dispatcher</option>
                    <option value="fleet_manager">Fleet manager</option>
                    <option value="hr">HR</option>
                    <option value="ops_manager">Ops manager</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>Notes<textarea id="rr-staff-shift-notes" rows="2"></textarea></label>
              </div>
              <div class="f">
                <button type="button" class="btn btn-sm" data-rr-staff-shift-delete style="color:var(--red);display:none">Delete shift</button>
                <div style="display:flex;gap:var(--s-2);margin-left:auto">
                  <button type="button" class="btn btn-sm" data-rr-staff-shift-close>Cancel</button>
                  <button type="button" class="btn btn-sm btn-primary" data-rr-staff-shift-save>Save</button>
                </div>
              </div>
            </div>
          </div>

        </div><!-- /sched-sub-staff -->

        <!-- RULES — compliance + schedule settings -->


        <!-- INSIGHTS — driver availability + future insights -->
        <!-- TEMPLATES · the live Templates sub-view (#sched-sub-templates,
             capture button + rr-tpl-list) is declared earlier in this file.
             A legacy static mockup with the SAME id lived here — duplicate
             DOM id + fake "used by N drivers" numbers — removed 2026-07-17. -->


        </div><!-- /.tcp-body -->

        <!-- ── Right utility rail + Notes workspace ─────────────────
             Slim, fixed rail on the schedule's right edge (Google-
             style). The Notes button slides out a Keep-like scratchpad.
             Both are descendants of #view-schedule, which is
             display:none when inactive, so they only show on Schedule.
             Wired in live.js via delegated handlers; notes persist in
             localStorage (namespaced per DSP). -->
        <div class="sched-util-rail" id="rr-sched-util-rail" role="toolbar" aria-label="Schedule utilities">
          <button type="button" class="sched-util-btn" data-rr-notes-toggle title="Notes" aria-label="Notes" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--tasks" data-rr-tasks-toggle title="My Tasks" aria-label="My Tasks" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="currentColor"/><polyline points="7.8 12.4 10.7 15.3 16.2 9.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="sched-util-badge" id="rr-nt-task-badge" aria-hidden="true">0</span>
            <span class="sched-util-udot" id="rr-nt-task-udot" hidden aria-hidden="true"></span>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--checklists" data-rr-checklists-toggle title="Checklists" aria-label="Checklists" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4.5" fill="currentColor"/><polyline points="7.5 12.4 10.5 15.4 16.5 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--contacts" data-rr-contacts-toggle title="Contacts" aria-label="Contacts" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.34 0-8 1.67-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-3.33-4.66-5-8-5z"/></svg>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--ops" data-rr-ophealth-toggle title="Operations Health" aria-label="Operations Health" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="currentColor"/><polyline points="8.5 12 11 14.5 15.5 9.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--forms" data-rr-forms-toggle title="Forms" aria-label="Forms" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" fill="currentColor"/><rect x="8" y="2" width="8" height="4" rx="1" fill="currentColor"/><path d="M8.7 12.6l2.1 2.1 4.6-4.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--receipts" data-rr-receipts-toggle title="Receipts" aria-label="Receipts" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18l-2.33-1.6L14.33 21 12 19.4 9.67 21l-2.34-1.6L5 21z" fill="currentColor"/><line x1="9" y1="8.5" x2="15" y2="8.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><line x1="9" y1="12.5" x2="15" y2="12.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="sched-util-btn sched-util-btn--recog" data-rr-recog-toggle title="Recognition" aria-label="Recognition" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.9 12.6 7.4 21l4.6-2.5L16.6 21l-1.5-8.4z" fill="currentColor"/><circle cx="12" cy="8.5" r="5.5" fill="currentColor"/><circle cx="12" cy="8.5" r="2.3" fill="#fff"/></svg>
          </button>
        </div>
        <aside class="sched-notes-panel" id="rr-sched-notes" aria-label="Notes" aria-hidden="true">
          <div class="ntp-head">
            <div class="ntp-head-title">Notes</div>
            <button type="button" class="ntp-icon-btn" data-rr-notes-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>

          <div class="ntp-scroll">
            <div class="ntp-notes-block" data-rr-nt-notes>
              <div class="ntp-composer">
                <div class="ntp-composer-row">
                  <span class="ntp-composer-plus" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
                  <div class="ntp-composer-input" contenteditable="true" role="textbox" aria-label="Take a note" data-rr-note-input data-placeholder="Take a note…"></div>
                  <button type="button" class="ntp-composer-pin" data-rr-note-pin-toggle aria-pressed="false" title="Pin this note" aria-label="Pin this note"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V4h6v6.76a2 2 0 0 0 .59 1.42L18 14H6l2.41-1.82A2 2 0 0 0 9 10.76z"/></svg></button>
                </div>
                <div class="ntp-composer-foot">
                  <div class="ntp-fmt" role="group" aria-label="Formatting">
                    <button type="button" class="ntp-fmt-btn" data-rr-note-fmt="checklist" title="Checklist" aria-label="Checklist"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 7 1.8 1.8L8 5.6"/><path d="m3 16 1.8 1.8L8 14.6"/><line x1="12" y1="7" x2="21" y2="7"/><line x1="12" y1="17" x2="21" y2="17"/></svg></button>
                    <button type="button" class="ntp-fmt-btn ntp-fmt-bold" data-rr-note-fmt="bold" title="Bold" aria-label="Bold">B</button>
                    <button type="button" class="ntp-fmt-btn ntp-fmt-italic" data-rr-note-fmt="italic" title="Italic" aria-label="Italic">I</button>
                    <button type="button" class="ntp-fmt-btn" data-rr-note-fmt="link" title="Link" aria-label="Link"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
                    <button type="button" class="ntp-fmt-btn" data-rr-note-fmt="image" title="Image" aria-label="Image"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/></svg></button>
                  </div>
                  <button type="button" class="ntp-add-btn" data-rr-note-add>Add Note</button>
                </div>
              </div>

              <div class="ntp-filter">
                <button type="button" class="ntp-filter-sel" data-rr-note-filter-cycle aria-label="Filter notes"><span data-rr-note-filter-label>All Notes</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
                <div class="ntp-search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="text" data-rr-note-search placeholder="Search notes…" aria-label="Search notes"/></div>
                <button type="button" class="ntp-icon-btn ntp-soft" data-rr-note-sort title="Sort &amp; filter" aria-label="Sort and filter"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg></button>
              </div>

              <div class="ntp-list" id="rr-sched-notes-list" role="list"></div>
              <a href="#" class="ntp-viewall" data-rr-note-viewall>View all notes (<span id="rr-nt-note-count">0</span>)</a>
            </div>
          </div>
        </aside>
        <!-- Checklists rail panel · its own rail icon since the My-Tasks
             split. Lists driver checklist templates (browse / search /
             filter / manage); building happens in the large
             #modal-clf-builder modal, not here. Same .rr-fp chrome +
             panel manager as Forms/Recognition. -->
        <aside class="sched-notes-panel rr-fp" id="rr-sched-checklists" aria-label="Checklists" aria-hidden="true">
          <div class="ntp-head rr-fp-head">
            <div class="rr-fp-head-titles">
              <div class="ntp-head-title">Checklists</div>
              <div class="rr-fp-subtitle">Build, assign, and track driver checklists</div>
            </div>
            <div class="rr-fp-head-actions">
              <button type="button" class="rr-fp-new" data-rr-clf-new title="Create a new checklist">+ New Checklist</button>
              <button type="button" class="ntp-icon-btn" data-rr-checklists-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>

          <div class="rr-fp-toolbar">
            <div class="rr-fp-searchrow">
              <div class="rr-fp-search">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" class="rr-fp-search-input" id="rr-clf-search" placeholder="Search checklists…" aria-label="Search checklists" autocomplete="off"/>
              </div>
            </div>
            <div class="rr-fp-chips" id="rr-clf-chips" role="tablist" aria-label="Filter checklists by status">
              <button type="button" class="rr-fp-chip is-active" data-rr-clf-chip="all">All</button>
              <button type="button" class="rr-fp-chip" data-rr-clf-chip="draft">Draft</button>
              <button type="button" class="rr-fp-chip" data-rr-clf-chip="active">Active</button>
              <button type="button" class="rr-fp-chip" data-rr-clf-chip="assigned">Assigned</button>
              <button type="button" class="rr-fp-chip" data-rr-clf-chip="archived">Archived</button>
            </div>
          </div>

          <div class="ntp-scroll rr-fp-scroll">
            <div class="rr-fp-cards" id="rr-clf-list" role="list"></div>
          </div>
        </aside>
        <!-- My Tasks rail panel · the personal to-do list, now behind its
             own rail icon (split out of the old combined Checklists / My
             Tasks panel). Same ids + data hooks as before the split, so
             the existing _rrRenderTasks wiring keeps working. -->
        <aside class="sched-notes-panel rr-fp" id="rr-sched-tasks" aria-label="My Tasks" aria-hidden="true">
          <div class="ntp-head rr-fp-head">
            <div class="rr-fp-head-titles">
              <div class="ntp-head-title">My Tasks</div>
              <div class="rr-fp-subtitle">Your personal to-do list</div>
            </div>
            <div class="rr-fp-head-actions">
              <button type="button" class="ntp-icon-btn" data-rr-tasks-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>

          <div class="ntp-scroll">
            <div class="ntp-tasks-block ntp-tasks-block--solo" data-rr-nt-tasks>
              <div class="ntp-tasks-head">
                <div class="ntp-section-title">All Tasks</div>
                <button type="button" class="ntp-addtask-btn" data-rr-task-add-open><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Task</button>
              </div>
              <!-- Server-mode view chips (unhidden by live.js once team
                   tasks load): my open tasks vs. ones I've delegated. -->
              <div class="ntp-task-views" data-rr-task-views hidden role="tablist" aria-label="Task views">
                <button type="button" class="ntp-task-view-b on" data-rr-task-view="mine" role="tab" aria-selected="true">My Tasks <b>0</b></button>
                <button type="button" class="ntp-task-view-b" data-rr-task-view="delegated" role="tab" aria-selected="false">Delegated <b>0</b></button>
              </div>
              <div class="ntp-task-form" data-rr-task-form hidden>
                <input type="text" class="ntp-task-input" data-rr-task-title placeholder="Task title…" aria-label="Task title" maxlength="200"/>
                <div class="ntp-task-form-row">
                  <input type="date" class="ntp-task-date" data-rr-task-due aria-label="Due date"/>
                  <select class="ntp-task-date" data-rr-task-repeat aria-label="Repeat" title="Repeat">
                    <option value="">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annually">Annually</option>
                  </select>
                </div>
                <!-- Weekly: pick which day(s) of the week -->
                <div class="ntp-task-form-row ntp-rep-extra" data-rr-task-rep-weekly hidden>
                  <div class="ntp-dow" data-rr-task-dows role="group" aria-label="Repeat on">
                    <button type="button" class="ntp-dow-b" data-dow="0" title="Sunday">S</button>
                    <button type="button" class="ntp-dow-b" data-dow="1" title="Monday">M</button>
                    <button type="button" class="ntp-dow-b" data-dow="2" title="Tuesday">T</button>
                    <button type="button" class="ntp-dow-b" data-dow="3" title="Wednesday">W</button>
                    <button type="button" class="ntp-dow-b" data-dow="4" title="Thursday">T</button>
                    <button type="button" class="ntp-dow-b" data-dow="5" title="Friday">F</button>
                    <button type="button" class="ntp-dow-b" data-dow="6" title="Saturday">S</button>
                  </div>
                </div>
                <!-- Monthly: on day N, or on the Nth weekday -->
                <div class="ntp-task-form-row ntp-rep-extra" data-rr-task-rep-monthly hidden>
                  <select class="ntp-task-date" data-rr-task-monthly aria-label="Monthly pattern"></select>
                </div>
                <!-- How many occurrences to create — or repeat with no end date -->
                <div class="ntp-task-form-row ntp-rep-extra" data-rr-task-rep-count-row hidden>
                  <label class="ntp-rep-forever"><input type="checkbox" data-rr-task-repeat-forever/>Repeat forever</label>
                  <span class="ntp-rep-lbl ntp-rep-count-el">for</span>
                  <input type="number" class="ntp-task-date ntp-task-repcount ntp-rep-count-el" data-rr-task-repeat-count min="1" max="60" value="8" aria-label="Number of occurrences"/>
                  <span class="ntp-rep-lbl ntp-rep-count-el">occurrences</span>
                </div>
                <!-- Assign to a leadership teammate (server mode only —
                     live.js unhides + fills this once team tasks load). -->
                <div class="ntp-task-form-row" data-rr-task-assignee-row hidden>
                  <select class="ntp-task-date ntp-task-assignee" data-rr-task-assignee aria-label="Assign to" title="Assign to">
                    <option value="">Assign to: Myself</option>
                  </select>
                </div>
                <div class="ntp-task-form-row">
                  <button type="button" class="ntp-add-btn ntp-add-btn-sm" data-rr-task-add>Add</button>
                  <button type="button" class="ntp-ghost-btn" data-rr-task-cancel>Cancel</button>
                </div>
              </div>
              <div class="ntp-tasklist" id="rr-sched-tasks-list" role="list"></div>
            </div>
          </div>
        </aside>
        <aside class="sched-notes-panel rr-fp" id="rr-sched-forms" aria-label="Driver Forms" aria-hidden="true">
          <div class="ntp-head rr-fp-head">
            <div class="rr-fp-head-titles">
              <div class="ntp-head-title">Driver Forms</div>
              <div class="rr-fp-subtitle">Forms used throughout the RouteReady Driver App</div>
            </div>
            <div class="rr-fp-head-actions">
              <div class="rr-fp-newsplit">
                <button type="button" class="rr-fp-new" data-rr-form-new title="Create a new form">+ New Form</button>
                <button type="button" class="rr-fp-new-caret" data-rr-fp-newmenu title="More form options" aria-label="More form options"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              </div>
              <button type="button" class="ntp-icon-btn" data-rr-forms-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>

          <div class="rr-fp-toolbar">
            <div class="rr-fp-searchrow">
              <div class="rr-fp-search">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" class="rr-fp-search-input" id="rr-fp-search" placeholder="Search Forms..." aria-label="Search forms" autocomplete="off"/>
              </div>
              <button type="button" class="rr-fp-trig" data-rr-fp-trig title="Filter by trigger">All Triggers<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              <button type="button" class="rr-fp-opt" data-rr-fp-opt title="View options" aria-label="View options"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg></button>
            </div>
            <div class="rr-fp-chips" id="rr-fp-chips" role="tablist" aria-label="Filter forms by trigger">
              <button type="button" class="rr-fp-chip is-active" data-rr-fp-chip="all">All</button>
              <button type="button" class="rr-fp-chip" data-rr-fp-chip="Check-In">Check-In</button>
              <button type="button" class="rr-fp-chip" data-rr-fp-chip="During Route">During Route</button>
              <button type="button" class="rr-fp-chip" data-rr-fp-chip="End of Shift">End of Shift</button>
              <button type="button" class="rr-fp-chip" data-rr-fp-chip="Manual">Manual</button>
            </div>
          </div>

          <div class="ntp-scroll rr-fp-scroll">
            <div class="rr-fp-cards" id="rr-sched-forms-list" role="list"></div>
          </div>

          <div class="rr-fp-pager" id="rr-fp-pager" hidden>
            <span class="rr-fp-pager-label" id="rr-fp-pager-label"></span>
            <div class="rr-fp-pager-btns">
              <button type="button" class="rr-fp-pager-btn" data-rr-fp-page="prev" aria-label="Previous page"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg></button>
              <button type="button" class="rr-fp-pager-btn" data-rr-fp-page="next" aria-label="Next page"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></button>
            </div>
          </div>
        </aside>
        <!-- Receipts slide-out · driver-submitted receipts (receipt intake,
             migrations 0435-0439) reviewed without leaving the schedule.
             List/summary come from the dispatcher-gated receipts_list /
             receipts_summary RPCs; status changes go through
             receipt_set_status and the 0436 trigger reflects them into the
             Receipt Ledger workbook. Rendered by _rcpLoad() in live.js. -->
        <aside class="sched-notes-panel rr-fp" id="rr-sched-receipts" aria-label="Receipts" aria-hidden="true">
          <div class="ntp-head rr-fp-head">
            <div class="rr-fp-head-titles">
              <div class="ntp-head-title">Receipts</div>
              <div class="rr-fp-subtitle">Driver-submitted receipts · review &amp; reconcile</div>
            </div>
            <div class="rr-fp-head-actions">
              <button type="button" class="rr-fp-new" data-rr-rcp-ledger title="Open the Receipt Ledger workbook">Open ledger</button>
              <button type="button" class="ntp-icon-btn" data-rr-receipts-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>

          <div class="rr-fp-toolbar">
            <div class="rr-fp-chips" id="rr-rcp-chips" role="tablist" aria-label="Filter receipts">
              <button type="button" class="rr-fp-chip is-active" data-rr-rcp-chip="all">All</button>
              <button type="button" class="rr-fp-chip" data-rr-rcp-chip="review">Needs review</button>
              <button type="button" class="rr-fp-chip" data-rr-rcp-chip="open">Unreconciled</button>
              <button type="button" class="rr-fp-chip" data-rr-rcp-chip="dupes">Duplicates</button>
            </div>
            <div class="rr-rcp-summary" id="rr-rcp-summary" hidden></div>
          </div>

          <div class="ntp-scroll rr-fp-scroll">
            <div class="rr-fp-cards" id="rr-rcp-list" role="list"></div>
          </div>
        </aside>
        <!-- Recognition slide-out · celebrate birthdays / anniversaries and
             send custom celebrations without leaving the schedule. Upcoming +
             Sent feeds come from recognition_upcoming / recognition_list; the
             "+ Send" and per-row Celebrate buttons open the existing
             openRecogSendModal composer. Same panel chrome + manager as
             Notes/Checklists/Forms. -->
        <aside class="sched-notes-panel rr-fp" id="rr-sched-recog" aria-label="Recognition" aria-hidden="true">
          <div class="ntp-head rr-fp-head">
            <div class="rr-fp-head-titles">
              <div class="ntp-head-title">Recognition</div>
              <div class="rr-fp-subtitle">Celebrate birthdays, anniversaries, and wins</div>
            </div>
            <div class="rr-fp-head-actions">
              <button type="button" class="rr-fp-new" id="rr-recog-panel-send" title="Send a celebration">+ Send</button>
              <button type="button" class="ntp-icon-btn" data-rr-recog-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>

          <div class="rr-clf-seg" role="tablist" aria-label="Recognition sections">
            <button type="button" class="rr-clf-seg-b is-active" data-rr-rgp-seg="upcoming" role="tab" aria-selected="true">Upcoming</button>
            <button type="button" class="rr-clf-seg-b" data-rr-rgp-seg="sent" role="tab" aria-selected="false">Sent</button>
          </div>

          <div class="ntp-scroll rr-fp-scroll">
            <div class="rr-fp-cards" id="rr-rgp-list" role="list"></div>
          </div>
        </aside>
        <!-- Contacts slide-out · Google-Contacts-style companion panel on
             the shared utility rail: create / search / list, with quick
             call + email actions per row. Same panel chrome + manager as
             Notes/Tasks/Forms; contacts persist in localStorage
             (namespaced per DSP) via the same _rrNt* storage helpers. -->
        <aside class="sched-notes-panel" id="rr-sched-contacts" aria-label="Contacts" aria-hidden="true">
          <div class="ntp-head">
            <div class="ntp-head-title">Contacts</div>
            <button type="button" class="ntp-icon-btn" data-rr-contacts-close title="Close" aria-label="Close panel"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="ntp-scroll">
            <button type="button" class="ctp-create" data-rr-contact-createtoggle>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Create contact</span>
            </button>
            <!-- Google-Contacts-style editor: name + company/title
                 static fields, then repeatable sections (emails,
                 phones, addresses, significant dates, websites,
                 custom fields — rows built in live.js), points of
                 contact, and notes. -->
            <div class="ctp-form" data-rr-contact-form hidden>
              <input type="text" class="ctp-input" data-rr-contact-first placeholder="First name" aria-label="First name" maxlength="60" autocomplete="off">
              <input type="text" class="ctp-input" data-rr-contact-last placeholder="Last name" aria-label="Last name" maxlength="60" autocomplete="off">
              <input type="text" class="ctp-input" data-rr-contact-company placeholder="Company" aria-label="Company" maxlength="80" autocomplete="off">
              <input type="text" class="ctp-input" data-rr-contact-title placeholder="Job title" aria-label="Job title" maxlength="80" autocomplete="off">
              <div class="ctp-multi" data-rr-contact-emails></div>
              <div class="ctp-multi" data-rr-contact-phones></div>
              <div class="ctp-multi" data-rr-contact-addresses></div>
              <div class="ctp-multi" data-rr-contact-dates></div>
              <div class="ctp-multi" data-rr-contact-sites></div>
              <div class="ctp-multi" data-rr-contact-customs></div>
              <div class="ctp-addrow" role="group" aria-label="Add contact fields">
                <button type="button" class="ctp-addbtn" data-rr-contact-add-row="email">+ Email</button>
                <button type="button" class="ctp-addbtn" data-rr-contact-add-row="phone">+ Phone</button>
                <button type="button" class="ctp-addbtn" data-rr-contact-add-row="address">+ Address</button>
                <button type="button" class="ctp-addbtn" data-rr-contact-add-row="date">+ Significant date</button>
                <button type="button" class="ctp-addbtn" data-rr-contact-add-row="site">+ Website</button>
                <button type="button" class="ctp-addbtn" data-rr-contact-add-row="custom">+ Custom field</button>
              </div>
              <!-- Points of contact · people at this business (name /
                   role / phone), repeatable rows built in live.js. -->
              <div class="ctp-pocs">
                <div class="ctp-pocs-head">
                  <span>Points of contact</span>
                  <button type="button" class="ctp-poc-add" data-rr-contact-poc-add>+ Add</button>
                </div>
                <div class="ctp-pocs-list" data-rr-contact-pocs></div>
              </div>
              <textarea class="ctp-input ctp-notes" data-rr-contact-notes placeholder="Notes" aria-label="Notes" rows="2" maxlength="500"></textarea>
              <div class="ctp-form-foot">
                <button type="button" class="ctp-btn" data-rr-contact-cancel>Cancel</button>
                <button type="button" class="ctp-btn ctp-btn-primary" data-rr-contact-save>Save</button>
              </div>
            </div>
            <div class="ntp-search ctp-search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="text" data-rr-contact-search placeholder="Search contacts…" aria-label="Search contacts"/></div>
            <div class="ctp-list" id="rr-sched-contacts-list" role="list"></div>
          </div>
        </aside>
      </div>
    