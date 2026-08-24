export interface ProxyNode {
  id: string;
  ip: string;
  port: number;
  firstSeen: number;
  lastOnlineAt?: number | null;
  firstSource: {
    kind: 'pure' | 'dom' | 'url' | 'file';
    name: string;
  };
  kind?: 'cf' | 'proxy' | 'unknown';
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
  cus?: { url: string; ok: boolean; segs: TimingSegments | null; failReason: string | null }[] | null;
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
  ok?: boolean;
  total?: number | null;
  off?: TimingSegments | null;
  cus?: { url: string; ok: boolean; segs: TimingSegments | null; failReason: string | null }[] | null;
  avgTcp?: number | null;
  avgTls?: number | null;
  avgHttp?: number | null;
  failReason?: string | null;
  colo?: string | null;
  loc?: string | null;
  exitIp?: string | null;
  probes?: ProbeDetail[];
  speed?: number | null;
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
  ip: string;
  port: number;
  label?: string;
  removedAt?: number;
  lastOnlineAt?: number;
  mode?: 'auto' | 'manual';
  t: number;
  reason: string;
}

export interface MonitorState {
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
  progress: Progress;
  logs: string[];
  github: {
    lastUpload: number | null;
    lastError: string | null;
  };
  speed: Record<string, SpeedResult>;
}

export interface Progress {
  tested: number;
  total: number;
}

export interface LogEntry {
  t: number;
  m: string;
}

export interface AppConfig {
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
  githubToken?: string;
  githubRepo?: string;
  githubBranch?: string;
}

export interface CustomProbe {
  url: string;
  expect: string;
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
  githubRepo?: string;
  githubBranch?: string;
}
