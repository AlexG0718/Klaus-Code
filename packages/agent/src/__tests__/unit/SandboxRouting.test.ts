/**
 * Tests for Docker sandbox routing across BuildTool, LintTool, ScriptTool, TestTool.
 *
 * Strategy: mock DockerSandbox.execute() and verify:
 *   - When sandbox is provided, execute() is called instead of spawn()
 *   - Host paths are translated to /workspace equivalents
 *   - Subdirectory cwd is prefixed with `cd /workspace/subdir &&`
 *   - Sensitive env keys are scrubbed from the sandbox env
 *   - When sandbox is null (DOCKER_ENABLED=false), spawn() is used
 *   - The sandbox is constructed once in ToolExecutor and shared
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../../sandbox/DockerSandbox');

import { spawn } from 'child_process';
import { DockerSandbox } from '../../sandbox/DockerSandbox';
import { BuildTool } from '../../tools/BuildTool';
import { LintTool } from '../../tools/LintTool';
import { ScriptTool } from '../../tools/ScriptTool';
import { TestTool } from '../../tools/TestTool';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const MockDockerSandbox = DockerSandbox as jest.MockedClass<
  typeof DockerSandbox
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSandboxMock(
  exitCode = 0,
  stdout = 'ok',
  stderr = ''
): jest.Mocked<DockerSandbox> {
  const mock = new MockDockerSandbox() as jest.Mocked<DockerSandbox>;
  mock.execute = jest.fn().mockResolvedValue({ exitCode, stdout, stderr });
  return mock;
}

function makeSpawnMock(exitCode = 0, stdout = '') {
  const emitter = {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
  } as any;
  emitter.stdout.on.mockImplementation(
    (ev: string, cb: (data: Buffer) => void) => {
      if (ev === 'data' && stdout) cb(Buffer.from(stdout));
    }
  );
  emitter.stderr.on.mockImplementation(() => {});
  emitter.on.mockImplementation((ev: string, cb: (code: number) => void) => {
    if (ev === 'close') setTimeout(() => cb(exitCode), 0);
  });
  return emitter;
}

// ─── BuildTool sandbox routing ────────────────────────────────────────────────

describe('BuildTool sandbox routing', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-build-'));
    await fs.writeJson(path.join(workspaceDir, 'package.json'), {
      scripts: { build: 'tsc', test: 'jest' },
    });
    MockDockerSandbox.mockClear();
    mockSpawn.mockReset();
  });
  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('calls sandbox.execute() instead of spawn() when sandbox is provided', async () => {
    const sandbox = makeSandboxMock();
    const tool = new BuildTool(workspaceDir, sandbox);

    await tool.npmRun({ script: 'build', packageDir: '.', timeout: 60000 });

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('uses spawn() when sandbox is null', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0, 'done') as any);
    const tool = new BuildTool(workspaceDir, null);

    await tool.npmRun({ script: 'build', packageDir: '.', timeout: 60000 });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('passes the workspace host dir as workspaceDir arg to sandbox', async () => {
    const sandbox = makeSandboxMock();
    const tool = new BuildTool(workspaceDir, sandbox);

    await tool.npmInstall({ packages: [], packageDir: '.', saveDev: false });

    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.any(String),
      workspaceDir, // host path — DockerSandbox handles the bind mount
      expect.any(Object)
    );
  });

  it('prefixes command with cd when packageDir is a subdirectory', async () => {
    // Create a nested package
    const subDir = path.join(workspaceDir, 'packages', 'ui');
    await fs.ensureDir(subDir);
    await fs.writeJson(path.join(subDir, 'package.json'), {
      scripts: { build: 'vite build' },
    });

    const sandbox = makeSandboxMock();
    const tool = new BuildTool(workspaceDir, sandbox);

    await tool.npmRun({
      script: 'build',
      packageDir: 'packages/ui',
      timeout: 60000,
    });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(command).toContain('cd /workspace/packages/ui &&');
    expect(command).toContain('npm run build');
  });

  it('does NOT prefix cd when packageDir is workspace root', async () => {
    const sandbox = makeSandboxMock();
    const tool = new BuildTool(workspaceDir, sandbox);

    await tool.npmRun({ script: 'build', packageDir: '.', timeout: 60000 });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(command).not.toContain('cd /workspace &&');
    expect(command).toMatch(/^npm run build/);
  });

  it('returns sandboxed:true in result when sandbox is used', async () => {
    const sandbox = makeSandboxMock();
    const tool = new BuildTool(workspaceDir, sandbox);
    const result = await tool.tscCheck({ packageDir: '.', emitFiles: false });
    expect(result.sandboxed).toBe(true);
  });

  it('returns sandboxed:false when running on host', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock(0) as any);
    const tool = new BuildTool(workspaceDir, null);
    const result = await tool.tscCheck({ packageDir: '.', emitFiles: false });
    expect(result.sandboxed).toBe(false);
  });
});

// ─── LintTool sandbox routing ─────────────────────────────────────────────────

describe('LintTool sandbox routing', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-lint-'));
    MockDockerSandbox.mockClear();
    mockSpawn.mockReset();
  });
  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('routes eslint through sandbox when sandbox provided', async () => {
    const sandbox = makeSandboxMock();
    const tool = new LintTool(workspaceDir, sandbox);

    await tool.eslintCheck({ paths: ['src'], fix: false, packageDir: '.' });

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('routes prettier through sandbox when sandbox provided', async () => {
    const sandbox = makeSandboxMock();
    const tool = new LintTool(workspaceDir, sandbox);

    await tool.prettierFormat({ paths: ['src'], check: true, packageDir: '.' });

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('lint paths remain relative in sandboxed command (no host paths leaked)', async () => {
    const sandbox = makeSandboxMock();
    const tool = new LintTool(workspaceDir, sandbox);

    await tool.eslintCheck({ paths: ['src'], fix: false, packageDir: '.' });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    // Must contain relative path, must NOT contain the host workspaceDir
    expect(command).toContain('src');
    expect(command).not.toContain(workspaceDir);
  });
});

// ─── ScriptTool sandbox routing ───────────────────────────────────────────────

describe('ScriptTool sandbox routing', () => {
  let workspaceDir: string;
  let scriptFile: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-script-'));
    scriptFile = path.join(workspaceDir, 'seed.js');
    await fs.writeFile(scriptFile, 'console.log("seeded")');
    MockDockerSandbox.mockClear();
    mockSpawn.mockReset();
  });
  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('routes script execution through sandbox when sandbox provided', async () => {
    const sandbox = makeSandboxMock();
    const tool = new ScriptTool(workspaceDir, sandbox);

    await tool.runNodeScript({
      scriptPath: 'seed.js',
      args: [],
      timeout: 10000,
      useTsNode: false,
    });

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('translates host script path to /workspace path in sandbox command', async () => {
    const sandbox = makeSandboxMock();
    const tool = new ScriptTool(workspaceDir, sandbox);

    await tool.runNodeScript({
      scriptPath: 'seed.js',
      args: [],
      timeout: 10000,
      useTsNode: false,
    });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(command).toContain('/workspace/seed.js');
    expect(command).not.toContain(workspaceDir); // no host path leaked
  });

  it('translates nested script paths correctly', async () => {
    const nestedDir = path.join(workspaceDir, 'scripts');
    const nestedScript = path.join(nestedDir, 'migrate.js');
    await fs.ensureDir(nestedDir);
    await fs.writeFile(nestedScript, 'console.log("migrate")');

    const sandbox = makeSandboxMock();
    const tool = new ScriptTool(workspaceDir, sandbox);

    await tool.runNodeScript({
      scriptPath: 'scripts/migrate.js',
      args: [],
      timeout: 10000,
      useTsNode: false,
    });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(command).toContain('/workspace/scripts/migrate.js');
  });

  it('scrubs ANTHROPIC_API_KEY from sandbox env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-super-secret';
    const sandbox = makeSandboxMock();
    const tool = new ScriptTool(workspaceDir, sandbox);

    await tool.runNodeScript({
      scriptPath: 'seed.js',
      args: [],
      timeout: 10000,
      useTsNode: false,
    });

    const [, , options] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(options.env.ANTHROPIC_API_KEY).toBe('');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('scrubs AGENT_API_SECRET from sandbox env', async () => {
    process.env.AGENT_API_SECRET = 'super-secret-agent-key';
    const sandbox = makeSandboxMock();
    const tool = new ScriptTool(workspaceDir, sandbox);

    await tool.runNodeScript({
      scriptPath: 'seed.js',
      args: [],
      timeout: 10000,
      useTsNode: false,
    });

    const [, , options] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(options.env.AGENT_API_SECRET).toBe('');

    delete process.env.AGENT_API_SECRET;
  });
});

// ─── TestTool sandbox routing ─────────────────────────────────────────────────

describe('TestTool sandbox routing', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    await fs.writeJson(path.join(workspaceDir, 'package.json'), {
      scripts: { test: 'jest' },
    });
    MockDockerSandbox.mockClear();
    mockSpawn.mockReset();
  });
  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  it('routes test run through sandbox when sandbox provided', async () => {
    // Mock sandbox returning a plausible jest output
    const sandbox = makeSandboxMock(0, 'Tests: 3 passed, 3 total');
    const tool = new TestTool(workspaceDir, sandbox);

    await tool.runTests({
      type: 'unit',
      coverage: false,
      updateSnapshots: false,
    });

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('uses --outputFile path inside /workspace so sandbox can write it', async () => {
    const sandbox = makeSandboxMock(0, 'Tests: 1 passed');
    const tool = new TestTool(workspaceDir, sandbox);

    await tool.runTests({
      type: 'all',
      coverage: false,
      updateSnapshots: false,
    });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    // The outputFile must point inside /workspace (not /tmp or a host path)
    if (command.includes('--outputFile=')) {
      expect(command).toContain('--outputFile=/workspace/');
      expect(command).not.toContain('--outputFile=/tmp/');
    }
  });

  it('prefixes command with cd for a test subdirectory', async () => {
    const subDir = path.join(workspaceDir, 'packages', 'core');
    await fs.ensureDir(subDir);
    await fs.writeJson(path.join(subDir, 'package.json'), {
      scripts: { test: 'jest' },
    });

    const sandbox = makeSandboxMock(0, 'Tests: 2 passed');
    const tool = new TestTool(workspaceDir, sandbox);

    await tool.runTests({
      directory: 'packages/core',
      type: 'all',
      coverage: false,
      updateSnapshots: false,
    });

    const [command] = (sandbox.execute as jest.Mock).mock.calls[0];
    expect(command).toContain('cd /workspace/packages/core &&');
  });
});

// ─── ToolExecutor creates one shared sandbox ──────────────────────────────────

describe('ToolExecutor sandbox sharing', () => {
  it('creates exactly one DockerSandbox instance when dockerEnabled is true', async () => {
    const { ToolExecutor } = await import('../../tools/ToolExecutor');
    const { DatabaseMemory } = await import('../../memory/DatabaseMemory');

    jest.mock('../../memory/DatabaseMemory');
    const mem = new DatabaseMemory(':memory:');
    mem.recordToolCall = jest.fn();
    mem.getKnowledge = jest.fn().mockReturnValue(undefined);
    mem.setKnowledge = jest.fn();

    MockDockerSandbox.mockClear();

    new ToolExecutor(
      {
        apiKey: 'k',
        workspaceDir: '/tmp/ws',
        dbPath: ':memory:',
        logDir: '/tmp',
        model: 'claude-opus-4-5',
        maxTokens: 1024,
        maxRetries: 1,
        maxContextMessages: 10,
        tokenBudget: 100_000,
        maxToolCalls: 50,
        maxConcurrentSessions: 3,
        corsOrigin: 'http://localhost:5173',
        maxPromptChars: 32_000,
        dockerEnabled: true,
        port: 3001,
      },
      mem,
      'test-session'
    );

    // Only one DockerSandbox should have been constructed
    expect(MockDockerSandbox).toHaveBeenCalledTimes(1);
  });

  it('creates no DockerSandbox when dockerEnabled is false', async () => {
    const { ToolExecutor } = await import('../../tools/ToolExecutor');
    MockDockerSandbox.mockClear();

    const { DatabaseMemory } = await import('../../memory/DatabaseMemory');
    const mem = new DatabaseMemory(':memory:');

    new ToolExecutor(
      {
        apiKey: 'k',
        workspaceDir: '/tmp/ws',
        dbPath: ':memory:',
        logDir: '/tmp',
        model: 'claude-opus-4-5',
        maxTokens: 1024,
        maxRetries: 1,
        maxContextMessages: 10,
        tokenBudget: 100_000,
        maxToolCalls: 50,
        maxConcurrentSessions: 3,
        corsOrigin: 'http://localhost:5173',
        maxPromptChars: 32_000,
        dockerEnabled: false,
        port: 3001,
      },
      mem,
      'test-session'
    );

    expect(MockDockerSandbox).not.toHaveBeenCalled();
  });
});
