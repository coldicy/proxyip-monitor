// 节点注册表迁移与回填（源 server.js:320-339、349-360）
const net = require('net');
const { state } = require('../state');
const { splitId } = require('../utils/text');
const { computeOnlineSince } = require('../domain/history');
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
// 启动时回填 lastOnlineAt, 保证历史裁剪后自动清理正确
function backfillLastOnline() {
  for (const id of Object.keys(state.nodes)) {
    const u = state.nodes[id];
    if (u && !u.lastOnlineAt) {
      const hist = state.history[id] || [];
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].ok) {
          u.lastOnlineAt = hist[i].t;
          break;
        }
      }
    }
    // 新增: 旧数据无 onlineSince 字段时, 按现有历史回填连续在线起点
    if (u && u.onlineSince === undefined) u.onlineSince = computeOnlineSince(id);
  }
}
module.exports = { migrateNodes, backfillLastOnline };
