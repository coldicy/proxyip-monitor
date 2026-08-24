import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { ProxyNode, HistoryEntry, GraveyardEntry, SpeedResult, MonitorState, Progress, AppConfig, ProbeResult } from '../types';
import { DataService } from './data.service';
import { ProbeService } from './probe.service';
import { Logger } from '../utils/logger';
import { AppConfig as ConfigClass, DEFAULT_CONFIG } from '../config';
import { runCurlWithCode, parseCurlJson } from '../utils/helpers';

const HISTORY_MAX_ENTRIES = 50;
const GRAVEYARD_BLOCK_EXPIRE_MS = 24 * 3600 * 1000;
const CYCLE_CLEANUP_MINUTES = 60;

export class MonitorService extends EventEmitter {
  private config: ConfigClass;
  private dataService: DataService;
  private probeService: ProbeService;
  private logger: Logger;
  
  private state: MonitorState;
  private timer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;
  private cycleRunning = false;
  private lastCleanup = 0;

  constructor() {
    super();
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.config = new ConfigClass(dataDir);
    this.logger = new Logger({} as any); // Temporary logger
    this.dataService = new DataService(dataDir, this.logger);
    this.probeService = new ProbeService(this.config);
    
    // Initialize state
    const history = this.dataService.loadHistory();
    const graveyard = this.dataService.loadGraveyard();
    const speedResults = this.dataService.getSpeedResults();
    
    this.state = {
      nodes: {},
      history,
      blocked: graveyard.blocked || {},
      graveyard: { list: graveyard.list || [] },
      cfCidrs: [],
      cfCidrsAt: 0,
      checking: false,
      lastCycle: null,
      progress: { tested: 0, total: 0 },
      logs: [],
      github: { lastUpload: null, lastError: null },
      speed: speedResults
    };
    
    // Update logger with actual state reference
    (this.logger as any).state = this.state;
  }

  async initializeAndStart(): Promise<void> {
    this.logger.log('正在加载配置...');
    await this.config.load();
    
    this.logger.log('正在发现节点...');
    await this.discoverNodes();
    
    this.startTimer();
    this.logger.log(`监控服务已启动，间隔 ${this.config.intervalSec} 秒`);
  }

  private startTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      if (!this.cycleRunning) {
        this.runCycle().catch(e => {
          this.logger.error(`周期检测异常：${e.message}`);
        });
      }
    }, this.config.intervalSec * 1000);
  }

  async runCycle(): Promise<void> {
    if (this.cycleRunning) {
      return;
    }
    
    this.cycleRunning = true;
    this.state.checking = true;
    this.state.progress = { tested: 0, total: Object.keys(this.state.nodes).length };
    this.logger.log(`开始新的检测周期，共 ${this.state.progress.total} 个节点`);

    try {
      // Load Cloudflare CIDRs if needed
      if (Date.now() - this.state.cfCidrsAt > 6 * 3600 * 1000) {
        await this.loadCloudflareCidrs();
      }

      const nodeEntries = Object.entries(this.state.nodes);
      const batchSize = Math.max(1, Math.floor(this.config.concurrency));
      
      for (let i = 0; i < nodeEntries.length; i += batchSize) {
        if (this.abortController?.signal.aborted) {
          this.logger.log('检测已被用户中断');
          break;
        }

        const batch = nodeEntries.slice(i, i + batchSize);
        const promises = batch.map(async ([id, node]) => {
          try {
            await this.checkNode(node);
            this.state.progress.tested++;
          } catch (error) {
            this.logger.error(`节点 ${id} 检测失败：${(error as Error).message}`);
            this.state.progress.tested++;
          }
        });

        await Promise.allSettled(promises);
      }

      // Cleanup if needed
      if (Date.now() - this.lastCleanup > CYCLE_CLEANUP_MINUTES * 60 * 1000) {
        this.cleanupOldData();
        this.lastCleanup = Date.now();
      }

      // Upload to GitHub if configured
      if (this.config.githubToken && this.config.githubRepo) {
        await this.uploadToGithub().catch(e => {
          this.logger.error(`自动上传失败：${e.message}`);
        });
      }

      this.state.lastCycle = Date.now();
      this.logger.log(`检测周期完成，在线节点：${Object.keys(this.state.history).length}`);
    } catch (error) {
      this.logger.error(`检测周期异常：${(error as Error).message}`);
    } finally {
      this.state.checking = false;
      this.cycleRunning = false;
      this.saveState();
    }
  }

  private async checkNode(node: ProxyNode): Promise<void> {
    const nodeId = node.id;
    const now = Date.now();
    
    // Check if node is blocked
    if (this.state.blocked[nodeId] && this.state.blocked[nodeId] > now) {
      return;
    }

    // Probe latency
    const probeResult = await this.probeService.probeLatency(node);
    
    if (!probeResult.ok) {
      // Node is offline
      delete this.state.nodes[nodeId];
      this.addToGraveyard(node, probeResult.failReason || '未知原因');
      this.dataService.deleteNode(nodeId);
      return;
    }

    // Node is online
    node.lastOnlineAt = now;
    this.state.nodes[nodeId] = node;
    this.dataService.saveNode(node);

    // Update history
    if (!this.state.history[nodeId]) {
      this.state.history[nodeId] = [];
    }
    const historyEntry: HistoryEntry = {
      t: now,
      off: probeResult.off!,
      colo: probeResult.colo || undefined,
      loc: probeResult.loc || undefined,
      exitIp: probeResult.exitIp || undefined
    };
    
    this.state.history[nodeId].push(historyEntry);
    if (this.state.history[nodeId].length > HISTORY_MAX_ENTRIES) {
      this.state.history[nodeId] = this.state.history[nodeId].slice(-HISTORY_MAX_ENTRIES);
    }

    // Custom probes
    if (this.config.customProbes.length > 0) {
      const customResults = await this.probeService.probeCustomProbes(node);
      historyEntry.cus = customResults;
    }

    // Speed test if needed
    if (this.probeService.needSpeedTest(this.state.speed[nodeId])) {
      const speedResult = await this.probeService.probeSpeed(node);
      this.state.speed[nodeId] = speedResult;
      this.dataService.saveSpeedResult(nodeId, speedResult);
      historyEntry.speed = speedResult.mbps || undefined;
    }

    this.emit('nodeChecked', { nodeId, result: probeResult });
  }

  private async loadCloudflareCidrs(): Promise<void> {
    try {
      const response = await fetch('https://www.cloudflare.com/ips-v4');
      if (response.ok) {
        const text = await response.text();
        this.state.cfCidrs = text.trim().split('\n').filter(line => line.trim());
        this.state.cfCidrsAt = Date.now();
        this.logger.log(`已加载 ${this.state.cfCidrs.length} 个 Cloudflare CIDR`);
      }
    } catch (error) {
      this.logger.error(`加载 Cloudflare CIDR 失败：${(error as Error).message}`);
    }
  }

  private addToGraveyard(node: ProxyNode, reason: string): void {
    const entry: GraveyardEntry = {
      id: node.id,
      ip: node.ip,
      port: node.port,
      t: Date.now(),
      reason
    };
    
    this.state.graveyard.list.push(entry);
    if (this.state.graveyard.list.length > 1000) {
      this.state.graveyard.list = this.state.graveyard.list.slice(-1000);
    }

    // Block node temporarily
    this.state.blocked[node.id] = Date.now() + GRAVEYARD_BLOCK_EXPIRE_MS;
    
    this.logger.log(`节点 ${node.id} 已加入墓地：${reason}`);
  }

  private cleanupOldData(): void {
    const now = Date.now();
    const expireMs = 7 * 24 * 3600 * 1000; // 7 days

    // Cleanup history
    for (const [nodeId, entries] of Object.entries(this.state.history)) {
      this.state.history[nodeId] = entries.filter(e => now - e.t < expireMs);
      if (this.state.history[nodeId].length === 0) {
        delete this.state.history[nodeId];
      }
    }

    // Cleanup graveyard
    this.state.graveyard.list = this.state.graveyard.list.filter(
      e => now - e.t < expireMs
    );

    // Cleanup blocked
    for (const [nodeId, expireTime] of Object.entries(this.state.blocked)) {
      if (now > expireTime) {
        delete this.state.blocked[nodeId];
      }
    }

    this.logger.log('已完成旧数据清理');
  }

  async discoverNodes(): Promise<number> {
    try {
      const ipFile = path.join(this.config.dataDir, 'iplist.txt');
      let content = '';
      
      if (fs.existsSync(ipFile)) {
        content = fs.readFileSync(ipFile, 'utf8');
      } else {
        // Try to load from default location
        const defaultIpFile = path.join(process.cwd(), 'public', 'iplist.txt');
        if (fs.existsSync(defaultIpFile)) {
          content = fs.readFileSync(defaultIpFile, 'utf8');
        }
      }

      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const newNodes: Record<string, ProxyNode> = {};

      for (const line of lines) {
        const parts = line.split(/[:\s]+/);
        if (parts.length >= 2) {
          const ip = parts[0];
          const port = parseInt(parts[1], 10);
          if (ip && port && !isNaN(port)) {
            const id = `${ip}:${port}`;
            if (!this.state.nodes[id]) {
              newNodes[id] = {
                id,
                ip,
                port,
                firstSeen: Date.now(),
                lastOnlineAt: null,
                kind: 'manual',
                firstSource: { kind: 'file', name: 'iplist.txt' }
              };
            }
          }
        }
      }

      // Merge with existing nodes
      this.state.nodes = { ...this.state.nodes, ...newNodes };
      
      // Save new nodes to database
      for (const node of Object.values(newNodes)) {
        this.dataService.saveNode(node);
      }

      this.logger.log(`发现 ${Object.keys(newNodes).length} 个新节点，总计 ${Object.keys(this.state.nodes).length} 个节点`);
      return Object.keys(newNodes).length;
    } catch (error) {
      this.logger.error(`发现节点失败：${(error as Error).message}`);
      return 0;
    }
  }

  getState(): MonitorState {
    return {
      ...this.state,
      graveyard: { list: this.state.graveyard.list }
    };
  }

  getLogs(): string[] {
    return this.state.logs.slice(-100);
  }

  getGraveyard(): { list: GraveyardEntry[]; blocked: Record<string, number> } {
    return {
      list: this.state.graveyard.list,
      blocked: this.state.blocked
    };
  }

  clearGraveyard(): void {
    this.state.graveyard.list = [];
    this.state.blocked = {};
    this.saveState();
    this.logger.log('墓地已清空');
  }

  async unblockNodes(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (this.state.blocked[id]) {
        delete this.state.blocked[id];
        count++;
      }
    }
    if (count > 0) {
      this.saveState();
    }
    return count;
  }

  async removeNodes(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (this.state.nodes[id]) {
        delete this.state.nodes[id];
        this.dataService.deleteNode(id);
        count++;
      }
      if (this.state.history[id]) {
        delete this.state.history[id];
      }
      if (this.state.speed[id]) {
        delete this.state.speed[id];
      }
    }
    if (count > 0) {
      this.saveState();
    }
    return count;
  }

  async speedTest(ids: string[]): Promise<Record<string, SpeedResult>> {
    const results: Record<string, SpeedResult> = {};
    
    for (const id of ids) {
      const node = this.state.nodes[id];
      if (node) {
        try {
          const result = await this.probeService.probeSpeed(node);
          results[id] = result;
          this.state.speed[id] = result;
          this.dataService.saveSpeedResult(id, result);
        } catch (error) {
          results[id] = {
            t: Date.now(),
            ok: false,
            mbps: null,
            size: null,
            failReason: (error as Error).message
          };
        }
      }
    }
    
    this.saveState();
    return results;
  }

  getPublicConfig(): Partial<AppConfig> {
    return {
      intervalSec: this.config.intervalSec,
      concurrency: this.config.concurrency,
      timeoutSec: this.config.timeoutSec,
      speedEnabled: this.config.speedEnabled,
      speedTimeoutSec: this.config.speedTimeoutSec,
      probeUrl: this.config.probeUrl,
      speedUrl: this.config.speedUrl,
      customProbes: this.config.customProbes,
      githubRepo: this.config.githubRepo,
      githubBranch: this.config.githubBranch
    };
  }

  updateConfig(updates: Partial<AppConfig>): void {
    this.config.update(updates);
    this.logger.log('配置已更新');
    
    // Restart timer if interval changed
    if (updates.intervalSec && updates.intervalSec !== this.config.intervalSec) {
      this.startTimer();
    }
  }

  getIpFileContent(): string {
    const ipFile = path.join(this.config.dataDir, 'iplist.txt');
    if (fs.existsSync(ipFile)) {
      return fs.readFileSync(ipFile, 'utf8');
    }
    return '';
  }

  async updateIpFile(content: string): Promise<void> {
    const ipFile = path.join(this.config.dataDir, 'iplist.txt');
    fs.writeFileSync(ipFile, content);
    this.logger.log('IP 列表文件已更新');
    await this.discoverNodes();
  }

  getNodeCount(): number {
    return Object.keys(this.state.nodes).length;
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
  }

  async uploadToGithub(): Promise<{ url?: string; error?: string }> {
    if (!this.config.githubToken || !this.config.githubRepo) {
      return { error: '未配置 GitHub Token 或仓库' };
    }

    try {
      const bestNodes = this.getBestNodes(100);
      const content = bestNodes.map(n => `${n.ip}:${n.port}`).join('\n');
      
      const apiUrl = `https://api.github.com/repos/${this.config.githubRepo}/contents/best-ips.txt`;
      
      // Get current file SHA
      let sha = '';
      try {
        const getResponse = await fetch(apiUrl, {
          headers: {
            'Authorization': `token ${this.config.githubToken}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        
        if (getResponse.ok) {
          const getData = await getResponse.json() as any;
          sha = getData.sha;
        }
      } catch (e) {
        // File doesn't exist yet, that's OK
      }

      const body: any = {
        message: `Auto-update: ${new Date().toISOString()}`,
        content: Buffer.from(content).toString('base64'),
        branch: this.config.githubBranch || 'main'
      };
      
      if (sha) {
        body.sha = sha;
      }

      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${this.config.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const result = await response.json() as any;
        this.state.github.lastUpload = Date.now();
        this.state.github.lastError = null;
        this.logger.log(`已上传到 GitHub: ${result.content.html_url}`);
        this.saveState();
        return { url: result.content.html_url };
      } else {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Upload failed');
      }
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.state.github.lastError = errorMsg;
      this.logger.error(`GitHub 上传失败：${errorMsg}`);
      this.saveState();
      return { error: errorMsg };
    }
  }

  private getBestNodes(limit: number): ProxyNode[] {
    const nodesWithSpeed = Object.values(this.state.nodes).map(node => {
      const speed = this.state.speed[node.id];
      return {
        node,
        mbps: speed?.ok ? (speed.mbps || 0) : 0
      };
    });

    return nodesWithSpeed
      .sort((a, b) => b.mbps - a.mbps)
      .slice(0, limit)
      .map(item => item.node);
  }

  private saveState(): void {
    this.dataService.saveHistory(this.state.history);
    this.dataService.saveGraveyard(
      this.state.graveyard.list,
      this.state.blocked
    );
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.dataService.close();
    this.logger.log('监控服务已关闭');
  }
}
