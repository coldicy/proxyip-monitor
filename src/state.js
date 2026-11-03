// 全局可变状态 + /api/state 响应缓存（源 server.js:45-62、64-77、80）
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
  lastUploadedContent: '',
};
let dataDirty = false;
let htmlCache = { mtime: 0, content: '' };

// ==================== /api/state 响应缓存（性能优化） ====================
// 原理：数据没变时直接返回缓存字符串，避免重复 buildState + JSON.stringify
// 检测中最少 2 秒重建一次；空闲时最少 4 秒重建一次；数据不变则永不重建
let stateCacheJson = null; // 缓存的 JSON 字符串
let stateCacheTime = 0; // 上次构建时间戳
let stateCacheDirty = true; // 数据是否发生了变化
// buildState 由 src/api/view.js 实现，引导阶段通过 setStateBuilder 注入，避免 state ↔ api/view 循环依赖
let buildStateFn = null;

function setStateBuilder(fn) {
  buildStateFn = fn;
}
function invalidateStateCache() {
  stateCacheDirty = true;
}

function getStateJson() {
  const now = Date.now();
  // 数据没变 → 直接返回缓存，不重建
  if (stateCacheJson && !stateCacheDirty) return stateCacheJson;
  // 数据变了，但距上次重建太近 → 返回旧缓存，避免高频重建
  const minInterval = state.checking ? 2000 : 4000;
  if (stateCacheJson && now - stateCacheTime < minInterval) return stateCacheJson;
  // 重建缓存
  stateCacheJson = JSON.stringify(buildStateFn());
  stateCacheTime = now;
  stateCacheDirty = false;
  return stateCacheJson;
}
// ==================== /api/state 响应缓存 结束 ====================

function markDirty() {
  dataDirty = true;
  invalidateStateCache();
}
function isDataDirty() {
  return dataDirty;
}
function clearDataDirty() {
  dataDirty = false;
}

module.exports = {
  state,
  markDirty,
  invalidateStateCache,
  getStateJson,
  htmlCache,
  setStateBuilder,
  isDataDirty,
  clearDataDirty,
};
