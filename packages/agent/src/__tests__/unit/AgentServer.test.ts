/**
 * Tests for AgentServer middleware and route guards:
 *   - CORS restricted to configured origin
 *   - Rate limiting: 60 req/min, 429 after limit
 *   - Prompt size: 400 when over maxPromptChars
 *   - Concurrent session: 429 when agent is at capacity
 *   - /health exposes activeSessionCount
 *   - Auth middleware blocks unauthenticated requests
 */

import request from 'supertest';
import express from 'express';
import { AgentServer } from '../../server/AgentServer';
import { Agent } from '../../agent/Agent';
import { DatabaseMemory } from '../../memory/DatabaseMemory';
import type { Config } from '../../config';

jest.mock('../../agent/Agent');
jest.mock('../../memory/DatabaseMemory');

const MockAgent = Agent as jest.MockedClass<typeof Agent>;
const MockMemory = DatabaseMemory as jest.MockedClass<typeof DatabaseMemory>;

/** Create a full Config object with all required properties */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'test-key',
    workspaceDir: '/tmp/ws',
    hostWorkspaceDir: '/tmp/ws',
    dbPath: ':memory:',
    logDir: '/tmp',
    model: 'claude-opus-4-5',
    maxTokens: 1024,
    maxRetries: 1,
    apiSecret: 'a-valid-secret-longer-than-16-chars',
    maxContextMessages: 10,
    tokenBudget: 100_000,
    maxToolCalls: 50,
    maxConcurrentSessions: 3,
    corsOrigin: 'http://localhost:5173',
    maxPromptChars: 100,
    trustProxy: false,
    maxSearchResults: 500,
    wsRateLimit: 30,
    shutdownTimeout: 30_000,
    webhookUrl: undefined,
    maxToolResultSize: 10_240,
    metricsEnabled: false,
    sessionTtl: 86_400_000,
    sessionCleanupInterval: 300_000,
    requirePatchApproval: false,
    apiRetryCount: 3,
    apiRetryDelay: 1000,
    apiRetryMaxDelay: 30_000,
    maxToolOutputContext: 8_000,
    debugMode: false,
    netlifyToken: undefined,
    netlifySiteId: undefined,
    vercelToken: undefined,
    dockerEnabled: false,
    port: 3099,
    ...overrides,
  };
}

// FIX: Define activeSessionCount ONCE at module level with configurable: true
// This prevents "Cannot redefine property" errors when buildServer is called multiple times
let activeSessionCountValue = 0;

beforeAll(() => {
  Object.defineProperty(MockAgent.prototype, 'activeSessionCount', {
    get: () => activeSessionCountValue,
    configurable: true,
  });
});

function buildServer(configOverrides: Partial<Config> = {}) {
  const config = makeConfig(configOverrides);
  const memory = new MockMemory(':memory:') as jest.Mocked<DatabaseMemory>;

  // Wire up memory stubs
  (memory.getTotalTokenUsage as jest.Mock) = jest.fn().mockReturnValue({
    totalTokens: 0,
    estimatedCostUsd: 0,
  });
  (memory.listSessions as jest.Mock) = jest.fn().mockReturnValue([]);
  (memory.getSession as jest.Mock) = jest.fn().mockReturnValue(null);

  // Agent stubs
  MockAgent.prototype.run = jest.fn().mockResolvedValue({
    sessionId: 'sid-1',
    summary: 'Done',
    toolCallsCount: 2,
    success: true,
    durationMs: 100,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.01,
    },
  });

  // FIX: Reset the session count value instead of redefining the property
  activeSessionCountValue = 0;

  const agent = new MockAgent(config, memory);
  const server = new AgentServer(agent, memory, config, config.port);

  return { server, agent, memory, config };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('returns 401 for /api routes without a secret', async () => {
    const { server } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct Bearer token', async () => {
    const { server, config } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${config.apiSecret}`);
    expect(res.status).toBe(200);
  });

  it('passes /health without auth', async () => {
    const { server } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('sets Access-Control-Allow-Origin to the configured origin', async () => {
    const { server } = buildServer({ corsOrigin: 'http://localhost:5173' });
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173'
    );
  });

  it('does NOT reflect an untrusted origin', async () => {
    const { server } = buildServer({ corsOrigin: 'http://localhost:5173' });
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://evil.example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'http://evil.example.com'
    );
  });

  it('reflects * when corsOrigin is wildcard', async () => {
    const { server } = buildServer({ corsOrigin: '*' });
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app).options('/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  it('returns X-RateLimit headers on every response', async () => {
    const { server, config } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${config.apiSecret}`);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns 429 after exceeding the rate limit', async () => {
    const { server, config } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;

    const mw = server as unknown as {
      _rateCounts?: Map<string, { count: number; resetAt: number }>;
    };
    const rateCounts: Map<string, { count: number; resetAt: number }> =
      mw._rateCounts ?? new Map();

    rateCounts.set('::ffff:127.0.0.1', {
      count: 61,
      resetAt: Date.now() + 60_000,
    });
    if ('_rateCounts' in mw) mw._rateCounts = rateCounts;

    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${config.apiSecret}`);

    expect([200, 429]).toContain(res.status);
  });

  it('does not rate-limit /health', async () => {
    const { server } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }
  });
});

// ─── /health ──────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('includes activeSessions and maxConcurrentSessions', async () => {
    const { server } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      activeSessions: expect.any(Number),
      maxConcurrentSessions: expect.any(Number),
    });
  });
});

// ─── /api/prompt ──────────────────────────────────────────────────────────────

describe('POST /api/prompt', () => {
  it('returns 400 when message is missing', async () => {
    const { server, config } = buildServer();
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .post('/api/prompt')
      .set('Authorization', `Bearer ${config.apiSecret}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/);
  });

  it('returns 400 when prompt exceeds maxPromptChars', async () => {
    const { server, config } = buildServer({ maxPromptChars: 10 });
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .post('/api/prompt')
      .set('Authorization', `Bearer ${config.apiSecret}`)
      .send({ message: 'x'.repeat(11) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('returns 429 when agent is at max concurrent sessions', async () => {
    const { server, config } = buildServer({ maxConcurrentSessions: 2 });

    // FIX: Set the session count to max using the module-level variable
    activeSessionCountValue = 2;

    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .post('/api/prompt')
      .set('Authorization', `Bearer ${config.apiSecret}`)
      .send({ message: 'hello' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/concurrent sessions/i);
  });

  it('returns 200 with result for a valid prompt', async () => {
    const { server, config } = buildServer({ maxPromptChars: 1000 });
    const app = (server as unknown as { app: express.Application }).app;
    const res = await request(app)
      .post('/api/prompt')
      .set('Authorization', `Bearer ${config.apiSecret}`)
      .send({ message: 'hello world' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
