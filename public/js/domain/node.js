// node.js — 节点领域逻辑：状态判定、质量分级与单行格式化（依赖 store 的 DATA.config 与 format）
import { DATA } from "../store.js";
import { fmtTime, fmtDuration, escapeHtml } from "../utils/format.js";
export function qualityWindow(){return DATA.state?.config?.qualityWindow||10;}
export function speedMin(){return DATA.state?.config?.speedMinMBps||0;}
export function speedOf(item){return (item.speed&&item.speed.ok&&item.speed.mbps!=null)?item.speed.mbps:null;}
export function effectiveMeta(item){const latest=item.latest||{};const recent=item.recent||[];const pick=f=>{if(latest[f])return{v:latest[f],hist:false};for(let i=recent.length-1;i>=0;i--){const p=recent[i];if(p&&p[f])return{v:p[f],hist:true};}return{v:null,hist:false};};return{loc:pick("loc"),colo:pick("colo"),exitIp:pick("exitIp")};}
export function latencyClass(v){if(v==null||!isFinite(v))return "";const l=DATA.state?.config?.maxTotalMs||0;if(l>0)return v<=l?"good":"warn";return "good";}
export function rateClass(v,th){if(v==null||!isFinite(v))return "";const t=Number(th)||0;if(t<=0)return "good";if(v>=t)return "good";if(v>=t*0.8)return "warn";return "bad";}
// 状态语义: quality=优质; qual=达标(在线且最近一次总延迟≤上限, 未设上限时在线即达标); unqual=未达标(在线但超上限); offline=离线
export function statusOf(item){const q=item.quality||{};const latest=item.latest||{};if(q.quality)return "quality";if(latest.ok){const l=DATA.state?.config?.maxTotalMs||0;if(l<=0)return "qual";if(latest.total!=null&&latest.total<=l)return "qual";return "unqual";}return "offline";}
export function failReasonFor(p){if(p&&p.failReason)return p.failReason;if(p&&p.off)return "官方探针成功，但自定义源站探针未全部通过";return "官方探针未通过（连接失败 / 超时 / 非CF内容）";}
export function srcLabelOf(item){const k=item.srcKind||"pure";const n=item.srcName||"";if(k==="pure")return "纯IP";if(k==="dom")return "域名"+(n?"/"+n:"");if(k==="url")return "列表"+(n?"/"+n:"");return k+(n?"/"+n:"");}
export function formatItemLine(item){const q=item.quality||{};const latest=item.latest||{};const m=effectiveMeta(item);const region=m.loc.v||m.colo.v||"Unknown";const dc=m.colo.v||"Unknown";
const ms=(qv,lv)=>{if(qv!=null&&isFinite(qv))return `${Math.round(qv)}ms`;if(lv!=null&&isFinite(lv))return `${Math.round(lv)}ms`;return "?ms";};
const sp=speedOf(item);const spd=sp!=null?sp.toFixed(2)+"MB/s":"?MB/s";
return `${item.ip}:${item.port}#${region} | ${dc} | ${ms(q.avgTotal,latest.total)} | ${ms(q.avgTcp,latest.avgTcp)} | ${ms(q.avgTls,latest.avgTls)} | ${ms(q.avgHttp,latest.avgHttp)} | ${spd}`;}
