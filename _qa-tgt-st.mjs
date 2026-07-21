// QA harness · Schedule → Targets: Service types split OUT of the Settings
// popover into its own toolbar button + dropdown (operator 2026-07-21).
// Asserts: Settings menu = rules + waves (no service types); #rr-tgt-st-btn
// opens its own menu hosting the LIVE #rr-set-service-types editor; a toggle
// fires set_service_type; the two dropdowns are mutually exclusive; outside
// click + Escape close them.
import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};

const ST=[
  {id:"st-sp",code:"SP",label:"Standard Parcel",color:"#2563EB",active:true},
  {id:"st-xl",code:"XL",label:"Extra Large",color:"#D97706",active:true},
  {id:"st-hub",code:"HUB",label:"Hub",color:"#16A34A",active:false},
];
const SETCALLS=[];

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
  const json=(b)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(b)});
  if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
  if(p==="/rest/v1/dsps"){const row={id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/Chicago",metadata:{}};return json(one?row:[row]);}
  if(p==="/rest/v1/rpc/list_service_types")return json(ST);
  if(p==="/rest/v1/rpc/set_service_type"){try{SETCALLS.push(JSON.parse(req.postData()||"{}"));}catch{}return json([]);}
  if(p.startsWith("/auth/v1/token"))return json(session);
  if(p.startsWith("/auth/v1/"))return json({});
  return json(one?{}:[]);
});
const page=await ctx.newPage();const errs=[];
page.on("pageerror",(e)=>errs.push(String(e)));
await page.goto("http://127.0.0.1:8123/dashboard/index.html",{waitUntil:"domcontentloaded",timeout:30000});
await page.waitForTimeout(4500);
await page.evaluate(()=>document.getElementById("rr-boot-overlay")?.remove());
await page.evaluate(()=>window.goto&&window.goto("schedule"));
await page.waitForTimeout(2500);
await page.evaluate(()=>window.schedSub&&window.schedSub("targets"));
await page.waitForTimeout(3500);

const R={};
R.layout=await page.evaluate(()=>{
  const vis=(el)=>!!(el&&el.offsetParent!==null);
  const sm=document.getElementById("rr-tgt-settings-menu");
  const stm=document.getElementById("rr-tgt-st-menu");
  return {
    settingsBtn:vis(document.getElementById("rr-tgt-settings-btn")),
    stBtn:vis(document.getElementById("rr-tgt-st-btn")),
    stBtnLabel:document.querySelector("#rr-tgt-st-btn .rr-tgt-kpi-label")?.textContent.trim(),
    settingsHasWaves:!!sm?.querySelector("#rr-sched-targets-waves-host"),
    settingsHasSt:!!sm?.querySelector("#rr-set-service-types"),
    stMenuHostPresent:!!stm?.querySelector("#rr-sched-targets-st-host"),
  };
});
// open the Service types dropdown → live editor inside
await page.click("#rr-tgt-st-btn");
await page.waitForTimeout(500);
R.stOpen=await page.evaluate(()=>{
  const m=document.getElementById("rr-tgt-st-menu");
  return {open:!!m&&!m.hidden,
    editorInside:!!m?.querySelector("#rr-set-service-types"),
    rows:[...(m?.querySelectorAll("[data-rr-st] .rr-drawer-st-code")||[])].map(x=>x.textContent.trim())};
});
await page.screenshot({path:"/tmp/claude-0/tgt-st-open.png"});
// toggle HUB on → set_service_type fires
await page.click('#rr-tgt-st-menu [data-rr-st="st-hub"] .rr-toggle');
await page.waitForTimeout(800);
R.toggleSaved=SETCALLS.some(c=>c.p_id==="st-hub"&&c.p_active===true);
R.stStillOpenAfterToggle=await page.evaluate(()=>{const m=document.getElementById("rr-tgt-st-menu");return !!m&&!m.hidden;});
// opening Settings closes Service types (mutually exclusive)
await page.click("#rr-tgt-settings-btn");
await page.waitForTimeout(500);
R.exclusive=await page.evaluate(()=>{
  const sm=document.getElementById("rr-tgt-settings-menu");
  const stm=document.getElementById("rr-tgt-st-menu");
  return {settingsOpen:!!sm&&!sm.hidden,stClosed:!!stm&&stm.hidden,
    settingsHasNoSt:!sm?.querySelector("#rr-set-service-types")};
});
await page.screenshot({path:"/tmp/claude-0/tgt-settings-open.png"});
// Escape closes and refocuses the trigger
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
R.escClosed=await page.evaluate(()=>{
  const sm=document.getElementById("rr-tgt-settings-menu");
  return !!sm&&sm.hidden;
});
// outside click closes the reopened ST menu
await page.click("#rr-tgt-st-btn");
await page.waitForTimeout(300);
await page.click("body",{position:{x:600,y:700}});
await page.waitForTimeout(400);
R.outsideCloses=await page.evaluate(()=>{const m=document.getElementById("rr-tgt-st-menu");return !!m&&m.hidden;});

console.log(JSON.stringify(R,null,1));
console.log("set_service_type calls:",JSON.stringify(SETCALLS));
console.log("pageerrors:",errs);
await browser.close();
