"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
class Logger {
    state;
    constructor(state) {
        this.state = state;
    }
    log(message) {
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const logEntry = `${timestamp} [INFO]: ${message}`;
        this.state.logs.push(logEntry);
        if (this.state.logs.length > 400) {
            this.state.logs = this.state.logs.slice(-400);
        }
        console.log(logEntry);
    }
    error(message) {
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const logEntry = `${timestamp} [ERROR]: ${message}`;
        this.state.logs.push(logEntry);
        if (this.state.logs.length > 400) {
            this.state.logs = this.state.logs.slice(-400);
        }
        console.error(logEntry);
    }
    warn(message) {
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const logEntry = `${timestamp} [WARN]: ${message}`;
        this.state.logs.push(logEntry);
        if (this.state.logs.length > 400) {
            this.state.logs = this.state.logs.slice(-400);
        }
        console.warn(logEntry);
    }
    debug(message) {
        if (process.env.DEBUG) {
            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
            console.debug(`${timestamp} [DEBUG]: ${message}`);
        }
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map