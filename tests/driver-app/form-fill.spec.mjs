// End-to-end tests for the driver PWA form-fill flow (app/app.js:renderFormFill
// and friends). These cover the CLIENT-side logic that has no other coverage:
// conditional show/hide, field validation blocking submit, the exact answers
// payload, draft autosave/restore, and the offline submission queue.
//
// How it works: we deep-link to #/tasks/form?id=… with a seeded driver session
// in localStorage, stub the supabase-js ESM import so createClient() returns an
// in-page fake client, and answer every RPC from an in-page mock that also
// records driver_submit_form payloads on window.__rrMock.submits. No network.
import { test, expect } from "@playwright/test";

const SESSION = {
  token: "tok_test", driver_id: "d1", dsp_id: "dsp1",
  name: "Test Driver", status: "active", dsp_name: "Test DSP",
};

// Install the network stub + in-page mock, seed the session, and open the form.
async function bootForm(page, form) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    if (/esm\.sh\/@supabase\/supabase-js/.test(route.request().url())) {
      return route.fulfill({
        contentType: "application/javascript",
        body: "export function createClient(){ return window.__rrSb; }",
      });
    }
    return route.abort();
  });

  await page.addInitScript(({ form, session }) => {
    localStorage.setItem("rr.driver.session", JSON.stringify(session));
    const mock = { handlers: {}, calls: [], submits: [] };
    mock.handlers.driver_get_form = () => ({ data: form, error: null });
    mock.handlers.driver_submit_form = (p) => {
      mock.submits.push(p);
      return { data: { id: "sub1", submitted_at: "2026-01-01T00:00:00Z" }, error: null };
    };
    mock.handlers.driver_list_forms = () => ({ data: [], error: null });
    window.__rrMock = mock;
    const from = () => ({
      upload: async () => ({ data: { path: "p" }, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: "x" } }),
      createSignedUrl: async () => ({ data: { signedUrl: "x" }, error: null }),
      remove: async () => ({ data: [], error: null }),
    });
    const chan = () => { const c = { on: () => c, subscribe: () => c, unsubscribe: () => {} }; return c; };
    window.__rrSb = {
      rpc: (name, params) => {
        mock.calls.push(name);
        const h = mock.handlers[name];
        return Promise.resolve(typeof h === "function" ? h(params) : (h !== undefined ? h : { data: null, error: null }));
      },
      storage: { from },
      channel: chan,
      removeChannel: () => {},
      functions: { invoke: async () => ({ data: null, error: null }) },
    };
  }, { form, session: SESSION });

  await page.goto(`http://127.0.0.1:8123/app/index.html#/tasks/form?id=${form.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#rr-form-fill");
}

const submits = (page) => page.evaluate(() => window.__rrMock.submits);
const clickSubmit = (page) => page.click('#rr-form-fill button[type="submit"]');
const queueCount = (page) => page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open("rr-form-queue", 1);
  req.onsuccess = () => {
    try {
      const r = req.result.transaction("subs", "readonly").objectStore("subs").getAll();
      r.onsuccess = () => res(r.result.length);
      r.onerror = () => res(-1);
    } catch { res(0); }
  };
  req.onerror = () => res(-1);
}));

// ── Fields used across tests ─────────────────────────────────────────
const F_NAME  = { id: "name",  type: "short_text", label: "Your name", required: true };
const F_HURT  = { id: "hurt",  type: "yes_no",     label: "Any injury?", required: true };
const F_DETAIL = { id: "detail", type: "short_text", label: "Describe",  required: true,
                   condition: { fieldId: "hurt", op: "eq", value: "yes" } };

test("conditional field reveals and hides with its trigger", async ({ page }) => {
  await bootForm(page, { id: "F1", title: "T", fields: [F_HURT, F_DETAIL], settings: {} });
  const cond = page.locator('.form-fill-cond[data-cond-field="detail"]');

  await expect(cond).toBeHidden();                            // hidden until trigger says yes
  await page.check('[data-rr-field="hurt"] input[value="yes"]');
  await expect(cond).toBeVisible();
  await page.check('[data-rr-field="hurt"] input[value="no"]');
  await expect(cond).toBeHidden();
});

test("a required field blocks submit and never calls the RPC", async ({ page }) => {
  await bootForm(page, { id: "F2", title: "T", fields: [F_NAME, F_HURT], settings: {} });
  await clickSubmit(page);
  await page.waitForTimeout(300);
  expect(await submits(page)).toHaveLength(0);
  await expect(page.locator("#rr-form-fill")).toBeVisible();  // stayed on the form
});

test("a valid submission sends the expected answers and leaves the form", async ({ page }) => {
  await bootForm(page, { id: "F3", title: "T", fields: [F_NAME, F_HURT, F_DETAIL], settings: {} });
  await page.fill('[data-rr-field="name"]', "Ada");
  await page.check('[data-rr-field="hurt"] input[value="no"]');   // hides detail → not required
  await clickSubmit(page);

  await page.waitForFunction(() => window.__rrMock.submits.length > 0);
  const [payload] = await submits(page);
  expect(payload.p_form_id).toBe("F3");
  expect(payload.p_answers.name).toBe("Ada");
  expect(payload.p_answers.hurt).toBe("no");
  await expect.poll(() => page.url()).toContain("#/tasks");     // navigated back to the hub
  await expect.poll(() => page.url()).not.toContain("/tasks/form");
});

test("a conditionally-revealed required field blocks until answered", async ({ page }) => {
  await bootForm(page, { id: "F4", title: "T", fields: [F_NAME, F_HURT, F_DETAIL], settings: {} });
  await page.fill('[data-rr-field="name"]', "Ada");
  await page.check('[data-rr-field="hurt"] input[value="yes"]');  // reveals detail (required)

  await clickSubmit(page);                                         // detail empty → blocked
  await page.waitForTimeout(300);
  expect(await submits(page)).toHaveLength(0);

  await page.fill('[data-rr-field="detail"]', "cut finger");
  await clickSubmit(page);
  await page.waitForFunction(() => window.__rrMock.submits.length > 0);
  const [payload] = await submits(page);
  expect(payload.p_answers.detail).toBe("cut finger");
});

test("number range validation blocks out-of-range values", async ({ page }) => {
  const age = { id: "age", type: "number", label: "Age", required: true, validation: { min: 18, max: 65 } };
  await bootForm(page, { id: "F5", title: "T", fields: [age], settings: {} });

  await page.fill('[data-rr-field="age"]', "10");
  await clickSubmit(page);
  await page.waitForTimeout(300);
  expect(await submits(page)).toHaveLength(0);                    // below min → blocked

  await page.fill('[data-rr-field="age"]', "30");
  await clickSubmit(page);
  await page.waitForFunction(() => window.__rrMock.submits.length > 0);
  expect((await submits(page))[0].p_answers.age).toBe("30");
});

test("in-progress answers are saved and restored across a reload", async ({ page }) => {
  await bootForm(page, { id: "F6", title: "T", fields: [F_NAME], settings: {} });
  await page.fill('[data-rr-field="name"]', "Draftee");
  await page.waitForTimeout(600);                                 // let the 400ms debounce fire

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#rr-form-fill");
  await expect(page.locator('[data-rr-field="name"]')).toHaveValue("Draftee");
});

test("submitting while offline queues the submission instead of sending it", async ({ page }) => {
  await bootForm(page, { id: "F7", title: "T", fields: [F_NAME, F_HURT], settings: {} });
  await page.fill('[data-rr-field="name"]', "Offline Ann");
  await page.check('[data-rr-field="hurt"] input[value="no"]');

  await page.context().setOffline(true);
  await clickSubmit(page);

  // Queued to IndexedDB, RPC never called, and we return to the hub.
  await page.waitForFunction(async () => {
    const c = await new Promise((res) => {
      const req = indexedDB.open("rr-form-queue", 1);
      req.onsuccess = () => { const r = req.result.transaction("subs", "readonly").objectStore("subs").getAll(); r.onsuccess = () => res(r.result.length); };
      req.onerror = () => res(0);
    });
    return c >= 1;
  });
  expect(await submits(page)).toHaveLength(0);
  expect(await queueCount(page)).toBe(1);
  await page.context().setOffline(false);
});
