/**
 * Vercel Deployment Tool
 * 
 * Deploys projects to Vercel using the Vercel CLI.
 * 
 * Security:
 * - Auth token passed via environment variable (never in command args)
 * - No shell execution (spawn with explicit args)
 * - Path traversal protection
 * - Output truncation to prevent memory exhaustion
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { logger } from '../logger';
import type { VercelDeployInput } from './schemas';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VercelDeployResult {
  success: boolean;
  url?: string;
  previewUrl?: string;
  productionUrl?: string;
  projectName?: string;
  deploymentId?: string;
  logs: string;
  error?: string;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function deployToVercel(
  input: VercelDeployInput,
  workspaceDir: string,
  authToken?: string
): Promise<VercelDeployResult> {
  const {
    directory = '.',
    production = false,
    projectName,
    buildCommand,
    outputDirectory,
    env = {},
  } = input;

  // ── Security: Validate directory is within workspace ────────────────────────
  const projectDir = path.resolve(workspaceDir, directory.replace(/^[/\\]+/, ''));
  const workspacePrefix = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  
  if (!projectDir.startsWith(workspacePrefix) && projectDir !== workspaceDir) {
    return {
      success: false,
      logs: '',
      error: `Directory "${directory}" is outside the workspace.`,
    };
  }

  // ── Verify project directory exists ─────────────────────────────────────────
  if (!(await fs.pathExists(projectDir))) {
    return {
      success: false,
      logs: '',
      error: `Project directory "${directory}" does not exist.`,
    };
  }

  // ── Check for Vercel token ──────────────────────────────────────────────────
  const token = authToken || process.env.VERCEL_TOKEN;
  if (!token) {
    return {
      success: false,
      logs: '',
      error: 'VERCEL_TOKEN environment variable is not set. Please configure your Vercel authentication.',
    };
  }

  logger.info('Starting Vercel deployment', { 
    directory, 
    production, 
    projectName,
    hasToken: !!token,
  });

  // ── Build Vercel CLI arguments ──────────────────────────────────────────────
  // Arguments are an array — never a concatenated string
  const args: string[] = [
    'vercel',
    '--yes',  // Skip confirmation prompts
  ];

  if (production) {
    args.push('--prod');
  }

  if (projectName) {
    // Validate project name (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
      return {
        success: false,
        logs: '',
        error: 'Project name can only contain letters, numbers, hyphens, and underscores.',
      };
    }
    args.push('--name', projectName);
  }

  if (buildCommand) {
    args.push('--build-command', buildCommand);
  }

  if (outputDirectory) {
    args.push('--output-directory', outputDirectory);
  }

  // ── Prepare environment variables ───────────────────────────────────────────
  // Token is passed via env, not command line (security best practice)
  const deployEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    VERCEL_TOKEN: token,
    // Prevent PATH injection
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };

  // Add user-specified env vars (sanitized)
  for (const [key, value] of Object.entries(env)) {
    // Only allow safe env var names
    if (/^[A-Z][A-Z0-9_]*$/i.test(key) && key !== 'PATH' && key !== 'VERCEL_TOKEN') {
      deployEnv[key] = value;
    }
  }

  // ── Execute deployment ──────────────────────────────────────────────────────
  const result = await spawnProcess('npx', args, projectDir, 300_000, deployEnv);

  // ── Parse output ────────────────────────────────────────────────────────────
  let url: string | undefined;
  let previewUrl: string | undefined;
  let productionUrl: string | undefined;
  let deploymentId: string | undefined;
  let detectedProjectName: string | undefined;

  // Try to parse JSON output first
  try {
    const jsonMatch = result.stdout.match(/\{[\s\S]*"url"[\s\S]*\}/);
    if (jsonMatch) {
      const json = JSON.parse(jsonMatch[0]);
      url = json.url;
      deploymentId = json.id;
    }
  } catch {
    // Fallback: extract URLs from stdout
    const urlMatches = result.stdout.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/g);
    if (urlMatches && urlMatches.length > 0) {
      url = urlMatches[0];
      if (production && urlMatches.length > 1) {
        previewUrl = urlMatches[0];
        productionUrl = urlMatches[1];
      }
    }
  }

  // Extract project name if mentioned
  const projectMatch = result.stdout.match(/Linked to ([^\s]+)/);
  if (projectMatch) {
    detectedProjectName = projectMatch[1];
  }

  if (result.success) {
    logger.info('Vercel deployment successful', { 
      url, 
      production, 
      deploymentId,
      projectName: detectedProjectName || projectName,
    });
  } else {
    logger.error('Vercel deployment failed', { 
      stderr: result.stderr.slice(0, 500),
    });
  }

  return {
    success: result.success,
    url: url || productionUrl || previewUrl,
    previewUrl,
    productionUrl,
    projectName: detectedProjectName || projectName,
    deploymentId,
    logs: `${result.stdout}\n${result.stderr}`,
    error: result.success ? undefined : result.stderr || 'Deployment failed',
  };
}

// ─── Internal spawn helper ───────────────────────────────────────────────────

interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function spawnProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeout: number,
  env: Record<string, string>
): Promise<SpawnResult> {
  const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap per stream

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;

    const child = spawn(bin, args, {
      cwd,
      shell: false,  // No shell interpretation
      env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
      logger.warn('Vercel deployment timed out', { timeout });
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

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: !timedOut && code === 0,
        stdout,
        stderr,
      });
    });
  });
}
