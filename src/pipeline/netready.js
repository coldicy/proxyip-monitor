// 启动网络就绪检查（源 server.js:282-296）
const { CONFIG } = require('../config');
const { splitProbe } = require('../utils/text');
const { runCurl } = require('../utils/curl');
const { log } = require('../logger');
// ==================== 启动网络就绪检查（新增） ====================
// 直连官方探针 URL（不经被测IP），拿到任意 HTTP 响应即认为出站网络就绪。
// 防止 Docker 更新/重启后网络未就绪时，第一轮检测写入整轮失败样本。
async function waitNetworkReady(maxMs, stepMs) {
  maxMs = maxMs || 45000;
  stepMs = stepMs || 5000;
  const probe = splitProbe(CONFIG.probeUrl);
  const started = Date.now();
  let tried = 0;
  while (Date.now() - started < maxMs) {
    tried++;
    const out = await runCurl(
      `curl -4 -k -s --noproxy '*' -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 6 'https://${probe.host}${probe.path}'`,
      8000,
    );
    if (out && String(out).trim() !== '000') {
      if (tried > 1) log('🌐 网络已就绪（第 ' + tried + ' 次尝试）');
      return true;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
module.exports = { waitNetworkReady };
