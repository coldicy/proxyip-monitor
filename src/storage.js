// 所有本地文件读写（原子落盘）（源 server.js:163、221-238、261-269、340-348）
const fs = require('fs');
const path = require('path');
const { CONFIG, publicConfig } = require('./config');
const { state } = require('./state');
const { isDataDirty, clearDataDirty } = require('./changeBus');
const { migrateNodes } = require('./nodes/registry');
function ensureIpFile() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.ipFile), { recursive: true });
    let st = null;
    try {
      st = fs.statSync(CONFIG.ipFile);
    } catch (e) {}
    if (st && st.isDirectory()) {
      try {
        fs.rmdirSync(CONFIG.ipFile);
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (!fs.existsSync(CONFIG.ipFile)) {
      fs.writeFileSync(CONFIG.ipFile, '# 每行: 纯IP / 域名 / http(s)列表源\n');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function persistGraveyard() {
  try {
    fs.writeFileSync(CONFIG.graveyardFile, JSON.stringify({ list: state.graveyard.list, blocked: state.blocked }));
  } catch (e) {}
}
function loadGraveyard() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.graveyardFile, 'utf8'));
    if (Array.isArray(d)) {
      state.graveyard.list = d;
      state.blocked = {};
    } else {
      state.graveyard.list = d.list || [];
      state.blocked = d.blocked || {};
    }
  } catch (e) {
    state.graveyard.list = [];
    state.blocked = {};
  }
}
function capGraveyard() {
  if (state.graveyard.list.length > 1000) state.graveyard.list = state.graveyard.list.slice(-1000);
}
function saveData() {
  if (!isDataDirty()) return;
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    const tmp = CONFIG.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ history: state.history, nodes: state.nodes }));
    fs.renameSync(tmp, CONFIG.dataFile);
  } catch (e) {
  } finally {
    clearDataDirty();
  }
}
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
    if (d && d.history) state.history = d.history;
    if (d && d.nodes && Object.keys(d.nodes).length) {
      state.nodes = d.nodes;
    } else {
      state.nodes = migrateNodes(d && d.disc ? d.disc : {});
    }
  } catch (e) {
    state.nodes = migrateNodes({});
  }
  loadGraveyard();
}
function persistConfig() {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(CONFIG.configFile, JSON.stringify(publicConfig(), null, 2));
    return true;
  } catch (e) {
    return false;
  }
}
module.exports = {
  ensureIpFile,
  persistGraveyard,
  loadGraveyard,
  capGraveyard,
  saveData,
  loadData,
  persistConfig,
};
