// 优质判定（源 server.js:598-635）
const { CONFIG } = require('../config');
// ==================== 优质判定（含速度下限 + 连续在线闸门） ====================
function computeQuality(points, speed, onlineSince) {
  const recent = (points || []).slice(-CONFIG.qualityWindow);
  if (!recent.length)
    return {
      quality: false,
      rate: 0,
      qualRate: 0,
      avgTotal: null,
      avgTcp: null,
      avgTls: null,
      avgHttp: null,
      samples: 0,
      speedPass: true,
      onlinePass: true,
    };
  const oks = recent.filter((p) => p.ok);
  const rate = oks.length / recent.length;
  let qualRate = rate;
  if (CONFIG.maxTotalMs > 0) {
    const qualified = oks.filter((p) => p.total != null && p.total <= CONFIG.maxTotalMs);
    qualRate = qualified.length / recent.length;
  }
  const valid = oks.filter(
    (p) =>
      p.avgTcp != null &&
      isFinite(p.avgTcp) &&
      p.avgTls != null &&
      isFinite(p.avgTls) &&
      p.avgHttp != null &&
      isFinite(p.avgHttp),
  );
  let avgTcp = null,
    avgTls = null,
    avgHttp = null,
    avgTotal = null;
  if (valid.length > 0) {
    avgTcp = Math.round(valid.reduce((s, p) => s + p.avgTcp, 0) / valid.length);
    avgTls = Math.round(valid.reduce((s, p) => s + p.avgTls, 0) / valid.length);
    avgHttp = Math.round(valid.reduce((s, p) => s + p.avgHttp, 0) / valid.length);
    avgTotal = avgTcp + avgTls + avgHttp;
  } else {
    const totals = oks.map((p) => p.total).filter((v) => v != null && isFinite(v));
    if (totals.length > 0) avgTotal = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
    const tcps = oks.map((p) => p.avgTcp).filter((v) => v != null && isFinite(v));
    const tlss = oks.map((p) => p.avgTls).filter((v) => v != null && isFinite(v));
    const https = oks.map((p) => p.avgHttp).filter((v) => v != null && isFinite(v));
    if (tcps.length) avgTcp = Math.round(tcps.reduce((a, b) => a + b, 0) / tcps.length);
    if (tlss.length) avgTls = Math.round(tlss.reduce((a, b) => a + b, 0) / tlss.length);
    if (https.length) avgHttp = Math.round(https.reduce((a, b) => a + b, 0) / https.length);
  }
  const enough = recent.length >= CONFIG.qualityWindow;
  const minSp = CONFIG.speedEnabled ? CONFIG.speedMinMBps : 0;
  const speedPass = minSp <= 0 ? true : !!(speed && speed.ok && speed.mbps != null && speed.mbps >= minSp);
  // 连续在线时长闸门: 0=不限; >0 要求当前连续在线 ≥ 该小时数(失败清零后需重新累积)
  const minHours = CONFIG.minOnlineHours;
  const onlineHours = onlineSince ? (Date.now() - onlineSince) / 3600000 : 0;
  const onlinePass = minHours <= 0 ? true : onlineHours >= minHours;
  const quality =
    enough && rate >= CONFIG.successThreshold && qualRate >= CONFIG.qualThreshold && speedPass && onlinePass;
  return { quality, rate, qualRate, avgTotal, avgTcp, avgTls, avgHttp, samples: recent.length, speedPass, onlinePass };
}
module.exports = { computeQuality };
