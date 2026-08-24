import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import * as path from 'path';
import { MonitorService } from './services/monitor.service';
import { ApiController } from './controllers/api.controller';
import { Logger } from './utils/logger';
import { VERSION } from './config';

const app = express();
const PORT = process.env.PORT || 8787;

// Initialize services
const monitorService = new MonitorService();
const logger = new Logger(monitorService['state'] || {
  nodes: {}, history: {}, blocked: {}, graveyard: { list: [] },
  cfCidrs: [], cfCidrsAt: 0, checking: false, lastCycle: null,
  progress: { tested: 0, total: 0 }, logs: [], github: { lastUpload: null, lastError: null }
});
const apiController = new ApiController(monitorService, logger);

// Middleware
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.get('/api/state', apiController.getState);
app.get('/api/logs', apiController.getLogs);
app.post('/api/abort', apiController.abortCheck);
app.get('/api/graveyard', apiController.getGraveyard);
app.post('/api/graveyard/clear', apiController.clearGraveyard);
app.post('/api/graveyard/unblock', apiController.unblockNodes);
app.post('/api/remove', apiController.removeNodes);
app.post('/api/speedtest', apiController.speedTest);
app.get('/api/config', apiController.getConfig);
app.post('/api/config', apiController.updateConfig);
app.get('/api/ipfile', apiController.getIpFile);
app.post('/api/ipfile', apiController.updateIpFile);
app.post('/api/check', apiController.checkNow);
app.post('/api/reload', apiController.reloadNodes);
app.post('/api/upload', apiController.uploadToGithub);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: VERSION });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error(`Server error: ${err.message}`);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Proxy Monitor ${VERSION} on http://0.0.0.0:${PORT}`);
  
  // Initialize and start monitoring
  monitorService.initializeAndStart().catch(e => {
    logger.error(`启动失败：${e.message}`);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.log('收到 SIGTERM，正在关闭...');
  server.close(() => {
    monitorService.close();
    logger.log('服务已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.log('收到 SIGINT，正在关闭...');
  server.close(() => {
    monitorService.close();
    logger.log('服务已关闭');
    process.exit(0);
  });
});

export default app;
