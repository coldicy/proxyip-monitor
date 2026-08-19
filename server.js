/**
Proxy Monitor v32-business
业务调整：
1. 总延迟 = 官方探针 + 所有自定义探针平均；无自定义探针则只用官方探针。
2. 任意探针当次不通即离线。
3. 历史记录保存每个探针详情，供前端柱状图点击展示。
4. 质量判定输出平均总延迟 / 平均TCP / 平均TLS / 平均HTTP源站延迟。
5. GitHub 上传与复制节点使用平均总延迟。
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');

const VERSION = 'v32-business';

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
  github: {
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip',
    branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true',
    uploadIntervalMin: parseInt(process.env.GITHUB_UPLOAD_INTERVAL_MIN || '0', 10)
  }
};

CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
CONFIG.graveyardFile = path.join(CONFIG.dataDir, 'graveyard.json');

const state = {
  units: [],
  nodes: {},
  history: {},
  blocked: {},
  graveyard: { list: [] },
  cfCidrs: [],
  cfCidrsAt: 0,
  lastCycle: null,
  checking: false,
  abort: false,
  progress: { tested: 0, total: 0 },
  logs: [],
  github: { lastUpload: null, lastError: null },
  lastUploadedContent: ''
};

let cycleTimer = null;
let githubTimer = null;

function log(m) {
  state.logs.push({ t: Date.now(), m: String(m) });
  if (state.logs.length > 400) state.logs = state.logs.slice(-400);
}

// ==================== 配置 ====================

function setConfig(o) {
  if (!o) return;
  const num = (v, d) => {
    const n = parseFloat(v);
    return isFinite(n) ? n : d;
  };

  if (o.intervalSec != null) CONFIG.intervalSec = Math.max(5, Math.round(num(o.intervalSec, CONFIG.intervalSec)));
  if (o.timeoutSec != null) CONFIG.timeoutSec = Math.max(1, Math.round(num(o.timeoutSec, CONFIG.timeoutSec)));
  if (o.concurrency != null) CONFIG.concurrency = Math.max(1, Math.round(num(o.concurrency, CONFIG.concurrency)));
  if (o.autoCleanDays != null) CONFIG.autoCleanDays = Math.max(0, num(o.autoCleanDays, 0));
  if (o.maxTotalMs != null) CONFIG.maxTotalMs = num(o.maxTotalMs, 0);
  if (o.probeUrl) CONFIG.probeUrl = String(o.probeUrl);
  if (o.qualityWindow != null) CONFIG.qualityWindow = Math.max(1, Math.round(num(o.qualityWindow, CONFIG.qualityWindow)));
  if (o.qualityRate != null) CONFIG.qualityRate = Math.min(1, Math.max(0, num(o.qualityRate, CONFIG.qualityRate)));

  if (o.customProbes && Array.isArray(o.customProbes)) {
    CONFIG.customProbes = o.customProbes
      .filter(p => p && p.url)
      .map(p => ({ url: String(p.url), expect: String(p.expect || '200') }));
  } else if (o.customProbeUrl != null) {
    CONFIG.customProbes = [{ url: String(o.customProbeUrl), expect: '204' }];
  }

  if (o.github) {
    const g = o.github;
    if (g.token != null) CONFIG.github.token = String(g.token);
    if (g.repo != null) CONFIG.github.repo = String(g.repo);
    if (g.path != null) CONFIG.github.path = String(g.path) || 'proxyip';
    if (g.branch != null) CONFIG.github.branch = String(g.branch) || 'main';
    if (g.auto != null) CONFIG.github.auto = (g.auto === true || g.auto === 'true');
    if (g.uploadIntervalMin != null) CONFIG.github.uploadIntervalMin = Math.max(0, Math.round(num(g.uploadIntervalMin, 0)));
  }

  restartGithubTimer();
}

function publicConfig() {
  return {
    intervalSec: CONFIG.intervalSec,
    timeoutSec: CONFIG.timeoutSec,
    concurrency: CONFIG.concurrency,
    autoCleanDays: CONFIG.autoCleanDays,
    maxTotalMs: CONFIG.maxTotalMs,
    probeUrl: CONFIG.probeUrl,
    customProbes: CONFIG.customProbes,
    qualityWindow: CONFIG.qualityWindow,
    qualityRate: CONFIG.qualityRate,
    github: { ...CONFIG.github }
  };
}

function persistConfig() {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(CONFIG.configFile, JSON.stringify(publicConfig(), null, 2));
  } catch (e) {}
}

function restartTimer() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(() => {
    runCycle().catch(e => log('⚠️ 定时检测异常: ' + e.message));
  }, CONFIG.intervalSec * 1000);
}

function restartGithubTimer() {
  if (githubTimer) clearInterval(githubTimer);
  const mins = CONFIG.github.uploadIntervalMin;
  if (mins > 0 && CONFIG.github.token && CONFIG.github.repo) {
    githubTimer = setInterval(() => {
      log('⏰ 定时触发 GitHub 上传');
      uploadGithub().catch(e => {
        state.github.lastError = e.message;
        log('⚠️ 定时上传失败: ' + e.message);
      });
    }, mins * 60 * 1000);
  }
}

// ==================== 工具 ====================

function splitProbe(u) {
  try {
    const x = new URL(u);
    return { host: x.hostname, path: x.pathname + x.search };
  } catch (e) {
    return { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' };
  }
}

function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

function parseLine(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;

  let host = raw;
  let port = 443;

  if (raw.startsWith('[')) {
    const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!m) return null;
    host = m[1];
    if (m[2]) port = +m[2];
  } else if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
      port = +parts[1];
    } else {
      host = raw;
    }
  }

  return { host, port };
}

function sourceKeyForLine(line) {
  if (isUrl(line)) return 'url:' + line;
  const r = parseLine(line);
  if (!r) return null;
  if (net.isIPv4(r.host)) return 'pure:' + r.host + ':' + r.port;
  if (net.isIPv6(r.host)) return null;
  return 'dom:' + r.host + ':' + r.port;
}

function splitId(id) {
  const i = id.lastIndexOf(':');
  return [id.slice(0, i), +id.slice(i + 1)];
}

function runCurl2Args(args, ms) {
  return new Promise(resolve => {
    execFile('curl', args, { timeout: ms, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (!error) return resolve({ out: stdout || '', code: 0 });

      let code = -1;
      if (typeof error.code === 'number') code = error.code;
      else if (typeof error.code === 'string' && /^\d+$/.test(error.code)) code = parseInt(error.code, 10);
      if (error.killed) code = -1;

      resolve({ out: stdout || '', code });
    });
  });
}

function curlFailText(code) {
  if (code === 28) return '超时';
  if (code === 7) return '连接被拒';
  if (code === 35 || code === 60 || code === 61) return 'TLS错误';
  if (code === -1) return '进程超时/被杀';
  if (code === 6) return 'DNS解析失败';
  return 'curl错误 ' + code;
}

function parseCurlJson(o) {
  if (!o) return null;
  const lines = String(o).trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch (e) {}
  }
  return null;
}

function parseTrace(t) {
  const p = {};
  String(t || '').replace(/\r/g, '').split('\n').forEach(l => {
    const i = l.indexOf('=');
    if (i > 0) p[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  });
  return p;
}

function readBody(q) {
  return new Promise(r => {
    let d = '';
    q.on('data', c => d += c);
    q.on('end', () => r(d));
  });
}

function buildSegs(w) {
  if (!w) return null;
  const tcp = Math.max(0, Math.round((parseFloat(w.tcp) || 0) * 1000));
  const tls = Math.max(0, Math.round(((parseFloat(w.tls) || 0) - (parseFloat(w.tcp) || 0)) * 1000));
  const total = Math.max(0, Math.round((parseFloat(w.ttfb) || 0) * 1000));
  return { tcp, tls, total, src: Math.max(0, total - tcp - tls) };
}

function averageSegs(segs) {
  const arr = (segs || []).filter(s => s && isFinite(s.total));
  if (!arr.length) return null;

  const avg = f => Math.round(arr.reduce((sum, s) => sum + (f(s) || 0), 0) / arr.length);

  const tcp = avg(s => s.tcp);
  const tls = avg(s => s.tls);
  const src = avg(s => s.src);
  const total = avg(s => s.total);

  return { tcp, tls, total, src: isFinite(src) ? src : Math.max(0, total - tcp - tls) };
}

function ensureIpFile() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.ipFile), { recursive: true });

    let st = null;
    try {
      st = fs.statSync(CONFIG.ipFile);
    } catch (e) {}

    if (st && st.isDirectory()) {
      try {
        fs.rmdirSync(CONFIG.ipFile);
      } catch (e) {
        return false;
      }
    }

    if (!fs.existsSync(CONFIG.ipFile)) {
      fs.writeFileSync(CONFIG.ipFile, '# 每行: 纯IP / 域名 / http(s)列表源\n');
    }

    return true;
  } catch (e) {
    return false;
  }
}

function persistGraveyard() {
  try {
    fs.writeFileSync(CONFIG.graveyardFile, JSON.stringify({ list: state.graveyard.list, blocked: state.blocked }));
  } catch (e) {}
}

function loadGraveyard() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.graveyardFile, 'utf8'));
    if (Array.isArray(d)) {
      state.graveyard.list = d;
      state.blocked = {};
    } else {
      state.graveyard.list = d.list || [];
      state.blocked = d.blocked || {};
    }
  } catch (e) {
    state.graveyard.list = [];
    state.blocked = {};
  }
}

function capGraveyard() {
  if (state.graveyard.list.length > 1000) state.graveyard.list = state.graveyard.list.slice(-1000);
}

function offlineSince(id) {
  const hist = state.history[id] || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].ok) return hist[i].t;
  }
  if (hist.length > 0) return hist[0].t;
  return Date.now();
}

function pushGrave(label, id, lastOnline, mode, reason) {
  state.graveyard.list.push({
    id,
    label,
    removedAt: Date.now(),
    lastOnlineAt: lastOnline,
    mode,
    reason
  });
}

function saveData() {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    const tmp = CONFIG.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ history: state.history, nodes: state.nodes }));
    fs.renameSync(tmp, CONFIG.dataFile);
  } catch (e) {}
}

async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      res[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return res;
}

function timeoutPromise(ms) {
  return new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms));
}

async function fetchList(url) {
  const args = ['-4', '-k', '-s', '-L', '--noproxy', '*', '--compressed', '-m', '20', url];
  const r = await runCurl2Args(args, 25000);
  const out = r.out || '';
  if (out.trim()) {
    if (out.length > 2 * 1024 * 1024) return out.slice(0, 2 * 1024 * 1024);
    return out;
  }
  return '';
}

// ==================== CF CIDR 分类 ====================

const CF_SUPERNETS = [
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/12',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17'
];

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return (p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) >>> 0;
}

function cidrMatch(ip, cidr) {
  const [n, bits] = cidr.split('/');
  const b = +bits;
  const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(n) & mask);
}

async function refreshCfCidrs(force) {
  if (!force && state.cfCidrs.length && (Date.now() - state.cfCidrsAt) < 12 * 3600 * 1000) return;

  let live = [];

  if (typeof fetch === 'function') {
    try {
      const res = await fetch('https://www.cloudflare.com/ips-v4');
      if (res.ok) {
        const txt = await res.text();
        live = txt.split(/\r?\n/)
          .map(s => s.trim())
          .filter(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));
      }
    } catch (e) {
      log('⚠️ 获取CF IP段失败，使用内置超网: ' + e.message);
    }
  } else {
    log('⚠️ 当前 Node 版本缺少 fetch，CF 分类仅使用内置超网');
  }

  state.cfCidrs = [...new Set([...CF_SUPERNETS, ...live])];
  state.cfCidrsAt = Date.now();

  for (const id of Object.keys(state.nodes)) {
    state.nodes[id].kind = classifyIp(state.nodes[id].ip);
  }

  log('🌐 CF IP分类集合已更新: ' + state.cfCidrs.length + ' 条');
}

function classifyIp(ip) {
  if (!ip || !net.isIPv4(ip) || !state.cfCidrs.length) return 'unknown';
  return state.cfCidrs.some(c => cidrMatch(ip, c)) ? 'cf' : 'proxy';
}

// ==================== 节点注册表迁移 ====================

function migrateNodes(disc) {
  const nodes = {};

  for (const key of Object.keys(disc || {})) {
    const e = disc[key];
    const kind = e.kind || (key.startsWith('pure:') ? 'pure' : key.startsWith('url:') ? 'url' : 'dom');

    for (const id of Object.keys(e.ids || {})) {
      const [ip, port] = splitId(id);
      if (!net.isIPv4(ip)) continue;
      if (!nodes[id]) nodes[id] = { id, ip, port, firstSource: { kind, name: e.name || id } };
    }
  }

  for (const id of Object.keys(state.history)) {
    const [ip, port] = splitId(id);
    if (!net.isIPv4(ip)) continue;

    const hist = state.history[id];
    const firstSeen = hist && hist.length ? hist[0].t : Date.now();

    if (!nodes[id]) nodes[id] = { id, ip, port, firstSource: { kind: 'pure', name: id } };
    if (!nodes[id].firstSeen) nodes[id].firstSeen = firstSeen;
  }

  for (const id of Object.keys(nodes)) {
    if (!nodes[id].firstSeen) nodes[id].firstSeen = Date.now();
  }

  return nodes;
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
    if (d && d.history) state.history = d.history;

    if (d && d.nodes && Object.keys(d.nodes).length) {
      state.nodes = d.nodes;
    } else {
      state.nodes = migrateNodes(d && d.disc ? d.disc : {});
    }
  } catch (e) {
    state.nodes = migrateNodes({});
  }

  loadGraveyard();
}

// ==================== 发现(只增) ====================

async function discover() {
  await refreshCfCidrs(false);

  const now = Date.now();
  let lines = [];
  try {
    lines = fs.readFileSync(CONFIG.ipFile, 'utf8').split(/\r?\n/);
  } catch (e) {}

  const present = new Set();
  const domJobs = [];
  const urlJobs = [];
  const adds = [];

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;

    const key = sourceKeyForLine(line);
    if (!key || present.has(key)) continue;
    present.add(key);

    if (key.startsWith('pure:')) {
      const id = key.slice(5);
      adds.push({ id, kind: 'pure', name: id });
    } else if (key.startsWith('dom:')) {
      const hp = key.slice(4);
      const li = hp.lastIndexOf(':');
      domJobs.push({ host: hp.slice(0, li), port: +hp.slice(li + 1), kind: 'dom', name: hp.slice(0, li) });
    } else {
      urlJobs.push({ url: key.slice(4), kind: 'url', name: key.slice(4) });
    }
  }

  await mapLimit(domJobs, 20, async j => {
    let ips = [];
    try {
      ips = await Promise.race([dnsPromises.resolve4(j.host), timeoutPromise(4000)]);
    } catch (e) {}

    (ips || [])
      .filter(ip => net.isIPv4(ip))
      .forEach(ip => adds.push({ id: ip + ':' + j.port, kind: j.kind, name: j.name }));
  });

  await mapLimit(urlJobs, 8, async j => {
    const content = await fetchList(j.url);
    for (const rl of content.split(/\r?\n/)) {
      const l = rl.split('#')[0].trim();
      if (!l || isUrl(l)) continue;

      const r = parseLine(l);
      if (!r || !net.isIPv4(r.host)) continue;

      adds.push({ id: r.host + ':' + r.port, kind: j.kind, name: j.name });
    }
  });

  let added = 0;

  for (const a of adds) {
    if (state.blocked[a.id]) continue;
    if (state.nodes[a.id]) continue;

    const [ip, port] = splitId(a.id);
    state.nodes[a.id] = {
      id: a.id,
      ip,
      port,
      firstSeen: now,
      firstSource: { kind: a.kind, name: a.name },
      kind: classifyIp(ip)
    };
    added++;
  }

  return added;
}

// ==================== 官方探针 ====================

async function probeLatency(u) {
  const point = {
    t: Date.now(),
    ok: false,
    off: null,
    code: null,
    colo: null,
    loc: null,
    exitIp: null,
    failReason: null
  };

  if (!u.ip) {
    point.failReason = '无有效IP';
    return point;
  }

  const probe = splitProbe(CONFIG.probeUrl);
  const ms = CONFIG.timeoutSec * 1000;

  const args = [
    '-4',
    '-k',
    '-s',
    '--noproxy', '*',
    '--retry', '0',
    '-w', '\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":"%{http_code}"}',
    '--resolve', `${probe.host}:${u.port}:${u.ip}`,
    '--connect-timeout', '3',
    '--max-time', String(CONFIG.timeoutSec + 2),
    `https://${probe.host}:${u.port}${probe.path}`
  ];

  let lat = null;
  let lastCode = 0;
  let lastOut = '';

  for (let a = 0; a < 2; a++) {
    const r = await runCurl2Args(args, ms + 2500);
    lastCode = r.code;
    lastOut = r.out || '';
    lat = parseCurlJson(lastOut);

    if (lat && lat.http && String(lat.http) !== '000') break;
  }

  const httpCode = lat && lat.http != null ? String(lat.http) : '000';
  point.code = httpCode;

  if (lat && String(lat.http) === '200') {
    const info = parseTrace(lastOut.trim().split('\n').slice(0, -1).join('\n'));

    if (!info.colo && !info.fl) {
      point.failReason = '官方探针返回非 CF 内容 (不具备反代能力)';
      return point;
    }

    point.ok = true;
    point.off = buildSegs(lat);
    point.colo = info.colo || null;
    point.loc = info.loc || null;
    point.exitIp = info.ip || null;
  } else {
    point.failReason = `不具备反代CF能力 (${httpCode !== '000' ? 'HTTP ' + httpCode : curlFailText(lastCode)})`;
  }

  return point;
}

// ==================== 自定义探针 ====================

async function probeCustoms(u) {
  const results = [];
  const ms = CONFIG.timeoutSec * 1000;

  for (const p of CONFIG.customProbes) {
    let cu;

    try {
      cu = new URL(p.url);
    } catch (e) {
      results.push({
        url: p.url,
        host: p.url,
        expect: String(p.expect || '200'),
        code: '000',
        segs: null,
        ok: false,
        failReason: '配置错误'
      });
      continue;
    }

    const expectCode = String(p.expect || '200');

    const args = [
      '-4',
      '-k',
      '-s',
      '--noproxy', '*',
      '--retry', '0',
      '-o', '/dev/null',
      '-w', '{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":"%{http_code}"}',
      '--resolve', `${cu.hostname}:${u.port}:${u.ip}`,
      '--connect-timeout', '3',
      '--max-time', String(CONFIG.timeoutSec + 2),
      `https://${cu.hostname}:${u.port}${cu.pathname}${cu.search}`
    ];

    const r = await runCurl2Args(args, ms + 2500);
    const res = parseCurlJson(r.out);
    const code = res && res.http != null ? String(res.http) : '000';
    const segs = buildSegs(res);

    let ok = false;
    let failReason = null;

    if (code === '000' && r.code !== 0) {
      failReason = `连接失败(${curlFailText(r.code)})`;
    } else if (code !== expectCode) {
      failReason = `预期${expectCode}实际${code}`;
    } else if (!segs) {
      failReason = '耗时解析失败';
    } else {
      ok = true;
    }

    results.push({
      url: p.url,
      host: cu.hostname,
      expect: expectCode,
      code,
      segs,
      ok,
      failReason
    });
  }

  const passed = results.filter(r => r.ok && r.segs);
  const agg = averageSegs(passed.map(r => r.segs));

  return { results, agg };
}

function pushHistory(id, point) {
  if (!state.history[id]) state.history[id] = [];
  state.history[id].push(point);
  if (state.history[id].length > 600) state.history[id] = state.history[id].slice(-600);
}

// ==================== 可中断流水线 ====================

async function runCycle() {
  if (state.checking) return;

  state.checking = true;
  state.abort = false;

  try {
    const added = await discover();
    if (added) log('🆕 发现 ' + added + ' 个新节点');

    state.units = Object.values(state.nodes);
    const total = state.units.length;
    state.progress = { tested: 0, total };

    log('🔄 开始检测 ' + total + ' 个节点（并发 ' + CONFIG.concurrency + '）');

    const queue = [...state.units];

    const workers = Array.from({ length: Math.min(CONFIG.concurrency, Math.max(queue.length, 1)) }, async () => {
      while (queue.length) {
        if (state.abort) return;

        const u = queue.shift();

        try {
          const lat = await probeLatency(u);

          const point = {
            t: Date.now(),
            ok: false,
            off: lat.off,
            cus: null,
            all: null,
            total: null,
            tcp: null,
            tls: null,
            src: null,
            colo: lat.colo,
            loc: lat.loc,
            exitIp: lat.exitIp,
            code: lat.code,
            failReason: lat.failReason,
            probes: [
              {
                name: '官方探针',
                type: 'official',
                url: CONFIG.probeUrl,
                ok: lat.ok,
                code: lat.code,
                segs: lat.off,
                failReason: lat.failReason
              }
            ],
            customResults: []
          };

          if (lat.ok) {
            if (CONFIG.customProbes.length) {
              const cus = await probeCustoms(u);

              point.customResults = cus.results;
              point.cus = cus.agg;

              cus.results.forEach((r, i) => {
                point.probes.push({
                  name: `自定义探针${i + 1} ${r.host}`,
                  type: 'custom',
                  url: r.url,
                  ok: r.ok,
                  code: r.code,
                  segs: r.segs,
                  failReason: r.failReason
                });
              });

              const failed = cus.results.filter(r => !r.ok || !r.segs);

              if (!failed.length && cus.results.length === CONFIG.customProbes.length) {
                const allSegs = [lat.off, ...cus.results.map(r => r.segs)].filter(Boolean);
                const all = averageSegs(allSegs);

                if (all) {
                  point.ok = true;
                  point.all = all;
                  point.total = all.total;
                  point.tcp = all.tcp;
                  point.tls = all.tls;
                  point.src = all.src;
                  point.failReason = null;
                } else {
                  point.ok = false;
                  point.failReason = '探针耗时解析失败';
                }
              } else {
                point.ok = false;
                point.failReason = '探针未全部通过: ' + failed.map(r => `${r.host}(${r.failReason || ('HTTP ' + r.code)})`).join(', ');
              }
            } else {
              const all = averageSegs([lat.off].filter(Boolean));

              if (all) {
                point.ok = true;
                point.all = all;
                point.total = all.total;
                point.tcp = all.tcp;
                point.tls = all.tls;
                point.src = all.src;
                point.failReason = null;
              }
            }
          }

          if (!(state.abort && point.ok)) {
            pushHistory(u.id, point);
            state.progress.tested++;
            log((point.ok ? '✅ ' : '❌ ') + u.id + (point.ok ? (' 平均总=' + point.total + 'ms') : (' 失败: ' + point.failReason)));
          }
        } catch (e) {
          log('⚠️ ' + u.id + ' 检测异常: ' + e.message);
          state.progress.tested++;
        }
      }
    });

    await Promise.all(workers);

    if (state.abort) log('⏹ 检测已中断，完成 ' + state.progress.tested + '/' + total);

    state.lastCycle = Date.now();

    const online = state.units.filter(u => {
      const h = state.history[u.id];
      return h && h.length && h[h.length - 1].ok;
    }).length;

    const quality = state.units.filter(u => computeQuality(state.history[u.id]).quality).length;

    log('🏁 检测完成：在线 ' + online + ' / 优质 ' + quality + ' / 总数 ' + total);

    await cleanGraveyard();
    saveData();

    if (CONFIG.github.auto) {
      autoUpload().catch(e => {
        state.github.lastError = e.message;
        log('⚠️ 自动上传失败: ' + e.message);
      });
    }
  } finally {
    state.checking = false;
    state.abort = false;
  }
}

// ==================== 质量判定 ====================

function computeQuality(points) {
  const recent = (points || []).slice(-CONFIG.qualityWindow);

  if (!recent.length) {
    return {
      quality: false,
      rate: 0,
      avgTotal: null,
      avgTcp: null,
      avgTls: null,
      avgHttp: null,
      avgCus: null,
      avgOff: null,
      samples: 0
    };
  }

  const oks = recent.filter(p => p.ok);
  const rate = recent.length ? oks.length / recent.length : 0;

  const avg = fn => {
    const vals = oks.map(fn).filter(x => x != null && isFinite(x));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  const pick = (p, field) => {
    if (p.all && p.all[field] != null) return p.all[field];
    if (p.cus && p.cus[field] != null) return p.cus[field];
    if (p.off && p.off[field] != null) return p.off[field];
    return null;
  };

  const avgTotal = avg(p => p.total != null ? p.total : pick(p, 'total'));
  const avgTcp = avg(p => pick(p, 'tcp'));
  const avgTls = avg(p => pick(p, 'tls'));
  const avgHttp = avg(p => pick(p, 'src'));

  const mk = pre => {
    const total = avg(p => p[pre] && p[pre].total);
    if (total == null) return null;

    return {
      total,
      tcp: avg(p => p[pre] && p[pre].tcp),
      tls: avg(p => p[pre] && p[pre].tls),
      src: avg(p => p[pre] && p[pre].src)
    };
  };

  const avgCus = mk('cus');
  const avgOff = mk('off');

  const enough = recent.length >= CONFIG.qualityWindow;
  const latOk = CONFIG.maxTotalMs <= 0 || (avgTotal != null && avgTotal <= CONFIG.maxTotalMs);

  return {
    quality: enough && rate >= CONFIG.qualityRate && latOk,
    rate,
    avgTotal,
    avgTcp,
    avgTls,
    avgHttp,
    avgCus,
    avgOff,
    samples: recent.length
  };
}

// ==================== 清理 ====================

async function cleanGraveyard() {
  if (CONFIG.autoCleanDays <= 0) return;

  const threshold = Date.now() - CONFIG.autoCleanDays * 24 * 3600 * 1000;
  let n = 0;

  for (const id of Object.keys(state.nodes)) {
    const lastOnline = offlineSince(id);

    if (lastOnline < threshold) {
      delete state.nodes[id];
      state.blocked[id] = Date.now();
      pushGrave(id, id, lastOnline, 'auto', `离线超 ${CONFIG.autoCleanDays} 天（自动清理）`);
      delete state.history[id];
      n++;
    }
  }

  if (n) {
    capGraveyard();
    persistGraveyard();
    saveData();
    log(`🗑️ 自动清理 ${n} 个长期离线节点（已屏蔽）`);
  }
}

async function removeUnits(ids) {
  let removed = 0;

  for (const id of ids) {
    const u = state.nodes[id];
    if (!u) continue;

    const lastOnline = offlineSince(id);

    delete state.nodes[id];
    state.blocked[id] = Date.now();
    pushGrave(id, id, lastOnline, 'manual', '手动删除');
    delete state.history[id];

    removed++;
  }

  if (removed) {
    capGraveyard();
    persistGraveyard();
    saveData();
    log(`🗑️ 手动删除 ${removed} 个节点（已屏蔽）`);
  }

  return removed;
}

// ==================== GitHub ====================

function formatNodeLine(ipPort, region, q) {
  const total = q.avgTotal != null ? q.avgTotal + 'ms' : '?ms';
  return `${ipPort}#${region} | 平均总延迟 ${total}`;
}

function buildUploadData() {
  state.units = Object.values(state.nodes);

  const seen = new Map();

  state.units.filter(u => u.ip).forEach(u => {
    const hist = state.history[u.id] || [];
    const latestOk = [...hist].reverse().find(p => p.ok) || null;
    const q = computeQuality(hist);

    if (!q.quality) return;

    const k = u.ip + ':' + u.port;
    const cur = seen.get(k);

    if (!cur || (q.avgTotal ?? 999999) < (cur.q.avgTotal ?? 999999)) {
      seen.set(k, { u, q, latest: latestOk });
    }
  });

  const nodes = [...seen.values()].sort((a, b) => (a.q.avgTotal ?? 999999) - (b.q.avgTotal ?? 999999));

  const bodies = { 'all.txt': [] };

  nodes.forEach(({ u, q, latest }) => {
    const ipPort = `${u.ip}:${u.port}`;
    const region = latest ? (latest.loc || latest.colo || 'Unknown') : 'Unknown';
    const line = formatNodeLine(ipPort, region, q);

    bodies['all.txt'].push(line);

    const safe = region.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
    if (!bodies[safe + '.txt']) bodies[safe + '.txt'] = [];
    bodies[safe + '.txt'].push(line);
  });

  const fingerprint = bodies['all.txt'].join('\n');

  return { bodies, count: nodes.length, fingerprint };
}

function renderFile(lines) {
  return `# ProxyIP quality list (auto uploaded by proxy-monitor ${VERSION})\n# updated: ${new Date().toISOString()}\n# nodes: ${lines.length}\n` +
    lines.join('\n') + (lines.length ? '\n' : '');
}

async function uploadGithub() {
  if (typeof fetch !== 'function') throw new Error('当前 Node 版本缺少 fetch，无法上传 GitHub');

  const g = CONFIG.github;
  if (!g.token || !g.repo) throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');

  const { bodies, count, fingerprint } = buildUploadData();
  if (!count) throw new Error('当前没有优质节点可上传');

  const headers = {
    'Authorization': `Bearer ${g.token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'proxy-monitor',
    'Content-Type': 'application/json'
  };

  const basePath = g.path.replace(/\.txt$/, '');

  for (const [filename, lines] of Object.entries(bodies)) {
    const fullPath = `${basePath}_${filename}`;
    const apiPath = fullPath.split('/').map(encodeURIComponent).join('/');
    const api = `https://api.github.com/repos/${g.repo}/contents/${apiPath}`;

    let sha;

    try {
      const getRes = await fetch(`${api}?ref=${g.branch}`, { headers });

      if (getRes.ok) {
        sha = (await getRes.json()).sha;
      } else if (getRes.status !== 404) {
        log(`⚠️ 查询 ${fullPath} 失败: HTTP ${getRes.status}`);
        continue;
      }
    } catch (e) {
      continue;
    }

    const body = {
      message: `chore: update ${filename} (${lines.length} nodes)`,
      content: Buffer.from(renderFile(lines), 'utf8').toString('base64'),
      branch: g.branch
    };

    if (sha) body.sha = sha;

    try {
      const putRes = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });

      if (!putRes.ok) {
        log(`⚠️ 上传 ${fullPath} 失败: HTTP ${putRes.status}`);
      }
    } catch (e) {}
  }

  state.github.lastUpload = Date.now();
  state.github.lastError = null;
  state.lastUploadedContent = fingerprint;

  log(`📤 已上传 ${count} 个优质节点 (${Object.keys(bodies).length} 个文件)`);

  return { count, fileCount: Object.keys(bodies).length };
}

async function autoUpload() {
  const { fingerprint, count } = buildUploadData();

  if (!count) return;

  if (fingerprint === state.lastUploadedContent) {
    log('⏭️ 优质列表未变化，跳过上传');
    return;
  }

  await uploadGithub();
}

// ==================== API ====================

function buildState() {
  try {
    state.units = Object.values(state.nodes);

    const items = state.units.map(u => {
      const hist = state.history[u.id] || [];
      const latest = hist.length ? hist[hist.length - 1] : null;
      const latestOk = [...hist].reverse().find(p => p.ok) || null;
      const meta = latestOk || latest || {};

      return {
        id: u.id,
        label: u.id,
        ip: u.ip,
        port: u.port,
        ipKind: u.kind || classifyIp(u.ip),
        srcKind: (u.firstSource && u.firstSource.kind) || 'pure',
        srcName: (u.firstSource && u.firstSource.name) || u.id,
        firstSeen: u.firstSeen || null,
        colo: meta.colo || null,
        loc: meta.loc || null,
        exitIp: meta.exitIp || null,
        latest,
        latestOk,
        quality: computeQuality(hist),
        recent: hist.slice(-40).map(p => ({
          t: p.t,
          ok: !!p.ok,
          total: p.total,
          all: p.all || null,
          off: p.off || null,
          cus: p.cus || null,
          probes: p.probes || [],
          failReason: p.failReason || null
        }))
      };
    });

    const online = items.filter(i => i.latest && i.latest.ok).length;
    const quality = items.filter(i => i.quality.quality).length;

    return {
      version: VERSION,
      checking: state.checking,
      progress: { ...state.progress },
      lastCycle: state.lastCycle,
      intervalSec: CONFIG.intervalSec,
      config: {
        maxTotalMs: CONFIG.maxTotalMs,
        qualityWindow: CONFIG.qualityWindow,
        qualityRate: CONFIG.qualityRate,
        autoCleanDays: CONFIG.autoCleanDays,
        customProbes: CONFIG.customProbes,
        concurrency: CONFIG.concurrency
      },
      github: {
        configured: !!(CONFIG.github.token && CONFIG.github.repo),
        auto: CONFIG.github.auto,
        lastUpload: state.github.lastUpload,
        lastError: state.github.lastError,
        uploadIntervalMin: CONFIG.github.uploadIntervalMin
      },
      summary: {
        total: items.length,
        online,
        quality,
        offline: items.length - online
      },
      items
    };
  } catch (e) {
    return {
      version: VERSION,
      checking: false,
      progress: { tested: 0, total: 0 },
      lastCycle: null,
      intervalSec: CONFIG.intervalSec,
      config: {
        maxTotalMs: 0,
        qualityWindow: 10,
        qualityRate: 1,
        autoCleanDays: 7,
        customProbes: [],
        concurrency: 50
      },
      github: {
        configured: false,
        auto: false,
        lastUpload: null,
        lastError: e.message,
        uploadIntervalMin: 0
      },
      summary: { total: 0, online: 0, quality: 0, offline: 0 },
      items: []
    };
  }
}

function getHtmlFile() {
  const a = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(a)) return a;
  return path.join(__dirname, 'index.html');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  const json = (d, s = 200) => {
    res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(d));
  };

  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(getHtmlFile()));
    }

    if (p === '/api/state') return json(buildState());

    if (p === '/api/logs') return json({ logs: state.logs });

    if (p === '/api/abort' && req.method === 'POST') {
      if (state.checking) {
        state.abort = true;
        log('⏹ 收到中断请求');
      }
      return json({ ok: true });
    }

    if (p === '/api/graveyard' && req.method === 'GET') {
      return json({ graveyard: state.graveyard.list });
    }

    if (p === '/api/graveyard/clear' && req.method === 'POST') {
      state.graveyard.list = [];
      state.blocked = {};
      persistGraveyard();
      return json({ ok: true });
    }

    if (p === '/api/remove' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效节点ID' }, 400);
      return json({ ok: true, count: await removeUnits(ids) });
    }

    if (p === '/api/config' && req.method === 'GET') return json(publicConfig());

    if (p === '/api/config' && req.method === 'POST') {
      setConfig(JSON.parse(await readBody(req) || '{}'));
      persistConfig();
      restartTimer();
      log('🛠️ 配置已更新');
      runCycle().catch(e => log('⚠️ 配置更新后检测失败: ' + e.message));
      return json({ ok: true, config: publicConfig() });
    }

    if (p === '/api/ipfile' && req.method === 'GET') {
      let c = '';
      try {
        c = fs.readFileSync(CONFIG.ipFile, 'utf8');
      } catch (e) {}
      return json({ content: c });
    }

    if (p === '/api/ipfile' && req.method === 'POST') {
      const { content } = JSON.parse(await readBody(req) || '{}');

      if (!ensureIpFile()) return json({ ok: false, error: 'ip.txt 路径被占用为目录' }, 500);

      fs.writeFileSync(CONFIG.ipFile, String(content ?? ''));
      runCycle().catch(e => log('⚠️ 节点列表保存后检测失败: ' + e.message));

      return json({ ok: true, count: Object.keys(state.nodes).length });
    }

    if (p === '/api/check' && req.method === 'POST') {
      log('🖱️ 手动触发检测');
      runCycle().catch(e => log('⚠️ 手动检测失败: ' + e.message));
      return json({ ok: true });
    }

    if (p === '/api/reload' && req.method === 'POST') {
      await discover();
      state.units = Object.values(state.nodes);
      return json({ ok: true, count: state.units.length });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      try {
        return json({ ok: true, ...(await uploadGithub()) });
      } catch (e) {
        state.github.lastError = e.message;
        log('⚠️ 手动上传失败: ' + e.message);
        return json({ ok: false, error: e.message }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
});

try {
  setConfig(JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8')));
} catch (e) {}

ensureIpFile();
loadData();

server.listen(CONFIG.port, async () => {
  console.log(`🚀 Proxy Monitor ${VERSION} on http://0.0.0.0:${CONFIG.port}`);
  log(`🚀 服务启动 (${VERSION} 平均总延迟模式)`);

  await refreshCfCidrs(true);
  await discover();

  state.units = Object.values(state.nodes);

  runCycle().catch(e => log('⚠️ 启动检测失败: ' + e.message));
  restartTimer();
  restartGithubTimer();
});