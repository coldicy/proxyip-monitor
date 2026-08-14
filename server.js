/**
 * Proxy Monitor v8
 * 优质判定重构：窗口内【每一次】单独判定达标(成功+TLS≤上限+速度≥下限)，达标率≥阈值才优质(默认100%)
 * 继承：进度/日志/近40次明细/粘性缓存/全IPv4/网页配置/ip.txt自愈/--noproxy
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');

const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || '/app/config/ip.txt',
  dataDir: process.env.DATA_DIR || '/app/data',
  intervalSec: parseInt(process.env.INTERVAL_SEC || '60', 10),
  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
  dnsTtlSec: parseInt(process.env.DNS_TTL_SEC || '300', 10),
  retainHours: parseInt(process.env.RETAIN_HOURS || '168', 10),
  maxTlsMs: parseFloat(process.env.MAX_TLS_MS || '0'),
  minSpeedKBps: parseFloat(process.env.MIN_SPEED_KBPS || '0'),
  qualityWindow: parseInt(process.env.QUALITY_WINDOW || '10', 10),
  qualityRate: parseFloat(process.env.QUALITY_RATE || '1'),   // 🌟 达标率阈值，默认 1 = 每次都必须达标
  github: { token: process.env.GITHUB_TOKEN || '', repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip.txt', branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true' },
};
CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');

const state = { units: [], history: {}, disc: {}, lastCycle: null, checking: false,
  progress: { tested: 0, total: 0 }, logs: [],
  github: { lastUpload: null, lastError: null }, lastUploadedContent: '' };
let cycleTimer = null;

function log(m){ state.logs.push({ t: Date.now(), m: String(m) }); if (state.logs.length > 400) state.logs = state.logs.slice(-400); }

// ==================== 配置 ====================
function setConfig(o){ if(!o)return; const num=(v,d)=>{const n=parseFloat(v);return isFinite(n)?n:d;};
  if(o.intervalSec!=null)CONFIG.intervalSec=Math.max(5,Math.round(num(o.intervalSec,CONFIG.intervalSec)));
  if(o.timeoutSec!=null)CONFIG.timeoutSec=Math.max(1,Math.round(num(o.timeoutSec,CONFIG.timeoutSec)));
  if(o.concurrency!=null)CONFIG.concurrency=Math.max(1,Math.round(num(o.concurrency,CONFIG.concurrency)));
  if(o.dnsTtlSec!=null)CONFIG.dnsTtlSec=Math.max(30,Math.round(num(o.dnsTtlSec,CONFIG.dnsTtlSec)));
  if(o.retainHours!=null)CONFIG.retainHours=Math.max(1,Math.round(num(o.retainHours,CONFIG.retainHours)));
  if(o.probeUrl)CONFIG.probeUrl=String(o.probeUrl);
  if(o.maxTlsMs!=null)CONFIG.maxTlsMs=num(o.maxTlsMs,0);
  if(o.minSpeedKBps!=null)CONFIG.minSpeedKBps=num(o.minSpeedKBps,0);
  if(o.qualityWindow!=null)CONFIG.qualityWindow=Math.max(1,Math.round(num(o.qualityWindow,CONFIG.qualityWindow)));
  if(o.qualityRate!=null)CONFIG.qualityRate=Math.min(1,Math.max(0,num(o.qualityRate,CONFIG.qualityRate)));
  if(o.github){const g=o.github;
    if(g.token!=null)CONFIG.github.token=String(g.token); if(g.repo!=null)CONFIG.github.repo=String(g.repo);
    if(g.path!=null)CONFIG.github.path=String(g.path)||'proxyip.txt'; if(g.branch!=null)CONFIG.github.branch=String(g.branch)||'main';
    if(g.auto!=null)CONFIG.github.auto=(g.auto===true||g.auto==='true'); } }
function publicConfig(){ return { intervalSec:CONFIG.intervalSec, timeoutSec:CONFIG.timeoutSec, concurrency:CONFIG.concurrency,
  dnsTtlSec:CONFIG.dnsTtlSec, retainHours:CONFIG.retainHours, probeUrl:CONFIG.probeUrl, maxTlsMs:CONFIG.maxTlsMs,
  minSpeedKBps:CONFIG.minSpeedKBps, qualityWindow:CONFIG.qualityWindow, qualityRate:CONFIG.qualityRate, github:{...CONFIG.github} }; }
function persistConfig(){ try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.configFile,JSON.stringify(publicConfig(),null,2));}catch(e){} }
function restartTimer(){ if(cycleTimer)clearInterval(cycleTimer); cycleTimer=setInterval(runCycle,CONFIG.intervalSec*1000); }

// ==================== 工具 ====================
function splitProbe(u){try{const x=new URL(u);return{host:x.hostname,path:x.pathname+x.search};}catch(e){return{host:'www.cloudflare.com',path:'/cdn-cgi/trace'};}}
function parseIpFile(){ let text='';try{text=fs.readFileSync(CONFIG.ipFile,'utf8');}catch(e){return[];}
  const out=[];const seen=new Set();
  for(const raw of text.split(/\r?\n/)){ const line=raw.split('#')[0].trim(); if(!line)continue;
    let host=line,port=443;
    if(line.startsWith('[')){const m=line.match(/^\[([^\]]+)\](?::(\d+))?$/);if(!m)continue;host=m[1];if(m[2])port=+m[2];}
    else if(line.split(':').length===2&&/^\d+$/.test(line.split(':')[1])){host=line.split(':')[0];port=+line.split(':')[1];}
    else if(line.includes(':')){host=line;}
    const id=host+':'+port; if(seen.has(id))continue; seen.add(id); out.push({host,port,label:line}); }
  return out; }
function runCurl(c,ms){return new Promise(r=>exec(c,{timeout:ms,maxBuffer:1024*1024},(e,o)=>r(e?null:o)));}
function parseCurlJson(o){if(!o)return null;const l=o.trim().split('\n');try{return JSON.parse(l[l.length-1]);}catch(e){return null;}}
function parseTrace(t){const p={};String(t||'').replace(/\r/g,'').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)p[l.slice(0,i).trim()]=l.slice(i+1).trim();});return p;}
function readBody(q){return new Promise(r=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>r(d));});}

// ==================== ip.txt 自愈 ====================
function ensureIpFile(){
  try{
    fs.mkdirSync(path.dirname(CONFIG.ipFile),{recursive:true});
    let st=null; try{st=fs.statSync(CONFIG.ipFile);}catch(e){}
    if(st&&st.isDirectory()){ try{fs.rmdirSync(CONFIG.ipFile);}catch(e){
      console.error('⚠️ '+CONFIG.ipFile+' 是非空目录，请在宿主机 rm -rf config/ip.txt 后重启'); return false; } }
    if(!fs.existsSync(CONFIG.ipFile)){
      fs.writeFileSync(CONFIG.ipFile,'# 每行一个节点：ip:port 或 域名:port（不写端口默认443）\n# 1.2.3.4:443\n# cdn.example.com:8443\n');
      console.log('📄 已自动创建示例 ip.txt'); }
    return true;
  }catch(e){ console.error('ensureIpFile error:',e.message); return false; }
}

// ==================== 粘性单元构建 ====================
async function refreshUnits(){
  const now=Date.now(); const targets=parseIpFile(); const map=new Map(); const seenKeys=new Set();
  for(const t of targets){
    if(net.isIPv4(t.host)){ map.set(t.host+':'+t.port,{id:t.host+':'+t.port,ip:t.host,port:t.port,host:t.host,label:t.label,isDomain:false}); }
    else if(net.isIPv6(t.host)){ /* 跳过 IPv6 */ }
    else{
      const key=t.host+':'+t.port; seenKeys.add(key);
      let entry=state.disc[key];
      const need=!entry||(now-entry.queriedAt)>CONFIG.dnsTtlSec*1000;
      if(need){
        let ips=[]; try{ips=await Promise.race([dnsPromises.resolve4(t.host),new Promise((_,rj)=>setTimeout(()=>rj(new Error('t')),4000))]);}catch(e){ips=[];}
        if(!entry){entry=state.disc[key]={queriedAt:now,ips:{}};}
        entry.queriedAt=now;
        (ips||[]).filter(ip=>net.isIPv4(ip)).forEach(ip=>{entry.ips[ip]=now;});
      }
      const aliveIps=Object.keys(entry.ips).filter(ip=>(now-entry.ips[ip])<=CONFIG.retainHours*3600*1000);
      if(!aliveIps.length){ map.set('dom:'+key,{id:'dom:'+key,ip:null,port:t.port,host:t.host,label:t.label,isDomain:true}); }
      else{ aliveIps.forEach(ip=>{
        const id='dom:'+key+'@'+ip;
        if(!state.history[id]&&state.history[ip+':'+t.port])state.history[id]=state.history[ip+':'+t.port];
        map.set(id,{id,ip,port:t.port,host:t.host,label:t.label,isDomain:true}); }); }
    }
  }
  Object.keys(state.disc).forEach(k=>{ if(!seenKeys.has(k))delete state.disc[k]; });
  state.units=[...map.values()];
}

// ==================== 测试 ====================
async function testTarget(u){
  const point={t:Date.now(),ok:false,tcp:null,tls:null,speed:null,colo:null,loc:null,exitIp:null};
  if(!u.ip)return point;
  const probe=splitProbe(CONFIG.probeUrl); const ms=CONFIG.timeoutSec*1000;
  const latCmd=`curl -4 -k -s --noproxy '*' --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${probe.host}:${u.port}${probe.path}'`;
  const raw=await runCurl(latCmd,ms+1500); const lat=parseCurlJson(raw);
  if(lat&&lat.http&&String(lat.http)!=='000'){ point.ok=true; point.tcp=Math.round(lat.tcp*1000); point.tls=Math.round(lat.tls*1000);
    const info=parseTrace(raw.trim().split('\n').slice(0,-1).join('\n'));
    point.colo=info.colo||null; point.loc=info.loc||null; point.exitIp=info.ip||null; }
  if(point.ok){
    const spCmd=`curl -4 -k -s --noproxy '*' -o /dev/null --retry 0 -w '\\n{"speed":%{speed_download},"http":%{http_code}}' --resolve "speed.cloudflare.com:${u.port}:${u.ip}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec+3} 'https://speed.cloudflare.com:${u.port}/__down?bytes=524288'`;
    const sp=parseCurlJson(await runCurl(spCmd,ms+4000));
    if(sp&&sp.http===200&&sp.speed>0)point.speed=Math.round(sp.speed/1024); }
  return point;
}

// ==================== 🌟 优质判定（每次达标制） ====================
function tlsOk(p){ return CONFIG.maxTlsMs<=0 || (p.tls!=null&&p.tls<=CONFIG.maxTlsMs); }
function speedOk(p){ return CONFIG.minSpeedKBps<=0 || (p.speed!=null&&p.speed>=CONFIG.minSpeedKBps); }
function computeQuality(points){
  const recent=(points||[]).slice(-CONFIG.qualityWindow);
  if(!recent.length)return{quality:false,rate:0,goodRate:0,medTls:null,medSpeed:null};
  const oks=recent.filter(p=>p.ok);
  const rate=oks.length/recent.length;                                   // 成功率
  const good=recent.filter(p=>p.ok&&tlsOk(p)&&speedOk(p)).length;        // 达标次数
  const goodRate=good/recent.length;                                     // 达标率
  const med=a=>a.length?a[Math.floor(a.length/2)]:null;
  const medTls=med(oks.map(p=>p.tls).filter(v=>v!=null).sort((a,b)=>a-b));
  const medSpeed=med(oks.map(p=>p.speed).filter(v=>v!=null).sort((a,b)=>a-b));
  return{quality:goodRate>=CONFIG.qualityRate,rate,goodRate,medTls,medSpeed};
}

async function runCycle(){
  if(state.checking)return; state.checking=true;
  try{
    await refreshUnits();
    state.progress={tested:0,total:state.units.length};
    log('🔄 开始检测 '+state.units.length+' 个节点（并发 '+CONFIG.concurrency+'）');
    const queue=[...state.units];
    const workers=Array.from({length:Math.min(CONFIG.concurrency,Math.max(queue.length,1))},async()=>{
      while(queue.length){ const u=queue.shift(); const point=await testTarget(u);
        if(!state.history[u.id])state.history[u.id]=[];
        state.history[u.id].push(point);
        if(state.history[u.id].length>600)state.history[u.id]=state.history[u.id].slice(-600);
        state.progress.tested++;
        log((point.ok?'✅ ':'❌ ')+u.id+(point.ok?(' tls='+point.tls+'ms'+(point.speed!=null?' speed='+point.speed+'KB/s':'')):' 失败')); } });
    await Promise.all(workers);
    state.lastCycle=Date.now();
    const online=state.units.filter(u=>{const h=state.history[u.id];return h&&h.length&&h[h.length-1].ok;}).length;
    const quality=state.units.filter(u=>computeQuality(state.history[u.id]).quality).length;
    log('🏁 检测完成：在线 '+online+' / 优质 '+quality+' / 总数 '+state.units.length);
    try{fs.mkdirSync(CONFIG.dataDir,{recursive:true});fs.writeFileSync(CONFIG.dataFile,JSON.stringify({history:state.history,disc:state.disc}));}catch(e){}
    if(CONFIG.github.auto)autoUpload().catch(e=>{state.github.lastError=e.message;log('⚠️ 自动上传失败: '+e.message);});
  }finally{ state.checking=false; }
}
function loadData(){ try{const d=JSON.parse(fs.readFileSync(CONFIG.dataFile,'utf8'));
  if(d&&d.history)state.history=d.history; if(d&&d.disc)state.disc=d.disc; }catch(e){} }

// ==================== GitHub ====================
function buildUploadContent(){
  const seen=new Map();
  state.units.filter(u=>u.ip).forEach(u=>{ const q=computeQuality(state.history[u.id]); if(!q.quality)return;
    const k=u.ip+':'+u.port; const cur=seen.get(k);
    if(!cur||(q.medTls??99999)<(cur.q.medTls??99999))seen.set(k,{u,q}); });
  const nodes=[...seen.values()].sort((a,b)=>(a.q.medTls??99999)-(b.q.medTls??99999));
  const lines=nodes.map(({u,q})=>`${u.ip}:${u.port}  # tls:${q.medTls}ms speed:${q.medSpeed??'?'}KB/s rate:${Math.round(q.rate*100)}%`);
  const content=`# ProxyIP quality list (auto uploaded by proxy-monitor)\n# updated: ${new Date().toISOString()}\n`+lines.join('\n')+(lines.length?'\n':'');
  return{content,count:nodes.length};
}
async function uploadGithub(){
  const g=CONFIG.github; if(!g.token||!g.repo)throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  const{content,count}=buildUploadContent(); if(!count)throw new Error('当前没有优质节点可上传');
  const apiPath=g.path.split('/').map(encodeURIComponent).join('/');
  const api=`https://api.github.com/repos/${g.repo}/contents/${apiPath}`;
  const headers={'Authorization':`Bearer ${g.token}`,'Accept':'application/vnd.github+json','User-Agent':'proxy-monitor','Content-Type':'application/json'};
  let sha; const getRes=await fetch(`${api}?ref=${g.branch}`,{headers});
  if(getRes.ok)sha=(await getRes.json()).sha; else if(getRes.status!==404)throw new Error('GitHub 查询失败: HTTP '+getRes.status);
  const body={message:`chore: update proxyip list (${count} nodes)`,content:Buffer.from(content,'utf8').toString('base64'),branch:g.branch};
  if(sha)body.sha=sha;
  const putRes=await fetch(api,{method:'PUT',headers,body:JSON.stringify(body)});
  if(!putRes.ok)throw new Error('GitHub 上传失败: HTTP '+putRes.status);
  state.github.lastUpload=Date.now(); state.github.lastError=null; state.lastUploadedContent=content;
  log('📤 已上传 '+count+' 个优质节点到 GitHub');
  return{count};
}
async function autoUpload(){ const{content}=buildUploadContent(); if(content===state.lastUploadedContent)return; await uploadGithub(); }

// ==================== API ====================
function buildState(){
  try{
    const items=state.units.map(u=>{ const hist=state.history[u.id]||[]; const latest=hist.length?hist[hist.length-1]:null;
      return{ id:u.id,label:u.label,host:u.host,port:u.port,isDomain:u.isDomain,ip:u.ip,
        colo:latest?latest.colo:null,loc:latest?latest.loc:null,exitIp:latest?latest.exitIp:null,
        latest,quality:computeQuality(hist),
        recent:hist.slice(-40).map(p=>({t:p.t,ok:!!p.ok,tls:p.tls,speed:p.speed})) }; });
    const online=items.filter(i=>i.latest&&i.latest.ok).length;
    const quality=items.filter(i=>i.quality.quality).length;
    return{ checking:state.checking,progress:{...state.progress},lastCycle:state.lastCycle,intervalSec:CONFIG.intervalSec,
      config:{maxTlsMs:CONFIG.maxTlsMs,minSpeedKBps:CONFIG.minSpeedKBps,qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate,dnsTtlSec:CONFIG.dnsTtlSec,retainHours:CONFIG.retainHours},
      github:{configured:!!(CONFIG.github.token&&CONFIG.github.repo),auto:CONFIG.github.auto,lastUpload:state.github.lastUpload,lastError:state.github.lastError},
      summary:{total:items.length,online,quality,offline:items.length-online},items };
  }catch(e){
    return{checking:false,progress:{tested:0,total:0},lastCycle:null,intervalSec:CONFIG.intervalSec,
      config:{maxTlsMs:0,minSpeedKBps:0,qualityWindow:10,qualityRate:1,dnsTtlSec:300,retainHours:168},
      github:{configured:false,auto:false,lastUpload:null,lastError:e.message},
      summary:{total:0,online:0,quality:0,offline:0},items:[]};
  }
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'); const p=url.pathname;
  const json=(d,s=200)=>{res.writeHead(s,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(d));};
  try{
    if(p==='/'||p==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')));}
    if(p==='/api/state')return json(buildState());
    if(p==='/api/logs')return json({logs:state.logs});
    if(p==='/api/config'&&req.method==='GET')return json(publicConfig());
    if(p==='/api/config'&&req.method==='POST'){setConfig(JSON.parse(await readBody(req)||'{}'));persistConfig();restartTimer();log('🛠️ 配置已更新');return json({ok:true,config:publicConfig()});}
    if(p==='/api/ipfile'&&req.method==='GET'){let c='';try{c=fs.readFileSync(CONFIG.ipFile,'utf8');}catch(e){}return json({content:c});}
    if(p==='/api/ipfile'&&req.method==='POST'){const{content}=JSON.parse(await readBody(req)||'{}');
      if(!ensureIpFile())return json({ok:false,error:'ip.txt 路径被占用为目录，请在宿主机 rm -rf config/ip.txt 后重试'},500);
      fs.writeFileSync(CONFIG.ipFile,String(content??''));await refreshUnits();log('📝 ip.txt 已更新，'+state.units.length+' 个测试单元');return json({ok:true,count:state.units.length});}
    if(p==='/api/check'&&req.method==='POST'){log('🖱️ 手动触发检测');runCycle();return json({ok:true});}
    if(p==='/api/reload'&&req.method==='POST'){await refreshUnits();return json({ok:true,count:state.units.length});}
    if(p==='/api/upload'&&req.method==='POST'){try{return json({ok:true,...(await uploadGithub())});}catch(e){state.github.lastError=e.message;return json({ok:false,error:e.message},500);}}
    return json({error:'not found'},404);
  }catch(e){return json({error:e.message},500);}
});

try{setConfig(JSON.parse(fs.readFileSync(CONFIG.configFile,'utf8')));}catch(e){}
ensureIpFile();
loadData();
server.listen(CONFIG.port,async()=>{
  console.log(`🚀 Proxy Monitor v8 on http://0.0.0.0:${CONFIG.port}`);
  log('🚀 服务启动');
  await refreshUnits(); runCycle(); restartTimer();
});