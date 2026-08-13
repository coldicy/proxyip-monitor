/**
 * Proxy Monitor - Docker 版节点长期监测后端
 * 零依赖：仅使用 Node.js 内置模块 + 系统 curl
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');

// ==================== 配置（环境变量） ====================
const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || '/app/config/ip.txt',
  dataFile: process.env.DATA_FILE || '/app/data/history.json',
  intervalSec: parseInt(process.env.INTERVAL_SEC || '60', 10),
  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
  maxTlsMs: parseFloat(process.env.MAX_TLS_MS || '0'),        // 优质阈值：TLS 延迟上限(ms)，0=不限
  minSpeedKBps: parseFloat(process.env.MIN_SPEED_KBPS || '0'),// 优质阈值：速度下限(KB/s)，0=不限
  qualityWindow: parseInt(process.env.QUALITY_WINDOW || '10', 10), // 取最近 N 次判定
  qualityRate: parseFloat(process.env.QUALITY_SUCCESS_RATE || '0.8'),
  github: {
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || '',       // 格式: owner/repo
    path: process.env.GITHUB_PATH || 'proxyip.txt',
    branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true',
  },
};

// ==================== 全局状态 ====================
const state = {
  targets: [],
  history: {},          // id -> [数据点]
  lastCycle: null,
  checking: false,
  startedAt: Date.now(),
  github: { lastUpload: null, lastError: null },
  lastUploadedContent: '',
};

// ==================== 工具函数 ====================
function splitProbe(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, path: u.pathname + u.search };
  } catch (e) {
    return { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' };
  }
}

function parseIpFile() {
  let text = '';
  try { text = fs.readFileSync(CONFIG.ipFile, 'utf8'); } catch (e) { return []; }
  const targets = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    let host = line, port = 443;
    if (line.startsWith('[')) {
      const m = line.match(/^\[([^\]]+)\](?::(\d+))?$/);
      if (!m) continue;
      host = m[1]; if (m[2]) port = +m[2];
    } else if (line.split(':').length === 2 && /^\d+$/.test(line.split(':')[1])) {
      host = line.split(':')[0]; port = +line.split(':')[1];
    } else if (line.includes(':')) {
      host = line; // 裸 IPv6
    }
    const id = `${host}:${port}`;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, host, port, label: line });
  }
  return targets;
}

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  try {
    const ips = await Promise.race([
      dnsPromises.resolve4(host),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 3000)),
    ]);
    return ips && ips.length ? ips[0] : null;
  } catch (e) { return null; }
}

function runCurl(cmd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function parseCurlJson(stdout) {
  if (!stdout) return null;
  const lines = stdout.trim().split('\n');
  try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
}

// ==================== 单节点测试（延迟 + 带宽） ====================
async function testTarget(t) {
  const ip = await resolveHost(t.host);
  const point = { t: Date.now(), ok: false, tcp: null, tls: null, speed: null, ip };
  if (!ip) return point;

  const curlIP = net.isIPv6(ip) ? `[${ip}]` : ip;
  const fam = net.isIPv6(ip) ? '-6' : '-4';
  const probe = splitProbe(CONFIG.probeUrl);
  const timeoutMs = CONFIG.timeoutSec * 1000;

  // ① 握手延迟（端口跟随节点实际端口）
  const latCmd = `curl ${fam} -k -s --retry 0 -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"http":%{http_code}}' --resolve "${probe.host}:${t.port}:${curlIP}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec} 'https://${probe.host}:${t.port}${probe.path}'`;
  const lat = parseCurlJson(await runCurl(latCmd, timeoutMs + 1500));
  if (lat && lat.http && String(lat.http) !== '000') {
    point.ok = true;
    point.tcp = Math.round(lat.tcp * 1000);
    point.tls = Math.round(lat.tls * 1000);
  }

  // ② 带宽采样（512KB，穿透节点）
  if (point.ok) {
    const spCmd = `curl ${fam} -k -s -o /dev/null --retry 0 -w '\\n{"speed":%{speed_download},"http":%{http_code}}' --resolve "speed.cloudflare.com:${t.port}:${curlIP}" --connect-timeout 2 --max-time ${CONFIG.timeoutSec + 3} 'https://speed.cloudflare.com:${t.port}/__down?bytes=524288'`;
    const sp = parseCurlJson(await runCurl(spCmd, timeoutMs + 4000));
    if (sp && sp.http === 200 && sp.speed > 0) point.speed = Math.round(sp.speed / 1024);
  }
  return point;
}

// ==================== 优质判定 ====================
function computeQuality(points) {
  const recent = (points || []).slice(-CONFIG.qualityWindow);
  if (!recent.length) return { quality: false, rate: 0, medTls: null, medSpeed: null };
  const oks = recent.filter(p => p.ok);
  const rate = oks.length / recent.length;
  const med = a => a.length ? a[Math.floor(a.length / 2)] : null;
  const medTls = med(oks.map(p => p.tls).filter(v => v != null).sort((a, b) => a - b));
  const medSpeed = med(oks.map(p => p.speed).filter(v => v != null).sort((a, b) => a - b));
  let quality = rate >= CONFIG.qualityRate;
  if (quality && CONFIG.maxTlsMs > 0) quality = medTls != null && medTls <= CONFIG.maxTlsMs;
  if (quality && CONFIG.minSpeedKBps > 0) quality = medSpeed != null && medSpeed >= CONFIG.minSpeedKBps;
  return { quality, rate, medTls, medSpeed };
}

// ==================== 监测循环 ====================
async function runCycle() {
  if (state.checking) return;
  state.checking = true;
  try {
    state.targets = parseIpFile();
    const queue = [...state.targets];
    const workers = Array.from({ length: Math.min(CONFIG.concurrency, Math.max(queue.length, 1)) }, async () => {
      while (queue.length) {
        const t = queue.shift();
        const point = await testTarget(t);
        if (!state.history[t.id]) state.history[t.id] = [];
        state.history[t.id].push(point);
        if (state.history[t.id].length > 600) state.history[t.id] = state.history[t.id].slice(-600);
      }
    });
    await Promise.all(workers);
    state.lastCycle = Date.now();
    saveData();
    if (CONFIG.github.auto) autoUpload().catch(e => { state.github.lastError = e.message; });
  } finally { state.checking = false; }
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.dataFile), { recursive: true });
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify({ history: state.history }));
  } catch (e) { /* ignore */ }
}

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
    if (data && data.history) state.history = data.history;
  } catch (e) { /* ignore */ }
}

// ==================== GitHub 上传 ====================
function buildUploadContent() {
  const nodes = state.targets
    .map(t => ({ t, q: computeQuality(state.history[t.id]) }))
    .filter(x => x.q.quality)
    .sort((a, b) => (a.q.medTls ?? 99999) - (b.q.medTls ?? 99999));
  const lines = nodes.map(({ t, q }) =>
    `${t.host}:${t.port}  # tls:${q.medTls}ms speed:${q.medSpeed ?? '?'}KB/s rate:${Math.round(q.rate * 100)}%`);
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
  const headers = {
    'Authorization': `Bearer ${g.token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'proxy-monitor',
    'Content-Type': 'application/json',
  };
  let sha;
  const getRes = await fetch(`${api}?ref=${g.branch}`, { headers });
  if (getRes.ok) sha = (await getRes.json()).sha;
  else if (getRes.status !== 404) throw new Error('GitHub 查询失败: HTTP ' + getRes.status);

  const body = {
    message: `chore: update proxyip list (${count} nodes)`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: g.branch,
  };
  if (sha) body.sha = sha;
  const putRes = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!putRes.ok) throw new Error('GitHub 上传失败: HTTP ' + putRes.status + ' ' + (await putRes.text()).slice(0, 150));
  state.github.lastUpload = Date.now();
  state.github.lastError = null;
  state.lastUploadedContent = content;
  return { count };
}

async function autoUpload() {
  const { content } = buildUploadContent();
  if (content === state.lastUploadedContent) return;
  await uploadGithub();
}

// ==================== API 状态 ====================
function buildState() {
  const items = state.targets.map(t => {
    const hist = state.history[t.id] || [];
    const latest = hist.length ? hist[hist.length - 1] : null;
    return {
      id: t.id, label: t.label, host: t.host, port: t.port,
      ip: latest ? latest.ip : null,
      latest,
      quality: computeQuality(hist),
      spark: hist.slice(-40).map(p => p.tls),
    };
  });
  const online = items.filter(i => i.latest && i.latest.ok).length;
  const quality = items.filter(i => i.quality.quality).length;
  return {
    checking: state.checking,
    lastCycle: state.lastCycle,
    intervalSec: CONFIG.intervalSec,
    config: {
      maxTlsMs: CONFIG.maxTlsMs, minSpeedKBps: CONFIG.minSpeedKBps,
      qualityWindow: CONFIG.qualityWindow, qualityRate: CONFIG.qualityRate,
    },
    github: {
      configured: !!(CONFIG.github.token && CONFIG.github.repo),
      auto: CONFIG.github.auto,
      lastUpload: state.github.lastUpload,
      lastError: state.github.lastError,
    },
    summary: { total: items.length, online, quality, offline: items.length - online },
    items,
  };
}

// ==================== HTTP 服务 ====================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  };
  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (p === '/api/state') return json(buildState());
    if (p === '/api/check' && req.method === 'POST') { runCycle(); return json({ ok: true }); }
    if (p === '/api/reload' && req.method === 'POST') {
      state.targets = parseIpFile();
      return json({ ok: true, count: state.targets.length });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      try { return json({ ok: true, ...(await uploadGithub()) }); }
      catch (e) { state.github.lastError = e.message; return json({ ok: false, error: e.message }, 500); }
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
});

// ==================== 启动 ====================
loadData();
state.targets = parseIpFile();
server.listen(CONFIG.port, () => {
  console.log(`🚀 Proxy Monitor running on http://0.0.0.0:${CONFIG.port}`);
  console.log(`📋 已加载 ${state.targets.length} 个节点，监测间隔 ${CONFIG.intervalSec}s`);
  runCycle();
  setInterval(runCycle, CONFIG.intervalSec * 1000);
});