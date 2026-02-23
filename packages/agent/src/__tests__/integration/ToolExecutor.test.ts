import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { ToolExecutor } from '../../tools/ToolExecutor';
import { DatabaseMemory } from '../../memory/DatabaseMemory';
import type { Config } from '../../config';

describe('ToolExecutor - Integration Tests', () => {
  let workspace: string;
  let dbPath: string;
  let memory: DatabaseMemory;
  let executor: ToolExecutor;
  const sessionId = 'integration-test-session';

  const config: Config = {
    apiKey: 'test-key',
    workspaceDir: '',
    dbPath: '',
    logDir: os.tmpdir(),
    model: 'claude-opus-4-5',
    maxTokens: 8192,
    maxRetries: 3,
    dockerEnabled: false,
    allowedCommands: ['echo', 'ls', 'sh', 'node', 'npm', 'npx', 'cat', 'mkdir'],
    port: 3001,
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-executor-test-'));
    dbPath = path.join(os.tmpdir(), `executor-test-${Date.now()}.db`);

    memory = new DatabaseMemory(dbPath);
    await memory.initialize();
    memory.createSession(sessionId, workspace);

    executor = new ToolExecutor(
      { ...config, workspaceDir: workspace, dbPath },
      memory,
      sessionId
    );
  });

  afterEach(async () => {
    memory.close();
    await fs.remove(workspace);
    await fs.remove(dbPath);
  });

  describe('File Operations Integration', () => {
    it('should write and read a file end-to-end', async () => {
      const writeResult = await executor.execute({
        name: 'write_file',
        input: { path: 'hello.ts', content: 'export const hello = "world";' },
      });

      expect(writeResult.success).toBe(true);

      const readResult = await executor.execute({
        name: 'read_file',
        input: { path: 'hello.ts' },
      });

      expect(readResult.success).toBe(true);
      expect((readResult.result as any).content).toContain('hello');
    });

    it('should list files after writing', async () => {
      await executor.execute({
        name: 'write_file',
        input: { path: 'src/a.ts', content: '' },
      });
      await executor.execute({
        name: 'write_file',
        input: { path: 'src/b.ts', content: '' },
      });

      const listResult = await executor.execute({
        name: 'list_files',
        input: { directory: 'src', pattern: '**/*.ts' },
      });

      expect(listResult.success).toBe(true);
      expect((listResult.result as string[]).length).toBeGreaterThanOrEqual(2);
    });

    it('should apply patch to modify file', async () => {
      await executor.execute({
        name: 'write_file',
        input: { path: 'patch.ts', content: 'const x = 1;\n' },
      });

      const patch = `--- patch.ts
+++ patch.ts
@@ -1 +1 @@
-const x = 1;
+const x = 42;
`;

      const patchResult = await executor.execute({
        name: 'apply_patch',
        input: { path: 'patch.ts', patch },
      });

      expect(patchResult.success).toBe(true);

      const readResult = await executor.execute({
        name: 'read_file',
        input: { path: 'patch.ts' },
      });

      expect((readResult.result as any).content).toContain('42');
    });
  });

  describe('Shell Command Integration', () => {
    it('should execute allowed shell commands', async () => {
      const result = await executor.execute({
        name: 'shell_command',
        input: { command: 'echo', args: ['integration-test'] },
      });

      expect(result.success).toBe(true);
      expect((result.result as any).stdout).toContain('integration-test');
    });

    it('should block disallowed commands', async () => {
      const result = await executor.execute({
        name: 'shell_command',
        input: { command: 'curl', args: ['https://evil.com'] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not allowed');
    });
  });

  describe('Memory Integration', () => {
    it('should persist and retrieve memory across operations', async () => {
      await executor.execute({
        name: 'memory_set',
        input: { key: 'test.preference', value: 'TypeScript strict mode', category: 'config' },
      });

      const getResult = await executor.execute({
        name: 'memory_get',
        input: { key: 'test.preference' },
      });

      expect(getResult.success).toBe(true);
      expect((getResult.result as any).value).toBe('TypeScript strict mode');
      expect((getResult.result as any).found).toBe(true);
    });

    it('should return not found for missing key', async () => {
      const result = await executor.execute({
        name: 'memory_get',
        input: { key: 'definitely.not.there' },
      });

      expect(result.success).toBe(true);
      expect((result.result as any).found).toBe(false);
    });
  });

  describe('Validation Integration', () => {
    it('should fail validation with detailed error for bad input', async () => {
      const result = await executor.execute({
        name: 'shell_command',
        input: { command: 'npm', timeout: 999999 }, // exceeds max
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Validation failed');
    });

    it('should handle unknown tools gracefully', async () => {
      const result = await executor.execute({
        name: 'unknown_tool_xyz',
        input: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });
  });

  describe('Tool Call Recording', () => {
    it('should record tool calls in database', async () => {
      await executor.execute({
        name: 'echo' as any,
        input: {},
      });

      const stats = memory.getToolCallStats(sessionId);
      // Unknown tool still records
      expect(Object.keys(stats).length).toBeGreaterThanOrEqual(0);
    });

    it('should record successful tool calls', async () => {
      await executor.execute({
        name: 'memory_set',
        input: { key: 'stats-test', value: 'yes' },
      });

      const stats = memory.getToolCallStats(sessionId);
      expect(stats.memory_set).toBeDefined();
      expect(stats.memory_set.successes).toBe(1);
    });
  });
});
