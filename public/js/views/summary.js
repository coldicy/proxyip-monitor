// summary.js — 顶部统计卡片、进度条与 GitHub 同步状态
import { DATA, els } from "../store.js";
import { fmtTime } from "../utils/format.js";

export function ghModeText(gh){if(gh.auto&&gh.uploadIntervalMin>0)return '自动+定时同步';if(gh.auto)return '自动同步';if(gh.uploadIntervalMin>0)return '定时同步';return '手动同步';}

export function renderSummary(){const st=DATA.state;if(!st)return;const s=st.summary||{total:0,online:0,quality:0,offline:0};
els.statTotal.textContent=s.total??0;els.statOnline.textContent=s.online??0;els.statQuality.textContent=s.quality??0;els.statOffline.textContent=s.offline??0;
const p=st.progress||{tested:0,total:0};const pct=p.total?Math.round(p.tested/p.total*100):0;
els.progressBar.style.width=st.checking?pct+"%":"100%";
els.progressText.textContent=st.checking?`正在检测 ${p.tested}/${p.total} (${pct}%)`:(st.lastCycle?`上次检测完成于 ${fmtTime(st.lastCycle)}`:"尚未开始检测");
const gh=st.github||{};
if(gh.configured){els.statGithub.textContent=ghModeText(gh);const parts=[];if(gh.lastUpload)parts.push("上次上传 "+fmtTime(gh.lastUpload));if(gh.uploadIntervalMin>0)parts.push(`定时 ${gh.uploadIntervalMin} 分钟`);if(gh.lastError)parts.push("存在上传错误，请查看日志");els.statGithubSub.textContent=parts.join(" · ")||"已配置";els.statGithubSub.className=gh.lastError?"sub bad":"sub";}
else{els.statGithub.textContent="未配置";els.statGithubSub.textContent="可在设置中配置 GitHub";els.statGithubSub.className="sub";}
els.footerVersion.textContent=`版本 ${st.version||"-"} · 间隔 ${st.intervalSec||"-"}s`;
els.btnAbort.disabled=!st.checking;els.btnCheck.disabled=!!st.checking;}
