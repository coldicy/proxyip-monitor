// logs.js — 运行日志弹窗（拉取 + 渲染 + 打开时的 3s 轮询）
import { api } from "../api.js";
import { $, openModal } from "../utils/dom.js";
import { escapeHtml, fmtTime } from "../utils/format.js";
let logsTimer=null;
export function renderLogs(logs){const box=$("#logsBox");if(!logs.length){box.innerHTML='<div class="muted">暂无日志</div>';return;}box.innerHTML=logs.slice().reverse().map(l=>`<div class="log-line"><span class="log-time">${escapeHtml(fmtTime(l.t))}</span><span>${escapeHtml(l.m)}</span></div>`).join("");}
export async function loadLogs(){try{const d=await api("/api/logs");renderLogs(d.logs||[]);}catch(e){$("#logsBox").innerHTML=`<div class="bad">日志加载失败: ${escapeHtml(e.message)}</div>`;}}
export function openLogs(){openModal($("#logsModal"));loadLogs();clearInterval(logsTimer);logsTimer=setInterval(loadLogs,3000);}
export function stopLogs(){clearInterval(logsTimer);logsTimer=null;}
