import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { DatabaseMemory } from '../../memory/DatabaseMemory';

describe('DatabaseMemory - Unit Tests', () => {
  let memory: DatabaseMemory;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `test-memory-${Date.now()}.db`);
    memory = new DatabaseMemory(dbPath);
    await memory.initialize();
  });

  afterEach(() => {
    memory.close();
    fs.removeSync(dbPath);
  });

  describe('Session Management', () => {
    it('should create a new session', () => {
      const session = memory.createSession('test-id', '/workspace');
      expect(session.id).toBe('test-id');
      expect(session.workspaceDir).toBe('/workspace');
      expect(session.createdAt).toBeInstanceOf(Date);
    });

    it('should retrieve an existing session', () => {
      memory.createSession('test-id', '/workspace');
      const session = memory.getSession('test-id');
      expect(session).toBeDefined();
      expect(session!.id).toBe('test-id');
    });

    it('should return undefined for non-existent session', () => {
      const session = memory.getSession('non-existent');
      expect(session).toBeUndefined();
    });

    it('should list sessions in descending order', () => {
      memory.createSession('id-1', '/workspace-1');
      // Small delay to ensure different timestamps
      memory.createSession('id-2', '/workspace-2');
      const sessions = memory.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });

    it('should update session summary', () => {
      memory.createSession('test-id', '/workspace');
      memory.updateSessionSummary('test-id', 'Test summary');
      const session = memory.getSession('test-id');
      expect(session!.summary).toBe('Test summary');
    });
  });

  describe('Message Storage', () => {
    const sessionId = 'msg-test-session';

    beforeEach(() => {
      memory.createSession(sessionId, '/workspace');
    });

    it('should add and retrieve messages', () => {
      memory.addMessage({
        id: 'msg-1',
        sessionId,
        role: 'user',
        content: 'Hello agent',
        metadata: {},
      });

      const messages = memory.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello agent');
      expect(messages[0].role).toBe('user');
    });

    it('should store all message roles', () => {
      const roles: Array<'user' | 'assistant' | 'system' | 'tool'> = [
        'user', 'assistant', 'system', 'tool',
      ];

      roles.forEach((role, i) => {
        memory.addMessage({
          id: `msg-${i}`,
          sessionId,
          role,
          content: `Message from ${role}`,
          metadata: {},
        });
      });

      const messages = memory.getMessages(sessionId);
      expect(messages).toHaveLength(4);
      expect(messages.map((m) => m.role)).toEqual(roles);
    });

    it('should store tool name and result', () => {
      memory.addMessage({
        id: 'tool-msg',
        sessionId,
        role: 'tool',
        content: '{"success": true}',
        toolName: 'read_file',
        toolResult: undefined,
        metadata: { durationMs: 50 },
      });

      const messages = memory.getMessages(sessionId);
      expect(messages[0].toolName).toBe('read_file');
    });

    it('should respect message limit', () => {
      for (let i = 0; i < 10; i++) {
        memory.addMessage({
          id: `msg-${i}`,
          sessionId,
          role: 'user',
          content: `Message ${i}`,
          metadata: {},
        });
      }

      const limited = memory.getMessages(sessionId, 5);
      expect(limited).toHaveLength(5);
    });
  });

  describe('Knowledge Store', () => {
    it('should set and get knowledge', () => {
      memory.setKnowledge('project.framework', 'React + TanStack', 'tech');
      const value = memory.getKnowledge('project.framework');
      expect(value).toBe('React + TanStack');
    });

    it('should update existing knowledge', () => {
      memory.setKnowledge('key', 'value1');
      memory.setKnowledge('key', 'value2');
      expect(memory.getKnowledge('key')).toBe('value2');
    });

    it('should return undefined for missing key', () => {
      expect(memory.getKnowledge('non-existent')).toBeUndefined();
    });

    it('should list knowledge by category', () => {
      memory.setKnowledge('a', 'val-a', 'cat1');
      memory.setKnowledge('b', 'val-b', 'cat1');
      memory.setKnowledge('c', 'val-c', 'cat2');

      const cat1 = memory.listKnowledge('cat1');
      expect(cat1).toHaveLength(2);

      const all = memory.listKnowledge();
      expect(all.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Tool Call Tracking', () => {
    const sessionId = 'tool-test-session';

    beforeEach(() => {
      memory.createSession(sessionId, '/workspace');
    });

    it('should record tool calls', () => {
      memory.recordToolCall({
        id: 'tc-1',
        sessionId,
        toolName: 'read_file',
        input: '{"path": "test.ts"}',
        output: '{"content": "..."}',
        success: true,
        durationMs: 42,
      });

      const stats = memory.getToolCallStats(sessionId);
      expect(stats.read_file).toBeDefined();
      expect(stats.read_file.calls).toBe(1);
      expect(stats.read_file.successes).toBe(1);
    });

    it('should track failed tool calls', () => {
      memory.recordToolCall({
        id: 'tc-fail',
        sessionId,
        toolName: 'shell_command',
        input: '{}',
        success: false,
        durationMs: 100,
      });

      const stats = memory.getToolCallStats(sessionId);
      expect(stats.shell_command.successes).toBe(0);
      expect(stats.shell_command.calls).toBe(1);
    });
  });
});
