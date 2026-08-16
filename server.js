/**
 * Proxy Monitor v25 (配置-节点解耦 + 节点注册表)
 * 配置只负责发现(每轮重新解析/拉取,只增); 节点注册表持久化,清理才删; 屏蔽防复活
 * firstSource 单值(首次引入)+firstSeen; 移除 v20 联动删除
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');
const VERSION = 'v25';

const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || '/app/config/ip.txt',
  dataDir: process.env.DATA_DIR || '/app/data',
  intervalSec: parseInt(process.env.INTERVAL_SEC || '60', 10),
  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  customProbeUrl: process.env.CUSTOM_PROBE_URL || 'https://proxyip-check.coldicy.cc.cd/generate_204',
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
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

const state = { units: [], nodes: {}, history: {}, blocked: {}, graveyard: { list: [] },
  lastCycle: null, checking: false, progress: { tested: 0, total: 0 }, logs: [],
  github: { lastUpload: null, lastError: null }, lastUploadedContent: '' };
let cycleTimer = null, githubTimer = null;

function log(m){ state.logs.push({ t: Date.now(), m: String(m) }); if (state.logs.length > 400) state.logs = state.logs.slice(-400); }

// ==================== 配置 ====================
function setConfig(o){ if(!o)return; const num=(v,d)=>{const n=parseFloat(v);return isFinite(n)?n:d;};
  if(o.intervalSec!=null)CONFIG.intervalSec=Math.max(5,Math.round(num(o.intervalSec,CONFIG.intervalSec)));
  if(o.timeoutSec!=null)CONFIG.timeoutSec=Math.max(1,Math.round(num(o.timeoutSec,CONFIG.timeoutSec)));
  if(o.concurrency!=null)CONFIG.concurrency=Math.max(1,Math.round(num(o.concurrency,CONFIG.concurrency)));
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
  autoCleanDays:CONFIG.autoCleanDays, probeUrl:CONFIG.probeUrl, customProbeUrl:CONFIG.customProbeUrl,
  maxTlsMs:CONFIG.maxTlsMs, minSpeedKBps:CONFIG.minSpeedKBps, qualityWindow:CONFIG.qualityWindow, qualityRate:CONFIG.qualityRate, github:{...CONFIG.github} }; }
function persistConfig(){ try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.configFile,JSON.stringify(publicConfig(),null,2));}catch(e){} }
function restartTimer(){ if(cycleTimer)clearInterval(cycleTimer); cycleTimer=setInterval(runCycle,CONFIG.intervalSec*1000); }
function restartGithubTimer(){ if(githubTimer)clearInterval(githubTimer);
  const mins=CONFIG.github.uploadIntervalMin;
  if(mins>0&&CONFIG.github.token&&CONFIG.github.repo){ githubTimer=setInterval(()=>{ log('⏰ 定时触发 GitHub 上传');
    uploadGithub().catch(e=>{state.github.lastError=e.message;log('⚠️ 定时上传失败: '+e.message);}); },mins*60*1000); } }

// ==================== 工具 ====================
function splitProbe(u){try{const x=new URL(u);return{host:x.hostname,path:x.pathname+x.search};}catch(e){return{host:'www.cloudflare.com',path:'/cdn-cgi/trace'};}}
function isUrl(s){return /^https?:\/\//i.test(s);}
function parseLine(raw){ let host=raw,port=443;
  if(raw.startsWith('[')){ const m=raw.match(/^\[([^\]]+)\](?::(\d+))?$/); if(!m)return null; host=m[1]; if(m[2])port=+m[2]; }
  else if(raw.includes(':')&&raw.split(':').length===2&&/^\d+$/.test(raw.split(':')[1])){ const p=raw.split(':'); host=p[0]; port=+p[1]; }
  else if(raw.includes(':')){ host=raw; }
  return {host,port}; }
function sourceKeyForLine(line){ if(isUrl(line))return 'url:'+line;
  const r=parseLine(line); if(!r)return null;
  if(net.isIPv4(r.host))return 'pure:'+r.host+':'+r.port;
  if(net.isIPv6(r.host))return null;
  return 'dom:'+r.host+':'+r.port; }
function splitId(id){ const i=id.lastIndexOf(':'); return [id.slice(0,i), +id.slice(i+1)]; }
function runCurl(c,ms){return new Promise(r=>exec(c,{timeout:ms,maxBuffer:4*1024*1024},(e,o)=>r(e?null:o)));}
function parseCurlJson(o){if(!o)return null;const l=o.trim().split('\n');try{return JSON.parse(l[l.length-1]);}catch(e){return null;}}
function parseTrace(t){const p={};String(t||'').replace(/\r/g,'').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)p[l.slice(0,i).trim()]=l.slice(i+1).trim();});return p;}
function readBody(q){return new Promise(r=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>r(d));});}
function ensureIpFile(){ try{ fs.mkdirSync(path.dirname(CONFIG.ipFile),{recursive:true});
  let st=null; try{st=fs.statSync(CONFIG.ipFile);}catch(e){}
  if(st&&st.isDirectory()){ try{fs.rmdirSync(CONFIG.ipFile);}catch(e){return false;} }
  if(!fs.existsSync(CONFIG.ipFile)){ fs.writeFileSync(CONFIG.ipFile,'# 每行: 纯IP / 域名 / http(s)列表源\n# 1.2.3.4:443\n# cdn.example.com:8443\n# https://example.com/list.txt\n'); }
  return true; }catch(e){ return false; } }
function persistGraveyard(){ try{ fs.writeFileSync(CONFIG.graveyardFile, JSON.stringify({list:state.graveyard.list,blocked:state.blocked})); }catch(e){} }
function loadGraveyard(){ try{ const d=JSON.parse(fs.readFileSync(CONFIG.graveyardFile,'utf8'));
  if(Array.isArray(d)){ state.graveyard.list=d; state.blocked={}; }
  else { state.graveyard.list=d.list||[]; state.blocked=d.blocked||{}; } }catch(e){ state.graveyard.list=[]; state.blocked={}; } }
function capGraveyard(){ if(state.graveyard.list.length>1000)state.graveyard.list=state.graveyard.list.slice(-1000); }
function offlineSince(id){ const hist=state.history[id]||[];
  for(let i=hist.length-1;i>=0;i--){ if(hist[i].ok)return hist[i].t; }
  if(hist.length>0)return hist[0].t;
  return Date.now(); }
function pushGrave(label,id,lastOnline,mode,reason){ state.graveyard.list.push({id,label,removedAt:Date.now(),lastOnlineAt:lastOnline,mode,reason}); }
function saveData(){ try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.dataFile,JSON.stringify({history:state.history,nodes:state.nodes}));}catch(e){} }
async function mapLimit(items,limit,fn){ const res=new Array(items.length); let i=0;
  const workers=Array.from({length:Math.min(limit,items.length||1)},async()=>{ while(i<items.length){ const idx=i++; res[idx]=await fn(items[idx]); } });
  await Promise.all(workers); return res; }
function timeoutPromise(ms){ return new Promise((_,rj)=>setTimeout(()=>rj(new Error('t')),ms)); }
async function fetchList(url){ const safe=url.replace(/'/g,"'\\''");
  const out=await runCurl(`curl -4 -k -s --noproxy '*' --compressed -m 20 '${safe}'`,25000);
  if(out&&out.trim()){ if(out.length>2*1024*1024)return out.slice(0,2*1024*1024); return out; }
  return ''; }

// ==================== 🌟 节点注册表迁移(旧disc/history→nodes) ====================
function migrateNodes(disc){
  const nodes={};
  for(const key of Object.keys(disc||{})){ const e=disc[key];
    const kind=e.kind||(key.startsWith('pure:')?'pure':key.startsWith('url:')?'url':'dom');
    for(const id of Object.keys(e.ids||{})){ const [ip,port]=splitId(id); if(!net.isIPv4(ip))continue;
      if(!nodes[id])nodes[id]={id,ip,port,firstSource:{kind,name:e.name||id}}; } }
  for(const id of Object.keys(state.history)){ const [ip,port]=splitId(id); if(!net.isIPv4(ip))continue;
    const hist=state.history[id]; const firstSeen=hist&&hist.length?hist[0].t:Date.now();
    if(!nodes[id])nodes[id]={id,ip,port,firstSource:{kind:'pure',name:id}};
    if(!nodes[id].firstSeen)nodes[id].firstSeen=firstSeen; }
  for(const id of Object.keys(nodes)){ if(!nodes[id].firstSeen)nodes[id].firstSeen=Date.now(); }
  return nodes;
}
function loadData(){ try{const d=JSON.parse(fs.readFileSync(CONFIG.dataFile,'utf8'));
  if(d&&d.history)state.history=d.history;
  if(d&&d.nodes&&Object.keys(d.nodes).length){ state.nodes=d.nodes; }
  else { state.nodes=migrateNodes(d&&d.disc?d.disc:{}); }
 }catch(e){ state.nodes=migrateNodes({}); } loadGraveyard(); }

// ==================== 🌟 发现(只增) + 单元=注册表 ====================
async function discover(){
  const now=Date.now();
  let lines=[]; try{lines=fs.readFileSync(CONFIG.ipFile,'utf8').split(/\r?\n/);}catch(e){}
  const present=new Set(); const domJobs=[],urlJobs=[]; const adds=[];
  for(const raw of lines){ const line=raw.split('#')[0].trim(); if(!line)continue;
    const key=sourceKeyForLine(line); if(!key||present.has(key))continue; present.add(key);
    if(key.startsWith('pure:')){ const id=key.slice(5); adds.push({id,kind:'pure',name:id}); }
    else if(key.startsWith('dom:')){ const hp=key.slice(4); const li=hp.lastIndexOf(':');
      domJobs.push({host:hp.slice(0,li),port:+hp.slice(li+1),kind:'dom',name:hp.slice(0,li)}); }
    else { urlJobs.push({url:key.slice(4),kind:'url',name:key.slice(4)}); } }
  await mapLimit(domJobs,20,async j=>{ let ips=[]; try{ips=await Promise.race([dnsPromises.resolve4(j.host),timeoutPromise(4000)]);}catch(e){}
    (ips||[]).filter(ip=>net.isIPv4(ip)).forEach(ip=>adds.push({id:ip+':'+j.port,kind:j.kind,name:j.name})); });
  await mapLimit(urlJobs,8,async j=>{ const content=await fetchList(j.url);
    for(const rl of content.split(/\r?\n/)){ const l=rl.split('#')[0].trim(); if(!l||isUrl(l))continue;
      const r=parseLine(l); if(!r||!net.isIPv4(r.host))continue; adds.push({id:r.host+':'+r.port,kind:j.kind,name:j.name}); } });
  let added=0;
  for(const a of adds){ if(state.blocked[a.id])continue; if(state.nodes[a.id])continue;
    const [ip,port]=splitId(a.id);
    state.nodes[a.id]={id:a.id,ip,port,firstSeen:now,firstSource:{kind:a.kind,name:a.name}}; added++; }
  return added;
}

// ==================== 三关加固测试 ====================
async function testTarget(u){
  const point={t:Date.now(),ok:false,tcp:null,tls:null,speed:null,colo:null,loc:null,exitIp:null,failReason:null};
  if(!u.ip){ point.failReason='无有效IP'; return point; }
  const probe=splitProbe(CONFIG.probeUrl); const ms=CONFIG.timeoutSec*1000;
  const latCmd=`curl -4 -k -s --noproxy '*' --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${probe.host}:${u.port}${probe.path}'`;
  const raw=await runCurl(latCmd,ms+1500); const lat=parseCurlJson(raw);
  if(lat && lat.http === 200){
    const traceText = raw.trim().split('\n').slice(0, -1).join('\n');
    const info = parseTrace(traceText);
    if (!info.colo && !info.fl) { point.failReason = '官方探针返回非 CF 内容 (疑似 SNI 劫持/假反代)'; return point; }
    point.ok=true; point.tcp=Math.round(lat.tcp*1000); point.tls=Math.round(lat.tls*1000);
    point.colo=info.colo||null; point.loc=info.loc||null; point.exitIp=info.ip||null; }
  else { point.failReason=`官方探针不通 (HTTP ${lat?lat.http:'000'})`; return point; }
  const spCmd=`curl -4 -k -s --noproxy '*' -o /dev/null --retry 0 -w '\\n{"speed":%{speed_download},"size":%{size_download},"http":%{http_code}}' --resolve "speed.cloudflare.com:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec+3} 'https://speed.cloudflare.com:${u.port}/__down?bytes=524288'`;
  let sp=parseCurlJson(await runCurl(spCmd,ms+4000));
  if(!(sp && sp.http===200 && sp.speed>0 && sp.size >= 500000)) sp=parseCurlJson(await runCurl(spCmd,ms+4000));
  if(sp && sp.http===200 && sp.speed>0 && sp.size >= 500000){ point.speed=Math.round(sp.speed/1024); }
  else { point.ok=false;
    if(sp && String(sp.http)==='403') point.failReason='SNI白名单/WAF拦截 (测速返回 403)';
    else if(!sp || String(sp.http)==='000') point.failReason='测速连接失败 (HTTP 000，疑似断流/超时)';
    else if(sp && sp.size < 500000) point.failReason=`测速返回体积异常 (${sp.size} bytes，预期 ~512KB，疑似劫持)`;
    else point.failReason=`测速失败 (HTTP ${sp?sp.http:'?'}，疑似限速/大文件不通)`;
    return point; }
  if(point.ok && CONFIG.customProbeUrl){ try{ const cu=new URL(CONFIG.customProbeUrl);
    const customCmd=`curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"http":%{http_code}}' --resolve "${cu.hostname}:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${cu.hostname}:${u.port}${cu.pathname}'`;
    const customRes=parseCurlJson(await runCurl(customCmd,ms+1500));
    const code=customRes?String(customRes.http):'000';
    const expectCode = cu.pathname.includes('generate_204') ? '204' : '200';
    if (code !== expectCode) { point.ok=false; point.failReason=`自定义探针返回非预期状态 (HTTP ${code}，预期 ${expectCode}，疑似假反代)`; } }
  catch(e){ point.ok=false; point.failReason='自定义探针配置错误'; } }
  return point;
}

// ==================== 质量判定(样本充足) ====================
function tlsOk(p){ return CONFIG.maxTlsMs<=0||(p.tls!=null&&p.tls<=CONFIG.maxTlsMs); }
function speedOk(p){ return CONFIG.minSpeedKBps<=0||(p.speed!=null&&p.speed>=CONFIG.minSpeedKBps); }
function computeQuality(points){
  const recent=(points||[]).slice(-CONFIG.qualityWindow);
  if(!recent.length)return{quality:false,rate:0,goodRate:0,avgTls:null,avgSpeed:null,samples:0};
  const oks=recent.filter(p=>p.ok); const rate=oks.length/recent.length;
  const good=recent.filter(p=>p.ok&&tlsOk(p)&&speedOk(p)).length; const goodRate=good/recent.length;
  const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;
  const enough=recent.length>=CONFIG.qualityWindow;
  return{quality:enough&&goodRate>=CONFIG.qualityRate,rate,goodRate,
    avgTls:avg(oks.map(p=>p.tls).filter(v=>v!=null)), avgSpeed:avg(oks.map(p=>p.speed).filter(v=>v!=null)),
    samples:recent.length};
}

// ==================== 清理(只删节点+屏蔽,不碰配置) ====================
async function cleanGraveyard(){
  if(CONFIG.autoCleanDays<=0)return;
  const threshold=Date.now()-CONFIG.autoCleanDays*24*3600*1000;
  let n=0;
  for(const id of Object.keys(state.nodes)){
    if(offlineSince(id)<threshold){ delete state.nodes[id]; state.blocked[id]=Date.now();
      pushGrave(id,id,offlineSince(id),'auto',`离线超 ${CONFIG.autoCleanDays} 天（自动清理）`); delete state.history[id]; n++; } }
  if(n){ capGraveyard(); persistGraveyard(); saveData(); log(`🗑️ 自动清理 ${n} 个长期离线节点（已屏蔽）`); }
}
async function removeUnits(ids){
  let removed=0;
  for(const id of ids){ const u=state.nodes[id]; if(!u)continue;
    delete state.nodes[id]; state.blocked[id]=Date.now();
    pushGrave(id,id,offlineSince(id),'manual','手动删除'); delete state.history[id]; removed++; }
  if(removed){ capGraveyard(); persistGraveyard(); saveData(); log(`🗑️ 手动删除 ${removed} 个节点（已屏蔽）`); }
  return removed;
}

async function runCycle(){
  if(state.checking)return; state.checking=true;
  try{ const added=await discover();
    if(added)log('🆕 发现 '+added+' 个新节点');
    state.units=Object.values(state.nodes);
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
    saveData();
    if(CONFIG.github.auto)autoUpload().catch(e=>{state.github.lastError=e.message;log('⚠️ 自动上传失败: '+e.message);});
  }finally{ state.checking=false; }
}

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
  try{ state.units=Object.values(state.nodes);
    const items=state.units.map(u=>{ const hist=state.history[u.id]||[]; const latest=hist.length?hist[hist.length-1]:null;
      return{ id:u.id,label:u.id,ip:u.ip,port:u.port,
        srcKind:(u.firstSource&&u.firstSource.kind)||'pure', srcName:(u.firstSource&&u.firstSource.name)||u.id, firstSeen:u.firstSeen||null,
        colo:latest?latest.colo:null,loc:latest?latest.loc:null,exitIp:latest?latest.exitIp:null,
        latest,quality:computeQuality(hist), recent:hist.slice(-40).map(p=>({t:p.t,ok:!!p.ok,tls:p.tls,speed:p.speed})) }; });
    const online=items.filter(i=>i.latest&&i.latest.ok).length; const quality=items.filter(i=>i.quality.quality).length;
    return{ version:VERSION, checking:state.checking,progress:{...state.progress},lastCycle:state.lastCycle,intervalSec:CONFIG.intervalSec,
      config:{maxTlsMs:CONFIG.maxTlsMs,minSpeedKBps:CONFIG.minSpeedKBps,qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate,autoCleanDays:CONFIG.autoCleanDays,customProbeUrl:CONFIG.customProbeUrl},
      github:{configured:!!(CONFIG.github.token&&CONFIG.github.repo),auto:CONFIG.github.auto,lastUpload:state.github.lastUpload,lastError:state.github.lastError,uploadIntervalMin:CONFIG.github.uploadIntervalMin},
      summary:{total:items.length,online,quality,offline:items.length-online},items };
  }catch(e){ return{version:VERSION,checking:false,progress:{tested:0,total:0},lastCycle:null,intervalSec:CONFIG.intervalSec,
    config:{maxTlsMs:0,minSpeedKBps:0,qualityWindow:10,qualityRate:1,autoCleanDays:7,customProbeUrl:''},
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
    if(p==='/api/config'&&req.method==='POST'){setConfig(JSON.parse(await readBody(req)||'{}'));persistConfig();restartTimer();log('🛠️ 配置已更新');runCycle();return json({ok:true,config:publicConfig()});}
    if(p==='/api/ipfile'&&req.method==='GET'){let c='';try{c=fs.readFileSync(CONFIG.ipFile,'utf8');}catch(e){}return json({content:c});}
    if(p==='/api/ipfile'&&req.method==='POST'){const{content}=JSON.parse(await readBody(req)||'{}');
      if(!ensureIpFile())return json({ok:false,error:'ip.txt 路径被占用为目录'},500);
      fs.writeFileSync(CONFIG.ipFile,String(content??''));runCycle();return json({ok:true,count:Object.keys(state.nodes).length});}
    if(p==='/api/check'&&req.method==='POST'){log('🖱️ 手动触发检测');runCycle();return json({ok:true});}
    if(p==='/api/reload'&&req.method==='POST'){await discover();state.units=Object.values(state.nodes);return json({ok:true,count:state.units.length});}
    if(p==='/api/upload'&&req.method==='POST'){try{return json({ok:true,...(await uploadGithub())});}
      catch(e){state.github.lastError=e.message;log('⚠️ 手动上传失败: '+e.message);return json({ok:false,error:e.message},500);}}
    return json({error:'not found'},404);
  }catch(e){return json({error:e.message},500);}
});

try{setConfig(JSON.parse(fs.readFileSync(CONFIG.configFile,'utf8')));}catch(e){}
ensureIpFile(); loadData();
server.listen(CONFIG.port,async()=>{
  console.log(`🚀 Proxy Monitor ${VERSION} on http://0.0.0.0:${CONFIG.port}`);
  log(`🚀 服务启动 (${VERSION} 配置-节点解耦+节点注册表)`);
  await discover(); state.units=Object.values(state.nodes); runCycle(); restartTimer(); restartGithubTimer();
});