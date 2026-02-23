import * as path from 'path';
import * as fs from 'fs-extra';
import { BuildTool } from './BuildTool';
import { logger } from '../logger';

// ─── Why ShellTool is gone ────────────────────────────────────────────────────
// The previous implementation passed ShellTool a whitelist that included 'sh',
// which is a full shell interpreter. This file now:
//   1. Uses BuildTool.npmRun() for the build step (typed, workspace-confined)
//   2. Spawns the Netlify CLI directly via child_process (no shell, no whitelist)
// The Netlify auth token is passed as an environment variable to the child
// process, not interpolated into a command string.

const NETLIFY_CLI = 'npx'; // always uses the project-local netlify-cli via npx

export interface DeployResult {
  success:   boolean;
  url?:      string;
  deployId?: string;
  logs:      string;
}

export interface DeployOptions {
  workspaceDir:    string;
  siteId?:         string;
  authToken?:      string;
  buildCommand?:   string;   // npm script name, e.g. "build" (NOT a raw command string)
  publishDir?:     string;
  environment?:    'production' | 'preview';
}

export async function deployToNetlify(options: DeployOptions): Promise<DeployResult> {
  const {
    workspaceDir,
    siteId,
    authToken,
    buildCommand = 'build',   // defaults to the "build" npm script
    publishDir   = 'dist',
    environment  = 'preview',
  } = options;

  logger.info('Starting Netlify deployment', { siteId, environment, publishDir });

  const buildTool = new BuildTool(workspaceDir);
  let logs = '';

  // ── Step 1: Build via BuildTool.npmRun ─────────────────────────────────────
  // npmRun validates the script exists in package.json before spawning.
  // No raw command string is ever constructed.
  logger.info('Running build script', { script: buildCommand });

  const buildResult = await buildTool.npmRun({
    script:     buildCommand,
    packageDir: '.',
    timeout:    300_000,
  });

  logs += `=== BUILD (npm run ${buildCommand}) ===\n${buildResult.stdout}\n${buildResult.stderr}\n`;

  if (!buildResult.success) {
    logger.error('Build failed', { stderr: buildResult.stderr.slice(0, 500) });
    return { success: false, logs };
  }

  // ── Step 2: Verify publish directory exists before deploying ──────────────
  const resolvedPublishDir = path.resolve(workspaceDir, publishDir.replace(/^[/\\]+/, ''));
  const publishPrefix = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  if (!resolvedPublishDir.startsWith(publishPrefix)) {
    throw new Error(`publishDir "${publishDir}" is outside the workspace.`);
  }
  if (!(await fs.pathExists(resolvedPublishDir))) {
    return {
      success: false,
      logs: logs + `\nPublish directory "${publishDir}" does not exist after build.\n`,
    };
  }

  // ── Step 3: Deploy via Netlify CLI ────────────────────────────────────────
  // Arguments are an array — never a concatenated string.
  // The auth token is an env var, not a --auth flag, so it never appears in
  // process args (which are visible via ps/top) or in log entries.
  const deployArgs = [
    'netlify',
    'deploy',
    `--dir=${resolvedPublishDir}`,
    '--json',
  ];
  if (siteId)                      deployArgs.push(`--site=${siteId}`);
  if (environment === 'production') deployArgs.push('--prod');

  logger.info('Deploying to Netlify', { publishDir: resolvedPublishDir, environment, siteId });

  const deployResult = await spawnProcess(
    NETLIFY_CLI,
    deployArgs,
    workspaceDir,
    120_000,
    authToken ? { NETLIFY_AUTH_TOKEN: authToken } : {}
  );

  logs += `\n=== DEPLOY ===\n${deployResult.stdout}\n${deployResult.stderr}\n`;

  if (!deployResult.success) {
    logger.error('Netlify deploy failed', { stderr: deployResult.stderr.slice(0, 500) });
    return { success: false, logs };
  }

  // ── Step 4: Parse JSON output from Netlify CLI ────────────────────────────
  let deployId: string | undefined;
  let url: string | undefined;

  try {
    const jsonMatch = deployResult.stdout.match(/\{[\s\S]+\}/);
    if (jsonMatch) {
      const json = JSON.parse(jsonMatch[0]);
      deployId = json.deploy_id as string | undefined;
      url      = (json.deploy_url ?? json.url) as string | undefined;
    }
  } catch {
    // Fallback: extract URL from stdout with regex
    const urlMatch = deployResult.stdout.match(/https:\/\/[^\s]+\.netlify\.app[^\s]*/);
    if (urlMatch) url = urlMatch[0];
  }

  logger.info('Deployment successful', { deployId, url, environment });
  return { success: true, url, deployId, logs };
}

// ─── Internal spawn helper ────────────────────────────────────────────────────

interface SpawnResult {
  success:  boolean;
  stdout:   string;
  stderr:   string;
}

async function spawnProcess(
  bin:      string,
  args:     string[],
  cwd:      string,
  timeout:  number,
  extraEnv: Record<string, string>,
): Promise<SpawnResult> {
  const { spawn } = await import('child_process');
  const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap per stream

  return new Promise((resolve, reject) => {
    let stdout       = '';
    let stderr       = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut     = false;

    const child = spawn(bin, args, {
      cwd,
      shell: false,  // args passed directly — no shell interpretation
      env: {
        ...process.env,
        ...extraEnv,
        // Ensure PATH injection via extraEnv cannot substitute a different binary
        PATH: process.env.PATH,
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
      logger.warn('Deploy process timed out', { bin, timeout });
    }, timeout);

    child.stdout.on('data', (d: Buffer) => {
      if (!stdoutCapped) {
        stdout += d.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT) + '\n[TRUNCATED]';
          stdoutCapped = true;
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (!stderrCapped) {
        stderr += d.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT) + '\n[TRUNCATED]';
          stderrCapped = true;
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: !timedOut && code === 0, stdout, stderr });
    });
  });
}
