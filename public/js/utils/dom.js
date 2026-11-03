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
export function openModal(el) {
  el.classList.add('show');
  document.body.classList.add('modal-open');
}
// 仅负责显隐；关闭相关的副作用（日志轮询、确认框兜底）由调用方在 events.js 统一处理
export function closeModal(el) {
  el.classList.remove('show');
  if (!document.querySelector('.modal.show')) document.body.classList.remove('modal-open');
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
