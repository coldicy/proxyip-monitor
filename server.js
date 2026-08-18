'use strict';

/**
 * Proxy Monitor Nova v51.1
 * Node.js 原生实现，无第三方依赖
 *
 * 功能：
 * - 长期监测 Cloudflare IP / 第三方反代 IP
 * - 官方探针 + 自定义探针
 * - 优质节点筛选
 * - GitHub 自动/手动上传
 * - Web 控制台
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');

const VERSION = 'v51.1';

const envBool = (v, d = false) => {
  if (v == null) return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || '/app/config/ip.txt',
  dataDir: process.env.DATA_DIR || '/app/data',

  intervalSec: parseInt(process.env.INTERVAL_SEC || '60', 10),
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '50', 10),

  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  probeProto: ['auto', 'http', 'https'].includes(process.env.PROBE_PROTO)
    ? process.env.PROBE_PROTO
    : 'auto',

  // null = auto, true/false = 强制
  requireCf: process.env.REQUIRE_CF == null ? null : envBool(process.env.REQUIRE_CF, true),

  customProbes: [],

  autoCleanDays: parseFloat(process.env.AUTO_CLEAN_DAYS || '7'),
  maxTotalMs: parseFloat(process.env.MAX_TOTAL_MS || '0'),

  qualityWindow: parseInt(process.env.QUALITY_WINDOW || '10', 10),
  qualityRate: parseFloat(process.env.QUALITY_RATE || '1'),

  github: {
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip',
    branch: process.env.GITHUB_BRANCH || 'main',
    auto: envBool(process.env.GITHUB_AUTO_UPLOAD, false),
    uploadIntervalMin: parseInt(process.env.GITHUB_UPLOAD_INTERVAL_MIN || '0', 10),
    regionFiles: envBool(process.env.GITHUB_REGION_FILES, false),
  },
};

CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
CONFIG.graveyardFile = path.join(CONFIG.dataDir, 'graveyard.json');

const state = {
  candidates: [],
  prev: new Map(),
  history: {},
  blocked: {},
  graveyard: { list: [] },

  cfCidrs: [],
  cfCidrsAt: 0,

  ipLineCount: 0,
  lastCycle: null,
  checking: false,
  abort: false,

  progress: { tested: 0, total: 0 },
  logs: [],

  github: {
    lastUpload: null,
    lastError: null,
  },

  lastUploadedContent: '',
};

let cycleTimer = null;
let githubTimer = null;

function log(m) {
  state.logs.push({ t: Date.now(), m: String(m) });
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
}

/* ------------------------- 基础工具 ------------------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

const toNumber = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function writeFileAtomic(file, data, mode = 0o644) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch {}
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log(`⚠️ 写入文件失败 ${file}: ${e.message}`);
    return false;
  }
}

async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length || 1) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        res[i] = await fn(items[i]);
      }
    }
  );
  await Promise.all(workers);
  return res;
}

const timeoutPromise = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

async function retry(fn, retries = 3, baseMs = 400) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ------------------------- curl 执行 ------------------------- */

function runCurl(args, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killed = false;

    let child;
    try {
      child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ out: null, code: -1, killed: false, error: e.message });
    }

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > 4 * 1024 * 1024) {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
      }
    });

    child.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 1024 * 1024) {
        try { child.stderr.destroy(); } catch {}
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ out: null, code: -1, killed: false, error: err.message });
      }
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          out: stdout,
          code: killed ? -1 : (code ?? -1),
          killed,
          stderr,
        });
      }
    });
  });
}

function curlFailText(code) {
  if (code === 28) return '超时';
  if (code === 7) return '连接被拒';
  if (code === 35 || code === 60 || code === 61) return 'TLS错误';
  if (code === -1) return '进程超时/被杀';
  if (code === 6) return 'DNS解析失败';
  return `curl错误 ${code}`;
}

/* ------------------------- 解析工具 ------------------------- */

const METRIC_FORMAT = '\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}';

function parseLastJson(out) {
  if (!out) return null;
  const lines = String(out).trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        return JSON.parse(line);
      } catch {}
    }
  }
  return null;
}

function parseTrace(text) {
  const obj = {};
  String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .forEach(line => {
      const s = line.trim();
      if (!s || s.startsWith('{')) return;
      const i = s.indexOf('=');
      if (i > 0) {
        const k = s.slice(0, i).trim();
        const v = s.slice(i + 1).trim();
        if (k) obj[k] = v;
      }
    });
  return obj;
}

function splitProbeUrl(u) {
  try {
    const x = new URL(u);
    return {
      protocol: x.protocol,
      hostname: x.hostname,
      port: x.port ? parseInt(x.port, 10) : (x.protocol === 'https:' ? 443 : 80),
      path: x.pathname + x.search,
    };
  } catch {
    return {
      protocol: 'https:',
      hostname: 'www.cloudflare.com',
      port: 443,
      path: '/cdn-cgi/trace',
    };
  }
}

function protoForPort(port, preferredProtocol) {
  if (CONFIG.probeProto === 'http') return 'http:';
  if (CONFIG.probeProto === 'https') return 'https:';
  if (preferredProtocol === 'http:' && [80, 8080].includes(port)) return 'http:';
  if ([80, 8080].includes(port)) return 'http:';
  return 'https:';
}

const isUrl = s => /^https?:\/\//i.test(s);

function parseLine(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;

  let host = raw;
  let port = 443;

  if (raw.startsWith('[')) {
    const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!m) return null;
    host = m[1];
    if (m[2]) port = parseInt(m[2], 10);
  } else if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
      port = parseInt(parts[1], 10);
    } else {
      host = raw;
    }
  }

  if (!host) return null;
  if (!(port > 0 && port <= 65535)) port = 443;

  return { host, port };
}

function sourceKeyForLine(line) {
  if (isUrl(line)) return 'url:' + line;

  const r = parseLine(line);
  if (!r) return null;

  if (net.isIPv4(r.host)) return `pure:${r.host}:${r.port}`;
  if (net.isIPv6(r.host)) return null;

  return `dom:${r.host}:${r.port}`;
}

const splitId = id => {
  const i = id.lastIndexOf(':');
  return [id.slice(0, i), parseInt(id.slice(i + 1), 10)];
};

/* ------------------------- 延迟段计算 ------------------------- */

function buildSegs(w) {
  if (!w) return null;

  const tcp = Math.max(0, Math.round((w.tcp || 0) * 1000));
  const tls = Math.max(0, Math.round(((w.tls || 0) - (w.tcp || 0)) * 1000));
  const total = Math.max(0, Math.round((w.ttfb || 0) * 1000));

  return {
    tcp,
    tls,
    total,
    src: Math.max(0, total - tcp - tls),
  };
}

function penaltySegs() {
  const P = (CONFIG.timeoutSec + 2) * 1000;
  const t = Math.round(P / 3);
  return {
    tcp: t,
    tls: t,
    src: Math.max(0, P - 2 * t),
    total: P,
  };
}

function avgSegs(list) {
  const valid = (list || []).filter(Boolean);
  if (!valid.length) return penaltySegs();

  const avg = fn => {
    const vals = valid.map(fn).filter(x => typeof x === 'number' && Number.isFinite(x));
    if (!vals.length) return 0;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };

  const tcp = avg(x => x.tcp);
  const tls = avg(x => x.tls);
  const total = avg(x => x.total);

  return {
    tcp,
    tls,
    total,
    src: Math.max(0, total - tcp - tls),
  };
}

/* ------------------------- 配置 ------------------------- */

function fullConfig() {
  return {
    intervalSec: CONFIG.intervalSec,
    timeoutSec: CONFIG.timeoutSec,
    concurrency: CONFIG.concurrency,
    autoCleanDays: CONFIG.autoCleanDays,
    maxTotalMs: CONFIG.maxTotalMs,
    probeUrl: CONFIG.probeUrl,
    probeProto: CONFIG.probeProto,
    requireCf: CONFIG.requireCf,
    customProbes: CONFIG.customProbes,
    qualityWindow: CONFIG.qualityWindow,
    qualityRate: CONFIG.qualityRate,
    github: { ...CONFIG.github },
  };
}

function publicConfig() {
  const c = fullConfig();
  return {
    ...c,
    github: {
      ...c.github,
      token: '',
      tokenMasked: c.github.token ? '******' : '',
    },
  };
}

function setConfig(o) {
  if (!o || typeof o !== 'object') return;

  if (o.intervalSec != null) CONFIG.intervalSec = Math.max(5, Math.round(toNumber(o.intervalSec, CONFIG.intervalSec)));
  if (o.timeoutSec != null) CONFIG.timeoutSec = Math.max(1, Math.round(toNumber(o.timeoutSec, CONFIG.timeoutSec)));
  if (o.concurrency != null) CONFIG.concurrency = Math.max(1, Math.round(toNumber(o.concurrency, CONFIG.concurrency)));
  if (o.autoCleanDays != null) CONFIG.autoCleanDays = Math.max(0, toNumber(o.autoCleanDays, CONFIG.autoCleanDays));
  if (o.maxTotalMs != null) CONFIG.maxTotalMs = Math.max(0, toNumber(o.maxTotalMs, CONFIG.maxTotalMs));

  if (o.probeUrl != null) CONFIG.probeUrl = String(o.probeUrl).trim() || CONFIG.probeUrl;
  if (o.probeProto != null && ['auto', 'http', 'https'].includes(o.probeProto)) CONFIG.probeProto = o.probeProto;

  if (o.requireCf !== undefined) {
    if (o.requireCf === null || o.requireCf === 'auto') CONFIG.requireCf = null;
    else CONFIG.requireCf = o.requireCf === true || o.requireCf === 'true';
  }

  if (o.qualityWindow != null) CONFIG.qualityWindow = Math.max(1, Math.round(toNumber(o.qualityWindow, CONFIG.qualityWindow)));
  if (o.qualityRate != null) CONFIG.qualityRate = Math.min(1, Math.max(0, toNumber(o.qualityRate, CONFIG.qualityRate)));

  if (Array.isArray(o.customProbes)) {
    CONFIG.customProbes = o.customProbes
      .filter(p => p && p.url)
      .map(p => ({
        url: String(p.url).trim(),
        expect: String(p.expect || '200').trim(),
      }));
  }

  if (o.github && typeof o.github === 'object') {
    const g = o.github;

    if (g.token != null) CONFIG.github.token = String(g.token).trim();

    if (g.repo != null) {
      CONFIG.github.repo = String(g.repo)
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/^\/+/, '')
        .replace(/\.git$/, '')
        .trim();
    }

    if (g.path != null) CONFIG.github.path = String(g.path).trim() || 'proxyip';
    if (g.branch != null) CONFIG.github.branch = String(g.branch).trim() || 'main';

    if (g.auto != null) CONFIG.github.auto = g.auto === true || g.auto === 'true';
    if (g.uploadIntervalMin != null) CONFIG.github.uploadIntervalMin = Math.max(0, Math.round(toNumber(g.uploadIntervalMin, 0)));
    if (g.regionFiles != null) CONFIG.github.regionFiles = g.regionFiles === true || g.regionFiles === 'true';
  }

  restartGithubTimer();
}

function persistConfig() {
  writeFileAtomic(CONFIG.configFile, JSON.stringify(fullConfig(), null, 2), 0o600);
}

function loadPersistedConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8'));
    setConfig(data);
  } catch {}
}

function restartTimer() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(runCycle, CONFIG.intervalSec * 1000);
}

function restartGithubTimer() {
  if (githubTimer) clearInterval(githubTimer);
  const m = CONFIG.github.uploadIntervalMin;

  if (m > 0 && CONFIG.github.token && CONFIG.github.repo) {
    githubTimer = setInterval(() => {
      log('⏰ 定时触发 GitHub 上传');
      uploadGithub().catch(e => {
        state.github.lastError = e.message;
        log('⚠️ 定时上传失败: ' + e.message);
      });
    }, m * 60000);
  }
}

/* ------------------------- 数据加载/保存 ------------------------- */

function ensureIpFile() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.ipFile), { recursive: true });

    let st = null;
    try {
      st = fs.statSync(CONFIG.ipFile);
    } catch {}

    if (st && st.isDirectory()) {
      try {
        fs.rmdirSync(CONFIG.ipFile);
      } catch {
        return false;
      }
    }

    if (!fs.existsSync(CONFIG.ipFile)) {
      fs.writeFileSync(
        CONFIG.ipFile,
        [
          '# Proxy Monitor Nova IP 源',
          '# 每行支持：',
          '# 1. 纯IP:端口，例如 104.16.1.1:443',
          '# 2. 域名:端口，例如 example.com:443',
          '# 3. http(s) 列表源，例如 https://example.com/ip.txt',
          '',
          '104.16.1.1:443',
          '104.16.2.1:443',
          '',
        ].join('\n')
      );
    }

    return true;
  } catch {
    return false;
  }
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
  } catch {
    state.graveyard.list = [];
    state.blocked = {};
  }
}

function persistGraveyard() {
  writeFileAtomic(
    CONFIG.graveyardFile,
    JSON.stringify({
      list: state.graveyard.list,
      blocked: state.blocked,
    })
  );
}

function capGraveyard() {
  if (state.graveyard.list.length > 1000) {
    state.graveyard.list = state.graveyard.list.slice(-1000);
  }
}

function saveData() {
  writeFileAtomic(CONFIG.dataFile, JSON.stringify({ history: state.history }), 0o644);
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
    if (d && d.history && typeof d.history === 'object') {
      state.history = d.history;
    }
  } catch {
    state.history = {};
  }

  loadGraveyard();
  log(`💾 加载历史 IP: ${Object.keys(state.history).length} / 屏蔽: ${Object.keys(state.blocked).length}`);
}

/* ------------------------- Cloudflare CIDR ------------------------- */

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
  '198.41.128.0/17',
];

const ipToInt = ip => {
  const p = ip.split('.').map(Number);
  return ((p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) >>> 0);
};

function cidrMatch(ip, cidr) {
  const [n, b] = cidr.split('/');
  const bits = parseInt(b, 10);
  const mask = bits <= 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(n) & mask);
}

async function fetchText(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': `proxy-monitor-nova/${VERSION}`,
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCfCidrs(force = false) {
  if (!force && state.cfCidrs.length && Date.now() - state.cfCidrsAt < 12 * 3600 * 1000) {
    return;
  }

  let live = [];

  try {
    const text = await fetchText('https://www.cloudflare.com/ips-v4', 8000);
    live = text
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));
  } catch {
    log('⚠️ 获取 Cloudflare IP 段失败，使用内置超网');
  }

  state.cfCidrs = [...new Set([...CF_SUPERNETS, ...live])].filter(Boolean);
  state.cfCidrsAt = Date.now();
  log(`🌐 CF 分类集合: ${state.cfCidrs.length} 条`);
}

function classifyIp(ip) {
  if (!ip || !net.isIPv4(ip) || !state.cfCidrs.length) return 'unknown';
  return state.cfCidrs.some(cidr => cidrMatch(ip, cidr)) ? 'cf' : 'proxy';
}

/* ------------------------- 候选发现 ------------------------- */

async function fetchList(url) {
  const args = [
    '-4',
    '-k',
    '-s',
    '--noproxy', '*',
    '--compressed',
    '-m', '20',
    url,
  ];

  const r = await runCurl(args, 25000);
  if (r.code === 0 && r.out && r.out.trim()) {
    return r.out.length > 2 * 1024 * 1024 ? r.out.slice(0, 2 * 1024 * 1024) : r.out;
  }

  return '';
}

async function discover() {
  await refreshCfCidrs(false);

  let lines = [];
  try {
    lines = fs.readFileSync(CONFIG.ipFile, 'utf8').split(/\r?\n/);
  } catch (e) {
    log('⚠️ 读取 ip.txt 失败: ' + e.message);
  }

  const present = new Set();
  const cur = new Map();
  const domJobs = [];
  const urlJobs = [];

  let valid = 0;

  for (const raw of lines) {
    try {
      const line = raw.split('#')[0].trim();
      if (!line) continue;

      const key = sourceKeyForLine(line);
      if (!key || present.has(key)) continue;

      present.add(key);
      valid++;

      if (key.startsWith('pure:')) {
        const id = key.slice(5);
        cur.set(id, { srcKind: 'pure', srcName: id });
      } else if (key.startsWith('dom:')) {
        const hp = key.slice(4);
        const li = hp.lastIndexOf(':');
        domJobs.push({
          host: hp.slice(0, li),
          port: parseInt(hp.slice(li + 1), 10),
          srcName: hp.slice(0, li),
          srcKind: 'dom',
        });
      } else if (key.startsWith('url:')) {
        urlJobs.push(key.slice(4));
      }
    } catch {}
  }

  state.ipLineCount = valid;

  await mapLimit(domJobs, 20, async j => {
    let ips = [];
    try {
      ips = await Promise.race([
        dnsPromises.resolve4(j.host),
        timeoutPromise(4000),
      ]);
    } catch {}

    (ips || [])
      .filter(ip => net.isIPv4(ip))
      .forEach(ip => {
        const id = `${ip}:${j.port}`;
        if (!cur.has(id)) {
          cur.set(id, {
            srcKind: j.srcKind,
            srcName: j.srcName,
          });
        }
      });
  });

  const domJobs2 = [];

  await mapLimit(urlJobs, 8, async url => {
    const text = await fetchList(url);

    for (const rl of text.split(/\r?\n/)) {
      const line = rl.split('#')[0].trim();
      if (!line || isUrl(line)) continue;

      const parsed = parseLine(line);
      if (!parsed) continue;

      if (net.isIPv4(parsed.host)) {
        const id = `${parsed.host}:${parsed.port}`;
        if (!cur.has(id)) {
          cur.set(id, {
            srcKind: 'url',
            srcName: url,
          });
        }
      } else if (parsed.host && !net.isIPv6(parsed.host)) {
        domJobs2.push({
          host: parsed.host,
          port: parsed.port,
          srcKind: 'url',
          srcName: url,
        });
      }
    }
  });

  await mapLimit(domJobs2, 20, async j => {
    let ips = [];
    try {
      ips = await Promise.race([
        dnsPromises.resolve4(j.host),
        timeoutPromise(4000),
      ]);
    } catch {}

    (ips || [])
      .filter(ip => net.isIPv4(ip))
      .forEach(ip => {
        const id = `${ip}:${j.port}`;
        if (!cur.has(id)) {
          cur.set(id, {
            srcKind: j.srcKind,
            srcName: j.srcName,
          });
        }
      });
  });

  for (const id of [...cur.keys()]) {
    if (state.blocked[id]) cur.delete(id);
  }

  return cur;
}

/* ------------------------- 探针 ------------------------- */

function requireCfContent() {
  if (CONFIG.requireCf === true) return true;
  if (CONFIG.requireCf === false) return false;

  const p = splitProbeUrl(CONFIG.probeUrl);
  return /(^|\.)cloudflare\.com$/i.test(p.hostname) && p.path.includes('/cdn-cgi/trace');
}

async function probeLatency(u) {
  const point = {
    t: Date.now(),
    ok: false,
    off: penaltySegs(),
    colo: null,
    loc: null,
    exitIp: null,
    failReason: null,
  };

  if (!net.isIPv4(u.ip)) {
    point.failReason = '无效IPv4';
    return point;
  }

  const probe = splitProbeUrl(CONFIG.probeUrl);
  const protocol = protoForPort(u.port, probe.protocol);
  const targetUrl = `${protocol}//${probe.hostname}:${u.port}${probe.path}`;

  const args = [
    '-4',
    '-k',
    '-s',
    '--noproxy', '*',
    '--retry', '0',
    '-w', METRIC_FORMAT,
    '--resolve', `${probe.hostname}:${u.port}:${u.ip}`,
    '--connect-timeout', String(Math.max(1, Math.min(5, CONFIG.timeoutSec))),
    '--max-time', String(CONFIG.timeoutSec + 2),
    targetUrl,
  ];

  let out = null;
  let code = -1;
  let last = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runCurl(args, (CONFIG.timeoutSec + 5) * 1000);
    code = r.code;
    out = r.out;
    last = parseLastJson(r.out);

    if (last && String(last.http) === '200') break;
    await sleep(250 * (attempt + 1));
  }

  if (last && String(last.http) === '200') {
    const trace = parseTrace(out);

    if (requireCfContent() && !trace.colo && !trace.fl) {
      point.failReason = '探针返回非Cloudflare内容';
      return point;
    }

    point.ok = true;
    point.off = buildSegs(last);
    point.colo = trace.colo || null;
    point.loc = trace.loc || null;
    point.exitIp = trace.ip || null;
  } else {
    point.failReason = `官方探针失败(${curlFailText(code)}${last && last.http ? `, HTTP ${last.http}` : ''})`;
  }

  return point;
}

function expectMatch(actual, expect) {
  actual = String(actual || '000');
  expect = String(expect || '200').trim();

  if (!expect || expect.toLowerCase() === 'any') {
    return actual !== '000';
  }

  if (/^[1-5]xx$/i.test(expect)) {
    return actual.length === 3 && actual[0].toLowerCase() === expect[0].toLowerCase();
  }

  return actual === expect;
}

async function probeCustoms(u) {
  const results = [];

  for (const p of CONFIG.customProbes) {
    let host = String(p.url);

    try {
      const cu = new URL(p.url);
      host = cu.hostname;

      const targetUrl = `${cu.protocol}//${cu.hostname}:${u.port}${cu.pathname}${cu.search}`;
      const args = [
        '-4',
        '-k',
        '-s',
        '--noproxy', '*',
        '--retry', '0',
        '-o', '/dev/null',
        '-w', METRIC_FORMAT,
        '--resolve', `${cu.hostname}:${u.port}:${u.ip}`,
        '--connect-timeout', String(Math.max(1, Math.min(5, CONFIG.timeoutSec))),
        '--max-time', String(CONFIG.timeoutSec + 2),
        targetUrl,
      ];

      let last = null;
      let code = -1;

      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await runCurl(args, (CONFIG.timeoutSec + 5) * 1000);
        code = r.code;
        last = parseLastJson(r.out);

        if (last && String(last.http) !== '000') break;
        await sleep(200 * (attempt + 1));
      }

      const actual = last && last.http != null ? String(last.http) : '000';
      const ok = expectMatch(actual, p.expect);

      results.push({
        host,
        expect: String(p.expect || '200'),
        code: actual,
        ok,
        failReason: ok ? null : `预期${p.expect || 200}实际${actual}${code !== 0 ? `(${curlFailText(code)})` : ''}`,
        segs: ok ? buildSegs(last) : penaltySegs(),
      });
    } catch {
      results.push({
        host,
        expect: String(p.expect || '200'),
        code: '000',
        ok: false,
        failReason: '自定义探针配置错误',
        segs: penaltySegs(),
      });
    }
  }

  return results;
}

function pushHistory(id, point) {
  if (!state.history[id]) state.history[id] = [];
  state.history[id].push(point);

  if (state.history[id].length > 600) {
    state.history[id] = state.history[id].slice(-600);
  }
}

/* ------------------------- 周期检测 ------------------------- */

function offlineSince(id) {
  const h = state.history[id] || [];

  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].ok) return h[i].t;
  }

  return h.length ? h[0].t : Date.now();
}

async function runCycle() {
  if (state.checking) return;

  state.checking = true;
  state.abort = false;

  try {
    const cur = await discover();
    const currentIds = new Set(cur.keys());

    const union = new Map();

    for (const [k, v] of state.prev) {
      if (!state.blocked[k]) union.set(k, v);
    }

    for (const [k, v] of cur) {
      union.set(k, v);
    }

    state.prev = cur;

    state.candidates = [...union.entries()].map(([id, a]) => {
      const [ip, port] = splitId(id);
      return {
        id,
        ip,
        port,
        srcKind: a.srcKind,
        srcName: a.srcName,
        kind: classifyIp(ip),
      };
    });

    const total = state.candidates.length;
    state.progress = { tested: 0, total };

    log(`🔄 开始检测 ${total} 个节点，并发 ${CONFIG.concurrency}`);

    const queue = state.candidates.slice();
    let index = 0;

    const workerCount = Math.min(CONFIG.concurrency, Math.max(1, queue.length));

    const workers = Array.from({ length: workerCount }, async () => {
      while (index < queue.length) {
        if (state.abort) break;

        const u = queue[index++];

        try {
          const lat = await probeLatency(u);

          let cus;
          if (lat.ok && CONFIG.customProbes.length) {
            cus = await probeCustoms(u);
          } else {
            cus = CONFIG.customProbes.map(p => {
              let host = String(p.url);
              try {
                host = new URL(p.url).hostname;
              } catch {}

              return {
                host,
                ok: false,
                failReason: '官方探针失败',
                segs: penaltySegs(),
              };
            });
          }

          const all = avgSegs([lat.off, ...cus.map(r => r.segs)]);
          const online = CONFIG.customProbes.length
            ? (lat.ok && cus.some(r => r.ok))
            : lat.ok;

          let failReason = null;
          if (!lat.ok) {
            failReason = lat.failReason;
          } else if (CONFIG.customProbes.length && !cus.some(r => r.ok)) {
            failReason = '自定义探针未达标: ' + cus.map(r => `${r.host}(${r.failReason || '失败'})`).join(', ');
          }

          const point = {
            t: Date.now(),
            ok: online,
            off: lat.off,
            cus,
            all,
            total: all ? all.total : null,
            colo: lat.colo,
            loc: lat.loc,
            exitIp: lat.exitIp,
            failReason,
          };

          if (!state.abort) {
            pushHistory(u.id, point);
            state.progress.tested++;

            if (point.ok) {
              log(`✅ ${u.id} 总=${point.total}ms`);
            } else {
              log(`❌ ${u.id} 失败: ${point.failReason}`);
            }
          } else {
            state.progress.tested++;
          }
        } catch (e) {
          state.progress.tested++;
          log(`⚠️ ${u.id} 异常: ${e.message}`);
        }
      }
    });

    await Promise.all(workers);

    if (state.abort) {
      log(`⏹ 已中断，完成 ${state.progress.tested}/${total}`);
    }

    state.lastCycle = Date.now();

    if (CONFIG.autoCleanDays > 0) {
      const threshold = Date.now() - CONFIG.autoCleanDays * 24 * 3600 * 1000;
      let n = 0;

      for (const id of Object.keys(state.history)) {
        if (!currentIds.has(id) && offlineSince(id) < threshold) {
          delete state.history[id];
          n++;
        }
      }

      if (n) log(`🧹 修剪 ${n} 个无引用长期离线孤儿历史`);
    }

    const online = state.candidates.filter(u => {
      const h = state.history[u.id];
      return h && h.length && h[h.length - 1].ok;
    }).length;

    const quality = state.candidates.filter(u => computeQuality(state.history[u.id]).quality).length;

    log(`🏁 在线 ${online} / 优质 ${quality} / 总数 ${total}`);

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

/* ------------------------- 质量计算 ------------------------- */

function computeQuality(points) {
  const recent = (points || []).slice(-CONFIG.qualityWindow);

  if (!recent.length) {
    return {
      quality: false,
      rate: 0,
      avgAll: null,
      samples: 0,
    };
  }

  const oks = recent.filter(p => p.ok);
  const rate = oks.length / recent.length;

  const avg = key => {
    const vals = recent
      .map(p => p.all && p.all[key])
      .filter(v => typeof v === 'number' && Number.isFinite(v));

    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };

  const avgAll = {
    total: avg('total'),
    tcp: avg('tcp'),
    tls: avg('tls'),
    src: avg('src'),
  };

  const enough = recent.length >= CONFIG.qualityWindow;
  const latOk = CONFIG.maxTotalMs <= 0 || (avgAll.total != null && avgAll.total <= CONFIG.maxTotalMs);

  return {
    quality: enough && rate >= CONFIG.qualityRate && latOk,
    rate,
    avgAll,
    samples: recent.length,
  };
}

/* ------------------------- 删除/屏蔽 ------------------------- */

function pushGrave(label, id, lastOnline, mode, reason) {
  state.graveyard.list.push({
    id,
    label,
    removedAt: Date.now(),
    lastOnlineAt: lastOnline,
    mode,
    reason,
  });
}

async function removeUnits(ids) {
  let removed = 0;
  const pure = new Set();

  for (const id of ids) {
    if (state.blocked[id]) continue;

    state.blocked[id] = Date.now();
    pushGrave(id, id, offlineSince(id), 'manual', '手动删除');

    delete state.history[id];
    pure.add(id);

    removed++;
  }

  if (removed) {
    try {
      const text = fs.readFileSync(CONFIG.ipFile, 'utf8');

      const kept = text.split(/\r?\n/).filter(line => {
        const raw = line.split('#')[0].trim();
        if (!raw) return true;

        const key = sourceKeyForLine(raw);
        if (key && key.startsWith('pure:') && pure.has(key.slice(5))) {
          return false;
        }

        return true;
      });

      writeFileAtomic(CONFIG.ipFile, kept.join('\n'));
    } catch {}

    capGraveyard();
    persistGraveyard();
    saveData();

    log(`🗑️ 手动删除 ${removed} 个节点`);
  }

  return removed;
}

/* ------------------------- GitHub 上传 ------------------------- */

function formatNodeLine({ u, q, latest }) {
  const region = (latest && (latest.loc || latest.colo)) || u.kind || 'Unknown';
  const total = q.avgAll && q.avgAll.total != null ? `${q.avgAll.total}ms` : '?ms';
  const tls = q.avgAll && q.avgAll.tls != null ? `${q.avgAll.tls}ms` : '?ms';

  return `${u.ip}:${u.port}#${region} | ${total} | ${tls}`;
}

function buildUploadData() {
  const nodes = [];

  for (const u of state.candidates) {
    if (!u.ip) continue;

    const h = state.history[u.id] || [];
    const latest = h.length ? h[h.length - 1] : null;
    const q = computeQuality(h);

    if (!q.quality) continue;

    nodes.push({ u, q, latest });
  }

  nodes.sort((a, b) => {
    const at = (a.q.avgAll && a.q.avgAll.total) ?? 99999999;
    const bt = (b.q.avgAll && b.q.avgAll.total) ?? 99999999;

    if (at !== bt) return at - bt;
    if (a.q.rate !== b.q.rate) return b.q.rate - a.q.rate;

    return (b.q.samples || 0) - (a.q.samples || 0);
  });

  const all = nodes.map(n => formatNodeLine(n));

  const bodies = {
    'all.txt': all,
  };

  if (nodes.length) {
    bodies['best.txt'] = [all[0]];

    const cf = nodes.find(n => n.u.kind === 'cf');
    if (cf) bodies['cf_best.txt'] = [formatNodeLine(cf)];

    const proxy = nodes.find(n => n.u.kind === 'proxy');
    if (proxy) bodies['proxy_best.txt'] = [formatNodeLine(proxy)];
  }

  if (CONFIG.github.regionFiles) {
    nodes.forEach(n => {
      const region = String((n.latest && (n.latest.loc || n.latest.colo)) || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '') || 'unknown';

      const fn = `${region}.txt`;
      if (!bodies[fn]) bodies[fn] = [];
      bodies[fn].push(formatNodeLine(n));
    });
  }

  return {
    bodies,
    count: nodes.length,
    fingerprint: JSON.stringify(bodies),
  };
}

function githubFilePath(fn) {
  const base = String(CONFIG.github.path || 'proxyip')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.txt$/, '');

  return base ? `${base}_${fn}` : fn;
}

async function uploadOneGithubFile(fullPath, lines, fn) {
  const g = CONFIG.github;

  const apiPath = fullPath
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const apiUrl = `https://api.github.com/repos/${g.repo}/contents/${apiPath}`;

  const headers = {
    Authorization: `Bearer ${g.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': `proxy-monitor-nova/${VERSION}`,
    'Content-Type': 'application/json',
  };

  const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(g.branch)}`, { headers });

  let sha;

  if (getRes.ok) {
    const j = await getRes.json();
    sha = j.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`查询文件失败 HTTP ${getRes.status}`);
  }

  const content = [
    `# Proxy Monitor Nova ${VERSION}`,
    `# updated: ${new Date().toISOString()}`,
    `# nodes: ${lines.length}`,
    '',
    ...lines,
    '',
  ].join('\n');

  const body = {
    message: `chore: update ${fn} (${lines.length} nodes)`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: g.branch,
  };

  if (sha) body.sha = sha;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    let msg = `HTTP ${putRes.status}`;
    try {
      const j = await putRes.json();
      if (j.message) msg += ` ${j.message}`;
    } catch {}
    throw new Error(msg);
  }
}

async function uploadGithubWithData(data) {
  const g = CONFIG.github;

  if (!g.token || !g.repo) {
    throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  }

  if (!data.count) {
    throw new Error('当前没有优质节点可上传');
  }

  let uploaded = 0;
  let failed = 0;
  let lastError = null;

  for (const [fn, lines] of Object.entries(data.bodies)) {
    if (!lines || !lines.length) continue;

    const fullPath = githubFilePath(fn);

    try {
      await retry(() => uploadOneGithubFile(fullPath, lines, fn), 2, 500);
      uploaded++;
      log(`📤 已上传 ${fullPath}`);
    } catch (e) {
      failed++;
      lastError = e.message;
      log(`⚠️ 上传 ${fullPath} 失败: ${e.message}`);
    }
  }

  if (!uploaded) {
    throw lastError ? new Error(lastError) : new Error('GitHub 上传失败');
  }

  state.github.lastUpload = Date.now();
  state.github.lastError = failed ? `${failed} 个文件失败: ${lastError}` : null;
  state.lastUploadedContent = data.fingerprint;

  log(`📤 已上传 ${data.count} 个优质节点，成功 ${uploaded} 个文件，失败 ${failed} 个文件`);

  return {
    count: data.count,
    files: uploaded,
    failed,
  };
}

async function uploadGithub() {
  const data = buildUploadData();
  return uploadGithubWithData(data);
}

async function autoUpload() {
  const data = buildUploadData();

  if (!data.count) {
    log('⏭️ 当前无优质节点，跳过上传');
    return;
  }

  if (data.fingerprint === state.lastUploadedContent) {
    log('⏭️ 优质列表未变化，跳过上传');
    return;
  }

  await uploadGithubWithData(data);
}

/* ------------------------- Web API ------------------------- */

function buildState() {
  try {
    const items = state.candidates.map(u => {
      const h = state.history[u.id] || [];
      const latest = h.length ? h[h.length - 1] : null;

      return {
        id: u.id,
        label: u.id,
        ip: u.ip,
        port: u.port,
        kind: u.kind || classifyIp(u.ip),
        srcKind: u.srcKind || 'pure',
        srcName: u.srcName || u.id,

        firstSeen: h.length ? h[0].t : null,
        colo: latest ? latest.colo : null,
        loc: latest ? latest.loc : null,
        exitIp: latest ? latest.exitIp : null,

        latest,
        quality: computeQuality(h),

        recent: h.slice(-40).map(p => ({
          t: p.t,
          ok: !!p.ok,
          total: p.total != null ? p.total : null,
          off: p.off && p.off.total != null ? p.off.total : null,
          all: p.all && p.all.total != null ? p.all.total : null,
        })),
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
      ipLineCount: state.ipLineCount,
      nodeCount: items.length,

      config: {
        maxTotalMs: CONFIG.maxTotalMs,
        qualityWindow: CONFIG.qualityWindow,
        qualityRate: CONFIG.qualityRate,
        autoCleanDays: CONFIG.autoCleanDays,
        customProbes: CONFIG.customProbes,
        concurrency: CONFIG.concurrency,
        probeUrl: CONFIG.probeUrl,
        probeProto: CONFIG.probeProto,
        requireCf: CONFIG.requireCf,
      },

      github: {
        configured: !!(CONFIG.github.token && CONFIG.github.repo),
        auto: CONFIG.github.auto,
        lastUpload: state.github.lastUpload,
        lastError: state.github.lastError,
        uploadIntervalMin: CONFIG.github.uploadIntervalMin,
        regionFiles: CONFIG.github.regionFiles,
      },

      summary: {
        total: items.length,
        online,
        quality,
        offline: items.length - online,
      },

      items,
    };
  } catch (e) {
    return {
      version: VERSION,
      checking: false,
      progress: { tested: 0, total: 0 },
      lastCycle: null,
      intervalSec: CONFIG.intervalSec,
      ipLineCount: state.ipLineCount,
      nodeCount: 0,

      config: {
        maxTotalMs: 0,
        qualityWindow: 10,
        qualityRate: 1,
        autoCleanDays: 7,
        customProbes: [],
        concurrency: 50,
        probeUrl: CONFIG.probeUrl,
        probeProto: CONFIG.probeProto,
        requireCf: CONFIG.requireCf,
      },

      github: {
        configured: false,
        auto: false,
        lastUpload: null,
        lastError: e.message,
        uploadIntervalMin: 0,
        regionFiles: false,
      },

      summary: {
        total: 0,
        online: 0,
        quality: 0,
        offline: 0,
      },

      items: [],
    };
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';

    req.on('data', chunk => {
      size += chunk.length;

      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }

      data += chunk;
    });

    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const text = await readBody(req);
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  const json = (d, s = 200) => {
    res.writeHead(s, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(d));
  };

  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    if (p === '/healthz') {
      return json({ ok: true, version: VERSION });
    }

    if (p === '/api/state') {
      return json(buildState());
    }

    if (p === '/api/logs') {
      return json({ logs: state.logs.slice().reverse() });
    }

    if (p === '/api/abort' && req.method === 'POST') {
      if (state.checking) {
        state.abort = true;
        log('⏹ 收到中断请求');
      }
      return json({ ok: true });
    }

    if (p === '/api/graveyard' && req.method === 'GET') {
      return json({
        graveyard: state.graveyard.list,
        blockedCount: Object.keys(state.blocked).length,
      });
    }

    if (p === '/api/graveyard/clear' && req.method === 'POST') {
      state.graveyard.list = [];
      state.blocked = {};
      persistGraveyard();
      log('♻️ 已清空记录并解除全部屏蔽');
      return json({ ok: true });
    }

    if (p === '/api/remove' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const ids = body.ids;

      if (!Array.isArray(ids) || !ids.length) {
        return json({ ok: false, error: '无有效ID' }, 400);
      }

      const count = await removeUnits(ids);
      return json({ ok: true, count });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return json(publicConfig());
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      setConfig(body);
      persistConfig();
      restartTimer();
      log('🛠️ 配置已更新');
      runCycle();
      return json({ ok: true, config: publicConfig() });
    }

    if (p === '/api/ipfile' && req.method === 'GET') {
      let content = '';
      try {
        content = fs.readFileSync(CONFIG.ipFile, 'utf8');
      } catch {}
      return json({ content });
    }

    if (p === '/api/ipfile' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const content = body.content;

      if (!ensureIpFile()) {
        return json({ ok: false, error: 'ip.txt 被占用为目录' }, 500);
      }

      writeFileAtomic(CONFIG.ipFile, String(content ?? ''));
      log('📄 ip.txt 已保存');
      runCycle();

      return json({ ok: true });
    }

    if (p === '/api/check' && req.method === 'POST') {
      log('🖱️ 手动触发检测');
      runCycle();
      return json({ ok: true });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      try {
        const r = await uploadGithub();
        return json({ ok: true, ...r });
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

/* ------------------------- 启动 ------------------------- */

process.on('unhandledRejection', err => {
  log('⚠️ unhandledRejection: ' + (err && err.message ? err.message : String(err)));
});

process.on('uncaughtException', err => {
  log('💥 uncaughtException: ' + (err && err.message ? err.message : String(err)));
  saveData();
  setTimeout(() => process.exit(1), 500).unref();
});

function shutdown() {
  log('👋 收到退出信号');
  clearInterval(cycleTimer);
  clearInterval(githubTimer);
  saveData();

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loadPersistedConfig();
ensureIpFile();
loadData();

server.listen(CONFIG.port, async () => {
  console.log(`🚀 Proxy Monitor Nova ${VERSION} listening on :${CONFIG.port}`);
  log(`🚀 启动 ${VERSION}`);

  await refreshCfCidrs(true);

  try {
    const cur = await discover();
    state.prev = cur;

    state.candidates = [...cur.entries()].map(([id, a]) => {
      const [ip, port] = splitId(id);
      return {
        id,
        ip,
        port,
        srcKind: a.srcKind,
        srcName: a.srcName,
        kind: classifyIp(ip),
      };
    });

    log(`📄 ip.txt 有效行: ${state.ipLineCount} · 初始候选: ${state.candidates.length}`);
  } catch (e) {
    log('⚠️ 初始化发现失败: ' + e.message);
  }

  runCycle();
  restartTimer();
  restartGithubTimer();
});