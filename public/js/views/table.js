// table.js — 表格行渲染、延迟柱图与整表刷新
import { DATA, SELECTED, currentFiltered, els, setCurrentFiltered } from '../store.js';
import {
  statusOf,
  effectiveMeta,
  latencyClass,
  rateClass,
  speedOf,
  speedMin,
  qualityWindow,
  srcLabelOf,
} from '../domain/node.js';
import { getFiltered, updateSelectedCount, updateSelectAll } from './filters.js';
import { escapeHtml, fmtTime, fmtCellMs, fmtPct, fmtDuration, flagEmoji } from '../utils/format.js';

export function statusHtml(item) {
  const s = statusOf(item);
  if (s === 'quality') return '<span class="badge quality">优质</span>';
  if (s === 'qual') return '<span class="badge ok">达标</span>';
  if (s === 'unqual') return '<span class="badge unqual">未达标</span>';
  const fr = (item.latest || {}).failReason;
  return `<span class="badge offline"${fr ? ` title="${escapeHtml(fr)}"` : ''}>离线</span>`;
}

export function speedCellHtml(item) {
  const sp = item.speed || null;
  const minSp = speedMin();
  if (sp && sp.ok && sp.mbps != null) {
    const cls = minSp > 0 ? (sp.mbps >= minSp ? 'good' : 'bad') : 'good';
    return `<td class="metric ${cls}" title="测速时间 ${escapeHtml(fmtTime(sp.t))} · 一次性测速">${sp.mbps.toFixed(2)}<span class="unit">MB/s</span></td>`;
  }
  if (sp && !sp.ok)
    return `<td class="metric muted" title="${escapeHtml(sp.failReason || '测速失败')} · 在线时10分钟自动重试，可⚡手动复测">-</td>`;
  return `<td class="metric muted" title="尚未测速（首次在线时自动一次性测速）">-</td>`;
}

// 连续在线时长列; 离线/从未在线显示 -, 在线显示 天/小时/分
export function onlineDurationCell(item) {
  if (!item.onlineSince)
    return '<td class="metric muted" title="当前不在线（最近一次检测失败或尚无样本），连续在线时长已清零">-</td>';
  const ms = Date.now() - item.onlineSince;
  return `<td class="metric good" title="连续在线起点 ${escapeHtml(fmtTime(item.onlineSince))}">${fmtDuration(ms)}</td>`;
}

export function barsHtml(item) {
  const win = qualityWindow();
  const recent = (item.recent || []).slice(-win);
  if (!recent.length) return '<span class="chart-empty">暂无</span>';
  const totals = recent.filter((p) => p.ok && p.total != null).map((p) => p.total);
  const limit = DATA.state?.config?.maxTotalMs || 0;
  const max = Math.max(100, limit, ...totals);
  return recent
    .map((p, idx) => {
      let cls = 'bar';
      let h = 7;
      if (p.ok && p.total != null) {
        h = Math.max(8, Math.min(42, Math.round((p.total / max) * 42)));
        if (limit <= 0 || p.total <= limit) cls += ' ok';
        else cls += ' warn';
      } else {
        cls += ' fail';
        h = 8;
      }
      return `<span class="${cls}" style="height:${h}px" data-id="${escapeHtml(item.id)}" data-idx="${idx}"></span>`;
    })
    .join('');
}

export function rowHtml(item) {
  const q = item.quality || {};
  const latest = item.latest || {};
  const hasSamples = (q.samples || 0) > 0;
  const kind = item.ipKind || 'unknown';
  const kindCls = kind === 'cf' ? 'cf' : kind === 'proxy' ? 'proxy' : 'unknown';
  const kindTxt = kind === 'cf' ? 'CloudflareIP' : kind === 'proxy' ? 'ProxyIP' : '未知';
  const m = effectiveMeta(item);
  const qualCell = hasSamples ? fmtPct(q.qualRate) : fmtPct(null);
  const sucCell = hasSamples ? fmtPct(q.rate) : fmtPct(null);
  const qualCls = hasSamples ? rateClass(q.qualRate, DATA.state?.config?.qualThreshold) : '';
  const sucCls = hasSamples ? rateClass(q.rate, DATA.state?.config?.successThreshold) : '';
  return `<tr class="${SELECTED.has(item.id) ? 'selected' : ''}" data-row-id="${escapeHtml(item.id)}">
<td><input type="checkbox" data-id="${escapeHtml(item.id)}" ${SELECTED.has(item.id) ? 'checked' : ''} /></td>
<td>
<div class="ip-row"><span class="ip">${escapeHtml(item.ip)}:${item.port}</span><span class="tag ${kindCls}">${kindTxt}</span></div>
<div class="meta-col">
<div class="meta-line"><span title="首次引入时间">🆙 ${escapeHtml(fmtTime(item.firstSeen))}</span><span title="首次来源">📥 ${escapeHtml(srcLabelOf(item))}</span></div>
<div class="meta-line"><span title="${m.loc.hist ? '地区（历史样本补齐）' : '地区'}">${flagEmoji(m.loc.v)} ${escapeHtml(m.loc.v || '-')}</span><span title="${m.colo.hist ? '数据中心（历史样本补齐）' : '数据中心'}">🏢 ${escapeHtml(m.colo.v || '-')}</span><span title="${m.exitIp.hist ? '出口IP（历史样本补齐）' : '出口IP'}">🌐 ${escapeHtml(m.exitIp.v || '-')}</span></div>
<div class="meta-line"><span title="最近检测">🕒 ${escapeHtml(latest.t ? fmtTime(latest.t) : '-')}</span></div>
</div>
</td>
<td><div class="bars">${barsHtml(item)}</div></td>
<td class="metric ${latencyClass(q.avgTotal)}">${fmtCellMs(q.avgTotal)}</td>
<td class="metric ${latencyClass(q.avgTcp)}">${fmtCellMs(q.avgTcp)}</td>
<td class="metric ${latencyClass(q.avgTls)}">${fmtCellMs(q.avgTls)}</td>
<td class="metric ${latencyClass(q.avgHttp)}">${fmtCellMs(q.avgHttp)}</td>
${speedCellHtml(item)}
${onlineDurationCell(item)}
<td class="metric ${qualCls}">${qualCell}</td>
<td class="metric ${sucCls}">${sucCell}</td>
<td>${statusHtml(item)}</td>
<td><div class="ops">
<button class="mini-btn" data-op="copy" data-id="${escapeHtml(item.id)}">复制</button>
<button class="mini-btn" data-op="speed" data-id="${escapeHtml(item.id)}" title="手动复测速度">⚡</button>
<button class="mini-btn" data-op="del" data-id="${escapeHtml(item.id)}">删除</button></div></td></tr>`;
}

export function renderTable() {
  if (!DATA.state) return;
  setCurrentFiltered(getFiltered());
  const st = els.tableWrap.scrollTop;
  if (!DATA.state.items.length) {
    els.emptyTip.hidden = false;
    els.emptyTip.textContent = '暂无节点。请先在 ⚙️ 设置中填写 ip.txt，或等待列表源发现节点。';
    els.tbody.innerHTML = '';
  } else if (!currentFiltered.length) {
    els.emptyTip.hidden = false;
    els.emptyTip.textContent = '没有符合当前筛选条件的节点。可点击重置后重试。';
    els.tbody.innerHTML = '';
  } else {
    els.emptyTip.hidden = true;
    els.tbody.innerHTML = currentFiltered.map(rowHtml).join('');
  }
  els.tableWrap.scrollTop = st;
  els.filteredCount.textContent = `筛选 ${currentFiltered.length} / ${DATA.state?.summary?.total || 0}`;
  updateSelectedCount();
  updateSelectAll();
}
