// 节点发现（源 server.js:361-398）
const fs = require('fs');
const dnsPromises = require('dns').promises;
const net = require('net');
const { CONFIG } = require('../config');
const { state } = require('../state');
const { markDirty } = require('../changeBus');
const { sourceKeyForLine, isUrl, parseLine, splitId } = require('../utils/text');
const { mapLimit, timeoutPromise, fetchList } = require('../utils/async');
const { refreshCfCidrs, classifyIp } = require('../domain/cidr');
// ==================== 发现(只增) ====================
async function discover() {
  await refreshCfCidrs(false);
  const now = Date.now();
  let lines = [];
  try {
    lines = fs.readFileSync(CONFIG.ipFile, 'utf8').split(/\r?\n/);
  } catch (e) {}
  const present = new Set();
  const domJobs = [],
    urlJobs = [];
  const adds = [];
  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const key = sourceKeyForLine(line);
    if (!key || present.has(key)) continue;
    present.add(key);
    if (key.startsWith('pure:')) {
      const id = key.slice(5);
      adds.push({ id, kind: 'pure', name: id });
    } else if (key.startsWith('dom:')) {
      const hp = key.slice(4);
      const li = hp.lastIndexOf(':');
      domJobs.push({ host: hp.slice(0, li), port: +hp.slice(li + 1), kind: 'dom', name: hp.slice(0, li) });
    } else {
      urlJobs.push({ url: key.slice(4), kind: 'url', name: key.slice(4) });
    }
  }
  await mapLimit(domJobs, 20, async (j) => {
    let ips = [];
    try {
      ips = await Promise.race([dnsPromises.resolve4(j.host), timeoutPromise(4000)]);
    } catch (e) {}
    (ips || [])
      .filter((ip) => net.isIPv4(ip))
      .forEach((ip) => adds.push({ id: ip + ':' + j.port, kind: j.kind, name: j.name }));
  });
  await mapLimit(urlJobs, 8, async (j) => {
    const content = await fetchList(j.url);
    for (const rl of content.split(/\r?\n/)) {
      const l = rl.split('#')[0].trim();
      if (!l || isUrl(l)) continue;
      const r = parseLine(l);
      if (!r || !net.isIPv4(r.host)) continue;
      adds.push({ id: r.host + ':' + r.port, kind: j.kind, name: j.name });
    }
  });
  let added = 0;
  for (const a of adds) {
    if (state.blocked[a.id]) continue;
    if (state.nodes[a.id]) continue;
    const [ip, port] = splitId(a.id);
    state.nodes[a.id] = {
      id: a.id,
      ip,
      port,
      firstSeen: now,
      firstSource: { kind: a.kind, name: a.name },
      kind: classifyIp(ip),
    };
    added++;
  }
  if (added) markDirty();
  return added;
}
module.exports = { discover };
