import { MonitorState } from '../types';
export declare class Logger {
    private state;
    constructor(state: MonitorState);
    log(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
}
//# sourceMappingURL=logger.d.ts.map