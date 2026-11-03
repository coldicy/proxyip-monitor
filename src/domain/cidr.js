// CF IP 段分类（源 server.js:297-319）
const net = require('net');
const { state } = require('../state');
const { log } = require('../logger');
// ==================== CF CIDR 分类 ====================
const CF_SUPERNETS = ['103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/12', '108.162.192.0/18',
'131.0.72.0/22', '141.101.64.0/18', '162.158.0.0/15', '172.64.0.0/13', '173.245.48.0/20',
'188.114.96.0/20', '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17'];
function ipToInt(ip) { const p = ip.split('.').map(Number); return (p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) >>> 0; }
function cidrMatch(ip, cidr) {
const [n, bits] = cidr.split('/'); const b = +bits;
const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
return (ipToInt(ip) & mask) === (ipToInt(n) & mask);
}
async function refreshCfCidrs(force) {
if (!force && state.cfCidrs.length && (Date.now() - state.cfCidrsAt) < 12 * 3600 * 1000) return;
let live = [];
try {
const res = await fetch('https://www.cloudflare.com/ips-v4');
if (res.ok) { const txt = await res.text(); live = txt.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s)); }
} catch (e) { log('⚠️ 获取CF IP段失败，使用内置超网: ' + e.message); }
state.cfCidrs = [...new Set([...CF_SUPERNETS, ...live])];
state.cfCidrsAt = Date.now();
for (const id of Object.keys(state.nodes)) state.nodes[id].kind = classifyIp(state.nodes[id].ip);
log('🌐 CF IP分类集合已更新: ' + state.cfCidrs.length + ' 条');
}
function classifyIp(ip) { if (!ip || !net.isIPv4(ip) || !state.cfCidrs.length) return 'unknown'; return state.cfCidrs.some(c => cidrMatch(ip, c)) ? 'cf' : 'proxy'; }
module.exports = { CF_SUPERNETS, ipToInt, cidrMatch, refreshCfCidrs, classifyIp };
