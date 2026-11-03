// dom.js — DOM 查询 / 弹窗 / 提示 / 剪贴板等通用 UI 原语（不依赖 store 与 views，避免循环依赖）
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));
export function toast(msg, type = 'info') {
  const w = $('#toastWrap');
  const d = document.createElement('div');
  d.className = 'toast ' + type;
  d.textContent = msg;
  w.appendChild(d);
  setTimeout(() => {
    d.style.opacity = '0';
    d.style.transform = 'translateY(8px)';
    setTimeout(() => d.remove(), 260);
  }, 4200);
}
// 可聚焦元素选择器，用于弹窗焦点陷阱
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let lastFocused = null;
export function openModal(el) {
  lastFocused = document.activeElement;
  el.classList.add('show');
  document.body.classList.add('modal-open');
  // 焦点移入弹窗卡片，屏幕阅读器与键盘用户可直接进入对话框内容
  const card = el.querySelector('.modal-card') || el;
  if (typeof card.focus === 'function') card.focus();
}
// 仅负责显隐；关闭相关的副作用（日志轮询、确认框兜底）由调用方在 events.js 统一处理
export function closeModal(el) {
  el.classList.remove('show');
  if (!document.querySelector('.modal.show')) document.body.classList.remove('modal-open');
  // 焦点归还给打开弹窗前的元素，避免焦点丢回 <body>
  if (lastFocused && typeof lastFocused.focus === 'function' && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
}
// 焦点陷阱：Tab / Shift+Tab 在最上层弹窗内循环，不逃逸到背景内容
export function trapFocus(container, e) {
  const items = Array.from(container.querySelectorAll(FOCUSABLE));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
let confirmResolve = null;
export function showConfirm(title, message, okText = '确定', danger = false) {
  return new Promise((res) => {
    confirmResolve = res;
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    const ok = $('#confirmOkBtn');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    openModal($('#confirmModal'));
  });
}
// 结算确认框 promise：返回是否确实结算了一个待决的确认框
export function settleConfirm(value) {
  const r = confirmResolve;
  confirmResolve = null;
  if (r) {
    r(value);
    return true;
  }
  return false;
}
export function setBtnLoading(btn, loading, text) {
  if (!btn) return;
  if (loading) {
    btn.dataset.old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = text || '处理中...';
  } else {
    btn.disabled = false;
    if (btn.dataset.old) btn.innerHTML = btn.dataset.old;
  }
}
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'success');
      return;
    }
    throw 0;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板', 'success');
    } catch (err) {
      toast('复制失败，请手动复制', 'error');
    }
    ta.remove();
  }
}
