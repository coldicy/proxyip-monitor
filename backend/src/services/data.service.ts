import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { ProxyNode, HistoryEntry, GraveyardEntry, SpeedResult } from '../types';
import { Logger } from '../utils/logger';

export class DataService {
  private db: Database.Database;
  private dataDir: string;
  private historyFile: string;
  private graveyardFile: string;
  private logger: Logger;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.historyFile = path.join(dataDir, 'history.json');
    this.graveyardFile = path.join(dataDir, 'graveyard.json');
    this.logger = logger;

    // Ensure data directory exists
    fs.mkdirSync(dataDir, { recursive: true });
    
    // Initialize SQLite database for persistent storage
    const dbPath = path.join(dataDir, 'proxy.db');
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase(): void {
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

  loadHistory(): Record<string, HistoryEntry[]> {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        return data.history || {};
      }
    } catch (error) {
      this.logger.error(`Failed to load history: ${(error as Error).message}`);
    }
    return {};
  }

  loadGraveyard(): { list: GraveyardEntry[]; blocked: Record<string, number> } {
    try {
      if (fs.existsSync(this.graveyardFile)) {
        const data = JSON.parse(fs.readFileSync(this.graveyardFile, 'utf8'));
        if (Array.isArray(data)) {
          return { list: data, blocked: {} };
        }
        return { list: data.list || [], blocked: data.blocked || {} };
      }
    } catch (error) {
      this.logger.error(`Failed to load graveyard: ${(error as Error).message}`);
    }
    return { list: [], blocked: {} };
  }

  saveHistory(history: Record<string, HistoryEntry[]>): void {
    try {
      const tmpFile = this.historyFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify({ history }));
      fs.renameSync(tmpFile, this.historyFile);
    } catch (error) {
      this.logger.error(`Failed to save history: ${(error as Error).message}`);
    }
  }

  saveGraveyard(list: GraveyardEntry[], blocked: Record<string, number>): void {
    try {
      fs.writeFileSync(this.graveyardFile, JSON.stringify({ list, blocked }));
    } catch (error) {
      this.logger.error(`Failed to save graveyard: ${(error as Error).message}`);
    }
  }

  saveNode(node: ProxyNode): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (id, ip, port, firstSeen, lastOnlineAt, kind, srcKind, srcName)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        node.id,
        node.ip,
        node.port,
        node.firstSeen,
        node.lastOnlineAt || null,
        node.kind || 'unknown',
        node.firstSource.kind,
        node.firstSource.name
      );
    } catch (error) {
      this.logger.error(`Failed to save node: ${(error as Error).message}`);
    }
  }

  saveSpeedResult(nodeId: string, speed: SpeedResult): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO speed_results (node_id, t, ok, mbps, size, failReason)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        nodeId,
        speed.t,
        speed.ok ? 1 : 0,
        speed.mbps,
        speed.size,
        speed.failReason
      );
    } catch (error) {
      this.logger.error(`Failed to save speed result: ${(error as Error).message}`);
    }
  }

  getSpeedResults(): Record<string, SpeedResult> {
    try {
      const rows = this.db.prepare('SELECT * FROM speed_results').all() as any[];
      const result: Record<string, SpeedResult> = {};
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
    } catch (error) {
      this.logger.error(`Failed to get speed results: ${(error as Error).message}`);
      return {};
    }
  }

  deleteNode(nodeId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
      stmt.run(nodeId);
      const speedStmt = this.db.prepare('DELETE FROM speed_results WHERE node_id = ?');
      speedStmt.run(nodeId);
    } catch (error) {
      this.logger.error(`Failed to delete node: ${(error as Error).message}`);
    }
  }

  close(): void {
    this.db.close();
  }
}
