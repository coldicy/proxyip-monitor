// 检测流水线 + 无效轮保护（源 server.js:504-597）
const { CONFIG } = require('../config');
const { state, markDirty, invalidateStateCache } = require('../state');
const { discover } = require('../nodes/discovery');
const { pushHistory, averageProbes, computeOnlineSince } = require('../domain/history');
const { computeQuality } = require('../domain/quality');
const { probeLatency } = require('../probes/latency');
const { probeCustoms } = require('../probes/custom');
const { probeSpeed, needSpeedTest } = require('../probes/speed');
const { mapLimit } = require('../utils/async');
const { cleanGraveyard } = require('../cleanup');
const { saveData } = require('../storage');
const { autoUpload } = require('../sync/github');
const { log } = require('../logger');
// ==================== 可中断流水线（两阶段: 延迟 → 测速） ====================
async function runCycle() {
if (state.checking) return; state.checking = true; state.abort = false; invalidateStateCache();
try {
const added = await discover(); if (added) log('🆕 发现 ' + added + ' 个新节点');
state.units = Object.values(state.nodes);
const total = state.units.length;
state.progress = { tested: 0, total }; invalidateStateCache();
log('🔄 开始检测 ' + total + ' 个节点（并发 ' + CONFIG.concurrency + '）');
// 新增: 记录本轮开始时间与上轮在线数, 供无效轮保护判定
const roundT = Date.now();
const prevOnline = state.units.filter(u => { const h = state.history[u.id]; return h && h.length && h[h.length - 1].ok; }).length;
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
// ==================== 无效轮保护（新增） ====================
// 上轮 ≥30% 在线、本轮全体离线、且非中断轮 → 判定为监控端网络异常(Docker重启/断网等),
// 回滚本轮写入的失败样本, 不让未正常完成的轮次污染优质窗口
if (!state.abort && total >= 10 && prevOnline >= Math.max(3, Math.round(total * 0.3))) {
const onlineNow = state.units.filter(u => { const h = state.history[u.id]; return h && h.length && h[h.length - 1].ok; }).length;
if (onlineNow === 0) {
let rolled = 0;
for (const u of state.units) {
const h = state.history[u.id];
if (h && h.length && !h[h.length - 1].ok && h[h.length - 1].t >= roundT) { h.pop(); rolled++; }
}
// 新增: 回滚失败样本后, 按剩余历史重建连续在线起点
for (const u of state.units) u.onlineSince = computeOnlineSince(u.id);
markDirty();
log(`🛡️ 无效轮保护: 上轮在线 ${prevOnline}, 本轮全体离线(判定为网络异常), 已回滚 ${rolled} 条失败样本, 不计入优质窗口`);
}
}
// ==================== 无效轮保护 结束 ====================
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
state.lastCycle = Date.now(); invalidateStateCache();
const online = state.units.filter(u => { const h = state.history[u.id]; return h && h.length && h[h.length - 1].ok; }).length;
const quality = state.units.filter(u => computeQuality(state.history[u.id], u.speed, u.onlineSince).quality).length;
log('🏁 检测完成：在线 ' + online + ' / 优质 ' + quality + ' / 总数 ' + total);
await cleanGraveyard();
saveData();
if (CONFIG.github.auto) autoUpload().catch(e => { state.github.lastError = e.message; invalidateStateCache(); log('⚠️ 自动上传失败: ' + e.message); });
} finally { state.checking = false; state.abort = false; invalidateStateCache(); }
}
module.exports = { runCycle };
