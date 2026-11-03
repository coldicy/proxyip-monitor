// graveyard.js — 被移除（屏蔽）节点记录：渲染、拉取、解除屏蔽与选中态
import { api } from "../api.js";
import { $, showConfirm, toast } from "../utils/dom.js";
import { GRAVE_SELECTED } from "../store.js";
import { escapeHtml, fmtTime } from "../utils/format.js";

export function updateGraveSelectedCount(){
const countEl=$("#graveSelCount");
const btn=$("#btnUnblockSelected");
if(countEl)countEl.textContent=GRAVE_SELECTED.size;
if(btn)btn.disabled=GRAVE_SELECTED.size===0;
const selectAll=$("#graveSelectAll");
const totalVisible=document.querySelectorAll("#graveyardList .grave-check").length;
if(selectAll){
selectAll.checked=totalVisible>0&&GRAVE_SELECTED.size===totalVisible;
selectAll.indeterminate=GRAVE_SELECTED.size>0&&GRAVE_SELECTED.size<totalVisible;
}
}

export function renderGraveyard(list){
const box=$("#graveyardList");
if(!list.length){box.innerHTML='<div class="muted">暂无被移除节点</div>';GRAVE_SELECTED.clear();updateGraveSelectedCount();return;}
box.innerHTML=list.slice().reverse().map(g=>{
const mode=g.mode==="auto"?"自动":"手动";
const checked=GRAVE_SELECTED.has(g.id)?'checked':'';
return `<div class="grave-item" data-grave-id="${escapeHtml(g.id)}">
<input type="checkbox" class="grave-check" data-id="${escapeHtml(g.id)}" ${checked} />
<div class="grave-content">
<b>${escapeHtml(g.id)}</b> · ${escapeHtml(mode)} · ${escapeHtml(g.reason||"-")}
<br />
移除: ${escapeHtml(fmtTime(g.removedAt))} · 最后在线: ${escapeHtml(fmtTime(g.lastOnlineAt))}
</div>
<button class="mini-btn" data-op="unblock" data-id="${escapeHtml(g.id)}">🔓 解除</button>
</div>`;
}).join("");
updateGraveSelectedCount();
}

export async function unblockGraveIds(ids){
if(!ids.length)return;
const ok=await showConfirm("解除屏蔽",`确定解除 ${ids.length} 个节点的屏蔽吗？解除后它们将重新加入监控。`,"解除",false);
if(!ok)return;
try{
const res=await api("/api/graveyard/unblock","POST",{ids});
toast(`已解除 ${res.count??ids.length} 个节点的屏蔽`,"success");
ids.forEach(id=>GRAVE_SELECTED.delete(id));
loadGraveyard();
}catch(e){toast("解除失败: "+e.message,"error");}
}

export async function loadGraveyard(){try{const d=await api("/api/graveyard");renderGraveyard(d.graveyard||[]);}catch(e){$("#graveyardList").innerHTML=`<div class="bad">加载失败: ${escapeHtml(e.message)}</div>`;}}
