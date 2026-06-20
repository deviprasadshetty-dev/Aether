/**
 * Aether structured logger with correlation IDs for agent action tracing.
 * Replaces ad-hoc console.error calls with leveled, structured output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    ts: string;
    level: LogLevel;
    corrId?: string;
    action?: string;
    msg: string;
    data?: Record<string, unknown>;
}

let globalLogLevel: LogLevel = "info";
const listeners: Array<(entry: LogEntry) => void> = [];

export function setLogLevel(level: LogLevel): void {
    globalLogLevel = level;
}

export function onLog(fn: (entry: LogEntry) => void): () => void {
    listeners.push(fn);
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
    };
}

const LEVEL_PRIO: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIO[level] >= LEVEL_PRIO[globalLogLevel];
}

function emit(entry: LogEntry): void {
    if (!shouldLog(entry.level)) return;

    // Structured stderr output for MCP transport
    const prefix = entry.corrId ? `[${entry.corrId}]` : "";
    const actionTag = entry.action ? ` [${entry.action}]` : "";
    const dataSuffix = entry.data ? ` ${JSON.stringify(entry.data)}` : "";

    const method =
        entry.level === "error"
            ? "error"
            : entry.level === "warn"
              ? "warn"
              : "error"; // MCP uses stderr for all logging

    console.error(
        `[Aether:${entry.level.toUpperCase()}]${prefix}${actionTag} ${entry.msg}${dataSuffix}`
    );

    for (const fn of listeners) {
        try {
            fn(entry);
        } catch {
            // Listener errors must not break logging
        }
    }
}

// ─── Logger Factory (creates logger with bound correlation ID) ────────

export interface Logger {
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    child(action: string): Logger;
    corrId: string;
}

let idCounter = 0;

export function createLogger(corrId?: string): Logger {
    const cid = corrId ?? `req-${++idCounter}-${Date.now().toString(36)}`;

    const log = (level: LogLevel, msg: string, data?: Record<string, unknown>, action?: string) => {
        emit({
            ts: new Date().toISOString(),
            level,
            corrId: cid,
            action,
            msg,
            data,
        });
    };

    return {
        corrId: cid,
        debug(msg, data) {
            log("debug", msg, data);
        },
        info(msg, data) {
            log("info", msg, data);
        },
        warn(msg, data) {
            log("warn", msg, data);
        },
        error(msg, data) {
            log("error", msg, data);
        },
        child(action: string): Logger {
            return {
                corrId: cid,
                debug(msg, data) {
                    log("debug", msg, data, action);
                },
                info(msg, data) {
                    log("info", msg, data, action);
                },
                warn(msg, data) {
                    log("warn", msg, data, action);
                },
                error(msg, data) {
                    log("error", msg, data, action);
                },
                child(subAction: string): Logger {
                    return this.child(`${action}/${subAction}`);
                },
            };
        },
    };
}

// Default logger (no correlation ID)
export const rootLogger = createLogger("root");
