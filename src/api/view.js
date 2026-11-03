// buildState 视图组装（源 server.js:745-792）
const { CONFIG, VERSION, historyCap } = require('../config');
const { state } = require('../state');
const { computeQuality } = require('../domain/quality');
const { classifyIp } = require('../domain/cidr');
// ==================== API ====================
// 前端需要的配置视图。成功与失败分支共用同一份来源，避免默认值出现第二副本并漂移
function configView() {
  return {
    maxTotalMs: CONFIG.maxTotalMs,
    qualityWindow: CONFIG.qualityWindow,
    successThreshold: CONFIG.successThreshold,
    qualThreshold: CONFIG.qualThreshold,
    autoCleanDays: CONFIG.autoCleanDays,
    customProbes: CONFIG.customProbes,
    concurrency: CONFIG.concurrency,
    speedEnabled: CONFIG.speedEnabled,
    speedMinMBps: CONFIG.speedMinMBps,
    speedUrl: CONFIG.speedUrl,
    speedTimeoutSec: CONFIG.speedTimeoutSec,
    speedConcurrency: CONFIG.speedConcurrency,
    speedPerCycle: CONFIG.speedPerCycle,
    minOnlineHours: CONFIG.minOnlineHours,
  };
}
function buildState() {
  try {
    state.units = Object.values(state.nodes);
    const cap = historyCap();
    const items = state.units.map((u) => {
      const hist = state.history[u.id] || [];
      const latest = hist.length ? hist[hist.length - 1] : null;
      return {
        id: u.id,
        label: u.id,
        ip: u.ip,
        port: u.port,
        ipKind: u.kind || classifyIp(u.ip),
        srcKind: (u.firstSource && u.firstSource.kind) || 'pure',
        srcName: (u.firstSource && u.firstSource.name) || u.id,
        firstSeen: u.firstSeen || null,
        // 新增: 连续在线起点(时间戳), 离线/从未在线为 null
        onlineSince: u.onlineSince || null,
        colo: latest ? latest.colo : null,
        loc: latest ? latest.loc : null,
        exitIp: latest ? latest.exitIp : null,
        speed: u.speed || null,
        latest,
        quality: computeQuality(hist, u.speed, u.onlineSince),
        // 只发优质窗口大小的数量
        recent: hist.slice(-cap).map((p) => ({
          t: p.t,
          ok: !!p.ok,
          total: p.total,
          off: p.off,
          cus: p.cus,
          probes: p.probes || [],
          avgTcp: p.avgTcp,
          avgTls: p.avgTls,
          avgHttp: p.avgHttp,
          failReason: p.failReason || null,
          colo: p.colo || null,
          loc: p.loc || null,
          exitIp: p.exitIp || null,
        })),
      };
    });
    const online = items.filter((i) => i.latest && i.latest.ok).length;
    const quality = items.filter((i) => i.quality.quality).length;
    return {
      version: VERSION,
      checking: state.checking,
      progress: { ...state.progress },
      lastCycle: state.lastCycle,
      intervalSec: CONFIG.intervalSec,
      config: configView(),
      github: {
        configured: !!(CONFIG.github.token && CONFIG.github.repo),
        auto: CONFIG.github.auto,
        lastUpload: state.github.lastUpload,
        lastError: state.github.lastError,
        uploadIntervalMin: CONFIG.github.uploadIntervalMin,
      },
      summary: { total: items.length, online, quality, offline: items.length - online },
      items,
    };
  } catch (e) {
    return {
      version: VERSION,
      checking: false,
      progress: { tested: 0, total: 0 },
      lastCycle: null,
      intervalSec: CONFIG.intervalSec,
      config: configView(),
      github: { configured: false, auto: false, lastUpload: null, lastError: e.message, uploadIntervalMin: 0 },
      summary: { total: 0, online: 0, quality: 0, offline: 0 },
      items: [],
    };
  }
}
module.exports = { buildState };
