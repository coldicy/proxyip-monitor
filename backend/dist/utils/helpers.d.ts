export declare function runCurl(command: string, timeoutMs: number): Promise<string | null>;
export declare function runCurlWithCode(command: string, timeoutMs: number): Promise<{
    out: string;
    code: number;
}>;
export declare function getCurlFailText(code: number): string;
export declare function parseCurlJson(output: string): any;
export declare function parseTrace(traceText: string): Record<string, string>;
export declare function parseNodeInfo(traceText: string): {
    ip: string;
    country?: string;
    city?: string;
} | null;
export declare function isValidIP(ip: string): boolean;
export declare function ipToInt(ip: string): number;
export declare function cidrMatch(ip: string, cidr: string): boolean;
export declare function sanitizeUrl(url: string): string;
export declare function isUrl(s: string): boolean;
export declare function maskToken(token: string): string;
export declare function isMaskedToken(token: string): boolean;
export declare function parseLine(raw: string): {
    host: string;
    port: number;
} | null;
//# sourceMappingURL=helpers.d.ts.map