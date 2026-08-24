import { Request, Response } from 'express';
import { MonitorService } from '../services/monitor.service';
import { Logger } from '../utils/logger';
export declare class ApiController {
    private monitorService;
    private logger;
    constructor(monitorService: MonitorService, logger: Logger);
    getState: (req: Request, res: Response) => Promise<void>;
    getLogs: (req: Request, res: Response) => Promise<void>;
    abortCheck: (req: Request, res: Response) => Promise<void>;
    getGraveyard: (req: Request, res: Response) => Promise<void>;
    clearGraveyard: (req: Request, res: Response) => Promise<void>;
    unblockNodes: (req: Request, res: Response) => Promise<void>;
    removeNodes: (req: Request, res: Response) => Promise<void>;
    speedTest: (req: Request, res: Response) => Promise<void>;
    getConfig: (req: Request, res: Response) => Promise<void>;
    updateConfig: (req: Request, res: Response) => Promise<void>;
    getIpFile: (req: Request, res: Response) => Promise<void>;
    updateIpFile: (req: Request, res: Response) => Promise<void>;
    checkNow: (req: Request, res: Response) => Promise<void>;
    reloadNodes: (req: Request, res: Response) => Promise<void>;
    uploadToGithub: (req: Request, res: Response) => Promise<void>;
}
//# sourceMappingURL=api.controller.d.ts.map