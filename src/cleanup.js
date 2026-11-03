// 手动删除 + 自动清理 + 屏蔽记录（源 server.js:260、636-662）
const { CONFIG } = require('./config');
const { state, markDirty } = require('./state');
const { offlineSince } = require('./domain/history');
const { saveData, capGraveyard, persistGraveyard } = require('./storage');
const { log } = require('./logger');
function pushGrave(label, id, lastOnline, mode, reason) { state.graveyard.list.push({ id, label, removedAt: Date.now(), lastOnlineAt: lastOnline, mode, reason }); }
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
module.exports = { pushGrave, cleanGraveyard, removeUnits };
