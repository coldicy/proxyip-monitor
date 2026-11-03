# ADR 0002: 以「订阅式信号总线」切分 state 的混装职责

Status: Accepted
Date: 2026-11-03

## Context

ADR 0001 完成前后端模块化后，`src/state.js` 仍是一个「什么都往里放」的模块（72 行），同时承担四类互不相关的职责：

1. **全局可变数据容器** `state`（14 个字段）；
2. **持久化脏位** `dataDirty`（仅 `storage.saveData` 关心）；
3. **`/api/state` 响应缓存** `stateCacheJson / stateCacheTime / stateCacheDirty / buildStateFn` 与 `setStateBuilder / getStateJson`；
4. **`index.html` 文件缓存** `htmlCache`（仅静态服务使用）。

这属于典型的 Divergent Change：任何一类职责变化都会触碰同一个文件，且四者之间没有内聚关系。

拆分遇到两个结构性障碍：

- **障碍 A**：若把持久化脏位下移到 `src/storage.js`（它才是唯一消费者），会形成 `state ↔ storage` 循环依赖——`storage.js` 已经 `require('./state')` 读取数据。
- **障碍 B**：若把响应缓存抽到 `src/api/stateCache.js`，那么基础层（`config` / `timers` / `sync/github` / `pipeline/cycle`）调用「失效缓存」就变成了**基础层 → api 层**的反向依赖，与既有分层方向（`utils → 基础层 → domain → 采集 → 编排 → api`）相悖。

同时还有一条容易被后续维护者误解的既有语义必须逐字保留：`getStateJson()` 的节流窗口——数据未变则永不重建；数据已变但距上次重建 < 2000ms（检测中）/ < 4000ms（空闲）仍返回旧缓存。也就是说 **`markDirty()` 只置脏位，并不绕过节流窗口**。

## Decision

引入一个**零依赖叶子模块** `src/changeBus.js` 作为全应用唯一的「数据已变」信号源，并通过「基础层只发信号、api 层订阅」实现依赖方向不变：

- `changeBus` 只导出 `markDirty / invalidate / isDataDirty / clearDataDirty / onChange`，不 `require` 任何模块。`markDirty()` 置持久化脏位并广播；`invalidate()` 仅广播（供只影响展示、无需落盘的变更使用）。二者语义 1:1 保留，不做合并，避免消费者漏调。
- `src/api/stateCache.js` 承载响应缓存与 `setStateBuilder`，在**模块加载时**通过 `onChange(() => (cacheDirty = true))` 自注册失效。依赖方向为 `api → 基础层`，单向。
- `src/state.js` 收缩为纯数据容器（仅导出 `state`）。
- `index.html` 文件缓存**就地私有化**到 `src/api/server.js`，不再外置。

依赖方向（全部单向）：`changeBus`（叶子） ← 基础层（`config` / `storage` / `timers` / `sync/github` / `pipeline/cycle` / `nodes` / `domain`） ← `api/stateCache` ← `api/routes`。`state` 只被读取，不再持有行为。

被否方案：

- **把脏位下移 `storage.js`**：直接触发 `state ↔ storage` 循环依赖（障碍 A），且 `markDirty` 的广播语义无处安放。
- **接受 `config → api/stateCache` 反向依赖**：能少一个模块，但破坏分层方向的单一性，后人无法再靠「依赖方向」判断代码位置是否合理。
- **合并 `markDirty` 与 `invalidate`**：语义一旦混淆，只影响展示的变更会被误标为需落盘（或反之），属隐性 bug 温床。

## Consequences

- 正向：四类职责分家，各自的变更不再触碰其它职责；`state.js` 回归「数据容器」单一语义；依赖方向仍为严格单向，循环依赖保持为 0（第三种同构切断手法：`setStateBuilder` 注入 / `setRefreshFn` 注入 / `changeBus.onChange` 订阅）。
- 正向：`getStateJson` 的节流语义被 `test/state-cache.test.mjs` 固化为可执行断言，重构前后均 7/7 通过，行为零变更。
- 负向：多出两个模块（`changeBus.js`、`api/stateCache.js`）；「谁是脏位真源」从「看 `state.js`」变成「看 `changeBus.js`」，需要 ADR 与文档指路。
- 约束：新增任何「数据已变」的写点，必须调用 `changeBus` 的 `markDirty()`（需落盘）或 `invalidate()`（仅展示），**不得**再向 `state` 挂脏位或直接操作缓存变量。
- 约束：`changeBus` 必须保持零依赖叶子属性；一旦它开始 `require` 其它业务模块，循环依赖会立即回归。
