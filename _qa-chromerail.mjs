// QA harness · top-right chrome vs the fixed right utility rail (2026-07-21).
// Operator report: on Schedule→week the launcher+bell end flush with the main
// card, clear of the 52px utility rail — but Roster / Targets (KPI-strip
// hosts outside .tcp-body) and the Onboarding Calendar header ran their
// right-aligned icons under/past the rail. Asserts every surface now ends at
// its card edge, left of the rail, and that the strips slide with an open
// rail panel like .tcp-body does.
import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
const ctx=await browser.newContext({viewport:{width:1920,height:1080}});
await ctx.addInitScript(([s])=>{
  localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token",JSON.stringify(s));
  window.__rrSchedOrientFlash=true;
  if(navigator.serviceWorker)navigator.serviceWorker.register=()=>new Promise(()=>{});
},[session]);
await ctx.route("**/*",(r)=>r.request().url().startsWith("http://127.0.0.1:8123")?r.continue():r.abort());
await ctx.route(`${HOST}/**`,(route)=>{
  const req=route.request();const p=new URL(req.url()).pathname;
  const one=(req.headers()["accept"]||"").includes("pgrst.object");
  const json=(b,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(b)});
  if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
  if(p==="/rest/v1/dsps"){const row={id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/Chicago",metadata:{}};return json(one?row:[row]);}
  if(p==="/rest/v1/rpc/rr_schema_version"||p==="/rest/v1/rpc/calendar_schema_version")return json(534);
  if(p.startsWith("/auth/v1/token"))return json(session);
  if(p.startsWith("/auth/v1/"))return json({});
  return json(one?{}:[]);
});
const page=await ctx.newPage();const errs=[];
page.on("pageerror",(e)=>errs.push(String(e)));
await page.goto("http://127.0.0.1:8123/dashboard/index.html",{waitUntil:"domcontentloaded",timeout:30000});
await page.waitForTimeout(5000);
await page.evaluate(()=>document.getElementById("rr-boot-overlay")?.remove());

const geo=(sels)=>page.evaluate((sels)=>{
  const out={};
  out.rail=(()=>{const e=document.querySelector("#rr-util-rail-mount .sched-util-rail");if(!e)return null;const r=e.getBoundingClientRect();return {l:Math.round(r.left),w:Math.round(r.width)};})();
  for(const [k,sel] of Object.entries(sels)){
    const e=document.querySelector(sel);
    if(!e||(!e.getBoundingClientRect().width)){out[k]=null;continue;}
    const r=e.getBoundingClientRect();
    out[k]={l:Math.round(r.left),r:Math.round(r.right)};
  }
  return out;
},sels);

const R={};const fails=[];
const ok=(name,cond,detail)=>{ if(!cond) fails.push(`${name}: ${detail}`); R[name]=(cond?"PASS":"FAIL")+" — "+detail; };

// ── 1 · Schedule → week (the reference — must be unchanged) ──
await page.evaluate(()=>window.goto&&window.goto("schedule"));
await page.waitForTimeout(2500);
let g=await geo({bell:"#rr-hdr-notif",launcher:"#rr-applauncher",card:"#sched-sub-week .builder-shell"});
ok("week.flush", !!g.bell&&!!g.card&&Math.abs(g.bell.r-g.card.r)<=2, `bell.r=${g.bell?.r} card.r=${g.card?.r}`);
ok("week.clearsRail", !!g.bell&&!!g.rail&&g.bell.r<=g.rail.l, `bell.r=${g.bell?.r} rail.l=${g.rail?.l}`);
await page.screenshot({path:"/tmp/claude-0/cr-week.png"});

// ── 2 · Schedule → roster ──
await page.evaluate(()=>window.schedSub&&window.schedSub("roster"));
await page.waitForTimeout(2500);
g=await geo({bell:"#rr-hdr-notif",launcher:"#rr-applauncher",host:"#rr-roster-chrome-host",card:"#ob-roster-mount"});
ok("roster.flush", !!g.bell&&!!g.card&&Math.abs(g.bell.r-g.card.r)<=2, `bell.r=${g.bell?.r} card.r=${g.card?.r}`);
ok("roster.clearsRail", !!g.bell&&!!g.rail&&g.bell.r<=g.rail.l, `bell.r=${g.bell?.r} rail.l=${g.rail?.l}`);
ok("roster.launcherLeftOfBell", !!g.launcher&&!!g.bell&&g.launcher.r<=g.bell.l, `launcher.r=${g.launcher?.r} bell.l=${g.bell?.l}`);
await page.screenshot({path:"/tmp/claude-0/cr-roster.png"});

// ── 3 · Schedule → targets ──
await page.evaluate(()=>window.schedSub&&window.schedSub("targets"));
await page.waitForTimeout(2500);
g=await geo({bell:"#rr-hdr-notif",host:"#rr-tgt-chrome-host",card:".plan-table-wrap"});
ok("targets.flush", !!g.bell&&!!g.card&&Math.abs(g.bell.r-g.card.r)<=2, `bell.r=${g.bell?.r} card.r=${g.card?.r}`);
ok("targets.clearsRail", !!g.bell&&!!g.rail&&g.bell.r<=g.rail.l, `bell.r=${g.bell?.r} rail.l=${g.rail?.l}`);
await page.screenshot({path:"/tmp/claude-0/cr-targets.png"});

// ── 4 · Targets + open Notes panel: strip chrome slides clear of the panel ──
await page.evaluate(()=>document.querySelector("[data-rr-notes-toggle]")?.click());
await page.waitForTimeout(900);
g=await geo({bell:"#rr-hdr-notif",panel:".sched-notes-panel.is-open"});
ok("targets.notesOpen.slides", !!g.bell&&!!g.panel&&g.bell.r<=g.panel.l, `bell.r=${g.bell?.r} panel.l=${g.panel?.l}`);
await page.screenshot({path:"/tmp/claude-0/cr-targets-notes.png"});
await page.evaluate(()=>document.querySelector("[data-rr-notes-toggle]")?.click());
await page.waitForTimeout(600);

// ── 5 · Onboarding → calendar: ⋯ cluster ends at the calendar card edge ──
await page.evaluate(()=>window.goto&&window.goto("onboarding-ops"));
await page.waitForTimeout(1500);
await page.evaluate(()=>window.obSub&&window.obSub("calendar"));
await page.waitForTimeout(3000);
g=await geo({more:"#rr-ivcal-more-trigger",gear:"#rr-cal-ribbon .oc-settings-btn",card:"#rr-ivcal"});
ok("calendar.flush", !!g.more&&!!g.card&&Math.abs(g.more.r-g.card.r)<=3, `more.r=${g.more?.r} card.r=${g.card?.r}`);
ok("calendar.clearsRail", !!g.more&&!!g.rail&&g.more.r<=g.rail.l, `more.r=${g.more?.r} rail.l=${g.rail?.l}`);
await page.screenshot({path:"/tmp/claude-0/cr-cal.png"});

// ── 6 · Onboarding → funnel: borrowed bell/avatar clear the rail too ──
await page.evaluate(()=>window.obSub&&window.obSub("funnel"));
await page.waitForTimeout(2500);
g=await geo({bell:"#rr-hdr-notif"});
ok("funnel.clearsRail", !!g.bell&&!!g.rail&&g.bell.r<=g.rail.l, `bell.r=${g.bell?.r} rail.l=${g.rail?.l}`);
await page.screenshot({path:"/tmp/claude-0/cr-funnel.png"});

console.log(JSON.stringify(R,null,1));
console.log("pageerrors:",errs.slice(0,5));
if(fails.length||errs.length){console.log("FAILURES:",fails);process.exit(1);}
console.log("ALL PASS");
await browser.close();
