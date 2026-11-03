// 样本窗口写入 + 连续在线 + 离线起点（源 server.js:240-258、481-503）
const { historyCap } = require('../config');
const { state, markDirty } = require('../state');
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
// ==================== 连续在线起点（新增） ====================
// 从最新样本倒推当前连续在线的起点; 最新样本失败/无样本返回 null;
// 仅用于启动回填与无效轮回滚后的重建(受窗口裁剪限制, 是"至少值")
function computeOnlineSince(id) {
const hist = state.history[id] || [];
if (!hist.length || !hist[hist.length - 1].ok) return null;
let i = hist.length - 1;
while (i > 0 && hist[i - 1].ok) i--;
return hist[i].t;
}
// ==================== 连续在线起点 结束 ====================
// ==================== 辅助：计算多个探针的平均值 ====================
function averageProbes(probes) {
if (!probes.length) return null;
const tcp = Math.round(probes.reduce((s, p) => s + p.tcp, 0) / probes.length);
const tls = Math.round(probes.reduce((s, p) => s + p.tls, 0) / probes.length);
const src = Math.round(probes.reduce((s, p) => s + p.src, 0) / probes.length);
return { total: tcp + tls + src, tcp, tls, src };
}
// 历史只保留窗口大小; 在线样本记录 lastOnlineAt 与连续在线起点 onlineSince
function pushHistory(id, point) {
if (!state.history[id]) state.history[id] = [];
state.history[id].push(point);
const cap = historyCap();
if (state.history[id].length > cap) state.history[id] = state.history[id].slice(-cap);
const n = state.nodes[id];
if (n && point && point.ok) {
n.lastOnlineAt = point.t;
// 新增: 失败后的首个成功样本 = 连续在线起点; 已在线则保持不变
if (!n.onlineSince) n.onlineSince = point.t;
}
// 新增: 一旦失败, 连续在线清零
if (n && point && !point.ok) n.onlineSince = null;
markDirty();
}
module.exports = { offlineSince, computeOnlineSince, averageProbes, pushHistory };
