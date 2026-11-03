// settings.js — 设置弹窗：配置回填 / 采集、自定义探针行与打开时的批量加载
import { api } from "../api.js";
import { $, $$, openModal, toast } from "../utils/dom.js";
import { escapeHtml } from "../utils/format.js";
import { renderGraveyard } from "./graveyard.js";

export function renderProbes(probes){const w=$("#customProbesWrap");w.innerHTML="";if(!probes.length){w.innerHTML='<div class="muted">未配置自定义探针（仅使用官方探针）</div>';return;}probes.forEach(p=>addProbeRow(p.url||"",p.expect||"200"));}
export function addProbeRow(url="",expect="200"){const w=$("#customProbesWrap");const mu=w.querySelector(".muted");if(mu)mu.remove();const d=document.createElement("div");d.className="probe-row";d.innerHTML=`<input class="input probe-url" placeholder="https://your-origin.example.com/health" value="${escapeHtml(url)}" /><input class="input probe-expect" placeholder="200" value="${escapeHtml(expect)}" /><button class="mini-btn probe-remove" title="删除">✕</button>`;w.appendChild(d);}

export function fillSettings(cfg){$("#cfg_intervalSec").value=cfg.intervalSec??60;$("#cfg_timeoutSec").value=cfg.timeoutSec??5;$("#cfg_concurrency").value=cfg.concurrency??50;$("#cfg_maxTotalMs").value=cfg.maxTotalMs??0;$("#cfg_probeUrl").value=cfg.probeUrl||"";$("#cfg_autoCleanDays").value=cfg.autoCleanDays??7;$("#cfg_qualityWindow").value=Math.min(50,Math.max(1,Math.round(Number(cfg.qualityWindow)||10)));$("#cfg_successThreshold").value=cfg.successThreshold??1;$("#cfg_qualThreshold").value=cfg.qualThreshold??1;$("#cfg_minOnlineHours").value=cfg.minOnlineHours??0;
$("#cfg_speedEnabled").checked=cfg.speedEnabled!==false;$("#cfg_speedMinMBps").value=cfg.speedMinMBps??0;$("#cfg_speedConcurrency").value=cfg.speedConcurrency??1;$("#cfg_speedPerCycle").value=cfg.speedPerCycle??20;$("#cfg_speedTimeoutSec").value=cfg.speedTimeoutSec??10;$("#cfg_speedUrl").value=cfg.speedUrl||"";
const gh=cfg.github||{};
$("#cfg_github_token").value="";
$("#cfg_github_token").placeholder=gh.tokenSet?`${gh.tokenMasked||"****"}（留空=保持不变）`:"ghp_...";
$("#cfg_github_repo").value=gh.repo||"";$("#cfg_github_path").value=gh.path||"proxyip";$("#cfg_github_branch").value=gh.branch||"main";$("#cfg_github_uploadIntervalMin").value=gh.uploadIntervalMin??0;$("#cfg_github_auto").checked=!!gh.auto;renderProbes(cfg.customProbes||[]);}

export function collectSettings(){const probes=$$("#customProbesWrap .probe-row").map(r=>({url:r.querySelector(".probe-url")?.value.trim()||"",expect:r.querySelector(".probe-expect")?.value.trim()||"200"})).filter(p=>p.url);
return{intervalSec:$("#cfg_intervalSec").value,timeoutSec:$("#cfg_timeoutSec").value,concurrency:$("#cfg_concurrency").value,autoCleanDays:$("#cfg_autoCleanDays").value,maxTotalMs:$("#cfg_maxTotalMs").value,probeUrl:$("#cfg_probeUrl").value.trim(),qualityWindow:Math.min(50,Math.max(1,Math.round(Number($("#cfg_qualityWindow").value)||10))),successThreshold:$("#cfg_successThreshold").value,qualThreshold:$("#cfg_qualThreshold").value,minOnlineHours:$("#cfg_minOnlineHours").value,
speedEnabled:$("#cfg_speedEnabled").checked,speedMinMBps:$("#cfg_speedMinMBps").value,speedConcurrency:$("#cfg_speedConcurrency").value,speedPerCycle:$("#cfg_speedPerCycle").value,speedTimeoutSec:$("#cfg_speedTimeoutSec").value,speedUrl:$("#cfg_speedUrl").value.trim(),
github:{token:$("#cfg_github_token").value.trim(),repo:$("#cfg_github_repo").value.trim(),path:$("#cfg_github_path").value.trim(),branch:$("#cfg_github_branch").value.trim(),auto:$("#cfg_github_auto").checked,uploadIntervalMin:$("#cfg_github_uploadIntervalMin").value},customProbes:probes};}

export async function loadSettings(){try{const [cfg,ip,gy]=await Promise.all([api("/api/config"),api("/api/ipfile"),api("/api/graveyard")]);fillSettings(cfg);$("#ipContent").value=ip.content||"";renderGraveyard(gy.graveyard||[]);}catch(e){toast("设置加载失败: "+e.message,"error");}}
export function openSettings(){openModal($("#settingsModal"));loadSettings();}
