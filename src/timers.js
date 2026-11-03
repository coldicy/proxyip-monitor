// 周期检测与定时上传定时器（源 server.js:51、164-174）
const { CONFIG } = require('./config');
const { state, invalidateStateCache } = require('./state');
const { runCycle } = require('./pipeline/cycle');
const { uploadGithub } = require('./sync/github');
const { log } = require('./logger');
let cycleTimer = null,
  githubTimer = null;
function restartTimer() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(() => {
    runCycle().catch((e) => log('⚠️ 周期检测异常: ' + e.message));
  }, CONFIG.intervalSec * 1000);
}
function restartGithubTimer() {
  if (githubTimer) clearInterval(githubTimer);
  const mins = CONFIG.github.uploadIntervalMin;
  if (mins > 0 && CONFIG.github.token && CONFIG.github.repo) {
    githubTimer = setInterval(
      () => {
        log('⏰ 定时触发 GitHub 上传');
        uploadGithub().catch((e) => {
          state.github.lastError = e.message;
          invalidateStateCache();
          log('⚠️ 定时上传失败: ' + e.message);
        });
      },
      mins * 60 * 1000,
    );
  }
}
module.exports = { restartTimer, restartGithubTimer };
