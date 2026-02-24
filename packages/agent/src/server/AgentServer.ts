import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { timingSafeEqual, createHash } from 'crypto';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';
import fg from 'fast-glob';
import { Agent } from '../agent/Agent';
import { DatabaseMemory } from '../memory/DatabaseMemory';
import { DockerSandbox } from '../sandbox/DockerSandbox';
import { logger } from '../logger';
import { audit } from '../logger/audit';
import type { AgentEvent } from '../agent/Agent';
import type { Config } from '../config';

// Helper to safely get string param (express types allow string | string[])
function getParam(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

// Extend Express Request to include correlation ID
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export class AgentServer {
  private app = express();
  private httpServer = createServer(this.app);
  private io: SocketIOServer;

  // Track which socket owns which session for join_session validation
  private sessionOwners = new Map<string, string>();

  // Cache for workspace tree to avoid repeated filesystem scans
  private workspaceTreeCache: {
    etag: string;
    data: { tree: TreeNode[]; workspace: string };
    timestamp: number;
  } | null = null;
  private readonly TREE_CACHE_TTL = 5000; // 5 seconds

  // WebSocket rate limiting: track events per socket
  private socketRateLimits = new Map<
    string,
    { count: number; resetAt: number }
  >();

  // Prometheus-style metrics
  private metrics = {
    httpRequestsTotal: 0,
    httpRequestsByPath: new Map<string, number>(),
    wsEventsTotal: 0,
    wsEventsByType: new Map<string, number>(),
    toolCallsTotal: 0,
    toolCallsByName: new Map<string, number>(),
    toolCallErrors: 0,
    tokensUsedTotal: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    sessionsFailed: 0,
    activeConnections: 0,
  };

  // Graceful shutdown state
  private isShuttingDown = false;
  private activeRequests = 0;

  // Session TTL cleanup timer
  private sessionCleanupTimer: NodeJS.Timeout | null = null;

  // Stale socket cleanup timer (checks for orphaned session owners)
  private staleSocketCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly memory: DatabaseMemory,
    private readonly config: Config,
    private readonly port: number
  ) {
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: this.config.corsOrigin,
        methods: ['GET', 'POST'],
      },
    });

    // Configure trust proxy for correct IP detection behind reverse proxies
    if (
      this.config.trustProxy !== false &&
      this.config.trustProxy !== 'false'
    ) {
      this.app.set('trust proxy', this.config.trustProxy);
      logger.info('Trust proxy configured', { value: this.config.trustProxy });
    }

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupSessionCleanup();
    this.setupStaleSocketCleanup();
  }

  // ─── Session TTL cleanup ────────────────────────────────────────────────────

  private setupSessionCleanup(): void {
    if (this.config.sessionTtl <= 0) {
      logger.info('Session TTL disabled (sessions live forever)');
      return;
    }

    logger.info('Session TTL cleanup enabled', {
      ttlMs: this.config.sessionTtl,
      intervalMs: this.config.sessionCleanupInterval,
    });

    this.sessionCleanupTimer = setInterval(() => {
      try {
        const expired = this.memory.expireIdleSessions(this.config.sessionTtl);
        if (expired > 0) {
          logger.info('Session cleanup completed', { expiredCount: expired });
        }
      } catch (err: any) {
        logger.error('Session cleanup error', { error: err.message });
      }
    }, this.config.sessionCleanupInterval);

    // Don't prevent Node from exiting if this is the only timer
    this.sessionCleanupTimer.unref();
  }

  // ─── Stale socket cleanup ───────────────────────────────────────────────────
  // If a client disconnects ungracefully (network drop), the socket may not fire
  // the disconnect event. This periodically checks for orphaned session owners
  // whose sockets no longer exist and cleans them up.

  private setupStaleSocketCleanup(): void {
    const CLEANUP_INTERVAL = 60_000; // Check every minute

    this.staleSocketCleanupTimer = setInterval(() => {
      const connectedSockets = new Set(
        Array.from(this.io.sockets.sockets.keys())
      );

      let cleaned = 0;
      for (const [sessionId, ownerId] of this.sessionOwners.entries()) {
        if (!connectedSockets.has(ownerId)) {
          this.sessionOwners.delete(sessionId);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.info('Stale socket cleanup completed', {
          cleanedCount: cleaned,
        });
      }
    }, CLEANUP_INTERVAL);

    this.staleSocketCleanupTimer.unref();
  }

  // ─── Timing-safe token comparison ────────────────────────────────────────
  // Prevents brute-force via timing side-channel

  private safeCompare(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) {
      // Compare against self to keep constant time, then return false
      timingSafeEqual(aBuf, aBuf);
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  }

  // ─── Auth middleware ──────────────────────────────────────────────────────

  private requireAuth = (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    const secret = this.config.apiSecret;
    if (!secret) return next(); // No secret configured → open (warn emitted at startup)

    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : req.headers['x-api-key'];

    if (!token || !this.safeCompare(String(token), secret)) {
      logger.warn('Unauthorized API request', {
        ip: req.ip,
        path: req.path,
        requestId: req.requestId,
      });
      audit.authFailure(
        req.ip,
        req.path,
        token ? 'Invalid token' : 'Missing token'
      );
      res
        .status(401)
        .json({
          error:
            'Unauthorized. Provide Authorization: Bearer <AGENT_API_SECRET>',
        });
      return;
    }
    next();
  };

  // ─── Middleware ───────────────────────────────────────────────────────────

  private setupMiddleware(): void {
    // ── Correlation ID (X-Request-ID) ───────────────────────────────────────
    // Assigns a unique ID to each request for distributed tracing.
    // Uses existing X-Request-ID header if present (from load balancer/proxy),
    // otherwise generates a new UUID. ID is included in response headers and logs.
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const requestId = (req.headers['x-request-id'] as string) || uuidv4();
      req.requestId = requestId;
      res.setHeader('X-Request-ID', requestId);
      next();
    });

    this.app.use(express.json({ limit: '10mb' }));

    // Custom morgan token for request ID
    morgan.token('request-id', (req: Request) => req.requestId || '-');

    this.app.use(
      morgan(
        ':method :url :status :res[content-length] - :response-time ms [:request-id]',
        {
          stream: { write: (msg) => logger.http(msg.trim()) },
        }
      )
    );

    // ── Security headers (CSP) ─────────────────────────────────────────────
    // Prevents XSS by restricting script/style sources.
    // Tool outputs may contain untrusted content that could be reflected.
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'", // Allow inline styles for dynamic UI
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self' ws: wss:", // Allow WebSocket connections
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });

    // ── Request tracking for graceful shutdown ──────────────────────────
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (this.isShuttingDown) {
        res.status(503).json({ error: 'Server is shutting down' });
        return;
      }
      this.activeRequests++;
      this.metrics.httpRequestsTotal++;
      const pathKey = `${req.method} ${req.path}`;
      this.metrics.httpRequestsByPath.set(
        pathKey,
        (this.metrics.httpRequestsByPath.get(pathKey) || 0) + 1
      );

      res.on('finish', () => {
        this.activeRequests--;
      });
      next();
    });

    // ── CORS — restricted to configured origin ────────────────────────────
    // Defaults to http://localhost:5173 in config. Set AGENT_CORS_ORIGIN=*
    // only for local dev with no auth. Never use * with a secret in production.
    const allowedOrigin = this.config.corsOrigin;
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin ?? '';
      if (allowedOrigin === '*' || origin === allowedOrigin) {
        res.header(
          'Access-Control-Allow-Origin',
          allowedOrigin === '*' ? '*' : origin
        );
      }
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Api-Key, X-Request-ID'
      );
      res.header('Access-Control-Expose-Headers', 'X-Request-ID');
      res.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS'
      );
      // Cache preflight requests for 24 hours to reduce OPTIONS spam
      res.header('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });

    // ── Rate limiting ─────────────────────────────────────────────────────
    // Simple in-memory token-bucket per IP. Resets every minute.
    // Prevents a misbehaving client from hammering the API even with a valid secret.
    const rateLimitWindow = 60_000; // 1 minute
    const rateLimitMax = 60; // requests per window
    const rateCounts = new Map<string, { count: number; resetAt: number }>();

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip rate limiting for health check and metrics
      if (req.path === '/health' || req.path === '/metrics') return next();

      const ip = req.ip ?? 'unknown';
      const now = Date.now();
      let entry = rateCounts.get(ip);

      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + rateLimitWindow };
        rateCounts.set(ip, entry);
      }

      entry.count++;

      res.header('X-RateLimit-Limit', String(rateLimitMax));
      res.header(
        'X-RateLimit-Remaining',
        String(Math.max(0, rateLimitMax - entry.count))
      );
      res.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

      if (entry.count > rateLimitMax) {
        logger.warn('Rate limit exceeded', {
          ip,
          count: entry.count,
          requestId: req.requestId,
        });
        audit.rateLimitExceeded(ip, 'http', entry.count);
        res.status(429).json({
          error: `Rate limit exceeded. Max ${rateLimitMax} requests per minute.`,
          requestId: req.requestId,
        });
        return;
      }

      // Periodically prune stale entries to avoid unbounded Map growth
      if (rateCounts.size > 10_000) {
        for (const [key, val] of rateCounts) {
          if (now > val.resetAt) rateCounts.delete(key);
        }
      }

      next();
    });
  }

  // ─── Routes ──────────────────────────────────────────────────────────────

  private setupRoutes(): void {
    // Health check — unauthenticated (used by Docker healthcheck)
    this.app.get('/health', async (_req, res) => {
      const total = this.memory.getTotalTokenUsage();

      // Deep health checks
      let dbStatus = 'ok';
      let dockerStatus = 'ok';

      try {
        // Verify database is accessible
        this.memory.countMessages('__health_check__');
      } catch (err: any) {
        dbStatus = `error: ${err.message}`;
      }

      if (this.config.dockerEnabled) {
        try {
          const sandbox = new DockerSandbox();
          await sandbox.initialize();
        } catch (err: any) {
          dockerStatus = `error: ${err.message}`;
        }
      } else {
        dockerStatus = 'disabled';
      }

      const healthy =
        dbStatus === 'ok' &&
        (dockerStatus === 'ok' || dockerStatus === 'disabled');

      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        activeSessions: this.agent.activeSessionCount,
        maxConcurrentSessions: this.config.maxConcurrentSessions,
        tokenBudget: this.config.tokenBudget,
        totalTokensUsed: total.totalTokens,
        estimatedCostUsd: total.estimatedCostUsd.toFixed(4),
        checks: {
          database: dbStatus,
          docker: dockerStatus,
        },
      });
    });

    // Prometheus metrics endpoint — unauthenticated for scraping
    if (this.config.metricsEnabled) {
      this.app.get('/metrics', (_req, res) => {
        const lines: string[] = [];

        // HTTP metrics
        lines.push(`# HELP agent_http_requests_total Total HTTP requests`);
        lines.push(`# TYPE agent_http_requests_total counter`);
        lines.push(
          `agent_http_requests_total ${this.metrics.httpRequestsTotal}`
        );

        lines.push(`# HELP agent_http_requests_by_path HTTP requests by path`);
        lines.push(`# TYPE agent_http_requests_by_path counter`);
        for (const [path, count] of this.metrics.httpRequestsByPath) {
          lines.push(
            `agent_http_requests_by_path{path="${path.replace(/"/g, '\\"')}"} ${count}`
          );
        }

        // WebSocket metrics
        lines.push(`# HELP agent_ws_events_total Total WebSocket events`);
        lines.push(`# TYPE agent_ws_events_total counter`);
        lines.push(`agent_ws_events_total ${this.metrics.wsEventsTotal}`);

        lines.push(`# HELP agent_ws_events_by_type WebSocket events by type`);
        lines.push(`# TYPE agent_ws_events_by_type counter`);
        for (const [type, count] of this.metrics.wsEventsByType) {
          lines.push(`agent_ws_events_by_type{type="${type}"} ${count}`);
        }

        // Tool metrics
        lines.push(`# HELP agent_tool_calls_total Total tool calls`);
        lines.push(`# TYPE agent_tool_calls_total counter`);
        lines.push(`agent_tool_calls_total ${this.metrics.toolCallsTotal}`);

        lines.push(`# HELP agent_tool_calls_by_name Tool calls by name`);
        lines.push(`# TYPE agent_tool_calls_by_name counter`);
        for (const [name, count] of this.metrics.toolCallsByName) {
          lines.push(`agent_tool_calls_by_name{name="${name}"} ${count}`);
        }

        lines.push(
          `# HELP agent_tool_call_errors_total Total tool call errors`
        );
        lines.push(`# TYPE agent_tool_call_errors_total counter`);
        lines.push(
          `agent_tool_call_errors_total ${this.metrics.toolCallErrors}`
        );

        // Token metrics
        lines.push(`# HELP agent_tokens_used_total Total tokens used`);
        lines.push(`# TYPE agent_tokens_used_total counter`);
        lines.push(`agent_tokens_used_total ${this.metrics.tokensUsedTotal}`);

        // Session metrics
        lines.push(
          `# HELP agent_sessions_started_total Total sessions started`
        );
        lines.push(`# TYPE agent_sessions_started_total counter`);
        lines.push(
          `agent_sessions_started_total ${this.metrics.sessionsStarted}`
        );

        lines.push(
          `# HELP agent_sessions_completed_total Total sessions completed`
        );
        lines.push(`# TYPE agent_sessions_completed_total counter`);
        lines.push(
          `agent_sessions_completed_total ${this.metrics.sessionsCompleted}`
        );

        lines.push(`# HELP agent_sessions_failed_total Total sessions failed`);
        lines.push(`# TYPE agent_sessions_failed_total counter`);
        lines.push(
          `agent_sessions_failed_total ${this.metrics.sessionsFailed}`
        );

        lines.push(`# HELP agent_active_sessions Current active sessions`);
        lines.push(`# TYPE agent_active_sessions gauge`);
        lines.push(`agent_active_sessions ${this.agent.activeSessionCount}`);

        lines.push(
          `# HELP agent_active_connections Current WebSocket connections`
        );
        lines.push(`# TYPE agent_active_connections gauge`);
        lines.push(
          `agent_active_connections ${this.metrics.activeConnections}`
        );

        res.set('Content-Type', 'text/plain; version=0.0.4');
        res.send(lines.join('\n') + '\n');
      });
    }

    // All other routes require auth
    this.app.use('/api', this.requireAuth);

    // ── Run prompt ────────────────────────────────────────────────────────
    this.app.post('/api/prompt', async (req: Request, res: Response) => {
      const { message, sessionId, model, planningModel, codingModel } = req.body;

      if (!message || typeof message !== 'string') {
        return res
          .status(400)
          .json({ error: 'message is required', requestId: req.requestId });
      }

      // Prompt size guard — catch oversized payloads before they reach the API
      if (message.length > this.config.maxPromptChars) {
        return res.status(400).json({
          error:
            `Prompt too large: ${message.length.toLocaleString()} characters ` +
            `(limit: ${this.config.maxPromptChars.toLocaleString()}).`,
          requestId: req.requestId,
        });
      }

      // Concurrent session guard — return 429 so the UI can handle it gracefully
      if (this.agent.activeSessionCount >= this.config.maxConcurrentSessions) {
        return res.status(429).json({
          error:
            `Too many concurrent sessions ` +
            `(${this.agent.activeSessionCount}/${this.config.maxConcurrentSessions}). ` +
            `Wait for a running session to complete or cancel one.`,
          requestId: req.requestId,
        });
      }

      const sid = sessionId ?? uuidv4();
      logger.info('HTTP prompt received', {
        sessionId: sid,
        messageLength: message.length,
        model: model || 'default',
        requestId: req.requestId,
      });
      try {
        const result = await this.agent.run(
          message,
          sid,
          (event: AgentEvent) => {
            this.io.to(sid).emit('agent_event', event);
          },
          { model, planningModel, codingModel }
        );
        return res.json({ requestId: req.requestId, ...result });
      } catch (err: any) {
        logger.error('HTTP prompt error', {
          error: err.message,
          sessionId: sid,
          requestId: req.requestId,
        });
        return res
          .status(500)
          .json({ error: err.message, requestId: req.requestId });
      }
    });

    // ── Cancel running session ─────────────────────────────────────────────
    this.app.post('/api/sessions/:id/cancel', (req: Request, res: Response) => {
      const id = getParam(req, 'id');
      const cancelled = this.agent.cancel(id);
      logger.info('Cancel request', {
        sessionId: id,
        cancelled,
        requestId: req.requestId,
      });
      if (cancelled) {
        this.io.to(id).emit('agent_event', {
          type: 'error',
          data: { error: 'Cancelled by user', sessionId: id },
          timestamp: new Date(),
        });
      }
      res.json({ success: cancelled, sessionId: id, requestId: req.requestId });
    });

    // ── Sessions list + search ────────────────────────────────────────────
    this.app.get('/api/sessions', (req: Request, res: Response) => {
      try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const sessions = q
          ? this.memory.searchSessions(q, 30)
          : this.memory.listSessions(30);

        const enriched = sessions.map((s) => ({
          ...s,
          tokenUsage: this.memory.getSessionTokenUsage(s.id),
        }));
        res.json({ sessions: enriched, query: q || null });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Single session detail ─────────────────────────────────────────────
    this.app.get('/api/sessions/:id', (req: Request, res: Response) => {
      const session = this.memory.getSession(getParam(req, 'id'));
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const messages = this.memory.getMessages(getParam(req, 'id'), 200);
      const tokenUsage = this.memory.getSessionTokenUsage(getParam(req, 'id'));
      const toolStats = this.memory.getToolCallStats(getParam(req, 'id'));
      res.json({ session, messages, tokenUsage, toolStats });
    });

    // ── Delete session ────────────────────────────────────────────────────
    this.app.delete('/api/sessions/:id', (req: Request, res: Response) => {
      const sessionId = getParam(req, 'id');
      const session = this.memory.getSession(sessionId);
      if (!session) {
        audit.sessionDelete(req.ip, sessionId, false, 'Session not found');
        return res
          .status(404)
          .json({ error: 'Session not found', requestId: req.requestId });
      }
      this.memory.deleteSession(sessionId);
      // Also clean up orphaned context summary
      this.memory.deleteKnowledge(`ctx_summary_${sessionId}`);
      logger.info('Session deleted via API', {
        sessionId,
        requestId: req.requestId,
      });
      audit.sessionDelete(req.ip, sessionId, true);
      res.json({ success: true, sessionId, requestId: req.requestId });
    });

    // ── Rename session ─────────────────────────────────────────────────────
    this.app.put('/api/sessions/:id/rename', (req: Request, res: Response) => {
      const session = this.memory.getSession(getParam(req, 'id'));
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { name } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name is required' });
      }

      this.memory.updateSessionSummary(
        getParam(req, 'id'),
        name.trim().slice(0, 200)
      );
      logger.info('Session renamed via API', {
        sessionId: getParam(req, 'id'),
        name: name.trim(),
      });
      res.json({
        success: true,
        sessionId: getParam(req, 'id'),
        name: name.trim(),
      });
    });

    // ── Toggle session pin ──────────────────────────────────────────────────
    this.app.post('/api/sessions/:id/pin', (req: Request, res: Response) => {
      const session = this.memory.getSession(getParam(req, 'id'));
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const pinned = this.memory.toggleSessionPin(getParam(req, 'id'));
      res.json({ success: true, sessionId: getParam(req, 'id'), pinned });
    });

    // ── Set session tags ────────────────────────────────────────────────────
    this.app.put('/api/sessions/:id/tags', (req: Request, res: Response) => {
      const session = this.memory.getSession(getParam(req, 'id'));
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { tags } = req.body;
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: 'tags must be an array' });
      }

      this.memory.setSessionTags(getParam(req, 'id'), tags.map(String));
      const updated = this.memory.getSession(getParam(req, 'id'));
      res.json({
        success: true,
        sessionId: getParam(req, 'id'),
        tags: updated?.tags ?? [],
      });
    });

    // ── Export session to Markdown/JSON ────────────────────────────────────
    this.app.get('/api/sessions/:id/export', (req: Request, res: Response) => {
      const sessionId = getParam(req, 'id');
      const session = this.memory.getSession(sessionId);
      if (!session) {
        audit.sessionExport(req.ip, sessionId, 'unknown', false);
        return res
          .status(404)
          .json({ error: 'Session not found', requestId: req.requestId });
      }

      const format = req.query.format === 'json' ? 'json' : 'markdown';
      const messages = this.memory.getMessages(sessionId, 1000);
      const tokenUsage = this.memory.getSessionTokenUsage(sessionId);
      const toolCalls = this.memory.getToolCallStats(sessionId);

      // Audit log the export
      audit.sessionExport(req.ip, sessionId, format, true);

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="session-${sessionId.slice(0, 8)}.json"`
        );
        return res.json({
          session,
          messages,
          tokenUsage,
          toolCalls,
          exportedAt: new Date().toISOString(),
        });
      }

      // Markdown format
      const lines: string[] = [
        `# AI Agent Session`,
        ``,
        `**Session ID:** ${session.id}`,
        `**Workspace:** ${session.workspaceDir}`,
        `**Created:** ${session.createdAt}`,
        `**Updated:** ${session.updatedAt}`,
        ``,
        `## Summary`,
        ``,
        session.summary || '_No summary available_',
        ``,
        `## Token Usage`,
        ``,
        `- Input tokens: ${tokenUsage.inputTokens.toLocaleString()}`,
        `- Output tokens: ${tokenUsage.outputTokens.toLocaleString()}`,
        `- Total tokens: ${tokenUsage.totalTokens.toLocaleString()}`,
        `- Estimated cost: $${tokenUsage.estimatedCostUsd.toFixed(4)}`,
        ``,
        `## Conversation`,
        ``,
      ];

      for (const msg of messages) {
        if (msg.role === 'user') {
          lines.push(`### 👤 User`);
          lines.push(``);
          lines.push(msg.content);
          lines.push(``);
        } else if (msg.role === 'assistant') {
          lines.push(`### 🤖 Assistant`);
          lines.push(``);
          lines.push(msg.content);
          lines.push(``);
        } else if (msg.role === 'tool') {
          lines.push(`### 🔧 Tool: ${msg.toolName || 'unknown'}`);
          lines.push(``);
          lines.push('```json');
          lines.push(
            msg.content.slice(0, 500) + (msg.content.length > 500 ? '...' : '')
          );
          lines.push('```');
          lines.push(``);
        }
      }

      lines.push(`---`);
      lines.push(`_Exported at ${new Date().toISOString()}_`);

      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="session-${sessionId.slice(0, 8)}.md"`
      );
      res.send(lines.join('\n'));
    });

    // ── Git rollback (undo uncommitted changes) ────────────────────────────
    this.app.post(
      '/api/workspace/rollback',
      async (req: Request, res: Response) => {
        try {
          const { GitTool } = await import('../tools/GitTool');
          const git = new GitTool(this.config.workspaceDir);
          await git.rollbackToLastCheckpoint();
          logger.info('Workspace rolled back to last checkpoint', {
            requestId: req.requestId,
          });
          audit.workspaceRollback(req.ip, undefined, true);
          res.json({
            success: true,
            message: 'Rolled back to last checkpoint',
            requestId: req.requestId,
          });
        } catch (err: any) {
          logger.error('Rollback failed', {
            error: err.message,
            requestId: req.requestId,
          });
          audit.workspaceRollback(req.ip, undefined, false, err.message);
          res
            .status(500)
            .json({ error: err.message, requestId: req.requestId });
        }
      }
    );

    // ── Read workspace file content ───────────────────────────────────────
    this.app.get('/api/workspace/file', async (req: Request, res: Response) => {
      try {
        const filePath =
          typeof req.query.path === 'string' ? req.query.path : '';
        if (!filePath)
          return res
            .status(400)
            .json({
              error: 'path query parameter is required',
              requestId: req.requestId,
            });

        const workspace = this.config.workspaceDir;
        const sanitized = filePath.replace(/^[/\\]+/, '');
        const resolved = path.resolve(workspace, sanitized);
        const workspacePrefix = workspace.endsWith(path.sep)
          ? workspace
          : workspace + path.sep;

        if (resolved !== workspace && !resolved.startsWith(workspacePrefix)) {
          return res
            .status(403)
            .json({
              error: 'Path outside workspace',
              requestId: req.requestId,
            });
        }

        if (!(await fs.pathExists(resolved))) {
          return res
            .status(404)
            .json({ error: 'File not found', requestId: req.requestId });
        }

        const stat = await fs.stat(resolved);
        if (stat.size > 5 * 1024 * 1024) {
          return res
            .status(413)
            .json({
              error: 'File too large (max 5MB)',
              requestId: req.requestId,
            });
        }
        if (stat.isDirectory()) {
          return res
            .status(400)
            .json({ error: 'Path is a directory', requestId: req.requestId });
        }

        const content = await fs.readFile(resolved, 'utf8');
        res.json({
          content,
          size: stat.size,
          path: sanitized,
          requestId: req.requestId,
        });
      } catch (err: any) {
        logger.error('File read error', {
          error: err.message,
          requestId: req.requestId,
        });
        res.status(500).json({ error: err.message, requestId: req.requestId });
      }
    });

    // ── Workspace file tree ───────────────────────────────────────────────
    this.app.get('/api/workspace/tree', async (req: Request, res: Response) => {
      try {
        const workspace = this.config.workspaceDir;
        const now = Date.now();

        // Check if cache is still valid
        if (
          this.workspaceTreeCache &&
          now - this.workspaceTreeCache.timestamp < this.TREE_CACHE_TTL
        ) {
          // Check If-None-Match header for conditional request
          const clientEtag = req.headers['if-none-match'];
          if (clientEtag === this.workspaceTreeCache.etag) {
            res.status(304).end();
            return;
          }
          res.setHeader('ETag', this.workspaceTreeCache.etag);
          res.setHeader('Cache-Control', 'private, max-age=5');
          res.json(this.workspaceTreeCache.data);
          return;
        }

        // Generate fresh tree
        const files = await fg('**/*', {
          cwd: workspace,
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/.next/**',
            '**/coverage/**',
          ],
          onlyFiles: false,
          markDirectories: true,
          dot: false,
        });

        const tree = await buildFileTree(files, workspace);
        const data = { tree, workspace };

        // Generate ETag from sorted file list
        const etag = `"${createHash('md5').update(JSON.stringify(files.sort())).digest('hex')}"`;

        // Update cache
        this.workspaceTreeCache = { etag, data, timestamp: now };

        // Check If-None-Match header
        const clientEtag = req.headers['if-none-match'];
        if (clientEtag === etag) {
          res.status(304).end();
          return;
        }

        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=5');
        res.json(data);
      } catch (err: any) {
        logger.error('Workspace tree error', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    // ── Token usage summary ───────────────────────────────────────────────
    this.app.get('/api/usage', (_req, res) => {
      const total = this.memory.getTotalTokenUsage();
      res.json({ total });
    });

    // ── Global error handler ───────────────────────────────────────────────
    this.app.use(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        logger.error('Unhandled server error', {
          error: err.message,
          stack: err.stack,
        });
        res.status(500).json({ error: 'Internal server error' });
      }
    );
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  private checkSocketRateLimit(socketId: string): boolean {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const maxEvents = this.config.wsRateLimit;

    let entry = this.socketRateLimits.get(socketId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      this.socketRateLimits.set(socketId, entry);
    }

    entry.count++;

    // Prune old entries periodically
    if (this.socketRateLimits.size > 10_000) {
      for (const [key, val] of this.socketRateLimits) {
        if (now > val.resetAt) this.socketRateLimits.delete(key);
      }
    }

    return entry.count <= maxEvents;
  }

  private trackWsEvent(eventType: string): void {
    this.metrics.wsEventsTotal++;
    this.metrics.wsEventsByType.set(
      eventType,
      (this.metrics.wsEventsByType.get(eventType) || 0) + 1
    );
  }

  private setupWebSocket(): void {
    // Socket auth middleware — timing-safe comparison
    this.io.use((socket, next) => {
      const secret = this.config.apiSecret;
      if (!secret) return next();
      const token =
        socket.handshake.auth?.token ?? socket.handshake.headers?.['x-api-key'];
      if (!token || !this.safeCompare(String(token), secret)) {
        logger.warn('Unauthorized WebSocket connection', {
          socketId: socket.id,
        });
        return next(new Error('Unauthorized'));
      }
      next();
    });

    this.io.on('connection', (socket) => {
      logger.info('WebSocket client connected', { socketId: socket.id });
      this.metrics.activeConnections++;

      // Rate limit wrapper for all events
      const rateLimitedHandler = <T>(
        eventName: string,
        handler: (data: T) => void | Promise<void>
      ) => {
        return async (data: T) => {
          this.trackWsEvent(eventName);

          if (!this.checkSocketRateLimit(socket.id)) {
            logger.warn('WebSocket rate limit exceeded', {
              socketId: socket.id,
              event: eventName,
            });
            socket.emit('error_event', {
              error: `Rate limit exceeded. Max ${this.config.wsRateLimit} events per minute.`,
              code: 'RATE_LIMITED',
            });
            return;
          }

          try {
            await handler(data);
          } catch (err: any) {
            logger.error('WebSocket handler error', {
              event: eventName,
              error: err.message,
            });
          }
        };
      };

      socket.on(
        'join_session',
        rateLimitedHandler('join_session', (sessionId: string) => {
          // Validate session ID format (UUID)
          if (
            typeof sessionId !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(sessionId)
          ) {
            socket.emit('error_event', { error: 'Invalid session ID format' });
            return;
          }

          // Track session ownership — first socket to create or join owns it
          const owner = this.sessionOwners.get(sessionId);
          if (owner && owner !== socket.id) {
            // Allow join if the session exists (user may have reconnected with new socket)
            const session = this.memory.getSession(sessionId);
            if (!session) {
              socket.emit('error_event', { error: 'Session not found' });
              return;
            }
          }

          if (!owner) {
            this.sessionOwners.set(sessionId, socket.id);
          }

          socket.join(sessionId);
          logger.debug('Client joined session', {
            socketId: socket.id,
            sessionId,
          });
          socket.emit('joined', { sessionId });
        })
      );

      socket.on(
        'prompt',
        rateLimitedHandler(
          'prompt',
          async (data: {
            message: string;
            sessionId?: string;
            model?: string;
            planningModel?: string;
            codingModel?: string;
          }) => {
            const sid = data.sessionId ?? uuidv4();
            socket.join(sid);
            logger.info('WebSocket prompt', {
              socketId: socket.id,
              sessionId: sid,
              model: data.model || 'default',
            });
            this.metrics.sessionsStarted++;

            // Size guard
            if (
              !data.message ||
              data.message.length > this.config.maxPromptChars
            ) {
              socket.emit('agent_event', {
                type: 'error',
                data: {
                  error: `Prompt too large or empty (limit: ${this.config.maxPromptChars.toLocaleString()} chars).`,
                },
                timestamp: new Date(),
              });
              this.metrics.sessionsFailed++;
              return;
            }

            // Concurrent session guard
            if (
              this.agent.activeSessionCount >= this.config.maxConcurrentSessions
            ) {
              socket.emit('agent_event', {
                type: 'error',
                data: {
                  error:
                    `Too many concurrent sessions ` +
                    `(${this.agent.activeSessionCount}/${this.config.maxConcurrentSessions}). ` +
                    `Wait for a running session to complete or cancel one.`,
                },
                timestamp: new Date(),
              });
              this.metrics.sessionsFailed++;
              return;
            }

            try {
              const result = await this.agent.run(
                data.message,
                sid,
                (event: AgentEvent) => {
                  this.io.to(sid).emit('agent_event', event);

                  // Track tool call metrics
                  if (event.type === 'tool_call') {
                    const toolData = event.data as any;
                    this.metrics.toolCallsTotal++;
                    this.metrics.toolCallsByName.set(
                      toolData.name,
                      (this.metrics.toolCallsByName.get(toolData.name) || 0) + 1
                    );
                  }
                  if (event.type === 'tool_result') {
                    const resultData = event.data as any;
                    if (!resultData.success) this.metrics.toolCallErrors++;
                  }
                },
                { model: data.model, planningModel: data.planningModel, codingModel: data.codingModel }
              );

              // Track token usage
              if (result.tokenUsage) {
                this.metrics.tokensUsedTotal +=
                  result.tokenUsage.inputTokens +
                  result.tokenUsage.outputTokens;
              }

              this.metrics.sessionsCompleted++;
              socket.emit('prompt_complete', { ...result });

              // Send webhook notification if configured
              await this.sendWebhook('session_complete', {
                sessionId: sid,
                result,
              });
            } catch (err: any) {
              logger.error('WebSocket prompt error', {
                error: err.message,
                sessionId: sid,
              });
              this.metrics.sessionsFailed++;
              socket.emit('agent_event', {
                type: 'error',
                data: { error: err.message, sessionId: sid },
                timestamp: new Date(),
              });

              // Send webhook notification for failure
              await this.sendWebhook('session_failed', {
                sessionId: sid,
                error: err.message,
              });
            }
          }
        )
      );

      socket.on(
        'cancel',
        rateLimitedHandler('cancel', (sessionId: string) => {
          const cancelled = this.agent.cancel(sessionId);
          socket.emit('cancel_result', { cancelled, sessionId });
          logger.info('WebSocket cancel', {
            socketId: socket.id,
            sessionId,
            cancelled,
          });
        })
      );

      // Patch approval response handler
      socket.on(
        'patch_approval_response',
        rateLimitedHandler(
          'patch_approval_response',
          (data: { approved: boolean; patchId: string }) => {
            logger.info('Patch approval response', {
              socketId: socket.id,
              patchId: data.patchId,
              approved: data.approved,
            });
            // The approval is stored in the agent's pending approvals map
            this.agent.resolvePatchApproval(data.patchId, data.approved);
          }
        )
      );

      socket.on('disconnect', () => {
        // Clean up session ownership for this socket
        for (const [sid, owner] of this.sessionOwners.entries()) {
          if (owner === socket.id) this.sessionOwners.delete(sid);
        }
        // Clean up rate limit tracking
        this.socketRateLimits.delete(socket.id);
        this.metrics.activeConnections--;
        logger.info('WebSocket client disconnected', { socketId: socket.id });
      });
    });
  }

  // ─── Webhook notifications ──────────────────────────────────────────────────

  private async sendWebhook(event: string, data: any): Promise<void> {
    if (!this.config.webhookUrl) return;

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      if (!response.ok) {
        logger.warn('Webhook delivery failed', {
          status: response.status,
          event,
        });
      }
    } catch (err: any) {
      logger.error('Webhook error', { error: err.message, event });
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        logger.info(`AgentServer listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    logger.info('Initiating graceful shutdown', {
      timeout: this.config.shutdownTimeout,
    });
    this.isShuttingDown = true;

    // Stop session cleanup timer
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }

    // Stop stale socket cleanup timer
    if (this.staleSocketCleanupTimer) {
      clearInterval(this.staleSocketCleanupTimer);
      this.staleSocketCleanupTimer = null;
    }

    // Notify all connected clients
    this.io.emit('server_shutdown', { message: 'Server is shutting down' });

    return new Promise((resolve, reject) => {
      const forceShutdownTimer = setTimeout(() => {
        logger.warn('Graceful shutdown timeout exceeded, forcing shutdown', {
          activeRequests: this.activeRequests,
          activeSessions: this.agent.activeSessionCount,
        });
        this.io.close();
        this.httpServer.close();
        resolve();
      }, this.config.shutdownTimeout);

      // Wait for active requests to complete
      const checkComplete = setInterval(() => {
        if (this.activeRequests === 0 && this.agent.activeSessionCount === 0) {
          clearInterval(checkComplete);
          clearTimeout(forceShutdownTimer);

          logger.info('All requests completed, closing server');
          this.io.close();
          this.httpServer.close((err) => {
            if (err) {
              logger.error('Error closing server', { error: err.message });
              reject(err);
            } else {
              logger.info('Server closed gracefully');
              resolve();
            }
          });
        }
      }, 100);
    });
  }
}

// ─── File tree builder ────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  size?: number;
}

async function buildFileTree(
  paths: string[],
  workspace: string
): Promise<TreeNode[]> {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const sortedPaths = [...paths].sort();

  // Pre-compute file sizes with bounded concurrency to avoid thousands of
  // simultaneous stat syscalls overwhelming the event loop / filesystem.
  const STAT_CONCURRENCY = 50;
  const fileSizes = new Map<string, number>();
  const filePaths = sortedPaths.filter((p) => !p.endsWith('/'));

  for (let i = 0; i < filePaths.length; i += STAT_CONCURRENCY) {
    const batch = filePaths.slice(i, i + STAT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (fp) => {
        const stat = await fs.stat(path.join(workspace, fp));
        return { path: fp, size: stat.size };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') fileSizes.set(r.value.path, r.value.size);
    }
  }

  for (const filePath of sortedPaths) {
    const isDir = filePath.endsWith('/');
    const cleanPath = isDir ? filePath.slice(0, -1) : filePath;
    const parts = cleanPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');

    const size = isDir ? undefined : fileSizes.get(cleanPath);

    const node: TreeNode = {
      name,
      path: cleanPath,
      type: isDir ? 'directory' : 'file',
      ...(isDir ? { children: [] } : {}),
      ...(size !== undefined ? { size } : {}),
    };

    if (isDir) dirMap.set(cleanPath, node);

    const parent = parentPath ? dirMap.get(parentPath) : null;
    if (parent?.children) {
      parent.children.push(node);
    } else if (!parentPath) {
      root.push(node);
    }
  }

  return root;
}
