// Email (Fleet Bridge) e2e (Email review EM#100) — the promoted core of
// the scratchpad QA harnesses that verified sections A–K. Guards:
//   1. Lazy boot (EM#96): no message fetch until the view opens; the
//      preboot keeps the sidebar unread dot honest.
//   2. Read-state + selection patching (EM#94): selecting an unread row
//      un-bolds it in place and ticks the tab counter.
//   3. Client search + scopes (EM#68/69): operators filter the loaded
//      folder; the Unread scope narrows.
//   4. The composer draft-autosave must NEVER snap half-typed
//      recipients into chips (operator-reported regression).
import { test, expect } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:8127";
const DSP  = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const F = {
  inbox:  "aaaaaaa1-0000-4000-8000-000000000001",
  drafts: "aaaaaaa1-0000-4000-8000-000000000002",
  sent:   "aaaaaaa1-0000-4000-8000-000000000003",
  trash:  "aaaaaaa1-0000-4000-8000-000000000005",
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

function b64(o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function fakeJwt() {
  return `${b64({ alg: "HS256" })}.${b64({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 31536000 })}.sig`;
}

function makeState() {
  const base = {
    dsp_id: DSP, applicant_id: null, cc_emails: null, bcc_emails: null, body_html: null,
    error_message: null, is_read: true, is_starred: false, snoozed_until: null,
    has_attachments: false, send_after: null, delivered_at: null, from_name: null,
  };
  return {
    folders: [
      { id: F.inbox,  name: "Inbox",  kind: "inbox",  position: 1, parent_id: null },
      { id: F.drafts, name: "Drafts", kind: "drafts", position: 2, parent_id: null },
      { id: F.sent,   name: "Sent",   kind: "sent",   position: 3, parent_id: null },
      { id: F.trash,  name: "Trash",  kind: "trash",  position: 5, parent_id: null },
    ],
    messages: [
      { ...base, id: "m-1", folder_id: F.inbox, direction: "inbound", status: "received",
        from_email: "vendor@fleetparts.com", to_email: "ozrk@mail.gorouteready.com",
        subject: "Invoice for parts", body_text: "invoice attached", is_read: false,
        has_attachments: true, created_at: hoursAgo(1) },
      { ...base, id: "m-2", folder_id: F.inbox, direction: "inbound", status: "received",
        from_email: "ann@applicant.com", to_email: "ozrk@mail.gorouteready.com",
        applicant_id: "app-1", subject: "Second interview", body_text: "hello",
        created_at: hoursAgo(2) },
    ],
    seen: { listGets: 0, msgPosts: [], msgPatches: [] },
  };
}

function eqVal(u, k) {
  const v = u.searchParams.get(k);
  return v && v.startsWith("eq.") ? v.slice(3) : null;
}

async function stubAndBoot(page, st, { openEmail = true } = {}) {
  await page.addInitScript(([key, jwt, user]) => {
    try {
      localStorage.setItem(key, JSON.stringify({
        access_token: jwt, token_type: "bearer",
        expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: "x",
        user: { id: user, aud: "authenticated", role: "authenticated", email: "op@ozark.com" },
      }));
    } catch (_) {}
  }, ["sb-doiwrhkirgblcvuskhno-auth-token", fakeJwt(), USER]);

  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN + "/")) return route.continue();
    if (!/supabase\.co/.test(url)) return route.abort();
    const req = route.request();
    const u = new URL(url);
    const p = u.pathname;
    const method = req.method();
    const accept = req.headers()["accept"] || "";
    const wantsObj = accept.includes("pgrst.object");
    const json = (body, status = 200, headers = {}) =>
      route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...headers }, body: JSON.stringify(body) });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 200, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,HEAD,OPTIONS" }, body: "" });
    }
    if (p.startsWith("/auth/v1/")) {
      return json({ access_token: fakeJwt(), token_type: "bearer", expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: "x",
        user: { id: USER, aud: "authenticated", role: "authenticated", email: "op@ozark.com" } });
    }
    if (p.startsWith("/storage/v1/")) return json({});
    if (p === "/rest/v1/rpc/email_folder_unread_counts") {
      const byF = {};
      for (const m of st.messages) {
        if (m.direction === "inbound" && m.is_read === false && m.folder_id) byF[m.folder_id] = (byF[m.folder_id] || 0) + 1;
      }
      return json(Object.entries(byF).map(([folder_id, unread]) => ({ folder_id, unread })));
    }
    if (p.startsWith("/rest/v1/rpc/")) return json(wantsObj ? {} : []);
    if (p === "/rest/v1/app_users") {
      const row = { id: USER, dsp_id: DSP, email: "op@ozark.com", full_name: "QA", role: "owner", allowed_pages: null };
      return json(wantsObj ? row : [row]);
    }
    if (p === "/rest/v1/dsps") {
      const row = { id: DSP, name: "Ozark Logistics", short_code: "OZRK", timezone: "America/New_York", metadata: {} };
      return json(wantsObj ? row : [row]);
    }
    if (p === "/rest/v1/fb_folders") return json(st.folders);
    if (p === "/rest/v1/email_messages") {
      const folderEq = eqVal(u, "folder_id");
      const idEq = eqVal(u, "id");
      let rows = st.messages.slice();
      if (folderEq) rows = rows.filter(m => m.folder_id === folderEq);
      if (idEq) rows = rows.filter(m => m.id === idEq);
      if (method === "HEAD") {
        return route.fulfill({ status: 200, headers: {
          "content-type": "application/json", "access-control-allow-origin": "*",
          "access-control-expose-headers": "content-range",
          "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` }, body: "" });
      }
      if (method === "GET") {
        if (folderEq) st.seen.listGets++;
        rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
        return json(wantsObj ? (rows[0] || {}) : rows);
      }
      if (method === "POST") {
        const body = req.postDataJSON() || {};
        st.seen.msgPosts.push(body);
        const row = { id: "new-" + st.seen.msgPosts.length, ...body };
        return json(wantsObj ? row : [row], 201);
      }
      if (method === "PATCH") {
        st.seen.msgPatches.push({ idEq, body: req.postDataJSON() || {} });
        rows.forEach(m => Object.assign(m, req.postDataJSON() || {}));
        return json([]);
      }
      if (method === "DELETE") return json([]);
    }
    if (p === "/rest/v1/document_intake") {
      if (method === "HEAD") return route.fulfill({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*",
        "access-control-expose-headers": "content-range", "content-range": "*/0" }, body: "" });
      return json([]);
    }
    return json(wantsObj ? {} : []);
  });

  await page.goto(ORIGIN + "/dashboard/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.evaluate(() => document.getElementById("rr-boot-overlay")?.remove());
  if (openEmail) {
    await page.evaluate(() => window.goto && window.goto("email"));
    await page.waitForSelector('#rr-em-inbox [data-em-msg="m-1"]', { timeout: 10000 });
  }
}

test("lazy boot: no message fetch pre-visit, dot painted, list on first visit", async ({ page }) => {
  const st = makeState();
  await stubAndBoot(page, st, { openEmail: false });
  expect(st.seen.listGets).toBe(0); // EM#96 — nothing loaded yet
  const dotShown = await page.$eval("#rr-nav-email-dot", el => !el.hidden).catch(() => false);
  expect(dotShown).toBe(true);      // preboot counts keep the dot honest
  await page.evaluate(() => window.goto && window.goto("email"));
  await page.waitForSelector('#rr-em-inbox [data-em-msg="m-1"]', { timeout: 10000 });
  expect(st.seen.listGets).toBe(1); // first visit loads the folder page
});

test("selecting an unread row patches read state in place", async ({ page }) => {
  const st = makeState();
  await stubAndBoot(page, st);
  await page.evaluate(() => {
    const el = document.querySelector('[data-em-msg="m-2"]');
    if (el) el.dataset.qaMark = "1";
  });
  await page.click('[data-em-msg="m-1"]');
  await page.waitForTimeout(500);
  // EM#94 — the sibling row's DOM survived (no full rebuild) and the
  // clicked row un-bolded with aria-selected set.
  expect(await page.$eval('[data-em-msg="m-2"]', el => el.dataset.qaMark)).toBe("1");
  const rowState = await page.$eval('[data-em-msg="m-1"]', el =>
    `${el.classList.contains("unread")}/${el.getAttribute("aria-selected")}`);
  expect(rowState).toBe("false/true");
  // Server read state written (0535).
  expect(st.seen.msgPatches.some(x => x.idEq === "m-1" && x.body.is_read === true)).toBe(true);
});

test("search operators and the Unread scope filter the loaded folder", async ({ page }) => {
  const st = makeState();
  await stubAndBoot(page, st);
  await page.fill("#rr-em-search", "from:vendor invoice");
  await page.waitForTimeout(400);
  let ids = await page.$$eval("#rr-em-inbox .em-msg-row", els => els.map(e => e.getAttribute("data-em-msg")));
  expect(ids).toEqual(["m-1"]);     // EM#68 — from: + free text
  await page.fill("#rr-em-search", "");
  await page.waitForTimeout(400);
  await page.selectOption("#rr-em-scope", "unread");
  await page.waitForTimeout(300);
  ids = await page.$$eval("#rr-em-inbox .em-msg-row", els => els.map(e => e.getAttribute("data-em-msg")));
  expect(ids).toEqual(["m-1"]);     // EM#69 — only the unread row
});

test("draft autosave never snaps a half-typed recipient into a chip", async ({ page }) => {
  const st = makeState();
  await stubAndBoot(page, st);
  await page.click('[data-em-act="new"]');
  await page.waitForSelector("#rr-em-composer-to");
  await page.click("#rr-em-composer-to");
  await page.type("#rr-em-composer-to", "rhester", { delay: 50 });
  await page.waitForTimeout(5200);  // ride out a 4s autosave tick mid-word
  expect(await page.locator('[data-em-cf="to"] .em-addr-chip').count()).toBe(0);
  expect(await page.inputValue("#rr-em-composer-to")).toBe("rhester");
  // The draft still captured the partial text non-destructively.
  const draftWrites = st.seen.msgPosts.filter(b => b.status === "draft")
    .concat(st.seen.msgPatches.map(x => x.body));
  expect(draftWrites.some(b => (b.to_email || "") === "rhester")).toBe(true);
  // Enter still commits explicitly.
  await page.type("#rr-em-composer-to", "75@gmail.com", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const chips = await page.locator('[data-em-cf="to"] .em-addr-chip').allTextContents();
  expect(chips.length).toBe(1);
  expect(chips[0]).toContain("rhester75@gmail.com");
});
