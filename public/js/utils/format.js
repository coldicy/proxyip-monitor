// format.js — 纯格式化 / 转义工具（无任何依赖，便于单测）
export function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s],
  );
}
export function fmtTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch (e) {
    return '-';
  }
}
export function flagEmoji(code) {
  if (!code) return '🌍';
  const c = String(code).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌍';
  const b = 0x1f1e6;
  return String.fromCodePoint(b + c.charCodeAt(0) - 65, b + c.charCodeAt(1) - 65);
}
export function fmtCellMs(v) {
  if (v == null || !isFinite(v)) return '<span class="muted">-</span>';
  return `${Math.round(v)}<span class="unit">ms</span>`;
}
export function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="muted">-</span>';
  return `${(v * 100).toFixed(1)}%`;
}
export function parseRatioInput(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  let r = n;
  if (r > 1) r = r / 100;
  return Math.max(0, Math.min(1, r));
}
// 比较运算符: lte≤ gte≥ lt< gt> eq=(浮点容差1e-9)
export function cmpOp(op, a, b) {
  if (op === 'lt') return a < b;
  if (op === 'gt') return a > b;
  if (op === 'eq') return Math.abs(a - b) < 1e-9;
  if (op === 'gte') return a >= b;
  return a <= b;
}
// 连续在线时长格式化: 天/小时/分/秒
export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}小时${m % 60}分` : `${h}小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}天${h % 24}小时` : `${d}天`;
}
