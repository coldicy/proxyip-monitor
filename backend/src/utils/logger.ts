import { MonitorState } from '../types';

export class Logger {
  private state: MonitorState;

  constructor(state: MonitorState) {
    this.state = state;
  }

  log(message: string): void {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logEntry = `${timestamp} [INFO]: ${message}`;
    this.state.logs.push(logEntry);
    if (this.state.logs.length > 400) {
      this.state.logs = this.state.logs.slice(-400);
    }
    console.log(logEntry);
  }

  error(message: string): void {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logEntry = `${timestamp} [ERROR]: ${message}`;
    this.state.logs.push(logEntry);
    if (this.state.logs.length > 400) {
      this.state.logs = this.state.logs.slice(-400);
    }
    console.error(logEntry);
  }

  warn(message: string): void {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logEntry = `${timestamp} [WARN]: ${message}`;
    this.state.logs.push(logEntry);
    if (this.state.logs.length > 400) {
      this.state.logs = this.state.logs.slice(-400);
    }
    console.warn(logEntry);
  }

  debug(message: string): void {
    if (process.env.DEBUG) {
      const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      console.debug(`${timestamp} [DEBUG]: ${message}`);
    }
  }
}
