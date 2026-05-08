// Preload script. Runs before the renderer loads, in an isolated
// context that has access to both Node and the renderer's window.
// We use contextBridge to expose ONLY a narrow API surface to the
// renderer; nothing else (no Node, no fs, no ipcRenderer raw) leaks.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rr", {
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
  },
  routes: {
    /** Stub: today's routes pull. Not implemented yet. */
    pullToday: () => ipcRenderer.invoke("routes:pullToday"),
  },
});
