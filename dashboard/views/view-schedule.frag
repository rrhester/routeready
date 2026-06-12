
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
                  <span>Weekly</span>
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
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Rescue</span><button type="button" data-rr-route-reset="rescue" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="rescue" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="nursery"   style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Nursery</span><button type="button" data-rr-route-reset="nursery" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="nursery" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="other"     style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Other</span><button type="button" data-rr-route-reset="other" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="other" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="class_training" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Class training</span><button type="button" data-rr-route-reset="class_training" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="class_training" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="road_training" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Road training</span><button type="button" data-rr-route-reset="road_training" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="road_training" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="pto" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">PTO / time off</span><button type="button" data-rr-route-reset="pto" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="pto" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="xl" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">XL</span><button type="button" data-rr-route-reset="xl" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="xl" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                        <div class="rr-rcp-row" data-rr-route="trainer_trainee" style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:#FFF">
                          <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-weight:600;color:#111827">Trainer (trainee riding along)</span><button type="button" data-rr-route-reset="trainer_trainee" style="background:none;border:0;color:var(--accent);font-size:11px;cursor:pointer">Reset</button></div>
                          <div class="rr-rcp-swatches" data-rr-route-swatches="trainer_trainee" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                        </div>
                      </div>
                      <!-- style block 23 extracted to inline-styles.css -->
                    </fieldset>

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
                        var PALETTE = [
                          { name: "Crimson",  hex: "#DC2626" },
                          { name: "Orange",   hex: "#EA580C" },
                          { name: "Olive",    hex: "#986F0B" },
                          { name: "Forest",   hex: "#65A30D" },
                          { name: "Teal",     hex: "#0D9488" },
                          { name: "Blue",     hex: "var(--accent)" },
                          { name: "Royal",    hex: "#7C3AED" },
                          { name: "Magenta",  hex: "#881798" },
                          { name: "Berry",    hex: "#DB2777" },
                          { name: "Slate",    hex: "#6B7280" },
                        ];
                        // Defaults map each route to one palette entry so
                        // first-time DSPs see a sensible default. These
                        // also override the :root --rr-route-c-* vars so
                        // the palette + chip colors stay in sync.
                        // Route types the operator can color-code. "Other" is
                        // the catch-all; the legacy reduction / cycle_1 /
                        // cycle_2 / backup types were retired from the picker.
                        var DEFAULTS = {
                          rescue:         "#DC2626",
                          nursery:        "#0D9488",
                          other:          "#6B7280",
                          class_training: "#0D9488",
                          road_training:  "#EA580C",
                          pto:            "#EA580C",
                          xl:             "#EA580C",
                          trainer_trainee:"#65A30D",
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
                        function applyColor(route, hex) {
                          document.documentElement.style.setProperty("--rr-route-c-" + route, hex);
                        }
                        function applyAll(map) {
                          Object.keys(DEFAULTS).forEach(function (k) {
                            applyColor(k, map[k] || DEFAULTS[k]);
                          });
                        }
                        function renderSwatches(route, current) {
                          var host = document.querySelector('[data-rr-route-swatches="' + route + '"]');
                          if (!host) return;
                          host.innerHTML = "";
                          PALETTE.forEach(function (entry) {
                            var b = document.createElement("button");
                            b.type = "button";
                            b.className = "rr-rcp-swatch";
                            b.style.background = entry.hex;
                            b.setAttribute("data-rr-route", route);
                            b.setAttribute("data-rr-hex", entry.hex);
                            b.setAttribute("title", entry.name);
                            if (entry.hex.toUpperCase() === String(current).toUpperCase()) {
                              b.classList.add("is-active");
                            }
                            host.appendChild(b);
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
              <!-- Monthly view · 5-6 row × 7-col calendar (weeks
                   down the left, days across the top) for a
                   month-at-a-glance read. Renderer lives in
                   live.js → renderSchedMonthlyView. -->
              <button class="subnav-item" data-sub="monthly" data-rr-tile="monthly" onclick="schedSub('monthly')" title="Monthly view — weeks down the left, days across the top">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18" x2="21" y2="18"/><line x1="9" y1="10" x2="9" y2="22"/><line x1="15" y1="10" x2="15" y2="22"/></svg>
                <span>Monthly</span>
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
              <button type="button" class="sched-page-btn-rules-foot" id="rr-sched-smartfill-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-sched-smartfill-rules-popover" title="Smart Fill rules — toggle parts of the auto-staff logic on/off">
                Rules
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
              <!-- Smart Fill rules popover · checkboxes per rule so
                   the DSP can toggle which rules apply on the next
                   Smart Fill run. State persists in localStorage. -->
              <div class="sched-smartfill-rules-popover" id="rr-sched-smartfill-rules-popover" role="dialog" aria-modal="false" aria-label="Smart Fill rules" hidden>
                <div class="sched-smartfill-rules-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L4.5 13.5H11l-1 8.5L19 10.5h-6.5L13 2z"/></svg>Smart Fill rules</div>
                <div class="sched-smartfill-rules-body" id="rr-sched-smartfill-rules-body" style="column-count:1;display:flex;flex-direction:column;gap:10px">
                  <!-- Localized styles for the v2 popover. Scoped to the
                       body element so they don't bleed into anything else. -->
                  <!-- style block 24 extracted to inline-styles.css -->

                  <!-- ── PRESET BAR ── one-click bundles of settings.
                       Buttons set the whole rule blob at once; operators
                       can still tweak any individual control afterward. -->
                  <div class="sf2-presets">
                    <div class="sf2-presets-label">Start from a preset:</div>
                    <div class="sf2-presets-row">
                      <button type="button" class="sf2-preset" data-rr-sf-preset="stick_to_last_week" title="Strong historical pattern + driver-affinity polish. Keeps drivers on the days they usually work.">Stick to last week</button>
                      <button type="button" class="sf2-preset" data-rr-sf-preset="maximize_coverage" title="5th-day fill on, preferred-day enhancement on, every protection still applies.">Maximize coverage</button>
                      <button type="button" class="sf2-preset" data-rr-sf-preset="conservative" title="Tighter buffers on top of the hard rules: WOC cap 5 consecutive days (vs 6), 7-day license-expiry warning, no 5th-day overtime, no enhancement passes. Hard rules are always enforced regardless of preset.">Conservative</button>
                      <button type="button" class="sf2-preset" data-rr-sf-preset="balanced" title="The historical defaults — what Smart Fill ships with out of the box.">Balanced</button>
                      <button type="button" class="sf2-preset sf2-preset-secondary" data-rr-sf-preset="reset" title="Clear every saved rule. Equivalent to a fresh install.">Reset all</button>
                    </div>
                    <div class="sf2-presets-foot">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                      <span>Hard rules (WOC, license, certs, PTO, min rest) are always enforced. Presets only adjust buffer sizes and soft preferences.</span>
                    </div>
                  </div>

                  <!-- ── LIVE DIFF STRIP ── shows the effect of your
                       in-progress edits without committing them. Powered
                       by a debounced in-browser planScheduleWeek dry-run. -->
                  <div class="sf2-livediff" id="sf2-livediff" data-state="idle">
                    <div class="sf2-livediff-pulse" aria-hidden="true"></div>
                    <div class="sf2-livediff-text" id="sf2-livediff-text">Run Smart Fill once to enable live preview of rule changes.</div>
                  </div>
                  <!-- Visible only when .is-manual is on the body. Tells
                       the operator they're in Manual scheduling mode and
                       gives them a one-click path back to Smart Fill. -->
                  <div class="sf2-manual-banner" id="sf2-manual-banner">
                    <div class="sf2-manual-banner-icon" aria-hidden="true">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></svg>
                    </div>
                    <div class="sf2-manual-banner-text">
                      <strong>You're in Manual scheduling mode.</strong> Smart Fill is off and the auto-staffing rules don't run. Switch back below to use rules-driven fill.
                    </div>
                  </div>

                  <!-- ── 1 · WHO CAN WORK ── eligibility. The license/cert/
                       service-type gates are ALWAYS enforced (the engine
                       never auto-assigns an unqualified driver), so they no
                       longer have on/off toggles — only the genuine choices
                       (include onboarding drivers, license buffer) remain. -->
                  <details class="sf2-section" data-rr-sf-section="eligibility" open>
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="sf2-section-num">1</span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Who can work</div>
                        <div class="sf2-section-sub">License, certs &amp; service types — always enforced</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <p class="sf2-row-help" style="margin:2px 10px 6px">The right certs (DOT / XL / EDV) for each route's service type and an active service type are always required — the engine never auto-assigns a driver who doesn't qualify.</p>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="include_onboarding" checked> <span class="sf-rule-name"><strong>Include onboarding drivers</strong> · activated trainees can take regular shifts</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="dl_valid" checked> <span class="sf-rule-name"><strong>DL valid required</strong> · skip drivers with an expired license</span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-dl-protection-days">License protection window</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-set-dl-protection-days" min="0" max="365" step="1" value="0">
                          <span style="font-size:11px;color:#6B7280">days before expiry</span>
                        </div>
                        <p class="sf2-row-help">Block drivers within N days of their license expiring (0 = only block once expired). Catches expirations before they bite.</p>
                      </div>
                      <label class="sched-smartfill-rule"><input type="checkbox" id="rr-sf-dl-msg-enable"> <span class="sf-rule-name"><strong>Message drivers before expiry</strong> · text / notify drivers ahead of their license renewal</span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-dl-msg-days">Message window</label>
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
                      <span class="sf2-section-num">2</span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Limits &amp; compliance</div>
                        <div class="sf2-section-sub">Time off, rest, day &amp; hour caps, WOC</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <p class="sf2-row-help" style="margin:2px 10px 6px">Approved PTO and each driver's saved availability are always respected — the engine never auto-assigns a driver on a day they're off or marked unavailable.</p>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="min_rest" checked> <span class="sf-rule-name"><strong>Min rest between shifts</strong> · enforce a minimum gap between two consecutive shifts</span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-min-rest-hours">Min rest hours</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-sf-min-rest-hours" min="0" max="48" step="1" value="10" data-rr-sf-num="min_rest_hours">
                          <span style="font-size:11px;color:#6B7280">hours</span>
                        </div>
                      </div>
                      <div class="sf2-group-label">Days &amp; hours caps</div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-target-days">Target days per driver</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-sf-target-days" min="0" max="7" step="1" value="4" data-rr-sf-num="target_days_per_week">
                          <span style="font-size:11px;color:#6B7280">days/week (soft)</span>
                        </div>
                        <p class="sf2-row-help">Aim to keep every driver at or below this many days a week. Engine scores against placements past this number, so other drivers fill first. The engine still goes over the target when coverage demands it (the OT escape hatch). 0 disables. Default 4 — fits a 4-day, 10-hour-shift week before OT.</p>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-max-days-window">Max days window</label>
                        <div class="sf2-row-control">
                          <div id="rr-sf-max-days-window" class="sf2-seg" role="radiogroup" aria-label="Max days window" data-rr-sf-select="max_days_window">
                            <button type="button" class="sf2-seg-btn is-active" data-val="schedule_week" role="radio" aria-checked="true">This schedule week</button>
                            <button type="button" class="sf2-seg-btn" data-val="rolling_7_days" role="radio" aria-checked="false">Rolling 7 days</button>
                          </div>
                        </div>
                        <p class="sf2-row-help">Rolling counts every shift within 7 days of the candidate — catches "Sat → Sun → Mon" 3-in-a-row spans week boundaries.</p>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-weekly-hour-window">Weekly hour window</label>
                        <div class="sf2-row-control">
                          <div id="rr-sf-weekly-hour-window" class="sf2-seg" role="radiogroup" aria-label="Weekly hour window" data-rr-sf-select="weekly_hour_window">
                            <button type="button" class="sf2-seg-btn is-active" data-val="schedule_week" role="radio" aria-checked="true">This schedule week</button>
                            <button type="button" class="sf2-seg-btn" data-val="rolling_7_days" role="radio" aria-checked="false">Rolling 7 days</button>
                          </div>
                        </div>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-pto-default-hours">PTO hours per day</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-sf-pto-default-hours" min="0" max="24" step="1" value="10" data-rr-sf-num="pto_default_hours">
                          <span style="font-size:11px;color:#6B7280">hours</span>
                        </div>
                        <p class="sf2-row-help">How many hours an approved-PTO day counts as when the cap is being calculated.</p>
                      </div>
                      <div class="sf2-group-label">Working Hours Compliance (WOC)</div>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="woc" checked> <span class="sf-rule-name"><strong>Enforce WOC</strong> · cap consecutive working days + weekly hours</span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-woc-max-days">Max consecutive days</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-set-woc-max-days" min="1" max="7" step="1" value="6">
                          <span style="font-size:11px;color:#6B7280">days in a row</span>
                        </div>
                        <p class="sf2-row-help">Day after this run is blocked — rolling, not weekly. A driver who works Wed–Mon (6 days across two calendar weeks) is blocked on the 7th. A day off, approved PTO, or a time-off request <strong>resets</strong> the streak — only worked days count consecutively.</p>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-woc-max-hours">Weekly hour cap</label>
                        <div class="sf2-row-control">
                          <input type="number" class="sf2-number" id="rr-set-woc-max-hours" min="1" max="168" step="1" value="40">
                          <span style="font-size:11px;color:#6B7280">hours</span>
                        </div>
                      </div>
                      <div class="sf2-group-label">Same-day shifts</div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-same-day">Same-day policy</label>
                        <div class="sf2-row-control">
                          <div id="rr-sf-same-day" class="sf2-seg" role="radiogroup" aria-label="Same-day policy" data-rr-sf-select="same_day_multi_shift">
                            <button type="button" class="sf2-seg-btn is-active" data-val="block" role="radio" aria-checked="true">Block</button>
                            <button type="button" class="sf2-seg-btn" data-val="allow" role="radio" aria-checked="false">Allow</button>
                          </div>
                        </div>
                        <p class="sf2-row-help">Block = one shift per driver per day. Allow = a driver can work two shifts the same day.</p>
                      </div>
                    </div>
                  </details>

                  <!-- ── 4 · PREFERENCES ── soft nudges; never block. -->
                  <details class="sf2-section" data-rr-sf-section="prefs">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="sf2-section-num">3</span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Preferences</div>
                        <div class="sf2-section-sub">Soft nudges — who to favor when there's a choice</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="preferred_days" checked> <span class="sf-rule-name"><strong>Favor preferred days</strong> · lean toward the days drivers asked for</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="attendance_penalty"> <span class="sf-rule-name"><strong>Schedule Final-corrective drivers last</strong> · drivers on a Final coaching ladder go to the back</span></label>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-sf-att-scheduling">Reward good attendance</label>
                        <div class="sf2-row-control">
                          <div id="rr-sf-att-scheduling" class="sf2-seg" role="radiogroup" aria-label="Reward good attendance" data-rr-sf-select="attendance_weight_combined">
                            <button type="button" class="sf2-seg-btn is-active" data-val="off" role="radio" aria-checked="true">Off</button>
                            <button type="button" class="sf2-seg-btn" data-val="low" role="radio" aria-checked="false">Low</button>
                            <button type="button" class="sf2-seg-btn" data-val="medium" role="radio" aria-checked="false">Medium</button>
                            <button type="button" class="sf2-seg-btn" data-val="high" role="radio" aria-checked="false">High</button>
                          </div>
                        </div>
                      </div>
                      <div class="sf2-row">
                        <label class="sf2-row-label" for="rr-set-affinity-weeks">History to look back on</label>
                        <div class="sf2-row-control">
                          <div id="rr-set-affinity-weeks" class="sf2-seg" role="radiogroup" aria-label="History to look back on">
                            <button type="button" class="sf2-seg-btn is-active" data-val="4" role="radio" aria-checked="true">4 weeks</button>
                            <button type="button" class="sf2-seg-btn" data-val="6" role="radio" aria-checked="false">6 weeks</button>
                            <button type="button" class="sf2-seg-btn" data-val="8" role="radio" aria-checked="false">8 weeks</button>
                          </div>
                        </div>
                      </div>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-rule="fifth_day_fill"> <span class="sf-rule-name"><strong>Allow a 5th day</strong> · give opted-in drivers one extra shift if coverage needs it</span></label>
                      <div class="sf2-subrules">
                        <label class="sched-smartfill-rule sched-smartfill-rule-advanced"><input type="checkbox" data-rr-sf-rule="fifth_day_override_availability"> <span class="sf-rule-name">Let the 5th day land on any day — WOC + license still apply</span></label>
                        <label class="sched-smartfill-rule sched-smartfill-rule-advanced"><input type="checkbox" data-rr-sf-rule="fifth_day_notify"> <span class="sf-rule-name">Message each driver who picks up a 5th day</span></label>
                      </div>
                    </div>
                  </details>

                  <!-- ── 5 · VANS ── van-assignment rules. -->
                  <details class="sf2-section sf-zone--vans" data-rr-sf-section="vans">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="sf2-section-num">4</span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Vans</div>
                        <div class="sf2-section-sub">When &amp; how vans are assigned alongside drivers</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sf2-section-body">
                      <div class="sf-vans-subzone-label">When to assign</div>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-vans="assign" checked> <span class="sf-rule-name"><strong>Assign vans during Smart Fill</strong> · when off, the van column stays empty for new assignments</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-auto-rescue checked> <span class="sf-rule-name"><strong>Auto-rescue at-risk vans</strong> · run van assignment automatically when FEM flags a van approaching the 14-day rotation rule</span></label>
                      <div class="sf-vans-subzone-label">Who gets which van</div>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-sf-vans="prefer_paired" checked> <span class="sf-rule-name"><strong>Prefer driver's paired van</strong> · use the standing primary / backup chain when possible</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="primary_chain" checked> <span class="sf-rule-name">Each van's primary driver keeps their van when they're scheduled</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="secondary_chain" checked> <span class="sf-rule-name">When the primary is off, the backup driver takes the van</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="pool_fill" checked> <span class="sf-rule-name">Match remaining drivers with any leftover vans</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="branded_first" checked> <span class="sf-rule-name">Assign branded (Amazon-wrapped) vans first</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="fem_priority" checked> <span class="sf-rule-name">Prioritize branded vans approaching the 14-day rotation rule</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="rescue_secondary" checked> <span class="sf-rule-name">Move a backup driver onto an at-risk van to prevent a VERO defect</span></label>
                      <label class="sched-smartfill-rule"><input type="checkbox" data-rr-van-rule="rescue_primary" checked> <span class="sf-rule-name">Move a primary driver onto an at-risk van as a last resort</span></label>
                    </div>
                  </details>

                  <!-- ── 6 · CUSTOM RULES ── ad-hoc constraints (preserved). -->
                  <details class="sf2-section sf-zone--adhoc" id="rr-sf-adhoc-disclosure" data-rr-sf-section="custom">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="sf2-section-num">5</span>
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

                  <!-- ── 7 · ADVANCED ── CP-SAT controls (preserved). -->
                  <details class="sf2-section sf-zone--engine" id="rr-sf-engine-expander" data-rr-sf-section="engine">
                    <summary class="sf2-section-head"><div class="sf2-section-head-inner">
                      <span class="sf2-section-num">6</span>
                      <span class="sf2-section-titles">
                        <div class="sf2-section-title">Advanced</div>
                        <div class="sf2-section-sub">Priorities, data sources &amp; compute — fine-tuning</div>
                      </span>
                      <svg class="sf2-section-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>
                    </div></summary>
                    <div class="sched-smartfill-engine-body">
                      <div class="sf-engine-group">
                        <div class="sf-engine-group-label">Priorities</div>
                        <div class="sf-engine-priorities" id="rr-sf-engine-priorities">
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-coverage" class="sf-engine-prio-name">Coverage</label>
                            <input id="rr-sf-prio-coverage" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="coverage" class="sf-engine-prio-slider" aria-label="Coverage priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">How aggressively to fill open shifts. Higher leaves fewer gaps but may push overtime or break other preferences.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-fairness" class="sf-engine-prio-name">Fairness</label>
                            <input id="rr-sf-prio-fairness" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="fairness" class="sf-engine-prio-slider" aria-label="Fairness priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Spread hours evenly across drivers. Higher balances paychecks week to week; lower lets seniority and preferences win.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-ot_avoidance" class="sf-engine-prio-name">Overtime avoidance</label>
                            <input id="rr-sf-prio-ot_avoidance" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="ot_avoidance" class="sf-engine-prio-slider" aria-label="Overtime avoidance priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Penalty for crossing 40h. Higher leaves shifts open before pushing a driver into OT; lower fills the gap regardless.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-stability" class="sf-engine-prio-name">Schedule stability</label>
                            <input id="rr-sf-prio-stability" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="stability" class="sf-engine-prio-slider" aria-label="Schedule stability priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Mirror last week's pattern. Higher keeps drivers on the same days each week; lower lets the engine reshuffle freely.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-van_continuity" class="sf-engine-prio-name">Van continuity</label>
                            <input id="rr-sf-prio-van_continuity" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="van_continuity" class="sf-engine-prio-slider" aria-label="Van continuity priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Stick to a driver's paired van. Higher keeps the primary/backup chain together; lower lets the engine swap vans to optimize other goals.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-preferred_days" class="sf-engine-prio-name">Preferred days</label>
                            <input id="rr-sf-prio-preferred_days" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="preferred_days" class="sf-engine-prio-slider" aria-label="Preferred days priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Honor driver day-of-week availability picks. Higher treats their picks as hard; lower treats them as hints the engine can override.</p>
                          </div>
                          <div class="sf-engine-prio-row">
                            <label for="rr-sf-prio-attendance_penalty" class="sf-engine-prio-name">Attendance penalty</label>
                            <input id="rr-sf-prio-attendance_penalty" type="range" min="1" max="5" step="1" value="3" data-rr-sf-prio="attendance_penalty" class="sf-engine-prio-slider" aria-label="Attendance penalty priority"/>
                            <div class="sf-engine-prio-ticks"><span>Ignore</span><span>Default</span><span>Insist</span></div>
                            <p class="sf-engine-prio-help">Weight on past attendance. Higher steers shifts away from drivers with recent no-shows or late points; lower ignores attendance history.</p>
                          </div>
                        </div>
                      </div>
                      <div class="sf-engine-group">
                        <div class="sf-engine-group-label">Data sources</div>
                        <div class="sf-engine-datasources">
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="pto" checked> <span>Use approved PTO</span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="affinity" checked> <span>Use affinity history (last N weeks)</span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="van_pairings" checked> <span>Use van pairings</span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="attendance" checked> <span>Use attendance score</span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="fifth_day_optin" checked> <span>Use 5th-day opt-in flags</span></label>
                          <label class="sf-engine-ds"><input type="checkbox" data-rr-sf-ds="ad_hoc_rules" checked> <span>Use ad-hoc custom rules</span></label>
                        </div>
                      </div>
                      <div class="sf-engine-group">
                        <div class="sf-engine-group-label">Compute budget</div>
                        <div class="sf-engine-budget">
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Solve time</span>
                            <div class="sf2-seg" id="rr-sf-solve-time" role="radiogroup" aria-label="Solve time" data-rr-sf-budget="solveTimeMs">
                              <button type="button" class="sf2-seg-btn" data-val="3000" role="radio" aria-checked="false">Quick (3s)</button>
                              <button type="button" class="sf2-seg-btn is-active" data-val="8000" role="radio" aria-checked="true">Normal (8s)</button>
                              <button type="button" class="sf2-seg-btn" data-val="30000" role="radio" aria-checked="false">Thorough (30s)</button>
                            </div>
                          </div>
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Affinity history window</span>
                            <div class="sf2-seg" id="rr-sf-affinity-weeks" role="radiogroup" aria-label="Affinity history window" data-rr-sf-budget="affinityWeeks">
                              <button type="button" class="sf2-seg-btn" data-val="2" role="radio" aria-checked="false">2 weeks</button>
                              <button type="button" class="sf2-seg-btn is-active" data-val="4" role="radio" aria-checked="true">4 weeks</button>
                              <button type="button" class="sf2-seg-btn" data-val="8" role="radio" aria-checked="false">8 weeks</button>
                            </div>
                          </div>
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Max days per week</span>
                            <div class="sf2-seg" id="rr-sf-max-days-override" role="radiogroup" aria-label="Max days per week" data-rr-sf-budget="maxDaysOverride">
                              <button type="button" class="sf2-seg-btn" data-val="3" role="radio" aria-checked="false">3</button>
                              <button type="button" class="sf2-seg-btn" data-val="4" role="radio" aria-checked="false">4</button>
                              <button type="button" class="sf2-seg-btn is-active" data-val="5" role="radio" aria-checked="true">5</button>
                              <button type="button" class="sf2-seg-btn" data-val="6" role="radio" aria-checked="false">6</button>
                              <button type="button" class="sf2-seg-btn" data-val="7" role="radio" aria-checked="false">7</button>
                            </div>
                          </div>
                          <div class="sf-engine-budget-row">
                            <span class="sf-engine-budget-label">Weekly hour cap</span>
                            <div class="sf2-seg" id="rr-sf-weekly-hour-cap" role="radiogroup" aria-label="Weekly hour cap" data-rr-sf-budget="weeklyHourCap">
                              <button type="button" class="sf2-seg-btn is-active" data-val="40" role="radio" aria-checked="true">40 hours</button>
                              <button type="button" class="sf2-seg-btn" data-val="45" role="radio" aria-checked="false">45 hours</button>
                              <button type="button" class="sf2-seg-btn" data-val="50" role="radio" aria-checked="false">50 hours</button>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div class="sf-engine-foot">
                        <button type="button" class="sf-engine-reset" id="rr-sf-engine-reset">Reset to defaults</button>
                      </div>
                    </div>
                  </details>

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
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="compliance-watch" title="Compliance watch · DOT / DL / cert expirations rolling forward">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <circle cx="12" cy="12" r="3"/>
                  <line x1="12" y1="10" x2="12" y2="12"/>
                  <line x1="12" y1="12" x2="13.5" y2="13.5"/>
                </svg>
                <span>Compliance watch</span>
              </button>
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="hiring-pulse" title="Hiring pulse · pipeline velocity vs. hire-by dates">
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
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="peak-days" title="Peak days · HVE / Prime / seasonal spikes on the horizon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="18" rx="1"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <polyline points="13 13 9 18 12 18 10 22 14 17 11 17 14 13"/>
                </svg>
                <span>Peak days</span>
              </button>
              <button type="button" class="sched-v2-intel-tile" data-rr-intel="what-if" title="What-if · run the solver against a scenario before you commit">
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
            <span>Weekly</span>
          </button>
            <!-- Group label · centered under the Weekly (middle) tile, on
                 the card's bottom line. -->
            <span class="sched-v2-group-label" aria-hidden="true">Go To</span>
          </div>
          <div class="sched-v2-split">
            <button type="button" class="sched-v2-tile" data-rr-v2="monthly" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
              <line x1="3" y1="14" x2="21" y2="14"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
              <line x1="9" y1="10" x2="9" y2="22"/>
              <line x1="15" y1="10" x2="15" y2="22"/>
              <line x1="7" y1="2" x2="7" y2="6"/>
              <line x1="17" y1="2" x2="17" y2="6"/>
            </svg>
            <span>Monthly</span>
          </button>
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
          <div class="rr-tgt-kpi">
            <div class="rr-tgt-kpi-text">
              <div class="rr-tgt-kpi-label">Cushion</div>
              <div class="rr-tgt-kpi-val">
                <input class="rr-tgt-kpi-input" id="rr-sched-targets-cushion-pct" type="number" min="0" max="50" step="1" autocomplete="off" aria-label="Cushion percent"/>
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
          <div class="rr-tgt-kpi">
            <div class="rr-tgt-kpi-text">
              <div class="rr-tgt-kpi-label">Status</div>
              <div class="rr-tgt-kpi-val">
                <span class="rr-tgt-kpi-status" id="rr-sched-targets-rules-status" aria-live="polite">—</span>
              </div>
            </div>
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
            <span class="rr-ab-driver">Driver</span>
            <span class="rr-ab-weeknav" id="rr-ab-weeknav"></span>
            <button type="button" class="rr-ab-btn" id="rr-ab-smartfill" title="Auto-staff this week from your rules + OKAMI demand">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.95 2.55L22.5 18.5l-2.55.95L19 22l-.95-2.55L15.5 18.5l2.55-.95z"/></svg>
              Smart Fill
              <span class="rr-ab-badge" id="rr-ab-sf-badge" hidden>0</span>
            </button>
            <button type="button" class="rr-ab-btn" id="rr-ab-assign" title="Auto-assign vans for this week using the standing primary / backup chain">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="13" height="10" rx="1.2"/><path d="M15 8h4l3 3v4h-7z"/><line x1="2" y1="15" x2="22" y2="15"/><circle cx="6.5" cy="16.5" r="1.6"/><circle cx="17.5" cy="16.5" r="1.6"/></svg>
              Assign Fleet
              <span class="rr-ab-caret" id="rr-ab-assign-caret" role="button" tabindex="0" title="Open the van / driver chain editor" aria-haspopup="true">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
              </span>
            </button>
            <button type="button" class="rr-ab-btn" id="rr-ab-unassign" title="Clear this week's van assignments">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="13" height="10" rx="1.2"/><path d="M15 8h4l3 3v4h-7z"/><line x1="2" y1="15" x2="22" y2="15"/><circle cx="6.5" cy="16.5" r="1.6"/><circle cx="17.5" cy="16.5" r="1.6"/></svg>
              Unassign Fleet
            </button>
            <div class="rr-ab-coverage" id="rr-ab-coverage" hidden>
              <span class="rr-ab-coverage-label">Coverage</span>
              <span class="rr-ab-coverage-main" id="rr-ab-coverage-main"></span>
              <span class="rr-ab-coverage-track" aria-hidden="true"><span class="rr-ab-coverage-bar" id="rr-ab-coverage-bar"></span></span>
              <span class="rr-ab-coverage-sub" id="rr-ab-coverage-sub"></span>
            </div>
            <button type="button" class="rr-ab-btn rr-ab-primary" id="rr-ab-finalize" title="Push this week's schedule to drivers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Finalize Schedule
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
              on("rr-ab-smartfill", function () { fire("rr-sched-smartfill-h"); });
              on("rr-ab-finalize",  function () { fire("rr-sched-finalize-h"); });
              on("rr-ab-assign", function (e) {
                if (e.target.closest("#rr-ab-assign-caret")) return; // caret owns its click
                var v = document.getElementById("rr-sched-vans-h");
                if (v && v.dataset.rrAssigned === "1") { say("Fleet is already assigned this week — use Unassign Fleet first."); return; }
                fire("rr-sched-vans-h");
              });
              on("rr-ab-assign-caret", function (e) {
                e.stopPropagation();
                fire("rr-sched-vans-chain-toggle");
              });
              on("rr-ab-unassign", function () {
                var v = document.getElementById("rr-sched-vans-h");
                if (!v || v.dataset.rrAssigned !== "1") { say("No van assignments to clear this week."); return; }
                fire("rr-sched-vans-h");
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

          <!-- ── Operational summary strip · thin, quiet status band
               under the action bar: open routes, attendance risks,
               drivers missing vans, and the Draft/Live state. Counts
               are painted by renderScheduleWeek (same data as the
               coverage card); each item hides itself at zero. The
               status chip mirrors the legacy title pill
               (#rr-sched-v2-status) so the Finalize flow keeps a
               single source of truth. -->
          <div class="rr-opstrip" id="rr-sched-opstrip" role="status" aria-label="Operational summary">
            <span class="rr-opstrip-item rr-opstrip-open" id="rr-strip-open" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/></svg>
              <span id="rr-strip-open-text"></span>
            </span>
            <span class="rr-opstrip-item rr-opstrip-att" id="rr-strip-att" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span id="rr-strip-att-text"></span>
            </span>
            <span class="rr-opstrip-item rr-opstrip-vans" id="rr-strip-vans" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="13" height="10" rx="1.2"/><path d="M15 8h4l3 3v4h-7z"/><circle cx="6.5" cy="17" r="1.7"/><circle cx="17.5" cy="17" r="1.7"/></svg>
              <span id="rr-strip-vans-text"></span>
            </span>
            <span class="rr-opstrip-status" id="rr-strip-status" data-state="draft">Schedule Draft</span>
          </div>
          <script>
            // Mirror the legacy Draft/Live pill into the strip's status
            // chip. The pill (#rr-sched-v2-status) is still the element
            // the Finalize flow updates; it's hidden by CSS, and this
            // observer keeps the visible chip truthful.
            (function () {
              if (window.__rrOpstripStatusWired) return;
              window.__rrOpstripStatusWired = true;
              function sync() {
                var pill = document.getElementById("rr-sched-v2-status");
                var chip = document.getElementById("rr-strip-status");
                if (!pill || !chip) return;
                var state = pill.getAttribute("data-state") === "live" ? "live" : "draft";
                chip.setAttribute("data-state", state);
                chip.textContent = state === "live" ? "Schedule Live" : "Schedule Draft";
              }
              function wire() {
                var pill = document.getElementById("rr-sched-v2-status");
                if (!pill) { setTimeout(wire, 600); return; }
                new MutationObserver(sync).observe(pill, { attributes: true, attributeFilter: ["data-state"] });
                sync();
              }
              if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
              else wire();
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
                  <!-- Focus-mode toggle moved to the Quick Access
                       Toolbar (top-left of the topbar); the header-card
                       icon was removed per operator request. -->
                  <!-- Hide / show the Open shifts rail. Unlike Focus mode
                       (which hides all page chrome), this only collapses the
                       right-hand Open shifts box so the grid fills that space.
                       Toggles body.rr-sched-hide-openshifts; persisted in
                       localStorage('rr-sched-hide-openshifts'). -->
                  <button class="rr-tf-icon" id="rr-sched-openshifts-toggle" type="button"
                          title="Hide the Open shifts panel — the schedule fills the space"
                          aria-label="Hide open shifts" aria-pressed="false"
                          style="position:relative;top:0;right:0">
                    <svg class="ic-os-hide" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/><polyline points="10 9 7 12 10 15"/></svg>
                    <svg class="ic-os-show" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/><polyline points="7 9 10 12 7 15"/></svg>
                  </button>
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
                  <!-- "Show pinned only" pin icon removed from the
                       header card per operator request. -->
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

            <!-- Marcus Davidson -->
            <div class="cal-grid">
              <div class="cal-row-label"><div class="avatar-sm tier-d">MD</div><div><div class="cal-row-label-name">Marcus Davidson</div><div class="cal-row-label-meta">KMO1 · 18 mo</div></div></div>
              <div class="cal-cell today"><div class="shift-chip"><div class="shift-chip-route">KMO1-14B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-14B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-14B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-14B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-22A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
            </div>

            <!-- Tasha Reyes -->
            <div class="cal-grid">
              <div class="cal-row-label"><div class="avatar-sm tier-d">TR</div><div><div class="cal-row-label-name">Tasha Reyes</div><div class="cal-row-label-meta">KMO2 · 9 mo</div></div></div>
              <div class="cal-cell today"><div class="shift-chip"><div class="shift-chip-route">KMO2-08C</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO2-08C</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO2-08C</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO2-08C</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell">
                <div class="conflict-marker" title="Swap pending approval — schedule will adjust">!</div>
                <div class="shift-chip swap"><div class="shift-chip-route">↔ Hill</div><div class="shift-chip-time">Pending swap</div></div>
              </div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
            </div>

            <!-- Kerwin Whitfield -->
            <div class="cal-grid">
              <div class="cal-row-label"><div class="avatar-sm tier-c">KW</div><div><div class="cal-row-label-name">Kerwin Whitfield</div><div class="cal-row-label-meta">KMO1 · 24 mo</div></div></div>
              <div class="cal-cell today"><div class="shift-chip"><div class="shift-chip-route">KMO1-09A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-09A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-09A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-09A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-09A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-09A</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
            </div>

            <!-- Jordan Beckett -->
            <div class="cal-grid">
              <div class="cal-row-label"><div class="avatar-sm tier-c">JB</div><div><div class="cal-row-label-name">Jordan Beckett</div><div class="cal-row-label-meta">KMO3 · 6 mo</div></div></div>
              <div class="cal-cell today"><div class="shift-chip off">Off</div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-04D</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-04D</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-04D</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-04D</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-04D</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
            </div>

            <!-- Devon Patterson — has time off -->
            <div class="cal-grid">
              <div class="cal-row-label"><div class="avatar-sm tier-b">DP</div><div><div class="cal-row-label-name">Devon Patterson</div><div class="cal-row-label-meta">KMO3 · 11 mo</div></div></div>
              <div class="cal-cell today"><div class="shift-chip"><div class="shift-chip-route">KMO3-12B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-12B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO3-12B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell">
                <div class="conflict-marker error" title="PTO approved but route still scheduled — needs reassignment">!</div>
                <div class="shift-chip timeoff"><div class="shift-chip-route">PTO</div></div>
              </div>
              <div class="cal-cell"><div class="shift-chip timeoff"><div class="shift-chip-route">PTO</div></div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
            </div>

            <!-- Camille Foster -->
            <div class="cal-grid">
              <div class="cal-row-label"><div class="avatar-sm tier-a">CF</div><div><div class="cal-row-label-name">Camille Foster</div><div class="cal-row-label-meta">KMO1 · 22 mo</div></div></div>
              <div class="cal-cell today"><div class="shift-chip"><div class="shift-chip-route">KMO1-03B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-03B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-03B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-03B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip"><div class="shift-chip-route">KMO1-03B</div><div class="shift-chip-time">7:00a – 6:00p</div></div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
              <div class="cal-cell"><div class="shift-chip off">Off</div></div>
            </div>

            <!-- Open shift row -->
            <div class="cal-grid" style="background:var(--canvas)">
              <div class="cal-row-label" style="background:var(--canvas)"><div class="avatar-sm" style="background:var(--canvas);color:var(--text-subtle);border:1.5px dashed var(--border-strong)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div><div><div class="cal-row-label-name" style="color:var(--text-muted)">Unassigned</div><div class="cal-row-label-meta">3 routes need a driver</div></div></div>
              <div class="cal-cell today"><div class="shift-chip open">+ KMO2-15A</div></div>
              <div class="cal-cell"><div class="shift-chip off"></div></div>
              <div class="cal-cell"><div class="shift-chip off"></div></div>
              <div class="cal-cell"><div class="shift-chip open">+ KMO3-07C</div></div>
              <div class="cal-cell"><div class="shift-chip open">+ KMO1-19D</div></div>
              <div class="cal-cell"><div class="shift-chip off"></div></div>
              <div class="cal-cell"><div class="shift-chip off"></div></div>
            </div>

            <!-- Coverage strip -->
            <div class="coverage-strip">
              <div class="coverage-cell">Coverage</div>
              <div class="coverage-cell partial">87 / 90</div>
              <div class="coverage-cell full">90 / 90</div>
              <div class="coverage-cell full">90 / 90</div>
              <div class="coverage-cell gap">86 / 90</div>
              <div class="coverage-cell gap">85 / 90</div>
              <div class="coverage-cell full">42 / 42</div>
              <div class="coverage-cell full">38 / 38</div>
            </div>
          </div>

          <!-- Right rail: Open Shifts panel lives inside the Driver pool footer;
               the Driver pool keeps its existing click-to-assign markup. -->
          <div class="sched-right-rail">
          <!-- DRIVER POOL — drag-to-assign or click to insert -->
          <aside class="driver-pool">
            <div class="pool-head">
              <span>Driver pool</span>
              <span style="font-weight:600;letter-spacing:0;text-transform:none;color:var(--text-subtle);font-size:var(--fs-xs)">12 available</span>
            </div>
            <input class="pool-search" placeholder="Search drivers…" />

            <div>
              <div class="pool-section-label">Available</div>
              <div class="pool-driver" draggable="true" onclick="toast('Click a calendar cell to assign Sasha Underwood')">
                <div class="avatar-sm tier-c">SU</div>
                <div><div class="pool-driver-name">Sasha Underwood</div><div class="pool-driver-meta">KMO2 · 0h scheduled</div></div>
                <span class="pool-driver-hours">0h</span>
              </div>
              <div class="pool-driver" draggable="true" onclick="toast('Click a calendar cell to assign Trevor Anders')">
                <div class="avatar-sm tier-a">TA</div>
                <div><div class="pool-driver-name">Trevor Anders</div><div class="pool-driver-meta">KMO1 · onboarding · 0h</div></div>
                <span class="pool-driver-hours">0h</span>
              </div>
              <div class="pool-driver" draggable="true" onclick="toast('Click a calendar cell to assign Lena Whitcomb')">
                <div class="avatar-sm tier-a">LW</div>
                <div><div class="pool-driver-name">Lena Whitcomb</div><div class="pool-driver-meta">KMO1 · 22h scheduled</div></div>
                <span class="pool-driver-hours">22h</span>
              </div>
              <div class="pool-driver" draggable="true" onclick="toast('Click a calendar cell to assign Asha Thornton')">
                <div class="avatar-sm tier-b">AT</div>
                <div><div class="pool-driver-name">Asha Thornton</div><div class="pool-driver-meta">KMO2 · 33h scheduled</div></div>
                <span class="pool-driver-hours">33h</span>
              </div>
              <div class="pool-driver" draggable="true" onclick="toast('Click a calendar cell to assign Marcus Hill')">
                <div class="avatar-sm tier-b">MH</div>
                <div><div class="pool-driver-name">Marcus Hill</div><div class="pool-driver-meta">KMO1 · 44h scheduled</div></div>
                <span class="pool-driver-hours">44h</span>
              </div>
              <div class="pool-driver maxed" draggable="false" title="At weekly max">
                <div class="avatar-sm tier-c">DM</div>
                <div><div class="pool-driver-name">Devin Mateo</div><div class="pool-driver-meta">KMO3 · max hours</div></div>
                <span class="pool-driver-hours">55h</span>
              </div>
            </div>

            <div>
              <div class="pool-section-label">Off / time off</div>
              <div class="pool-driver off">
                <div class="avatar-sm tier-d">DP</div>
                <div><div class="pool-driver-name">Devon Patterson</div><div class="pool-driver-meta">PTO May 15–17</div></div>
                <span class="pool-driver-hours">PTO</span>
              </div>
              <div class="pool-driver off">
                <div class="avatar-sm tier-c">JB</div>
                <div><div class="pool-driver-name">Jordan Beckett</div><div class="pool-driver-meta">Off Mon (school)</div></div>
                <span class="pool-driver-hours">Off</span>
              </div>
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
        <div class="sched-subview" id="sched-sub-drivers" style="display:none">
          <div class="schedule-grid-wrap">
            <div class="sg-toolbar">
              <div>78 active drivers · click any row for full schedule editor</div>
              <div class="sg-toolbar-actions">
                <button class="btn btn-sm">Apply template…</button>
                <button class="btn btn-sm">Filter: All stations</button>
              </div>
            </div>
            <table class="schedule-table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th class="day">M</th><th class="day">T</th><th class="day">W</th><th class="day">T</th><th class="day">F</th><th class="day">S</th><th class="day">S</th>
                  <th>Hours</th>
                  <th>Time off</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="driver-cell"><div class="avatar-sm tier-d">MD</div><div><div class="cell-name">Marcus Davidson</div><div class="cell-name-sub">KMO1 · 18 mo</div></div></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle" onclick="sgToggle(this)"></button></td>
                  <td class="day-cell"><button class="day-toggle" onclick="sgToggle(this)"></button></td>
                  <td style="font-size:var(--fs-sm);font-weight:600">55h</td>
                  <td class="timeoff-cell">—</td>
                  <td class="actions-cell"><button class="btn btn-sm">Edit</button></td>
                </tr>
                <tr>
                  <td class="driver-cell"><div class="avatar-sm tier-d">TR</div><div><div class="cell-name">Tasha Reyes</div><div class="cell-name-sub">KMO2 · 9 mo</div></div></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle" onclick="sgToggle(this)"></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle on" onclick="sgToggle(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></button></td>
                  <td class="day-cell"><button class="day-toggle" onclick="sgToggle(this)"></button></td>
                  <td style="font-size:var(--fs-sm);font-weight:600">55h</td>
                  <td class="timeoff-cell"><span class="has-off">May 10–12</span></td>
                  <td class="actions-cell"><button class="btn btn-sm">Edit</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- TIME OFF APPROVAL QUEUE -->

        <!-- SHIFT SWAPS APPROVAL QUEUE -->
        <div class="sched-subview" id="sched-sub-swaps" style="display:none">
          <div class="section">
            <div class="section-head">
              <h2 class="section-title">Pending swaps</h2>
              <span class="section-sub">2 requests · review before publish</span>
            </div>

            <div class="approval-card">
              <div class="approval-icon swap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
              <div>
                <div class="approval-title">Tasha Reyes ↔ Marcus Hill · Friday May 4</div>
                <div class="approval-msg">Tasha wants to swap her <strong>KMO2-08C</strong> shift for Marcus's <strong>KMO2-15A</strong>. Both qualified for the routes. Marcus has accepted.</div>
                <div class="approval-meta"><span>Requested by Tasha 3h ago</span><span>·</span><span>Marcus accepted 2h ago</span></div>
              </div>
              <div class="approval-actions">
                <button class="btn btn-sm">Deny</button>
                <button class="btn btn-primary btn-sm">Approve swap</button>
              </div>
            </div>

            <div class="approval-card">
              <div class="approval-icon swap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
              <div>
                <div class="approval-title">Jordan Beckett · drop Wednesday</div>
                <div class="approval-msg">Jordan posted Wed May 2 (KMO3-04D) as available for swap. <strong>2 drivers offered to take it</strong> (Devon Patterson, Asha Thornton).</div>
                <div class="approval-meta"><span>Posted yesterday</span><span>·</span><span>2 offers waiting</span></div>
              </div>
              <div class="approval-actions">
                <button class="btn btn-sm">Decline</button>
                <button class="btn btn-primary btn-sm">Choose driver</button>
              </div>
            </div>
          </div>
        </div>

        <!-- AVAILABILITY MATRIX -->
        <div class="sched-subview" id="sched-sub-availability" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:var(--s-4)">
            <div>
              <h2 style="font-size:var(--fs-lg);font-weight:600;margin:0">Driver availability</h2>
              <p class="page-sub" style="margin:4px 0 0 0">What each driver is willing to work, recurring. Drivers update this in their app — managers see conflicts when scheduling outside it.</p>
            </div>
            <div style="display:flex;gap:var(--s-2)">
              <button class="btn btn-sm btn-ghost btn-icon" title="Export" aria-label="Export">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="btn btn-sm">Request availability update</button>
            </div>
          </div>

          <div class="avail-legend">
            <div class="avail-legend-item"><span class="avail-legend-swatch preferred"></span>Preferred</div>
            <div class="avail-legend-item"><span class="avail-legend-swatch available"></span>Available</div>
            <div class="avail-legend-item"><span class="avail-legend-swatch unavailable"></span>Not available</div>
            <div class="avail-legend-item"><span class="avail-legend-swatch timeoff"></span>Time off (date-specific)</div>
            <div class="avail-legend-item" style="margin-left:auto;color:var(--text-subtle)">Last updated by drivers · 2h ago</div>
          </div>

          <table class="avail-table">
            <thead>
              <tr>
                <th class="driver-col">Driver</th>
                <th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th>
                <th>Min hrs</th>
                <th>Max hrs</th>
                <th>Preferences</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="driver-col"><div style="display:flex;align-items:center;gap:var(--s-2-5)"><div class="avatar-sm tier-d">MD</div><div><div class="cell-name">Marcus Davidson</div><div class="cell-name-sub">KMO1 · 18 mo</div></div></div></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell available">✓</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td class="avail-hours"><strong>40h</strong></td>
                <td class="avail-hours"><strong>55h</strong></td>
                <td style="font-size:var(--fs-xs);color:var(--text-muted);text-align:left">Open to swaps · Backup pool</td>
              </tr>
              <tr>
                <td class="driver-col"><div style="display:flex;align-items:center;gap:var(--s-2-5)"><div class="avatar-sm tier-d">TR</div><div><div class="cell-name">Tasha Reyes</div><div class="cell-name-sub">KMO2 · 9 mo</div></div></div></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell available">✓</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td class="avail-hours"><strong>40h</strong></td>
                <td class="avail-hours"><strong>50h</strong></td>
                <td style="font-size:var(--fs-xs);color:var(--text-muted);text-align:left">Childcare on Wed · Open to swaps</td>
              </tr>
              <tr>
                <td class="driver-col"><div style="display:flex;align-items:center;gap:var(--s-2-5)"><div class="avatar-sm tier-c">KW</div><div><div class="cell-name">Kerwin Whitfield</div><div class="cell-name-sub">KMO1 · 24 mo</div></div></div></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell available">✓</span></td>
                <td class="avail-hours"><strong>50h</strong></td>
                <td class="avail-hours"><strong>60h</strong></td>
                <td style="font-size:var(--fs-xs);color:var(--text-muted);text-align:left">Wants extra hours · 6+ days</td>
              </tr>
              <tr>
                <td class="driver-col"><div style="display:flex;align-items:center;gap:var(--s-2-5)"><div class="avatar-sm tier-c">JB</div><div><div class="cell-name">Jordan Beckett</div><div class="cell-name-sub">KMO3 · 6 mo</div></div></div></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td class="avail-hours"><strong>40h</strong></td>
                <td class="avail-hours"><strong>50h</strong></td>
                <td style="font-size:var(--fs-xs);color:var(--text-muted);text-align:left">School Mondays · Tu–Sat preferred</td>
              </tr>
              <tr>
                <td class="driver-col"><div style="display:flex;align-items:center;gap:var(--s-2-5)"><div class="avatar-sm tier-b">DP</div><div><div class="cell-name">Devon Patterson</div><div class="cell-name-sub">KMO3 · 11 mo</div></div></div></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell timeoff">PTO</span></td>
                <td><span class="avail-cell timeoff">PTO</span></td>
                <td><span class="avail-cell available">✓</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td class="avail-hours"><strong>40h</strong></td>
                <td class="avail-hours"><strong>55h</strong></td>
                <td style="font-size:var(--fs-xs);color:var(--text-muted);text-align:left">PTO May 15–17</td>
              </tr>
              <tr>
                <td class="driver-col"><div style="display:flex;align-items:center;gap:var(--s-2-5)"><div class="avatar-sm tier-a">CF</div><div><div class="cell-name">Camille Foster</div><div class="cell-name-sub">KMO1 · 22 mo</div></div></div></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell preferred">✓</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td><span class="avail-cell unavailable">—</span></td>
                <td class="avail-hours"><strong>40h</strong></td>
                <td class="avail-hours"><strong>50h</strong></td>
                <td style="font-size:var(--fs-xs);color:var(--text-muted);text-align:left">Strict M–F</td>
              </tr>
            </tbody>
          </table>

          <div style="margin-top:var(--s-5);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:var(--s-5)">
            <h3 style="font-size:var(--fs-md);font-weight:600;margin:0 0 var(--s-3) 0">Availability summary by day</h3>
            <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:var(--s-2)">
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Mon</div><div style="font-size:18px;font-weight:700;color:var(--text)">71</div><div class="u-xs-subtle">of 78 available</div></div>
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Tue</div><div style="font-size:18px;font-weight:700;color:var(--text)">75</div><div class="u-xs-subtle">of 78 available</div></div>
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Wed</div><div style="font-size:18px;font-weight:700;color:var(--amber)">68</div><div class="u-xs-subtle">of 78 available</div></div>
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Thu</div><div style="font-size:18px;font-weight:700;color:var(--text)">73</div><div class="u-xs-subtle">of 78 available</div></div>
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Fri</div><div style="font-size:18px;font-weight:700;color:var(--text)">76</div><div class="u-xs-subtle">of 78 available</div></div>
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Sat</div><div style="font-size:18px;font-weight:700;color:var(--amber)">52</div><div class="u-xs-subtle">of 78 available</div></div>
              <div class="u-center"><div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Sun</div><div style="font-size:18px;font-weight:700;color:var(--red)">28</div><div class="u-xs-subtle">of 78 available</div></div>
            </div>
            <div style="margin-top:var(--s-4);padding-top:var(--s-3);border-top:1px solid var(--border);font-size:var(--fs-sm);color:var(--text-muted)">
              <strong style="color:var(--text)">Coverage forecast</strong> — Sunday is your tightest day. Demand 38 routes, only 28 drivers available. <a style="color:var(--accent-text);font-weight:500" onclick="goto('pipeline')" href="javascript:void(0)">Hire 10 more weekend-available drivers →</a>
            </div>
          </div>
        </div>

        <!-- FORECAST — 4-week look-ahead -->
        <div class="sched-subview" id="sched-sub-forecast" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:var(--s-4)">
            <div>
              <h2 style="font-size:var(--fs-lg);font-weight:600;margin:0">4-week coverage forecast</h2>
              <p class="page-sub" style="margin:4px 0 0 0">Predicts uncovered routes before they happen, based on schedules, time-off, and historical patterns.</p>
            </div>
            <button class="btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.39 7.36H22l-6.19 4.5 2.36 7.36L12 16.71l-6.17 4.51 2.36-7.36L2 9.36h7.61z"/></svg>
              Auto-fix all
            </button>
          </div>

          <div class="forecast-grid">
            <div class="forecast-week">
              <div class="forecast-week-label">Week 1 · This week</div>
              <div class="forecast-week-dates">May 1 – May 7</div>
              <div class="forecast-coverage"><div class="forecast-num">87</div><div class="forecast-of">of 90 routes</div></div>
              <div class="forecast-status warn"><span class="kpi-pip amber"></span>3 open shifts</div>
              <div class="forecast-issues"><strong>Tuesday + Friday</strong> short — backup pool notified for KMO2-15A and KMO3-07C.</div>
              <button class="forecast-action">Manage open shifts</button>
            </div>

            <div class="forecast-week">
              <div class="forecast-week-label">Week 2 · Next week</div>
              <div class="forecast-week-dates">May 8 – May 14</div>
              <div class="forecast-coverage"><div class="forecast-num">85</div><div class="forecast-of">of 90 routes</div></div>
              <div class="forecast-status warn"><span class="kpi-pip amber"></span>5 open shifts</div>
              <div class="forecast-issues">Reyes off Mon–Wed (PTO). <strong>2 routes need backup</strong> Mon, 1 Tue, 2 Wed.</div>
              <button class="forecast-action primary" onclick="openAiSchedule()">Smart Fill →</button>
            </div>

            <div class="forecast-week">
              <div class="forecast-week-label">Week 3</div>
              <div class="forecast-week-dates">May 15 – May 21</div>
              <div class="forecast-coverage"><div class="forecast-num">82</div><div class="forecast-of">of 90 routes</div></div>
              <div class="forecast-status bad"><span class="kpi-pip red"></span>8 open shifts</div>
              <div class="forecast-issues">Devon Patterson approved PTO. <strong>3 callout-prone Mondays</strong> in pattern history. Backup pool currently 4 deep — likely insufficient.</div>
              <button class="forecast-action primary">Plan hires →</button>
            </div>

            <div class="forecast-week">
              <div class="forecast-week-label">Week 4</div>
              <div class="forecast-week-dates">May 22 – May 28</div>
              <div class="forecast-coverage"><div class="forecast-num">80</div><div class="forecast-of">of 90 routes</div></div>
              <div class="forecast-status bad"><span class="kpi-pip red"></span>10 open shifts</div>
              <div class="forecast-issues">Camille Foster PTO. Memorial Day weekend dip. <strong>Hire 3 drivers</strong> from cycle 14 to fill structural gap.</div>
              <button class="forecast-action primary" onclick="goto('pipeline')">Open pipeline →</button>
            </div>
          </div>

          <div style="margin-top:var(--s-6);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:var(--s-5)">
            <h3 style="font-size:var(--fs-md);font-weight:600;margin:0 0 var(--s-3) 0">Pattern insights</h3>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--s-4)">
              <div>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Callout pattern</div>
                <div style="font-size:var(--fs-md);color:var(--text);line-height:1.5">3 drivers consistently call out Mondays. Build buffer for that day.</div>
              </div>
              <div>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Demand seasonality</div>
                <div style="font-size:var(--fs-md);color:var(--text);line-height:1.5">Friday demand averages 105% of Tuesday. Schedule 2 extra drivers Fri.</div>
              </div>
              <div>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Open shift fill rate</div>
                <div style="font-size:var(--fs-md);color:var(--text);line-height:1.5">Backup pool fills 78% of open shifts within 24h. Notify earlier next time.</div>
              </div>
            </div>
          </div>
        </div>

        <!-- TEMPLATES — saved weekly patterns the operator can paste forward. -->
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
          <!-- Split screen · LEFT = one unified request stream (PTO,
               Unpaid time off and Availability changes merged into a
               single chronological queue). RIGHT = three equally-sized
               operational reports. Both render at once via
               _renderSchedRequestsActive. -->
          <div class="sched-requests-split">
            <section class="sched-requests-card" id="rr-sched-req-stream-panel">
              <header class="sched-requests-card-head">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                <span class="sched-requests-card-title">Requests</span>
                <button type="button" class="btn btn-sm" id="rr-pto-report-btn" style="margin-left:auto;display:inline-flex;align-items:center;gap:6px">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  PTO report
                </button>
              </header>
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
          <!-- 13-week OKAMI planner host · the live OKAMI table is
               moved here at runtime by _rrMoveOkami13Week() on entry
               and returned to #view-okami on exit. -->
          <section class="rr-tgt-13w" id="rr-sched-targets-13week" aria-label="13-week route planner">
            <div class="rr-tgt-13w-head">
              <div>
                <div class="rr-tgt-13w-title">
                  Route planner
                  <span class="rr-tgt-13w-badge" title="Amazon's term for the 13-week DSP route plan horizon">13-week plan</span>
                </div>
                <p class="rr-tgt-13w-sub">Routes vs. staffing vs. risk · drawn from your real history. Edit any week to recalc downstream coverage.</p>
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
        <!-- TEMPLATES -->
        <div class="sched-subview" id="sched-sub-templates" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-4)">
            <div class="page-sub" style="margin:0">Saved schedule patterns. Apply to new drivers or for quick weekly setup.</div>
            <button class="btn btn-primary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New template</button>
          </div>

          <div class="templates-grid">
            <div class="template-card">
              <div class="template-card-name">Standard M–F</div>
              <div class="template-card-days">M T W T F · · ·</div>
              <div class="template-card-meta">7:00a – 6:00p · used by 62 drivers</div>
            </div>
            <div class="template-card">
              <div class="template-card-name">Tuesday – Saturday</div>
              <div class="template-card-days">· T W T F S ·</div>
              <div class="template-card-meta">7:00a – 6:00p · used by 12 drivers</div>
            </div>
            <div class="template-card">
              <div class="template-card-name">Weekend warrior</div>
              <div class="template-card-days">· · · · F S S</div>
              <div class="template-card-meta">7:00a – 6:00p · used by 4 drivers</div>
            </div>
            <div class="template-card">
              <div class="template-card-name">Part-time M/W/F</div>
              <div class="template-card-days">M · W · F · ·</div>
              <div class="template-card-meta">7:00a – 6:00p · used by 0 drivers</div>
            </div>
            <div class="template-card">
              <div class="template-card-name">6-day week</div>
              <div class="template-card-days">M T W T F S ·</div>
              <div class="template-card-meta">7:00a – 6:00p · used by 0 drivers</div>
            </div>
          </div>
        </div>


        </div><!-- /.tcp-body -->
      </div>
    