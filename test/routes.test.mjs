import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 路由层集成测试：起真实 http server 打各端点，重点锁住「落盘失败必须返回 500 与真实文案」这条链路
const require = createRequire(import.meta.url);
const { createServer } = require('../src/api/server.js');
const { buildState } = require('../src/api/view.js');
const { state, setStateBuilder } = require('../src/state.js');
const { CONFIG } = require('../src/config.js');

let server;
let tmpRoot;
let orig;

function request(pathname, { method = 'GET', body } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: body != null ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {}
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

beforeAll(async () => {
  orig = { ipFile: CONFIG.ipFile, dataDir: CONFIG.dataDir, dataFile: CONFIG.dataFile, configFile: CONFIG.configFile };
  // /api/state 依赖注入的 buildState（引导阶段由 server.js 注入，测试里手动接上）
  setStateBuilder(buildState);
  // 预置 CF 段，避免 discover → refreshCfCidrs 触发真实网络请求
  state.cfCidrs = ['104.16.0.0/12'];
  state.cfCidrsAt = Date.now();

  server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
});

beforeEach(() => {
  // 每例前把可写路径复位到临时目录，并清空内存态，保证用例之间互不影响
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-routes-'));
  const emptyIp = path.join(tmpRoot, 'empty-ip.txt');
  fs.writeFileSync(emptyIp, '');
  CONFIG.ipFile = emptyIp;
  CONFIG.dataDir = path.join(tmpRoot, 'data');
  CONFIG.dataFile = path.join(CONFIG.dataDir, 'history.json');
  CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
  state.nodes = {};
  state.history = {};
  state.blocked = {};
  state.graveyard.list = [];
  state.logs = [];
  state.checking = false;
});

afterAll(async () => {
  Object.assign(CONFIG, orig);
  await new Promise((res) => server.close(res));
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {}
});

describe('路由层集成 · 基础端点', () => {
  it('GET /api/logs 返回日志数组', async () => {
    const r = await request('/api/logs');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.logs)).toBe(true);
  });

  it('POST /api/abort 空闲时也返回 ok', async () => {
    const r = await request('/api/abort', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  it('GET /api/graveyard 返回屏蔽墓地列表', async () => {
    const r = await request('/api/graveyard');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.graveyard)).toBe(true);
  });

  it('POST /api/graveyard/unblock 空 ids 返回 400 与提示', async () => {
    const r = await request('/api/graveyard/unblock', { method: 'POST', body: { ids: [] } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: '无有效节点ID' });
  });

  it('POST /api/remove 空 ids 返回 400', async () => {
    const r = await request('/api/remove', { method: 'POST', body: {} });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('无有效节点ID');
  });

  it('GET /api/config 返回公开配置（含 github.tokenSet）', async () => {
    const r = await request('/api/config');
    expect(r.status).toBe(200);
    expect(typeof r.json.intervalSec).toBe('number');
    expect(typeof r.json.github.tokenSet).toBe('boolean');
  });

  it('GET /api/ipfile 读取当前 ip 文件内容', async () => {
    const f = path.join(tmpRoot, 'ip-with-content.txt');
    fs.writeFileSync(f, '1.2.3.4\n');
    CONFIG.ipFile = f;
    const r = await request('/api/ipfile');
    expect(r.status).toBe(200);
    expect(r.json.content).toBe('1.2.3.4\n');
  });

  it('未知 /api 子路径返回 404', async () => {
    const r = await request('/api/not-exist');
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'not found' });
  });
});

describe('路由层集成 · /api/state 视图', () => {
  it('返回版本号与汇总结构', async () => {
    const r = await request('/api/state');
    expect(r.status).toBe(200);
    expect(r.json.version).toBe('v36-window');
    expect(r.json.summary).toEqual({ total: 0, online: 0, quality: 0, offline: 0 });
    expect(typeof r.json.config.qualityWindow).toBe('number');
  });
});

describe('路由层集成 · 落盘失败必须返回 500 与真实文案', () => {
  it('POST /api/ipfile 父路径不可创建时返回 500 并携带真实原因', async () => {
    // 用一个普通文件充当父目录，保证 mkdir 必然失败（不依赖具体环境权限）
    fs.writeFileSync(path.join(tmpRoot, 'blocker'), 'x');
    CONFIG.ipFile = path.join(tmpRoot, 'blocker', 'config', 'ip.txt');
    const r = await request('/api/ipfile', { method: 'POST', body: { content: '1.2.3.4\n' } });
    expect(r.status).toBe(500);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('无法写入 ip.txt (' + CONFIG.ipFile + '): ');
    expect(r.json.error).toMatch(/ENOTDIR|EEXIST|ENOENT|EACCES|EPERM/);
  });

  it('POST /api/ipfile 成功写入并返回 ok', async () => {
    // 屏蔽该 IP，使 discover 跳过它，避免触发真实网络探测
    state.blocked['1.2.3.4:443'] = Date.now();
    CONFIG.ipFile = path.join(tmpRoot, 'ip-ok', 'ip.txt');
    const r = await request('/api/ipfile', { method: 'POST', body: { content: '1.2.3.4\n' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(fs.readFileSync(CONFIG.ipFile, 'utf8')).toBe('1.2.3.4\n');
    await new Promise((res) => setTimeout(res, 50));
  });

  it('POST /api/config 落盘失败时返回 500 与真实文案', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'blocker'), 'x');
    CONFIG.dataDir = path.join(tmpRoot, 'blocker', 'data');
    CONFIG.configFile = path.join(CONFIG.dataDir, 'config.json');
    const r = await request('/api/config', { method: 'POST', body: {} });
    expect(r.status).toBe(500);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe('配置保存失败：无法写入 ' + CONFIG.configFile);
    await new Promise((res) => setTimeout(res, 50));
  });

  it('POST /api/config 落盘成功时返回 ok 与配置', async () => {
    const r = await request('/api/config', { method: 'POST', body: { concurrency: 5 } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.config.concurrency).toBe(5);
    await new Promise((res) => setTimeout(res, 50));
  });
});
