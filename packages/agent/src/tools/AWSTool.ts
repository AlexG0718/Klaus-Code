/**
 * AWS Deployment Tool
 * 
 * Deploys static sites to AWS S3 with optional CloudFront CDN integration.
 * Uses the AWS CLI for deployment (aws s3 sync).
 * 
 * Security:
 * - AWS credentials from environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * - No shell execution (spawn with explicit args)
 * - Path traversal protection
 * - Bucket name validation
 * - No sensitive data in logs
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { logger } from '../logger';
import { BuildTool } from './BuildTool';
import type { AWSS3DeployInput } from './schemas';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AWSS3DeployResult {
  success: boolean;
  bucketUrl?: string;
  cloudFrontUrl?: string;
  invalidationId?: string;
  filesUploaded?: number;
  logs: string;
  error?: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

// S3 bucket naming rules
function isValidBucketName(name: string): boolean {
  // Must be 3-63 characters, lowercase, numbers, hyphens
  // Cannot start/end with hyphen, no consecutive periods
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) && 
         !name.includes('..') &&
         !name.includes('.-') &&
         !name.includes('-.');
}

// AWS region validation
function isValidRegion(region: string): boolean {
  return /^[a-z]{2}-[a-z]+-\d+$/.test(region);
}

// CloudFront distribution ID validation
function isValidDistributionId(id: string): boolean {
  return /^[A-Z0-9]+$/.test(id);
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function deployToS3(
  input: AWSS3DeployInput,
  workspaceDir: string
): Promise<AWSS3DeployResult> {
  const {
    directory = '.',
    bucketName,
    buildDir = 'dist',
    region = 'us-east-1',
    buildCommand,
    cloudFrontDistributionId,
    deleteExisting = true,
  } = input;

  // ── Security: Validate inputs ───────────────────────────────────────────────
  if (!isValidBucketName(bucketName)) {
    return {
      success: false,
      logs: '',
      error: `Invalid S3 bucket name: "${bucketName}". Bucket names must be 3-63 characters, ` +
             `contain only lowercase letters, numbers, and hyphens, and cannot start/end with a hyphen.`,
    };
  }

  if (!isValidRegion(region)) {
    return {
      success: false,
      logs: '',
      error: `Invalid AWS region: "${region}". Expected format like "us-east-1".`,
    };
  }

  if (cloudFrontDistributionId && !isValidDistributionId(cloudFrontDistributionId)) {
    return {
      success: false,
      logs: '',
      error: `Invalid CloudFront distribution ID: "${cloudFrontDistributionId}".`,
    };
  }

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

  // ── Check for AWS credentials ───────────────────────────────────────────────
  const hasCredentials = !!(
    process.env.AWS_ACCESS_KEY_ID && 
    process.env.AWS_SECRET_ACCESS_KEY
  ) || !!(
    process.env.AWS_PROFILE
  ) || !!(
    process.env.AWS_ROLE_ARN  // IAM role assumption
  );

  if (!hasCredentials) {
    return {
      success: false,
      logs: '',
      error: 'AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, ' +
             'or configure AWS_PROFILE, or use IAM role-based authentication.',
    };
  }

  logger.info('Starting AWS S3 deployment', {
    directory,
    bucketName,
    region,
    buildDir,
    hasCloudFront: !!cloudFrontDistributionId,
  });

  let logs = '';

  // ── Step 1: Build (optional) ────────────────────────────────────────────────
  if (buildCommand) {
    logger.info('Running build command', { buildCommand });
    
    const buildTool = new BuildTool(workspaceDir);
    const buildResult = await buildTool.npmRun({
      script: buildCommand.replace(/^npm run\s*/i, ''),
      packageDir: directory,
      timeout: 300_000,
    });

    logs += `=== BUILD ===\n${buildResult.stdout}\n${buildResult.stderr}\n\n`;

    if (!buildResult.success) {
      logger.error('Build failed', { stderr: buildResult.stderr.slice(0, 500) });
      return { success: false, logs, error: 'Build failed' };
    }
  }

  // ── Step 2: Verify build directory exists ───────────────────────────────────
  const buildPath = path.resolve(projectDir, buildDir.replace(/^[/\\]+/, ''));
  const buildPrefix = projectDir.endsWith(path.sep) ? projectDir : projectDir + path.sep;

  if (!buildPath.startsWith(buildPrefix) && buildPath !== projectDir) {
    return {
      success: false,
      logs,
      error: `Build directory "${buildDir}" is outside the project directory.`,
    };
  }

  if (!(await fs.pathExists(buildPath))) {
    return {
      success: false,
      logs,
      error: `Build directory "${buildDir}" does not exist.`,
    };
  }

  // ── Step 3: Sync to S3 ──────────────────────────────────────────────────────
  logger.info('Syncing to S3', { buildPath, bucketName });

  const s3Args: string[] = [
    's3', 'sync',
    buildPath,
    `s3://${bucketName}`,
    '--region', region,
  ];

  if (deleteExisting) {
    s3Args.push('--delete');
  }

  const s3Result = await spawnAWS(s3Args, projectDir);
  logs += `=== S3 SYNC ===\n${s3Result.stdout}\n${s3Result.stderr}\n\n`;

  if (!s3Result.success) {
    logger.error('S3 sync failed', { stderr: s3Result.stderr.slice(0, 500) });
    return { success: false, logs, error: 'S3 sync failed: ' + s3Result.stderr };
  }

  // Count uploaded files from output
  const uploadMatches = s3Result.stdout.match(/upload:/g);
  const filesUploaded = uploadMatches ? uploadMatches.length : 0;

  // ── Step 4: CloudFront invalidation (optional) ──────────────────────────────
  let invalidationId: string | undefined;

  if (cloudFrontDistributionId) {
    logger.info('Creating CloudFront invalidation', { distributionId: cloudFrontDistributionId });

    const cfArgs: string[] = [
      'cloudfront', 'create-invalidation',
      '--distribution-id', cloudFrontDistributionId,
      '--paths', '/*',
    ];

    const cfResult = await spawnAWS(cfArgs, projectDir);
    logs += `=== CLOUDFRONT INVALIDATION ===\n${cfResult.stdout}\n${cfResult.stderr}\n\n`;

    if (cfResult.success) {
      // Parse invalidation ID from output
      try {
        const json = JSON.parse(cfResult.stdout);
        invalidationId = json.Invalidation?.Id;
      } catch {
        const idMatch = cfResult.stdout.match(/"Id":\s*"([^"]+)"/);
        if (idMatch) invalidationId = idMatch[1];
      }
    } else {
      // Non-fatal: deployment succeeded, just invalidation failed
      logger.warn('CloudFront invalidation failed', { stderr: cfResult.stderr.slice(0, 500) });
      logs += 'Warning: CloudFront invalidation failed, but S3 deployment succeeded.\n';
    }
  }

  // ── Build result URLs ───────────────────────────────────────────────────────
  const bucketUrl = `http://${bucketName}.s3-website-${region}.amazonaws.com`;
  
  // If CloudFront is configured, we'd need to look up the domain
  // For now, indicate that CloudFront is configured but don't guess the URL
  const cloudFrontUrl = cloudFrontDistributionId 
    ? `CloudFront distribution ${cloudFrontDistributionId} updated`
    : undefined;

  logger.info('AWS S3 deployment successful', {
    bucketUrl,
    filesUploaded,
    invalidationId,
  });

  return {
    success: true,
    bucketUrl,
    cloudFrontUrl,
    invalidationId,
    filesUploaded,
    logs,
  };
}

// ─── Internal spawn helper ───────────────────────────────────────────────────

interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function spawnAWS(
  args: string[],
  cwd: string
): Promise<SpawnResult> {
  const MAX_OUTPUT = 5 * 1024 * 1024; // 5MB cap per stream
  const TIMEOUT = 300_000; // 5 minutes

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;

    // AWS credentials come from environment - we pass them through
    // but ensure PATH cannot be overridden
    const env = {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    };

    const child = spawn('aws', args, {
      cwd,
      shell: false,  // No shell interpretation
      env: env as NodeJS.ProcessEnv,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
      logger.warn('AWS CLI command timed out', { args: args.slice(0, 3) });
    }, TIMEOUT);

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
      // If AWS CLI is not installed, provide helpful error
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({
          success: false,
          stdout: '',
          stderr: 'AWS CLI is not installed. Please install it from https://aws.amazon.com/cli/',
        });
      } else {
        reject(err);
      }
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
