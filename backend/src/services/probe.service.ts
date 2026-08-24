import { exec } from 'child_process';
import { promisify } from 'util';
import { ProxyNode, ProbeResult, TimingSegments, SpeedResult, CustomProbe } from '../types';
import { AppConfig } from '../config';
import { runCurlWithCode, parseCurlJson, parseTrace, getCurlFailText } from '../utils/helpers';

const execAsync = promisify(exec);
const SPEED_MIN_BYTES = 64 * 1024;
const SPEED_RETRY_MS = 10 * 60 * 1000;

export class ProbeService {
  constructor(private config: AppConfig) {}

  private splitProbe(url: string): { host: string; path: string } {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, path: parsed.pathname + parsed.search };
    } catch {
      return { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' };
    }
  }

  private buildTimingSegments(w: any): TimingSegments | null {
    if (!w) return null;
    const tcp = Math.round((w.tcp || 0) * 1000);
    const tls = Math.round(((w.tls || 0) - (w.tcp || 0)) * 1000);
    const total = Math.round((w.ttfb || 0) * 1000);
    let src = total - tcp - tls;
    if (src < 0) src = 0;
    return { tcp, tls, total: tcp + tls + src, src };
  }

  async probeLatency(node: ProxyNode): Promise<ProbeResult> {
    const result: ProbeResult = {
      t: Date.now(),
      ok: false,
      off: null,
      cus: null,
      total: null,
      avgTcp: null,
      avgTls: null,
      avgHttp: null,
      colo: null,
      loc: null,
      exitIp: null,
      failReason: null,
      probes: []
    };

    const probe = this.splitProbe(this.config.probeUrl);
    const timeoutMs = this.config.timeoutSec * 1000;
    const ua = 'PM-' + Math.random().toString(36).slice(2, 10);
    
    const curlCmd = `curl -4 -k -s --noproxy '*' --retry 0 -A '${ua}' -w '\\n{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${probe.host}:${node.port}:${node.ip}" --connect-timeout 3 --max-time ${this.config.timeoutSec + 2} 'https://${probe.host}:${node.port}${probe.path}'`;

    let latencyData: any = null;
    let lastOutput = '';
    let lastCode = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await runCurlWithCode(curlCmd, timeoutMs + 2500);
      lastCode = response.code;
      lastOutput = response.out;
      latencyData = parseCurlJson(response.out);
      
      if (latencyData && latencyData.http && String(latencyData.http) !== '000') {
        break;
      }
    }

    if (latencyData && latencyData.http === 200) {
      const lines = lastOutput.trim().split('\n');
      const traceOutput = lines.slice(0, -1).join('\n');
      const info = parseTrace(traceOutput);

      if (!info.colo && !info.fl) {
        result.failReason = '官方探针返回非 CF 内容 (不具备反代能力)';
        return result;
      }

      if (!lastOutput.includes('uag=' + ua)) {
        result.failReason = '官方探针 UA 未回显 (疑似伪造 trace)';
        return result;
      }

      result.ok = true;
      result.off = this.buildTimingSegments(latencyData);
      result.colo = info.colo || null;
      result.loc = info.loc || null;
      result.exitIp = info.ip || null;
    } else {
      result.failReason = `不具备反代 CF 能力 (${getCurlFailText(lastCode)})`;
    }

    return result;
  }

  async probeCustomProbes(node: ProxyNode): Promise<{ url: string; ok: boolean; segs: TimingSegments | null; failReason: string | null }[]> {
    const results: { url: string; ok: boolean; segs: TimingSegments | null; failReason: string | null }[] = [];
    const timeoutMs = this.config.timeoutSec * 1000;

    for (const probe of this.config.customProbes) {
      try {
        const probeUrl = new URL(probe.url);
        const expectCode = String(probe.expect || '200');
        
        const cmd = `curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"http":%{http_code}}' --resolve "${probeUrl.hostname}:${node.port}:${node.ip}" --connect-timeout 3 --max-time ${this.config.timeoutSec + 2} 'https://${probeUrl.hostname}:${node.port}${probeUrl.pathname}${probeUrl.search}'`;
        
        const response = await runCurlWithCode(cmd, timeoutMs + 2500);
        const data = parseCurlJson(response.out);
        const code = data ? String(data.http) : '000';
        const segs = this.buildTimingSegments(data);

        let ok = false;
        let failReason: string | null = null;

        if (code === '000' && response.code !== 0) {
          failReason = `连接失败 (${getCurlFailText(response.code)})`;
        } else if (code !== expectCode) {
          failReason = `预期${expectCode}实际${code}`;
        } else {
          ok = true;
        }

        results.push({ url: probe.url, ok, segs, failReason });
      } catch (error) {
        results.push({ 
          url: probe.url, 
          ok: false, 
          segs: null, 
          failReason: '配置错误' 
        });
      }
    }

    return results;
  }

  async probeSpeed(node: ProxyNode): Promise<SpeedResult> {
    const result: SpeedResult = {
      t: Date.now(),
      ok: false,
      mbps: null,
      size: null,
      failReason: null
    };

    const speedProbe = this.splitProbe(this.config.speedUrl);
    const timestamp = Date.now();
    
    const cmd = `curl -k -s --retry 0 -o /dev/null -w '{"speed":%{speed_download},"size":%{size_download},"time":%{time_total},"http":%{http_code}}' --resolve "${speedProbe.host}:${node.port}:${node.ip}" --connect-timeout 3 --max-time ${this.config.speedTimeoutSec} 'https://${speedProbe.host}:${node.port}${speedProbe.path}${speedProbe.path.includes('?') ? '&' : '?'}_t=${timestamp}'`;

    const response = await runCurlWithCode(cmd, this.config.speedTimeoutSec * 1000 + 2500);
    const data = parseCurlJson(response.out);
    
    const size = (data && isFinite(data.size)) ? data.size : 0;
    const secs = (data && isFinite(data.time) && data.time > 0) ? data.time : 0;
    const http = data ? String(data.http) : '000';
    const kb = (size / 1024).toFixed(1);

    if (size >= SPEED_MIN_BYTES && secs > 0) {
      const raw = size / secs / 1048576;
      const mbps = Math.round(raw * 100) / 100;
      
      if (mbps > 0 && (http === '200' || response.code === 28 || response.code === 18)) {
        result.mbps = mbps;
        result.size = Math.round(size);
        result.ok = true;
        return result;
      }
      
      result.failReason = `测速失败 (HTTP ${http}, 收到 ${kb}KB/${secs.toFixed(1)}s, 疑似非下载响应)`;
      return result;
    }

    if (data) {
      result.failReason = `测速失败 (HTTP ${http}, 仅收到 ${kb}KB${secs > 0 ? '/' + secs.toFixed(1) + 's' : ''}${response.code && response.code !== 0 ? ', curl ' + response.code : ''})`;
    } else {
      result.failReason = `测速失败 (${getCurlFailText(response.code)})`;
    }

    return result;
  }

  needSpeedTest(speed: SpeedResult | undefined): boolean {
    if (!this.config.speedEnabled) return false;
    if (!speed) return true;
    if (speed.ok) return false;
    return (Date.now() - (speed.t || 0)) > SPEED_RETRY_MS;
  }
}
