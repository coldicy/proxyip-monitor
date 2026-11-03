// 全局可变状态（纯数据容器）
// 历史版本这里还混装了另外三类职责，批次 6 已分别迁出：
//   - 持久化脏位与「数据已变」信号 → src/changeBus.js
//   - /api/state 响应缓存         → src/api/stateCache.js
//   - index.html 文件缓存         → src/api/server.js（就地私有）
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

module.exports = { state };
