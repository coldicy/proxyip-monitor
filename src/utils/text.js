// 文本/地址解析纯函数（源 server.js:86、176-192）
const net = require('net');
// 修复: 旧正则 /['"`\\s]/g 会误删字母 s; 现在只剥离 引号/反引号/反斜杠/空白
function sanitizeUrl(u) { return String(u || '').replace(/['"`\\\s]/g, ''); }
function splitProbe(u) { try { const x = new URL(u); return { host: x.hostname, path: x.pathname + x.search }; } catch (e) { return { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' }; } }
function isUrl(s) { return /^https?:\/\//i.test(s); }
function parseLine(raw) {
let host = raw, port = 443;
if (raw.startsWith('[')) { const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/); if (!m) return null; host = m[1]; if (m[2]) port = +m[2]; }
else if (raw.includes(':') && raw.split(':').length === 2 && /^\d+$/.test(raw.split(':')[1])) { const p = raw.split(':'); host = p[0]; port = +p[1]; }
else if (raw.includes(':')) { host = raw; }
return { host, port };
}
function sourceKeyForLine(line) {
if (isUrl(line)) return 'url:' + line;
const r = parseLine(line); if (!r) return null;
if (net.isIPv4(r.host)) return 'pure:' + r.host + ':' + r.port;
if (net.isIPv6(r.host)) return null;
return 'dom:' + r.host + ':' + r.port;
}
function splitId(id) { const i = id.lastIndexOf(':'); return [id.slice(0, i), +id.slice(i + 1)]; }
module.exports = { sanitizeUrl, splitProbe, isUrl, parseLine, sourceKeyForLine, splitId };
