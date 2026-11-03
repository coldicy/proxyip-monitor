// main.js — 唯一入口：轮询调度 + renderAll 编排 + DOMContentLoaded 启动
import { DATA, SELECTED, setRefreshFn } from "./store.js";
import { toast } from "./utils/dom.js";
import { api } from "./api.js";
import { renderSummary } from "./views/summary.js";
import { renderFilterOptions } from "./views/filters.js";
import { renderTable } from "./views/table.js";
import { bindEvents } from "./events.js";

let pollTimer=null,stateErrorShown=false;
export function renderAll(){if(!DATA.state)return;const ids=new Set(DATA.state.items.map(i=>i.id));for(const id of [...SELECTED])if(!ids.has(id))SELECTED.delete(id);renderSummary();renderFilterOptions();renderTable();}
export function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(refreshState,DATA.state&&DATA.state.checking?2500:8000);}
export async function refreshState(){try{DATA.state=await api("/api/state");stateErrorShown=false;renderAll();}catch(e){if(!stateErrorShown){toast("状态加载失败: "+e.message,"error");stateErrorShown=true;}}finally{schedulePoll();}}
document.addEventListener("DOMContentLoaded",()=>{setRefreshFn(refreshState);bindEvents();refreshState();});
