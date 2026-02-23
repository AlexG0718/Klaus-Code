import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { ScriptTool } from '../../tools/ScriptTool';

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

describe('ScriptTool', () => {
  let tool: ScriptTool;
  let workspaceDir: string;
  let scriptFile: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'script-tool-test-'));
    scriptFile = path.join(workspaceDir, 'seed.js');
    await fs.writeFile(scriptFile, 'console.log("seeded")');
    tool = new ScriptTool(workspaceDir);
    mockSpawn.mockReset();
  });

  afterEach(async () => { await fs.remove(workspaceDir); });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('runs node with the resolved script path', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0, 'seeded') as any);

    const result = await tool.runNodeScript({
      scriptPath: 'seed.js', args: [], timeout: 10000, useTsNode: false,
    });

    expect(result.success).toBe(true);
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe('node');
    expect(args[0]).toBe(scriptFile);   // absolute resolved path
  });

  it('uses ts-node when useTsNode is true', async () => {
    const tsScript = path.join(workspaceDir, 'seed.ts');
    await fs.writeFile(tsScript, 'console.log("ts seeded")');
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

    await tool.runNodeScript({ scriptPath: 'seed.ts', args: [], timeout: 10000, useTsNode: true });

    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe('npx');
    expect(args[0]).toBe('ts-node');
  });

  it('passes args to the script process', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

    await tool.runNodeScript({
      scriptPath: 'seed.js', args: ['--env', 'test'], timeout: 10000, useTsNode: false,
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--env');
    expect(args).toContain('test');
  });

  it('strips the ANTHROPIC_API_KEY from the child process environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-secret';
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);

    await tool.runNodeScript({ scriptPath: 'seed.js', args: [], timeout: 10000, useTsNode: false });

    const opts = mockSpawn.mock.calls[0][2] as any;
    expect(opts.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('never uses shell:true', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
    await tool.runNodeScript({ scriptPath: 'seed.js', args: [], timeout: 10000, useTsNode: false });
    const opts = mockSpawn.mock.calls[0][2] as any;
    expect(opts?.shell).toBeFalsy();
  });

  // ── Path confinement ───────────────────────────────────────────────────────

  it('blocks path traversal via ../', async () => {
    await expect(
      tool.runNodeScript({ scriptPath: '../../etc/passwd', args: [], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('outside the workspace');
  });

  it('blocks absolute paths', async () => {
    await expect(
      tool.runNodeScript({ scriptPath: '/etc/passwd', args: [], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('outside the workspace');
  });

  it('throws when the script file does not exist', async () => {
    await expect(
      tool.runNodeScript({ scriptPath: 'nonexistent.js', args: [], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('Script not found');
  });

  // ── Extension allowlist ────────────────────────────────────────────────────

  it('allows .js files', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
    await expect(
      tool.runNodeScript({ scriptPath: 'seed.js', args: [], timeout: 5000, useTsNode: false })
    ).resolves.toBeDefined();
  });

  it('blocks .sh files', async () => {
    await fs.writeFile(path.join(workspaceDir, 'evil.sh'), '#!/bin/sh\nrm -rf /');
    await expect(
      tool.runNodeScript({ scriptPath: 'evil.sh', args: [], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('only .js, .mjs, .cjs, .ts');
  });

  it('blocks .py files', async () => {
    await fs.writeFile(path.join(workspaceDir, 'script.py'), 'import os');
    await expect(
      tool.runNodeScript({ scriptPath: 'script.py', args: [], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('only .js, .mjs, .cjs, .ts');
  });

  // ── Arg injection prevention ───────────────────────────────────────────────

  it('blocks semicolons in args', async () => {
    await expect(
      tool.runNodeScript({ scriptPath: 'seed.js', args: ['; rm -rf /'], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('disallowed characters');
  });

  it('blocks pipe characters in args', async () => {
    await expect(
      tool.runNodeScript({ scriptPath: 'seed.js', args: ['| cat /etc/passwd'], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('disallowed characters');
  });

  it('blocks backticks in args', async () => {
    await expect(
      tool.runNodeScript({ scriptPath: 'seed.js', args: ['`whoami`'], timeout: 5000, useTsNode: false })
    ).rejects.toThrow('disallowed characters');
  });

  it('allows clean alphanumeric args', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
    await expect(
      tool.runNodeScript({ scriptPath: 'seed.js', args: ['--env', 'production', '--verbose'], timeout: 5000, useTsNode: false })
    ).resolves.toBeDefined();
  });

  // ── Exit code handling ─────────────────────────────────────────────────────

  it('returns success:false when script exits with non-zero code', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(1, '', 'Error: database connection refused') as any);
    const result = await tool.runNodeScript({ scriptPath: 'seed.js', args: [], timeout: 5000, useTsNode: false });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
