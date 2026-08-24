import { ProxyNode, HistoryEntry, GraveyardEntry, SpeedResult } from '../types';
import { Logger } from '../utils/logger';
export declare class DataService {
    private db;
    private dataDir;
    private historyFile;
    private graveyardFile;
    private logger;
    constructor(dataDir: string, logger: Logger);
    private initDatabase;
    loadHistory(): Record<string, HistoryEntry[]>;
    loadGraveyard(): {
        list: GraveyardEntry[];
        blocked: Record<string, number>;
    };
    saveHistory(history: Record<string, HistoryEntry[]>): void;
    saveGraveyard(list: GraveyardEntry[], blocked: Record<string, number>): void;
    saveNode(node: ProxyNode): void;
    saveSpeedResult(nodeId: string, speed: SpeedResult): void;
    getSpeedResults(): Record<string, SpeedResult>;
    deleteNode(nodeId: string): void;
    close(): void;
}
//# sourceMappingURL=data.service.d.ts.map