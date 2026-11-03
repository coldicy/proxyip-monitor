// 常量与配置（源 server.js:11-44、97-162）
const path = require('path');
const { sanitizeUrl, isUrl } = require('./utils/text');
const { log } = require('./logger');
const { invalidate } = require('./changeBus');
const VERSION = 'v36-window';
const SPEED_RETRY_MS = 10 * 60 * 1000;
// 应用默认值一律为项目相对路径（与启动目录无关）；容器内的绝对路径由 Dockerfile 的 ENV 注入
const ROOT = path.resolve(__dirname, '..');
const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  ipFile: process.env.IP_FILE || path.join(ROOT, 'config/ip.txt'),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  intervalSec: parseInt(process.env.INTERVAL_SEC || '600', 10),
  probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
  customProbes: [],
  timeoutSec: parseInt(process.env.TIMEOUT_SEC || '5', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '20', 10),
  autoCleanDays: parseFloat(process.env.AUTO_CLEAN_DAYS || '3'),
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
  minOnlineHours: parseFloat(process.env.MIN_ONLINE_HOURS || '0'),
  github: {
    token: '',
    repo: process.env.GITHUB_REPO || '',
    path: process.env.GITHUB_PATH || 'proxyip',
    branch: process.env.GITHUB_BRANCH || 'main',
    auto: process.env.GITHUB_AUTO_UPLOAD === 'true',
    uploadIntervalMin: parseInt(process.env.GITHUB_UPLOAD_INTERVAL_MIN || '0', 10),
  },
};
CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
CONFIG.graveyardFile = path.join(CONFIG.dataDir, 'graveyard.json');
CONFIG.secretFile = path.join(CONFIG.dataDir, 'github.secret');

// restartGithubTimer 由 src/timers.js 实现，引导阶段通过 setRestartGithubTimer 注入，避免 config ↔ timers 循环依赖
let restartGithubTimerFn = () => {};
function setRestartGithubTimer(fn) {
  restartGithubTimerFn = fn;
}

// ==================== 配置 ====================
// 对 CONFIG.qualityWindow 进行取整，并保证结果在 1 到 50 之间
function historyCap() {
  return Math.min(50, Math.max(1, Math.round(CONFIG.qualityWindow) || 10));
}
// 数值类配置：阈值 / 计数 / 窗口长度，统一做范围钳制
function applyNumericConfig(o, num) {
  if (o.intervalSec != null) CONFIG.intervalSec = Math.max(5, Math.round(num(o.intervalSec, CONFIG.intervalSec)));
  if (o.timeoutSec != null) CONFIG.timeoutSec = Math.max(1, Math.round(num(o.timeoutSec, CONFIG.timeoutSec)));
  if (o.concurrency != null) CONFIG.concurrency = Math.max(1, Math.round(num(o.concurrency, CONFIG.concurrency)));
  if (o.autoCleanDays != null) CONFIG.autoCleanDays = Math.max(0, num(o.autoCleanDays, 0));
  if (o.maxTotalMs != null) CONFIG.maxTotalMs = num(o.maxTotalMs, 0);
  if (o.qualityWindow != null)
    CONFIG.qualityWindow = Math.min(50, Math.max(1, Math.round(num(o.qualityWindow, CONFIG.qualityWindow))));
  if (o.successThreshold != null)
    CONFIG.successThreshold = Math.min(1, Math.max(0, num(o.successThreshold, CONFIG.successThreshold)));
  if (o.qualThreshold != null)
    CONFIG.qualThreshold = Math.min(1, Math.max(0, num(o.qualThreshold, CONFIG.qualThreshold)));
  if (o.qualityRate != null && o.successThreshold == null && o.qualThreshold == null) {
    CONFIG.successThreshold = Math.min(1, Math.max(0, num(o.qualityRate, 1)));
    CONFIG.qualThreshold = CONFIG.successThreshold;
  }
  if (CONFIG.qualThreshold > CONFIG.successThreshold) {
    log(
      `⚠️ 达标率阈值 ${CONFIG.qualThreshold} 高于成功率阈值 ${CONFIG.successThreshold}，已自动调整为 ${CONFIG.successThreshold}`,
    );
    CONFIG.qualThreshold = CONFIG.successThreshold;
  }
  if (o.speedTimeoutSec != null)
    CONFIG.speedTimeoutSec = Math.max(3, Math.round(num(o.speedTimeoutSec, CONFIG.speedTimeoutSec)));
  if (o.speedMinMBps != null) CONFIG.speedMinMBps = Math.max(0, num(o.speedMinMBps, 0));
  if (o.speedConcurrency != null)
    CONFIG.speedConcurrency = Math.min(3, Math.max(1, Math.round(num(o.speedConcurrency, CONFIG.speedConcurrency))));
  if (o.speedPerCycle != null)
    CONFIG.speedPerCycle = Math.max(1, Math.round(num(o.speedPerCycle, CONFIG.speedPerCycle)));
  if (o.minOnlineHours != null) CONFIG.minOnlineHours = Math.max(0, num(o.minOnlineHours, 0));
}
// 端点类配置：探针 URL / 测速 URL / 测速开关，全部经 sanitizeUrl 与白名单校验
function applyEndpointConfig(o) {
  if (o.probeUrl) {
    const u = sanitizeUrl(o.probeUrl);
    if (isUrl(u)) CONFIG.probeUrl = u;
  }
  if (o.customProbes && Array.isArray(o.customProbes)) {
    CONFIG.customProbes = o.customProbes
      .filter((p) => p && p.url)
      .map((p) => ({ url: sanitizeUrl(p.url), expect: String(p.expect || '200') }))
      .filter((p) => isUrl(p.url));
  } else if (o.customProbeUrl != null) {
    const u = sanitizeUrl(o.customProbeUrl);
    if (isUrl(u)) CONFIG.customProbes = [{ url: u, expect: '204' }];
  }
  if (o.speedEnabled != null) CONFIG.speedEnabled = o.speedEnabled === true || o.speedEnabled === 'true';
  if (o.speedUrl) {
    const u = sanitizeUrl(o.speedUrl);
    if (isUrl(u)) CONFIG.speedUrl = u;
  }
}
// GitHub 同步配置：token 落盘、仓库与分支、自动上传开关
function applyGithubConfig(o, num) {
  if (!o.github) return;
  const { isMaskedToken, writeSecret } = require('./security');
  const g = o.github;
  if (g.token != null) {
    const t = String(g.token).trim();
    if (t && !isMaskedToken(t)) {
      CONFIG.github.token = t;
      writeSecret(t);
      log('🔒 GitHub Token 已更新');
    }
  }
  if (g.repo != null) CONFIG.github.repo = String(g.repo);
  if (g.path != null) CONFIG.github.path = String(g.path) || 'proxyip';
  if (g.branch != null) CONFIG.github.branch = String(g.branch) || 'main';
  if (g.auto != null) CONFIG.github.auto = g.auto === true || g.auto === 'true';
  if (g.uploadIntervalMin != null)
    CONFIG.github.uploadIntervalMin = Math.max(0, Math.round(num(g.uploadIntervalMin, 0)));
}
function setConfig(o) {
  if (!o) return;
  const num = (v, d) => {
    const n = parseFloat(v);
    return isFinite(n) ? n : d;
  };
  applyNumericConfig(o, num);
  applyEndpointConfig(o);
  applyGithubConfig(o, num);
  restartGithubTimerFn();
  invalidate();
}
function publicConfig() {
  const { maskToken } = require('./security');
  return {
    intervalSec: CONFIG.intervalSec,
    timeoutSec: CONFIG.timeoutSec,
    concurrency: CONFIG.concurrency,
    autoCleanDays: CONFIG.autoCleanDays,
    maxTotalMs: CONFIG.maxTotalMs,
    probeUrl: CONFIG.probeUrl,
    customProbes: CONFIG.customProbes,
    qualityWindow: CONFIG.qualityWindow,
    successThreshold: CONFIG.successThreshold,
    qualThreshold: CONFIG.qualThreshold,
    speedEnabled: CONFIG.speedEnabled,
    speedUrl: CONFIG.speedUrl,
    speedTimeoutSec: CONFIG.speedTimeoutSec,
    speedMinMBps: CONFIG.speedMinMBps,
    speedConcurrency: CONFIG.speedConcurrency,
    speedPerCycle: CONFIG.speedPerCycle,
    minOnlineHours: CONFIG.minOnlineHours,
    github: {
      tokenSet: !!CONFIG.github.token,
      tokenMasked: maskToken(CONFIG.github.token),
      repo: CONFIG.github.repo,
      path: CONFIG.github.path,
      branch: CONFIG.github.branch,
      auto: CONFIG.github.auto,
      uploadIntervalMin: CONFIG.github.uploadIntervalMin,
    },
  };
}
module.exports = { VERSION, SPEED_RETRY_MS, CONFIG, historyCap, setConfig, publicConfig, setRestartGithubTimer };
