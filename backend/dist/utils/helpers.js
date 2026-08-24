"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCurl = runCurl;
exports.runCurlWithCode = runCurlWithCode;
exports.getCurlFailText = getCurlFailText;
exports.parseCurlJson = parseCurlJson;
exports.parseTrace = parseTrace;
exports.parseNodeInfo = parseNodeInfo;
exports.isValidIP = isValidIP;
exports.ipToInt = ipToInt;
exports.cidrMatch = cidrMatch;
exports.sanitizeUrl = sanitizeUrl;
exports.isUrl = isUrl;
exports.maskToken = maskToken;
exports.isMaskedToken = isMaskedToken;
exports.parseLine = parseLine;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
async function runCurl(command, timeoutMs) {
    try {
        const { stdout } = await execAsync(command, {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024
        });
        return stdout;
    }
    catch (error) {
        return null;
    }
}
async function runCurlWithCode(command, timeoutMs) {
    try {
        const { stdout } = await execAsync(command, {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024
        });
        return { out: stdout, code: 0 };
    }
    catch (error) {
        const code = error.killed ? -1 : (error.code || 1);
        const output = error.stdout || '';
        return { out: output, code };
    }
}
function getCurlFailText(code) {
    const messages = {
        28: '超时',
        7: '连接被拒',
        35: 'TLS 错误',
        60: 'TLS 错误',
        61: 'TLS 错误',
        '-1': '进程超时/被杀',
        6: 'DNS 解析失败'
    };
    return messages[code] || `curl 错误 ${code}`;
}
function parseCurlJson(output) {
    if (!output)
        return null;
    const lines = output.trim().split('\n');
    try {
        return JSON.parse(lines[lines.length - 1]);
    }
    catch (e) {
        return null;
    }
}
function parseTrace(traceText) {
    const result = {};
    String(traceText || '')
        .replace(/\r/g, '')
        .split('\n')
        .forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) {
            result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    });
    return result;
}
function parseNodeInfo(traceText) {
    const data = parseTrace(traceText);
    if (!data.ip)
        return null;
    return {
        ip: data.ip,
        country: data.country,
        city: data.city
    };
}
function isValidIP(ip) {
    if (!ip)
        return false;
    const parts = ip.split('.');
    if (parts.length !== 4)
        return false;
    return parts.every(part => {
        const num = parseInt(part, 10);
        return !isNaN(num) && num >= 0 && num <= 255 && String(num) === part;
    });
}
function ipToInt(ip) {
    const parts = ip.split('.').map(Number);
    return (parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3]) >>> 0;
}
function cidrMatch(ip, cidr) {
    const [network, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(network) & mask);
}
function sanitizeUrl(url) {
    return String(url || '').replace(/['"`\\\s]/g, '');
}
function isUrl(s) {
    return /^https?:\/\//i.test(s);
}
function maskToken(token) {
    if (!token)
        return '';
    if (token.length <= 8)
        return '****';
    return token.slice(0, 4) + '****' + token.slice(-4);
}
function isMaskedToken(token) {
    return /\*{3,}/.test(String(token || ''));
}
function parseLine(raw) {
    let host = raw;
    let port = 443;
    if (raw.startsWith('[')) {
        const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
        if (!m)
            return null;
        host = m[1];
        if (m[2])
            port = parseInt(m[2]);
    }
    else if (raw.includes(':') && raw.split(':').length === 2 && /^\d+$/.test(raw.split(':')[1])) {
        const p = raw.split(':');
        host = p[0];
        port = parseInt(p[1]);
    }
    else if (raw.includes(':')) {
        host = raw;
    }
    return { host, port };
}
//# sourceMappingURL=helpers.js.map