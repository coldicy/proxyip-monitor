// /api/state 响应缓存（源 src/state.js:21-50）
// 原理：数据没变时直接返回缓存字符串，避免重复 buildState + JSON.stringify
// 检测中最少 2 秒重建一次；空闲时最少 4 秒重建一次；数据不变则永不重建
const { state } = require('../state');
const { onChange } = require('../changeBus');

let cacheJson = null; // 缓存的 JSON 字符串
let cacheTime = 0; // 上次构建时间戳
let cacheDirty = true; // 数据是否发生了变化
// buildState 由 src/api/view.js 实现，引导阶段通过 setStateBuilder 注入，避免 state ↔ api/view 循环依赖
let buildStateFn = null;

// 订阅「数据已变」信号：来自 changeBus 的 markDirty / invalidate 都会让缓存失效
onChange(() => {
  cacheDirty = true;
});

function setStateBuilder(fn) {
  buildStateFn = fn;
}

function getStateJson() {
  const now = Date.now();
  // 数据没变 → 直接返回缓存，不重建
  if (cacheJson && !cacheDirty) return cacheJson;
  // 数据变了，但距上次重建太近 → 返回旧缓存，避免高频重建
  const minInterval = state.checking ? 2000 : 4000;
  if (cacheJson && now - cacheTime < minInterval) return cacheJson;
  // 重建缓存
  cacheJson = JSON.stringify(buildStateFn());
  cacheTime = now;
  cacheDirty = false;
  return cacheJson;
}

module.exports = { setStateBuilder, getStateJson };
