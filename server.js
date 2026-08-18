/**
 * Proxy Monitor · Nova (v50) —— 从零重构
 * 不变量:
 *  I1 显示集合=本轮来源∪上轮−blocked, 每轮派生不存盘 → 总数永不漂移
 *  I2 自动清理只剪"无引用+长期离线"孤儿history, 不碰显示/不新增屏蔽
 *  I3 仅手动删除屏蔽; 仅清空记录解除; 手动删纯IP同删ip.txt行
 *  I4 四段恒等(总=TCP+TLS+源站); 失败惩罚P; 窗口平均
 *  I5 持久化原子(tmp+rename); 读坏即空; 启动打印自检
 */
const http=require('http'),fs=require('fs'),path=require('path');
const {exec}=require('child_process');const dnsPromises=require('dns').promises;const net=require('net');
const VERSION='v50';

const CONFIG={
  port:+(process.env.PORT||8787), ipFile:process.env.IP_FILE||'/app/config/ip.txt',
  dataDir:process.env.DATA_DIR||'/app/data', intervalSec:+(process.env.INTERVAL_SEC||60),
  probeUrl:process.env.PROBE_URL||'https://www.cloudflare.com/cdn-cgi/trace',
  customProbes:[], timeoutSec:+(process.env.TIMEOUT_SEC||5), concurrency:+(process.env.CONCURRENCY||50),
  autoCleanDays:parseFloat(process.env.AUTO_CLEAN_DAYS||7), maxTotalMs:parseFloat(process.env.MAX_TOTAL_MS||0),
  qualityWindow:+(process.env.QUALITY_WINDOW||10), qualityRate:parseFloat(process.env.QUALITY_RATE||1),
  github:{token:process.env.GITHUB_TOKEN||'',repo:process.env.GITHUB_REPO||'',path:process.env.GITHUB_PATH||'proxyip',
    branch:process.env.GITHUB_BRANCH||'main',auto:process.env.GITHUB_AUTO_UPLOAD==='true',
    uploadIntervalMin:+(process.env.GITHUB_UPLOAD_INTERVAL_MIN||0)},
};
CONFIG.dataFile=path.join(CONFIG.dataDir,'history.json');
CONFIG.configFile=path.join(CONFIG.dataDir,'config.json');
CONFIG.graveyardFile=path.join(CONFIG.dataDir,'graveyard.json');

const state={candidates:[],prev:new Map(),history:{},blocked:{},graveyard:{list:[]},
  cfCidrs:[],cfCidrsAt:0,ipLineCount:0,lastCycle:null,checking:false,abort:false,
  progress:{tested:0,total:0},logs:[],github:{lastUpload:null,lastError:null},lastUploadedContent:''};
let cycleTimer=null,githubTimer=null;
const log=m=>{state.logs.push({t:Date.now(),m});if(state.logs.length>400)state.logs=state.logs.slice(-400);};

/* ---------- 配置 ---------- */
const num=(v,d)=>{const n=parseFloat(v);return isFinite(n)?n:d;};
function setConfig(o){if(!o)return;
  if(o.intervalSec!=null)CONFIG.intervalSec=Math.max(5,Math.round(num(o.intervalSec,CONFIG.intervalSec)));
  if(o.timeoutSec!=null)CONFIG.timeoutSec=Math.max(1,Math.round(num(o.timeoutSec,CONFIG.timeoutSec)));
  if(o.concurrency!=null)CONFIG.concurrency=Math.max(1,Math.round(num(o.concurrency,CONFIG.concurrency)));
  if(o.autoCleanDays!=null)CONFIG.autoCleanDays=Math.max(0,num(o.autoCleanDays,0));
  if(o.maxTotalMs!=null)CONFIG.maxTotalMs=num(o.maxTotalMs,0);
  if(o.probeUrl)CONFIG.probeUrl=String(o.probeUrl);
  if(o.qualityWindow!=null)CONFIG.qualityWindow=Math.max(1,Math.round(num(o.qualityWindow,CONFIG.qualityWindow)));
  if(o.qualityRate!=null)CONFIG.qualityRate=Math.min(1,Math.max(0,num(o.qualityRate,CONFIG.qualityRate)));
  if(Array.isArray(o.customProbes))CONFIG.customProbes=o.customProbes.filter(p=>p&&p.url).map(p=>({url:String(p.url),expect:String(p.expect||'200')}));
  if(o.github){const g=o.github;
    if(g.token!=null)CONFIG.github.token=String(g.token);if(g.repo!=null)CONFIG.github.repo=String(g.repo);
    if(g.path!=null)CONFIG.github.path=String(g.path)||'proxyip';if(g.branch!=null)CONFIG.github.branch=String(g.branch)||'main';
    if(g.auto!=null)CONFIG.github.auto=(g.auto===true||g.auto==='true');
    if(g.uploadIntervalMin!=null)CONFIG.github.uploadIntervalMin=Math.max(0,Math.round(num(g.uploadIntervalMin,0)));}
  restartGithubTimer();}
const publicConfig=()=>({intervalSec:CONFIG.intervalSec,timeoutSec:CONFIG.timeoutSec,concurrency:CONFIG.concurrency,
  autoCleanDays:CONFIG.autoCleanDays,maxTotalMs:CONFIG.maxTotalMs,probeUrl:CONFIG.probeUrl,customProbes:CONFIG.customProbes,
  qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate,github:{...CONFIG.github}});
const persistConfig=()=>{try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.configFile,JSON.stringify(publicConfig(),null,2));}catch(e){}};
const restartTimer=()=>{if(cycleTimer)clearInterval(cycleTimer);cycleTimer=setInterval(runCycle,CONFIG.intervalSec*1000);};
function restartGithubTimer(){if(githubTimer)clearInterval(githubTimer);const m=CONFIG.github.uploadIntervalMin;
  if(m>0&&CONFIG.github.token&&CONFIG.github.repo)githubTimer=setInterval(()=>{log('⏰ 定时触发 GitHub 上传');uploadGithub().catch(e=>{state.github.lastError=e.message;log('⚠️ 定时上传失败: '+e.message);});},m*60000);}

/* ---------- 工具 ---------- */
const splitProbe=u=>{try{const x=new URL(u);return{host:x.hostname,path:x.pathname+x.search};}catch(e){return{host:'www.cloudflare.com',path:'/cdn-cgi/trace'};}};
const isUrl=s=>/^https?:\/\//i.test(s);
function parseLine(raw){let host=raw,port=443;
  if(raw.startsWith('[')){const m=raw.match(/^\[([^\]]+)\](?::(\d+))?$/);if(!m)return null;host=m[1];if(m[2])port=+m[2];}
  else if(raw.includes(':')&&raw.split(':').length===2&&/^\d+$/.test(raw.split(':')[1])){const p=raw.split(':');host=p[0];port=+p[1];}
  else if(raw.includes(':'))host=raw;
  return{host,port};}
function sourceKeyForLine(line){if(isUrl(line))return 'url:'+line;const r=parseLine(line);if(!r)return null;
  if(net.isIPv4(r.host))return 'pure:'+r.host+':'+r.port;if(net.isIPv6(r.host))return null;return 'dom:'+r.host+':'+r.port;}
const splitId=id=>{const i=id.lastIndexOf(':');return[id.slice(0,i),+id.slice(i+1)];};
const runCurl=(c,ms)=>new Promise(r=>exec(c,{timeout:ms,maxBuffer:4*1024*1024},(e,o)=>r(e?null:o)));
const runCurl2=(c,ms)=>new Promise(r=>exec(c,{timeout:ms,maxBuffer:4*1024*1024},(e,o)=>r({out:e?null:o,code:e?(e.killed?-1:e.code):0})));
const curlFailText=c=>c===28?'超时':c===7?'连接被拒':(c===35||c===60||c===61)?'TLS错误':c===-1?'进程超时/被杀':c===6?'DNS解析失败':'curl错误 '+c;
const parseCurlJson=o=>{if(!o)return null;const l=o.trim().split('\n');try{return JSON.parse(l[l.length-1]);}catch(e){return null;}};
const parseTrace=t=>{const p={};String(t||'').replace(/\r/g,'').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)p[l.slice(0,i).trim()]=l.slice(i+1).trim();});return p;};
const readBody=q=>new Promise(r=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>r(d));});
/* 四段: 恒等 */
function buildSegs(w){if(!w)return null;const tcp=Math.max(0,Math.round((w.tcp||0)*1000));
  const tls=Math.max(0,Math.round(((w.tls||0)-(w.tcp||0))*1000));const total=Math.max(0,Math.round((w.ttfb||0)*1000));
  return{tcp,tls,total,src:Math.max(0,total-tcp-tls)};}
function penaltySegs(){const P=(CONFIG.timeoutSec+2)*1000,t=Math.round(P/3);return{tcp:t,tls:t,src:Math.max(0,P-2*t),total:P};}
function avgSegs(list){if(!list||!list.length)return null;const avg=f=>Math.round(list.reduce((s,x)=>s+f(x),0)/list.length);
  const tcp=avg(x=>x.tcp),tls=avg(x=>x.tls),total=avg(x=>x.total);return{tcp,tls,total,src:Math.max(0,total-tcp-tls)};}
function ensureIpFile(){try{fs.mkdirSync(path.dirname(CONFIG.ipFile),{recursive:true});let st=null;try{st=fs.statSync(CONFIG.ipFile);}catch(e){}
  if(st&&st.isDirectory()){try{fs.rmdirSync(CONFIG.ipFile);}catch(e){return false;}}
  if(!fs.existsSync(CONFIG.ipFile))fs.writeFileSync(CONFIG.ipFile,'# 每行: 纯IP / 域名 / http(s)列表源\n');return true;}catch(e){return false;}}
const persistGraveyard=()=>{try{fs.writeFileSync(CONFIG.graveyardFile,JSON.stringify({list:state.graveyard.list,blocked:state.blocked}));}catch(e){}};
function loadGraveyard(){try{const d=JSON.parse(fs.readFileSync(CONFIG.graveyardFile,'utf8'));
  if(Array.isArray(d)){state.graveyard.list=d;state.blocked={};}else{state.graveyard.list=d.list||[];state.blocked=d.blocked||{};}}
  catch(e){state.graveyard.list=[];state.blocked={};}}
const capGraveyard=()=>{if(state.graveyard.list.length>1000)state.graveyard.list=state.graveyard.list.slice(-1000);};
function offlineSince(id){const h=state.history[id]||[];for(let i=h.length-1;i>=0;i--)if(h[i].ok)return h[i].t;return h.length?h[0].t:Date.now();}
const pushGrave=(label,id,lastOnline,mode,reason)=>state.graveyard.list.push({id,label,removedAt:Date.now(),lastOnlineAt:lastOnline,mode,reason});
const saveData=()=>{try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});const t=CONFIG.dataFile+'.tmp';
  fs.writeFileSync(t,JSON.stringify({history:state.history}));fs.renameSync(t,CONFIG.dataFile);}catch(e){}};
async function mapLimit(items,limit,fn){const res=new Array(items.length);let i=0;
  const w=Array.from({length:Math.min(limit,items.length||1)},async()=>{while(i<items.length){const idx=i++;res[idx]=await fn(items[idx]);}});
  await Promise.all(w);return res;}
const timeoutPromise=ms=>new Promise((_,rj)=>setTimeout(()=>rj(new Error('t')),ms));
async function fetchList(url){const safe=url.replace(/'/g,"'\\''");const out=await runCurl(`curl -4 -k -s --noproxy '*' --compressed -m 20 '${safe}'`,25000);
  if(out&&out.trim())return out.length>2*1024*1024?out.slice(0,2*1024*1024):out;return '';}

/* ---------- CF CIDR(只标识) ---------- */
const CF_SUPERNETS=['103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','104.16.0.0/12','108.162.192.0/18','131.0.72.0/22','141.101.64.0/18','162.158.0.0/15','172.64.0.0/13','173.245.48.0/20','188.114.96.0/20','190.93.240.0/20','197.234.240.0/22','198.41.128.0/17'];
const ipToInt=ip=>{const p=ip.split('.').map(Number);return(p[0]*16777216+p[1]*65536+p[2]*256+p[3])>>>0;};
function cidrMatch(ip,cidr){const[n,b]=cidr.split('/');const mask=+b===0?0:(0xFFFFFFFF<<(32-+b))>>>0;return(ipToInt(ip)&mask)===(ipToInt(n)&mask);}
async function refreshCfCidrs(force){if(!force&&state.cfCidrs.length&&(Date.now()-state.cfCidrsAt)<12*3600*1000)return;let live=[];
  try{const r=await fetch('https://www.cloudflare.com/ips-v4');if(r.ok){const t=await r.text();live=t.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));}}catch(e){log('⚠️ 获取CF IP段失败,用内置超网');}
  state.cfCidrs=[...new Set([...CF_SUPERNETS,...live])];state.cfCidrsAt=Date.now();log('🌐 CF分类集合: '+state.cfCidrs.length+' 条');}
const classifyIp=ip=>(!ip||!net.isIPv4(ip)||!state.cfCidrs.length)?'unknown':(state.cfCidrs.some(c=>cidrMatch(ip,c))?'cf':'proxy');

/* ---------- 加载(零迁移) ---------- */
function loadData(){try{const d=JSON.parse(fs.readFileSync(CONFIG.dataFile,'utf8'));if(d&&d.history&&typeof d.history==='object')state.history=d.history;}catch(e){state.history={};}
  loadGraveyard();log('💾 加载: 历史IP '+Object.keys(state.history).length+' / 屏蔽 '+Object.keys(state.blocked).length);}

/* ---------- 发现(派生候选) ---------- */
async function discover(){await refreshCfCidrs(false);
  let lines=[];try{lines=fs.readFileSync(CONFIG.ipFile,'utf8').split(/\r?\n/);}catch(e){log('⚠️ 读ip.txt失败: '+e.message);}
  const present=new Set(),domJobs=[],urlJobs=[],cur=new Map();let valid=0;
  for(const raw of lines){try{const line=raw.split('#')[0].trim();if(!line)continue;const key=sourceKeyForLine(line);if(!key||present.has(key))continue;present.add(key);valid++;
    if(key.startsWith('pure:'))cur.set(key.slice(5),{srcKind:'pure',srcName:key.slice(5)});
    else if(key.startsWith('dom:')){const hp=key.slice(4),li=hp.lastIndexOf(':');domJobs.push({host:hp.slice(0,li),port:+hp.slice(li+1)});}
    else urlJobs.push({url:key.slice(4)});}catch(e){}}
  state.ipLineCount=valid;
  await mapLimit(domJobs,20,async j=>{let ips=[];try{ips=await Promise.race([dnsPromises.resolve4(j.host),timeoutPromise(4000)]);}catch(e){}
    (ips||[]).filter(ip=>net.isIPv4(ip)).forEach(ip=>{const id=ip+':'+j.port;if(!cur.has(id))cur.set(id,{srcKind:'dom',srcName:j.host});});});
  await mapLimit(urlJobs,8,async j=>{const c=await fetchList(j.url);for(const rl of c.split(/\r?\n/)){const l=rl.split('#')[0].trim();if(!l||isUrl(l))continue;
    const r=parseLine(l);if(!r||!net.isIPv4(r.host))continue;const id=r.host+':'+r.port;if(!cur.has(id))cur.set(id,{srcKind:'url',srcName:j.url});}});
  for(const id of[...cur.keys()])if(state.blocked[id])cur.delete(id);
  return cur;}

/* ---------- 探针 ---------- */
async function probeLatency(u){const point={t:Date.now(),ok:false,off:penaltySegs(),colo:null,loc:null,exitIp:null,failReason:null};
  if(!u.ip){point.failReason='无有效IP';return point;}
  const probe=splitProbe(CONFIG.probeUrl),ms=CONFIG.timeoutSec*1000;
  const cmd=`curl -4 -k -s --noproxy '*' --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec+2} 'https://${probe.host}:${u.port}${probe.path}'`;
  let lat=null,code=0,out=null;
  for(let a=0;a<2;a++){const r=await runCurl2(cmd,ms+2500);code=r.code;out=r.out;lat=parseCurlJson(r.out);if(lat&&lat.http&&String(lat.http)!=='000')break;}
  if(lat&&lat.http===200){const info=parseTrace(out.trim().split('\n').slice(0,-1).join('\n'));
    if(!info.colo&&!info.fl){point.failReason='官方探针返回非CF内容(不具备反代能力)';return point;}
    point.ok=true;point.off=buildSegs(lat);point.colo=info.colo||null;point.loc=info.loc||null;point.exitIp=info.ip||null;}
  else point.failReason=`不具备反代CF能力(${curlFailText(code)})`;
  return point;}
async function probeCustoms(u){const results=[],ms=CONFIG.timeoutSec*1000;
  for(const p of CONFIG.customProbes){try{const cu=new URL(p.url),exp=String(p.expect||'200');
    const cmd=`curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${cu.hostname}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec+2} 'https://${cu.hostname}:${u.port}${cu.pathname}${cu.search}'`;
    const r=await runCurl2(cmd,ms+2500),res=parseCurlJson(r.out),code=res?String(res.http):'000';
    let ok=false,fail=null;
    if(code==='000'&&r.code!==0)fail=`连接失败(${curlFailText(r.code)})`;else if(code!==exp)fail=`预期${exp}实际${code}`;else ok=true;
    results.push({host:cu.hostname,expect:exp,code,ok,failReason:fail,segs:ok?buildSegs(res):penaltySegs()});}
  catch(e){results.push({host:String(p.url),expect:p.expect,code:'000',ok:false,failReason:'配置错误',segs:penaltySegs()});}}
  return results;}
const pushHistory=(id,point)=>{if(!state.history[id])state.history[id]=[];state.history[id].push(point);if(state.history[id].length>600)state.history[id]=state.history[id].slice(-600);};

/* ---------- 周期 ---------- */
async function runCycle(){if(state.checking)return;state.checking=true;state.abort=false;
  try{const cur=await discover();
    const union=new Map();for(const[k,v]of state.prev)if(!state.blocked[k])union.set(k,v);
    for(const[k,v]of cur)union.set(k,v);
    state.prev=cur;
    state.candidates=[...union.entries()].map(([id,a])=>{const[ip,port]=splitId(id);return{id,ip,port,srcKind:a.srcKind,srcName:a.srcName,kind:classifyIp(ip)};});
    const total=state.candidates.length;state.progress={tested:0,total};
    log('🔄 检测 '+total+' 节点(并发 '+CONFIG.concurrency+')');
    const queue=[...state.candidates];
    const workers=Array.from({length:Math.min(CONFIG.concurrency,Math.max(queue.length,1))},async()=>{
      while(queue.length){if(state.abort)return;const u=queue.shift();
        try{const lat=await probeLatency(u);
          let cus;
          if(lat.ok&&CONFIG.customProbes.length)cus=await probeCustoms(u);
          else cus=CONFIG.customProbes.map(p=>{try{const c=new URL(p.url);return{host:c.hostname,ok:false,segs:penaltySegs()};}catch(e){return{host:String(p.url),ok:false,segs:penaltySegs()};}});
          const all=avgSegs([lat.off,...cus.map(r=>r.segs)]);
          const online=CONFIG.customProbes.length?(lat.ok&&cus.some(r=>r.ok)):lat.ok;
          const point={t:Date.now(),ok:online,off:lat.off,cus:cus,all,total:all?all.total:null,colo:lat.colo,loc:lat.loc,exitIp:lat.exitIp,
            failReason:!lat.ok?lat.failReason:(!online?('自定义源站均未达标: '+cus.map(r=>`${r.host}(${r.failReason||'失败'})`).join(', ')):null)};
          if(!(state.abort&&point.ok)){pushHistory(u.id,point);state.progress.tested++;
            log((point.ok?'✅ ':'❌ ')+u.id+(point.ok?(' 总='+point.total+'ms'):(' 失败: '+point.failReason)));}}
        catch(e){log('⚠️ '+u.id+' 异常: '+e.message);state.progress.tested++;}}});
    await Promise.all(workers);
    if(state.abort)log('⏹ 中断, 完成 '+state.progress.tested+'/'+total);
    state.lastCycle=Date.now();
    if(CONFIG.autoCleanDays>0){const th=Date.now()-CONFIG.autoCleanDays*24*3600*1000;let n=0;
      for(const id of Object.keys(state.history))if(!union.has(id)&&offlineSince(id)<th){delete state.history[id];n++;}
      if(n)log('🧹 修剪 '+n+' 个无引用长期离线孤儿历史');}
    const online=state.candidates.filter(u=>{const h=state.history[u.id];return h&&h.length&&h[h.length-1].ok;}).length;
    const quality=state.candidates.filter(u=>computeQuality(state.history[u.id]).quality).length;
    log('🏁 在线 '+online+' / 优质 '+quality+' / 总数 '+total);
    saveData();
    if(CONFIG.github.auto)autoUpload().catch(e=>{state.github.lastError=e.message;log('⚠️ 自动上传失败: '+e.message);});
  }finally{state.checking=false;state.abort=false;}}

/* ---------- 质量 ---------- */
function computeQuality(points){const recent=(points||[]).slice(-CONFIG.qualityWindow);
  if(!recent.length)return{quality:false,rate:0,avgAll:null,samples:0};
  const oks=recent.filter(p=>p.ok),rate=oks.length/recent.length;
  const avgOf=g=>{const v=recent.map(g).filter(x=>x!=null&&isFinite(x));return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):null;};
  const avgAll={total:avgOf(p=>p.all&&p.all.total),tcp:avgOf(p=>p.all&&p.all.tcp),tls:avgOf(p=>p.all&&p.all.tls),src:avgOf(p=>p.all&&p.all.src)};
  const enough=recent.length>=CONFIG.qualityWindow;
  const latOk=CONFIG.maxTotalMs<=0||(avgAll.total!=null&&avgAll.total<=CONFIG.maxTotalMs);
  return{quality:enough&&rate>=CONFIG.qualityRate&&latOk,rate,avgAll,samples:recent.length};}

/* ---------- 生命周期 ---------- */
async function removeUnits(ids){let removed=0;const pure=new Set();
  for(const id of ids){if(state.blocked[id])continue;state.blocked[id]=Date.now();pushGrave(id,id,offlineSince(id),'manual','手动删除');delete state.history[id];pure.add(id);removed++;}
  if(removed){try{const t=fs.readFileSync(CONFIG.ipFile,'utf8');
    const kept=t.split(/\r?\n/).filter(l=>{const raw=l.split('#')[0].trim();if(!raw)return true;const k=sourceKeyForLine(raw);return!(k&&k.startsWith('pure:')&&pure.has(k.slice(5)));});
    fs.writeFileSync(CONFIG.ipFile,kept.join('\n'));}catch(e){}
    capGraveyard();persistGraveyard();saveData();log('🗑️ 手动删除 '+removed+' 个(已屏蔽)');}
  return removed;}

/* ---------- GitHub ---------- */
function buildUploadData(){const seen=new Map();
  state.candidates.filter(u=>u.ip).forEach(u=>{const h=state.history[u.id]||[];const latest=h.length?h[h.length-1]:null;const q=computeQuality(h);if(!q.quality)return;
    const k=u.ip+':'+u.port,c=seen.get(k);if(!c||((q.avgAll&&q.avgAll.total)??99999)<((c.q.avgAll&&c.q.avgAll.total)??99999))seen.set(k,{u,q,latest});});
  const nodes=[...seen.values()].sort((a,b)=>((a.q.avgAll&&a.q.avgAll.total)??99999)-((b.q.avgAll&&b.q.avgAll.total)??99999));
  const bodies={'all.txt':[]};
  nodes.forEach(({u,q,latest})=>{const ipPort=`${u.ip}:${u.port}`,region=latest?(latest.loc||latest.colo||'Unknown'):'Unknown';
    const total=q.avgAll&&q.avgAll.total!=null?q.avgAll.total+'ms':'?ms',tls=q.avgAll&&q.avgAll.tls!=null?q.avgAll.tls+'ms':'?ms';
    const line=`${ipPort}#${region} | ${total} | ${tls}`;bodies['all.txt'].push(line);
    const safe=region.toLowerCase().replace(/[^a-z0-9_-]/g,'')||'unknown';if(!bodies[safe+'.txt'])bodies[safe+'.txt']=[];bodies[safe+'.txt'].push(line);});
  return{bodies,count:nodes.length,fingerprint:bodies['all.txt'].join('\n')};}
async function uploadGithub(){const g=CONFIG.github;if(!g.token||!g.repo)throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  const{bodies,count,fingerprint}=buildUploadData();if(!count)throw new Error('当前没有优质节点可上传');
  const headers={'Authorization':`Bearer ${g.token}`,'Accept':'application/vnd.github+json','User-Agent':'proxy-monitor','Content-Type':'application/json'};
  const base=g.path.replace(/\.txt$/,'');
  for(const[fn,lines]of Object.entries(bodies)){const full=`${base}_${fn}`,apiP=full.split('/').map(encodeURIComponent).join('/');
    const api=`https://api.github.com/repos/${g.repo}/contents/${apiP}`;let sha;
    try{const gr=await fetch(`${api}?ref=${g.branch}`,{headers});if(gr.ok)sha=(await gr.json()).sha;else if(gr.status!==404){log(`⚠️ 查询 ${full} 失败`);continue;}}catch(e){continue;}
    const body={message:`chore: update ${fn} (${lines.length} nodes)`,content:Buffer.from(`# ProxyIP quality list (proxy-monitor ${VERSION})\n# updated: ${new Date().toISOString()}\n# nodes: ${lines.length}\n`+lines.join('\n')+'\n','utf8').toString('base64'),branch:g.branch};if(sha)body.sha=sha;
    try{const pr=await fetch(api,{method:'PUT',headers,body:JSON.stringify(body)});if(!pr.ok)log(`⚠️ 上传 ${full} 失败`);}catch(e){}}
  state.github.lastUpload=Date.now();state.github.lastError=null;state.lastUploadedContent=fingerprint;
  log(`📤 已上传 ${count} 个优质节点 (${Object.keys(bodies).length} 文件)`);return{count,fileCount:Object.keys(bodies).length};}
async function autoUpload(){const{fingerprint}=buildUploadData();if(fingerprint===state.lastUploadedContent){log('⏭️ 优质列表未变化,跳过');return;}await uploadGithub();}

/* ---------- API ---------- */
function buildState(){try{const items=state.candidates.map(u=>{const h=state.history[u.id]||[];const latest=h.length?h[h.length-1]:null;
    return{id:u.id,label:u.id,ip:u.ip,port:u.port,ipKind:u.kind||classifyIp(u.ip),srcKind:u.srcKind||'pure',srcName:u.srcName||u.id,
      firstSeen:h.length?h[0].t:null,colo:latest?latest.colo:null,loc:latest?latest.loc:null,exitIp:latest?latest.exitIp:null,
      latest,quality:computeQuality(h),recent:h.slice(-40).map(p=>({t:p.t,ok:!!p.ok,total:p.total,off:p.off&&p.off.total,cus:(p.cus||[]).map(r=>r&&r.segs?r.segs.total:null)}))};});
  const online=items.filter(i=>i.latest&&i.latest.ok).length,quality=items.filter(i=>i.quality.quality).length;
  return{version:VERSION,checking:state.checking,progress:{...state.progress},lastCycle:state.lastCycle,intervalSec:CONFIG.intervalSec,
    ipLineCount:state.ipLineCount,nodeCount:items.length,
    config:{maxTotalMs:CONFIG.maxTotalMs,qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate,autoCleanDays:CONFIG.autoCleanDays,customProbes:CONFIG.customProbes,concurrency:CONFIG.concurrency},
    github:{configured:!!(CONFIG.github.token&&CONFIG.github.repo),auto:CONFIG.github.auto,lastUpload:state.github.lastUpload,lastError:state.github.lastError,uploadIntervalMin:CONFIG.github.uploadIntervalMin},
    summary:{total:items.length,online,quality,offline:items.length-online},items};
  }catch(e){return{version:VERSION,checking:false,progress:{tested:0,total:0},lastCycle:null,intervalSec:CONFIG.intervalSec,ipLineCount:state.ipLineCount,nodeCount:0,
    config:{maxTotalMs:0,qualityWindow:10,qualityRate:1,autoCleanDays:7,customProbes:[],concurrency:50},
    github:{configured:false,auto:false,lastUpload:null,lastError:e.message,uploadIntervalMin:0},summary:{total:0,online:0,quality:0,offline:0},items:[]};}}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost'),p=url.pathname;
  const json=(d,s=200)=>{res.writeHead(s,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(d));};
  try{
    if(p==='/'||p==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')));}
    if(p==='/api/state')return json(buildState());
    if(p==='/api/logs')return json({logs:state.logs});
    if(p==='/api/abort'&&req.method==='POST'){if(state.checking){state.abort=true;log('⏹ 收到中断');}return json({ok:true});}
    if(p==='/api/graveyard'&&req.method==='GET')return json({graveyard:state.graveyard.list});
    if(p==='/api/graveyard/clear'&&req.method==='POST'){state.graveyard.list=[];state.blocked={};persistGraveyard();log('♻️ 清空记录,解除全部屏蔽');return json({ok:true});}
    if(p==='/api/remove'&&req.method==='POST'){const{ids}=JSON.parse(await readBody(req)||'{}');if(!Array.isArray(ids)||!ids.length)return json({ok:false,error:'无有效ID'},400);return json({ok:true,count:await removeUnits(ids)});}
    if(p==='/api/config'&&req.method==='GET')return json(publicConfig());
    if(p==='/api/config'&&req.method==='POST'){setConfig(JSON.parse(await readBody(req)||'{}'));persistConfig();restartTimer();log('🛠️ 配置已更新');runCycle();return json({ok:true,config:publicConfig()});}
    if(p==='/api/ipfile'&&req.method==='GET'){let c='';try{c=fs.readFileSync(CONFIG.ipFile,'utf8');}catch(e){}return json({content:c});}
    if(p==='/api/ipfile'&&req.method==='POST'){const{content}=JSON.parse(await readBody(req)||'{}');if(!ensureIpFile())return json({ok:false,error:'ip.txt被占用为目录'},500);fs.writeFileSync(CONFIG.ipFile,String(content??''));runCycle();return json({ok:true});}
    if(p==='/api/check'&&req.method==='POST'){log('🖱️ 手动触发');runCycle();return json({ok:true});}
    if(p==='/api/upload'&&req.method==='POST'){try{return json({ok:true,...(await uploadGithub())});}catch(e){state.github.lastError=e.message;log('⚠️ 手动上传失败: '+e.message);return json({ok:false,error:e.message},500);}}
    return json({error:'not found'},404);
  }catch(e){return json({error:e.message},500);}});

try{setConfig(JSON.parse(fs.readFileSync(CONFIG.configFile,'utf8')));}catch(e){}
ensureIpFile();loadData();
server.listen(CONFIG.port,async()=>{console.log(`🚀 Proxy Monitor ${VERSION} on :${CONFIG.port}`);
  log(`🚀 启动 (${VERSION} 派生显示+追加历史+显式屏蔽)`);
  await refreshCfCidrs(true);
  const cur=await discover();state.prev=cur;
  state.candidates=[...cur.entries()].map(([id,a])=>{const[ip,port]=splitId(id);return{id,ip,port,srcKind:a.srcKind,srcName:a.srcName,kind:classifyIp(ip)};});
  log(`📄 ip.txt 有效行: ${state.ipLineCount} · 本轮候选: ${state.candidates.length}`);
  runCycle();restartTimer();restartGithubTimer();});