// events.js — 全部 DOM 事件绑定与事件委托（唯一的事件注册点）
import {
  DATA,
  FILTERS,
  SELECTED,
  GRAVE_SELECTED,
  currentFiltered,
  els,
  refresh,
  resetFilters,
  setSort,
} from './store.js';
import { $, closeModal, setBtnLoading, settleConfirm, showConfirm, toast, trapFocus } from './utils/dom.js';
import { api } from './api.js';
import { copyItems, removeIds, runSpeedTest } from './actions.js';
import { renderTable } from './views/table.js';
import { updateSelectedCount, updateSelectAll } from './views/filters.js';
import { openLogs, loadLogs, stopLogs } from './views/logs.js';
import { openSettings, collectSettings, addProbeRow } from './views/settings.js';
import { unblockGraveIds, loadGraveyard, updateGraveSelectedCount } from './views/graveyard.js';
import { openManual } from './views/manual.js';
import { showTooltip, positionTooltip, hideTooltip } from './views/tooltip.js';

// 统一关闭入口：除显隐外，补齐日志轮询停止与确认框兜底 promise
function closeAny(el) {
  closeModal(el);
  if (el.id === 'logsModal') stopLogs();
  if (el.id === 'confirmModal') settleConfirm(false);
}

export function bindEvents() {
  $('#btnManual').addEventListener('click', openManual);
  // 页脚手册是带 href 的链接（可键盘聚焦），拦截默认跳转后仍走同一打开逻辑
  $('#footerManual').addEventListener('click', (e) => {
    e.preventDefault();
    openManual();
  });
  $('#btnLogs').addEventListener('click', openLogs);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnRefreshLogs').addEventListener('click', loadLogs);
  els.btnCheck.addEventListener('click', async () => {
    try {
      await api('/api/check', 'POST');
      toast('已触发检测', 'success');
      refresh();
    } catch (e) {
      toast('触发检测失败: ' + e.message, 'error');
    }
  });
  els.btnAbort.addEventListener('click', async () => {
    try {
      await api('/api/abort', 'POST');
      toast('已请求中断当前检测', 'info');
    } catch (e) {
      toast('中断失败: ' + e.message, 'error');
    }
  });
  els.btnUpload.addEventListener('click', async () => {
    if (DATA.state && !DATA.state.github?.configured) {
      const ok = await showConfirm('GitHub 未配置', '尚未配置 GitHub Token / 仓库。是否打开设置？', '打开设置');
      if (ok) openSettings();
      return;
    }
    const btn = els.btnUpload;
    setBtnLoading(btn, true, '上传中...');
    try {
      const res = await api('/api/upload', 'POST');
      if (res.failed && res.failed > 0) {
        toast(`已上传但 ${res.failed} 个文件失败，下轮自动重试`, 'warn');
      } else {
        toast(`上传成功：${res.count} 个优质节点，${res.fileCount} 个文件`, 'success');
      }
      refresh();
    } catch (e) {
      toast('上传失败: ' + e.message, 'error');
    } finally {
      setBtnLoading(btn, false);
    }
  });
  $('#searchInput').addEventListener('input', (e) => {
    FILTERS.search = e.target.value.trim();
    renderTable();
  });
  $('#kindFilter').addEventListener('change', (e) => {
    FILTERS.kind = e.target.value;
    renderTable();
  });
  $('#statusFilter').addEventListener('change', (e) => {
    FILTERS.status = e.target.value;
    renderTable();
  });
  $('#maxLatencyFilter').addEventListener('input', (e) => {
    FILTERS.maxLatency = e.target.value;
    renderTable();
  });
  $('#minSpeedFilter').addEventListener('input', (e) => {
    FILTERS.minSpeed = e.target.value;
    renderTable();
  });
  $('#qualRateFilter').addEventListener('input', (e) => {
    FILTERS.minQual = e.target.value;
    renderTable();
  });
  $('#successRateFilter').addEventListener('input', (e) => {
    FILTERS.minSuccess = e.target.value;
    renderTable();
  });
  // 连续在线时长筛选
  $('#minOnlineFilter').addEventListener('input', (e) => {
    FILTERS.minOnline = e.target.value;
    renderTable();
  });
  $('#onlineOpFilter').addEventListener('change', (e) => {
    FILTERS.onlineOp = e.target.value;
    renderTable();
  });
  // 运算符(纯文本样式)点击展开切换, 即时生效
  $('#latOpFilter').addEventListener('change', (e) => {
    FILTERS.latOp = e.target.value;
    renderTable();
  });
  $('#speedOpFilter').addEventListener('change', (e) => {
    FILTERS.speedOp = e.target.value;
    renderTable();
  });
  $('#qualOpFilter').addEventListener('change', (e) => {
    FILTERS.qualOp = e.target.value;
    renderTable();
  });
  $('#successOpFilter').addEventListener('change', (e) => {
    FILTERS.successOp = e.target.value;
    renderTable();
  });
  $('#coloFilter').addEventListener('change', (e) => {
    FILTERS.colo = e.target.value;
    renderTable();
  });
  $('#locFilter').addEventListener('change', (e) => {
    FILTERS.loc = e.target.value;
    renderTable();
  });
  $('#onlyQualityFilter').addEventListener('change', (e) => {
    FILTERS.onlyQuality = e.target.checked;
    renderTable();
  });
  $('#sortSelect').addEventListener('change', (e) => {
    setSort(e.target.value);
    renderTable();
  });
  // 重置: 运算符一并恢复默认 (总延迟≤, 其余≥)
  $('#btnResetFilters').addEventListener('click', () => {
    resetFilters();
    $('#searchInput').value = '';
    $('#kindFilter').value = 'all';
    $('#statusFilter').value = 'all';
    $('#latOpFilter').value = 'lte';
    $('#maxLatencyFilter').value = '';
    $('#speedOpFilter').value = 'gte';
    $('#minSpeedFilter').value = '';
    $('#qualOpFilter').value = 'gte';
    $('#qualRateFilter').value = '';
    $('#successOpFilter').value = 'gte';
    $('#successRateFilter').value = '';
    $('#onlineOpFilter').value = 'gte';
    $('#minOnlineFilter').value = '';
    $('#coloFilter').value = '';
    $('#locFilter').value = '';
    $('#onlyQualityFilter').checked = false;
    renderTable();
  });
  els.btnCopyFiltered.addEventListener('click', () => copyItems(currentFiltered));
  els.selectAll.addEventListener('change', (e) => {
    const c = e.target.checked;
    currentFiltered.forEach((i) => {
      if (c) SELECTED.add(i.id);
      else SELECTED.delete(i.id);
    });
    renderTable();
  });
  els.btnDeleteSelected.addEventListener('click', () => removeIds(Array.from(SELECTED)));
  els.tbody.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-id]');
    if (!cb) return;
    const id = cb.dataset.id;
    if (cb.checked) SELECTED.add(id);
    else SELECTED.delete(id);
    const row = cb.closest('tr');
    if (row) row.classList.toggle('selected', cb.checked);
    updateSelectedCount();
    updateSelectAll();
  });
  els.tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const id = btn.dataset.id;
    const op = btn.dataset.op;
    if (op === 'del') removeIds([id]);
    else if (op === 'copy') {
      const item = DATA.state?.items?.find((x) => x.id === id);
      if (item) copyItems([item]);
    } else if (op === 'speed') runSpeedTest(id);
  });
  els.tbody.addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.bar');
    if (!bar) return;
    showTooltip(bar, e);
  });
  els.tbody.addEventListener('mousemove', (e) => {
    if ($('#tooltip').classList.contains('show')) positionTooltip(e);
  });
  els.tbody.addEventListener('mouseout', (e) => {
    const bar = e.target.closest('.bar');
    if (!bar) return;
    const to = e.relatedTarget;
    if (to && bar.contains(to)) return;
    hideTooltip();
  });
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('mousedown', (e) => {
      if (e.target === m) closeAny(m);
    }),
  );
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => {
      const el = document.getElementById(b.dataset.close);
      if (el) closeAny(el);
    }),
  );
  document.addEventListener('keydown', (e) => {
    const open = document.querySelectorAll('.modal.show');
    if (e.key === 'Escape') {
      if (open.length) closeAny(open[open.length - 1]);
      return;
    }
    // Tab 在弹窗内循环，保持焦点不逃逸到背景内容
    if (e.key === 'Tab' && open.length) trapFocus(open[open.length - 1], e);
  });
  $('#confirmOkBtn').addEventListener('click', () => {
    settleConfirm(true);
    closeModal($('#confirmModal'));
  });
  $('#confirmCancelBtn').addEventListener('click', () => {
    settleConfirm(false);
    closeModal($('#confirmModal'));
  });
  $('#btnAddProbe').addEventListener('click', () => addProbeRow());
  $('#customProbesWrap').addEventListener('click', (e) => {
    if (!e.target.closest('.probe-remove')) return;
    const row = e.target.closest('.probe-row');
    if (row) row.remove();
    if (!$('#customProbesWrap').children.length)
      $('#customProbesWrap').innerHTML = '<div class="muted">未配置自定义探针（仅使用官方探针）</div>';
  });
  $('#btnSaveConfig').addEventListener('click', async () => {
    const btn = $('#btnSaveConfig');
    setBtnLoading(btn, true);
    try {
      await api('/api/config', 'POST', collectSettings());
      toast('配置已保存，后端已开始新一轮检测', 'success');
      refresh();
    } catch (e) {
      toast('保存配置失败: ' + e.message, 'error');
    } finally {
      setBtnLoading(btn, false);
    }
  });
  $('#btnSaveReload').addEventListener('click', async () => {
    const btn = $('#btnSaveReload');
    setBtnLoading(btn, true);
    try {
      await api('/api/config', 'POST', collectSettings());
      await api('/api/ipfile', 'POST', { content: $('#ipContent').value });
      try {
        await api('/api/reload', 'POST');
      } catch (e) {}
      toast('配置与节点列表已保存，重载已触发', 'success');
      refresh();
    } catch (e) {
      toast('保存并重载失败: ' + e.message, 'error');
    } finally {
      setBtnLoading(btn, false);
    }
  });
  $('#btnClearGraveyard').addEventListener('click', async () => {
    const ok = await showConfirm('清空记录', '清空后将解除全部屏蔽，被删除节点可重新加入。确定清空吗？', '清空', true);
    if (!ok) return;
    try {
      await api('/api/graveyard/clear', 'POST');
      toast('已清空屏蔽记录', 'success');
      GRAVE_SELECTED.clear();
      loadGraveyard();
    } catch (e) {
      toast('清空失败: ' + e.message, 'error');
    }
  });
  $('#btnUnblockSelected').addEventListener('click', () => {
    unblockGraveIds(Array.from(GRAVE_SELECTED));
  });
  $('#graveyardList').addEventListener('change', (e) => {
    const cb = e.target.closest('.grave-check');
    if (!cb) return;
    const id = cb.dataset.id;
    if (cb.checked) GRAVE_SELECTED.add(id);
    else GRAVE_SELECTED.delete(id);
    updateGraveSelectedCount();
  });
  $('#graveyardList').addEventListener('click', async (e) => {
    const btn = e.target.closest("button[data-op='unblock']");
    if (!btn) return;
    const id = btn.dataset.id;
    unblockGraveIds([id]);
  });
  $('#graveSelectAll').addEventListener('change', (e) => {
    const checks = document.querySelectorAll('#graveyardList .grave-check');
    checks.forEach((cb) => {
      if (e.target.checked) GRAVE_SELECTED.add(cb.dataset.id);
      else GRAVE_SELECTED.delete(cb.dataset.id);
      cb.checked = e.target.checked;
    });
    updateGraveSelectedCount();
  });
}
