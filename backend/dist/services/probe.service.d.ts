import { ProxyNode, ProbeResult, TimingSegments, SpeedResult } from '../types';
import { AppConfig } from '../config';
export declare class ProbeService {
    private config;
    constructor(config: AppConfig);
    private splitProbe;
    private buildTimingSegments;
    probeLatency(node: ProxyNode): Promise<ProbeResult>;
    probeCustomProbes(node: ProxyNode): Promise<{
        url: string;
        ok: boolean;
        segs: TimingSegments | null;
        failReason: string | null;
    }[]>;
    probeSpeed(node: ProxyNode): Promise<SpeedResult>;
    needSpeedTest(speed: SpeedResult | undefined): boolean;
}
//# sourceMappingURL=probe.service.d.ts.map