import { chromium } from "playwright";
const DSP="11111111-1111-1111-1111-111111111111", UID="22222222-2222-2222-2222-222222222222", HOST="https://doiwrhkirgblcvuskhno.supabase.co";
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:UID,role:"authenticated",exp:Math.floor(Date.now()/1000)+31536000})}.x`;
const session={access_token:JWT,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+31536000,refresh_token:"x",user:{id:UID,aud:"authenticated",role:"authenticated",email:"qa@rr.dev"}};
let STATIONS=[{id:"s-1",code:"DCA1",name:"Chantilly",active:true}]; // start single-station
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox","--headless=new"]});
const ctx=await browser.newContext({viewport:{width:1500,height:950}});
await ctx.addInitScript(([s])=>{localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token",JSON.stringify(s));window.__rrSchedOrientFlash=true;},[session]);
await ctx.route("**/*",(r)=>r.request().url().startsWith("http://127.0.0.1:8123")?r.continue():r.abort());
await ctx.route(`${HOST}/**`,(route)=>{
  const req=route.request();const p=new URL(req.url()).pathname;const m=req.method();
  const one=(req.headers()["accept"]||"").includes("pgrst.object");
  const json=(b,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(b)});
  if(p==="/rest/v1/app_users")return json(one?{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}:[{id:UID,dsp_id:DSP,email:"qa@rr.dev",full_name:"QA",role:"owner",allowed_pages:null}]);
  if(p==="/rest/v1/dsps")return json(one?{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}:[{id:DSP,name:"QA DSP",short_code:"DCA1",timezone:"America/New_York",metadata:{}}]);
  if(p==="/rest/v1/stations"){
    if(m==="POST"){let body={};try{body=JSON.parse(req.postData()||"{}");}catch{}const rows=Array.isArray(body)?body:[body];rows.forEach((r,i)=>STATIONS.push({id:"s-"+(STATIONS.length+1+i),code:r.code,name:r.name,active:r.active!==false}));return json(rows,201);}
    if(m==="PATCH"){const u=new URL(req.url());return json([]);}
    return json(STATIONS);
  }
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
R.switchHiddenAtBoot=await page.evaluate(()=>document.getElementById("rr-station-switch")?.hidden);
await page.evaluate(()=>window.goto&&window.goto("settings"));
await page.waitForTimeout(2500);
R.ownerSectionVisible=await page.evaluate(()=>{const el=document.querySelector("#rr-stations-list");return !!el && el.offsetParent!==null;});
R.listBefore=await page.evaluate(()=>[...document.querySelectorAll("#rr-stations-list .rr-stn-code")].map(x=>x.textContent));
// add a station
await page.fill("#rr-station-new-code","dbo5");
await page.fill("#rr-station-new-name","Boston");
await page.click("#rr-station-add-btn");
await page.waitForTimeout(1500);
R.listAfter=await page.evaluate(()=>[...document.querySelectorAll("#rr-stations-list .rr-stn-code")].map(x=>x.textContent));
R.statusMsg=await page.evaluate(()=>document.getElementById("rr-stations-status")?.textContent);
R.switchRevealedAfterAdd=await page.evaluate(()=>{const el=document.getElementById("rr-station-switch");return el?!el.hidden:"missing";});
R.switchMenuOptions=await page.evaluate(()=>{document.getElementById("rr-station-btn")?.click();return [...document.querySelectorAll("#rr-station-menu .rr-qat-opt-lbl")].map(x=>x.textContent.trim());});
// invalid code
await page.fill("#rr-station-new-code","x");
await page.click("#rr-station-add-btn");
await page.waitForTimeout(400);
R.invalidMsg=await page.evaluate(()=>document.getElementById("rr-stations-status")?.textContent);
R.errs=errs.slice(0,4);
console.log(JSON.stringify(R,null,2));
await browser.close();
