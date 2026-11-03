// manual.js — 使用手册弹窗：按需拉取 public/manual.html 并缓存渲染
import { api } from '../api.js';
import { $, openModal } from '../utils/dom.js';
import { escapeHtml } from '../utils/format.js';
let loaded = false,
  failed = false;
// 尊重系统「减少动态效果」偏好：开启时用瞬时定位代替平滑滚动
function scrollBehavior() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
function bindNav(root) {
  root.querySelectorAll('.manual-nav a').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const t = document.querySelector(a.getAttribute('href'));
      if (t) t.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }),
  );
}
async function load(box) {
  try {
    const html = await api('manual.html');
    box.innerHTML = html;
    loaded = true;
    bindNav(box);
  } catch (e) {
    failed = true;
    box.innerHTML = `<div class="bad">手册加载失败: ${escapeHtml(e.message)}</div>`;
  }
}
export function openManual() {
  const box = $('#manualContent');
  if (!loaded && !failed) {
    box.innerHTML = '<div class="muted">正在加载手册...</div>';
    load(box);
  }
  openModal($('#manualModal'));
}
