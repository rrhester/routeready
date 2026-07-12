/* RouteReady · native capability bridge (Capacitor)
 *
 * Loaded as a classic script BEFORE app.js. It defines window.RRNative, a thin
 * seam over the Capacitor native shell (see docs/CAPACITOR-SETUP.md). In the
 * plain PWA there is no `window.Capacitor`, so every method is an inert no-op
 * and the app keeps its existing Web Push path unchanged.
 *
 * The bridge deliberately holds NO Supabase client and NO router — app.js owns
 * those. It surfaces raw device events (a push token, a notification tap) and
 * app.js decides what to do (register the token via driver_device_push_register,
 * deep-link the tap). That keeps this file dependency-free and safe to load
 * everywhere.
 *
 * What still needs a custom native plugin (documented, not implemented here):
 *   • PushKit VoIP token + CallKit incoming-call UI (iOS) — for live calls/PTT.
 *   • Android ConnectionService / full-screen intent + foreground audio service.
 * Those land in Phases 3–4 behind this same seam (registerVoip / presentIncomingCall).
 */
(function () {
  "use strict";

  var CAP = (typeof window !== "undefined" && window.Capacitor) || null;

  function isNative() {
    try { return !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform()); }
    catch (_) { return false; }
  }

  function platform() {
    try { return (CAP && CAP.getPlatform && CAP.getPlatform()) || "web"; }
    catch (_) { return "web"; }
  }

  function plugin(name) {
    return (CAP && CAP.Plugins && CAP.Plugins[name]) || null;
  }

  // The push "kind" our backend (device_push_tokens) expects for an alert
  // token on this platform: APNs on iOS, FCM on Android.
  function alertKind() {
    return platform() === "ios" ? "apns" : "fcm";
  }

  /* Register for standard (alert) push and stream the results back to app.js.
   *   opts.onToken(kind, token)  — called with a fresh APNs/FCM token.
   *   opts.onOpen(data)          — called when the user taps a notification;
   *                                `data` is the push payload's data object.
   *   opts.onError(err)          — optional.
   * Returns true if the native path was taken (caller should then SKIP Web
   * Push), false on web / when unavailable (caller keeps Web Push).
   */
  async function registerPush(opts) {
    opts = opts || {};
    if (!isNative()) return false;
    var Push = plugin("PushNotifications");
    if (!Push) return false;

    try {
      var perm = await Push.checkPermissions();
      if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
        perm = await Push.requestPermissions();
      }
      if (perm.receive !== "granted") return true; // native, but user declined

      // One-time listener wiring per app launch.
      if (!registerPush._wired) {
        registerPush._wired = true;
        Push.addListener("registration", function (t) {
          try { opts.onToken && opts.onToken(alertKind(), t && t.value); }
          catch (e) { /* swallow */ }
        });
        Push.addListener("registrationError", function (e) {
          try { opts.onError && opts.onError(e); } catch (_) {}
        });
        Push.addListener("pushNotificationActionPerformed", function (action) {
          var data = (action && action.notification && action.notification.data) || {};
          try { opts.onOpen && opts.onOpen(data); } catch (_) {}
        });
      }
      await Push.register();
      return true;
    } catch (e) {
      try { opts.onError && opts.onError(e); } catch (_) {}
      return true; // native path attempted — do not fall back to Web Push
    }
  }

  // Set the app icon badge (iOS/Android) when the plugin is present.
  async function setBadge(n) {
    var Badge = plugin("Badge");
    if (!Badge) return;
    try {
      if (!n) { await Badge.clear(); }
      else { await Badge.set({ count: n }); }
    } catch (_) {}
  }

  // Short haptic buzz on native (falls back silently on web).
  async function haptic(style) {
    var H = plugin("Haptics");
    if (!H) return;
    try { await H.impact({ style: style || "MEDIUM" }); } catch (_) {}
  }

  /* ── Phase 3–4 seam (VoIP / CallKit) ─────────────────────────────────────
   * These require the custom native plugin described in CAPACITOR-SETUP.md.
   * They are declared now so callers can feature-detect and the interface is
   * stable; today they resolve to a safe default on every platform.
   */
  async function registerVoip(opts) {
    var Voip = plugin("RRVoip"); // custom plugin, added in Phase 3
    if (!isNative() || !Voip) return false;
    try {
      if (!registerVoip._wired) {
        registerVoip._wired = true;
        Voip.addListener && Voip.addListener("voipToken", function (t) {
          try { opts && opts.onToken && opts.onToken("voip", t && t.value); } catch (_) {}
        });
      }
      await Voip.register();
      return true;
    } catch (_) { return true; }
  }

  window.RRNative = {
    isNative: isNative,
    platform: platform,
    plugin: plugin,
    registerPush: registerPush,
    registerVoip: registerVoip,
    setBadge: setBadge,
    haptic: haptic,
  };
})();
