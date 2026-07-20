import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};

// Current (Sunday-anchored) week dates, matching _schedStart = startOfWeek(today).
const now=new Date(); const sun=new Date(now); sun.setDate(now.getDate()-now.getDay());
const iso=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const DATES=[...Array(7)].map((_,i)=>{const d=new Date(sun);d.setDate(sun.getDate()+i);return iso(d);});

// Scenario state — mutated between runs.
//  A: one station, target 25 @10% → plan round(27.5)=28; 28 rows (25 + 3 cushion), all filled.
//  B: two stations 12+13 @10% → per-station plan 13+14=27; rows = 13+14=27 (1 cushion each), all filled.
//     (Pre-fix code planned round(27.5)=28/day here → phantom "7 cushion seats open".)
let SCENARIO="A";
const mkShift=(id,date,station,driver,cushion)=>({id,date,station_id:station,driver_id:driver,status:"scheduled",
  starts_at:`${date}T10:50:00-04:00`,ends_at:`${date}T21:20:00-04:00`,is_cushion:cushion,service_type_id:"svc-sp",
  service_type_code:"SP",shift_kind:"regular",wave_index:0,block_hours:10.5});
function gridFor(scn){
  const coverage=[],shifts=[];let n=0;
  for(const d of DATES){
    if(scn==="A"){
      coverage.push({date:d,station_id:"st-a",station_code:"DCA1",target_routes:25,needed:28});
      for(let i=0;i<28;i++)shifts.push(mkShift(`sh-${d}-${n++}`,d,"st-a",`drv-${i}`,i>=25));
    }else{
      coverage.push({date:d,station_id:"st-a",station_code:"DCA1",target_routes:12,needed:13});
      coverage.push({date:d,station_id:"st-b",station_code:"DBO5",target_routes:13,needed:14});
      for(let i=0;i<13;i++)shifts.push(mkShift(`sh-${d}-${n++}`,d,"st-a",`drv-${i}`,i>=12));
      for(let i=0;i<14;i++)shifts.push(mkShift(`sh-${d}-${n++}`,d,"st-b",`drv-${13+i}`,i>=13));
    }
  }
  return {coverage,shifts};
}
const DRIVERS=[...Array(30)].map((_,i)=>({id:`drv-${i}`,full_name:`Driver ${String(i).padStart(2,"0")}`,first_name:"D",last_name:String(i),preferred_name:null,status:"active",station_id:null,hire_date:"2025-01-01",birthday:null,tier:null,metadata:{},dl_expires_on:null,dot_certified:false,xl_certified:false,edv_certified:false,is_trainer:false,role:"driver",station:null}));

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
async function runScenario(scn){
  SCENARIO=scn;
  const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
  await ctx.addInitScript(([s])=>{
    localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token",JSON.stringify(s));
    window.__rrSchedOrientFlash=true;
    // keep the SW out of the harness — its controllerchange reload fights goto()
    if(navigator.serviceWorker)navigator.serviceWorker.register=()=>new Promise(()=>{});
  },[session]);
  await ctx.route("**/*",(r)=>r.request().url().startsWith("http://127.0.0.1:8123")?r.continue():r.abort());
  await ctx.route(`${HOST}/**`,(route)=>{
    const req=route.request();const p=new URL(req.url()).pathname;
    const one=(req.headers()["accept"]||"").includes("pgrst.object");
    const json=(b,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(b)});
    if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
    if(p==="/rest/v1/dsps")return json(one?{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}:[{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}]);
    if(p==="/rest/v1/rpc/schedule_grid")return json(gridFor(SCENARIO));
    if(p==="/rest/v1/rpc/scheduling_settings_for_week")return json({cushion_pct:10,max_days_per_week:5,allow_availability_override:false,preference_tiebreaker:"least_loaded"});
    if(p==="/rest/v1/rpc/get_woc_settings")return json(null);
    if(p==="/rest/v1/drivers")return json(DRIVERS);
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
  await page.waitForTimeout(3500);
  const out=await page.evaluate(()=>({
    dayCoverage:[...document.querySelectorAll(".day-coverage")].map(x=>x.textContent.trim()),
    covMain:document.getElementById("rr-ab-coverage-main")?.textContent.replace(/\s+/g," ").trim(),
    covSub:document.getElementById("rr-ab-coverage-sub")?.textContent.replace(/\s+/g," ").trim(),
    planByDate:{...(window._rrSchedPlanByDate||{})},
  }));
  out.errs=errs.slice(0,4);
  await ctx.close();
  return out;
}
const R={};
R.A=await runScenario("A");
R.B=await runScenario("B");
console.log(JSON.stringify(R,null,2));
await browser.close();
