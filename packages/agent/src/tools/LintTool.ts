import * as path from 'path';
import { logger } from '../logger';
import type { DockerSandbox } from '../sandbox/DockerSandbox';
import type { EslintCheckInput, PrettierFormatInput } from './schemas';

const NPX_BIN = 'npx';

export interface LintResult {
  success:       boolean;
  stdout:        string;
  stderr:        string;
  durationMs:    number;
  command:       string;
  sandboxed:     boolean;
  fixesApplied?: boolean;
}

export class LintTool {
  constructor(
    private readonly workspaceDir: string,
    private readonly sandbox: DockerSandbox | null = null,
  ) {}

  // ─── ESLint ────────────────────────────────────────────────────────────────

  async eslintCheck(input: EslintCheckInput): Promise<LintResult> {
    const cwd           = this.resolveDir(input.packageDir);
    const resolvedPaths = input.paths.map((p) => this.resolveLintPath(p));

    const args = [
      'eslint',
      '--no-error-on-unmatched-pattern',
      '--max-warnings', '0',
      ...resolvedPaths,
    ];
    if (input.fix) args.push('--fix');

    logger.info('Running ESLint', { paths: resolvedPaths, fix: input.fix, sandboxed: !!this.sandbox });
    const result = await this.runProcess(NPX_BIN, args, cwd, 120_000);
    return {
      ...result,
      command:      `npx eslint ${resolvedPaths.join(' ')}${input.fix ? ' --fix' : ''}`,
      fixesApplied: input.fix && result.success,
    };
  }

  // ─── Prettier ──────────────────────────────────────────────────────────────

  async prettierFormat(input: PrettierFormatInput): Promise<LintResult> {
    const cwd           = this.resolveDir(input.packageDir);
    const resolvedPaths = input.paths.map((p) => this.resolveLintPath(p));

    const args = [
      'prettier',
      ...(input.check ? ['--check'] : ['--write']),
      ...resolvedPaths,
    ];

    logger.info('Running Prettier', { paths: resolvedPaths, check: input.check, sandboxed: !!this.sandbox });
    const result = await this.runProcess(NPX_BIN, args, cwd, 60_000);
    return {
      ...result,
      command:      `npx prettier ${input.check ? '--check' : '--write'} ${resolvedPaths.join(' ')}`,
      fixesApplied: !input.check && result.success,
    };
  }

  // ─── Core process runner ──────────────────────────────────────────────────

  private async runProcess(
    bin:     string,
    args:    string[],
    cwd:     string,
    timeout: number,
  ): Promise<Omit<LintResult, 'command' | 'fixesApplied'>> {
    // ── Docker sandbox path ───────────────────────────────────────────────
    if (this.sandbox) {
      const containerCwd  = this.hostToContainer(cwd);
      const cdPrefix      = containerCwd !== '/workspace' ? `cd ${containerCwd} && ` : '';
      // Lint paths are relative to cwd — no translation needed
      const containerCmd  = `${cdPrefix}${bin} ${args.join(' ')}`;

      logger.info('Routing lint command to Docker sandbox', { command: containerCmd });
      const result = await this.sandbox.execute(containerCmd, this.workspaceDir, { timeout });

      const success = result.exitCode === 0;
      if (!success) logger.warn('Sandboxed lint failed', { command: containerCmd });
      return { success, stdout: result.stdout, stderr: result.stderr, durationMs: 0, sandboxed: true };
    }

    // ── Host path ─────────────────────────────────────────────────────────
    const { spawn } = await import('child_process');
    const start     = Date.now();
    const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap

    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false;
      let stdoutCapped = false, stderrCapped = false;

      const child = spawn(bin, args, { cwd, shell: false, env: { ...process.env } });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        logger.warn('Lint command timed out', { bin, timeout });
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
      child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Failed to spawn ${bin}: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        const success    = !timedOut && code === 0;
        logger.info('Lint process complete', { bin, exitCode: code, durationMs, success });
        if (!success) logger.warn('Lint issues found', { stdout: stdout.slice(0, 500) });
        resolve({ success, stdout, stderr, durationMs, sandboxed: false });
      });
    });
  }

  // ─── Path translation ─────────────────────────────────────────────────────

  private hostToContainer(hostPath: string): string {
    const rel = path.relative(this.workspaceDir, hostPath);
    return rel === '' ? '/workspace' : `/workspace/${rel}`;
  }

  // ─── Guards ───────────────────────────────────────────────────────────────

  private resolveDir(dir: string): string {
    const sanitized = dir.replace(/^[/\\]+/, '');
    const resolved  = path.resolve(this.workspaceDir, sanitized);
    this.assertInWorkspace(resolved, dir);
    return resolved;
  }

  private resolveLintPath(p: string): string {
    const nonGlobPart = p.split('*')[0].replace(/^[/\\]+/, '');
    const resolved    = path.resolve(this.workspaceDir, nonGlobPart);
    this.assertInWorkspace(resolved, p);
    return path.relative(this.workspaceDir, path.resolve(this.workspaceDir, p.replace(/^[/\\]+/, '')));
  }

  private assertInWorkspace(resolved: string, original: string): void {
    const prefix = this.workspaceDir.endsWith(path.sep) ? this.workspaceDir : this.workspaceDir + path.sep;
    if (resolved !== this.workspaceDir && !resolved.startsWith(prefix)) {
      throw new Error(`Access denied: path "${original}" resolves outside the workspace.`);
    }
  }
}
