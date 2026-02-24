import * as path from 'path';
import { spawn } from 'child_process';
import { logger } from '../logger';
import type { RunCIInput } from './schemas';

// The `act` command used to run GitHub Actions workflows locally.
// Flags are fixed to the user-specified runner image and architecture.
const ACT_BIN = 'act';
const ACT_BASE_ARGS = [
  '-P', 'ubuntu-latest=ghcr.io/catthehacker/ubuntu:full-latest',
  '--container-architecture', 'linux/amd64',
];

// How much of the tail to keep as raw_output.
// Failures almost always appear at the end; the head is dominated by
// docker-pull progress bars, apt-get installs, and other setup noise.
const RAW_OUTPUT_TAIL_BYTES = 30_000;  // 30 KB tail
const FAILURE_SUMMARY_MAX_BYTES = 25_000; // 25 KB for extracted failure blocks

export interface CIResult {
  passed: boolean;
  exitCode: number;
  /** Tail of the combined stdout+stderr (last ~30 KB). Failures appear here. */
  raw_output: string;
  /** Structured extraction of every failure block found in the full output. */
  failure_summary: string;
  /** Individual failure lines, deduplicated. */
  failures: string[];
  total_output_bytes: number;
  duration_ms: number;
  workflow?: string;
  job?: string;
}

export class CITool {
  constructor(private readonly workspaceDir: string) {}

  async runCI(input: RunCIInput): Promise<CIResult> {
    const cwd = input.directory
      ? path.resolve(this.workspaceDir, input.directory.replace(/^[/\\]+/, ''))
      : this.workspaceDir;

    logger.info('Running local CI via act', {
      cwd,
      workflow: input.workflow,
      job: input.job,
    });

    const start = Date.now();

    const args = [...ACT_BASE_ARGS];
    if (input.workflow) {
      args.push('--workflows', input.workflow);
    }
    if (input.job) {
      args.push('--job', input.job);
    }

    const { stdout, stderr, exitCode } = await this.runProcess(
      ACT_BIN,
      args,
      cwd,
      input.timeout,
    );

    const duration_ms = Date.now() - start;
    // Combine stdout first, stderr second — act writes progress to stderr and
    // step output to stdout, so interleaving order doesn't matter much here.
    const combined = stdout + '\n' + stderr;
    const total_output_bytes = combined.length;

    const passed = exitCode === 0;

    // Extract structured failure info from the FULL output before any truncation.
    const failure_summary = this.extractFailureSections(combined);
    const failures = this.parseFailureLines(combined);

    logger.info('Local CI run complete', {
      passed,
      exitCode,
      duration_ms,
      total_output_bytes,
      failure_sections_bytes: failure_summary.length,
    });

    if (!passed) {
      logger.warn('CI failed', { failures: failures.slice(0, 10), exitCode });
    }

    // Keep only the TAIL of the raw output. CI output has this rough structure:
    //   [head]  docker pull / apt-get / npm install (setup noise — rarely useful for diagnosis)
    //   [tail]  build output / test runner output / failure messages  ← what matters
    const raw_output = total_output_bytes > RAW_OUTPUT_TAIL_BYTES
      ? `[...${total_output_bytes - RAW_OUTPUT_TAIL_BYTES} bytes of setup output omitted — see failure_summary for extracted errors...]\n\n` +
        combined.slice(-RAW_OUTPUT_TAIL_BYTES)
      : combined;

    return {
      passed,
      exitCode,
      raw_output,
      failure_summary,
      failures,
      total_output_bytes,
      duration_ms,
      workflow: input.workflow,
      job: input.job,
    };
  }

  // ─── Failure section extractor ─────────────────────────────────────────────
  // Scans the full output and pulls out every block that contains a failure
  // indicator, keeping a window of context lines around it.  This runs on the
  // FULL (uncapped) output so no failure can be hidden by truncation.

  private extractFailureSections(output: string): string {
    const lines = output.split('\n');
    const sections: string[] = [];
    let i = 0;

    while (i < lines.length) {
      if (this.isFailureLine(lines[i])) {
        // Collect the failure block: up to 5 lines of preceding context,
        // the failing line itself, and up to 40 lines of following context
        // (enough to capture a full stack trace or test failure block).
        const blockStart = Math.max(0, i - 5);
        let blockEnd = i + 1;

        // Extend the block while we're still in step output or seeing more
        // failure-related content (act prefixes step output with "  | ").
        while (
          blockEnd < lines.length &&
          blockEnd - i < 40 &&
          (
            /^\s*\|/.test(lines[blockEnd]) ||        // act step output
            /^\s+(at |Error|FAIL|\d+ (passing|failing|pending))/.test(lines[blockEnd]) ||
            lines[blockEnd].trim() === '' && blockEnd - i < 10  // blank lines within block
          )
        ) {
          blockEnd++;
        }

        sections.push(lines.slice(blockStart, blockEnd).join('\n'));
        i = blockEnd;
      } else {
        i++;
      }
    }

    if (sections.length === 0) {
      return '';
    }

    const joined = sections.join('\n\n─────\n\n');
    if (joined.length <= FAILURE_SUMMARY_MAX_BYTES) {
      return joined;
    }

    // If the extracted sections themselves exceed the cap, keep the last portion
    // (later sections = deeper in the run = closer to the actual failures).
    return (
      `[...${joined.length - FAILURE_SUMMARY_MAX_BYTES} bytes of earlier failure sections omitted...]\n\n` +
      joined.slice(-FAILURE_SUMMARY_MAX_BYTES)
    );
  }

  private isFailureLine(line: string): boolean {
    return (
      // act step failure icon
      line.includes('❌') ||
      // jest/vitest "FAILED <file>"
      /\bFAILED\b/.test(line) ||
      // jest "FAIL <file>" (but not "FAIL 0 skipped" noise)
      (/\bFAIL\b/.test(line) && !/\bFAIL\b\s*\d+\s*skip/i.test(line)) ||
      // act job failure summary
      /\bfailed with exit code\b/i.test(line) ||
      // jest individual test failure marker (● TestName)
      /●\s+\S/.test(line) ||
      // mocha/vitest numbered failures: "  1) test name"
      /^\s*\d+\)\s+\w/.test(line) ||
      // common error types
      /\b(AssertionError|SyntaxError|ReferenceError|RangeError)\b/.test(line) ||
      // TypeError — avoid matching variable names containing "TypeError"
      /(?<!\w)TypeError(?!\w)/.test(line) ||
      // TypeScript compiler errors: "error TS2345:"
      /\berror TS\d+\b/.test(line) ||
      // generic "Error: <message>"
      /\bError:\s/.test(line) ||
      // Python tracebacks
      /Traceback \(most recent/.test(line) ||
      // "exited with <nonzero>" from act
      /\bexited with\s+[1-9]/.test(line)
    );
  }

  // ─── Simple failure line extractor ────────────────────────────────────────
  // Returns deduplicated single-line summaries — compact list for quick scanning.

  private parseFailureLines(output: string): string[] {
    const seen = new Set<string>();
    const failures: string[] = [];

    for (const line of output.split('\n')) {
      if (!this.isFailureLine(line)) continue;

      const trimmed = line.trim();
      if (!trimmed || seen.has(trimmed)) continue;

      seen.add(trimmed);
      failures.push(trimmed.slice(0, 400));

      if (failures.length >= 60) break;
    }

    return failures;
  }

  // ─── Process runner ────────────────────────────────────────────────────────

  private async runProcess(
    bin: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB in-memory cap (before our own truncation)

    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false;
      let stdoutCapped = false, stderrCapped = false;

      const child = spawn(bin, args, {
        cwd,
        shell: false,
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000);
        logger.warn('CI run timed out', { timeout, cwd });
      }, timeout);

      child.stdout.on('data', (d: Buffer) => {
        if (!stdoutCapped) {
          stdout += d.toString();
          if (stdout.length > MAX_OUTPUT) {
            stdout = stdout.slice(0, MAX_OUTPUT) + '\n[PROCESS OUTPUT CAPPED AT 10MB]';
            stdoutCapped = true;
          }
        }
      });

      child.stderr.on('data', (d: Buffer) => {
        if (!stderrCapped) {
          stderr += d.toString();
          if (stderr.length > MAX_OUTPUT) {
            stderr = stderr.slice(0, MAX_OUTPUT) + '\n[PROCESS OUTPUT CAPPED AT 10MB]';
            stderrCapped = true;
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            '`act` is not installed or not in PATH. ' +
            'Install it from https://github.com/nektos/act and ensure it is accessible.',
          ));
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        logger.debug('CI process exited', { exitCode: code, timedOut });
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
        });
      });
    });
  }
}
