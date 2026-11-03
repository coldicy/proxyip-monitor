// Token 脱敏与密钥文件读写（源 server.js:87-96）
const fs = require('fs');
const { CONFIG } = require('./config');
const { log } = require('./logger');
function maskToken(t) { if (!t) return ''; if (t.length <= 8) return '****'; return t.slice(0, 4) + '****' + t.slice(-4); }
function isMaskedToken(t) { return /\*{3,}/.test(String(t || '')); }
function readSecret() { try { return fs.readFileSync(CONFIG.secretFile, 'utf8').trim(); } catch (e) { return ''; } }
function writeSecret(t) {
try {
fs.mkdirSync(CONFIG.dataDir, { recursive: true });
fs.writeFileSync(CONFIG.secretFile, t, { mode: 0o600 });
try { fs.chmodSync(CONFIG.secretFile, 0o600); } catch (e) { }
} catch (e) { log('⚠️ Token 写入失败: ' + e.message); }
}
module.exports = { maskToken, isMaskedToken, readSecret, writeSecret };
