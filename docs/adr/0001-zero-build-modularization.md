# ADR 0001: 前后端采用零构建原生模块化

Status: Accepted
Date: 2026-11-03

## Context

后端 `server.js`（891 行）与前端 `public/index.html`（655 行）各自单文件承载全部职责，维护成本与可读性已成为主要问题。改造候选有两条路：一是引入打包器与前端框架（Vite + React/Preact）彻底组件化；二是在不增加构建步骤的前提下，用语言原生能力（后端 CommonJS、前端浏览器原生 ES Modules）把职责拆到独立模块。项目当前为零 npm 依赖、单阶段 Docker 构建、单进程运行，且系统已在线上运行，要求行为零变更。

## Decision

前后端均采用**零构建原生模块化**：后端拆为 `src/**` 的 CommonJS 模块，`server.js` 仅保留启动引导；前端拆为 `public/css/*.css` 与 `public/js/**`（原生 ESM），`index.html` 仅保留静态壳与 `<script type="module">` 入口。不引入打包器与前端框架，不改 Docker 部署形态。为使前端多文件可用，仅新增一项配套逻辑：`public/` 目录的静态文件服务。

测试工具链是唯一例外：允许引入测试框架，但**仅作为 `devDependencies`**，`Dockerfile` 不执行 `npm ci`，镜像内不含 `node_modules`，运行时依赖集合保持为空。

## Consequences

- 正向：直接命中「单文件职责过重」的根因，而不引入新的工具链复杂度；部署形态、零运行时依赖、单镜像特性全部不变；拆分改为「纯搬迁」，变更风险可控且可逐阶段回滚。
- 负向：文件数量从 2 个增至约 35 个；前端首屏 HTTP 请求数增加（内网监控面板场景可忽略）；模块间依赖以相对路径手工维护，缺少打包器的静态检查。
- 负向：`state` 与 `api/view` 之间出现循环依赖风险，需以 `setStateBuilder(buildState)` 注入方式显式切断。
- 约束：`Dockerfile` 必须追加 `COPY src ./src`，否则镜像内启动即 `MODULE_NOT_FOUND`；前端资源必须经新增的静态文件服务提供，且需防路径穿越。
- 约束：后续如需引入打包器或前端框架，须以新 ADR 覆盖本决策，不得在实施中静默引入。
