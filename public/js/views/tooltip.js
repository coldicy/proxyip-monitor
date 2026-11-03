// tooltip.js — 延迟柱悬浮详情（内容构建 + 定位 + 显隐）
import { DATA } from "../store.js";
import { $ } from "../utils/dom.js";
import { effectiveMeta, speedOf, failReasonFor, qualityWindow } from "../domain/node.js";
import { escapeHtml, fmtTime, flagEmoji } from "../utils/format.js";

export function buildTooltipHtml(p,item){const m=effectiveMeta(item);const status=p.ok?'<span class="good">成功</span>':'<span class="bad">失败</span>';
let html=`<h4>${flagEmoji(m.loc.v)} ${escapeHtml(item.ip)}:${item.port} · ${escapeHtml(fmtTime(p.t))}</h4><div class="grid"><span>状态</span><span>${status}</span>`;
if(p.total!=null)html+=`<span>总延迟</span><span>${Math.round(p.total)} ms</span>`;
if(p.avgTcp!=null)html+=`<span>平均TCP</span><span>${Math.round(p.avgTcp)} ms</span>`;
if(p.avgTls!=null)html+=`<span>平均TLS</span><span>${Math.round(p.avgTls)} ms</span>`;
if(p.avgHttp!=null)html+=`<span>平均HTTP</span><span>${Math.round(p.avgHttp)} ms</span>`;
const sp=speedOf(item);html+=`<span>下载速度</span><span>${sp!=null?sp.toFixed(2)+" MB/s":"-"}</span>`;
html+=`<span>地区</span><span>${escapeHtml(m.loc.v||"-")}</span><span>数据中心</span><span>${escapeHtml(m.colo.v||"-")}</span><span>出口IP</span><span>${escapeHtml(m.exitIp.v||"-")}</span></div>`;
if(!p.ok){const reason=failReasonFor(p);if(reason)html+=`<div class="probe-item" style="border-color:rgba(244,63,94,.35);">❌ 失败原因：${escapeHtml(reason)}</div>`;}
if(Array.isArray(p.probes)&&p.probes.length){html+=`<div style="margin-top:9px;color:var(--muted)">探针明细（总 / TCP / TLS / HTTP）</div>`;p.probes.forEach(pr=>{const name=pr.name==="official"?"官方探针":pr.name;const src=pr.src??((pr.total!=null&&pr.tcp!=null&&pr.tls!=null)?Math.max(0,pr.total-pr.tcp-pr.tls):null);html+=`<div class="probe-item"><b>${escapeHtml(name)}</b><br />总 ${pr.total??"-"} ms · TCP ${pr.tcp??"-"} ms · TLS ${pr.tls??"-"} ms · HTTP ${src??"-"} ms</div>`;});}
else if(p.off){html+=`<div class="probe-item"><b>官方探针</b><br />总 ${p.off.total??"-"} ms · TCP ${p.off.tcp??"-"} ms · TLS ${p.off.tls??"-"} ms · HTTP ${p.off.src??"-"} ms</div>`;}
return html;}

export function positionTooltip(e){const tip=$("#tooltip");const pad=14;let x=e.clientX+pad,y=e.clientY+pad;const r=tip.getBoundingClientRect();if(x+r.width>window.innerWidth-10)x=Math.max(10,window.innerWidth-r.width-10);if(y+r.height>window.innerHeight-10)y=Math.max(10,window.innerHeight-r.height-10);tip.style.left=x+"px";tip.style.top=y+"px";}
export function showTooltip(bar,e){const id=bar.dataset.id;const idx=parseInt(bar.dataset.idx,10);const item=DATA.state?.items?.find(x=>x.id===id);if(!item)return;const recent=(item.recent||[]).slice(-qualityWindow());const p=recent[idx];if(!p)return;const tip=$("#tooltip");tip.innerHTML=buildTooltipHtml(p,item);tip.classList.add("show");positionTooltip(e);}
export function hideTooltip(){$("#tooltip").classList.remove("show");}
