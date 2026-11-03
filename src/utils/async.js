// 并发与超时原语（源 server.js:270-281）
const { runCurl } = require('./curl');
async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      res[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return res;
}
function timeoutPromise(ms) {
  return new Promise((_, rj) => setTimeout(() => rj(new Error('t')), ms));
}
async function fetchList(url) {
  const safe = url.replace(/'/g, "'\\''");
  const out = await runCurl(`curl -4 -k -s --noproxy '*' --compressed -m 20 '${safe}'`, 25000);
  if (out && out.trim()) {
    if (out.length > 2 * 1024 * 1024) return out.slice(0, 2 * 1024 * 1024);
    return out;
  }
  return '';
}
module.exports = { mapLimit, timeoutPromise, fetchList };
