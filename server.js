/**
Proxy Monitor v37-graveyard 管理
- 新增: 手动解除/添加屏蔽 (graveyard 管理)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const dnsPromises = require('dns').promises;
const net = require('net');
const VERSION = 'v37-graveyard 管理';
const SPEED_RETRY_MS = 10 * 60 * 1000;
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
  successThreshold: parseFloat(process.env.SUCCESS_THRESHOLD || '1'),
  qualThreshold: parseFloat(process.env.QUAL_THRESHOLD || '1'),
  speedEnabled: process.env.SPEED_ENABLED !== 'false',
  speedUrl: process.env.SPEED_URL || 'https://speed.cloudflare.com/__down?bytes=20000000',
  speedTimeoutSec: parseInt(process.env.SPEED_TIMEOUT_SEC || '10', 10),
  speedMinMBps: parseFloat(process.env.SPEED_MIN_MBPS || '0'),
  speedConcurrency: Math.min(3, Math.max(1, parseInt(process.env.SPEED_CONCURRENCY || '1', 10))),
  speedPerCycle: Math.max(1, parseInt(process.env.SPEED_PER_CYCLE || '20', 10)),
  github: {
    token: '', repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip', branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true',
    uploadIntervalMin: parseInt(process.env.GITHUB_UPLOAD_INTERVAL_MIN || '0', 10)
  },
};
CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
CONFIG.graveyardFile = path.join(CONFIG.dataDir, 'graveyard.json');
CONFIG.secretFile = path.join(CONFIG.dataDir, 'github.secret');
const state = {
  units: [], nodes: {}, history: {}, blocked: {}, graveyard: { list: [] },
  cfCidrs: [], cfCidrsAt: 0,
  lastCycle: null, checking: false, abort: false, progress: { tested: 0, total: 0 }, logs: [],
  github: { lastUpload: null, lastError: null }, lastUploadedContent: ''
};
let cycleTimer = null, githubTimer = null;
let dataDirty = false;
let htmlCache = { mtime: 0, content: '' };
function log(m) { state.logs.push({ t: Date.now(), m: String(m) }); if (state.logs.length > 400) state.logs = state.logs.slice(-400); }
function markDirty() { dataDirty = true; }
// ==================== 进程级止血: 只记日志, 不让进程崩溃重启 ====================
process.on('uncaughtException', (e) => { log('💥 未捕获异常(已止血): ' + (e && e.stack ? e.stack : e)); });
process.on('unhandledRejection', (e) => { log('💥 未处理拒绝(已止血): ' + (e && e.stack ? e.stack : e)); });
// ==================== 安全工具 ====================
// 修复: 旧正则 /['"`\\s]/g 会误删字母 s; 现在只剥离 引号/反引号/反斜杠/空白
function sanitizeUrl(u) { return String(u || '').replace(/['"`\\\s]/g, ''); }
function maskToken(t) { if (!t) return ''; if (t.length <= 8) return '****'; return t.slice(0, 4) + '****' + t.slice(-4); }
function isMaskedToken(t) { return /\*{3,}/.test(String(t || '')); }
function readSecret() { try { return fs.readFileSync(CONFIG.secretFile, 'utf8').trim(); } catch (e) { return ''; } }
function writeSecret(t) {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(CONFIG.secretFile, t, { mode: 0o600 });
    try { fs.chmodSync(CONFIG.secretFile, 0o600); } catch (e) { }
  } catch (e) { log('⚠️ Token 写入失败: ' + e.message); }
}
// ==================== 配置 ====================
// 对 CONFIG.qualityWindow 进行取整，并保证结果在 1 到 50 之间
function historyCap() { return Math.min(50, Math.max(1, Math.round(CONFIG.qualityWindow) || 10)); }
function setConfig(o) {
  if (!o) return;
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  if (o.intervalSec != null) CONFIG.intervalSec = Math.max(5, Math.round(num(o.intervalSec, CONFIG.intervalSec)));
  if (o.timeoutSec != null) CONFIG.timeoutSec = Math.max(1, Math.round(num(o.timeoutSec, CONFIG.timeoutSec)));
  if (o.concurrency != null) CONFIG.concurrency = Math.max(1, Math.round(num(o.concurrency, CONFIG.concurrency)));
  if (o.autoCleanDays != null) CONFIG.autoCleanDays = Math.max(0, num(o.autoCleanDays, 0));
  if (o.maxTotalMs != null) CONFIG.maxTotalMs = num(o.maxTotalMs, 0);
  if (o.probeUrl) { const u = sanitizeUrl(o.probeUrl); if (isUrl(u)) CONFIG.probeUrl = u; }
  if (o.qualityWindow != null) CONFIG.qualityWindow = Math.min(50, Math.max(1, Math.round(num(o.qualityWindow, CONFIG.qualityWindow))));
  if (o.successThreshold != null) CONFIG.successThreshold = Math.min(1, Math.max(0, num(o.successThreshold, CONFIG.successThreshold)));
  if (o.qualThreshold != null) CONFIG.qualThreshold = Math.min(1, Math.max(0, num(o.qualThreshold, CONFIG.qualThreshold)));
  if (o.qualityRate != null && o.successThreshold == null && o.qualThreshold == null) {
    CONFIG.successThreshold = Math.min(1, Math.max(0, num(o.qualityRate, 1)));
    CONFIG.qualThreshold = CONFIG.successThreshold;
  }
  if (CONFIG.qualThreshold > CONFIG.successThreshold) {
    log(`⚠️ 达标率阈值 ${CONFIG.qualThreshold} 高于成功率阈值 ${CONFIG.successThreshold}，已自动调整为 ${CONFIG.successThreshold}`);
    CONFIG.qualThreshold = CONFIG.successThreshold;
  }
  if (o.customProbes && Array.isArray(o.customProbes)) {
    CONFIG.customProbes = o.customProbes.filter(p => p && p.url).map(p => ({ url: sanitizeUrl(p.url), expect: String(p.expect || '200') })).filter(p => isUrl(p.url));
  } else if (o.customProbeUrl != null) {
    const u = sanitizeUrl(o.customProbeUrl); if (isUrl(u)) CONFIG.customProbes = [{ url: u, expect: '204' }];
  }
  if (o.speedEnabled != null) CONFIG.speedEnabled = (o.speedEnabled === true || o.speedEnabled === 'true');
  if (o.speedUrl) { const u = sanitizeUrl(o.speedUrl); if (isUrl(u)) CONFIG.speedUrl = u; }
  if (o.speedTimeoutSec != null) CONFIG.speedTimeoutSec = Math.max(3, Math.round(num(o.speedTimeoutSec, CONFIG.speedTimeoutSec)));
  if (o.speedMinMBps != null) CONFIG.speedMinMBps = Math.max(0, num(o.speedMinMBps, 0));
  if (o.speedConcurrency != null) CONFIG.speedConcurrency = Math.min(3, Math.max(1, Math.round(num(o.speedConcurrency, CONFIG.speedConcurrency))));
  if (o.speedPerCycle != null) CONFIG.speedPerCycle = Math.max(1, Math.round(num(o.speedPerCycle, CONFIG.speedPerCycle)));
  if (o.github) {
    const g = o.github;
    if (g.token != null) {
      const t = String(g.token).trim();
      if (t && !isMaskedToken(t)) { CONFIG.github.token = t; writeSecret(t); log('🔒 GitHub Token 已更新'); }
    }
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
    intervalSec: CONFIG.intervalSec, timeoutSec: CONFIG.timeoutSec, concurrency: CONFIG.concurrency,
    autoCleanDays: CONFIG.autoCleanDays, maxTotalMs: CONFIG.maxTotalMs, probeUrl: CONFIG.probeUrl,
    customProbes: CONFIG.customProbes, qualityWindow: CONFIG.qualityWindow,
    successThreshold: CONFIG.successThreshold, qualThreshold: CONFIG.qualThreshold,
    speedEnabled: CONFIG.speedEnabled, speedUrl: CONFIG.speedUrl, speedTimeoutSec: CONFIG.speedTimeoutSec,
    speedMinMBps: CONFIG.speedMinMBps, speedConcurrency: CONFIG.speedConcurrency, speedPerCycle: CONFIG.speedPerCycle,
    github: {
      tokenSet: !!CONFIG.github.token, tokenMasked: maskToken(CONFIG.github.token),
      repo: CONFIG.github.repo, path: CONFIG.github.path, branch: CONFIG.github.branch,
      auto: CONFIG.github.auto, uploadIntervalMin: CONFIG.github.uploadIntervalMin
    }
  };
}
function persistConfig() { try { fs.mkdirSync(CONFIG.dataDir, { recursive: true }); fs.writeFileSync(CONFIG.configFile, JSON.stringify(publicConfig(), null, 2)); } catch (e) { } }
function restartTimer() { if (cycleTimer) clearInterval(cycleTimer); cycleTimer = setInterval(() => { runCycle().catch(e => log('⚠️ 周期检测异常: ' + e.message)); }, CONFIG.intervalSec * 1000); }
function restartGithubTimer() {
  if (githubTimer) clearInterval(githubTimer);
  const mins = CONFIG.github.uploadIntervalMin;
  if (mins > 0 && CONFIG.github.token && CONFIG.github.repo) {
    githubTimer = setInterval(() => {
      log('⏰ 定时触发 GitHub 上传');
      uploadGithub().catch(e => { state.github.lastError = e.message; log('⚠️ 定时上传失败: ' + e.message); });
    }, mins * 60 * 1000);
  }
}
// ==================== 工具 ====================
function splitProbe(u) { try { const x = new URL(u); return { host: x.hostname, path: x.pathname + x.search }; } catch (e) { return { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' }; } }
function isUrl(s) { return /^https?:\/\//i.test(s); }
function parseLine(raw) {
  let host = raw, port = 443;
  if (raw.startsWith('[')) { const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/); if (!m) return null; host = m[1]; if (m[2]) port = +m[2]; }
  else if (raw.includes(':') && raw.split(':').length === 2 && /^\d+$/.test(raw.split(':')[1])) { const p = raw.split(':'); host = p[0]; port = +p[1]; }
  else if (raw.includes(':')) { host = raw; }
  return { host, port };
}
function sourceKeyForLine(line) {
  if (isUrl(line)) return 'url:' + line;
  const r = parseLine(line); if (!r) return null;
  if (net.isIPv4(r.host)) return 'pure:' + r.host + ':' + r.port;
  if (net.isIPv6(r.host)) return null;
  return 'dom:' + r.host + ':' + r.port;
}
function splitId(id) { const i = id.lastIndexOf(':'); return [id.slice(0, i), +id.slice(i + 1)]; }
function runCurl(c, ms) { return new Promise(r => exec(c, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, o) => r(e ? null : o))); }
// 注意: 保留 stdout, 即使 curl 非零退出(如28超时)也带回 -w 统计, 供测速截断计算使用
function runCurl2(c, ms) { return new Promise(r => exec(c, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, o) => r({ out: o, code: e ? (e.killed ? -1 : e.code) : 0 }))); }
function curlFailText(code) {
  if (code === 28) return '超时'; if (code === 7) return '连接被拒';
  if (code === 35 || code === 60 || code === 61) return 'TLS错误';
  if (code === -1) return '进程超时/被杀'; if (code === 6) return 'DNS解析失败';
  return 'curl错误 ' + code;
}
function parseCurlJson(o) { if (!o) return null; const l = o.trim().split('\n'); try { return JSON.parse(l[l.length - 1]); } catch (e) { return null; } }
function parseTrace(t) { const p = {}; String(t || '').replace(/\r/g, '').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) p[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); return p; }
function readBody(q, max) {
  max = max || 5 * 1024 * 1024;
  return new Promise((res, rej) => {
    let d = '';
    q.on('data', c => { d += c; if (d.length > max) { rej(new Error('请求体过大')); q.destroy(); } });
    q.on('end', () => res(d));
    q.on('error', rej);
  });
}
function buildSegs(w) {
  if (!w) return null;
  const tcp = Math.round((w.tcp || 0) * 1000);
  const tls = Math.round(((w.tls || 0) - (w.tcp || 0)) * 1000);
  const total = Math.round((w.ttfb || 0) * 1000);
  let src = total - tcp - tls; if (src < 0) src = 0;
  return { tcp, tls, total: tcp + tls + src, src };
}
function ensureIpFile() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.ipFile), { recursive: true });
    let st = null; try { st = fs.statSync(CONFIG.ipFile); } catch (e) { }
    if (st && st.isDirectory()) { try { fs.rmdirSync(CONFIG.ipFile); } catch (e) { return false; } }
    if (!fs.existsSync(CONFIG.ipFile)) { fs.writeFileSync(CONFIG.ipFile, '# 每行: 纯IP / 域名 / http(s)列表源\n'); }
    return true;
  } catch (e) { return false; }
}
function persistGraveyard() { try { fs.writeFileSync(CONFIG.graveyardFile, JSON.stringify({ list: state.graveyard.list, blocked: state.blocked })); } catch (e) { } }
function loadGraveyard() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.graveyardFile, 'utf8'));
    if (Array.isArray(d)) { state.graveyard.list = d; state.blocked = {}; }
    else { state.graveyard.list = d.list || []; state.blocked = d.blocked || {}; }
  } catch (e) { state.graveyard.list = []; state.blocked = {}; }
}
function capGraveyard() { if (state.graveyard.list.length > 1000) state.graveyard.list = state.graveyard.list.slice(-1000); }
// 修复: 优先取节点注册表 lastOnlineAt, 历史裁剪后自动清理仍正确
function offlineSince(id) {
  const u = state.nodes[id];
  if (u && u.lastOnlineAt) return u.lastOnlineAt;
  const hist = state.history[id] || [];
  for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].ok) return hist[i].t; }
  if (u && u.firstSeen) return u.firstSeen;
  if (hist.length > 0) return hist[0].t;
  return Date.now();
}
function pushGrave(label, id, lastOnline, mode, reason) { state.graveyard.list.push({ id, label, removedAt: Date.now(), lastOnlineAt: lastOnline, mode, reason }); }
function saveData() {
  if (!dataDirty) return;
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    const tmp = CONFIG.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ history: state.history, nodes: state.nodes }));
    fs.renameSync(tmp, CONFIG.dataFile);
  } catch (e) { } finally { dataDirty = false; }
}
async function mapLimit(items, limit, fn) {
  const res = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => { while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx]); } });
  await Promise.all(workers); return res;
}
function timeoutPromise(ms) { return new Promise((_, rj) => setTimeout(() => rj(new Error('t')), ms)); }
async function fetchList(url) {
  const safe = url.replace(/'/g, "'\\''");
  const out = await runCurl(`curl -4 -k -s --noproxy '*' --compressed -m 20 '${safe}'`, 25000);
  if (out && out.trim()) { if (out.length > 2 * 1024 * 1024) return out.slice(0, 2 * 1024 * 1024); return out; }
  return '';
}
// ==================== CF CIDR 分类 ====================
const CF_SUPERNETS = ['103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/12', '108.162.192.0/18',
  '131.0.72.0/22', '141.101.64.0/18', '162.158.0.0/15', '172.64.0.0/13', '173.245.48.0/20',
  '188.114.96.0/20', '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17'];
function ipToInt(ip) { const p = ip.split('.').map(Number); return (p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) >>> 0; }
function cidrMatch(ip, cidr) {
  const [n, bits] = cidr.split('/'); const b = +bits;
  const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(n) & mask);
}
async function refreshCfCidrs(force) {
  if (!force && state.cfCidrs.length && (Date.now() - state.cfCidrsAt) < 12 * 3600 * 1000) return;
  let live = [];
  try {
    const res = await fetch('https://www.cloudflare.com/ips-v4');
    if (res.ok) { const txt = await res.text(); live = txt.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s)); }
  } catch (e) { log('⚠️ 获取CF IP段失败，使用内置超网: ' + e.message); }
  state.cfCidrs = [...new Set([...CF_SUPERNETS, ...live])];
  state.cfCidrsAt = Date.now();
  for (const id of Object.keys(state.nodes)) state.nodes[id].kind = classifyIp(state.nodes[id].ip);
  log('🌐 CF IP分类集合已更新: ' + state.cfCidrs.length + ' 条');
}
function classifyIp(ip) { if (!ip || !net.isIPv4(ip) || !state.cfCidrs.length) return 'unknown'; return state.cfCidrs.some(c => cidrMatch(ip, c)) ? 'cf' : 'proxy'; }
// ==================== 节点注册表迁移 ====================
function migrateNodes(disc) {
  const nodes = {};
  for (const key of Object.keys(disc || {})) {
    const e = disc[key];
    const kind = e.kind || (key.startsWith('pure:') ? 'pure' : key.startsWith('url:') ? 'url' : 'dom');
    for (const id of Object.keys(e.ids || {})) {
      const [ip, port] = splitId(id); if (!net.isIPv4(ip)) continue;
      if (!nodes[id]) nodes[id] = { id, ip, port, firstSource: { kind, name: e.name || id } };
    }
  }
  for (const id of Object.keys(state.history)) {
    const [ip, port] = splitId(id); if (!net.isIPv4(ip)) continue;
    const hist = state.history[id]; const firstSeen = hist && hist.length ? hist[0].t : Date.now();
    if (!nodes[id]) nodes[id] = { id, ip, port, firstSource: { kind: 'pure', name: id } };
    if (!nodes[id].firstSeen) nodes[id].firstSeen = firstSeen;
  }
  for (const id of Object.keys(nodes)) { if (!nodes[id].firstSeen) nodes[id].firstSeen = Date.now(); }
  return nodes;
}
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
    if (d && d.history) state.history = d.history;
    if (d && d.nodes && Object.keys(d.nodes).length) { state.nodes = d.nodes; }
    else { state.nodes = migrateNodes(d && d.disc ? d.disc : {}); }
  } catch (e) { state.nodes = migrateNodes({}); }
  loadGraveyard();
}
// 启动时回填 lastOnlineAt, 保证历史裁剪后自动清理正确
function backfillLastOnline() {
  for (const id of Object.keys(state.nodes)) {
    const u = state.nodes[id];
    if (u && !u.lastOnlineAt) {
      const hist = state.history[id] || [];
      for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].ok) { u.lastOnlineAt = hist[i].t; break; } }
    }
  }
}
// ==================== 发现(只增) ====================
async function discover() {
  await refreshCfCidrs(false);
  const now = Date.now();
  let lines = []; try { lines = fs.readFileSync(CONFIG.ipFile, 'utf8').split(/\r?\n/); } catch (e) { }
  const present = new Set(); const domJobs = [], urlJobs = []; const adds = [];
  for (const raw of lines) {
    const line = raw.split('#')[0].trim(); if (!line) continue;
    const key = sourceKeyForLine(line); if (!key || present.has(key)) continue; present.add(key);
    if (key.startsWith('pure:')) { const id = key.slice(5); adds.push({ id, kind: 'pure', name: id }); }
    else if (key.startsWith('dom:')) {
      const hp = key.slice(4); const li = hp.lastIndexOf(':');
      domJobs.push({ host: hp.slice(0, li), port: +hp.slice(li + 1), kind: 'dom', name: hp.slice(0, li) });
    }
    else { urlJobs.push({ url: key.slice(4), kind: 'url', name: key.slice(4) }); }
  }
  await mapLimit(domJobs, 20, async j => {
    let ips = []; try { ips = await Promise.race([dnsPromises.resolve4(j.host), timeoutPromise(4000)]); } catch (e) { }
    (ips || []).filter(ip => net.isIPv4(ip)).forEach(ip => adds.push({ id: ip + ':' + j.port, kind: j.kind, name: j.name }));
  });
  await mapLimit(urlJobs, 8, async j => {
    const content = await fetchList(j.url);
    for (const rl of content.split(/\r?\n/)) {
      const l = rl.split('#')[0].trim(); if (!l || isUrl(l)) continue;
      const r = parseLine(l); if (!r || !net.isIPv4(r.host)) continue;
      adds.push({ id: r.host + ':' + r.port, kind: j.kind, name: j.name });
    }
  });
  let added = 0;
  for (const a of adds) {
    if (state.blocked[a.id]) continue; if (state.nodes[a.id]) continue;
    const [ip, port] = splitId(a.id);
    state.nodes[a.id] = { id: a.id, ip, port, firstSeen: now, firstSource: { kind: a.kind, name: a.name }, kind: classifyIp(ip) };
    added++;
  }
  if (added) markDirty();
  return added;
}
// ==================== 官方探针 (uag 回显校验) ====================
async function probeLatency(u) {
  const point = { t: Date.now(), ok: false, off: null, colo: null, loc: null, exitIp: null, failReason: null };
  if (!u.ip) { point.failReason = '无有效IP'; return point; }
  const probe = splitProbe(CONFIG.probeUrl); const ms = CONFIG.timeoutSec * 1000;
  const ua = 'PM-' + Math.random().toString(36).slice(2, 10);
  const latCmd = `curl -4 -k -s --noproxy '*' --retry 0 -A '${ua}' -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec + 2} 'https://${probe.host}:${u.port}${probe.path}'`;
  let lat = null, lastCode = 0, lastOut = null;
  for (let a = 0; a < 2; a++) {
    const r = await runCurl2(latCmd, ms + 2500); lastCode = r.code; lastOut = r.out; lat = parseCurlJson(r.out);
    if (lat && lat.http && String(lat.http) !== '000') break;
  }
  if (lat && lat.http === 200) {
    const info = parseTrace(lastOut.trim().split('\n').slice(0, -1).join('\n'));
    if (!info.colo && !info.fl) { point.failReason = '官方探针返回非 CF 内容 (不具备反代能力)'; return point; }
    if (!lastOut.includes('uag=' + ua)) { point.failReason = '官方探针UA未回显 (疑似伪造trace)'; return point; }
    point.ok = true; point.off = buildSegs(lat);
    point.colo = info.colo || null; point.loc = info.loc || null; point.exitIp = info.ip || null;
  } else {
    point.failReason = `不具备反代CF能力 (${curlFailText(lastCode)})`;
  }
  return point;
}
// ==================== 自定义探针 ====================
async function probeCustoms(u) {
  const results = []; const ms = CONFIG.timeoutSec * 1000;
  for (const p of CONFIG.customProbes) {
    try {
      const cu = new URL(p.url); const expectCode = String(p.expect || '200');
      const cmd = `curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${cu.hostname}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec + 2} 'https://${cu.hostname}:${u.port}${cu.pathname}${cu.search}'`;
      const r = await runCurl2(cmd, ms + 2500);
      const res = parseCurlJson(r.out);
      const code = res ? String(res.http) : '000';
      const segs = buildSegs(res);
      let ok = false, failReason = null;
      if (code === '000' && r.code !== 0) failReason = `连接失败(${curlFailText(r.code)})`;
      else if (code !== expectCode) failReason = `预期${expectCode}实际${code}`;
      else ok = true;
      results.push({ url: p.url, host: cu.hostname, expect: expectCode, code, segs, ok, failReason });
    } catch (e) { results.push({ url: p.url, host: p.url, expect: p.expect, code: '000', segs: null, ok: false, failReason: '配置错误' }); }
  }
  return results;
}
// ==================== 一次性下载测速 (curl 平均速度) ====================
// 20MB 字节上限 + speedTimeoutSec 时间上限; speed = size/time; 超时截断(exit 28)仍输出 -w, 慢节点也能得到有效平均速度
const SPEED_MIN_BYTES = 64 * 1024; // 有效样本最低接收量
async function probeSpeed(u) {
  const point = { t: Date.now(), ok: false, mbps: null, size: null, failReason: null };
  if (!u.ip) { point.failReason = '无有效IP'; return point; }
  const sp = splitProbe(CONFIG.speedUrl);
  const timestamp = Date.now();
  const cmd = `curl -k -s --retry 0 -o /dev/null -w '{"speed":%{speed_download},"size":%{size_download},"time":%{time_total},"http":%{http_code}}' --resolve "${sp.host}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.speedTimeoutSec} 'https://${sp.host}:${u.port}${sp.path}${sp.path.includes('?') ? '&' : '?'}_t=${timestamp}'`;
  const r = await runCurl2(cmd, CONFIG.speedTimeoutSec * 1000 + 2500);
  const j = parseCurlJson(r.out);
  const size = (j && isFinite(j.size)) ? j.size : 0;
  const secs = (j && isFinite(j.time) && j.time > 0) ? j.time : 0;
  const http = j ? String(j.http) : '000';
  const kb = (size / 1024).toFixed(1);
  if (size >= SPEED_MIN_BYTES && secs > 0) {
    const raw = size / secs / 1048576;
    const mbps = Math.round(raw * 100) / 100;
    if (mbps > 0 && (http === '200' || r.code === 28 || r.code === 18)) {
      point.mbps = mbps; point.size = Math.round(size); point.ok = true; return point;
    }
    point.failReason = `测速失败 (HTTP ${http}, 收到 ${kb}KB/${secs.toFixed(1)}s, 疑似非下载响应)`;
    return point;
  }
  if (j) {
    point.failReason = `测速失败 (HTTP ${http}, 仅收到 ${kb}KB${secs > 0 ? '/' + secs.toFixed(1) + 's' : ''}${r.code && r.code !== 0 ? ', curl ' + r.code : ''})`;
  } else {
    point.failReason = `测速失败 (${curlFailText(r.code)})`;
  }
  return point;
}
// 测速闸门: 无记录→测; 成功记录→永不复测; 失败记录→间隔>10分钟才重试。是否"在线"由调用方(本轮point.ok)保证, 离线节点完全不测
function needSpeedTest(u) {
  if (!CONFIG.speedEnabled) return false;
  if (!u.speed) return true;
  if (u.speed.ok) return false;
  return (Date.now() - (u.speed.t || 0)) > SPEED_RETRY_MS;
}
// ==================== 辅助：计算多个探针的平均值 ====================
function averageProbes(probes) {
  if (!probes.length) return null;
  const tcp = Math.round(probes.reduce((s, p) => s + p.tcp, 0) / probes.length);
  const tls = Math.round(probes.reduce((s, p) => s + p.tls, 0) / probes.length);
  const src = Math.round(probes.reduce((s, p) => s + p.src, 0) / probes.length);
  return { total: tcp + tls + src, tcp, tls, src };
}
// 历史只保留窗口大小; 在线样本记录 lastOnlineAt
function pushHistory(id, point) {
  if (!state.history[id]) state.history[id] = [];
  state.history[id].push(point);
  const cap = historyCap();
  if (state.history[id].length > cap) state.history[id] = state.history[id].slice(-cap);
  const n = state.nodes[id];
  if (n && point && point.ok) n.lastOnlineAt = point.t;
  markDirty();
}
// ==================== 可中断流水线（两阶段: 延迟 → 测速） ====================
async function runCycle() {
  if (state.checking) return; state.checking = true; state.abort = false;
  try {
    const added = await discover(); if (added) log('🆕 发现 ' + added + ' 个新节点');
    state.units = Object.values(state.nodes);
    const total = state.units.length;
    state.progress = { tested: 0, total };
    log('🔄 开始检测 ' + total + ' 个节点（并发 ' + CONFIG.concurrency + '）');
    const queue = [...state.units];
    const speedCandidates = [];
    const workers = Array.from({ length: Math.min(CONFIG.concurrency, Math.max(queue.length, 1)) }, async () => {
      while (queue.length) {
        if (state.abort) return;
        const u = queue.shift();
        try {
          const lat = await probeLatency(u);
          const point = {
            t: Date.now(), ok: false, off: lat.off, cus: null, total: null, avgTcp: null, avgTls: null, avgHttp: null,
            colo: lat.colo, loc: lat.loc, exitIp: lat.exitIp, failReason: lat.failReason, probes: []
          };
          let allProbes = [];
          if (lat.ok) {
            allProbes.push({ name: 'official', ...lat.off });
            let customOk = true;
            if (CONFIG.customProbes.length) {
              const customResults = await probeCustoms(u);
              for (const r of customResults) {
                if (r.ok && r.segs) { allProbes.push({ name: r.url, ...r.segs }); }
                else { customOk = false; point.failReason = '自定义探针失败: ' + r.url + (r.failReason ? ' (' + r.failReason + ')' : ''); break; }
              }
            }
            if (customOk) {
              const avg = averageProbes(allProbes);
              if (avg) { point.total = avg.total; point.avgTcp = avg.tcp; point.avgTls = avg.tls; point.avgHttp = avg.src; point.probes = allProbes; point.ok = true; point.cus = avg; }
              else { point.failReason = '无法计算平均延迟'; }
            } else { point.ok = false; }
          }
          if (point.ok && needSpeedTest(u)) speedCandidates.push(u);
          if (!(state.abort && point.ok)) {
            pushHistory(u.id, point); state.progress.tested++;
            log((point.ok ? '✅ ' : '❌ ') + u.id + (point.ok ? (' 总=' + point.total + 'ms') : (' 失败: ' + point.failReason)));
          }
        } catch (e) {
          log('⚠️  ' + u.id + ' 检测异常: ' + e.message);
          pushHistory(u.id, { t: Date.now(), ok: false, off: null, cus: null, total: null, avgTcp: null, avgTls: null, avgHttp: null, colo: null, loc: null, exitIp: null, failReason: '检测异常: ' + e.message, probes: [] });
          state.progress.tested++;
        }
      }
    });
    await Promise.all(workers);
    if (state.abort) log('⏹ 检测已中断，完成 ' + state.progress.tested + '/' + total);
    if (!state.abort && CONFIG.speedEnabled && speedCandidates.length) {
      const batch = speedCandidates.slice(0, CONFIG.speedPerCycle);
      if (speedCandidates.length > batch.length) log(`⚡ 测速排队 ${speedCandidates.length} 个，本周期测 ${batch.length} 个（配额），其余顺延`);
      log(`⚡ 开始测速 ${batch.length} 个节点（并发 ${CONFIG.speedConcurrency}，单节点封顶 ${CONFIG.speedTimeoutSec}s）`);
      await mapLimit(batch, CONFIG.speedConcurrency, async (u) => {
        if (state.abort) return null;
        const sp = await probeSpeed(u);
        u.speed = sp; markDirty();
        log(sp.ok ? `⚡ ${u.id} 测速: ${sp.mbps} MB/s` : `⚡ ${u.id} 测速失败: ${sp.failReason}（在线时10分钟后重试）`);
        return sp;
      });
    }
    state.lastCycle = Date.now();
    const online = state.units.filter(u => { const h = state.history[u.id]; return h && h.length && h[h.length - 1].ok; }).length;
    const quality = state.units.filter(u => computeQuality(state.history[u.id], u.speed).quality).length;
    log('🏁 检测完成：在线 ' + online + ' / 优质 ' + quality + ' / 总数 ' + total);
    await cleanGraveyard();
    saveData();
    if (CONFIG.github.auto) autoUpload().catch(e => { state.github.lastError = e.message; log('⚠️ 自动上传失败: ' + e.message); });
  } finally { state.checking = false; state.abort = false; }
}
// ==================== 优质判定（含速度下限） ====================
function computeQuality(points, speed) {
  const recent = (points || []).slice(-CONFIG.qualityWindow);
  if (!recent.length) return { quality: false, rate: 0, qualRate: 0, avgTotal: null, avgTcp: null, avgTls: null, avgHttp: null, samples: 0, speedPass: true };
  const oks = recent.filter(p => p.ok);
  const rate = oks.length / recent.length;
  let qualRate = rate;
  if (CONFIG.maxTotalMs > 0) {
    const qualified = oks.filter(p => p.total != null && p.total <= CONFIG.maxTotalMs);
    qualRate = qualified.length / recent.length;
  }
  const valid = oks.filter(p => p.avgTcp != null && isFinite(p.avgTcp) && p.avgTls != null && isFinite(p.avgTls) && p.avgHttp != null && isFinite(p.avgHttp));
  let avgTcp = null, avgTls = null, avgHttp = null, avgTotal = null;
  if (valid.length > 0) {
    avgTcp = Math.round(valid.reduce((s, p) => s + p.avgTcp, 0) / valid.length);
    avgTls = Math.round(valid.reduce((s, p) => s + p.avgTls, 0) / valid.length);
    avgHttp = Math.round(valid.reduce((s, p) => s + p.avgHttp, 0) / valid.length);
    avgTotal = avgTcp + avgTls + avgHttp;
  } else {
    const totals = oks.map(p => p.total).filter(v => v != null && isFinite(v));
    if (totals.length > 0) avgTotal = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
    const tcps = oks.map(p => p.avgTcp).filter(v => v != null && isFinite(v));
    const tlss = oks.map(p => p.avgTls).filter(v => v != null && isFinite(v));
    const https = oks.map(p => p.avgHttp).filter(v => v != null && isFinite(v));
    if (tcps.length) avgTcp = Math.round(tcps.reduce((a, b) => a + b, 0) / tcps.length);
    if (tlss.length) avgTls = Math.round(tlss.reduce((a, b) => a + b, 0) / tlss.length);
    if (https.length) avgHttp = Math.round(https.reduce((a, b) => a + b, 0) / https.length);
  }
  const enough = recent.length >= CONFIG.qualityWindow;
  const minSp = CONFIG.speedEnabled ? CONFIG.speedMinMBps : 0;
  const speedPass = minSp <= 0 ? true : !!(speed && speed.ok && speed.mbps != null && speed.mbps >= minSp);
  const quality = enough && rate >= CONFIG.successThreshold && qualRate >= CONFIG.qualThreshold && speedPass;
  return { quality, rate, qualRate, avgTotal, avgTcp, avgTls, avgHttp, samples: recent.length, speedPass };
}
// ==================== 清理 ====================
async function cleanGraveyard() {
  if (CONFIG.autoCleanDays <= 0) return;
  const threshold = Date.now() - CONFIG.autoCleanDays * 24 * 3600 * 1000;
  let n = 0;
  for (const id of Object.keys(state.nodes)) {
    if (offlineSince(id) < threshold) {
      const last = offlineSince(id);
      delete state.nodes[id]; state.blocked[id] = Date.now();
      pushGrave(id, id, last, 'auto', `离线超 ${CONFIG.autoCleanDays} 天（自动清理）`);
      delete state.history[id]; n++; markDirty();
    }
  }
  if (n) { capGraveyard(); persistGraveyard(); saveData(); log(`🗑️ 自动清理 ${n} 个长期离线节点（已屏蔽）`); }
}
async function removeUnits(ids) {
  let removed = 0;
  for (const id of ids) {
    const u = state.nodes[id]; if (!u) continue;
    const last = offlineSince(id);
    delete state.nodes[id]; state.blocked[id] = Date.now();
    pushGrave(id, id, last, 'manual', '手动删除');
    delete state.history[id]; removed++; markDirty();
  }
  if (removed) { capGraveyard(); persistGraveyard(); saveData(); log(`🗑️ 手动删除 ${removed} 个节点（已屏蔽）`); }
  return removed;
}
// ==================== 格式（复制 & GitHub 上传） ====================
function formatNodeLine(ipPort, region, colo, q, speedMbps) {
  const total = q.avgTotal != null ? q.avgTotal + 'ms' : '?ms';
  const tcp = q.avgTcp != null ? q.avgTcp + 'ms' : '?ms';
  const tls = q.avgTls != null ? q.avgTls + 'ms' : '?ms';
  const http = q.avgHttp != null ? q.avgHttp + 'ms' : '?ms';
  const spd = (speedMbps != null && isFinite(speedMbps)) ? speedMbps.toFixed(2) + 'MB/s' : '?MB/s';
  return `${ipPort}#${region} | ${colo || 'Unknown'} | ${total} | ${tcp} | ${tls} | ${http} | ${spd}`;
}
function buildUploadData() {
  const seen = new Map();
  state.units.filter(u => u.ip).forEach(u => {
    const hist = state.history[u.id] || [];
    const q = computeQuality(hist, u.speed); if (!q.quality) return;
    const k = u.ip + ':' + u.port; const cur = seen.get(k);
    if (!cur || (q.avgTotal ?? 99999) < (cur.q.avgTotal ?? 99999)) seen.set(k, { u, q, hist });
  });
  const nodes = [...seen.values()].sort((a, b) => (a.q.avgTotal ?? 99999) - (b.q.avgTotal ?? 99999));
  const bodies = { 'all.txt': [] };
  nodes.forEach(({ u, q, hist }) => {
    let loc = null, colo = null;
    for (let i = hist.length - 1; i >= 0; i--) {
      const p = hist[i]; if (!p) continue;
      if (!loc && p.loc) loc = p.loc;
      if (!colo && p.colo) colo = p.colo;
      if (loc && colo) break;
    }
    const ipPort = `${u.ip}:${u.port}`;
    const region = loc || colo || 'Unknown';
    const speedMbps = (u.speed && u.speed.ok && u.speed.mbps != null) ? u.speed.mbps : null;
    const line = formatNodeLine(ipPort, region, colo, q, speedMbps);
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
  const g = CONFIG.github; if (!g.token || !g.repo) throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  const { bodies, count, fingerprint } = buildUploadData(); if (!count) throw new Error('当前没有优质节点可上传');
  const headers = { 'Authorization': `Bearer ${g.token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'proxy-monitor', 'Content-Type': 'application/json' };
  const basePath = g.path.replace(/.txt$/, '');
  let failed = 0;
  for (const [filename, lines] of Object.entries(bodies)) {
    const fullPath = `${basePath}_${filename}`;
    const apiPath = fullPath.split('/').map(encodeURIComponent).join('/');
    const api = `https://api.github.com/repos/${g.repo}/contents/${apiPath}`;
    let sha;
    try {
      const getRes = await fetch(`${api}?ref=${g.branch}`, { headers });
      if (getRes.ok) sha = (await getRes.json()).sha;
      else if (getRes.status !== 404) { failed++; log(`⚠️ 查询 ${fullPath} 失败: HTTP ${getRes.status}`); continue; }
    } catch (e) { failed++; continue; }
    const body = { message: `chore: update ${filename} (${lines.length} nodes)`, content: Buffer.from(renderFile(lines), 'utf8').toString('base64'), branch: g.branch };
    if (sha) body.sha = sha;
    try { const putRes = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) }); if (!putRes.ok) { failed++; log(`⚠️ 上传 ${fullPath} 失败: HTTP ${putRes.status}`); } } catch (e) { failed++; }
  }
  state.github.lastUpload = Date.now();
  if (failed > 0) {
    state.github.lastError = `${failed} 个文件上传失败`;
    log('⚠️ ' + state.github.lastError + '（下轮自动重试）');
  } else {
    state.github.lastError = null;
    state.lastUploadedContent = fingerprint;
    log(`📤 已上传 ${count} 个优质节点 (${Object.keys(bodies).length} 个文件)`);
  }
  return { count, fileCount: Object.keys(bodies).length, failed };
}
async function autoUpload() {
  const { fingerprint } = buildUploadData();
  if (fingerprint === state.lastUploadedContent) { log('⏭️ 优质列表未变化，跳过上传'); return; }
  await uploadGithub();
}
// ==================== API ====================
function buildState() {
  try {
    state.units = Object.values(state.nodes);
    const cap = historyCap();
    const items = state.units.map(u => {
      const hist = state.history[u.id] || []; const latest = hist.length ? hist[hist.length - 1] : null;
      return {
        id: u.id, label: u.id, ip: u.ip, port: u.port, ipKind: u.kind || classifyIp(u.ip),
        srcKind: (u.firstSource && u.firstSource.kind) || 'pure', srcName: (u.firstSource && u.firstSource.name) || u.id,
        firstSeen: u.firstSeen || null,
        colo: latest ? latest.colo : null, loc: latest ? latest.loc : null, exitIp: latest ? latest.exitIp : null,
        speed: u.speed || null,
        latest, quality: computeQuality(hist, u.speed),
        // 修改: 只发优质窗口大小的数量
        recent: hist.slice(-cap).map(p => ({
          t: p.t, ok: !!p.ok, total: p.total, off: p.off, cus: p.cus, probes: p.probes || [],
          avgTcp: p.avgTcp, avgTls: p.avgTls, avgHttp: p.avgHttp,
          failReason: p.failReason || null, colo: p.colo || null, loc: p.loc || null, exitIp: p.exitIp || null
        }))
      };
    });
    const online = items.filter(i => i.latest && i.latest.ok).length;
    const quality = items.filter(i => i.quality.quality).length;
    return {
      version: VERSION, checking: state.checking, progress: { ...state.progress }, lastCycle: state.lastCycle, intervalSec: CONFIG.intervalSec,
      config: {
        maxTotalMs: CONFIG.maxTotalMs, qualityWindow: CONFIG.qualityWindow,
        successThreshold: CONFIG.successThreshold, qualThreshold: CONFIG.qualThreshold,
        autoCleanDays: CONFIG.autoCleanDays, customProbes: CONFIG.customProbes, concurrency: CONFIG.concurrency,
        speedEnabled: CONFIG.speedEnabled, speedMinMBps: CONFIG.speedMinMBps, speedUrl: CONFIG.speedUrl,
        speedTimeoutSec: CONFIG.speedTimeoutSec, speedConcurrency: CONFIG.speedConcurrency, speedPerCycle: CONFIG.speedPerCycle
      },
      github: { configured: !!(CONFIG.github.token && CONFIG.github.repo), auto: CONFIG.github.auto, lastUpload: state.github.lastUpload, lastError: state.github.lastError, uploadIntervalMin: CONFIG.github.uploadIntervalMin },
      summary: { total: items.length, online, quality, offline: items.length - online }, items
    };
  } catch (e) {
    return {
      version: VERSION, checking: false, progress: { tested: 0, total: 0 }, lastCycle: null, intervalSec: CONFIG.intervalSec,
      config: { maxTotalMs: 0, qualityWindow: 10, successThreshold: 1, qualThreshold: 1, autoCleanDays: 7, customProbes: [], concurrency: 50, speedEnabled: true, speedMinMBps: 0, speedUrl: CONFIG.speedUrl, speedTimeoutSec: 10, speedConcurrency: 1, speedPerCycle: 20 },
      github: { configured: false, auto: false, lastUpload: null, lastError: e.message, uploadIntervalMin: 0 },
      summary: { total: 0, online: 0, quality: 0, offline: 0 }, items: []
    };
  }
}
function serveIndex(res) {
  const f = path.join(__dirname, 'public', 'index.html');
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs !== htmlCache.mtime || !htmlCache.content) htmlCache = { mtime: st.mtimeMs, content: fs.readFileSync(f, 'utf8') };
  } catch (e) {
    if (!htmlCache.content) htmlCache.content = '<h1>public/index.html 缺失</h1>';
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlCache.content);
}

// ==================== 新增屏蔽管理 API ====================
async function unblockIds(ids) {
  let removed = 0;
  for (const id of ids) {
    if (state.blocked[id]) {
      delete state.blocked[id];
      removed++;
    }
    // 从 graveyard.list 中删除对应项
    const idx = state.graveyard.list.findIndex(g => g.id === id);
    if (idx !== -1) {
      state.graveyard.list.splice(idx, 1);
      removed++;
    }
  }
  if (removed) {
    capGraveyard();
    persistGraveyard();
    markDirty();
    log(`🔓 手动解除屏蔽 ${removed} 个节点`);
  }
  return removed;
}

async function blockIds(ids) {
  let added = 0;
  const now = Date.now();
  for (const id of ids) {
    // 如果已屏蔽则跳过
    if (state.blocked[id]) continue;
    // 如果节点存在，先删除
    if (state.nodes[id]) {
      delete state.nodes[id];
      delete state.history[id];
      markDirty();
    }
    state.blocked[id] = now;
    pushGrave(id, id, now, 'manual', '手动屏蔽');
    added++;
  }
  if (added) {
    capGraveyard();
    persistGraveyard();
    markDirty();
    log(`🚫 手动屏蔽 ${added} 个节点`);
  }
  return added;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); const p = url.pathname;
  const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); };
  try {
    if (p === '/' || p === '/index.html') return serveIndex(res);
    if (p === '/api/state') return json(buildState());
    if (p === '/api/logs') return json({ logs: state.logs });
    if (p === '/api/abort' && req.method === 'POST') { if (state.checking) { state.abort = true; log('⏹ 收到中断请求'); } return json({ ok: true }); }
    if (p === '/api/graveyard' && req.method === 'GET') return json({ graveyard: state.graveyard.list });
    if (p === '/api/graveyard/clear' && req.method === 'POST') { state.graveyard.list = []; state.blocked = {}; persistGraveyard(); return json({ ok: true }); }
    // 新增：解除屏蔽
    if (p === '/api/graveyard/unblock' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效ID' }, 400);
      const count = await unblockIds(ids);
      return json({ ok: true, count });
    }
    // 新增：手动添加屏蔽
    if (p === '/api/graveyard/block' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效ID' }, 400);
      const count = await blockIds(ids);
      return json({ ok: true, count });
    }
    if (p === '/api/remove' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效节点ID' }, 400);
      return json({ ok: true, count: await removeUnits(ids) });
    }
    if (p === '/api/speedtest' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效节点ID' }, 400);
      const results = [];
      for (const id of ids.slice(0, 10)) {
        const u = state.nodes[id]; if (!u) continue;
        const sp = await probeSpeed(u); u.speed = sp; markDirty(); results.push({ id, ...sp });
        log(sp.ok ? `⚡ ${id} 手动复测: ${sp.mbps} MB/s` : `⚡ ${id} 手动复测失败: ${sp.failReason}`);
      }
      saveData();
      return json({ ok: true, results });
    }
    if (p === '/api/config' && req.method === 'GET') return json(publicConfig());
    if (p === '/api/config' && req.method === 'POST') { setConfig(JSON.parse(await readBody(req) || '{}')); persistConfig(); restartTimer(); log('🛠️ 配置已更新'); runCycle().catch(e => log('⚠️ 保存后检测异常: ' + e.message)); return json({ ok: true, config: publicConfig() }); }
    if (p === '/api/ipfile' && req.method === 'GET') { let c = ''; try { c = fs.readFileSync(CONFIG.ipFile, 'utf8'); } catch (e) { } return json({ content: c }); }
    if (p === '/api/ipfile' && req.method === 'POST') {
      const { content } = JSON.parse(await readBody(req) || '{}');
      if (!ensureIpFile()) return json({ ok: false, error: 'ip.txt 路径被占用为目录' }, 500);
      fs.writeFileSync(CONFIG.ipFile, String(content ?? '')); runCycle().catch(e => log('⚠️ 重载检测异常: ' + e.message)); return json({ ok: true, count: Object.keys(state.nodes).length });
    }
    if (p === '/api/check' && req.method === 'POST') { log('🖱️ 手动触发检测'); runCycle().catch(e => log('⚠️ 手动检测异常: ' + e.message)); return json({ ok: true }); }
    if (p === '/api/reload' && req.method === 'POST') { await discover(); state.units = Object.values(state.nodes); return json({ ok: true, count: state.units.length }); }
    if (p === '/api/upload' && req.method === 'POST') { try { return json({ ok: true, ...(await uploadGithub()) }); } catch (e) { state.github.lastError = e.message; log('⚠️ 手动上传失败: ' + e.message); return json({ ok: false, error: e.message }, 500); } }
    return json({ error: 'not found' }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
});
// ==================== 启动（含旧明文Token迁移 + lastOnlineAt回填） ====================
server.on('error', (e) => { log('💥 HTTP server 错误: ' + e.message); });
CONFIG.github.token = process.env.GITHUB_TOKEN || readSecret() || '';
try {
  const onDisk = JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8'));
  if (onDisk && onDisk.github && onDisk.github.token) {
    if (!readSecret()) writeSecret(String(onDisk.github.token));
    delete onDisk.github.token;
    try { fs.writeFileSync(CONFIG.configFile, JSON.stringify(onDisk, null, 2)); } catch (e) { }
    log('🔒 旧版明文 Token 已迁移至加密存储');
  }
  setConfig(onDisk);
} catch (e) { }
ensureIpFile(); loadData(); backfillLastOnline();
server.listen(CONFIG.port, () => {
  console.log(`🚀 Proxy Monitor ${VERSION} on http://0.0.0.0:${CONFIG.port}`);
  log(`🚀 服务启动 (${VERSION})`);
  (async () => {
    try {
      await refreshCfCidrs(true);
      await discover();
    } catch (e) { log('⚠️ 启动初始化失败(已止血): ' + e.message); }
    state.units = Object.values(state.nodes);
    runCycle().catch(e => log('⚠️ 首轮检测异常: ' + e.message));
    restartTimer(); restartGithubTimer();
  })();
});