// 日志环形缓冲（源 server.js:79）
const { state } = require('./state');
function log(m) { state.logs.push({ t: Date.now(), m: String(m) }); if (state.logs.length > 400) state.logs = state.logs.slice(-400); }
module.exports = { log };
