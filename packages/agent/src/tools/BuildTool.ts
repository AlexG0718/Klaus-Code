import * as path from 'path';
import * as fs   from 'fs-extra';
import { logger } from '../logger';
import type { DockerSandbox } from '../sandbox/DockerSandbox';
import type { NpmInstallInput, NpmRunInput, TscCheckInput } from './schemas';

// ─── Hardcoded binaries ───────────────────────────────────────────────────────
const NPM_BIN  = 'npm';
const TSC_BIN  = 'npx';
const TSC_ARGS = ['tsc'];

export interface BuildResult {
  success:    boolean;
  stdout:     string;
  stderr:     string;
  durationMs: number;
  command:    string;
  sandboxed:  boolean;
}

export interface ScriptCheckResult {
  exists:           boolean;
  availableScripts: string[];
}

export class BuildTool {
  constructor(
    private readonly workspaceDir: string,
    private readonly sandbox: DockerSandbox | null = null,
  ) {}

  // ─── npm install ─────────────────────────────────────────────────────────

  async npmInstall(input: NpmInstallInput): Promise<BuildResult> {
    const cwd = this.resolvePackageDir(input.packageDir);
    await this.assertPackageJson(cwd);

    const args: string[] = ['install'];
    if (input.packages.length > 0) {
      args.push(...input.packages.map(this.sanitizePackageName));
      if (input.saveDev) args.push('--save-dev');
    }

    const command = `${NPM_BIN} ${args.join(' ')}`;
    logger.info('Running npm install', { cwd, packages: input.packages, sandboxed: !!this.sandbox });
    return this.runProcess(NPM_BIN, args, cwd, 300_000, command);
  }

  // ─── npm run <script> ─────────────────────────────────────────────────────

  async npmRun(input: NpmRunInput): Promise<BuildResult> {
    const cwd = this.resolvePackageDir(input.packageDir);
    await this.assertPackageJson(cwd);

    const check = await this.checkScript(cwd, input.script);
    if (!check.exists) {
      throw new Error(
        `Script "${input.script}" not found in package.json. ` +
        `Available scripts: ${check.availableScripts.join(', ') || 'none'}`,
      );
    }

    const args    = ['run', input.script];
    const command = `${NPM_BIN} ${args.join(' ')}`;
    logger.info('Running npm script', { script: input.script, cwd, sandboxed: !!this.sandbox });
    return this.runProcess(NPM_BIN, args, cwd, input.timeout, command, input.env ?? {});
  }

  // ─── tsc --noEmit ─────────────────────────────────────────────────────────

  async tscCheck(input: TscCheckInput): Promise<BuildResult> {
    const cwd  = this.resolvePackageDir(input.packageDir);
    const args = [...TSC_ARGS];
    if (!input.emitFiles) args.push('--noEmit');

    const command = `${TSC_BIN} ${args.join(' ')}`;
    logger.info('Running TypeScript check', { cwd, emitFiles: input.emitFiles, sandboxed: !!this.sandbox });
    return this.runProcess(TSC_BIN, args, cwd, 120_000, command);
  }

  // ─── Core process runner ──────────────────────────────────────────────────

  private async runProcess(
    bin:      string,
    args:     string[],
    cwd:      string,
    timeout:  number,
    command:  string,
    extraEnv: Record<string, string> = {},
  ): Promise<BuildResult> {
    // ── Docker sandbox path ───────────────────────────────────────────────
    if (this.sandbox) {
      const { containerCmd, containerCwd } = this.toContainerCommand(bin, args, cwd);
      logger.info('Routing build command to Docker sandbox', { command: containerCmd });

      const result = await this.sandbox.execute(containerCmd, this.workspaceDir, {
        timeout,
        env: { ...extraEnv },
      });

      const success = result.exitCode === 0;
      if (!success) logger.warn('Sandboxed build failed', { command: containerCmd, exitCode: result.exitCode });
      return { success, stdout: result.stdout, stderr: result.stderr, durationMs: 0, command: containerCmd, sandboxed: true };
    }

    // ── Host path ─────────────────────────────────────────────────────────
    const { spawn } = await import('child_process');
    const start     = Date.now();
    const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap

    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false;
      let stdoutCapped = false, stderrCapped = false;

      const child = spawn(bin, args, {
        cwd,
        shell: false,
        env: { ...process.env, ...extraEnv, PATH: process.env.PATH! },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        logger.warn('Build command timed out', { command, timeout });
      }, timeout);

      child.stdout.on('data', (d: Buffer) => {
        if (!stdoutCapped) {
          stdout += d.toString();
          if (stdout.length > MAX_OUTPUT) { stdout = stdout.slice(0, MAX_OUTPUT) + '\n[TRUNCATED]'; stdoutCapped = true; }
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        if (!stderrCapped) {
          stderr += d.toString();
          if (stderr.length > MAX_OUTPUT) { stderr = stderr.slice(0, MAX_OUTPUT) + '\n[TRUNCATED]'; stderrCapped = true; }
        }
      });
      child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Failed to start ${bin}: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        const exitCode   = timedOut ? 124 : (code ?? 0);
        const success    = exitCode === 0;
        logger.info('Build process complete', { command, exitCode, durationMs });
        if (!success) logger.warn('Build process failed', { command, exitCode, stderr: stderr.slice(0, 1000) });
        resolve({ success, stdout, stderr, durationMs, command, sandboxed: false });
      });
    });
  }

  // ─── Path translation ─────────────────────────────────────────────────────
  // Maps absolute host paths inside the workspace to their /workspace equivalents
  // so the sandboxed process sees the correct paths.

  private toContainerCommand(
    bin:  string,
    args: string[],
    cwd:  string,
  ): { containerCmd: string; containerCwd: string } {
    const containerCwd = this.hostToContainer(cwd);
    const translatedArgs = args.map((a) =>
      a.startsWith(this.workspaceDir) ? this.hostToContainer(a) : a,
    );

    // If cwd is a subdirectory of the workspace, prefix with cd so the
    // process runs in the right directory within the mounted volume.
    const cdPrefix = containerCwd !== '/workspace' ? `cd ${containerCwd} && ` : '';
    const containerCmd = `${cdPrefix}${bin} ${translatedArgs.join(' ')}`;
    return { containerCmd, containerCwd };
  }

  private hostToContainer(hostPath: string): string {
    const rel = path.relative(this.workspaceDir, hostPath);
    return rel === '' ? '/workspace' : `/workspace/${rel}`;
  }

  // ─── Guards ───────────────────────────────────────────────────────────────

  private resolvePackageDir(packageDir: string): string {
    const sanitized = packageDir.replace(/^[/\\]+/, '');
    const resolved  = path.resolve(this.workspaceDir, sanitized);
    const prefix    = this.workspaceDir.endsWith(path.sep) ? this.workspaceDir : this.workspaceDir + path.sep;
    if (resolved !== this.workspaceDir && !resolved.startsWith(prefix)) {
      throw new Error(`Access denied: packageDir "${packageDir}" resolves outside the workspace.`);
    }
    return resolved;
  }

  private async assertPackageJson(cwd: string): Promise<void> {
    if (!(await fs.pathExists(path.join(cwd, 'package.json')))) {
      throw new Error(`No package.json found in ${cwd}`);
    }
  }

  private async checkScript(cwd: string, script: string): Promise<ScriptCheckResult> {
    try {
      const pkg = await fs.readJson(path.join(cwd, 'package.json'));
      const availableScripts = Object.keys(pkg.scripts ?? {});
      return { exists: availableScripts.includes(script), availableScripts };
    } catch {
      return { exists: false, availableScripts: [] };
    }
  }

  private sanitizePackageName(pkg: string): string {
    if (!/^(@[a-z0-9-_]+\/)?[a-z0-9-_.@]+(@[\w.*^~>=<!|-]+)?$/.test(pkg)) {
      throw new Error(`Invalid package name: "${pkg}".`);
    }
    return pkg;
  }
}
