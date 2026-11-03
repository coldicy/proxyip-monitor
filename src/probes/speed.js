// 一次性测速 + 测速闸门（源 server.js:442-479）
const { CONFIG, SPEED_RETRY_MS } = require('../config');
const { splitProbe } = require('../utils/text');
const { runCurl2, curlFailText, parseCurlJson } = require('../utils/curl');
// ==================== 一次性下载测速 (curl 平均速度) ====================
// 20MB 字节上限 + speedTimeoutSec 时间上限; speed = size/time; 超时截断(exit 28)仍输出 -w, 慢节点也能得到有效平均速度
const SPEED_MIN_BYTES = 64 * 1024; // 有效样本最低接收量
async function probeSpeed(u) {
const point = { t: Date.now(), ok: false, mbps: null, size: null, failReason: null };
if (!u.ip) { point.failReason = '无有效IP'; return point; }
const sp = splitProbe(CONFIG.speedUrl);
const timestamp = Date.now();
const cmd = `curl -k -s --retry 0 -o /dev/null -w '{"speed":%{speed_download},"size":%{size_download},"time":%{time_total},"http":%{http_code}}' --resolve "${sp.host}:${u.port}:${u.ip}" --connect-timeout 3 --max-time ${CONFIG.speedTimeoutSec} 'https://${sp.host}:${u.port}${sp.path}${sp.path.includes('?') ? '&' : '?'}_t=${timestamp}'`;
const r = await runCurl2(cmd, CONFIG.speedTimeoutSec * 1000 + 2500);
const j = parseCurlJson(r.out);
const size = (j && isFinite(j.size)) ? j.size : 0;
const secs = (j && isFinite(j.time) && j.time > 0) ? j.time : 0;
const http = j ? String(j.http) : '000';
const kb = (size / 1024).toFixed(1);
if (size >= SPEED_MIN_BYTES && secs > 0) {
const raw = size / secs / 1048576;
const mbps = Math.round(raw * 100) / 100;
if (mbps > 0 && (http === '200' || r.code === 28 || r.code === 18)) {
point.mbps = mbps; point.size = Math.round(size); point.ok = true; return point;
}
point.failReason = `测速失败 (HTTP ${http}, 收到 ${kb}KB/${secs.toFixed(1)}s, 疑似非下载响应)`;
return point;
}
if (j) {
point.failReason = `测速失败 (HTTP ${http}, 仅收到 ${kb}KB${secs > 0 ? '/' + secs.toFixed(1) + 's' : ''}${r.code && r.code !== 0 ? ', curl ' + r.code : ''})`;
} else {
point.failReason = `测速失败 (${curlFailText(r.code)})`;
}
return point;
}
// 测速闸门: 无记录→测; 成功记录→永不复测; 失败记录→间隔>10分钟才重试。是否"在线"由调用方(本轮point.ok)保证, 离线节点完全不测
function needSpeedTest(u) {
if (!CONFIG.speedEnabled) return false;
if (!u.speed) return true;
if (u.speed.ok) return false;
return (Date.now() - (u.speed.t || 0)) > SPEED_RETRY_MS;
}
module.exports = { SPEED_MIN_BYTES, probeSpeed, needSpeedTest };
