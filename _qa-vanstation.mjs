// QA: Fleet station lens — vans follow their DRIVERS (chain + day
// assignments through _rrVanIdsAtStation), explicit Station select still
// pins, scoped empty state explains itself. Reproduces the operator's
// report (vans only visible under "All stations") and verifies zero-config
// scoping. Run: node _qa-vanstation.mjs (http.server on :8123 first).
import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};
const STATIONS=[
  {id:"s-1",code:"DCA1",name:"Chantilly",active:true},
  {id:"s-2",code:"DBO5",name:"Boston",active:true},
];
// Operator's live state: vans exist but none has an explicit station.
const VANS=[
  {id:"v-1",name:"4271",kind:"van",status:"active",ownership:"dsp_owned",operational_status:"operational",station_id:null,station_code:null,photo_path:null},
  {id:"v-2",name:"4272",kind:"van",status:"active",ownership:"dsp_owned",operational_status:"operational",station_id:null,station_code:null,photo_path:null},
  {id:"v-3",name:"4273",kind:"van",status:"active",ownership:"dsp_owned",operational_status:"operational",station_id:null,station_code:null,photo_path:null},
];
// Drivers: Alice homed DCA1, Bob homed DBO5 (driver_stations 404s = pre-0525).
const DRIVERS=[{id:"d-alice",station_id:"s-1"},{id:"d-bob",station_id:"s-2"}];
// Van 4271 is chained to Bob (primary); 4272 had a day loan to Alice; 4273 orphan.
const CHAINS=[{vehicle_id:"v-1",driver_id:"d-bob",rank:0}];
const DAYROWS=[{vehicle_id:"v-2",driver_id:"d-alice"}];
const SAVES=[];
const stCode=(id)=>((STATIONS.find((s)=>s.id===id)||{}).code||null);

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
const ctx=await browser.newContext({viewport:{width:1500,height:950}});
await ctx.addInitScript(([s])=>{localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token",JSON.stringify(s));window.__rrSchedOrientFlash=true;},[session]);
await ctx.route("**/*",(r)=>r.request().url().startsWith("http://127.0.0.1:8123")?r.continue():r.abort());
await ctx.route(`${HOST}/**`,(route)=>{
  const req=route.request();const u=new URL(req.url());const p=u.pathname;const m=req.method();
  const one=(req.headers()["accept"]||"").includes("pgrst.object");
  const json=(b,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(b)});
  const body=()=>{try{return JSON.parse(req.postData()||"{}");}catch{return {};}};
  if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
  if(p==="/rest/v1/dsps")return json(one?{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}:[{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}]);
  if(p==="/rest/v1/stations")return json(STATIONS);
  if(p==="/rest/v1/driver_stations")return json({code:"42P01",message:"relation does not exist"},404);
  if(p==="/rest/v1/drivers"){
    const st=(u.searchParams.get("station_id")||"").replace("eq.","");
    return json(st?DRIVERS.filter((d)=>d.station_id===st).map((d)=>({id:d.id})):[]);
  }
  if(p==="/rest/v1/vehicle_driver_assignments")return json(CHAINS);
  if(p==="/rest/v1/vehicle_day_assignments")return json(DAYROWS);
  if(p==="/rest/v1/rpc/vehicles_roster")return json(VANS.map((v)=>({...v})));
  if(p==="/rest/v1/rpc/vehicle_record"){
    const v=VANS.find((x)=>x.id===body().p_id);
    return v?json({vehicle:{...v},drivers:[],logs:[]}):json({},404);
  }
  if(p==="/rest/v1/rpc/vehicle_record_save"){
    const a=body();SAVES.push(a);
    let v=VANS.find((x)=>x.id===a.p_id);
    if(!v){v={id:"v-new",photo_path:null};VANS.push(v);}
    Object.assign(v,{name:a.p_name,station_id:a.p_station_id||null,station_code:stCode(a.p_station_id)});
    return json({...v});
  }
  if(p==="/rest/v1/vehicles"&&m==="PATCH")return json([]);
  if(p.startsWith("/auth/v1/token"))return json(session);
  if(p.startsWith("/auth/v1/"))return json({});
  return json(one?{}:[]);
});

const page=await ctx.newPage();const errs=[];
page.on("pageerror",(e)=>errs.push(String(e)));
await page.goto("http://127.0.0.1:8123/dashboard/index.html",{waitUntil:"domcontentloaded"});
await page.waitForTimeout(4500);
await page.evaluate(()=>document.getElementById("rr-boot-overlay")?.remove());

const R={};
const rosterNames=()=>page.evaluate(()=>[...document.querySelectorAll("#fleet-tbody tr[data-rr-vehicle-id] .cell-name-text")].map(x=>x.textContent.trim()));
const emptyText=()=>page.evaluate(()=>{const e=document.querySelector("#fleet-tbody .fl-empty");return e?e.querySelector("h3")?.textContent.trim():null;});
const setScope=async(id)=>{
  await page.evaluate(()=>document.getElementById("rr-station-btn")?.click());
  await page.waitForTimeout(300);
  await page.evaluate((sid)=>document.querySelector(`[data-rr-station-opt="${sid}"]`)?.click(),id);
  await page.waitForTimeout(1800);
};

// 1 · All mode — all three station-less vans visible.
await page.evaluate(()=>window.goto("fleet"));
await page.waitForTimeout(2500);
R.allModeVans=await rosterNames();

// 2 · ZERO-CONFIG scoping: DBO5 shows the van chained to Bob; DCA1 shows the
// van day-loaned to Alice; the orphan van (4273) shows in neither.
await setScope("s-2");
R.bostonAuto=await rosterNames();
await setScope("s-1");
R.chantillyAuto=await rosterNames();

// 3 · Explicit pin still works: assign orphan 4273 → DBO5 via the drawer.
await setScope("all");
await page.evaluate(()=>window.openFleetDrawer("v-3"));
await page.waitForTimeout(1500);
R.stationSelectOptions=await page.evaluate(()=>{
  const sel=document.querySelector('#rr-fd-drawer [data-rr-fd-field="station_id"]');
  return sel?[...sel.options].map(o=>`${o.value||"∅"}:${o.textContent.trim()}`):null;
});
await page.selectOption('#rr-fd-drawer [data-rr-fd-field="station_id"]',"s-2");
await page.click('[data-rr-fd-save="profile"]');
await page.waitForTimeout(1800);
R.savedStationArg=SAVES.length?SAVES[SAVES.length-1].p_station_id:"(no save call)";
await page.evaluate(()=>document.getElementById("rr-fd-drawer")?.remove());

// 4 · DBO5 = chained + pinned; DCA1 unchanged; All = 3.
await setScope("s-2");
R.bostonAfterPin=await rosterNames();
await setScope("s-1");
R.chantillyAfterPin=await rosterNames();
await setScope("all");
R.allAfterPin=await rosterNames();

// 5 · Empty state: drop the day rows so DCA1 goes empty, check the copy.
DAYROWS.length=0;
await setScope("s-1");
R.emptyHead=await emptyText();
R.emptyRows=(await rosterNames()).length;
await setScope("all");

R.pageErrors=errs.slice(0,4);
console.log(JSON.stringify(R,null,2));
await browser.close();
