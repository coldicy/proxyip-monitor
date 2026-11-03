// 路由表与各端点处理（源 server.js:804-862 中 /api/* 分支）
const fs = require('fs');
const { CONFIG, publicConfig, setConfig } = require('../config');
const { state, getStateJson, markDirty, invalidateStateCache } = require('../state');
const { readBody } = require('../utils/http');
const { persistGraveyard, persistConfig, ensureIpFile, saveData } = require('../storage');
const { removeUnits } = require('../cleanup');
const { uploadGithub } = require('../sync/github');
const { runCycle } = require('../pipeline/cycle');
const { restartTimer } = require('../timers');
const { probeSpeed } = require('../probes/speed');
const { discover } = require('../nodes/discovery');
const { log } = require('../logger');
async function handle(p, req, res, json) {
if (p === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(getStateJson()); }
if (p === '/api/logs') return json({ logs: state.logs });
if (p === '/api/abort' && req.method === 'POST') { if (state.checking) { state.abort = true; log('⏹ 收到中断请求'); } return json({ ok: true }); }
if (p === '/api/graveyard' && req.method === 'GET') return json({ graveyard: state.graveyard.list });
if (p === '/api/graveyard/clear' && req.method === 'POST') { state.graveyard.list = []; state.blocked = {}; persistGraveyard(); return json({ ok: true }); }
// 新增：解除屏蔽接口
if (p === '/api/graveyard/unblock' && req.method === 'POST') {
const { ids } = JSON.parse(await readBody(req) || '{}');
if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效节点ID' }, 400);
let unblocked = 0;
for (const id of ids) {
if (state.blocked[id]) {
delete state.blocked[id];
unblocked++;
}
}
// 从 graveyard 列表中移除
state.graveyard.list = state.graveyard.list.filter(g => !ids.includes(g.id));
persistGraveyard();
markDirty();
log(`🔓 解除屏蔽 ${unblocked} 个节点`);
return json({ ok: true, count: unblocked });
}
if (p === '/api/remove' && req.method === 'POST') {
const { ids } = JSON.parse(await readBody(req) || '{}');
if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效节点ID' }, 400);
return json({ ok: true, count: await removeUnits(ids) });
}
if (p === '/api/speedtest' && req.method === 'POST') {
const { ids } = JSON.parse(await readBody(req) || '{}');
if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: '无有效节点ID' }, 400);
const results = [];
for (const id of ids.slice(0, 10)) {
const u = state.nodes[id]; if (!u) continue;
const sp = await probeSpeed(u); u.speed = sp; markDirty(); results.push({ id, ...sp });
log(sp.ok ? `⚡ ${id} 手动复测: ${sp.mbps} MB/s` : `⚡ ${id} 手动复测失败: ${sp.failReason}`);
}
saveData();
return json({ ok: true, results });
}
if (p === '/api/config' && req.method === 'GET') return json(publicConfig());
if (p === '/api/config' && req.method === 'POST') { setConfig(JSON.parse(await readBody(req) || '{}')); const saved = persistConfig(); restartTimer(); log('🛠️ 配置已更新'); runCycle().catch(e => log('⚠️ 保存后检测异常: ' + e.message)); return saved ? json({ ok: true, config: publicConfig() }) : json({ ok: false, error: '配置保存失败：无法写入 ' + CONFIG.configFile }, 500); }
if (p === '/api/ipfile' && req.method === 'GET') { let c = ''; try { c = fs.readFileSync(CONFIG.ipFile, 'utf8'); } catch (e) { } return json({ content: c }); }
if (p === '/api/ipfile' && req.method === 'POST') {
const { content } = JSON.parse(await readBody(req) || '{}');
const ensured = ensureIpFile();
if (!ensured.ok) return json({ ok: false, error: '无法写入 ip.txt (' + CONFIG.ipFile + '): ' + ensured.error }, 500);
try { fs.writeFileSync(CONFIG.ipFile, String(content ?? '')); } catch (e) { return json({ ok: false, error: '无法写入 ip.txt (' + CONFIG.ipFile + '): ' + e.message }, 500); }
runCycle().catch(e => log('⚠️ 重载检测异常: ' + e.message)); return json({ ok: true, count: Object.keys(state.nodes).length });
}
if (p === '/api/check' && req.method === 'POST') { log('🖱️ 手动触发检测'); runCycle().catch(e => log('⚠️ 手动检测异常: ' + e.message)); return json({ ok: true }); }
if (p === '/api/reload' && req.method === 'POST') { await discover(); state.units = Object.values(state.nodes); return json({ ok: true, count: state.units.length }); }
if (p === '/api/upload' && req.method === 'POST') { try { return json({ ok: true, ...(await uploadGithub()) }); } catch (e) { state.github.lastError = e.message; invalidateStateCache(); log('⚠️ 手动上传失败: ' + e.message); return json({ ok: false, error: e.message }, 500); } }
return json({ error: 'not found' }, 404);
}
module.exports = { handle };
