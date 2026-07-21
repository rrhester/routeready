// QA: Fleet station lens — van editor Station select + scoped empty state.
// Reproduces the operator's report (vans only visible under "All stations"),
// then assigns a station through the new drawer field and verifies the van
// follows the lens. Run: node _qa-vanstation.mjs (http.server on :8123 first).
import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};
const STATIONS=[
  {id:"s-1",code:"DCA1",name:"Chantilly",active:true},
  {id:"s-2",code:"DBO5",name:"Boston",active:true},
];
// Operator's live state: vans exist but none has a station assigned.
const VANS=[
  {id:"v-1",name:"4271",kind:"van",status:"active",ownership:"dsp_owned",operational_status:"operational",station_id:null,station_code:null,photo_path:null},
  {id:"v-2",name:"4272",kind:"van",status:"active",ownership:"dsp_owned",operational_status:"operational",station_id:null,station_code:null,photo_path:null},
  {id:"v-3",name:"4273",kind:"van",status:"active",ownership:"dsp_owned",operational_status:"operational",station_id:null,station_code:null,photo_path:null},
];
const SAVES=[];
const stCode=(id)=>((STATIONS.find((s)=>s.id===id)||{}).code||null);

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
const ctx=await browser.newContext({viewport:{width:1500,height:950}});
await ctx.addInitScript(([s])=>{localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token",JSON.stringify(s));window.__rrSchedOrientFlash=true;},[session]);
await ctx.route("**/*",(r)=>r.request().url().startsWith("http://127.0.0.1:8123")?r.continue():r.abort());
await ctx.route(`${HOST}/**`,(route)=>{
  const req=route.request();const p=new URL(req.url()).pathname;const m=req.method();
  const one=(req.headers()["accept"]||"").includes("pgrst.object");
  const json=(b,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(b)});
  const body=()=>{try{return JSON.parse(req.postData()||"{}");}catch{return {};}};
  if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
  if(p==="/rest/v1/dsps")return json(one?{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}:[{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}]);
  if(p==="/rest/v1/stations")return json(STATIONS);
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
const emptyHead=()=>page.evaluate(()=>document.querySelector("#fleet-tbody .fl-empty h3")?.textContent.trim()||null);
const setScope=async(id)=>{
  await page.evaluate(()=>document.getElementById("rr-station-btn")?.click());
  await page.waitForTimeout(300);
  await page.evaluate((sid)=>document.querySelector(`[data-rr-station-opt="${sid}"]`)?.click(),id);
  await page.waitForTimeout(1800);
};

// 1 · All mode — the three unassigned vans are visible.
await page.evaluate(()=>window.goto("fleet"));
await page.waitForTimeout(2500);
R.allModeVans=await rosterNames();

// 2 · Scope Boston — pre-assignment this is the operator's bug state; now it
// should show the explanatory scoped empty state, not "No vans yet".
await setScope("s-2");
R.scopedEmptyHead=await emptyHead();
R.scopedEmptyRows=(await rosterNames()).length;

// 3 · Back to All, open van 4271 — the Profile tab has the new Station select.
await setScope("all");
await page.evaluate(()=>window.openFleetDrawer("v-1"));
await page.waitForTimeout(1500);
R.stationSelectOptions=await page.evaluate(()=>{
  const sel=document.querySelector('#rr-fd-drawer [data-rr-fd-field="station_id"]');
  return sel?[...sel.options].map(o=>`${o.value||"∅"}:${o.textContent.trim()}`):null;
});

// 4 · Assign DBO5 and save — vehicle_record_save must receive p_station_id.
await page.selectOption('#rr-fd-drawer [data-rr-fd-field="station_id"]',"s-2");
await page.click('[data-rr-fd-save="profile"]');
await page.waitForTimeout(1800);
R.savedStationArg=SAVES.length?SAVES[SAVES.length-1].p_station_id:"(no save call)";
R.drawerSubAfterSave=await page.evaluate(()=>document.getElementById("rr-fd-sub")?.textContent.trim());
await page.evaluate(()=>document.getElementById("rr-fd-drawer")?.remove());

// 5 · The van now follows the lens: Boston shows it, Chantilly doesn't, All shows all.
await setScope("s-2");
R.bostonVans=await rosterNames();
await setScope("s-1");
R.chantillyEmptyHead=await emptyHead();
await setScope("all");
R.allAfterAssign=await rosterNames();

// 6 · Add-van under a scope defaults the Station select to that station.
await setScope("s-2");
await page.evaluate(()=>window.openFleetDrawer(null));
await page.waitForTimeout(900);
R.newVanDefaultStation=await page.evaluate(()=>document.querySelector('#rr-fd-drawer [data-rr-fd-field="station_id"]')?.value);
await setScope("all");

R.pageErrors=errs.slice(0,4);
console.log(JSON.stringify(R,null,2));
await browser.close();
