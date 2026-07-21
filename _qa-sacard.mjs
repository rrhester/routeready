import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};

const now=new Date(); const sun=new Date(now); sun.setDate(now.getDate()-now.getDay());
const iso=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const cellsFor=(sp)=>{const out=[];for(let w=0;w<13;w++)for(let i=0;i<7;i++){
  const d=new Date(sun);d.setDate(sun.getDate()+w*7+i);
  out.push({date:iso(d),station_id:"st-a",station_code:"DCA1",target_routes:sp+1,filled:0,
    targets_by_wave:[{service_type_code:"SP",target_routes:sp},{service_type_code:"XL",target_routes:1}]});}
  return out;};

// A: 24 SP + 1 XL (26 seats/day, 182/wk), workdays default 5, pad 20, 50 drivers
//    -> need 44, have 50 -> COVERED (6 spare).
// B: 34 SP + 1 XL (36 seats/day, 252/wk), workdays 3.5, pad 20, 65 drivers
//    -> need 87, have 65 -> SHORT 22; free fix 4.7 days; hire 22 = 88 applicants @25%.
//    Then pad -> 10 in the popover: need 80 -> SHORT 15 (live update).
const SCN={
  A:{cells:cellsFor(24),count:50,staffing:{plan_pad_pct:20}},
  B:{cells:cellsFor(34),count:65,staffing:{plan_pad_pct:20,workdays_per_week:3.5}},
};

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
async function run(key){
  const S=SCN[key];
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
    const json=(b,code=200,hdr={})=>route.fulfill({status:code,contentType:"application/json",headers:hdr,body:JSON.stringify(b)});
    if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
    if(p==="/rest/v1/dsps"){
      if(m==="PATCH")return json([]);
      const row={id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{staffing:S.staffing}};
      return json(one?row:[row]);
    }
    if(p==="/rest/v1/rpc/okami_grid")return json(S.cells);
    if(p==="/rest/v1/rpc/active_drivers_for_horizon"){
      const rows=[...Array(13)].map((_,w)=>{const d=new Date(sun);d.setDate(sun.getDate()+w*7);
        return {week_start:iso(d),total_active:S.count,on_time_off:0,on_pto:0,available:S.count};});
      return json(rows);
    }
    if(p==="/rest/v1/drivers")return json([],200,{"content-range":`0-${S.count-1}/${S.count}`});
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
  const read=()=>page.evaluate(()=>{
    const c=document.getElementById("rr-sa-card");
    if(!c)return null;
    return {
      cls:c.className,
      title:c.querySelector(".rr-sa-title")?.textContent.trim(),
      sub:c.querySelector(".rr-sa-sub")?.textContent.replace(/\s+/g," ").trim(),
      bars:[...c.querySelectorAll(".rr-sa-val")].map(x=>x.textContent.trim()),
      fixes:[...c.querySelectorAll(".rr-sa-fix")].map(x=>x.textContent.replace(/\s+/g," ").trim()),
      insideWrap:!!c.closest(".plan-table-wrap"),
      onTargets:!!c.closest("#sched-sub-targets"),
    };
  });
  const out={first:await read()};
  if(key==="B"){
    await page.click(".rr-tgt-th-info");
    await page.waitForTimeout(500);
    await page.fill("#rr-okami-pad-inp","10");
    await page.waitForTimeout(900);
    out.afterPad10=await read();
  }
  out.errs=errs.slice(0,4);
  try{await page.locator("#rr-sa-card").screenshot({path:`/tmp/claude-0/sa-card-${key}.png`});}catch(_){}
  await ctx.close();
  return out;
}
const R={};
R.A=await run("A");
R.B=await run("B");
console.log(JSON.stringify(R,null,2));
await browser.close();
