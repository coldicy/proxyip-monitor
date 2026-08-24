import { EventEmitter } from 'events';
import { GraveyardEntry, SpeedResult, MonitorState, AppConfig } from '../types';
export declare class MonitorService extends EventEmitter {
    private config;
    private dataService;
    private probeService;
    private logger;
    private state;
    private timer;
    private abortController;
    private cycleRunning;
    private lastCleanup;
    constructor();
    initializeAndStart(): Promise<void>;
    private startTimer;
    runCycle(): Promise<void>;
    private checkNode;
    private loadCloudflareCidrs;
    private addToGraveyard;
    private cleanupOldData;
    discoverNodes(): Promise<number>;
    getState(): MonitorState;
    getLogs(): string[];
    getGraveyard(): {
        list: GraveyardEntry[];
        blocked: Record<string, number>;
    };
    clearGraveyard(): void;
    unblockNodes(ids: string[]): Promise<number>;
    removeNodes(ids: string[]): Promise<number>;
    speedTest(ids: string[]): Promise<Record<string, SpeedResult>>;
    getPublicConfig(): Partial<AppConfig>;
    updateConfig(updates: Partial<AppConfig>): void;
    getIpFileContent(): string;
    updateIpFile(content: string): Promise<void>;
    getNodeCount(): number;
    abort(): void;
    uploadToGithub(): Promise<{
        url?: string;
        error?: string;
    }>;
    private getBestNodes;
    private saveState;
    close(): void;
}
//# sourceMappingURL=monitor.service.d.ts.map