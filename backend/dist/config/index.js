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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.VERSION = exports.CF_SUPERNETS = exports.AppConfigClass = void 0;
exports.getHistoryCap = getHistoryCap;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const VERSION = 'v2.0.0';
exports.VERSION = VERSION;
const DEFAULT_CONFIG = {
    dataDir: '/app/data',
    intervalSec: 60,
    probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
    customProbes: [],
    timeoutSec: 5,
    concurrency: 50,
    autoCleanDays: 7,
    maxTotalMs: 0,
    qualityWindow: 10,
    successThreshold: 1,
    qualThreshold: 1,
    speedEnabled: true,
    speedUrl: 'https://speed.cloudflare.com/__down?bytes=20000000',
    speedTimeoutSec: 10,
    speedMinMBps: 0,
    speedConcurrency: 1,
    speedPerCycle: 20,
    githubToken: undefined,
    githubRepo: undefined,
    githubBranch: 'main'
};
exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
function parseNumber(env, defaultVal) {
    const parsed = parseFloat(env || String(defaultVal));
    return isFinite(parsed) ? parsed : defaultVal;
}
function parseBoolean(env, defaultVal) {
    if (env === undefined)
        return defaultVal;
    return env === 'true' || env === '1';
}
class AppConfigClass {
    dataDir;
    intervalSec;
    probeUrl;
    customProbes;
    timeoutSec;
    concurrency;
    autoCleanDays;
    maxTotalMs;
    qualityWindow;
    successThreshold;
    qualThreshold;
    speedEnabled;
    speedUrl;
    speedTimeoutSec;
    speedMinMBps;
    speedConcurrency;
    speedPerCycle;
    githubToken;
    githubRepo;
    githubBranch;
    constructor(dataDir) {
        this.dataDir = dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
        this.intervalSec = parseNumber(process.env.INTERVAL_SEC, DEFAULT_CONFIG.intervalSec);
        this.probeUrl = process.env.PROBE_URL || DEFAULT_CONFIG.probeUrl;
        this.customProbes = this.parseCustomProbes();
        this.timeoutSec = parseNumber(process.env.TIMEOUT_SEC, DEFAULT_CONFIG.timeoutSec);
        this.concurrency = parseNumber(process.env.CONCURRENCY, DEFAULT_CONFIG.concurrency);
        this.autoCleanDays = parseNumber(process.env.AUTO_CLEAN_DAYS, DEFAULT_CONFIG.autoCleanDays);
        this.maxTotalMs = parseNumber(process.env.MAX_TOTAL_MS, DEFAULT_CONFIG.maxTotalMs);
        this.qualityWindow = parseNumber(process.env.QUALITY_WINDOW, DEFAULT_CONFIG.qualityWindow);
        this.successThreshold = parseNumber(process.env.SUCCESS_THRESHOLD, DEFAULT_CONFIG.successThreshold);
        this.qualThreshold = parseNumber(process.env.QUAL_THRESHOLD, DEFAULT_CONFIG.qualThreshold);
        this.speedEnabled = parseBoolean(process.env.SPEED_ENABLED, DEFAULT_CONFIG.speedEnabled);
        this.speedUrl = process.env.SPEED_URL || DEFAULT_CONFIG.speedUrl;
        this.speedTimeoutSec = parseNumber(process.env.SPEED_TIMEOUT_SEC, DEFAULT_CONFIG.speedTimeoutSec);
        this.speedMinMBps = parseNumber(process.env.SPEED_MIN_MBPS, DEFAULT_CONFIG.speedMinMBps);
        this.speedConcurrency = Math.min(3, Math.max(1, parseNumber(process.env.SPEED_CONCURRENCY, DEFAULT_CONFIG.speedConcurrency)));
        this.speedPerCycle = Math.max(1, parseNumber(process.env.SPEED_PER_CYCLE, DEFAULT_CONFIG.speedPerCycle));
        this.githubToken = process.env.GITHUB_TOKEN;
        this.githubRepo = process.env.GITHUB_REPO;
        this.githubBranch = process.env.GITHUB_BRANCH || DEFAULT_CONFIG.githubBranch;
    }
    parseCustomProbes() {
        const probesStr = process.env.CUSTOM_PROBES;
        if (!probesStr)
            return [];
        try {
            const probes = JSON.parse(probesStr);
            if (Array.isArray(probes)) {
                return probes.filter(p => p.url && p.expect).map(p => ({ url: p.url, expect: String(p.expect) }));
            }
        }
        catch (e) {
            // Invalid JSON, ignore
        }
        return [];
    }
    async load() {
        const configFile = path.join(this.dataDir, 'config.json');
        try {
            if (fs.existsSync(configFile)) {
                const savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
                this.update(savedConfig);
            }
        }
        catch (error) {
            console.error(`Failed to load config file: ${error.message}`);
        }
    }
    update(updates) {
        const validKeys = [
            'dataDir', 'intervalSec', 'probeUrl', 'customProbes', 'timeoutSec',
            'concurrency', 'autoCleanDays', 'maxTotalMs', 'qualityWindow',
            'successThreshold', 'qualThreshold', 'speedEnabled', 'speedUrl',
            'speedTimeoutSec', 'speedMinMBps', 'speedConcurrency', 'speedPerCycle',
            'githubToken', 'githubRepo', 'githubBranch'
        ];
        for (const key of validKeys) {
            if (updates[key] !== undefined) {
                this[key] = updates[key];
            }
        }
        // Save config to file
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const configFile = path.join(this.dataDir, 'config.json');
            const saveData = { ...this };
            delete saveData.dataDir; // Don't save dataDir
            fs.writeFileSync(configFile, JSON.stringify(saveData, null, 2));
        }
        catch (error) {
            console.error(`Failed to save config: ${error.message}`);
        }
    }
}
exports.AppConfigClass = AppConfigClass;
function getHistoryCap(qualityWindow) {
    return Math.min(50, Math.max(1, Math.round(qualityWindow) || 10));
}
exports.CF_SUPERNETS = [
    '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/12',
    '108.162.192.0/18', '131.0.72.0/22', '141.101.64.0/18', '162.158.0.0/15',
    '172.64.0.0/13', '173.245.48.0/20', '188.114.96.0/20', '190.93.240.0/20',
    '197.234.240.0/22', '198.41.128.0/17'
];
//# sourceMappingURL=index.js.map