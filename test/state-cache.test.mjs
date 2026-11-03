import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

// 本文件是批次 6（state 职责切分）的保护网：把 /api/state 响应缓存的语义固化为可执行断言。
// 关键语义：markDirty 只置脏位，**不会**绕过节流窗口；窗口在检测中为 2s、空闲为 4s。
const require = createRequire(import.meta.url);

let mod;
let state;
let buildCalls = 0;

beforeEach(() => {
  // stateCache* 是模块私有变量，删除 require 缓存以获得干净实例
  delete require.cache[require.resolve('../src/state.js')];
  mod = require('../src/state.js');
  state = mod.state;
  buildCalls = 0;
  mod.setStateBuilder(() => ({ n: ++buildCalls }));
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('响应缓存 · getStateJson', () => {
  it('数据未变时复用缓存，builder 只被调用一次', () => {
    const a = mod.getStateJson();
    const b = mod.getStateJson();
    expect(a).toBe(b);
    expect(buildCalls).toBe(1);
  });

  it('空闲（checking=false）时距上次重建不足 4s 仍返回旧缓存', () => {
    const a = mod.getStateJson();
    vi.setSystemTime(10_000 + 3_999);
    mod.invalidateStateCache();
    expect(mod.getStateJson()).toBe(a);
    expect(buildCalls).toBe(1);
  });

  it('空闲时超过 4s 重建缓存', () => {
    const a = mod.getStateJson();
    vi.setSystemTime(10_000 + 4_001);
    mod.invalidateStateCache();
    const b = mod.getStateJson();
    expect(b).not.toBe(a);
    expect(buildCalls).toBe(2);
  });

  it('检测中（checking=true）窗口收紧为 2s', () => {
    state.checking = true;
    const a = mod.getStateJson();
    vi.setSystemTime(10_000 + 1_999);
    mod.invalidateStateCache();
    expect(mod.getStateJson()).toBe(a);
    expect(buildCalls).toBe(1);

    vi.setSystemTime(10_000 + 2_001);
    expect(mod.getStateJson()).not.toBe(a);
    expect(buildCalls).toBe(2);
  });

  it('markDirty 置脏位，但不绕过节流窗口', () => {
    const a = mod.getStateJson();
    mod.markDirty();
    expect(mod.isDataDirty()).toBe(true);
    // 距上次重建 0ms，远小于空闲窗口 → 仍返回旧缓存
    expect(mod.getStateJson()).toBe(a);
    expect(buildCalls).toBe(1);
    // 越过窗口后必然重建
    vi.setSystemTime(10_000 + 4_001);
    expect(mod.getStateJson()).not.toBe(a);
    expect(buildCalls).toBe(2);
  });

  it('clearDataDirty 复位持久化脏位', () => {
    mod.markDirty();
    expect(mod.isDataDirty()).toBe(true);
    mod.clearDataDirty();
    expect(mod.isDataDirty()).toBe(false);
  });

  it('state 是模块级单例（跨调用同一引用）', () => {
    expect(mod.state).toBe(state);
  });
});
