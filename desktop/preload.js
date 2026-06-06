// Preload script. Runs before the renderer loads, in an isolated
// context that has access to both Node and the renderer's window.
// We use contextBridge to expose ONLY a narrow API surface to the
// renderer; nothing else (no Node, no fs, no ipcRenderer raw) leaks.

const { contextBridge, ipcRenderer } = require("electron");

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
     * login window navigates past the auth wall (or closes). Lets the
     * renderer flip the status pill without an operator click. */
    onAutoSaved: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("portal:autoSaved", handler);
      return () => ipcRenderer.removeListener("portal:autoSaved", handler);
    },
  },
  reports: {
    /** Download a file from `url`. If `clickSelector` is given, we
     * load `url` as a page and click the selector to trigger the
     * download — otherwise `url` is treated as a direct file URL. */
    download: (opts) => ipcRenderer.invoke("reports:download", opts),
    /** Native folder picker; returns { ok, dir } or { canceled }. */
    pickDownloadDir: () => ipcRenderer.invoke("reports:pickDownloadDir"),
    /** Reveal a previously downloaded file in the OS file manager. */
    openInFolder: (opts) => ipcRenderer.invoke("reports:openInFolder", opts),
    /** Recent download history (up to 20 entries). */
    listHistory: () => ipcRenderer.invoke("reports:listHistory"),
  },
  scraper: {
    /** List every recipe stored on disk. */
    list: () => ipcRenderer.invoke("scraper:list"),
    /** Read a single recipe (with selectors). */
    get: (id) => ipcRenderer.invoke("scraper:get", { id }),
    /** Upsert a recipe (name / startUrl / interval / enabled / downloadDir / selectors). */
    save: (patch) => ipcRenderer.invoke("scraper:save", patch),
    /** Delete a recipe and its seen-set. */
    delete: (id) => ipcRenderer.invoke("scraper:delete", { id }),
    /** Launch the headed recorder; resolves once the operator finishes or cancels. */
    record: (id) => ipcRenderer.invoke("scraper:record", { id }),
    /** Fire the recipe now (headless), regardless of schedule. */
    runNow: (id) => ipcRenderer.invoke("scraper:runNow", { id }),
    /** Wipe the dedupe set so the next run re-emits everything visible. */
    resetSeen: (id) => ipcRenderer.invoke("scraper:resetSeen", { id }),
    /** Subscribe to recipe-updated events from the main process. */
    onRecipeUpdated: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("scraper:recipeUpdated", handler);
      return () => ipcRenderer.removeListener("scraper:recipeUpdated", handler);
    },
  },
  scheduler: {
    /** List all scheduled download jobs. */
    list: () => ipcRenderer.invoke("scheduler:list"),
    /** Upsert a job (omit id to create, include id to update). */
    saveJob: (job) => ipcRenderer.invoke("scheduler:saveJob", job),
    /** Delete a job by id. */
    deleteJob: (id) => ipcRenderer.invoke("scheduler:deleteJob", { id }),
    /** Fire a job immediately, regardless of its nextRunAt. */
    runNow: (id) => ipcRenderer.invoke("scheduler:runNow", { id }),
    /** Subscribe to job-updated events from the main process. */
    onJobUpdated: (cb) => {
      const handler = (_evt, payload) => cb(payload);
      ipcRenderer.on("scheduler:jobUpdated", handler);
      return () => ipcRenderer.removeListener("scheduler:jobUpdated", handler);
    },
  },
  agent: {
    /** Read agent settings (key presence, model, effort, upload config). */
    getConfig: () => ipcRenderer.invoke("agent:getConfig"),
    /** Persist agent settings. Pass apiKey/applySecret "" to clear, omit to keep. */
    setConfig: (patch) => ipcRenderer.invoke("agent:setConfig", patch),
    /** List every agent task on disk. */
    listTasks: () => ipcRenderer.invoke("agent:listTasks"),
    /** Read a single task. */
    getTask: (id) => ipcRenderer.invoke("agent:getTask", { id }),
    /** Upsert a task (goal / startUrl / interval / enabled / upload / model). */
    saveTask: (patch) => ipcRenderer.invoke("agent:saveTask", patch),
    /** Delete a task and its dedupe set. */
    deleteTask: (id) => ipcRenderer.invoke("agent:deleteTask", { id }),
    /** Wipe the dedupe set so the next run re-emits everything it finds. */
    resetSeen: (id) => ipcRenderer.invoke("agent:resetSeen", { id }),
    /** Run a task now (headless agent loop); resolves with the run summary. */
    runNow: (id) => ipcRenderer.invoke("agent:runNow", { id }),
    /** Ask a running task to stop at the next step boundary. */
    stop: (id) => ipcRenderer.invoke("agent:stop", { id }),
    /** Subscribe to live per-step events while a task runs. */
    onStep: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("agent:step", handler);
      return () => ipcRenderer.removeListener("agent:step", handler);
    },
    /** Subscribe to task-updated events (after each run). */
    onTaskUpdated: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("agent:taskUpdated", handler);
      return () => ipcRenderer.removeListener("agent:taskUpdated", handler);
    },
  },
});
