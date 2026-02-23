import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { BuildTool } from '../../tools/BuildTool';

// Mock child_process so tests never actually run npm
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function makeSpawnMock(exitCode: number, stdout = '', stderr = '') {
  const emitter = {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
  } as any;

  emitter.stdout.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'data' && stdout) cb(Buffer.from(stdout));
  });
  emitter.stderr.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'data' && stderr) cb(Buffer.from(stderr));
  });
  emitter.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'close') setTimeout(() => cb(exitCode), 0);
  });

  return emitter;
}

describe('BuildTool', () => {
  let tool: BuildTool;
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-tool-test-'));
    await fs.writeJson(path.join(workspaceDir, 'package.json'), {
      name: 'test-project',
      scripts: { build: 'tsc', test: 'jest', lint: 'eslint src' },
    });
    tool = new BuildTool(workspaceDir);
    mockSpawn.mockReset();
  });

  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  // ── npm_install ────────────────────────────────────────────────────────────

  describe('npmInstall', () => {
    it('runs "npm install" with no args when packages list is empty', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0, 'added 42 packages') as any);

      const result = await tool.npmInstall({ packages: [], packageDir: '.', saveDev: false });

      expect(result.success).toBe(true);
      const [bin, args] = mockSpawn.mock.calls[0];
      expect(bin).toBe('npm');
      expect(args).toEqual(['install']);
    });

    it('passes package names as separate args — never as a single string', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

      await tool.npmInstall({ packages: ['lodash', 'zod'], packageDir: '.', saveDev: false });

      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toEqual(['install', 'lodash', 'zod']);
    });

    it('adds --save-dev flag when saveDev is true', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

      await tool.npmInstall({ packages: ['jest'], packageDir: '.', saveDev: true });

      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('--save-dev');
    });

    it('rejects package names containing shell metacharacters', async () => {
      await expect(
        tool.npmInstall({ packages: ['lodash; rm -rf /'], packageDir: '.', saveDev: false })
      ).rejects.toThrow('Invalid package name');
    });

    it('rejects path traversal in packageDir', async () => {
      await expect(
        tool.npmInstall({ packages: [], packageDir: '../../etc', saveDev: false })
      ).rejects.toThrow('outside the workspace');
    });

    it('throws when package.json is missing', async () => {
      await fs.remove(path.join(workspaceDir, 'package.json'));
      await expect(
        tool.npmInstall({ packages: [], packageDir: '.', saveDev: false })
      ).rejects.toThrow('No package.json');
    });

    it('returns success:false and captures stderr on non-zero exit', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(1, '', 'npm ERR! code ENOENT') as any);

      const result = await tool.npmInstall({ packages: [], packageDir: '.', saveDev: false });
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('npm ERR!');
    });

    it('uses shell:false — spawn is called without shell option', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
      await tool.npmInstall({ packages: [], packageDir: '.', saveDev: false });

      const spawnOptions = mockSpawn.mock.calls[0][2] as any;
      expect(spawnOptions?.shell).toBeFalsy();
    });
  });

  // ── npm_run ────────────────────────────────────────────────────────────────

  describe('npmRun', () => {
    it('runs "npm run <script>" for a script that exists in package.json', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0, 'Build complete') as any);

      const result = await tool.npmRun({ script: 'build', packageDir: '.', timeout: 60000 });

      expect(result.success).toBe(true);
      const [bin, args] = mockSpawn.mock.calls[0];
      expect(bin).toBe('npm');
      expect(args).toEqual(['run', 'build']);
    });

    it('rejects scripts that do not exist in package.json', async () => {
      await expect(
        tool.npmRun({ script: 'deploy:prod', packageDir: '.', timeout: 60000 })
      ).rejects.toThrow('Script "deploy:prod" not found');
    });

    it('error message lists available scripts when script is missing', async () => {
      await expect(
        tool.npmRun({ script: 'nonexistent', packageDir: '.', timeout: 60000 })
      ).rejects.toThrow(/Available scripts: build, test, lint/);
    });

    it('passes extra env vars to the process', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

      await tool.npmRun({
        script: 'build', packageDir: '.', timeout: 60000,
        env: { NODE_ENV: 'production' },
      });

      const spawnOptions = mockSpawn.mock.calls[0][2] as any;
      expect(spawnOptions.env.NODE_ENV).toBe('production');
    });
  });

  // ── tsc_check ─────────────────────────────────────────────────────────────

  describe('tscCheck', () => {
    it('runs "npx tsc --noEmit" by default', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

      await tool.tscCheck({ packageDir: '.', emitFiles: false });

      const [bin, args] = mockSpawn.mock.calls[0];
      expect(bin).toBe('npx');
      expect(args).toContain('tsc');
      expect(args).toContain('--noEmit');
    });

    it('omits --noEmit when emitFiles is true', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

      await tool.tscCheck({ packageDir: '.', emitFiles: true });

      const [, args] = mockSpawn.mock.calls[0];
      expect(args).not.toContain('--noEmit');
    });

    it('returns success:false when TypeScript errors exist', async () => {
      mockSpawn.mockReturnValue(makeSpawnMock(2, '', 'error TS2345: Argument of type') as any);

      const result = await tool.tscCheck({ packageDir: '.', emitFiles: false });
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('TS2345');
    });
  });
});
