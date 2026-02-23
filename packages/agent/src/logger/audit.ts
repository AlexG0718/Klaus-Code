import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';
import * as os from 'os';

/**
 * Audit Logger
 * 
 * Separate logging transport for security-sensitive operations:
 * - Session deletion
 * - Session export
 * - Workspace rollback
 * - Authentication failures
 * - Rate limit events
 * 
 * Logs include timestamps, IPs, and operation details for compliance
 * and security forensics.
 */

const LOG_DIR = process.env.AGENT_LOG_DIR ?? path.join(os.homedir(), '.klaus-code', 'logs');

const { combine, timestamp, json } = winston.format;

// Audit log format: structured JSON with all context
const auditFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  json()
);

export const auditLogger = winston.createLogger({
  level: 'info',
  defaultMeta: { service: 'klaus-code-audit' },
  transports: [
    // Audit-specific rotating log file
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'audit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '90d',  // Keep 90 days of audit logs (longer retention)
      maxSize: '100m',  // Larger files for audit trails
      format: auditFormat,
    }),
  ],
  exitOnError: false,
});

export type AuditAction = 
  | 'session_delete'
  | 'session_export'
  | 'session_rollback'
  | 'auth_failure'
  | 'rate_limit_exceeded'
  | 'session_create'
  | 'workspace_modify'
  | 'config_change';

export interface AuditEntry {
  action: AuditAction;
  ip?: string;
  sessionId?: string;
  userId?: string;  // For future auth integration
  details?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
}

/**
 * Log an audit event. All sensitive operations should call this.
 */
export function logAudit(entry: AuditEntry): void {
  auditLogger.info(entry.action, {
    ...entry,
    auditTimestamp: new Date().toISOString(),
  });
}

/**
 * Convenience methods for common audit events
 */
export const audit = {
  sessionDelete: (ip: string | undefined, sessionId: string, success: boolean, error?: string) => {
    logAudit({
      action: 'session_delete',
      ip,
      sessionId,
      success,
      errorMessage: error,
    });
  },

  sessionExport: (ip: string | undefined, sessionId: string, format: string, success: boolean) => {
    logAudit({
      action: 'session_export',
      ip,
      sessionId,
      details: { format },
      success,
    });
  },

  workspaceRollback: (ip: string | undefined, sessionId: string | undefined, success: boolean, error?: string) => {
    logAudit({
      action: 'session_rollback',
      ip,
      sessionId,
      success,
      errorMessage: error,
    });
  },

  authFailure: (ip: string | undefined, path: string, reason: string) => {
    logAudit({
      action: 'auth_failure',
      ip,
      details: { path, reason },
      success: false,
    });
  },

  rateLimitExceeded: (ip: string | undefined, type: 'http' | 'websocket', count: number) => {
    logAudit({
      action: 'rate_limit_exceeded',
      ip,
      details: { type, count },
      success: false,
    });
  },
};
