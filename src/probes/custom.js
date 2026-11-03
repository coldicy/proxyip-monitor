// 自定义源站探针（源 server.js:422-441）
const { CONFIG } = require('../config');
const { runCurl2, curlFailText, parseCurlJson, buildSegs } = require('../utils/curl');
// ==================== 自定义探针 ====================
async function probeCustoms(u) {
  const results = [];
  const ms = CONFIG.timeoutSec * 1000;
  for (const p of CONFIG.customProbes) {
    try {
      const cu = new URL(p.url);
      const expectCode = String(p.expect || '200');
      const cmd = `curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${cu.hostname}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec + 2} 'https://${cu.hostname}:${u.port}${cu.pathname}${cu.search}'`;
      const r = await runCurl2(cmd, ms + 2500);
      const res = parseCurlJson(r.out);
      const code = res ? String(res.http) : '000';
      const segs = buildSegs(res);
      let ok = false,
        failReason = null;
      if (code === '000' && r.code !== 0) failReason = `连接失败(${curlFailText(r.code)})`;
      else if (code !== expectCode) failReason = `预期${expectCode}实际${code}`;
      else ok = true;
      results.push({ url: p.url, host: cu.hostname, expect: expectCode, code, segs, ok, failReason });
    } catch (e) {
      results.push({
        url: p.url,
        host: p.url,
        expect: p.expect,
        code: '000',
        segs: null,
        ok: false,
        failReason: '配置错误',
      });
    }
  }
  return results;
}
module.exports = { probeCustoms };
