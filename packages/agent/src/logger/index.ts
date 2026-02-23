import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';
import * as os from 'os';

// ─── Log directory ────────────────────────────────────────────────────────────
// All log files live in one of two places depending on how you run the agent:
//
//  LOCAL (npm run dev)
//    ~/.klaus-code/logs/
//    ├── agent-YYYY-MM-DD.log       ← all levels (info, debug, warn, error)
//    ├── agent-error-YYYY-MM-DD.log ← errors only
//    └── exceptions.log             ← uncaught exceptions + unhandled rejections
//
//  DOCKER (docker compose up)
//    /data/logs/  (inside the agent container, mounted as a named volume)
//    Same file names as above. Access with:
//      docker compose exec agent ls /data/logs
//      docker compose cp agent:/data/logs ./logs-backup
//
// The log directory is controlled by AGENT_LOG_DIR in .env
// ─────────────────────────────────────────────────────────────────────────────

const LOG_DIR = process.env.AGENT_LOG_DIR ?? path.join(os.homedir(), '.klaus-code', 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// Console format: coloured, human-readable
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, component, ...rest }) => {
    const ctx = component ? `[${component}] ` : '';
    const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    return `${timestamp} ${level} ${ctx}${message}${extra}`;
  })
);

// File format: structured JSON, parseable by log tools
const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'klaus-code' },
  transports: [
    // Console — shown in terminal / docker compose logs
    new winston.transports.Console({ format: consoleFormat }),

    // All-levels daily rotating log file
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'agent-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',        // Keep 14 days of logs
      maxSize: '50m',         // Rotate if file exceeds 50MB
      format: fileFormat,
      level: LOG_LEVEL,
    }),

    // Errors-only log (easier to grep for problems)
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'agent-error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      format: fileFormat,
      level: 'error',
    }),
  ],

  // Catch uncaught exceptions and write them to exceptions.log
  exceptionHandlers: [
    new winston.transports.File({
      dirname: LOG_DIR,
      filename: 'exceptions.log',
      format: fileFormat,
    }),
  ],

  // Catch unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      dirname: LOG_DIR,
      filename: 'exceptions.log',
      format: fileFormat,
    }),
  ],

  exitOnError: false,
});

/**
 * Create a child logger that automatically includes a component name in every
 * log entry. Use this in each class/module:
 *
 *   const log = createChildLogger({ component: 'FileTool' });
 *   log.info('Reading file', { path: '...' });
 *   // → { "level":"info", "component":"FileTool", "message":"Reading file", "path":"..." }
 */
export function createChildLogger(meta: Record<string, unknown>): winston.Logger {
  return logger.child(meta);
}

// HTTP access log level (used by morgan middleware)
if (!Object.prototype.hasOwnProperty.call(winston.config.npm.levels, 'http')) {
  // 'http' sits between 'info' and 'verbose' in severity
}

// ─── Debug Logger ─────────────────────────────────────────────────────────────
// Separate logger for debug mode that captures full API requests/responses.
// Only active when AGENT_DEBUG_MODE=true. Writes to debug-YYYY-MM-DD.log.
// WARNING: This logs sensitive data including prompts and responses!

const DEBUG_MODE = process.env.AGENT_DEBUG_MODE === 'true';

export const debugLogger = winston.createLogger({
  level: DEBUG_MODE ? 'debug' : 'error', // effectively disabled when not debug mode
  defaultMeta: { service: 'klaus-code-debug' },
  silent: !DEBUG_MODE,
  transports: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'debug-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '3d',        // Keep only 3 days of debug logs
      maxSize: '100m',       // Larger size for verbose debug data
      format: combine(
        timestamp(),
        json()
      ),
    }),
  ],
});

/**
 * Log API request/response for debugging. Only writes if AGENT_DEBUG_MODE=true.
 */
export function logApiDebug(
  type: 'request' | 'response' | 'error',
  data: {
    sessionId: string;
    model?: string;
    messages?: unknown;
    tools?: unknown;
    response?: unknown;
    error?: unknown;
    tokens?: { input: number; output: number };
    attempt?: number;
  }
): void {
  if (!DEBUG_MODE) return;
  
  debugLogger.debug(`API ${type}`, {
    type,
    ...data,
    timestamp: new Date().toISOString(),
  });
}
