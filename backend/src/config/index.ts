import { AppConfig, GithubConfig, CustomProbe } from '../types';
import * as path from 'path';

const VERSION = 'v2.0.0';

function parseNumber(env: string | undefined, defaultVal: number): number {
  const parsed = parseFloat(env || String(defaultVal));
  return isFinite(parsed) ? parsed : defaultVal;
}

function parseBoolean(env: string | undefined, defaultVal: boolean): boolean {
  if (env === undefined) return defaultVal;
  return env === 'true' || env === '1';
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR || '/app/data';
  
  const config: AppConfig = {
    port: parseNumber(process.env.PORT, 8787),
    ipFile: process.env.IP_FILE || '/app/config/ip.txt',
    dataDir,
    intervalSec: parseNumber(process.env.INTERVAL_SEC, 60),
    probeUrl: process.env.PROBE_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
    customProbes: [],
    timeoutSec: parseNumber(process.env.TIMEOUT_SEC, 5),
    concurrency: parseNumber(process.env.CONCURRENCY, 50),
    autoCleanDays: parseNumber(process.env.AUTO_CLEAN_DAYS, 7),
    maxTotalMs: parseNumber(process.env.MAX_TOTAL_MS, 0),
    qualityWindow: parseNumber(process.env.QUALITY_WINDOW, 10),
    successThreshold: parseNumber(process.env.SUCCESS_THRESHOLD, 1),
    qualThreshold: parseNumber(process.env.QUAL_THRESHOLD, 1),
    speedEnabled: parseBoolean(process.env.SPEED_ENABLED, true),
    speedUrl: process.env.SPEED_URL || 'https://speed.cloudflare.com/__down?bytes=20000000',
    speedTimeoutSec: parseNumber(process.env.SPEED_TIMEOUT_SEC, 10),
    speedMinMBps: parseNumber(process.env.SPEED_MIN_MBPS, 0),
    speedConcurrency: Math.min(3, Math.max(1, parseNumber(process.env.SPEED_CONCURRENCY, 1))),
    speedPerCycle: Math.max(1, parseNumber(process.env.SPEED_PER_CYCLE, 20)),
    github: {
      token: process.env.GITHUB_TOKEN || '',
      repo: process.env.GITHUB_REPO || '',
      path: process.env.GITHUB_PATH || 'proxyip',
      branch: process.env.GITHUB_BRANCH || 'main',
      auto: parseBoolean(process.env.GITHUB_AUTO_UPLOAD, false),
      uploadIntervalMin: parseNumber(process.env.GITHUB_UPLOAD_INTERVAL_MIN, 0)
    },
    dataFile: path.join(dataDir, 'history.json'),
    configFile: path.join(dataDir, 'config.json'),
    graveyardFile: path.join(dataDir, 'graveyard.json'),
    secretFile: path.join(dataDir, 'github.secret')
  };

  return config;
}

export function getHistoryCap(qualityWindow: number): number {
  return Math.min(50, Math.max(1, Math.round(qualityWindow) || 10));
}

export const CF_SUPERNETS = [
  '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/12',
  '108.162.192.0/18', '131.0.72.0/22', '141.101.64.0/18', '162.158.0.0/15',
  '172.64.0.0/13', '173.245.48.0/20', '188.114.96.0/20', '190.93.240.0/20',
  '197.234.240.0/22', '198.41.128.0/17'
];

export { VERSION };
