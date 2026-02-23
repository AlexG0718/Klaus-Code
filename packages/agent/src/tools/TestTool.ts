import * as path from 'path';
import * as fs   from 'fs-extra';
import { logger } from '../logger';
import type { DockerSandbox } from '../sandbox/DockerSandbox';
import type { RunTestsInput } from './schemas';

const NPX_BIN = 'npx';

export interface TestResult {
  type:          string;
  passed:        boolean;
  total:         number;
  passed_count:  number;
  failed_count:  number;
  skipped_count: number;
  coverage?:     CoverageResult;
  failures:      TestFailure[];
  duration_ms:   number;
  raw_output:    string;
  sandboxed:     boolean;
}

export interface TestFailure {
  test_name: string;
  message:   string;
  stack?:    string;
}

export interface CoverageResult {
  lines:      number;
  statements: number;
  functions:  number;
  branches:   number;
}

export class TestTool {
  constructor(
    private readonly workspaceDir: string,
    private readonly sandbox: DockerSandbox | null = null,
  ) {}

  async runTests(input: RunTestsInput): Promise<TestResult> {
    const cwd = input.directory
      ? path.resolve(this.workspaceDir, input.directory.replace(/^[/\\]+/, ''))
      : this.workspaceDir;

    this.assertInWorkspace(cwd);

    logger.info('Running tests', { type: input.type, sandboxed: !!this.sandbox, coverage: input.coverage });
    const start = Date.now();

    const { runner, args } = await this.buildTestCommand(cwd, input);

    // The JSON results file must be inside the workspace so the sandbox
    // can write it to the mounted volume (the sandbox has no other writable path).
    const resultsFile    = path.join(cwd, '.jest-results.json');
    const containerResults = this.hostToContainer(resultsFile);

    // Replace any host-absolute outputFile path with the container path
    const translatedArgs = args.map((a) =>
      a.startsWith('--outputFile=') && this.sandbox
        ? `--outputFile=${containerResults}`
        : a,
    );

    const { stdout, stderr, exitCode } = await this.runProcess(
      NPX_BIN, runner, translatedArgs, cwd, 300_000,
    );

    const duration_ms = Date.now() - start;
    const raw         = stdout + stderr;

    let parsed: any = null;
    try {
      if (await fs.pathExists(resultsFile)) {
        parsed = await fs.readJson(resultsFile);
        await fs.remove(resultsFile);
      }
    } catch {
      logger.warn('Could not parse test JSON results');
    }

    const result = parsed
      ? this.parseJestJson(parsed, raw, input.type, duration_ms)
      : this.parseRawOutput(raw, input.type, duration_ms);

    result.passed = exitCode === 0;

    logger.info('Test run complete', {
      type: input.type, passed: result.passed,
      total: result.total, failed: result.failed_count, duration_ms,
    });

    if (!result.passed) {
      logger.warn('Tests failed', { failures: result.failures.map((f) => f.test_name) });
    }

    return result;
  }

  // ─── Core process runner ──────────────────────────────────────────────────

  private async runProcess(
    bin:     string,
    runner:  string,
    args:    string[],
    cwd:     string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // ── Docker sandbox path ───────────────────────────────────────────────
    if (this.sandbox) {
      const containerCwd = this.hostToContainer(cwd);
      const cdPrefix     = containerCwd !== '/workspace' ? `cd ${containerCwd} && ` : '';
      const containerCmd = `${cdPrefix}${bin} ${runner} ${args.join(' ')}`;

      logger.info('Routing test run to Docker sandbox', { command: containerCmd });
      const result = await this.sandbox.execute(containerCmd, this.workspaceDir, { timeout });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }

    // ── Host path ─────────────────────────────────────────────────────────
    const { spawn } = await import('child_process');
    const start     = Date.now();
    const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap

    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false;
      let stdoutCapped = false, stderrCapped = false;

      const child = spawn(bin, [runner, ...args], {
        cwd, shell: false, env: { ...process.env },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        logger.warn('Test run timed out', { timeout });
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
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        logger.debug('Test process exited', { exitCode: code, durationMs: Date.now() - start });
        resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1) });
      });
    });
  }

  // ─── Command builder ──────────────────────────────────────────────────────

  private async buildTestCommand(
    cwd:   string,
    input: RunTestsInput,
  ): Promise<{ runner: string; args: string[] }> {
    const pkgPath = path.join(cwd, 'package.json');
    let runner    = 'jest';

    if (await fs.pathExists(pkgPath)) {
      const pkg: any = await fs.readJson(pkgPath);
      if ((pkg.scripts?.test ?? '').includes('vitest')) runner = 'vitest';
    }

    const args: string[] = [];

    if (runner === 'vitest') {
      args.push('run');
      if (input.testPattern) args.push(input.testPattern);
      if (input.coverage)    args.push('--coverage');
    } else {
      if (input.testPattern)             args.push(`--testPathPattern=${input.testPattern}`);
      if (input.coverage)                args.push('--coverage');
      if (input.updateSnapshots)         args.push('--updateSnapshot');
      if (input.type === 'unit')         args.push('--testPathPattern=__tests__/unit|\\.unit\\.');
      if (input.type === 'integration')  args.push('--testPathPattern=__tests__/integration|\\.integration\\.');
      if (input.type === 'e2e')          args.push('--testPathPattern=__tests__/e2e|\\.e2e\\.');

      // Results file inside the workspace so the sandbox can write it
      args.push('--json', `--outputFile=${path.join(cwd, '.jest-results.json')}`);
    }

    return { runner, args };
  }

  // ─── Result parsers ───────────────────────────────────────────────────────

  private parseJestJson(json: any, raw: string, type: string, duration_ms: number): TestResult {
    const failures: TestFailure[] = [];
    for (const suite of json.testResults ?? []) {
      for (const test of suite.testResults ?? []) {
        if (test.status === 'failed') {
          failures.push({
            test_name: test.fullName,
            message:   (test.failureMessages ?? []).join('\n').slice(0, 2000),
          });
        }
      }
    }
    return {
      type,
      passed:        json.success ?? false,
      total:         json.numTotalTests ?? 0,
      passed_count:  json.numPassedTests ?? 0,
      failed_count:  json.numFailedTests ?? 0,
      skipped_count: json.numPendingTests ?? 0,
      coverage:      json.coverageMap ? this.parseCoverage(json.coverageMap) : undefined,
      failures,
      duration_ms,
      raw_output:    raw.slice(0, 5000),
      sandboxed:     !!this.sandbox,
    };
  }

  private parseRawOutput(output: string, type: string, duration_ms: number): TestResult {
    const passed_count = parseInt(output.match(/(\d+) passed/)?.[1] ?? '0');
    const failed_count = parseInt(output.match(/(\d+) failed/)?.[1] ?? '0');
    const total        = parseInt(output.match(/Tests:\s+(\d+)/)?.[1] ?? '0') || passed_count + failed_count;
    const failures: TestFailure[] = [];
    for (const m of output.matchAll(/● (.+?)\n\n([\s\S]+?)(?=\n● |\n\n─|$)/g)) {
      failures.push({ test_name: m[1].trim(), message: m[2].trim().slice(0, 1000) });
    }
    return {
      type, passed: failed_count === 0 && passed_count > 0,
      total, passed_count, failed_count, skipped_count: 0,
      failures, duration_ms, raw_output: output.slice(0, 5000), sandboxed: !!this.sandbox,
    };
  }

  private parseCoverage(coverageMap: any): CoverageResult {
    let tL = 0, cL = 0, tS = 0, cS = 0, tF = 0, cF = 0, tB = 0, cB = 0;
    for (const file of Object.values(coverageMap) as any[]) {
      for (const [k, n] of Object.entries(file.s ?? {})) {
        tS++; if ((n as number) > 0) cS++;
        const line = file.statementMap?.[k]?.start?.line;
        if (line) { tL = Math.max(tL, line); if ((n as number) > 0) cL++; }
      }
      for (const n of Object.values(file.f ?? {})) { tF++; if ((n as number) > 0) cF++; }
      for (const counts of Object.values(file.b ?? {}) as number[][]) {
        for (const n of counts) { tB++; if (n > 0) cB++; }
      }
    }
    const pct = (c: number, t: number) => (t > 0 ? Math.round((c / t) * 100) : 0);
    return { lines: pct(cL, tL), statements: pct(cS, tS), functions: pct(cF, tF), branches: pct(cB, tB) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private hostToContainer(hostPath: string): string {
    const rel = path.relative(this.workspaceDir, hostPath);
    return rel === '' ? '/workspace' : `/workspace/${rel}`;
  }

  private assertInWorkspace(resolved: string): void {
    const prefix = this.workspaceDir.endsWith(path.sep) ? this.workspaceDir : this.workspaceDir + path.sep;
    if (resolved !== this.workspaceDir && !resolved.startsWith(prefix)) {
      throw new Error('Access denied: test directory is outside the workspace.');
    }
  }
}
