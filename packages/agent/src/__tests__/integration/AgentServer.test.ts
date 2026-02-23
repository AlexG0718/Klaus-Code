import request from 'supertest';
import { createServer } from 'http';
import express from 'express';
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

  const testPort = 3099;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `server-test-${Date.now()}.db`);
    memory = new DatabaseMemory(dbPath);
    await memory.initialize();

    const config: Config = {
      apiKey: 'test',
      workspaceDir: os.tmpdir(),
      dbPath,
      logDir: os.tmpdir(),
      model: 'claude-opus-4-5',
      maxTokens: 8192,
      maxRetries: 3,
      dockerEnabled: false,
      allowedCommands: [],
      port: testPort,
    };

    mockAgent = new Agent(config, memory) as jest.Mocked<Agent>;
    (mockAgent.run as jest.Mock).mockResolvedValue({
      sessionId: 'test-session',
      summary: 'Task completed successfully',
      toolCallsCount: 3,
      success: true,
      durationMs: 1500,
    });

    server = new AgentServer(mockAgent as any, testPort);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    memory.close();
    await fs.remove(dbPath);
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(`http://localhost:${testPort}`)
        .get('/health');

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
        expect.any(Function)
      );
    });
  });

  describe('GET /api/sessions', () => {
    it('should return sessions array', async () => {
      const res = await request(`http://localhost:${testPort}`)
        .get('/api/sessions');

      expect(res.status).toBe(200);
      expect(res.body.sessions).toBeDefined();
      expect(Array.isArray(res.body.sessions)).toBe(true);
    });
  });
});
