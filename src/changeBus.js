// 数据变更总线：全应用唯一的「数据已变」信号源
// 这是一个零依赖叶子模块 —— 供基础层（config / storage / timers）与接口层共同引用。
// 它同时解决了两个结构问题：
//   1. 持久化脏位若下移到 storage.js，会形成 state ↔ storage 循环依赖（storage 已依赖 state）
//   2. 响应缓存若抽到 api 层，基础层调用它就成了「基础层 → api 层」的分层倒置
// 通过「基础层只发信号、api 层订阅」的方式，依赖方向保持完全单向。
let dataDirty = false;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

// 数据已变：置持久化脏位 + 通知订阅者（如响应缓存失效）
function markDirty() {
  dataDirty = true;
  emit();
}

// 仅通知订阅者，不改持久化脏位（用于只影响展示数据、无需落盘的变更）
function invalidate() {
  emit();
}

function isDataDirty() {
  return dataDirty;
}

function clearDataDirty() {
  dataDirty = false;
}

function onChange(fn) {
  listeners.add(fn);
}

module.exports = { markDirty, invalidate, isDataDirty, clearDataDirty, onChange };
