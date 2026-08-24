export interface ProxyNode {
  id: string;
  ip: string;
  port: number;
  firstSeen: number;
  lastOnlineAt?: number;
  firstSource: {
    kind: 'pure' | 'dom' | 'url';
    name: string;
  };
  kind?: 'cf' | 'proxy' | 'unknown';
  speed?: SpeedResult;
}

export interface SpeedResult {
  t: number;
  ok: boolean;
  mbps: number | null;
  size: number | null;
  failReason: string | null;
}

export interface ProbeResult {
  t: number;
  ok: boolean;
  off: TimingSegments | null;
  cus: TimingSegments | null;
  total: number | null;
  avgTcp: number | null;
  avgTls: number | null;
  avgHttp: number | null;
  colo: string | null;
  loc: string | null;
  exitIp: string | null;
  failReason: string | null;
  probes: ProbeDetail[];
}

export interface ProbeDetail {
  name: string;
  tcp: number;
  tls: number;
  total: number;
  src: number;
}

export interface TimingSegments {
  tcp: number;
  tls: number;
  total: number;
  src: number;
}

export interface HistoryEntry {
  t: number;
  ok: boolean;
  total?: number | null;
  off?: TimingSegments | null;
  cus?: TimingSegments | null;
  avgTcp?: number | null;
  avgTls?: number | null;
  avgHttp?: number | null;
  failReason?: string | null;
  colo?: string | null;
  loc?: string | null;
  exitIp?: string | null;
  probes?: ProbeDetail[];
}

export interface QualityResult {
  quality: boolean;
  rate: number;
  qualRate: number;
  avgTotal: number | null;
  avgTcp: number | null;
  avgTls: number | null;
  avgHttp: number | null;
  samples: number;
  speedPass: boolean;
}

export interface GraveyardEntry {
  id: string;
  label: string;
  removedAt: number;
  lastOnlineAt: number;
  mode: 'auto' | 'manual';
  reason: string;
}

export interface AppState {
  nodes: Record<string, ProxyNode>;
  history: Record<string, HistoryEntry[]>;
  blocked: Record<string, number>;
  graveyard: {
    list: GraveyardEntry[];
  };
  cfCidrs: string[];
  cfCidrsAt: number;
  checking: boolean;
  lastCycle: number | null;
  progress: {
    tested: number;
    total: number;
  };
  logs: LogEntry[];
  github: {
    lastUpload: number | null;
    lastError: string | null;
  };
}

export interface LogEntry {
  t: number;
  m: string;
}

export interface AppConfig {
  port: number;
  ipFile: string;
  dataDir: string;
  intervalSec: number;
  probeUrl: string;
  customProbes: CustomProbe[];
  timeoutSec: number;
  concurrency: number;
  autoCleanDays: number;
  maxTotalMs: number;
  qualityWindow: number;
  successThreshold: number;
  qualThreshold: number;
  speedEnabled: boolean;
  speedUrl: string;
  speedTimeoutSec: number;
  speedMinMBps: number;
  speedConcurrency: number;
  speedPerCycle: number;
  github: GithubConfig;
  dataFile: string;
  configFile: string;
  graveyardFile: string;
  secretFile: string;
}

export interface CustomProbe {
  url: string;
  expect: string;
}

export interface GithubConfig {
  token: string;
  repo: string;
  path: string;
  branch: string;
  auto: boolean;
  uploadIntervalMin: number;
}

export interface PublicConfig {
  intervalSec: number;
  timeoutSec: number;
  concurrency: number;
  autoCleanDays: number;
  maxTotalMs: number;
  probeUrl: string;
  customProbes: CustomProbe[];
  qualityWindow: number;
  successThreshold: number;
  qualThreshold: number;
  speedEnabled: boolean;
  speedUrl: string;
  speedTimeoutSec: number;
  speedMinMBps: number;
  speedConcurrency: number;
  speedPerCycle: number;
  github: {
    tokenSet: boolean;
    tokenMasked: string;
    repo: string;
    path: string;
    branch: string;
    auto: boolean;
    uploadIntervalMin: number;
  };
}

export interface ApiStateResponse {
  version: string;
  checking: boolean;
  progress: { tested: number; total: number };
  lastCycle: number | null;
  intervalSec: number;
  config: {
    maxTotalMs: number;
    qualityWindow: number;
    successThreshold: number;
    qualThreshold: number;
    autoCleanDays: number;
    customProbes: CustomProbe[];
    concurrency: number;
    speedEnabled: boolean;
    speedMinMBps: number;
    speedUrl: string;
    speedTimeoutSec: number;
    speedConcurrency: number;
    speedPerCycle: number;
  };
  github: {
    configured: boolean;
    auto: boolean;
    lastUpload: number | null;
    lastError: string | null;
    uploadIntervalMin: number;
  };
  summary: {
    total: number;
    online: number;
    quality: number;
    offline: number;
  };
  items: StateItem[];
}

export interface StateItem {
  id: string;
  label: string;
  ip: string;
  port: number;
  ipKind: string;
  srcKind: string;
  srcName: string;
  firstSeen: number | null;
  colo: string | null;
  loc: string | null;
  exitIp: string | null;
  speed: SpeedResult | null;
  latest: ProbeResult | null;
  quality: QualityResult;
  recent: HistoryEntry[];
}
