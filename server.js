/**
Proxy Monitor v36-window
- 新增：连续在线时长功能
*/
const fs = require('fs');
const { CONFIG, VERSION, setConfig, setRestartGithubTimer } = require('./src/config');
const { state, setStateBuilder } = require('./src/state');
const { readSecret, writeSecret } = require('./src/security');
const { ensureIpFile, loadData } = require('./src/storage');
const { backfillLastOnline } = require('./src/nodes/registry');
const { refreshCfCidrs } = require('./src/domain/cidr');
const { discover } = require('./src/nodes/discovery');
const { waitNetworkReady } = require('./src/pipeline/netready');
const { runCycle } = require('./src/pipeline/cycle');
const { restartTimer, restartGithubTimer } = require('./src/timers');
const { createServer } = require('./src/api/server');
const { buildState } = require('./src/api/view');
const { log } = require('./src/logger');

// 接线：切断 state ↔ api/view 与 config ↔ timers 循环依赖
setStateBuilder(buildState);
setRestartGithubTimer(restartGithubTimer);

// ==================== 进程级止血: 只记日志, 不让进程崩溃重启 ====================
process.on('uncaughtException', (e) => { log('💥 未捕获异常(已止血): ' + (e && e.stack ? e.stack : e)); });
process.on('unhandledRejection', (e) => { log('💥 未处理拒绝(已止血): ' + (e && e.stack ? e.stack : e)); });

const server = createServer();
server.on('error', (e) => { log('💥 HTTP server 错误: ' + e.message); });

// ==================== 启动（含旧明文Token迁移 + lastOnlineAt/onlineSince回填 + 网络就绪检查） ====================
CONFIG.github.token = process.env.GITHUB_TOKEN || readSecret() || '';
try {
const onDisk = JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8'));
if (onDisk && onDisk.github && onDisk.github.token) {
if (!readSecret()) writeSecret(String(onDisk.github.token));
delete onDisk.github.token;
try { fs.writeFileSync(CONFIG.configFile, JSON.stringify(onDisk, null, 2)); } catch (e) { }
log('🔒 旧版明文 Token 已迁移至加密存储');
}
setConfig(onDisk);
} catch (e) { }
const ipReady = ensureIpFile(); if (!ipReady.ok) log('⚠️ ip.txt 不可用 (' + CONFIG.ipFile + '): ' + ipReady.error + ' — 请用 IP_FILE 指定可写路径'); loadData(); backfillLastOnline();
server.listen(CONFIG.port, () => {
console.log(`🚀 Proxy Monitor ${VERSION} on http://0.0.0.0:${CONFIG.port}`);
log(`🚀 服务启动 (${VERSION})`);
(async () => {
try {
await refreshCfCidrs(true);
await discover();
} catch (e) { log('⚠️ 启动初始化失败(已止血): ' + e.message); }
state.units = Object.values(state.nodes);
// 新增: 启动网络就绪检查, 避免 Docker 更新/重启后网络未就绪导致第一轮整轮失败
const ready = await waitNetworkReady(45000, 5000);
log(ready ? '🌐 启动网络检查通过' : '⚠️ 启动后等待45秒网络仍未就绪, 开启无效轮保护进行首轮检测');
runCycle().catch(e => log('⚠️ 首轮检测异常: ' + e.message));
restartTimer(); restartGithubTimer();
})();
});
