"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataService = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class DataService {
    db;
    dataDir;
    historyFile;
    graveyardFile;
    logger;
    constructor(dataDir, logger) {
        this.dataDir = dataDir;
        this.historyFile = path.join(dataDir, 'history.json');
        this.graveyardFile = path.join(dataDir, 'graveyard.json');
        this.logger = logger;
        // Ensure data directory exists
        fs.mkdirSync(dataDir, { recursive: true });
        // Initialize SQLite database for persistent storage
        const dbPath = path.join(dataDir, 'proxy.db');
        this.db = new better_sqlite3_1.default(dbPath);
        this.initDatabase();
    }
    initDatabase() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        firstSeen INTEGER,
        lastOnlineAt INTEGER,
        kind TEXT,
        srcKind TEXT,
        srcName TEXT
      );
      
      CREATE TABLE IF NOT EXISTS speed_results (
        node_id TEXT PRIMARY KEY,
        t INTEGER,
        ok INTEGER,
        mbps REAL,
        size INTEGER,
        failReason TEXT,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_nodes_ip ON nodes(ip);
      CREATE INDEX IF NOT EXISTS idx_nodes_lastOnline ON nodes(lastOnlineAt);
    `);
    }
    loadHistory() {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
                return data.history || {};
            }
        }
        catch (error) {
            this.logger.error(`Failed to load history: ${error.message}`);
        }
        return {};
    }
    loadGraveyard() {
        try {
            if (fs.existsSync(this.graveyardFile)) {
                const data = JSON.parse(fs.readFileSync(this.graveyardFile, 'utf8'));
                if (Array.isArray(data)) {
                    return { list: data, blocked: {} };
                }
                return { list: data.list || [], blocked: data.blocked || {} };
            }
        }
        catch (error) {
            this.logger.error(`Failed to load graveyard: ${error.message}`);
        }
        return { list: [], blocked: {} };
    }
    saveHistory(history) {
        try {
            const tmpFile = this.historyFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify({ history }));
            fs.renameSync(tmpFile, this.historyFile);
        }
        catch (error) {
            this.logger.error(`Failed to save history: ${error.message}`);
        }
    }
    saveGraveyard(list, blocked) {
        try {
            fs.writeFileSync(this.graveyardFile, JSON.stringify({ list, blocked }));
        }
        catch (error) {
            this.logger.error(`Failed to save graveyard: ${error.message}`);
        }
    }
    saveNode(node) {
        try {
            const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (id, ip, port, firstSeen, lastOnlineAt, kind, srcKind, srcName)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
            stmt.run(node.id, node.ip, node.port, node.firstSeen, node.lastOnlineAt || null, node.kind || 'unknown', node.firstSource.kind, node.firstSource.name);
        }
        catch (error) {
            this.logger.error(`Failed to save node: ${error.message}`);
        }
    }
    saveSpeedResult(nodeId, speed) {
        try {
            const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO speed_results (node_id, t, ok, mbps, size, failReason)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
            stmt.run(nodeId, speed.t, speed.ok ? 1 : 0, speed.mbps, speed.size, speed.failReason);
        }
        catch (error) {
            this.logger.error(`Failed to save speed result: ${error.message}`);
        }
    }
    getSpeedResults() {
        try {
            const rows = this.db.prepare('SELECT * FROM speed_results').all();
            const result = {};
            for (const row of rows) {
                result[row.node_id] = {
                    t: row.t,
                    ok: row.ok === 1,
                    mbps: row.mbps,
                    size: row.size,
                    failReason: row.failReason
                };
            }
            return result;
        }
        catch (error) {
            this.logger.error(`Failed to get speed results: ${error.message}`);
            return {};
        }
    }
    deleteNode(nodeId) {
        try {
            const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
            stmt.run(nodeId);
            const speedStmt = this.db.prepare('DELETE FROM speed_results WHERE node_id = ?');
            speedStmt.run(nodeId);
        }
        catch (error) {
            this.logger.error(`Failed to delete node: ${error.message}`);
        }
    }
    close() {
        this.db.close();
    }
}
exports.DataService = DataService;
//# sourceMappingURL=data.service.js.map