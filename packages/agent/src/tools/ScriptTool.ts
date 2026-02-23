import * as path from 'path';
import * as fs   from 'fs-extra';
import { logger } from '../logger';
import type { DockerSandbox } from '../sandbox/DockerSandbox';
import type { RunNodeScriptInput } from './schemas';

const NODE_BIN    = 'node';
const TSNODE_BIN  = 'npx';
const TSNODE_ARGS = ['ts-node'];

const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const BLOCKED_ARG_CHARS  = /[;&|`$<>(){}[\]\\'"]/;

// Env vars that must never be visible to user scripts — cleared in both
// the host spawn and the Docker sandbox env override.
const SCRUBBED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'AGENT_API_SECRET'];

export interface ScriptResult {
  success:    boolean;
  stdout:     string;
  stderr:     string;
  durationMs: number;
  scriptPath: string;
  exitCode:   number;
  sandboxed:  boolean;
}

export class ScriptTool {
  constructor(
    private readonly workspaceDir: string,
    private readonly sandbox: DockerSandbox | null = null,
  ) {}

  async runNodeScript(input: RunNodeScriptInput): Promise<ScriptResult> {
    // ── 1. Resolve and confine ────────────────────────────────────────────
    const sanitized = input.scriptPath.replace(/^[/\\]+/, '');
    const resolved  = path.resolve(this.workspaceDir, sanitized);
    const prefix    = this.workspaceDir.endsWith(path.sep) ? this.workspaceDir : this.workspaceDir + path.sep;

    if (!resolved.startsWith(prefix)) {
      throw new Error(`Access denied: script "${input.scriptPath}" is outside the workspace.`);
    }

    // ── 2. File exists + allowed extension ───────────────────────────────
    if (!(await fs.pathExists(resolved))) {
      throw new Error(`Script not found: ${input.scriptPath}`);
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(
        `Cannot execute "${input.scriptPath}": only ${[...ALLOWED_EXTENSIONS].join(', ')} files are allowed.`,
      );
    }

    // ── 3. Validate args ─────────────────────────────────────────────────
    for (const arg of input.args) {
      if (BLOCKED_ARG_CHARS.test(arg)) {
        throw new Error(`Argument contains disallowed characters: "${arg}".`);
      }
    }

    // ── 4. Choose binary ─────────────────────────────────────────────────
    const useTsNode = input.useTsNode || ext === '.ts';
    const bin       = useTsNode ? TSNODE_BIN : NODE_BIN;
    const binArgs   = useTsNode ? [...TSNODE_ARGS, resolved, ...input.args] : [resolved, ...input.args];

    logger.info('Running node script', {
      script: input.scriptPath, useTsNode, sandboxed: !!this.sandbox,
    });

    return this.runProcess(bin, binArgs, input.timeout, resolved);
  }

  // ─── Core process runner ──────────────────────────────────────────────────

  private async runProcess(
    bin:        string,
    args:       string[],
    timeout:    number,
    scriptPath: string,
  ): Promise<ScriptResult> {
    // ── Docker sandbox path ───────────────────────────────────────────────
    if (this.sandbox) {
      // Translate any absolute host paths in args to /workspace equivalents.
      // The script path itself is always an absolute host path — must translate.
      const translatedArgs = args.map((a) =>
        a.startsWith(this.workspaceDir) ? this.hostToContainer(a) : a,
      );
      const containerCmd = `${bin} ${translatedArgs.join(' ')}`;

      // Scrub sensitive keys from the environment passed into the sandbox
      const sandboxEnv: Record<string, string> = {};
      for (const key of SCRUBBED_ENV_KEYS) sandboxEnv[key] = '';

      logger.info('Routing script to Docker sandbox', { command: containerCmd });
      const result = await this.sandbox.execute(containerCmd, this.workspaceDir, {
        timeout,
        env: sandboxEnv,
      });

      const success  = result.exitCode === 0;
      const exitCode = result.exitCode;
      if (!success) logger.warn('Sandboxed script failed', { command: containerCmd, exitCode });
      return { success, stdout: result.stdout, stderr: result.stderr, durationMs: 0, scriptPath, exitCode, sandboxed: true };
    }

    // ── Host path ─────────────────────────────────────────────────────────
    const { spawn } = await import('child_process');
    const start     = Date.now();
    const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap

    // Scrub sensitive keys from the host environment
    const hostEnv: Record<string, string | undefined> = { ...process.env };
    for (const key of SCRUBBED_ENV_KEYS) hostEnv[key] = '';

    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false;
      let stdoutCapped = false, stderrCapped = false;

      const child = spawn(bin, args, {
        cwd:   this.workspaceDir,
        shell: false,
        env:   hostEnv as NodeJS.ProcessEnv,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        logger.warn('Script timed out', { scriptPath, timeout });
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
        const exitCode   = timedOut ? 124 : (code ?? 0);
        const success    = exitCode === 0;
        logger.info('Script complete', { scriptPath, exitCode, durationMs });
        if (!success) logger.warn('Script failed', { scriptPath, exitCode, stderr: stderr.slice(0, 500) });
        resolve({ success, stdout, stderr, durationMs, scriptPath, exitCode, sandboxed: false });
      });
    });
  }

  // ─── Path translation ─────────────────────────────────────────────────────

  private hostToContainer(hostPath: string): string {
    const rel = path.relative(this.workspaceDir, hostPath);
    return rel === '' ? '/workspace' : `/workspace/${rel}`;
  }
}
