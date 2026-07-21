import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};

const now=new Date(); const sun=new Date(now); sun.setDate(now.getDate()-now.getDay());
const iso=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// 13 weeks of okami cells: 24 SP + 1 XL per day, one station.
const CELLS=[];
for(let w=0;w<13;w++)for(let i=0;i<7;i++){
  const d=new Date(sun);d.setDate(sun.getDate()+w*7+i);
  CELLS.push({date:iso(d),station_id:"st-a",station_code:"DCA1",target_routes:25,filled:0,
    targets_by_wave:[{service_type_code:"SP",target_routes:24},{service_type_code:"XL",target_routes:1}]});
}
const PATCHES=[];

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
await ctx.addInitScript(([s])=>{
  localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token",JSON.stringify(s));
  window.__rrSchedOrientFlash=true;
  if(navigator.serviceWorker)navigator.serviceWorker.register=()=>new Promise(()=>{});
},[session]);
await ctx.route("**/*",(r)=>r.request().url().startsWith("http://127.0.0.1:8123")?r.continue():r.abort());
await ctx.route(`${HOST}/**`,(route)=>{
  const req=route.request();const p=new URL(req.url()).pathname;const m=req.method();
  const one=(req.headers()["accept"]||"").includes("pgrst.object");
  const json=(b,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(b)});
  if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
  if(p==="/rest/v1/dsps"){
    if(m==="PATCH"){try{PATCHES.push(JSON.parse(req.postData()||"{}"));}catch{}return json([]);}
    const row={id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{staffing:{plan_pad_pct:20}}};
    return json(one?row:[row]);
  }
  if(p==="/rest/v1/rpc/okami_grid")return json(CELLS);
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
await page.waitForTimeout(3000);

const R={};
const readNeeded=()=>page.evaluate(()=>{
  const row=document.getElementById("okami-row-0");
  return row?row.querySelectorAll("td")[2]?.textContent.trim():null;
});
R.neededAt20=await readNeeded();
await page.click(".rr-tgt-th-info");
await page.waitForTimeout(600);
R.padInputInitial=await page.evaluate(()=>document.getElementById("rr-okami-pad-inp")?.value);
R.staleSliderTextGone=await page.evaluate(()=>!document.querySelector(".pa-pop")?.textContent.includes("slider on the OKAMI page"));
R.simple=await page.evaluate(()=>{
  const t=document.querySelector(".pa-pop")?.textContent||"";
  return {
    formulaNotationGone:!t.includes("ceil( max("),
    peakFloorProseGone:!t.includes("Peak-day floor"),
    cushionProseGone:!t.includes("different thing"),
    exampleLine:(t.match(/W\d+: .*drivers/)||[null])[0],
    inputs:["rr-okami-wdw","rr-okami-pad-inp","rr-tgt-hire-lead"].map(id=>!!document.getElementById(id)),
    chars:t.length,
  };
});
try{await page.locator(".pa-pop").screenshot({path:"/tmp/claude-0/fs-popover.png"});}catch(_){}
await page.fill("#rr-okami-pad-inp","10");
await page.waitForTimeout(1400);
R.neededAt10=await readNeeded();
R.metadataSaved=PATCHES.some(b=>b?.metadata?.staffing?.plan_pad_pct===10);
// close + reopen the popover — the new value must round-trip
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.click(".rr-tgt-th-info");
await page.waitForTimeout(600);
R.padInputReopened=await page.evaluate(()=>document.getElementById("rr-okami-pad-inp")?.value);
R.errs=errs.slice(0,4);
console.log(JSON.stringify(R,null,2));
await browser.close();
