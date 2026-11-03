import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// 后端源码为 CommonJS（含 require/module.exports）。用 createRequire 统一走 Node 的 CJS 缓存，
// 保证测试与源文件拿到同一份模块实例（尤其是共享的可变 state / CONFIG）。
const require = createRequire(import.meta.url);
const text = require('../src/utils/text.js');
const curl = require('../src/utils/curl.js');
const quality = require('../src/domain/quality.js');
const history = require('../src/domain/history.js');
const stateMod = require('../src/state.js');
const config = require('../src/config.js');

const { parseLine, sourceKeyForLine } = text;
const { buildSegs } = curl;
const { computeQuality } = quality;
const { offlineSince, computeOnlineSince } = history;
const { state } = stateMod;
const { CONFIG, historyCap } = config;

describe('src/utils/text.js · parseLine', () => {
  it('纯 IP 默认端口 443', () => {
    expect(parseLine('1.2.3.4')).toEqual({ host: '1.2.3.4', port: 443 });
  });
  it('IP:端口 解析出端口', () => {
    expect(parseLine('1.2.3.4:8443')).toEqual({ host: '1.2.3.4', port: 8443 });
  });
  it('方括号 IPv6 带端口', () => {
    expect(parseLine('[2001:db8::1]:8443')).toEqual({ host: '2001:db8::1', port: 8443 });
  });
  it('方括号 IPv6 无端口默认 443', () => {
    expect(parseLine('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 443 });
  });
  it('冒号多于 1 个且非方括号时整体作为 host', () => {
    expect(parseLine('example.com:443:extra')).toEqual({ host: 'example.com:443:extra', port: 443 });
  });
  it('方括号格式非法返回 null', () => {
    expect(parseLine('[bad')).toBeNull();
  });
});

describe('src/utils/text.js · sourceKeyForLine', () => {
  it('URL 行前缀 url:', () => {
    expect(sourceKeyForLine('https://x.com/a')).toBe('url:https://x.com/a');
  });
  it('纯 IPv4（带显式端口）前缀 pure:', () => {
    expect(sourceKeyForLine('1.2.3.4:8443')).toBe('pure:1.2.3.4:8443');
  });
  it('纯 IPv4（默认端口）前缀 pure: 且补充 :443', () => {
    expect(sourceKeyForLine('1.2.3.4')).toBe('pure:1.2.3.4:443');
  });
  it('域名前缀 dom:', () => {
    expect(sourceKeyForLine('example.com')).toBe('dom:example.com:443');
  });
  it('IPv6 字面量返回 null', () => {
    expect(sourceKeyForLine('::1')).toBeNull();
    expect(sourceKeyForLine('[2001:db8::1]:8443')).toBeNull();
  });
});

describe('src/utils/curl.js · buildSegs', () => {
  it('入参为空返回 null', () => {
    expect(buildSegs(null)).toBeNull();
  });
  it('空对象各分段为 0', () => {
    expect(buildSegs({})).toEqual({ tcp: 0, tls: 0, total: 0, src: 0 });
  });
  it('正常分段换算为毫秒', () => {
    expect(buildSegs({ tcp: 0.1, tls: 0.2, ttfb: 0.3 })).toEqual({ tcp: 100, tls: 100, total: 300, src: 100 });
  });
  it('src 为负时截断为 0，total 重新等于三段之和', () => {
    expect(buildSegs({ tcp: 0.1, tls: 0.2, ttfb: 0.05 })).toEqual({ tcp: 100, tls: 100, total: 200, src: 0 });
  });
});

describe('src/domain/quality.js · computeQuality', () => {
  const okPoint = { ok: true, total: 60, avgTcp: 10, avgTls: 20, avgHttp: 30 };
  const tenOk = () => Array.from({ length: 10 }, () => ({ ...okPoint }));

  afterEach(() => {
    CONFIG.speedMinMBps = 0;
    CONFIG.speedEnabled = true;
    CONFIG.maxTotalMs = 0;
    CONFIG.qualityWindow = 10;
  });

  it('无样本时不判定优质', () => {
    expect(computeQuality([], null, null)).toEqual({
      quality: false,
      rate: 0,
      qualRate: 0,
      avgTotal: null,
      avgTcp: null,
      avgTls: null,
      avgHttp: null,
      samples: 0,
      speedPass: true,
      onlinePass: true,
    });
  });

  it('未满窗口（样本不足）不判定优质', () => {
    const q = computeQuality([{ ...okPoint }], null, null);
    expect(q.samples).toBe(1);
    expect(q.rate).toBe(1);
    expect(q.quality).toBe(false);
  });

  it('满窗口且全部在线且达标 → 优质，平均值正确', () => {
    const q = computeQuality(tenOk(), null, null);
    expect(q.samples).toBe(10);
    expect(q.rate).toBe(1);
    expect(q.qualRate).toBe(1);
    expect(q.avgTotal).toBe(60);
    expect(q.avgTcp).toBe(10);
    expect(q.avgTls).toBe(20);
    expect(q.avgHttp).toBe(30);
    expect(q.quality).toBe(true);
  });

  it('成功率不足阈值（0.5 < 1）不判定优质', () => {
    const points = [...tenOk().slice(0, 5), ...Array.from({ length: 5 }, () => ({ ok: false }))];
    const q = computeQuality(points, null, null);
    expect(q.samples).toBe(10);
    expect(q.rate).toBe(0.5);
    expect(q.quality).toBe(false);
  });

  it('仅统计窗口内最近 N 条样本（多余样本被裁掉）', () => {
    const points = [{ ok: false }, ...tenOk()];
    const q = computeQuality(points, null, null);
    expect(q.samples).toBe(10);
    expect(q.rate).toBe(1);
    expect(q.quality).toBe(true);
  });

  it('速度下限为 0 时即使无测速记录也通过 speedPass', () => {
    const q = computeQuality(tenOk(), null, null);
    expect(q.speedPass).toBe(true);
  });

  it('设置速度下限后，未达标测速记录导致不优质', () => {
    CONFIG.speedMinMBps = 5;
    expect(computeQuality(tenOk(), null, null).speedPass).toBe(false);
    expect(computeQuality(tenOk(), { ok: true, mbps: 3 }, null).speedPass).toBe(false);
    expect(computeQuality(tenOk(), { ok: true, mbps: 10 }, null).speedPass).toBe(true);
    expect(computeQuality(tenOk(), { ok: true, mbps: 10 }, null).quality).toBe(true);
  });
});

describe('src/domain/history.js · computeOnlineSince', () => {
  beforeEach(() => {
    state.history = {};
    state.nodes = {};
  });

  it('连续全部在线时返回最早样本时间', () => {
    state.history.a = [
      { t: 100, ok: true },
      { t: 200, ok: true },
      { t: 300, ok: true },
    ];
    expect(computeOnlineSince('a')).toBe(100);
  });

  it('最近一次失败后重新在线时返回失败之后的首个成功样本时间', () => {
    state.history.a = [
      { t: 10, ok: false },
      { t: 20, ok: true },
      { t: 30, ok: true },
    ];
    expect(computeOnlineSince('a')).toBe(20);
  });

  it('最新样本失败返回 null', () => {
    state.history.a = [
      { t: 1, ok: true },
      { t: 2, ok: false },
    ];
    expect(computeOnlineSince('a')).toBeNull();
  });

  it('无样本返回 null', () => {
    expect(computeOnlineSince('missing')).toBeNull();
  });
});

describe('src/domain/history.js · offlineSince', () => {
  beforeEach(() => {
    state.history = {};
    state.nodes = {};
  });

  it('优先取节点 lastOnlineAt', () => {
    state.nodes.a = { lastOnlineAt: 500 };
    expect(offlineSince('a')).toBe(500);
  });

  it('无 lastOnlineAt 时取最近一次成功样本时间', () => {
    state.nodes.a = {};
    state.history.a = [
      { t: 10, ok: true },
      { t: 20, ok: false },
    ];
    expect(offlineSince('a')).toBe(10);
  });

  it('无成功样本时回退到 firstSeen', () => {
    state.nodes.a = { firstSeen: 777 };
    state.history.a = [];
    expect(offlineSince('a')).toBe(777);
  });

  it('无成功样本且无 firstSeen 时回退到最早样本时间', () => {
    state.nodes.a = {};
    state.history.a = [{ t: 5, ok: false }];
    expect(offlineSince('a')).toBe(5);
  });

  it('完全无记录时回退到当前时间', () => {
    state.nodes.a = {};
    state.history.a = [];
    const t = offlineSince('a');
    expect(typeof t).toBe('number');
    expect(Math.abs(t - Date.now())).toBeLessThan(5000);
  });
});

describe('src/config.js · historyCap', () => {
  let original;
  beforeEach(() => {
    original = CONFIG.qualityWindow;
  });
  afterEach(() => {
    CONFIG.qualityWindow = original;
  });

  it('默认 qualityWindow=10 → 10', () => {
    CONFIG.qualityWindow = 10;
    expect(historyCap()).toBe(10);
  });

  it('上限 50', () => {
    CONFIG.qualityWindow = 100;
    expect(historyCap()).toBe(50);
  });

  it('下限 1', () => {
    CONFIG.qualityWindow = -5;
    expect(historyCap()).toBe(1);
  });

  it('0 视为无效回落默认 10', () => {
    CONFIG.qualityWindow = 0;
    expect(historyCap()).toBe(10);
  });
});

describe('src/storage.js · 落盘失败必须暴露真实原因', () => {
  const storage = require('../src/storage.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let origIp, origDataDir, origConfigFile, tmpRoot;

  beforeEach(() => {
    origIp = CONFIG.ipFile;
    origDataDir = CONFIG.dataDir;
    origConfigFile = CONFIG.configFile;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-storage-'));
    // 用一个「普通文件」充当父目录，保证 mkdir 必然失败（不依赖具体环境权限）
    fs.writeFileSync(path.join(tmpRoot, 'blocker'), 'x');
  });
  afterEach(() => {
    CONFIG.ipFile = origIp;
    CONFIG.dataDir = origDataDir;
    CONFIG.configFile = origConfigFile;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {}
  });

  it('父路径不可创建时返回 ok:false，并携带真实 errno（而不是「占用为目录」）', () => {
    CONFIG.ipFile = path.join(tmpRoot, 'blocker', 'config', 'ip.txt');
    const r = storage.ensureIpFile();
    expect(r.ok).toBe(false);
    expect(String(r.error)).not.toContain('占用为目录');
    expect(String(r.error)).toMatch(/ENOTDIR|EEXIST|ENOENT|EACCES|EPERM/);
  });

  it('路径可写时返回 ok:true 并创建文件', () => {
    CONFIG.ipFile = path.join(tmpRoot, 'config', 'ip.txt');
    const r = storage.ensureIpFile();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(CONFIG.ipFile)).toBe(true);
  });

  it('persistConfig 落盘失败返回 false，不再静默吞掉', () => {
    CONFIG.dataDir = path.join(tmpRoot, 'blocker', 'data');
    CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
    expect(storage.persistConfig()).toBe(false);
  });

  it('persistConfig 落盘成功返回 true', () => {
    CONFIG.dataDir = path.join(tmpRoot, 'data');
    CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
    expect(storage.persistConfig()).toBe(true);
    expect(fs.existsSync(CONFIG.configFile)).toBe(true);
  });
});

describe('src/config.js · 默认路径为项目相对（容器路径由 Dockerfile ENV 注入）', () => {
  const cfg = require('../src/config.js');
  const fs = require('fs');
  const path = require('path');
  const CONFIG_SRC = require.resolve('../src/config.js');
  const PROJECT_ROOT = path.resolve(path.dirname(CONFIG_SRC), '..');

  it('未显式指定时，dataDir / ipFile 落在项目目录内', () => {
    if (!process.env.DATA_DIR) expect(cfg.CONFIG.dataDir).toBe(path.join(PROJECT_ROOT, 'data'));
    if (!process.env.IP_FILE) expect(cfg.CONFIG.ipFile).toBe(path.join(PROJECT_ROOT, 'config', 'ip.txt'));
  });

  it('派生文件全部位于 dataDir 之下', () => {
    for (const k of ['dataFile', 'configFile', 'graveyardFile', 'secretFile']) {
      expect(cfg.CONFIG[k].startsWith(cfg.CONFIG.dataDir + path.sep)).toBe(true);
    }
  });

  it('应用源码不再硬编码容器路径作为默认值', () => {
    // 容器路径属于部署知识，只应出现在 Dockerfile，不应出现在应用默认值里
    expect(fs.readFileSync(CONFIG_SRC, 'utf8')).not.toMatch(/['"`]\/app/);
  });
});
