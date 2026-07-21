// QA harness · Onboarding → Calendar two-row header redesign (2026-07-21).
// Row 1 = #rr-ob-viewseg text-only tabs; Row 2 = #rr-cal-ribbon toolbar
// (side toggle · Today · ‹ › · bold range · Work Week ▾ | zoom −＋ · search ·
// settings gear · ⋮ create menu). Operator pass 2026-07-21: the Schedule
// interview primary is GONE, zoom/settings are back in view, and the ⋮ holds
// the create actions (New interview / event / task). Also asserts the header
// rhythm survives, nav/toggle work, and Overview keeps its header.
import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
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
  if(p==="/rest/v1/dsps"){
    const row={id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/Chicago",metadata:{}};
    return json(one?row:[row]);
  }
  if(p==="/rest/v1/rpc/rr_schema_version"||p==="/rest/v1/rpc/calendar_schema_version")return json(534);
  if(p.startsWith("/auth/v1/token"))return json(session);
  if(p.startsWith("/auth/v1/"))return json({});
  return json(one?{}:[]);
});
const page=await ctx.newPage();const errs=[];
page.on("pageerror",(e)=>errs.push(String(e)));
await page.goto("http://127.0.0.1:8123/dashboard/index.html",{waitUntil:"domcontentloaded",timeout:30000});
await page.waitForTimeout(4500);
await page.evaluate(()=>document.getElementById("rr-boot-overlay")?.remove());
await page.evaluate(()=>window.goto&&window.goto("onboarding-ops"));
await page.waitForTimeout(1500);
await page.evaluate(()=>window.obSub&&window.obSub("calendar"));
await page.waitForTimeout(3000);

const vis=`(el)=>!!(el&&el.offsetParent!==null&&el.getBoundingClientRect().width>0)`;
const snap=()=>page.evaluate(()=>{
  const $=(s)=>document.querySelector(s);
  const vis=(el)=>!!(el&&el.offsetParent!==null&&el.getBoundingClientRect().width>0);
  const cal=$("#rr-ivcal .oc");
  const seg=$("#rr-ob-viewseg");
  return {
    calTop:cal?Math.round(cal.getBoundingClientRect().top):null,
    // row 1 · text-only tabs
    tabs:[...document.querySelectorAll("#rr-ob-viewseg .rr-viewseg-btn")].map(b=>({t:b.textContent.trim(),active:b.classList.contains("active"),icons:b.querySelectorAll("svg").length})),
    segH:seg?Math.round(seg.getBoundingClientRect().height):null,
    // gone-for-good
    createPill:vis($(".rr-cal-create")),
    zoomSeg:vis($(".oc-zoom")),
    gearBtn:!!document.querySelector(".oc-bar-utils [data-ivcal-settings]"),
    launcherVisible:vis($("#rr-applauncher")),
    bellInHeader:!!document.querySelector("#rr-cal-ribbon #rr-hdr-notif"),
    // row 2 · toolbar
    sideToggle:vis($("#rr-cal-ribbon .oc-side-toggle")),
    today:vis($('#rr-cal-ribbon [data-ivcal-nav="0"]')),
    prev:vis($('#rr-cal-ribbon [data-ivcal-nav="-1"]')),
    next:vis($('#rr-cal-ribbon [data-ivcal-nav="1"]')),
    period:$("#rr-cal-ribbon .oc-period")?.textContent?.trim(),
    viewdd:vis($("#rr-cal-ribbon #rr-cal-viewdd")),
    viewLabel:$("#rr-cal-viewdd-current")?.textContent?.trim(),
    search:vis($("#rr-cal-ribbon [data-ivcal-search]")),
    zoomSegVisible:vis($("#rr-cal-ribbon .oc-zoom")),
    gearVisible:vis($("#rr-cal-ribbon .oc-settings-btn")),
    primaryGone:!$("#rr-cal-ribbon .rr-cal-newgroup .subnav-item"),
    more:vis($("#rr-ivcal-more-trigger")),
    // visual order of the right cluster (zoom → search → gear → ⋮)
    rightOrder:(()=>{const ids=[["zoom","#rr-cal-ribbon .oc-zoom"],["search","#rr-cal-ribbon [data-ivcal-search]"],["gear","#rr-cal-ribbon .oc-settings-btn"],["more","#rr-ivcal-more-trigger"]];
      return ids.map(([k,s])=>{const e=$(s);return e?[k,Math.round(e.getBoundingClientRect().left)]:[k,null];}).sort((a,b)=>(a[1]??1e9)-(b[1]??1e9)).map(x=>x[0]).join(",");})(),
  };
});
const R={};
R.cal=await snap();
await page.screenshot({path:"/tmp/claude-0/calhd-full.png"});

// ⋮ overflow: open → items → settings popover opens anchored
await page.click("#rr-ivcal-more-trigger");
await page.waitForTimeout(300);
R.moreMenu=await page.evaluate(()=>{
  const m=document.getElementById("rr-ivcal-more-menu");
  return {open:!!m&&!m.hidden,items:[...(m?.querySelectorAll(".rr-ivcal-more-item")||[])].map(b=>b.textContent.trim())};
});
await page.screenshot({path:"/tmp/claude-0/calhd-more.png"});
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
R.moreClosedOnEscape=await page.evaluate(()=>document.getElementById("rr-ivcal-more-menu")?.hidden===true);

// settings gear opens the two-column sheet BELOW the gear, fully on-screen
await page.click("#rr-cal-ribbon .oc-settings-btn");
await page.waitForTimeout(400);
R.settings=await page.evaluate(()=>{
  const m=document.getElementById("rr-ivcal-setmenu");
  if(!m)return null;const r=m.getBoundingClientRect();
  const gear=document.querySelector("#rr-cal-ribbon .oc-settings-btn").getBoundingClientRect();
  return {w:Math.round(r.width),top:Math.round(r.top),
    belowGear:r.top>=gear.bottom,
    inViewport:r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
    cols:m.querySelectorAll(".oc-set-col").length,
    title:m.querySelector(".oc-set-title")?.textContent.trim()};
});
// a control inside the sheet still works (time format seg)
await page.click('#rr-ivcal-setmenu [data-set-clock] [data-ck="24"]');
await page.waitForTimeout(500);
R.settingsClockWorks=await page.evaluate(()=>document.querySelector('#rr-ivcal-setmenu [data-set-clock] [data-ck="24"]')?.classList.contains("on"));
await page.click('#rr-ivcal-setmenu [data-set-clock] [data-ck="12"]');
await page.waitForTimeout(400);
await page.screenshot({path:"/tmp/claude-0/calhd-settings.png"});
R.settingsCloseBtn=await page.evaluate(()=>{document.querySelector("#rr-ivcal-setmenu [data-set-close]")?.click();return !document.getElementById("rr-ivcal-setmenu");});
await page.waitForTimeout(300);

// zoom via the visible ＋ still re-renders (row height changes)
const rhBefore=await page.evaluate(()=>getComputedStyle(document.querySelector("#rr-ivcal .oc-col")).height);
await page.click('#rr-cal-ribbon .oc-zoom [data-ivcal-zoom="8"]');
await page.waitForTimeout(600);
const rhAfter=await page.evaluate(()=>getComputedStyle(document.querySelector("#rr-ivcal .oc-col")).height);
R.zoomWorks=rhBefore!==rhAfter;

// nav: next week changes the period, Today returns
const p0=R.cal.period;
await page.click('#rr-cal-ribbon [data-ivcal-nav="1"]');
await page.waitForTimeout(700);
R.periodAfterNext=await page.evaluate(()=>document.querySelector("#rr-cal-ribbon .oc-period")?.textContent?.trim());
await page.click('#rr-cal-ribbon [data-ivcal-nav="0"]');
await page.waitForTimeout(700);
R.periodBackToToday=(await page.evaluate(()=>document.querySelector("#rr-cal-ribbon .oc-period")?.textContent?.trim()))===p0;

// side toggle collapses the booking sidebar
await page.click("#rr-cal-ribbon .oc-side-toggle");
await page.waitForTimeout(600);
R.sideClosed=await page.evaluate(()=>!document.querySelector("#rr-ivcal .oc-side"));
await page.click("#rr-cal-ribbon .oc-side-toggle");
await page.waitForTimeout(600);
R.sideReopened=await page.evaluate(()=>!!document.querySelector("#rr-ivcal .oc-side"));

// view dropdown still switches views
await page.click("#rr-cal-viewdd-trigger");
await page.waitForTimeout(250);
await page.click('#rr-cal-viewdd-menu [data-cal-view="day"]');
await page.waitForTimeout(700);
R.dayView=await page.evaluate(()=>document.getElementById("rr-cal-viewdd-current")?.textContent?.trim());
await page.evaluate(()=>window.rrIvcalSetView("workweek"));
await page.waitForTimeout(600);

// row-1 tabs: Overview keeps its legacy header; Calendar returns
await page.click('#rr-ob-viewseg [data-rr-viewseg="overview"]');
await page.waitForTimeout(1200);
R.overview=await page.evaluate(()=>{
  const vis=(el)=>!!(el&&el.offsetParent!==null&&el.getBoundingClientRect().width>0);
  return {
    obsub:document.getElementById("view-onboarding-ops")?.getAttribute("data-obsub"),
    tabActive:document.querySelector('#rr-ob-viewseg [data-rr-viewseg="overview"]')?.classList.contains("active"),
    ribbonTiles:vis(document.querySelector('.sched-ribbon-group[data-group="sourcing"]')),
    launcherDockUsable:!!document.querySelector('#view-onboarding-ops .rr-launcher-dock'),
  };
});
await page.screenshot({path:"/tmp/claude-0/calhd-overview.png"});
await page.click('#rr-ob-viewseg [data-rr-viewseg="calendar"]');
await page.waitForTimeout(1500);
R.backToCal=await page.evaluate(()=>({
  obsub:document.getElementById("view-onboarding-ops")?.getAttribute("data-obsub"),
  tabActive:document.querySelector('#rr-ob-viewseg [data-rr-viewseg="calendar"]')?.classList.contains("active"),
  today:!!document.querySelector('#rr-cal-ribbon [data-ivcal-nav="0"]'),
  more:!!document.getElementById("rr-ivcal-more-trigger"),
}));

console.log(JSON.stringify(R,null,1));
console.log("pageerrors:",errs);
await browser.close();
