// actions.js — 由用户操作触发的写操作（删除 / 手动复测 / 复制）
import { api } from "./api.js";
import { showConfirm, toast, copyText } from "./utils/dom.js";
import { SELECTED, refresh } from "./store.js";
import { formatItemLine } from "./domain/node.js";

export function copyItems(items){if(!items.length){toast("没有可复制的节点","warn");return;}copyText(items.map(formatItemLine).join("\n"));}
export async function removeIds(ids){if(!ids.length)return;const ok=await showConfirm("删除节点",`确定删除 ${ids.length} 个节点吗？删除后会进入屏蔽记录。`,"删除",true);if(!ok)return;try{const res=await api("/api/remove","POST",{ids});toast(`已删除 ${res.count??ids.length} 个节点`,"success");SELECTED.clear();await refresh();}catch(e){toast("删除失败: "+e.message,"error");}}
export async function runSpeedTest(id){toast("开始测速（手动复测）...","info");try{const res=await api("/api/speedtest","POST",{ids:[id]});const r=(res.results||[])[0];if(r&&r.ok)toast(`测速完成: ${r.mbps} MB/s`,"success");else toast("测速失败: "+((r&&r.failReason)||"未知原因"),"warn");refresh();}catch(e){toast("测速失败: "+e.message,"error");}}
