import request from 'supertest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { AgentServer } from '../../server/AgentServer';
import { Agent } from '../../agent/Agent';
import { DatabaseMemory } from '../../memory/DatabaseMemory';
import type { Config } from '../../config';

// Mock the Agent to avoid calling real Claude API
jest.mock('../../agent/Agent');

describe('AgentServer - Integration Tests', () => {
  let server: AgentServer;
  let mockAgent: jest.Mocked<Agent>;
  let dbPath: string;
  let memory: DatabaseMemory;
  let config: Config;

  const testPort = 3099;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `server-test-${Date.now()}.db`);
    memory = new DatabaseMemory(dbPath);
    await memory.initialize();

    config = {
      apiKey: 'test',
      workspaceDir: os.tmpdir(),
      hostWorkspaceDir: os.tmpdir(),
      dbPath,
      logDir: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      maxRetries: 3,
      maxContextMessages: 30,
      dockerEnabled: false,
      port: testPort,
      // Required Config properties
      trustProxy: false,
      maxPromptChars: 100_000,
      maxConcurrentSessions: 5,
      tokenBudget: 100_000,
      tokenBudgetTier1: 0,
      tokenBudgetTier2: 0,
      tokenBudgetTier3: 0,
      maxToolCalls: 50,
      corsOrigin: '*',
      maxSearchResults: 500,
      wsRateLimit: 30,
      shutdownTimeout: 30_000,
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
    };

    mockAgent = new Agent(config, memory) as jest.Mocked<Agent>;
    (mockAgent.run as jest.Mock).mockResolvedValue({
      sessionId: 'test-session',
      summary: 'Task completed successfully',
      toolCallsCount: 3,
      success: true,
      durationMs: 1500,
    });

    // AgentServer constructor expects: (agent, memory, config, port)
    server = new AgentServer(
      mockAgent as unknown as Agent,
      memory,
      config,
      testPort
    );
    await server.start();
  });

  afterAll(async () => {
    try {
      await Promise.race([
        server.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stop timeout')), 5000)
        ),
      ]);
    } catch {
      // Server may already be stopped or timeout - ignore
    }
    try {
      memory.close();
    } catch {
      // Ignore close errors
    }
    await fs.remove(dbPath);
  }, 10000); // 10 second timeout for afterAll

  beforeEach(() => {
    // Clear mock calls between tests
    jest.clearAllMocks();
    (mockAgent.run as jest.Mock).mockResolvedValue({
      sessionId: 'test-session',
      summary: 'Task completed successfully',
      toolCallsCount: 3,
      success: true,
      durationMs: 1500,
    });
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(`http://localhost:${testPort}`).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /api/prompt', () => {
    it('should return 400 when message is missing', async () => {
      const res = await request(`http://localhost:${testPort}`)
        .post('/api/prompt')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 for non-string message', async () => {
      const res = await request(`http://localhost:${testPort}`)
        .post('/api/prompt')
        .send({ message: 123 });

      expect(res.status).toBe(400);
    });

    it('should return 200 with agent result for valid message', async () => {
      const res = await request(`http://localhost:${testPort}`)
        .post('/api/prompt')
        .send({ message: 'Build a hello world component' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBe('Task completed successfully');
      expect(res.body.toolCallsCount).toBe(3);
    });

    it('should accept optional sessionId', async () => {
      const res = await request(`http://localhost:${testPort}`)
        .post('/api/prompt')
        .send({ message: 'test', sessionId: 'my-session-123' });

      expect(res.status).toBe(200);
      expect(mockAgent.run).toHaveBeenCalledWith(
        'test',
        'my-session-123',
        expect.any(Function),
        { model: undefined }
      );
    });
  });

  describe('GET /api/sessions', () => {
    it('should return sessions array', async () => {
      const res = await request(`http://localhost:${testPort}`).get(
        '/api/sessions'
      );

      expect(res.status).toBe(200);
      expect(res.body.sessions).toBeDefined();
      expect(Array.isArray(res.body.sessions)).toBe(true);
    });
  });
});
