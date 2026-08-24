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
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const path = __importStar(require("path"));
const monitor_service_1 = require("./services/monitor.service");
const api_controller_1 = require("./controllers/api.controller");
const logger_1 = require("./utils/logger");
const config_1 = require("./config");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8787;
// Initialize services
const monitorService = new monitor_service_1.MonitorService();
const logger = new logger_1.Logger(monitorService['state'] || {
    nodes: {}, history: {}, blocked: {}, graveyard: { list: [] },
    cfCidrs: [], cfCidrsAt: 0, checking: false, lastCycle: null,
    progress: { tested: 0, total: 0 }, logs: [], github: { lastUpload: null, lastError: null }
});
const apiController = new api_controller_1.ApiController(monitorService, logger);
// Middleware
app.use((0, cors_1.default)());
app.use((0, helmet_1.default)({ contentSecurityPolicy: false }));
app.use((0, compression_1.default)());
app.use(express_1.default.json({ limit: '5mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '5mb' }));
// Static files
app.use(express_1.default.static(path.join(__dirname, '../public')));
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
    res.json({ status: 'ok', version: config_1.VERSION });
});
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});
// Error handler
app.use((err, req, res, next) => {
    logger.error(`Server error: ${err.message}`);
    res.status(500).json({ error: err.message || 'Internal server error' });
});
// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Proxy Monitor ${config_1.VERSION} on http://0.0.0.0:${PORT}`);
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
exports.default = app;
//# sourceMappingURL=index.js.map