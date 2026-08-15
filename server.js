/**
 * Proxy Monitor v18 (屏蔽逻辑统一)
 * 统一：自动清理与手动清理都写入屏蔽名单；屏蔽IP不被域名二次解析、也不因ip.txt重写而显示
 * 释放：清空清除记录 = 解除全部屏蔽（唯一释放口）
 * 继承：v17 IP主键模型 / 三重验证 / 日志闭环 / 每文件计数 / 手册
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');
const VERSION = 'v18';

const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || '/app/config/ip.txt',
  dataDir: process.env.DATA_DIR || '/app/data',
  intervalSec: parseInt(process.env.INTERVAL_SEC || '60', 10),
  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  customProbeUrl: process.env.CUSTOM_PROBE_URL || 'https://proxyip-check.coldicy.cc.cd/generate_204',
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
  dnsTtlSec: parseInt(process.env.DNS_TTL_SEC || '300', 10),
  autoCleanDays: parseFloat(process.env.AUTO_CLEAN_DAYS || '7'),
  maxTlsMs: parseFloat(process.env.MAX_TLS_MS || '0'),
  minSpeedKBps: parseFloat(process.env.MIN_SPEED_KBPS || '0'),
  qualityWindow: parseInt(process.env.QUALITY_WINDOW || '10', 10),
  qualityRate: parseFloat(process.env.QUALITY_RATE || '1'),
  github: { token: process.env.GITHUB_TOKEN || '', repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip', branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true',
    uploadIntervalMin: parseInt(process.env.GITHUB_UPLOAD_INTERVAL_MIN || '0', 10) },
};
CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
CONFIG.graveyardFile = path.join(CONFIG.dataDir, 'graveyard.json');

const state = { units: [], history: {}, disc: {}, blocked: {}, graveyard: { list: [] },
  lastCycle: null, checking: false, progress: { tested: 0, total: 0 }, logs: [],
  github: { lastUpload: null, lastError: null }, lastUploadedContent: '' };
let cycleTimer = null, githubTimer = null;

function log(m){ state.logs.push({ t: Date.now(), m: String(m) }); if (state.logs.length > 400) state.logs = state.logs.slice(-400); }

// ==================== 配置 ====================
function setConfig(o){ if(!o)return; const num=(v,d)=>{const n=parseFloat(v);return isFinite(n)?n:d;};
  if(o.intervalSec!=null)CONFIG.intervalSec=Math.max(5,Math.round(num(o.intervalSec,CONFIG.intervalSec)));
  if(o.timeoutSec!=null)CONFIG.timeoutSec=Math.max(1,Math.round(num(o.timeoutSec,CONFIG.timeoutSec)));
  if(o.concurrency!=null)CONFIG.concurrency=Math.max(1,Math.round(num(o.concurrency,CONFIG.concurrency)));
  if(o.dnsTtlSec!=null)CONFIG.dnsTtlSec=Math.max(30,Math.round(num(o.dnsTtlSec,CONFIG.dnsTtlSec)));
  if(o.autoCleanDays!=null)CONFIG.autoCleanDays=Math.max(0,num(o.autoCleanDays,0));
  if(o.probeUrl)CONFIG.probeUrl=String(o.probeUrl);
  if(o.customProbeUrl!=null)CONFIG.customProbeUrl=String(o.customProbeUrl);
  if(o.maxTlsMs!=null)CONFIG.maxTlsMs=num(o.maxTlsMs,0);
  if(o.minSpeedKBps!=null)CONFIG.minSpeedKBps=num(o.minSpeedKBps,0);
  if(o.qualityWindow!=null)CONFIG.qualityWindow=Math.max(1,Math.round(num(o.qualityWindow,CONFIG.qualityWindow)));
  if(o.qualityRate!=null)CONFIG.qualityRate=Math.min(1,Math.max(0,num(o.qualityRate,CONFIG.qualityRate)));
  if(o.github){const g=o.github;
    if(g.token!=null)CONFIG.github.token=String(g.token); if(g.repo!=null)CONFIG.github.repo=String(g.repo);
    if(g.path!=null)CONFIG.github.path=String(g.path)||'proxyip'; if(g.branch!=null)CONFIG.github.branch=String(g.branch)||'main';
    if(g.auto!=null)CONFIG.github.auto=(g.auto===true||g.auto==='true');
    if(g.uploadIntervalMin!=null)CONFIG.github.uploadIntervalMin=Math.max(0,Math.round(num(g.uploadIntervalMin,0))); }
  restartGithubTimer(); }
function publicConfig(){ return { intervalSec:CONFIG.intervalSec, timeoutSec:CONFIG.timeoutSec, concurrency:CONFIG.concurrency,
  dnsTtlSec:CONFIG.dnsTtlSec, autoCleanDays:CONFIG.autoCleanDays, probeUrl:CONFIG.probeUrl, customProbeUrl:CONFIG.customProbeUrl,
  maxTlsMs:CONFIG.maxTlsMs, minSpeedKBps:CONFIG.minSpeedKBps, qualityWindow:CONFIG.qualityWindow, qualityRate:CONFIG.qualityRate, github:{...CONFIG.github} }; }
function persistConfig(){ try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.configFile,JSON.stringify(publicConfig(),null,2));}catch(e){} }
function restartTimer(){ if(cycleTimer)clearInterval(cycleTimer); cycleTimer=setInterval(runCycle,CONFIG.intervalSec*1000); }
function restartGithubTimer(){ if(githubTimer)clearInterval(githubTimer);
  const mins=CONFIG.github.uploadIntervalMin;
  if(mins>0&&CONFIG.github.token&&CONFIG.github.repo){ githubTimer=setInterval(()=>{ log('⏰ 定时触发 GitHub 上传');
    uploadGithub().catch(e=>{state.github.lastError=e.message;log('⚠️ 定时上传失败: '+e.message);}); },mins*60*1000); } }

// ==================== 工具 ====================
function splitProbe(u){try{const x=new URL(u);return{host:x.hostname,path:x.pathname+x.search};}catch(e){return{host:'www.cloudflare.com',path:'/cdn-cgi/trace'};}}
function parseLine(raw){ let host=raw,port=443;
  if(raw.startsWith('[')){ const m=raw.match(/^\[([^\]]+)\](?::(\d+))?$/); if(!m)return null; host=m[1]; if(m[2])port=+m[2]; }
  else if(raw.includes(':')&&raw.split(':').length===2&&/^\d+$/.test(raw.split(':')[1])){ const p=raw.split(':'); host=p[0]; port=+p[1]; }
  else if(raw.includes(':')){ host=raw; }
  return {host,port}; }
function lineId(raw){ const r=parseLine(raw); return r?r.host+':'+r.port:null; }
function parseIpFile(){ let text='';try{text=fs.readFileSync(CONFIG.ipFile,'utf8');}catch(e){return[];}
  const out=[];const seen=new Set();
  for(const raw of text.split(/\r?\n/)){ const line=raw.split('#')[0].trim(); if(!line)continue;
    const r=parseLine(line); if(!r)continue; const id=r.host+':'+r.port; if(seen.has(id))continue; seen.add(id);
    out.push({host:r.host,port:r.port,label:line}); }
  return out; }
function runCurl(c,ms){return new Promise(r=>exec(c,{timeout:ms,maxBuffer:1024*1024},(e,o)=>r(e?null:o)));}
function parseCurlJson(o){if(!o)return null;const l=o.trim().split('\n');try{return JSON.parse(l[l.length-1]);}catch(e){return null;}}
function parseTrace(t){const p={};String(t||'').replace(/\r/g,'').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)p[l.slice(0,i).trim()]=l.slice(i+1).trim();});return p;}
function readBody(q){return new Promise(r=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>r(d));});}
function ensureIpFile(){ try{ fs.mkdirSync(path.dirname(CONFIG.ipFile),{recursive:true});
  let st=null; try{st=fs.statSync(CONFIG.ipFile);}catch(e){}
  if(st&&st.isDirectory()){ try{fs.rmdirSync(CONFIG.ipFile);}catch(e){return false;} }
  if(!fs.existsSync(CONFIG.ipFile)){ fs.writeFileSync(CONFIG.ipFile,'# 每行一个节点\n# 1.2.3.4:443\n'); }
  return true; }catch(e){ return false; } }
function persistGraveyard(){ try{ fs.writeFileSync(CONFIG.graveyardFile, JSON.stringify({list:state.graveyard.list,blocked:state.blocked})); }catch(e){} }
function loadGraveyard(){ try{ const d=JSON.parse(fs.readFileSync(CONFIG.graveyardFile,'utf8'));
  if(Array.isArray(d)){ state.graveyard.list=d; state.blocked={}; }
  else { state.graveyard.list=d.list||[]; state.blocked=d.blocked||{}; } }catch(e){ state.graveyard.list=[]; state.blocked={}; } }
function offlineSince(id){ const hist=state.history[id]||[];
  for(let i=hist.length-1;i>=0;i--){ if(hist[i].ok)return hist[i].t; }
  if(hist.length>0)return hist[0].t;
  return Date.now(); }
function pushGrave(label,id,lastOnline,mode,reason){ state.graveyard.list.push({id,label,removedAt:Date.now(),lastOnlineAt:lastOnline,mode,reason}); }
function rewriteIpFileRemoving(idSet){ try{ const text=fs.readFileSync(CONFIG.ipFile,'utf8');
  const newLines=text.split(/\r?\n/).filter(line=>{ const raw=line.split('#')[0].trim(); if(!raw)return true;
    const id=lineId(raw); return !(id&&idSet.has(id)); });
  fs.writeFileSync(CONFIG.ipFile,newLines.join('\n')); return true; }catch(e){ log('⚠️ 写入 ip.txt 失败: '+e.message); return false; } }
function migrateHistory(ip,port){
  const id=ip+':'+port;
  if(state.history[id]&&state.history[id].length)return;
  let merged=[]; const legacy=[];
  for(const k of Object.keys(state.history)){
    if(k===id)continue;
    if(k.endsWith('@'+ip)){ const head=k.slice(0,k.lastIndexOf('@')); const p=head.split(':').pop();
      if(+p===port){ merged=merged.concat(state.history[k]); legacy.push(k); } } }
  if(merged.length){ merged.sort((a,b)=>a.t-b.t); state.history[id]=merged.slice(-600); legacy.forEach(k=>delete state.history[k]); }
}

// ==================== IP主键单元构建（屏蔽对 纯IP+域名 双生效） ====================
async function refreshUnits(){
  const now=Date.now(); const targets=parseIpFile(); const map=new Map(); const seenKeys=new Set();
  for(const t of targets){
    if(net.isIPv4(t.host)){
      const id=t.host+':'+t.port;
      if(state.blocked[id])continue;                 // 🌟 v18：屏蔽的纯IP也不显示
      if(!map.has(id))map.set(id,{id,ip:t.host,port:t.port,sources:[],isDomain:false,label:id});
    }
    else if(net.isIPv6(t.host)){ }
    else{
      const key=t.host+':'+t.port; seenKeys.add(key);
      let entry=state.disc[key];
      const need=!entry||(now-entry.queriedAt)>CONFIG.dnsTtlSec*1000;
      if(need){ let ips=[]; try{ips=await Promise.race([dnsPromises.resolve4(t.host),new Promise((_,rj)=>setTimeout(()=>rj(new Error('t')),4000))]);}catch(e){ips=[];}
        if(!entry){entry=state.disc[key]={queriedAt:now,ips:{}};} entry.queriedAt=now;
        (ips||[]).filter(ip=>net.isIPv4(ip)).forEach(ip=>{entry.ips[ip]=now;}); }
      let added=0;
      for(const ip of Object.keys(entry.ips)){
        const pid=ip+':'+t.port;
        if(state.blocked[pid])continue;              // 屏蔽的IP不被域名二次解析
        if(!map.has(pid)){ migrateHistory(ip,t.port); map.set(pid,{id:pid,ip,port:t.port,sources:[],isDomain:false,label:pid}); }
        const u=map.get(pid); if(!u.sources.includes(t.host))u.sources.push(t.host);
        added++; }
      if(!added){ map.set('dom:'+key,{id:'dom:'+key,ip:null,port:t.port,host:t.host,sources:[t.host],isDomain:true,label:t.label}); }
    }
  }
  Object.keys(state.disc).forEach(k=>{ if(!seenKeys.has(k))delete state.disc[k]; });
  state.units=[...map.values()];
}

// ==================== 三重验证 ====================
async function testTarget(u){
  const point={t:Date.now(),ok:false,tcp:null,tls:null,speed:null,colo:null,loc:null,exitIp:null,failReason:null};
  if(!u.ip){ point.failReason='无有效IP（域名未解析到可用IP或被屏蔽）'; return point; }
  const probe=splitProbe(CONFIG.probeUrl); const ms=CONFIG.timeoutSec*1000;
  const latCmd=`curl -4 -k -s --noproxy '*' --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${probe.host}:${u.port}${probe.path}'`;
  const raw=await runCurl(latCmd,ms+1500); const lat=parseCurlJson(raw);
  if(lat&&lat.http&&String(lat.http)!=='000'){ point.ok=true; point.tcp=Math.round(lat.tcp*1000); point.tls=Math.round(lat.tls*1000);
    const info=parseTrace(raw.trim().split('\n').slice(0,-1).join('\n'));
    point.colo=info.colo||null; point.loc=info.loc||null; point.exitIp=info.ip||null; }
  else { point.failReason=`官方探针不通 (HTTP ${lat?lat.http:'000'})`; return point; }
  const spCmd=`curl -4 -k -s --noproxy '*' -o /dev/null --retry 0 -w '\\n{"speed":%{speed_download},"http":%{http_code}}' --resolve "speed.cloudflare.com:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec+3} 'https://speed.cloudflare.com:${u.port}/__down?bytes=524288'`;
  let sp=parseCurlJson(await runCurl(spCmd,ms+4000));
  if(!(sp&&sp.http===200&&sp.speed>0)) sp=parseCurlJson(await runCurl(spCmd,ms+4000));
  if(sp&&sp.http===200&&sp.speed>0){ point.speed=Math.round(sp.speed/1024); }
  else { point.ok=false;
    if(sp&&String(sp.http)==='403')point.failReason='SNI白名单/WAF拦截 (测速返回 403)';
    else if(!sp||String(sp.http)==='000')point.failReason='测速连接失败 (HTTP 000，疑似断流/超时)';
    else point.failReason=`测速失败 (HTTP ${sp.http}，疑似限速/大文件不通)`;
    return point; }
  if(point.ok&&CONFIG.customProbeUrl){ try{ const cu=new URL(CONFIG.customProbeUrl);
    const customCmd=`curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"http":%{http_code}}' --resolve "${cu.hostname}:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${cu.hostname}:${u.port}${cu.pathname}'`;
    const customRes=parseCurlJson(await runCurl(customCmd,ms+1500));
    const code=customRes?String(customRes.http):'000';
    if(code==='403'){ point.ok=false; point.failReason='反代IP不可用：Error 1034: Edge IP Restricted'; } }
  catch(e){ point.ok=false; point.failReason='自定义探针配置错误'; } }
  return point;
}

// ==================== 质量判定 ====================
function tlsOk(p){ return CONFIG.maxTlsMs<=0||(p.tls!=null&&p.tls<=CONFIG.maxTlsMs); }
function speedOk(p){ return CONFIG.minSpeedKBps<=0||(p.speed!=null&&p.speed>=CONFIG.minSpeedKBps); }
function computeQuality(points){
  const recent=(points||[]).slice(-CONFIG.qualityWindow);
  if(!recent.length)return{quality:false,rate:0,goodRate:0,avgTls:null,avgSpeed:null};
  const oks=recent.filter(p=>p.ok); const rate=oks.length/recent.length;
  const good=recent.filter(p=>p.ok&&tlsOk(p)&&speedOk(p)).length; const goodRate=good/recent.length;
  const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;
  return{quality:goodRate>=CONFIG.qualityRate,rate,goodRate,
    avgTls:avg(oks.map(p=>p.tls).filter(v=>v!=null)), avgSpeed:avg(oks.map(p=>p.speed).filter(v=>v!=null))};
}

// ==================== 生命周期清理（自动清理也写屏蔽） ====================
async function cleanGraveyard(){
  if(CONFIG.autoCleanDays<=0)return;
  const threshold=Date.now()-CONFIG.autoCleanDays*24*3600*1000;
  const toRemove=new Set(); let n=0;
  for(const u of state.units){ if(!u.ip)continue;
    const since=offlineSince(u.id);
    if(since<threshold){ toRemove.add(u.ip+':'+u.port);
      state.blocked[u.ip+':'+u.port]=Date.now();        // 🌟 v18：自动清理也屏蔽
      for(const key of Object.keys(state.disc))delete state.disc[key].ips[u.ip];
      delete state.history[u.id];
      pushGrave(u.id,u.id,since,'auto',`离线超 ${CONFIG.autoCleanDays} 天（自动清理）`); n++; } }
  if(n){ rewriteIpFileRemoving(toRemove);
    if(state.graveyard.list.length>1000)state.graveyard.list=state.graveyard.list.slice(-1000);
    persistGraveyard(); await refreshUnits();
    log(`🗑️ 自动清理 ${n} 个长期离线节点（已屏蔽）`); }
}

// ==================== 手动删除（与自动统一的屏蔽语义） ====================
async function removeUnits(ids){
  let removed=0; const lineIds=new Set(); let changed=false;
  for(const id of ids){ const u=state.units.find(x=>x.id===id); if(!u)continue;
    const since=offlineSince(id);
    if(u.ip){ lineIds.add(u.ip+':'+u.port);
      state.blocked[u.ip+':'+u.port]=Date.now();
      for(const key of Object.keys(state.disc))delete state.disc[key].ips[u.ip];
      delete state.history[id]; }
    else { lineIds.add(u.host+':'+u.port); delete state.disc[u.host+':'+u.port]; }
    changed=true; pushGrave(u.label,id,since,'manual','手动删除'); removed++; }
  if(changed){ rewriteIpFileRemoving(lineIds);
    if(state.graveyard.list.length>1000)state.graveyard.list=state.graveyard.list.slice(-1000);
    persistGraveyard(); await refreshUnits(); }
  log(`🗑️ 手动删除 ${removed} 个节点（已屏蔽）`); return removed;
}

async function runCycle(){
  if(state.checking)return; state.checking=true;
  try{ await refreshUnits();
    state.progress={tested:0,total:state.units.length};
    log('🔄 开始检测 '+state.units.length+' 个节点（并发 '+CONFIG.concurrency+'）');
    const queue=[...state.units];
    const workers=Array.from({length:Math.min(CONFIG.concurrency,Math.max(queue.length,1))},async()=>{
      while(queue.length){ const u=queue.shift();
        try{ const point=await testTarget(u);
          if(!state.history[u.id])state.history[u.id]=[];
          state.history[u.id].push(point);
          if(state.history[u.id].length>600)state.history[u.id]=state.history[u.id].slice(-600);
          state.progress.tested++;
          log((point.ok?'✅ ':'❌ ')+u.id+(point.ok?(' tls='+point.tls+'ms'+(point.speed!=null?' speed='+point.speed+'KB/s':'')):(' 失败: '+point.failReason)));
        }catch(e){ log('⚠️ '+u.id+' 检测异常: '+e.message); state.progress.tested++; } } });
    await Promise.all(workers);
    state.lastCycle=Date.now();
    const online=state.units.filter(u=>{const h=state.history[u.id];return h&&h.length&&h[h.length-1].ok;}).length;
    const quality=state.units.filter(u=>computeQuality(state.history[u.id]).quality).length;
    log('🏁 检测完成：在线 '+online+' / 优质 '+quality+' / 总数 '+state.units.length);
    await cleanGraveyard();
    try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.dataFile,JSON.stringify({history:state.history,disc:state.disc}));}catch(e){}
    if(CONFIG.github.auto)autoUpload().catch(e=>{state.github.lastError=e.message;log('⚠️ 自动上传失败: '+e.message);});
  }finally{ state.checking=false; }
}
function loadData(){ try{const d=JSON.parse(fs.readFileSync(CONFIG.dataFile,'utf8'));
  if(d&&d.history)state.history=d.history; if(d&&d.disc)state.disc=d.disc; }catch(e){} loadGraveyard(); }

// ==================== GitHub ====================
function formatNodeLine(ipPort,region,q){
  const tls=q.avgTls!=null?q.avgTls+'ms':'?ms';
  let speedStr='?Mbps'; if(q.avgSpeed!=null)speedStr=(q.avgSpeed*8/1000).toFixed(1)+'Mbps';
  return `${ipPort}#${region} | ${tls} | ${speedStr}`; }
function buildUploadData(){
  const seen=new Map();
  state.units.filter(u=>u.ip).forEach(u=>{ const hist=state.history[u.id]||[]; const latest=hist.length?hist[hist.length-1]:null;
    const q=computeQuality(hist); if(!q.quality)return;
    const k=u.ip+':'+u.port; const cur=seen.get(k);
    if(!cur||(q.avgTls??99999)<(cur.q.avgTls??99999))seen.set(k,{u,q,latest}); });
  const nodes=[...seen.values()].sort((a,b)=>(a.q.avgTls??99999)-(b.q.avgTls??99999));
  const bodies={'all.txt':[]};
  nodes.forEach(({u,q,latest})=>{ const ipPort=`${u.ip}:${u.port}`; const region=latest?(latest.loc||latest.colo||'Unknown'):'Unknown';
    const line=formatNodeLine(ipPort,region,q); bodies['all.txt'].push(line);
    const safe=region.toLowerCase().replace(/[^a-z0-9_-]/g,'')||'unknown';
    if(!bodies[safe+'.txt'])bodies[safe+'.txt']=[]; bodies[safe+'.txt'].push(line); });
  const fingerprint=bodies['all.txt'].join('\n');
  return {bodies,count:nodes.length,fingerprint};
}
function renderFile(lines){
  return `# ProxyIP quality list (auto uploaded by proxy-monitor ${VERSION})\n# updated: ${new Date().toISOString()}\n# nodes: ${lines.length}\n`+
    lines.join('\n')+(lines.length?'\n':'');
}
async function uploadGithub(){
  const g=CONFIG.github; if(!g.token||!g.repo)throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  const {bodies,count,fingerprint}=buildUploadData(); if(!count)throw new Error('当前没有优质节点可上传');
  const headers={'Authorization':`Bearer ${g.token}`,'Accept':'application/vnd.github+json','User-Agent':'proxy-monitor','Content-Type':'application/json'};
  const basePath=g.path.replace(/\.txt$/,'');
  for(const [filename,lines] of Object.entries(bodies)){
    const fullPath=`${basePath}_${filename}`; const apiPath=fullPath.split('/').map(encodeURIComponent).join('/');
    const api=`https://api.github.com/repos/${g.repo}/contents/${apiPath}`;
    let sha; try{ const getRes=await fetch(`${api}?ref=${g.branch}`,{headers});
      if(getRes.ok)sha=(await getRes.json()).sha; else if(getRes.status!==404){log(`⚠️ 查询 ${fullPath} 失败: HTTP ${getRes.status}`);continue;} }catch(e){continue;}
    const body={message:`chore: update ${filename} (${lines.length} nodes)`,content:Buffer.from(renderFile(lines),'utf8').toString('base64'),branch:g.branch}; if(sha)body.sha=sha;
    try{ const putRes=await fetch(api,{method:'PUT',headers,body:JSON.stringify(body)}); if(!putRes.ok)log(`⚠️ 上传 ${fullPath} 失败: HTTP ${putRes.status}`); }catch(e){} }
  state.github.lastUpload=Date.now(); state.github.lastError=null; state.lastUploadedContent=fingerprint;
  log(`📤 已上传 ${count} 个优质节点 (${Object.keys(bodies).length} 个文件)`); return{count,fileCount:Object.keys(bodies).length};
}
async function autoUpload(){ const {fingerprint}=buildUploadData();
  if(fingerprint===state.lastUploadedContent){ log('⏭️ 优质列表未变化，跳过上传'); return; }
  await uploadGithub(); }

// ==================== API ====================
function buildState(){
  try{ const items=state.units.map(u=>{ const hist=state.history[u.id]||[]; const latest=hist.length?hist[hist.length-1]:null;
    return{ id:u.id,label:u.label,host:u.host||null,port:u.port,isDomain:u.isDomain,ip:u.ip,sources:u.sources||[],
      colo:latest?latest.colo:null,loc:latest?latest.loc:null,exitIp:latest?latest.exitIp:null,
      latest,quality:computeQuality(hist), recent:hist.slice(-40).map(p=>({t:p.t,ok:!!p.ok,tls:p.tls,speed:p.speed})) }; });
    const online=items.filter(i=>i.latest&&i.latest.ok).length; const quality=items.filter(i=>i.quality.quality).length;
    return{ version:VERSION, checking:state.checking,progress:{...state.progress},lastCycle:state.lastCycle,intervalSec:CONFIG.intervalSec,
      config:{maxTlsMs:CONFIG.maxTlsMs,minSpeedKBps:CONFIG.minSpeedKBps,qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate,dnsTtlSec:CONFIG.dnsTtlSec,autoCleanDays:CONFIG.autoCleanDays,customProbeUrl:CONFIG.customProbeUrl},
      github:{configured:!!(CONFIG.github.token&&CONFIG.github.repo),auto:CONFIG.github.auto,lastUpload:state.github.lastUpload,lastError:state.github.lastError,uploadIntervalMin:CONFIG.github.uploadIntervalMin},
      summary:{total:items.length,online,quality,offline:items.length-online},items };
  }catch(e){ return{version:VERSION,checking:false,progress:{tested:0,total:0},lastCycle:null,intervalSec:CONFIG.intervalSec,
    config:{maxTlsMs:0,minSpeedKBps:0,qualityWindow:10,qualityRate:1,dnsTtlSec:300,autoCleanDays:7,customProbeUrl:''},
    github:{configured:false,auto:false,lastUpload:null,lastError:e.message,uploadIntervalMin:0},
    summary:{total:0,online:0,quality:0,offline:0},items:[]}; }
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'); const p=url.pathname;
  const json=(d,s=200)=>{res.writeHead(s,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(d));};
  try{
    if(p==='/'||p==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')));}
    if(p==='/api/state')return json(buildState());
    if(p==='/api/logs')return json({logs:state.logs});
    if(p==='/api/graveyard'&&req.method==='GET')return json({graveyard:state.graveyard.list});
    if(p==='/api/graveyard/clear'&&req.method==='POST'){state.graveyard.list=[];state.blocked={};persistGraveyard();return json({ok:true});}
    if(p==='/api/remove'&&req.method==='POST'){const{ids}=JSON.parse(await readBody(req)||'{}');
      if(!Array.isArray(ids)||!ids.length)return json({ok:false,error:'无有效节点ID'},400);
      return json({ok:true,count:await removeUnits(ids)});}
    if(p==='/api/config'&&req.method==='GET')return json(publicConfig());
    if(p==='/api/config'&&req.method==='POST'){setConfig(JSON.parse(await readBody(req)||'{}'));persistConfig();restartTimer();log('🛠️ 配置已更新');return json({ok:true,config:publicConfig()});}
    if(p==='/api/ipfile'&&req.method==='GET'){let c='';try{c=fs.readFileSync(CONFIG.ipFile,'utf8');}catch(e){}return json({content:c});}
    if(p==='/api/ipfile'&&req.method==='POST'){const{content}=JSON.parse(await readBody(req)||'{}');
      if(!ensureIpFile())return json({ok:false,error:'ip.txt 路径被占用为目录'},500);
      fs.writeFileSync(CONFIG.ipFile,String(content??''));await refreshUnits();return json({ok:true,count:state.units.length});}
    if(p==='/api/check'&&req.method==='POST'){log('🖱️ 手动触发检测');runCycle();return json({ok:true});}
    if(p==='/api/reload'&&req.method==='POST'){await refreshUnits();return json({ok:true,count:state.units.length});}
    if(p==='/api/upload'&&req.method==='POST'){try{return json({ok:true,...(await uploadGithub())});}
      catch(e){state.github.lastError=e.message;log('⚠️ 手动上传失败: '+e.message);return json({ok:false,error:e.message},500);}}
    return json({error:'not found'},404);
  }catch(e){return json({error:e.message},500);}
});

try{setConfig(JSON.parse(fs.readFileSync(CONFIG.configFile,'utf8')));}catch(e){}
ensureIpFile(); loadData();
server.listen(CONFIG.port,async()=>{
  console.log(`🚀 Proxy Monitor ${VERSION} on http://0.0.0.0:${CONFIG.port}`);
  log(`🚀 服务启动 (${VERSION} 屏蔽逻辑统一)`);
  await refreshUnits(); runCycle(); restartTimer(); restartGithubTimer();
});