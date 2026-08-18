/**
 * Proxy Monitor v34 (自愈加载 + 启动日志)
 * 修复: 全0问题 -> 迁移容错(ids/ips) / 发现逐行容错 / 启动打印数量 / buildState容错
 * 继承: v33 惩罚均摊+多线折线 / 多源站 / CF CIDR / 解耦 / 清除记录 / 中断安全
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');
const VERSION = 'v34';

const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || '/app/config/ip.txt',
  dataDir: process.env.DATA_DIR || '/app/data',
  intervalSec: parseInt(process.env.INTERVAL_SEC || '60', 10),
  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  customProbes: [],
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '50', 10),
  autoCleanDays: parseFloat(process.env.AUTO_CLEAN_DAYS || '7'),
  maxTotalMs: parseFloat(process.env.MAX_TOTAL_MS || '0'),
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
  cfCidrs: [], cfCidrsAt: 0, ipLineCount: 0,
  lastCycle: null, checking: false, abort: false, progress: { tested: 0, total: 0 }, logs: [],
  github: { lastUpload: null, lastError: null }, lastUploadedContent: '' };
let cycleTimer = null, githubTimer = null;

function log(m){ state.logs.push({ t: Date.now(), m: String(m) }); if (state.logs.length > 400) state.logs = state.logs.slice(-400); }

// ==================== 配置 ====================
function setConfig(o){ if(!o)return; const num=(v,d)=>{const n=parseFloat(v);return isFinite(n)?n:d;};
  if(o.intervalSec!=null)CONFIG.intervalSec=Math.max(5,Math.round(num(o.intervalSec,CONFIG.intervalSec)));
  if(o.timeoutSec!=null)CONFIG.timeoutSec=Math.max(1,Math.round(num(o.timeoutSec,CONFIG.timeoutSec)));
  if(o.concurrency!=null)CONFIG.concurrency=Math.max(1,Math.round(num(o.concurrency,CONFIG.concurrency)));
  if(o.autoCleanDays!=null)CONFIG.autoCleanDays=Math.max(0,num(o.autoCleanDays,0));
  if(o.maxTotalMs!=null)CONFIG.maxTotalMs=num(o.maxTotalMs,0);
  if(o.probeUrl)CONFIG.probeUrl=String(o.probeUrl);
  if(o.qualityWindow!=null)CONFIG.qualityWindow=Math.max(1,Math.round(num(o.qualityWindow,CONFIG.qualityWindow)));
  if(o.qualityRate!=null)CONFIG.qualityRate=Math.min(1,Math.max(0,num(o.qualityRate,CONFIG.qualityRate)));
  if(o.customProbes && Array.isArray(o.customProbes)){
    CONFIG.customProbes = o.customProbes.filter(p => p && p.url).map(p => ({url: String(p.url), expect: String(p.expect || '200')}));
  } else if(o.customProbeUrl != null) {
    CONFIG.customProbes = [{url: String(o.customProbeUrl), expect: '204'}];
  }
  if(o.github){const g=o.github;
    if(g.token!=null)CONFIG.github.token=String(g.token); if(g.repo!=null)CONFIG.github.repo=String(g.repo);
    if(g.path!=null)CONFIG.github.path=String(g.path)||'proxyip'; if(g.branch!=null)CONFIG.github.branch=String(g.branch)||'main';
    if(g.auto!=null)CONFIG.github.auto=(g.auto===true||g.auto==='true');
    if(g.uploadIntervalMin!=null)CONFIG.github.uploadIntervalMin=Math.max(0,Math.round(num(g.uploadIntervalMin,0))); }
  restartGithubTimer(); }
function publicConfig(){ return { intervalSec:CONFIG.intervalSec, timeoutSec:CONFIG.timeoutSec, concurrency:CONFIG.concurrency,
  autoCleanDays:CONFIG.autoCleanDays, maxTotalMs:CONFIG.maxTotalMs, probeUrl:CONFIG.probeUrl, customProbes:CONFIG.customProbes,
  qualityWindow:CONFIG.qualityWindow, qualityRate:CONFIG.qualityRate, github:{...CONFIG.github} }; }
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
function runCurl2(c,ms){return new Promise(r=>exec(c,{timeout:ms,maxBuffer:4*1024*1024},(e,o)=>r({out:e?null:o,code:e?(e.killed?-1:e.code):0})));}
function curlFailText(code){ if(code===28)return '超时'; if(code===7)return '连接被拒'; if(code===35||code===60||code===61)return 'TLS错误';
  if(code===-1)return '进程超时/被杀'; if(code===6)return 'DNS解析失败'; return 'curl错误 '+code; }
function parseCurlJson(o){if(!o)return null;const l=o.trim().split('\n');try{return JSON.parse(l[l.length-1]);}catch(e){return null;}}
function parseTrace(t){const p={};String(t||'').replace(/\r/g,'').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)p[l.slice(0,i).trim()]=l.slice(i+1).trim();});return p;}
function readBody(q){return new Promise(r=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>r(d));});}
function buildSegs(w){ if(!w)return null;
  const tcp=Math.max(0,Math.round((w.tcp||0)*1000));
  const tls=Math.max(0,Math.round(((w.tls||0)-(w.tcp||0))*1000));
  const total=Math.max(0,Math.round((w.ttfb||0)*1000));
  return {tcp,tls,total,src:Math.max(0,total-tcp-tls)}; }
function penaltySegs(){ const P=(CONFIG.timeoutSec+2)*1000; const t=Math.round(P/3);
  return {tcp:t,tls:t,src:Math.max(0,P-2*t),total:P}; }
function avgSegs(list){ if(!list||!list.length)return null;
  const avg=f=>Math.round(list.reduce((s,x)=>s+f(x),0)/list.length);
  const tcp=avg(x=>x.tcp), tls=avg(x=>x.tls), total=avg(x=>x.total);
  return {tcp,tls,total,src:Math.max(0,total-tcp-tls)}; }
function ensureIpFile(){ try{ fs.mkdirSync(path.dirname(CONFIG.ipFile),{recursive:true});
  let st=null; try{st=fs.statSync(CONFIG.ipFile);}catch(e){}
  if(st&&st.isDirectory()){ try{fs.rmdirSync(CONFIG.ipFile);}catch(e){return false;} }
  if(!fs.existsSync(CONFIG.ipFile)){ fs.writeFileSync(CONFIG.ipFile,'# 每行: 纯IP / 域名 / http(s)列表源\n'); }
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
function saveData(){ try{ fs.mkdirSync(CONFIG.dataDir,{recursive:true});
  const tmp=CONFIG.dataFile+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify({history:state.history,nodes:state.nodes}));
  fs.renameSync(tmp, CONFIG.dataFile); }catch(e){} }
async function mapLimit(items,limit,fn){ const res=new Array(items.length); let i=0;
  const workers=Array.from({length:Math.min(limit,items.length||1)},async()=>{ while(i<items.length){ const idx=i++; res[idx]=await fn(items[idx]); } });
  await Promise.all(workers); return res; }
function timeoutPromise(ms){ return new Promise((_,rj)=>setTimeout(()=>rj(new Error('t')),ms)); }
async function fetchList(url){ const safe=url.replace(/'/g,"'\\''");
  const out=await runCurl(`curl -4 -k -s --noproxy '*' --compressed -m 20 '${safe}'`,25000);
  if(out&&out.trim()){ if(out.length>2*1024*1024)return out.slice(0,2*1024*1024); return out; }
  return ''; }

// ==================== CF CIDR 分类 ====================
const CF_SUPERNETS = ['103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','104.16.0.0/12','108.162.192.0/18',
  '131.0.72.0/22','141.101.64.0/18','162.158.0.0/15','172.64.0.0/13','173.245.48.0/20',
  '188.114.96.0/20','190.93.240.0/20','197.234.240.0/22','198.41.128.0/17'];
function ipToInt(ip){ const p=ip.split('.').map(Number); return (p[0]*16777216 + p[1]*65536 + p[2]*256 + p[3]) >>> 0; }
function cidrMatch(ip,cidr){ const [n,bits]=cidr.split('/'); const b=+bits;
  const mask=b===0?0:(0xFFFFFFFF<<(32-b))>>>0;
  return (ipToInt(ip)&mask)===(ipToInt(n)&mask); }
async function refreshCfCidrs(force){
  if(!force && state.cfCidrs.length && (Date.now()-state.cfCidrsAt)<12*3600*1000) return;
  let live=[];
  try{ const res=await fetch('https://www.cloudflare.com/ips-v4');
    if(res.ok){ const txt=await res.text();
      live=txt.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s)); } }
  catch(e){ log('⚠️ 获取CF IP段失败，使用内置超网: '+e.message); }
  state.cfCidrs=[...new Set([...CF_SUPERNETS, ...live])];
  state.cfCidrsAt=Date.now();
  for(const id of Object.keys(state.nodes)) state.nodes[id].kind=classifyIp(state.nodes[id].ip);
  log('🌐 CF IP分类集合已更新: '+state.cfCidrs.length+' 条');
}
function classifyIp(ip){ if(!ip||!net.isIPv4(ip)||!state.cfCidrs.length)return 'unknown';
  return state.cfCidrs.some(c=>cidrMatch(ip,c))?'cf':'proxy'; }

// ==================== 🌟 迁移容错(ids/ips 兼容) ====================
function migrateNodes(disc){
  const nodes={};
  for(const key of Object.keys(disc||{})){ const e=disc[key]||{};
    const idsObj=e.ids||e.ips||{};
    const kind=e.kind||(key.startsWith('pure:')?'pure':key.startsWith('url:')?'url':'dom');
    for(const id of Object.keys(idsObj)){ try{ const [ip,port]=splitId(id); if(!net.isIPv4(ip))continue;
      if(!nodes[id])nodes[id]={id,ip,port,firstSource:{kind,name:e.name||id}}; }catch(err){} } }
  for(const id of Object.keys(state.history)){ try{ const [ip,port]=splitId(id); if(!net.isIPv4(ip))continue;
    const hist=state.history[id]; const firstSeen=hist&&hist.length?hist[0].t:Date.now();
    if(!nodes[id])nodes[id]={id,ip,port,firstSource:{kind:'pure',name:id}};
    if(!nodes[id].firstSeen)nodes[id].firstSeen=firstSeen; }catch(err){} }
  for(const id of Object.keys(nodes)){ if(!nodes[id].firstSeen)nodes[id].firstSeen=Date.now(); }
  return nodes;
}
function loadData(){
  try{ const d=JSON.parse(fs.readFileSync(CONFIG.dataFile,'utf8'));
    if(d&&d.history)state.history=d.history;
    if(d&&d.nodes&&Object.keys(d.nodes).length){ state.nodes=d.nodes; }
    else { state.nodes=migrateNodes(d&&d.disc?d.disc:{}); }
  }catch(e){ state.nodes=migrateNodes({}); }
  loadGraveyard();
  log('💾 加载完成: 历史节点 '+Object.keys(state.history).length+' / 注册节点 '+Object.keys(state.nodes).length);
}

// ==================== 🌟 发现(逐行容错+计数) ====================
async function discover(){
  await refreshCfCidrs(false);
  const now=Date.now();
  let lines=[]; try{lines=fs.readFileSync(CONFIG.ipFile,'utf8').split(/\r?\n/);}catch(e){ log('⚠️ 读取ip.txt失败: '+e.message); }
  const present=new Set(); const domJobs=[],urlJobs=[]; const adds=[]; let valid=0;
  for(const raw of lines){ try{ const line=raw.split('#')[0].trim(); if(!line)continue;
    const key=sourceKeyForLine(line); if(!key||present.has(key))continue; present.add(key); valid++;
    if(key.startsWith('pure:')){ const id=key.slice(5); adds.push({id,kind:'pure',name:id}); }
    else if(key.startsWith('dom:')){ const hp=key.slice(4); const li=hp.lastIndexOf(':');
      domJobs.push({host:hp.slice(0,li),port:+hp.slice(li+1),kind:'dom',name:hp.slice(0,li)}); }
    else { urlJobs.push({url:key.slice(4),kind:'url',name:key.slice(4)}); } }catch(err){} }
  state.ipLineCount=valid;
  await mapLimit(domJobs,20,async j=>{ let ips=[]; try{ips=await Promise.race([dnsPromises.resolve4(j.host),timeoutPromise(4000)]);}catch(e){}
    (ips||[]).filter(ip=>net.isIPv4(ip)).forEach(ip=>adds.push({id:ip+':'+j.port,kind:j.kind,name:j.name})); });
  await mapLimit(urlJobs,8,async j=>{ const content=await fetchList(j.url);
    for(const rl of content.split(/\r?\n/)){ const l=rl.split('#')[0].trim(); if(!l||isUrl(l))continue;
      const r=parseLine(l); if(!r||!net.isIPv4(r.host))continue; adds.push({id:r.host+':'+r.port,kind:j.kind,name:j.name}); } });
  let added=0;
  for(const a of adds){ try{ if(state.blocked[a.id])continue; if(state.nodes[a.id])continue;
    const [ip,port]=splitId(a.id);
    state.nodes[a.id]={id:a.id,ip,port,firstSeen:now,firstSource:{kind:a.kind,name:a.name},kind:classifyIp(ip)}; added++; }catch(err){} }
  return added;
}

// ==================== 官方探针 ====================
async function probeLatency(u){
  const point={t:Date.now(),ok:false,off:penaltySegs(),colo:null,loc:null,exitIp:null,failReason:null};
  if(!u.ip){ point.failReason='无有效IP'; return point; }
  const probe=splitProbe(CONFIG.probeUrl); const ms=CONFIG.timeoutSec*1000;
  const latCmd=`curl -4 -k -s --noproxy '*' --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec+2} 'https://${probe.host}:${u.port}${probe.path}'`;
  let lat=null,lastCode=0,lastOut=null;
  for(let a=0;a<2;a++){ const r=await runCurl2(latCmd,ms+2500); lastCode=r.code; lastOut=r.out; lat=parseCurlJson(r.out);
    if(lat&&lat.http&&String(lat.http)!=='000')break; }
  if(lat && lat.http === 200){
    const info=parseTrace(lastOut.trim().split('\n').slice(0,-1).join('\n'));
    if(!info.colo && !info.fl){ point.failReason='官方探针返回非 CF 内容 (不具备反代能力)'; return point; }
    point.ok=true; point.off=buildSegs(lat);
    point.colo=info.colo||null; point.loc=info.loc||null; point.exitIp=info.ip||null; }
  else { point.failReason=`不具备反代CF能力 (${curlFailText(lastCode)})`; }
  return point;
}

// ==================== 自定义探针 ====================
async function probeCustoms(u){
  const results=[]; const ms=CONFIG.timeoutSec*1000;
  for(const p of CONFIG.customProbes){
    try{
      const cu=new URL(p.url); const expectCode=String(p.expect||'200');
      const cmd=`curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${cu.hostname}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec+2} 'https://${cu.hostname}:${u.port}${cu.pathname}${cu.search}'`;
      const r=await runCurl2(cmd,ms+2500);
      const res=parseCurlJson(r.out);
      const code=res?String(res.http):'000';
      let ok=false,failReason=null;
      if(code==='000'&&r.code!==0)failReason=`连接失败(${curlFailText(r.code)})`;
      else if(code!==expectCode)failReason=`预期${expectCode}实际${code}`;
      else ok=true;
      results.push({host:cu.hostname,expect:expectCode,code,ok,failReason,segs: ok?buildSegs(res):penaltySegs()});
    }catch(e){ results.push({host:String(p.url),expect:p.expect,code:'000',ok:false,failReason:'配置错误',segs:penaltySegs()}); }
  }
  return results;
}

function pushHistory(id,point){ if(!state.history[id])state.history[id]=[];
  state.history[id].push(point);
  if(state.history[id].length>600)state.history[id]=state.history[id].slice(-600); }

// ==================== 流水线 ====================
async function runCycle(){
  if(state.checking)return; state.checking=true; state.abort=false;
  try{ const added=await discover(); if(added)log('🆕 发现 '+added+' 个新节点');
    state.units=Object.values(state.nodes);
    const total=state.units.length;
    state.progress={tested:0,total};
    log('🔄 开始检测 '+total+' 个节点（并发 '+CONFIG.concurrency+'）');
    const queue=[...state.units];
    const workers=Array.from({length:Math.min(CONFIG.concurrency,Math.max(queue.length,1))},async()=>{
      while(queue.length){
        if(state.abort)return;
        const u=queue.shift();
        try{
          const lat=await probeLatency(u);
          let cusResults;
          if(lat.ok && CONFIG.customProbes.length){ cusResults=await probeCustoms(u); }
          else { cusResults=CONFIG.customProbes.map(p=>{ try{const cu=new URL(p.url);return{host:cu.hostname,ok:false,segs:penaltySegs()};}catch(e){return{host:String(p.url),ok:false,segs:penaltySegs()};} }); }
          const allList=[lat.off, ...cusResults.map(r=>r.segs)];
          const all=avgSegs(allList);
          const online = CONFIG.customProbes.length ? (lat.ok && cusResults.some(r=>r.ok)) : lat.ok;
          const point={t:Date.now(),ok:online,off:lat.off,cus:cusResults,all:all,total:all?all.total:null,
            colo:lat.colo,loc:lat.loc,exitIp:lat.exitIp,
            failReason: !lat.ok ? lat.failReason : (!online ? ('自定义源站均未达标: '+cusResults.map(r=>`${r.host}(${r.failReason||'失败'})`).join(', ')) : null)};
          if(!(state.abort && point.ok)){
            pushHistory(u.id,point); state.progress.tested++;
            log((point.ok?'✅ ':'❌ ')+u.id+(point.ok?(' 总='+point.total+'ms'):(' 失败: '+point.failReason)));
          }
        }catch(e){ log('⚠️ '+u.id+' 检测异常: '+e.message); state.progress.tested++; }
      } });
    await Promise.all(workers);
    if(state.abort)log('⏹ 检测已中断，完成 '+state.progress.tested+'/'+total);
    state.lastCycle=Date.now();
    const online=state.units.filter(u=>{const h=state.history[u.id];return h&&h.length&&h[h.length-1].ok;}).length;
    const quality=state.units.filter(u=>computeQuality(state.history[u.id]).quality).length;
    log('🏁 检测完成：在线 '+online+' / 优质 '+quality+' / 总数 '+total);
    await cleanGraveyard();
    saveData();
    if(CONFIG.github.auto)autoUpload().catch(e=>{state.github.lastError=e.message;log('⚠️ 自动上传失败: '+e.message);});
  }finally{ state.checking=false; state.abort=false; }
}

// ==================== 质量判定 ====================
function computeQuality(points){
  const recent=(points||[]).slice(-CONFIG.qualityWindow);
  if(!recent.length)return{quality:false,rate:0,avgAll:null,avgProbes:null,samples:0};
  const oks=recent.filter(p=>p.ok); const rate=oks.length/recent.length;
  const avgOf=g=>{ const v=recent.map(g).filter(x=>x!=null&&isFinite(x)); return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):null; };
  const avgAll={ total:avgOf(p=>p.all&&p.all.total), tcp:avgOf(p=>p.all&&p.all.tcp), tls:avgOf(p=>p.all&&p.all.tls), src:avgOf(p=>p.all&&p.all.src) };
  const maxCus=recent.reduce((m,p)=>Math.max(m,(p.cus||[]).length),0);
  const cusAvgs=[]; for(let i=0;i<maxCus;i++) cusAvgs.push(avgOf(p=>p.cus&&p.cus[i]&&p.cus[i].segs?p.cus[i].segs.total:null));
  const avgProbes={ off:avgOf(p=>p.off&&p.off.total), cus:cusAvgs };
  const avgTotal=avgAll.total;
  const enough=recent.length>=CONFIG.qualityWindow;
  const latOk=CONFIG.maxTotalMs<=0||(avgTotal!=null&&avgTotal<=CONFIG.maxTotalMs);
  return{quality:enough&&rate>=CONFIG.qualityRate&&latOk,rate,avgAll,avgProbes,samples:recent.length};
}

// ==================== 清理 ====================
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

// ==================== GitHub ====================
function formatNodeLine(ipPort,region,q){
  const total=q.avgAll&&q.avgAll.total!=null?q.avgAll.total+'ms':'?ms';
  const tls=q.avgAll&&q.avgAll.tls!=null?q.avgAll.tls+'ms':'?ms';
  return `${ipPort}#${region} | ${total} | ${tls}`; }
function buildUploadData(){
  const seen=new Map();
  state.units.filter(u=>u.ip).forEach(u=>{ const hist=state.history[u.id]||[]; const latest=hist.length?hist[hist.length-1]:null;
    const q=computeQuality(hist); if(!q.quality)return;
    const k=u.ip+':'+u.port; const cur=seen.get(k);
    if(!cur||((q.avgAll&&q.avgAll.total)??99999)<((cur.q.avgAll&&cur.q.avgAll.total)??99999))seen.set(k,{u,q,latest}); });
  const nodes=[...seen.values()].sort((a,b)=>((a.q.avgAll&&a.q.avgAll.total)??99999)-((b.q.avgAll&&b.q.avgAll.total)??99999));
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

// ==================== API(容错 buildState) ====================
function buildState(){
  try{ state.units=Object.values(state.nodes);
    const items=[];
    for(const u of state.units){ try{
      const hist=state.history[u.id]||[]; const latest=hist.length?hist[hist.length-1]:null;
      items.push({ id:u.id,label:u.id,ip:u.ip,port:u.port,ipKind:u.kind||classifyIp(u.ip),
        srcKind:(u.firstSource&&u.firstSource.kind)||'pure', srcName:(u.firstSource&&u.firstSource.name)||u.id, firstSeen:u.firstSeen||null,
        colo:latest?latest.colo:null,loc:latest?latest.loc:null,exitIp:latest?latest.exitIp:null,
        latest,quality:computeQuality(hist),
        recent:hist.slice(-40).map(p=>({t:p.t,ok:!!p.ok,total:p.total,off:p.off&&p.off.total,cus:(p.cus||[]).map(r=>r&&r.segs?r.segs.total:null)})) });
    }catch(err){} }
    const online=items.filter(i=>i.latest&&i.latest.ok).length; const quality=items.filter(i=>i.quality.quality).length;
    return{ version:VERSION, checking:state.checking,progress:{...state.progress},lastCycle:state.lastCycle,intervalSec:CONFIG.intervalSec,
      ipLineCount:state.ipLineCount, nodeCount:state.units.length,
      config:{maxTotalMs:CONFIG.maxTotalMs,qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate,autoCleanDays:CONFIG.autoCleanDays,customProbes:CONFIG.customProbes,concurrency:CONFIG.concurrency},
      github:{configured:!!(CONFIG.github.token&&CONFIG.github.repo),auto:CONFIG.github.auto,lastUpload:state.github.lastUpload,lastError:state.github.lastError,uploadIntervalMin:CONFIG.github.uploadIntervalMin},
      summary:{total:items.length,online,quality,offline:items.length-online},items };
  }catch(e){ return{version:VERSION,checking:false,progress:{tested:0,total:0},lastCycle:null,intervalSec:CONFIG.intervalSec,ipLineCount:state.ipLineCount,nodeCount:0,
    config:{maxTotalMs:0,qualityWindow:10,qualityRate:1,autoCleanDays:7,customProbes:[],concurrency:50},
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
    if(p=='/api/abort'&&req.method==='POST'){ if(state.checking){state.abort=true;log('⏹ 收到中断请求');} return json({ok:true}); }
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
  log(`🚀 服务启动 (${VERSION} 自愈加载)`);
  await refreshCfCidrs(true);
  log(`📄 ip.txt 有效行: ${state.ipLineCount} · 启动时注册节点: ${Object.keys(state.nodes).length}`);
  await discover();
  log(`🧩 发现后节点: ${Object.keys(state.nodes).length}`);
  state.units=Object.values(state.nodes); runCycle(); restartTimer(); restartGithubTimer();
});