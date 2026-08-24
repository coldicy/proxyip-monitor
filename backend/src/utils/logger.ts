import winston from 'winston';
import { AppState } from '../types';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

export class Logger {
  private logger: winston.Logger;
  private state: AppState;

  constructor(state: AppState) {
    this.state = state;
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      ),
      defaultMeta: { service: 'proxy-monitor' },
      transports: [
        new winston.transports.Console({
          format: combine(colorize(), logFormat)
        })
      ]
    });
  }

  log(message: string): void {
    this.state.logs.push({ t: Date.now(), m: message });
    if (this.state.logs.length > 400) {
      this.state.logs = this.state.logs.slice(-400);
    }
    this.logger.info(message);
  }

  error(message: string): void {
    this.state.logs.push({ t: Date.now(), m: `ERROR: ${message}` });
    if (this.state.logs.length > 400) {
      this.state.logs = this.state.logs.slice(-400);
    }
    this.logger.error(message);
  }

  warn(message: string): void {
    this.state.logs.push({ t: Date.now(), m: `WARN: ${message}` });
    if (this.state.logs.length > 400) {
      this.state.logs = this.state.logs.slice(-400);
    }
    this.logger.warn(message);
  }

  debug(message: string): void {
    this.logger.debug(message);
  }
}
