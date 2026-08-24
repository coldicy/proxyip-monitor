import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function runCurl(command: string, timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    return null;
  }
}

export async function runCurlWithCode(command: string, timeoutMs: number): Promise<{ out: string; code: number }> {
  try {
    const { stdout } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024
    });
    return { out: stdout, code: 0 };
  } catch (error: any) {
    const code = error.killed ? -1 : (error.code || 1);
    const output = error.stdout || '';
    return { out: output, code };
  }
}

export function getCurlFailText(code: number): string {
  const messages: Record<number, string> = {
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

export function parseCurlJson(output: string): any {
  if (!output) return null;
  const lines = output.trim().split('\n');
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    return null;
  }
}

export function parseTrace(traceText: string): Record<string, string> {
  const result: Record<string, string> = {};
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

export function parseNodeInfo(traceText: string): { ip: string; country?: string; city?: string } | null {
  const data = parseTrace(traceText);
  if (!data.ip) return null;
  return {
    ip: data.ip,
    country: data.country,
    city: data.city
  };
}

export function isValidIP(ip: string): boolean {
  if (!ip) return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && String(num) === part;
  });
}

export function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3]) >>> 0;
}

export function cidrMatch(ip: string, cidr: string): boolean {
  const [network, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(network) & mask);
}

export function sanitizeUrl(url: string): string {
  return String(url || '').replace(/['"`\\\s]/g, '');
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

export function isMaskedToken(token: string): boolean {
  return /\*{3,}/.test(String(token || ''));
}

export function parseLine(raw: string): { host: string; port: number } | null {
  let host = raw;
  let port = 443;

  if (raw.startsWith('[')) {
    const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!m) return null;
    host = m[1];
    if (m[2]) port = parseInt(m[2]);
  } else if (raw.includes(':') && raw.split(':').length === 2 && /^\d+$/.test(raw.split(':')[1])) {
    const p = raw.split(':');
    host = p[0];
    port = parseInt(p[1]);
  } else if (raw.includes(':')) {
    host = raw;
  }

  return { host, port };
}
