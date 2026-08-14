/**
 * Proxy Monitor - Docker 版节点长期监测后端（v4）
 * v4：域名解析出的【全部 IPv4】逐个独立测试（不测 IPv6，自动去重）；解析失败保留为离线行
 * 继承：网页配置/编辑 ip.txt、--noproxy 直连、colo/loc 采集、GitHub 上传
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
  maxTlsMs: parseFloat(process.env.MAX_TLS_MS || '0'),
  minSpeedKBps: parseFloat(process.env.MIN_SPEED_KBPS || '0'),
  qualityWindow: parseInt(process.env.QUALITY_WINDOW || '10', 10),
  qualityRate: parseFloat(process.env.QUALITY_SUCCESS_RATE || '0.8'),
  github: {
    token: process.env.GITHUB_TOKEN || '', repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip.txt', branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true',
  },
};
CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');

const state = {
  units: [], history: {}, lastCycle: null, checking: false,
  github: { lastUpload: null, lastError: null }, lastUploadedContent: '',
};
let cycleTimer = null;

// ==================== 配置管理 ====================
function setConfig(o) {
  if (!o) return;
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  if (o.intervalSec != null) CONFIG.intervalSec = Math.max(5, Math.round(num(o.intervalSec, CONFIG.intervalSec)));
  if (o.timeoutSec != null) CONFIG.timeoutSec = Math.max(1, Math.round(num(o.timeoutSec, CONFIG.timeoutSec)));
  if (o.concurrency != null) CONFIG.concurrency = Math.max(1, Math.round(num(o.concurrency, CONFIG.concurrency)));
  if (o.probeUrl) CONFIG.probeUrl = String(o.probeUrl);
  if (o.maxTlsMs != null) CONFIG.maxTlsMs = num(o.maxTlsMs, 0);
  if (o.minSpeedKBps != null) CONFIG.minSpeedKBps = num(o.minSpeedKBps, 0);
  if (o.qualityWindow != null) CONFIG.qualityWindow = Math.max(1, Math.round(num(o.qualityWindow, CONFIG.qualityWindow)));
  if (o.qualityRate != null) CONFIG.qualityRate = Math.min(1, Math.max(0, num(o.qualityRate, CONFIG.qualityRate)));
  if (o.github) { const g = o.github;
    if (g.token != null) CONFIG.github.token = String(g.token);
    if (g.repo != null) CONFIG.github.repo = String(g.repo);
    if (g.path != null) CONFIG.github.path = String(g.path) || 'proxyip.txt';
    if (g.branch != null) CONFIG.github.branch = String(g.branch) || 'main';
    if (g.auto != null) CONFIG.github.auto = (g.auto === true || g.auto === 'true');
  }
}
function publicConfig() {
  return { intervalSec: CONFIG.intervalSec, timeoutSec: CONFIG.timeoutSec, concurrency: CONFIG.concurrency,
    probeUrl: CONFIG.probeUrl, maxTlsMs: CONFIG.maxTlsMs, minSpeedKBps: CONFIG.minSpeedKBps,
    qualityWindow: CONFIG.qualityWindow, qualityRate: CONFIG.qualityRate, github: { ...CONFIG.github } };
}
function persistConfig() { try { fs.mkdirSync(CONFIG.dataDir, { recursive: true }); fs.writeFileSync(CONFIG.configFile, JSON.stringify(publicConfig(), null, 2)); } catch (e) {} }
function restartTimer() { if (cycleTimer) clearInterval(cycleTimer); cycleTimer = setInterval(runCycle, CONFIG.intervalSec * 1000); }

// ==================== 工具 ====================
function splitProbe(url) { try { const u = new URL(url); return { host: u.hostname, path: u.pathname + u.search }; } catch (e) { return { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' }; } }
function parseIpFile() {
  let text = ''; try { text = fs.readFileSync(CONFIG.ipFile, 'utf8'); } catch (e) { return []; }
  const out = []; const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim(); if (!line) continue;
    let host = line, port = 443;
    if (line.startsWith('[')) { const m = line.match(/^\[([^\]]+)\](?::(\d+))?$/); if (!m) continue; host = m[1]; if (m[2]) port = +m[2]; }
    else if (line.split(':').length === 2 && /^\d+$/.test(line.split(':')[1])) { host = line.split(':')[0]; port = +line.split(':')[1]; }
    else if (line.includes(':')) { host = line; }
    const id = `${host}:${port}`; if (seen.has(id)) continue; seen.add(id);
    out.push({ host, port, label: line });
  }
  return out;
}
function runCurl(cmd, ms) { return new Promise(res => exec(cmd, { timeout: ms, maxBuffer: 1024 * 1024 }, (e, o) => res(e ? null : o))); }
function parseCurlJson(o) { if (!o) return null; const l = o.trim().split('\n'); try { return JSON.parse(l[l.length - 1]); } catch (e) { return null; } }
function parseTrace(t) { const p = {}; String(t || '').replace(/\r/g, '').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) p[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); return p; }
function readBody(req) { return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); }); }

// ==================== 🌟 域名展开为全部 IPv4 ====================
async function refreshUnits() {
  const targets = parseIpFile();
  const map = new Map();
  for (const t of targets) {
    if (net.isIPv4(t.host)) {
      const id = `${t.host}:${t.port}`;
      if (!map.has(id)) map.set(id, { id, ip: t.host, port: t.port, host: t.host, label: t.label, isDomain: false });
    } else if (net.isIPv6(t.host)) {
      // 按要求跳过 IPv6
    } else {
      let ips = [];
      try {
        ips = await Promise.race([dnsPromises.resolve4(t.host), new Promise((_, r) => setTimeout(() => r(new Error('dns timeout')), 4000))]);
      } catch (e) { ips = []; }
      ips = (ips || []).filter(ip => net.isIPv4(ip)); // 只测 IPv4
      if (!ips.length) {
        const id = `${t.host}:${t.port}`; // 解析失败也保留为离线行
        if (!map.has(id)) map.set(id, { id, ip: null, port: t.port, host: t.host, label: t.label, isDomain: true });
      } else {
        for (const ip of ips) {
          const id = `${ip}:${t.port}`;
          if (!map.has(id)) map.set(id, { id, ip, port: t.port, host: t.host, label: t.label, isDomain: true });
        }
      }
    }
  }
  state.units = [...map.values()];
}

// ==================== 测试 / 质量 ====================
async function testTarget(u) {
  const point = { t: Date.now(), ok: false, tcp: null, tls: null, speed: null, colo: null, loc: null, exitIp: null };
  if (!u.ip) return point;
  const curlIP = u.ip; const fam = '-4';
  const probe = splitProbe(CONFIG.probeUrl);
  const timeoutMs = CONFIG.timeoutSec * 1000;
  const latCmd = `curl ${fam} -k -s --noproxy '*' --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${curlIP}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${probe.host}:${u.port}${probe.path}'`;
  const raw = await runCurl(latCmd, timeoutMs + 1500);
  const lat = parseCurlJson(raw);
  if (lat && lat.http && String(lat.http) !== '000') {
    point.ok = true; point.tcp = Math.round(lat.tcp * 1000); point.tls = Math.round(lat.tls * 1000);
    const info = parseTrace(raw.trim().split('\n').slice(0, -1).join('\n'));
    point.colo = info.colo || null; point.loc = info.loc || null; point.exitIp = info.ip || null;
  }
  if (point.ok) {
    const spCmd = `curl ${fam} -k -s --noproxy '*' -o /dev/null --retry 0 -w '\\n{"speed":%{speed_download},"http":%{http_code}}' --resolve "speed.cloudflare.com:${u.port}:${curlIP}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec + 3} 'https://speed.cloudflare.com:${u.port}/__down?bytes=524288'`;
    const sp = parseCurlJson(await runCurl(spCmd, timeoutMs + 4000));
    if (sp && sp.http === 200 && sp.speed > 0) point.speed = Math.round(sp.speed / 1024);
  }
  return point;
}
function computeQuality(points) {
  const recent = (points || []).slice(-CONFIG.qualityWindow);
  if (!recent.length) return { quality: false, rate: 0, medTls: null, medSpeed: null };
  const oks = recent.filter(p => p.ok); const rate = oks.length / recent.length;
  const med = a => a.length ? a[Math.floor(a.length / 2)] : null;
  const medTls = med(oks.map(p => p.tls).filter(v => v != null).sort((a, b) => a - b));
  const medSpeed = med(oks.map(p => p.speed).filter(v => v != null).sort((a, b) => a - b));
  let quality = rate >= CONFIG.qualityRate;
  if (quality && CONFIG.maxTlsMs > 0) quality = medTls != null && medTls <= CONFIG.maxTlsMs;
  if (quality && CONFIG.minSpeedKBps > 0) quality = medSpeed != null && medSpeed >= CONFIG.minSpeedKBps;
  return { quality, rate, medTls, medSpeed };
}
async function runCycle() {
  if (state.checking) return; state.checking = true;
  try {
    await refreshUnits();
    const queue = [...state.units];
    const workers = Array.from({ length: Math.min(CONFIG.concurrency, Math.max(queue.length, 1)) }, async () => {
      while (queue.length) {
        const u = queue.shift();
        const point = await testTarget(u);
        if (!state.history[u.id]) state.history[u.id] = [];
        state.history[u.id].push(point);
        if (state.history[u.id].length > 600) state.history[u.id] = state.history[u.id].slice(-600);
      }
    });
    await Promise.all(workers);
    state.lastCycle = Date.now();
    try { fs.mkdirSync(CONFIG.dataDir, { recursive: true }); fs.writeFileSync(CONFIG.dataFile, JSON.stringify({ history: state.history })); } catch (e) {}
    if (CONFIG.github.auto) autoUpload().catch(e => { state.github.lastError = e.message; });
  } finally { state.checking = false; }
}
function loadData() { try { const d = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8')); if (d && d.history) state.history = d.history; } catch (e) {} }

// ==================== GitHub ====================
function buildUploadContent() {
  const nodes = state.units.filter(u => u.ip).map(u => ({ u, q: computeQuality(state.history[u.id]) }))
    .filter(x => x.q.quality).sort((a, b) => (a.q.medTls ?? 99999) - (b.q.medTls ?? 99999));
  const lines = nodes.map(({ u, q }) => `${u.ip}:${u.port}  # tls:${q.medTls}ms speed:${q.medSpeed ?? '?'}KB/s rate:${Math.round(q.rate * 100)}%`);
  const content = `# ProxyIP quality list (auto uploaded by proxy-monitor)\n# updated: ${new Date().toISOString()}\n` + lines.join('\n') + (lines.length ? '\n' : '');
  return { content, count: nodes.length };
}
async function uploadGithub() {
  const g = CONFIG.github;
  if (!g.token || !g.repo) throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  const { content, count } = buildUploadContent();
  if (!count) throw new Error('当前没有优质节点可上传');
  const apiPath = g.path.split('/').map(encodeURIComponent).join('/');
  const api = `https://api.github.com/repos/${g.repo}/contents/${apiPath}`;
  const headers = { 'Authorization': `Bearer ${g.token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'proxy-monitor', 'Content-Type': 'application/json' };
  let sha;
  const getRes = await fetch(`${api}?ref=${g.branch}`, { headers });
  if (getRes.ok) sha = (await getRes.json()).sha; else if (getRes.status !== 404) throw new Error('GitHub 查询失败: HTTP ' + getRes.status);
  const body = { message: `chore: update proxyip list (${count} nodes)`, content: Buffer.from(content, 'utf8').toString('base64'), branch: g.branch };
  if (sha) body.sha = sha;
  const putRes = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!putRes.ok) throw new Error('GitHub 上传失败: HTTP ' + putRes.status);
  state.github.lastUpload = Date.now(); state.github.lastError = null; state.lastUploadedContent = content;
  return { count };
}
async function autoUpload() { const { content } = buildUploadContent(); if (content === state.lastUploadedContent) return; await uploadGithub(); }

// ==================== API ====================
function buildState() {
  try {
    const items = state.units.map(u => {
      const hist = state.history[u.id] || [];
      const latest = hist.length ? hist[hist.length - 1] : null;
      return { id: u.id, label: u.label, host: u.host, port: u.port, isDomain: u.isDomain,
        ip: u.ip, colo: latest ? latest.colo : null, loc: latest ? latest.loc : null,
        latest, quality: computeQuality(hist), spark: hist.slice(-40).map(p => p.tls) };
    });
    const online = items.filter(i => i.latest && i.latest.ok).length;
    const quality = items.filter(i => i.quality.quality).length;
    return { checking: state.checking, lastCycle: state.lastCycle, intervalSec: CONFIG.intervalSec,
      config: { maxTlsMs: CONFIG.maxTlsMs, minSpeedKBps: CONFIG.minSpeedKBps, qualityWindow: CONFIG.qualityWindow, qualityRate: CONFIG.qualityRate },
      github: { configured: !!(CONFIG.github.token && CONFIG.github.repo), auto: CONFIG.github.auto, lastUpload: state.github.lastUpload, lastError: state.github.lastError },
      summary: { total: items.length, online, quality, offline: items.length - online }, items };
  } catch (e) {
    return { checking:false, lastCycle:null, intervalSec:CONFIG.intervalSec,
      config:{maxTlsMs:CONFIG.maxTlsMs,minSpeedKBps:CONFIG.minSpeedKBps,qualityWindow:CONFIG.qualityWindow,qualityRate:CONFIG.qualityRate},
      github:{configured:!!(CONFIG.github.token&&CONFIG.github.repo),auto:CONFIG.github.auto,lastUpload:null,lastError:e.message},
      summary:{total:0,online:0,quality:0,offline:0}, items:[] };
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); const p = url.pathname;
  const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); };
  try {
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))); }
    if (p === '/api/state') return json(buildState());
    if (p === '/api/config' && req.method === 'GET') return json(publicConfig());
    if (p === '/api/config' && req.method === 'POST') { setConfig(JSON.parse(await readBody(req) || '{}')); persistConfig(); restartTimer(); return json({ ok: true, config: publicConfig() }); }
    if (p === '/api/ipfile' && req.method === 'GET') { let c = ''; try { c = fs.readFileSync(CONFIG.ipFile, 'utf8'); } catch (e) {} return json({ content: c }); }
    if (p === '/api/ipfile' && req.method === 'POST') { const { content } = JSON.parse(await readBody(req) || '{}'); fs.mkdirSync(path.dirname(CONFIG.ipFile), { recursive: true }); fs.writeFileSync(CONFIG.ipFile, String(content ?? '')); await refreshUnits(); return json({ ok: true, count: state.units.length }); }
    if (p === '/api/check' && req.method === 'POST') { runCycle(); return json({ ok: true }); }
    if (p === '/api/reload' && req.method === 'POST') { await refreshUnits(); return json({ ok: true, count: state.units.length }); }
    if (p === '/api/upload' && req.method === 'POST') { try { return json({ ok: true, ...(await uploadGithub()) }); } catch (e) { state.github.lastError = e.message; return json({ ok: false, error: e.message }, 500); } }
    return json({ error: 'not found' }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
});

try { setConfig(JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8'))); } catch (e) {}
loadData();
server.listen(CONFIG.port, async () => {
  console.log(`🚀 Proxy Monitor v4 on http://0.0.0.0:${CONFIG.port}`);
  await refreshUnits();
  runCycle(); restartTimer();
});