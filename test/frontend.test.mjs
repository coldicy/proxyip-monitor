// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  escapeHtml,
  fmtTime,
  flagEmoji,
  fmtCellMs,
  fmtPct,
  parseRatioInput,
  cmpOp,
  fmtDuration,
} from '../public/js/utils/format.js';
import {
  qualityWindow,
  speedMin,
  speedOf,
  effectiveMeta,
  latencyClass,
  rateClass,
  statusOf,
  failReasonFor,
  srcLabelOf,
} from '../public/js/domain/node.js';
import { DATA, FILTERS, SORT, setSort, resetFilters } from '../public/js/store.js';
import { getFiltered } from '../public/js/views/filters.js';
import { openModal, closeModal, trapFocus, setBtnLoading } from '../public/js/utils/dom.js';

const setConfig = (cfg) => {
  DATA.state = {
    items: DATA.state?.items || [],
    config: { qualityWindow: 10, maxTotalMs: 0, speedMinMBps: 0, ...cfg },
  };
};

describe('public/js/utils/format.js · 纯格式化函数', () => {
  it('escapeHtml 转义五个危险字符与 null', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('fmtTime 无时间戳返回占位符', () => {
    expect(fmtTime(0)).toBe('-');
    expect(fmtTime(null)).toBe('-');
    expect(fmtTime(Date.now())).not.toBe('-');
  });

  it('flagEmoji 仅接受两位国家码', () => {
    expect(flagEmoji('JP')).toBe('🇯🇵');
    expect(flagEmoji('us')).toBe('🇺🇸');
    expect(flagEmoji('')).toBe('🌍');
    expect(flagEmoji('JPN')).toBe('🌍');
    expect(flagEmoji(null)).toBe('🌍');
  });

  it('fmtCellMs 四舍五入并处理非法值', () => {
    expect(fmtCellMs(123.6)).toBe('124<span class="unit">ms</span>');
    expect(fmtCellMs(null)).toBe('<span class="muted">-</span>');
    expect(fmtCellMs(NaN)).toBe('<span class="muted">-</span>');
  });

  it('fmtPct 保留一位小数', () => {
    expect(fmtPct(0.9876)).toBe('98.8%');
    expect(fmtPct(null)).toBe('<span class="muted">-</span>');
  });

  it('parseRatioInput 兼容百分数与小数并钳制到 [0,1]', () => {
    expect(parseRatioInput('')).toBeNull();
    expect(parseRatioInput(null)).toBeNull();
    expect(parseRatioInput('abc')).toBeNull();
    expect(parseRatioInput('0.5')).toBe(0.5);
    expect(parseRatioInput('50')).toBe(0.5);
    expect(parseRatioInput('150')).toBe(1);
    expect(parseRatioInput('-1')).toBe(0);
  });

  it('cmpOp 支持五种运算符', () => {
    expect(cmpOp('lte', 1, 2)).toBe(true);
    expect(cmpOp('gte', 2, 2)).toBe(true);
    expect(cmpOp('lt', 2, 2)).toBe(false);
    expect(cmpOp('gt', 3, 2)).toBe(true);
    expect(cmpOp('eq', 0.1 + 0.2, 0.3)).toBe(true);
  });

  it('fmtDuration 按天/小时/分/秒分级', () => {
    expect(fmtDuration(30000)).toBe('30秒');
    expect(fmtDuration(60000)).toBe('1分钟');
    expect(fmtDuration(3600000)).toBe('1小时');
    expect(fmtDuration(5400000)).toBe('1小时30分');
    expect(fmtDuration(86400000)).toBe('1天');
    expect(fmtDuration(90000000)).toBe('1天1小时');
    expect(fmtDuration(-1)).toBe('-');
    expect(fmtDuration(null)).toBe('-');
  });
});

describe('public/js/domain/node.js · 质量分级与状态判定', () => {
  beforeEach(() => {
    setConfig({ qualityWindow: 20, maxTotalMs: 0, speedMinMBps: 0 });
  });

  it('qualityWindow / speedMin 取自 DATA.state.config 并带兜底', () => {
    expect(qualityWindow()).toBe(20);
    DATA.state = null;
    expect(qualityWindow()).toBe(10);
    expect(speedMin()).toBe(0);
  });

  it('speedOf 仅在测速成功且有数值时返回', () => {
    expect(speedOf({ speed: { ok: true, mbps: 5.2 } })).toBe(5.2);
    expect(speedOf({ speed: { ok: false, mbps: 5.2 } })).toBeNull();
    expect(speedOf({})).toBeNull();
  });

  it('latencyClass 以 maxTotalMs 为界；未设上限恒为 good', () => {
    setConfig({ maxTotalMs: 1000 });
    expect(latencyClass(800)).toBe('good');
    expect(latencyClass(1200)).toBe('warn');
    setConfig({ maxTotalMs: 0 });
    expect(latencyClass(9999)).toBe('good');
    expect(latencyClass(null)).toBe('');
  });

  it('rateClass 三段判定：达标 good / 临界 warn / 过低 bad', () => {
    expect(rateClass(0.95, 0.9)).toBe('good');
    expect(rateClass(0.8, 0.9)).toBe('warn');
    expect(rateClass(0.5, 0.9)).toBe('bad');
    expect(rateClass(0.5, 0)).toBe('good');
    expect(rateClass(null, 0.9)).toBe('');
  });

  it('statusOf 覆盖优质/达标/未达标/离线', () => {
    setConfig({ maxTotalMs: 1000 });
    expect(statusOf({ quality: { quality: true }, latest: { ok: true } })).toBe('quality');
    expect(statusOf({ quality: {}, latest: { ok: true, total: 500 } })).toBe('qual');
    expect(statusOf({ quality: {}, latest: { ok: true, total: 2000 } })).toBe('unqual');
    expect(statusOf({ quality: {}, latest: { ok: false } })).toBe('offline');
    setConfig({ maxTotalMs: 0 });
    expect(statusOf({ quality: {}, latest: { ok: true, total: 99999 } })).toBe('qual');
  });

  it('effectiveMeta 优先最新样本，缺失时回退历史', () => {
    const both = effectiveMeta({
      latest: { loc: 'JP', colo: 'NRT', exitIp: '1.1.1.1' },
      recent: [{ loc: 'US', colo: 'LAX', exitIp: '2.2.2.2' }],
    });
    expect(both.loc).toEqual({ v: 'JP', hist: false });
    const fallback = effectiveMeta({ latest: {}, recent: [{ loc: 'US', colo: 'LAX', exitIp: '2.2.2.2' }] });
    expect(fallback.colo).toEqual({ v: 'LAX', hist: true });
    const none = effectiveMeta({ latest: {}, recent: [] });
    expect(none.loc).toEqual({ v: null, hist: false });
  });

  it('failReasonFor 区分自定义探针与官方探针失败', () => {
    expect(failReasonFor({ failReason: '超时' })).toBe('超时');
    expect(failReasonFor({ off: {} })).toContain('自定义源站探针');
    expect(failReasonFor({})).toContain('官方探针未通过');
  });

  it('srcLabelOf 按来源类型给出中文标签', () => {
    expect(srcLabelOf({ srcKind: 'pure' })).toBe('纯IP');
    expect(srcLabelOf({ srcKind: 'dom', srcName: 'a.com' })).toBe('域名/a.com');
    expect(srcLabelOf({ srcKind: 'url', srcName: 'x' })).toBe('列表/x');
  });
});

describe('public/js/views/filters.js · getFiltered 筛选与排序', () => {
  const node = (over = {}) => ({
    id: '1.1.1.1:443',
    ip: '1.1.1.1',
    port: 443,
    ipKind: 'cf',
    srcKind: 'pure',
    srcName: '1.1.1.1',
    onlineSince: null,
    latest: { ok: true, total: 100, loc: 'JP', colo: 'NRT', exitIp: '1.1.1.1' },
    recent: [],
    quality: { quality: false, avgTotal: 100, rate: 1, qualRate: 1 },
    speed: null,
    ...over,
  });

  beforeEach(() => {
    resetFilters();
    setSort('total_asc');
    DATA.state = {
      config: { qualityWindow: 10, maxTotalMs: 0, speedMinMBps: 0 },
      items: [
        node({
          id: 'a',
          ip: '1.1.1.1',
          ipKind: 'cf',
          quality: { quality: false, avgTotal: 300, rate: 0.5, qualRate: 0.5 },
        }),
        node({
          id: 'b',
          ip: '2.2.2.2',
          ipKind: 'proxy',
          latest: { ok: true, total: 50, loc: 'US', colo: 'LAX', exitIp: '2.2.2.2' },
          quality: { quality: true, avgTotal: 50, rate: 1, qualRate: 1 },
          speed: { ok: true, mbps: 8 },
        }),
        node({
          id: 'c',
          ip: '3.3.3.3',
          ipKind: 'cf',
          latest: { ok: false, total: null, loc: null, colo: null, exitIp: null },
          quality: { quality: false, avgTotal: null, rate: 0, qualRate: 0 },
        }),
      ],
    };
  });

  it('无 state 时返回空数组', () => {
    DATA.state = null;
    expect(getFiltered()).toEqual([]);
  });

  it('默认按总延迟升序，无延迟排最后', () => {
    const ids = getFiltered().map((i) => i.id);
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('search 命中 id / ip / 地区 / 数据中心', () => {
    Object.assign(FILTERS, { search: 'lax' });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
    Object.assign(FILTERS, { search: '3.3' });
    expect(getFiltered().map((i) => i.id)).toEqual(['c']);
  });

  it('kind 过滤按 ipKind', () => {
    Object.assign(FILTERS, { kind: 'proxy' });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
  });

  it('status=online 只保留最新样本成功的节点', () => {
    Object.assign(FILTERS, { status: 'online' });
    expect(
      getFiltered()
        .map((i) => i.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('onlyQuality 只保留优质节点', () => {
    Object.assign(FILTERS, { onlyQuality: true });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
  });

  it('maxLatency 配合运算符生效', () => {
    Object.assign(FILTERS, { maxLatency: '100', latOp: 'lte' });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
    Object.assign(FILTERS, { maxLatency: '100', latOp: 'gte' });
    expect(
      getFiltered()
        .map((i) => i.id)
        .sort(),
    ).toEqual(['a']);
  });

  it('minSpeed 过滤测速数值', () => {
    Object.assign(FILTERS, { minSpeed: '5' });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
  });

  it('minSuccess 百分比输入被换算为比例', () => {
    Object.assign(FILTERS, { minSuccess: '80' });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
  });

  it('colo 与 loc 精确匹配', () => {
    Object.assign(FILTERS, { colo: 'NRT' });
    expect(getFiltered().map((i) => i.id)).toEqual(['a']);
    resetFilters();
    Object.assign(FILTERS, { loc: 'US' });
    expect(getFiltered().map((i) => i.id)).toEqual(['b']);
  });

  it('sort 变更改变结果顺序', () => {
    setSort('success_desc');
    expect(getFiltered().map((i) => i.id)[0]).toBe('b');
    setSort('speed_desc');
    expect(getFiltered().map((i) => i.id)[0]).toBe('b');
  });

  it('online_desc 将离线节点排在最后', () => {
    setSort('online_desc');
    DATA.state.items[0].onlineSince = Date.now() - 2 * 3600 * 1000;
    const ids = getFiltered().map((i) => i.id);
    expect(ids[0]).toBe('a');
    expect(ids[ids.length - 1]).toBe('c');
  });

  it('sort 变量默认值为 total_asc（模块内可读）', () => {
    expect(SORT).toBe('total_asc');
  });
});

describe('public/js/utils/dom.js · 弹窗焦点管理', () => {
  it('openModal 把焦点移入弹窗卡片，closeModal 归还触发元素', () => {
    document.body.innerHTML =
      '<button id="trigger">t</button><div class="modal" id="m"><div class="modal-card" tabindex="-1"><button id="inner">b</button></div></div>';
    const trigger = document.getElementById('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const modal = document.getElementById('m');
    openModal(modal);
    expect(modal.classList.contains('show')).toBe(true);
    expect(document.body.classList.contains('modal-open')).toBe(true);
    expect(document.activeElement.classList.contains('modal-card')).toBe(true);

    closeModal(modal);
    expect(modal.classList.contains('show')).toBe(false);
    expect(document.body.classList.contains('modal-open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('trapFocus 在首尾可聚焦元素之间循环', () => {
    document.body.innerHTML =
      '<div class="modal" id="m"><div class="modal-card"><button id="first">1</button><button id="last">2</button></div></div>';
    const modal = document.getElementById('m');
    const first = document.getElementById('first');
    const last = document.getElementById('last');

    first.focus();
    const back = { shiftKey: true, preventDefault: vi.fn() };
    trapFocus(modal, back);
    expect(document.activeElement).toBe(last);
    expect(back.preventDefault).toHaveBeenCalled();

    const forward = { shiftKey: false, preventDefault: vi.fn() };
    trapFocus(modal, forward);
    expect(document.activeElement).toBe(first);
    expect(forward.preventDefault).toHaveBeenCalled();
  });

  it('setBtnLoading 切换禁用态并在恢复时还原内容', () => {
    document.body.innerHTML = '<button id="btn">保存</button>';
    const btn = document.getElementById('btn');
    setBtnLoading(btn, true, '处理中...');
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toBe('处理中...');
    setBtnLoading(btn, false);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe('保存');
  });
});

describe('public/index.html · 可访问性标记', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'public/index.html'), 'utf8');

  it('四个弹窗均声明 role=dialog 与 aria-modal', () => {
    const dialogs = html.match(/role="dialog"/g) || [];
    expect(dialogs.length).toBe(4);
    expect(html.match(/aria-modal="true"/g)?.length).toBe(4);
  });

  it('Toast 容器是 live region', () => {
    expect(html).toMatch(/id="toastWrap"[^>]*aria-live="polite"/);
  });

  it('页脚手册是带 href 的可聚焦链接', () => {
    expect(html).toMatch(/<a id="footerManual" href="#manualModal">/);
  });
});
