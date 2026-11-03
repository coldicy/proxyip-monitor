import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

// 本文件是批次 6（state 职责切分）的保护网：把 /api/state 响应缓存的语义固化为可执行断言。
// 关键语义：markDirty 只置脏位，**不会**绕过节流窗口；窗口在检测中为 2s、空闲为 4s。
// 批次 6 后职责已分家：数据容器在 src/state.js，脏位/信号在 src/changeBus.js，缓存在 src/api/stateCache.js。
const require = createRequire(import.meta.url);

let state;
let bus;
let cache;
let buildCalls = 0;

beforeEach(() => {
  // 三者都是模块私有变量，删除 require 缓存以获得干净实例
  for (const p of ['../src/state.js', '../src/changeBus.js', '../src/api/stateCache.js']) {
    delete require.cache[require.resolve(p)];
  }
  // 先建 changeBus 单例，再让 stateCache 订阅同一个实例
  state = require('../src/state.js').state;
  bus = require('../src/changeBus.js');
  cache = require('../src/api/stateCache.js');
  buildCalls = 0;
  cache.setStateBuilder(() => ({ n: ++buildCalls }));
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('响应缓存 · getStateJson', () => {
  it('数据未变时复用缓存，builder 只被调用一次', () => {
    const a = cache.getStateJson();
    const b = cache.getStateJson();
    expect(a).toBe(b);
    expect(buildCalls).toBe(1);
  });

  it('空闲（checking=false）时距上次重建不足 4s 仍返回旧缓存', () => {
    const a = cache.getStateJson();
    vi.setSystemTime(10_000 + 3_999);
    bus.invalidate();
    expect(cache.getStateJson()).toBe(a);
    expect(buildCalls).toBe(1);
  });

  it('空闲时超过 4s 重建缓存', () => {
    const a = cache.getStateJson();
    vi.setSystemTime(10_000 + 4_001);
    bus.invalidate();
    const b = cache.getStateJson();
    expect(b).not.toBe(a);
    expect(buildCalls).toBe(2);
  });

  it('检测中（checking=true）窗口收紧为 2s', () => {
    state.checking = true;
    const a = cache.getStateJson();
    vi.setSystemTime(10_000 + 1_999);
    bus.invalidate();
    expect(cache.getStateJson()).toBe(a);
    expect(buildCalls).toBe(1);

    vi.setSystemTime(10_000 + 2_001);
    expect(cache.getStateJson()).not.toBe(a);
    expect(buildCalls).toBe(2);
  });

  it('markDirty 置脏位，但不绕过节流窗口', () => {
    const a = cache.getStateJson();
    bus.markDirty();
    expect(bus.isDataDirty()).toBe(true);
    // 距上次重建 0ms，远小于空闲窗口 → 仍返回旧缓存
    expect(cache.getStateJson()).toBe(a);
    expect(buildCalls).toBe(1);
    // 越过窗口后必然重建
    vi.setSystemTime(10_000 + 4_001);
    expect(cache.getStateJson()).not.toBe(a);
    expect(buildCalls).toBe(2);
  });

  it('clearDataDirty 复位持久化脏位', () => {
    bus.markDirty();
    expect(bus.isDataDirty()).toBe(true);
    bus.clearDataDirty();
    expect(bus.isDataDirty()).toBe(false);
  });

  it('state 是模块级单例（跨调用同一引用）', () => {
    expect(require('../src/state.js').state).toBe(state);
  });
});
