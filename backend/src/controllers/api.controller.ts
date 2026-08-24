import { Request, Response } from 'express';
import { MonitorService } from '../services/monitor.service';
import { Logger } from '../utils/logger';
import { VERSION } from '../config';

export class ApiController {
  constructor(
    private monitorService: MonitorService,
    private logger: Logger
  ) {}

  getState = async (req: Request, res: Response): Promise<void> => {
    try {
      const state = this.monitorService.getState();
      res.json(state);
    } catch (error) {
      this.logger.error(`Get state error: ${(error as Error).message}`);
      res.status(500).json({ error: 'Failed to get state' });
    }
  };

  getLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const logs = this.monitorService.getLogs();
      res.json({ logs });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get logs' });
    }
  };

  abortCheck = async (req: Request, res: Response): Promise<void> => {
    try {
      this.monitorService.abort();
      this.logger.log('收到中断请求');
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to abort' });
    }
  };

  getGraveyard = async (req: Request, res: Response): Promise<void> => {
    try {
      const graveyard = this.monitorService.getGraveyard();
      res.json({ graveyard });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get graveyard' });
    }
  };

  clearGraveyard = async (req: Request, res: Response): Promise<void> => {
    try {
      this.monitorService.clearGraveyard();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clear graveyard' });
    }
  };

  unblockNodes = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.length) {
        res.status(400).json({ ok: false, error: '无有效节点 ID' });
        return;
      }
      const count = await this.monitorService.unblockNodes(ids);
      res.json({ ok: true, count });
    } catch (error) {
      res.status(500).json({ error: 'Failed to unblock nodes' });
    }
  };

  removeNodes = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.length) {
        res.status(400).json({ ok: false, error: '无有效节点 ID' });
        return;
      }
      const count = await this.monitorService.removeNodes(ids);
      res.json({ ok: true, count });
    } catch (error) {
      res.status(500).json({ error: 'Failed to remove nodes' });
    }
  };

  speedTest = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.length) {
        res.status(400).json({ ok: false, error: '无有效节点 ID' });
        return;
      }
      const results = await this.monitorService.speedTest(ids.slice(0, 10));
      res.json({ ok: true, results });
    } catch (error) {
      res.status(500).json({ error: 'Failed to run speed test' });
    }
  };

  getConfig = async (req: Request, res: Response): Promise<void> => {
    try {
      const config = this.monitorService.getPublicConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get config' });
    }
  };

  updateConfig = async (req: Request, res: Response): Promise<void> => {
    try {
      this.monitorService.updateConfig(req.body);
      this.logger.log('配置已更新');
      const config = this.monitorService.getPublicConfig();
      res.json({ ok: true, config });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update config' });
    }
  };

  getIpFile = async (req: Request, res: Response): Promise<void> => {
    try {
      const content = this.monitorService.getIpFileContent();
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get IP file' });
    }
  };

  updateIpFile = async (req: Request, res: Response): Promise<void> => {
    try {
      const { content } = req.body;
      await this.monitorService.updateIpFile(String(content ?? ''));
      const count = this.monitorService.getNodeCount();
      res.json({ ok: true, count });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update IP file' });
    }
  };

  checkNow = async (req: Request, res: Response): Promise<void> => {
    try {
      this.logger.log('手动触发检测');
      this.monitorService.runCycle().catch(e => this.logger.error(`手动检测异常：${e.message}`));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to start check' });
    }
  };

  reloadNodes = async (req: Request, res: Response): Promise<void> => {
    try {
      const count = await this.monitorService.discoverNodes();
      res.json({ ok: true, count });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reload nodes' });
    }
  };

  uploadToGithub = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.monitorService.uploadToGithub();
      res.json({ ok: true, ...result });
    } catch (error) {
      this.logger.error(`手动上传失败：${(error as Error).message}`);
      res.status(500).json({ ok: false, error: (error as Error).message });
    }
  };
}
