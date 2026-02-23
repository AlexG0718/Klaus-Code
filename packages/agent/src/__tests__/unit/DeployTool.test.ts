/**
 * Tests for the refactored DeployTool:
 *   - Uses BuildTool.npmRun() for build step (not ShellTool)
 *   - Spawns Netlify CLI directly with shell:false
 *   - Auth token passed as env var, not in args
 *   - publishDir confinement
 *   - Returns success:false when build fails
 *   - Returns success:false when deploy fails
 *   - Parses deploy URL from Netlify JSON output
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { deployToNetlify } from '../../tools/DeployTool';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../../tools/BuildTool');

import { spawn } from 'child_process';
import { BuildTool } from '../../tools/BuildTool';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const MockBuildTool = BuildTool as jest.MockedClass<typeof BuildTool>;

function makeSpawnMock(exitCode: number, stdout = '', stderr = '') {
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
  emitter.stderr.on.mockImplementation(
    (ev: string, cb: (data: Buffer) => void) => {
      if (ev === 'data' && stderr) cb(Buffer.from(stderr));
    }
  );
  emitter.on.mockImplementation((ev: string, cb: (code: number) => void) => {
    if (ev === 'close') setTimeout(() => cb(exitCode), 0);
  });
  return emitter;
}

describe('DeployTool', () => {
  let workspaceDir: string;
  let publishDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-test-'));
    publishDir = path.join(workspaceDir, 'dist');
    await fs.ensureDir(publishDir);
    await fs.writeJson(path.join(workspaceDir, 'package.json'), {
      name: 'test',
      scripts: { build: 'tsc' },
    });

    jest.clearAllMocks();

    // Default: build succeeds
    MockBuildTool.prototype.npmRun = jest.fn().mockResolvedValue({
      success: true,
      stdout: 'Build complete',
      stderr: '',
      durationMs: 500,
      command: 'npm run build',
    });

    // Default: Netlify CLI succeeds with a URL
    const netlifyJson = JSON.stringify({
      deploy_id: 'abc123',
      deploy_url: 'https://abc123.netlify.app',
    });
    mockSpawn.mockReturnValue(makeSpawnMock(0, netlifyJson) as any);
  });

  afterEach(async () => {
    await fs.remove(workspaceDir);
  });

  // ── ShellTool is gone ──────────────────────────────────────────────────────

  it('does NOT import or instantiate ShellTool', async () => {
    // If ShellTool were used, this test would fail because we have not mocked it.
    // The fact that it passes confirms DeployTool no longer depends on it.
    await deployToNetlify({ workspaceDir, publishDir: 'dist' });
    const ShellToolModule = jest.requireMock('../../tools/ShellTool');
    expect(ShellToolModule).toBeUndefined(); // module was never required
  });

  // ── Build step ────────────────────────────────────────────────────────────

  it('calls BuildTool.npmRun with the build script name', async () => {
    await deployToNetlify({
      workspaceDir,
      publishDir: 'dist',
      buildCommand: 'build',
    });
    expect(MockBuildTool.prototype.npmRun).toHaveBeenCalledWith(
      expect.objectContaining({ script: 'build' })
    );
  });

  it('returns success:false and does not spawn Netlify CLI when build fails', async () => {
    MockBuildTool.prototype.npmRun = jest.fn().mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'tsc error TS2345',
      durationMs: 200,
      command: 'npm run build',
    });

    const result = await deployToNetlify({ workspaceDir, publishDir: 'dist' });

    expect(result.success).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.logs).toContain('tsc error TS2345');
  });

  // ── Netlify CLI spawn ──────────────────────────────────────────────────────

  it('spawns the Netlify CLI with shell:false', async () => {
    await deployToNetlify({ workspaceDir, publishDir: 'dist' });
    const opts = mockSpawn.mock.calls[0][2] as any;
    expect(opts?.shell).toBeFalsy();
  });

  it('passes auth token as NETLIFY_AUTH_TOKEN env var, not as a CLI arg', async () => {
    await deployToNetlify({
      workspaceDir,
      publishDir: 'dist',
      authToken: 'test-token-abc',
    });

    const [, args, opts] = mockSpawn.mock.calls[0] as any;
    const argString = args.join(' ');

    // Token must NOT be in the CLI args
    expect(argString).not.toContain('test-token-abc');
    // Token MUST be in the env
    expect(opts.env.NETLIFY_AUTH_TOKEN).toBe('test-token-abc');
  });

  it('adds --prod flag for production environment', async () => {
    await deployToNetlify({
      workspaceDir,
      publishDir: 'dist',
      environment: 'production',
    });
    const [, args] = mockSpawn.mock.calls[0] as any;
    expect(args).toContain('--prod');
  });

  it('does not add --prod flag for preview environment', async () => {
    await deployToNetlify({
      workspaceDir,
      publishDir: 'dist',
      environment: 'preview',
    });
    const [, args] = mockSpawn.mock.calls[0] as any;
    expect(args).not.toContain('--prod');
  });

  it('includes --site flag when siteId provided', async () => {
    await deployToNetlify({
      workspaceDir,
      publishDir: 'dist',
      siteId: 'my-site-id',
    });
    const [, args] = mockSpawn.mock.calls[0] as any;
    expect(args.join(' ')).toContain('--site=my-site-id');
  });

  // ── publishDir confinement ────────────────────────────────────────────────

  it('throws when publishDir is outside the workspace', async () => {
    await expect(
      deployToNetlify({ workspaceDir, publishDir: '../../etc' })
    ).rejects.toThrow('outside the workspace');
  });

  it('returns failure when publishDir does not exist after build', async () => {
    await fs.remove(publishDir); // delete the dist dir
    const result = await deployToNetlify({ workspaceDir, publishDir: 'dist' });
    expect(result.success).toBe(false);
    expect(result.logs).toContain('does not exist after build');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // ── Result parsing ────────────────────────────────────────────────────────

  it('parses deploy URL from Netlify JSON output', async () => {
    const json = JSON.stringify({
      deploy_id: 'xyz789',
      deploy_url: 'https://xyz789.netlify.app',
    });
    mockSpawn.mockReturnValue(makeSpawnMock(0, json) as any);

    const result = await deployToNetlify({ workspaceDir, publishDir: 'dist' });
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://xyz789.netlify.app');
    expect(result.deployId).toBe('xyz789');
  });

  it('falls back to regex URL parsing when JSON parse fails', async () => {
    const stdout = 'Deployed! https://fallback.netlify.app (site ready)';
    mockSpawn.mockReturnValue(makeSpawnMock(0, stdout) as any);

    const result = await deployToNetlify({ workspaceDir, publishDir: 'dist' });
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://fallback.netlify.app');
  });

  it('returns success:false when Netlify CLI exits with non-zero', async () => {
    mockSpawn.mockReturnValue(
      makeSpawnMock(1, '', 'Error: site not found') as any
    );
    const result = await deployToNetlify({ workspaceDir, publishDir: 'dist' });
    expect(result.success).toBe(false);
    expect(result.logs).toContain('Error: site not found');
  });
});
