// Preload script. Runs before the renderer loads, in an isolated
// context that has access to both Node and the renderer's window.
// We use contextBridge to expose ONLY a narrow API surface; nothing
// else (no Node, no fs, no raw ipcRenderer) leaks.
//
// Option B security model — capability gating by origin:
//   • The bundled local UI (file://) is fully trusted → it gets the full
//     `window.rr` surface (incl. powerful bits like arbitrary report
//     downloads and "show in folder").
//   • The live dashboard (https://…gorouteready.com) is trusted-but-remote
//     → it gets only the minimal `window.routeready` bridge: trigger a
//     portal sign-in, check session state, drive agent tasks. No raw file
//     I/O, no arbitrary-URL download, and it never receives the portal
//     cookies themselves — capture/use stays entirely native.
// Any other origin gets nothing (main also blocks it from loading in-app).

const { contextBridge, ipcRenderer } = require("electron");

const isLocal = location.protocol === "file:";
// Trusted dashboard host(s). Keep in sync with main's DEFAULT_DASHBOARD_URL
// if you point the app at a different domain.
const isDashboard = /(^|\.)gorouteready\.com$/i.test(location.hostname);

// ─── Full surface — bundled local UI only ───────────────────────────
if (isLocal) {
  contextBridge.exposeInMainWorld("rr", {
    config: {
      /** Read the saved portal URL + defaults. */
      get: () => ipcRenderer.invoke("config:get"),
      /** Persist a new portal URL. */
      set: (opts) => ipcRenderer.invoke("config:set", opts),
    },
    portal: {
      /** Launch a visible Chromium for the operator to sign in to Amazon. */
      login: (opts) => ipcRenderer.invoke("portal:login", opts),
      /** Capture the current portal storageState and persist (encrypted). */
      saveSession: () => ipcRenderer.invoke("portal:saveSession"),
      /** Wipe the persisted session and close the portal browser. */
      logout: () => ipcRenderer.invoke("portal:logout"),
      /** Check whether we have a persisted session on disk. */
      hasSession: () => ipcRenderer.invoke("portal:hasSession"),
      /** Headless probe: load the portal home and report whether the
       * cached session is still valid. */
      probe: (opts) => ipcRenderer.invoke("portal:probe", opts),
      /** Subscribe to the auto-save event fired by main when the headed
       * login window navigates past the auth wall (or closes). */
      onAutoSaved: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("portal:autoSaved", handler);
        return () => ipcRenderer.removeListener("portal:autoSaved", handler);
      },
    },
    reports: {
      /** Download a file from `url` (optionally clicking a selector). */
      download: (opts) => ipcRenderer.invoke("reports:download", opts),
      /** Native folder picker; returns { ok, dir } or { canceled }. */
      pickDownloadDir: () => ipcRenderer.invoke("reports:pickDownloadDir"),
      /** Reveal a previously downloaded file in the OS file manager. */
      openInFolder: (opts) => ipcRenderer.invoke("reports:openInFolder", opts),
      /** Recent download history (up to 20 entries). */
      listHistory: () => ipcRenderer.invoke("reports:listHistory"),
    },
    scraper: {
      list: () => ipcRenderer.invoke("scraper:list"),
      get: (id) => ipcRenderer.invoke("scraper:get", { id }),
      save: (patch) => ipcRenderer.invoke("scraper:save", patch),
      delete: (id) => ipcRenderer.invoke("scraper:delete", { id }),
      record: (id) => ipcRenderer.invoke("scraper:record", { id }),
      runNow: (id) => ipcRenderer.invoke("scraper:runNow", { id }),
      resetSeen: (id) => ipcRenderer.invoke("scraper:resetSeen", { id }),
      onRecipeUpdated: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("scraper:recipeUpdated", handler);
        return () => ipcRenderer.removeListener("scraper:recipeUpdated", handler);
      },
    },
    scheduler: {
      list: () => ipcRenderer.invoke("scheduler:list"),
      saveJob: (job) => ipcRenderer.invoke("scheduler:saveJob", job),
      deleteJob: (id) => ipcRenderer.invoke("scheduler:deleteJob", { id }),
      runNow: (id) => ipcRenderer.invoke("scheduler:runNow", { id }),
      onJobUpdated: (cb) => {
        const handler = (_evt, payload) => cb(payload);
        ipcRenderer.on("scheduler:jobUpdated", handler);
        return () => ipcRenderer.removeListener("scheduler:jobUpdated", handler);
      },
    },
    agent: {
      getConfig: () => ipcRenderer.invoke("agent:getConfig"),
      setConfig: (patch) => ipcRenderer.invoke("agent:setConfig", patch),
      listTasks: () => ipcRenderer.invoke("agent:listTasks"),
      getTask: (id) => ipcRenderer.invoke("agent:getTask", { id }),
      saveTask: (patch) => ipcRenderer.invoke("agent:saveTask", patch),
      deleteTask: (id) => ipcRenderer.invoke("agent:deleteTask", { id }),
      resetSeen: (id) => ipcRenderer.invoke("agent:resetSeen", { id }),
      runNow: (id) => ipcRenderer.invoke("agent:runNow", { id }),
      stop: (id) => ipcRenderer.invoke("agent:stop", { id }),
      onStep: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("agent:step", handler);
        return () => ipcRenderer.removeListener("agent:step", handler);
      },
      onTaskUpdated: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("agent:taskUpdated", handler);
        return () => ipcRenderer.removeListener("agent:taskUpdated", handler);
      },
    },
  });
}

// ─── Minimal bridge — the live dashboard (and local) ────────────────
// This is the Option B surface the web dashboard calls. Deliberately
// small: trigger sign-in, read session state, drive agent tasks. No file
// I/O, no arbitrary download, never returns portal cookies.
if (isLocal || isDashboard) {
  contextBridge.exposeInMainWorld("routeready", {
    /** Lets the dashboard detect it's running inside the desktop app and
     * reveal the "Sync Portal" + agent controls. */
    isDesktop: true,
    /** Installed app version (so the dashboard can gate features that
     * need a newer bridge). */
    getVersion: () => ipcRenderer.invoke("app:getVersion"),

    /** Open the managed portal sign-in window and capture the session. */
    syncPortal: (opts) => ipcRenderer.invoke("portal:login", opts),
    /** Whether a portal session is currently saved. */
    hasPortalSession: () => ipcRenderer.invoke("portal:hasSession"),
    /** Forget the saved portal session. */
    forgetPortal: () => ipcRenderer.invoke("portal:logout"),
    /** Headless validity probe of the saved portal session. */
    probePortal: (opts) => ipcRenderer.invoke("portal:probe", opts),
    /** Fires when the portal session is auto-saved post-login. */
    onPortalSaved: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("portal:autoSaved", handler);
      return () => ipcRenderer.removeListener("portal:autoSaved", handler);
    },

    agent: {
      getConfig: () => ipcRenderer.invoke("agent:getConfig"),
      setConfig: (patch) => ipcRenderer.invoke("agent:setConfig", patch),
      listTasks: () => ipcRenderer.invoke("agent:listTasks"),
      getTask: (id) => ipcRenderer.invoke("agent:getTask", { id }),
      saveTask: (patch) => ipcRenderer.invoke("agent:saveTask", patch),
      deleteTask: (id) => ipcRenderer.invoke("agent:deleteTask", { id }),
      runNow: (id) => ipcRenderer.invoke("agent:runNow", { id }),
      stop: (id) => ipcRenderer.invoke("agent:stop", { id }),
      onStep: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("agent:step", handler);
        return () => ipcRenderer.removeListener("agent:step", handler);
      },
      onTaskUpdated: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("agent:taskUpdated", handler);
        return () => ipcRenderer.removeListener("agent:taskUpdated", handler);
      },
    },
  });
}
