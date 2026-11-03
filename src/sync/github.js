// 上传数据构建 + 上传 / 自动上传（源 server.js:663-744）
const { CONFIG, VERSION } = require('../config');
const { state, invalidateStateCache } = require('../state');
const { computeQuality } = require('../domain/quality');
const { log } = require('../logger');
// ==================== 格式（复制 & GitHub 上传） ====================
function formatNodeLine(ipPort, region, colo, q, speedMbps) {
  const total = q.avgTotal != null ? q.avgTotal + 'ms' : '?ms';
  const tcp = q.avgTcp != null ? q.avgTcp + 'ms' : '?ms';
  const tls = q.avgTls != null ? q.avgTls + 'ms' : '?ms';
  const http = q.avgHttp != null ? q.avgHttp + 'ms' : '?ms';
  const spd = speedMbps != null && isFinite(speedMbps) ? speedMbps.toFixed(2) + 'MB/s' : '?MB/s';
  return `${ipPort}#${region} | ${colo || 'Unknown'} | ${total} | ${tcp} | ${tls} | ${http} | ${spd}`;
}
function buildUploadData() {
  const seen = new Map();
  state.units
    .filter((u) => u.ip)
    .forEach((u) => {
      const hist = state.history[u.id] || [];
      const q = computeQuality(hist, u.speed, u.onlineSince);
      if (!q.quality) return;
      const k = u.ip + ':' + u.port;
      const cur = seen.get(k);
      if (!cur || (q.avgTotal ?? 99999) < (cur.q.avgTotal ?? 99999)) seen.set(k, { u, q, hist });
    });
  const nodes = [...seen.values()].sort((a, b) => (a.q.avgTotal ?? 99999) - (b.q.avgTotal ?? 99999));
  const bodies = { 'all.txt': [] };
  nodes.forEach(({ u, q, hist }) => {
    let loc = null,
      colo = null;
    for (let i = hist.length - 1; i >= 0; i--) {
      const p = hist[i];
      if (!p) continue;
      if (!loc && p.loc) loc = p.loc;
      if (!colo && p.colo) colo = p.colo;
      if (loc && colo) break;
    }
    const ipPort = `${u.ip}:${u.port}`;
    const region = loc || colo || 'Unknown';
    const speedMbps = u.speed && u.speed.ok && u.speed.mbps != null ? u.speed.mbps : null;
    const line = formatNodeLine(ipPort, region, colo, q, speedMbps);
    bodies['all.txt'].push(line);
    const safe = region.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
    if (!bodies[safe + '.txt']) bodies[safe + '.txt'] = [];
    bodies[safe + '.txt'].push(line);
  });
  const fingerprint = bodies['all.txt'].join('\n');
  return { bodies, count: nodes.length, fingerprint };
}
function renderFile(lines) {
  return (
    `# ProxyIP quality list (auto uploaded by proxy-monitor ${VERSION})
# updated: ${new Date().toISOString()}
# nodes: ${lines.length}
` +
    lines.join('\n') +
    (lines.length ? '\n' : '')
  );
}
async function uploadGithub() {
  const g = CONFIG.github;
  if (!g.token || !g.repo) throw new Error('未配置 GITHUB_TOKEN / GITHUB_REPO');
  const { bodies, count, fingerprint } = buildUploadData();
  if (!count) throw new Error('当前没有优质节点可上传');
  const headers = {
    Authorization: `Bearer ${g.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'proxy-monitor',
    'Content-Type': 'application/json',
  };
  const basePath = g.path.replace(/.txt$/, '');
  let failed = 0;
  for (const [filename, lines] of Object.entries(bodies)) {
    const fullPath = `${basePath}_${filename}`;
    const apiPath = fullPath.split('/').map(encodeURIComponent).join('/');
    const api = `https://api.github.com/repos/${g.repo}/contents/${apiPath}`;
    let sha;
    try {
      const getRes = await fetch(`${api}?ref=${g.branch}`, { headers });
      if (getRes.ok) sha = (await getRes.json()).sha;
      else if (getRes.status !== 404) {
        failed++;
        log(`⚠️ 查询 ${fullPath} 失败: HTTP ${getRes.status}`);
        continue;
      }
    } catch (e) {
      failed++;
      continue;
    }
    const body = {
      message: `chore: update ${filename} (${lines.length} nodes)`,
      content: Buffer.from(renderFile(lines), 'utf8').toString('base64'),
      branch: g.branch,
    };
    if (sha) body.sha = sha;
    try {
      const putRes = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!putRes.ok) {
        failed++;
        log(`⚠️ 上传 ${fullPath} 失败: HTTP ${putRes.status}`);
      }
    } catch (e) {
      failed++;
    }
  }
  state.github.lastUpload = Date.now();
  invalidateStateCache();
  if (failed > 0) {
    state.github.lastError = `${failed} 个文件上传失败`;
    invalidateStateCache();
    log('⚠️ ' + state.github.lastError + '（下轮自动重试）');
  } else {
    state.github.lastError = null;
    invalidateStateCache();
    state.lastUploadedContent = fingerprint;
    log(`📤 已上传 ${count} 个优质节点 (${Object.keys(bodies).length} 个文件)`);
  }
  return { count, fileCount: Object.keys(bodies).length, failed };
}
async function autoUpload() {
  const { fingerprint } = buildUploadData();
  if (fingerprint === state.lastUploadedContent) {
    log('⏭️ 优质列表未变化，跳过上传');
    return;
  }
  await uploadGithub();
}
module.exports = { formatNodeLine, buildUploadData, renderFile, uploadGithub, autoUpload };
