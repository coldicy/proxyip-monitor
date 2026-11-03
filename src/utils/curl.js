// curl 进程封装与输出解析（源 server.js:193-203、213-220）
const { exec } = require('child_process');
function runCurl(c, ms) { return new Promise(r => exec(c, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, o) => r(e ? null : o))); }
// 注意: 保留 stdout, 即使 curl 非零退出(如28超时)也带回 -w 统计, 供测速截断计算使用
function runCurl2(c, ms) { return new Promise(r => exec(c, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, o) => r({ out: o, code: e ? (e.killed ? -1 : e.code) : 0 }))); }
function curlFailText(code) {
if (code === 28) return '超时'; if (code === 7) return '连接被拒';
if (code === 35 || code === 60 || code === 61) return 'TLS错误';
if (code === -1) return '进程超时/被杀'; if (code === 6) return 'DNS解析失败';
return 'curl错误 ' + code;
}
function parseCurlJson(o) { if (!o) return null; const l = o.trim().split('\n'); try { return JSON.parse(l[l.length - 1]); } catch (e) { return null; } }
function parseTrace(t) { const p = {}; String(t || '').replace(/\r/g, '').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) p[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); return p; }
function buildSegs(w) {
if (!w) return null;
const tcp = Math.round((w.tcp || 0) * 1000);
const tls = Math.round(((w.tls || 0) - (w.tcp || 0)) * 1000);
const total = Math.round((w.ttfb || 0) * 1000);
let src = total - tcp - tls; if (src < 0) src = 0;
return { tcp, tls, total: tcp + tls + src, src };
}
module.exports = { runCurl, runCurl2, curlFailText, parseCurlJson, parseTrace, buildSegs };
