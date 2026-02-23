import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { LintTool } from '../../tools/LintTool';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function makeSpawnMock(exitCode: number, stdout = '', stderr = '') {
  const emitter = {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
  } as any;
  emitter.stdout.on.mockImplementation((ev: string, cb: Function) => { if (ev === 'data' && stdout) cb(Buffer.from(stdout)); });
  emitter.stderr.on.mockImplementation((ev: string, cb: Function) => { if (ev === 'data' && stderr) cb(Buffer.from(stderr)); });
  emitter.on.mockImplementation((ev: string, cb: Function) => { if (ev === 'close') setTimeout(() => cb(exitCode), 0); });
  return emitter;
}

describe('LintTool', () => {
  let tool: LintTool;
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-tool-test-'));
    tool = new LintTool(workspaceDir);
    mockSpawn.mockReset();
  });

  afterEach(async () => { await fs.remove(workspaceDir); });

  // ── ESLint ─────────────────────────────────────────────────────────────────

  describe('eslintCheck', () => {
    it('runs "npx eslint" with the correct args', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

      await tool.eslintCheck({ paths: ['src'], fix: false, packageDir: '.' });

      const [bin, args] = mockSpawn.mock.calls[0];
      expect(bin).toBe('npx');
      expect(args[0]).toBe('eslint');
      expect(args).toContain('src');
    });

    it('adds --fix when fix is true', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
      await tool.eslintCheck({ paths: ['src'], fix: true, packageDir: '.' });
      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('--fix');
    });

    it('does NOT add --fix when fix is false', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
      await tool.eslintCheck({ paths: ['src'], fix: false, packageDir: '.' });
      const [, args] = mockSpawn.mock.calls[0];
      expect(args).not.toContain('--fix');
    });

    it('returns success:false when ESLint finds errors', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(1, '3 errors found') as any);
      const result = await tool.eslintCheck({ paths: ['src'], fix: false, packageDir: '.' });
      expect(result.success).toBe(false);
    });

    it('blocks path traversal in paths array', async () => {
      await expect(
        tool.eslintCheck({ paths: ['../../etc/passwd'], fix: false, packageDir: '.' })
      ).rejects.toThrow('outside the workspace');
    });

    it('blocks path traversal in packageDir', async () => {
      await expect(
        tool.eslintCheck({ paths: ['src'], fix: false, packageDir: '../../etc' })
      ).rejects.toThrow('outside the workspace');
    });

    it('never uses shell:true', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
      await tool.eslintCheck({ paths: ['.'], fix: false, packageDir: '.' });
      const opts = mockSpawn.mock.calls[0][2] as any;
      expect(opts?.shell).toBeFalsy();
    });
  });

  // ── Prettier ───────────────────────────────────────────────────────────────

  describe('prettierFormat', () => {
    it('uses --write when check is false', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
      await tool.prettierFormat({ paths: ['src'], check: false, packageDir: '.' });
      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('--write');
      expect(args).not.toContain('--check');
    });

    it('uses --check when check is true', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
      await tool.prettierFormat({ paths: ['src'], check: true, packageDir: '.' });
      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('--check');
      expect(args).not.toContain('--write');
    });

    it('returns success:false when files are not formatted', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(1, 'src/index.ts: needs formatting') as any);
      const result = await tool.prettierFormat({ paths: ['src'], check: true, packageDir: '.' });
      expect(result.success).toBe(false);
    });

    it('blocks absolute paths', async () => {
      await expect(
        tool.prettierFormat({ paths: ['/etc/passwd'], check: false, packageDir: '.' })
      ).rejects.toThrow('outside the workspace');
    });
  });
});
