import { CustomProbe } from '../types';
declare const VERSION = "v2.0.0";
export interface AppConfigInterface {
    dataDir: string;
    intervalSec: number;
    probeUrl: string;
    customProbes: CustomProbe[];
    timeoutSec: number;
    concurrency: number;
    autoCleanDays: number;
    maxTotalMs: number;
    qualityWindow: number;
    successThreshold: number;
    qualThreshold: number;
    speedEnabled: boolean;
    speedUrl: string;
    speedTimeoutSec: number;
    speedMinMBps: number;
    speedConcurrency: number;
    speedPerCycle: number;
    githubToken?: string;
    githubRepo?: string;
    githubBranch?: string;
}
declare const DEFAULT_CONFIG: AppConfigInterface;
export declare class AppConfigClass implements AppConfigInterface {
    dataDir: string;
    intervalSec: number;
    probeUrl: string;
    customProbes: CustomProbe[];
    timeoutSec: number;
    concurrency: number;
    autoCleanDays: number;
    maxTotalMs: number;
    qualityWindow: number;
    successThreshold: number;
    qualThreshold: number;
    speedEnabled: boolean;
    speedUrl: string;
    speedTimeoutSec: number;
    speedMinMBps: number;
    speedConcurrency: number;
    speedPerCycle: number;
    githubToken?: string;
    githubRepo?: string;
    githubBranch?: string;
    constructor(dataDir?: string);
    private parseCustomProbes;
    load(): Promise<void>;
    update(updates: Partial<AppConfig>): void;
}
export type AppConfig = AppConfigInterface;
export declare function getHistoryCap(qualityWindow: number): number;
export declare const CF_SUPERNETS: string[];
export { VERSION, DEFAULT_CONFIG };
//# sourceMappingURL=index.d.ts.map