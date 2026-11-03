// filters.js — 筛选选项渲染、筛选 + 排序求值与选中态统计
import { DATA, FILTERS, SORT, SELECTED, currentFiltered, els } from "../store.js";
import { $ } from "../utils/dom.js";
import { effectiveMeta, statusOf, speedOf } from "../domain/node.js";
import { escapeHtml, flagEmoji, parseRatioInput, cmpOp } from "../utils/format.js";

export function getFiltered(){if(!DATA.state||!Array.isArray(DATA.state.items))return [];let arr=DATA.state.items.slice();const f=FILTERS;
if(f.search){const s=f.search.toLowerCase();arr=arr.filter(i=>{const m=effectiveMeta(i);return [i.id,i.ip,i.srcName,m.loc.v,m.colo.v,m.exitIp.v].filter(Boolean).some(v=>String(v).toLowerCase().includes(s));});}
if(f.kind!=="all")arr=arr.filter(i=>i.ipKind===f.kind);
if(f.status!=="all"){if(f.status==="online")arr=arr.filter(i=>i.latest&&i.latest.ok);else arr=arr.filter(i=>statusOf(i)===f.status);}
if(f.onlyQuality)arr=arr.filter(i=>i.quality?.quality);
// 数值筛选: 运算符可选(≤/≥/</>//=), 输入框留空=不启用
const ml=parseFloat(f.maxLatency);if(isFinite(ml))arr=arr.filter(i=>i.quality?.avgTotal!=null&&cmpOp(f.latOp,i.quality.avgTotal,ml));
const ms=parseFloat(f.minSpeed);if(isFinite(ms))arr=arr.filter(i=>{const s=speedOf(i);return s!=null&&cmpOp(f.speedOp,s,ms);});
const mq=parseRatioInput(f.minQual);if(mq!=null)arr=arr.filter(i=>cmpOp(f.qualOp,(i.quality?.qualRate??0),mq));
const msc=parseRatioInput(f.minSuccess);if(msc!=null)arr=arr.filter(i=>cmpOp(f.successOp,(i.quality?.rate??0),msc));
// 新增: 连续在线时长筛选(单位小时; 离线节点按 0 计)
const mh=parseFloat(f.minOnline);if(isFinite(mh))arr=arr.filter(i=>{const hrs=i.onlineSince?(Date.now()-i.onlineSince)/3600000:0;return cmpOp(f.onlineOp,hrs,mh);});
if(f.colo)arr=arr.filter(i=>effectiveMeta(i).colo.v===f.colo);
if(f.loc)arr=arr.filter(i=>effectiveMeta(i).loc.v===f.loc);
// 排序: ov=连续在线小时数(离线0), 降序时离线节点排最后; 同值按总延迟升序
const tv=i=>i.quality?.avgTotal??Infinity,sv=i=>i.quality?.rate??-1,qv=i=>i.quality?.qualRate??-1,pv=i=>speedOf(i)??-1,ov=i=>i.onlineSince?(Date.now()-i.onlineSince)/3600000:0;
if(SORT==="total_asc")arr.sort((a,b)=>tv(a)-tv(b)||sv(b)-sv(a));
else if(SORT==="success_desc")arr.sort((a,b)=>sv(b)-sv(a)||tv(a)-tv(b));
else if(SORT==="qual_desc")arr.sort((a,b)=>qv(b)-qv(a)||tv(a)-tv(b));
else if(SORT==="speed_desc")arr.sort((a,b)=>pv(b)-pv(a)||tv(a)-tv(b));
else if(SORT==="online_desc")arr.sort((a,b)=>ov(b)-ov(a)||tv(a)-tv(b));
return arr;}

export function updateSelectedCount(){els.selCount.textContent=SELECTED.size;els.btnDeleteSelected.disabled=SELECTED.size===0;}
export function updateSelectAll(){const vis=currentFiltered.filter(i=>SELECTED.has(i.id)).length;els.selectAll.checked=currentFiltered.length>0&&vis===currentFiltered.length;els.selectAll.indeterminate=vis>0&&vis<currentFiltered.length;}
export function setSelectOptions(sel,values,allLabel,labelFn){const cur=sel.value;const opts=[`<option value="">${allLabel}</option>`];values.forEach(v=>{const l=labelFn?labelFn(v):v;opts.push(`<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`);});sel.innerHTML=opts.join("");if(values.includes(cur))sel.value=cur;else sel.value="";}
export function renderFilterOptions(){if(!DATA.state||!Array.isArray(DATA.state.items))return;
const colos=[...new Set(DATA.state.items.map(i=>effectiveMeta(i).colo.v).filter(Boolean))].sort();
const locs=[...new Set(DATA.state.items.map(i=>effectiveMeta(i).loc.v).filter(Boolean))].sort();
setSelectOptions($("#coloFilter"),colos,"数据中心: 全部");
setSelectOptions($("#locFilter"),locs,"地区: 全部",v=>`${flagEmoji(v)} ${v}`);
if(!colos.includes($("#coloFilter").value)){$("#coloFilter").value="";FILTERS.colo="";}
if(!locs.includes($("#locFilter").value)){$("#locFilter").value="";FILTERS.loc="";}}
