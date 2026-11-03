// 官方探针（源 server.js:399-421）
const { CONFIG } = require('../config');
const { splitProbe } = require('../utils/text');
const { runCurl2, curlFailText, parseCurlJson, parseTrace, buildSegs } = require('../utils/curl');
// ==================== 官方探针 (uag 回显校验) ====================
async function probeLatency(u) {
  const point = { t: Date.now(), ok: false, off: null, colo: null, loc: null, exitIp: null, failReason: null };
  if (!u.ip) {
    point.failReason = '无有效IP';
    return point;
  }
  const probe = splitProbe(CONFIG.probeUrl);
  const ms = CONFIG.timeoutSec * 1000;
  const ua = 'PM-' + Math.random().toString(36).slice(2, 10);
  const latCmd = `curl -4 -k -s --noproxy '*' --retry 0 -A '${ua}' -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${probe.host}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.timeoutSec + 2} 'https://${probe.host}:${u.port}${probe.path}'`;
  let lat = null,
    lastCode = 0,
    lastOut = null;
  for (let a = 0; a < 2; a++) {
    const r = await runCurl2(latCmd, ms + 2500);
    lastCode = r.code;
    lastOut = r.out;
    lat = parseCurlJson(r.out);
    if (lat && lat.http && String(lat.http) !== '000') break;
  }
  if (lat && lat.http === 200) {
    const info = parseTrace(lastOut.trim().split('\n').slice(0, -1).join('\n'));
    if (!info.colo && !info.fl) {
      point.failReason = '官方探针返回非 CF 内容 (不具备反代能力)';
      return point;
    }
    if (!lastOut.includes('uag=' + ua)) {
      point.failReason = '官方探针UA未回显 (疑似伪造trace)';
      return point;
    }
    point.ok = true;
    point.off = buildSegs(lat);
    point.colo = info.colo || null;
    point.loc = info.loc || null;
    point.exitIp = info.ip || null;
  } else {
    point.failReason = `不具备反代CF能力 (${curlFailText(lastCode)})`;
  }
  return point;
}
module.exports = { probeLatency };
