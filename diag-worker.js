// Friendly's storage and watchdog thread (see app.js, "Device storage and the watchdog thread").
const U="https://us-central1-friendly-6992a.cloudfunctions.net/hang";let last=Date.now(),vis=true,steps=[],uid="",v="",route="",stalled=false,hungAt=0,strikes=0,dirty=false,lastFlush=0,db=null;
const open=()=>new Promise((res,rej)=>{const r=indexedDB.open("friendlyDiag",1);r.onupgradeneeded=()=>r.result.createObjectStore("kv");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
const tx=(mode,fn)=>new Promise((res,rej)=>{if(!db)return res();try{const t=db.transaction("kv",mode);fn(t.objectStore("kv"));t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error);}catch(e){rej(e);}});
function flush(){dirty=false;lastFlush=Date.now();tx("readwrite",s=>{s.put({hb:last,log:steps.slice(-50),route,v,stalled},"__trace");}).catch(()=>{});}
(async()=>{try{db=await open();}catch(e){}
  const kv={};let trace=null,ct=null;
  try{await tx("readonly",s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(c.key==="__trace")trace=c.value;else if(c.key==="__ct")ct=c.value;else kv[c.key]=c.value;c.continue();};});}catch(e){}
  postMessage({prev:{kv,trace,ct,ok:!!db}});
  try{await tx("readwrite",s=>{s.delete("__ct");});}catch(e){}
  flush();
  setInterval(()=>{if(dirty||Date.now()-lastFlush>5000)flush();},2000);
})();
onmessage=e=>{const d=e.data||{};last=Date.now();strikes=0;
  if(d.step){steps.push(d.step);if(steps.length>60)steps.shift();flush();}
  if(d.uid!==undefined)uid=d.uid;if(d.v)v=d.v;if(typeof d.vis==="boolean")vis=d.vis;if(d.route!==undefined&&d.route!==route){route=d.route;dirty=true;}if(d.stalled)stalled=true;
  if(d.kv){const k=d.kv[0],val=d.kv[1];tx("readwrite",s=>{val===null?s.delete(k):s.put(val,k);}).catch(()=>{});}
  if(d.ct!==undefined)tx("readwrite",s=>{d.ct===null?s.delete("__ct"):s.put(d.ct,"__ct");}).catch(()=>{});
  if(hungAt){fetch(U,{method:"POST",body:JSON.stringify({kind:"resumed",uid,v,vis,route,hungFor:Math.round((Date.now()-hungAt)/1000),steps:steps.slice(-10)})}).catch(()=>{});hungAt=0;}};
setInterval(()=>{if(hungAt||(!vis&&v.indexOf("native")<0))return;const gap=Date.now()-last;if(gap>6000){if(++strikes<2)return;hungAt=last;fetch(U,{method:"POST",body:JSON.stringify({kind:"hung",uid,v,vis,route,gapS:Math.round(gap/1000),steps:steps.slice(-10)})}).catch(()=>{});}else strikes=0;},1000);
