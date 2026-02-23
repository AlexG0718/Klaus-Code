/**
 * Terraform Tool
 * 
 * Executes Terraform commands for infrastructure as code management.
 * Supports init, plan, apply, destroy, and output commands.
 * 
 * Security:
 * - Path traversal protection for all directories
 * - Variable validation (no shell metacharacters)
 * - Sensitive output filtering
 * - No shell execution
 * - Approval gate for destructive operations
 * - tfvars file validation
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { logger } from '../logger';
import type {
  TerraformInitInput,
  TerraformPlanInput,
  TerraformApplyInput,
  TerraformDestroyInput,
  TerraformOutputInput,
} from './schemas';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TerraformResult {
  success: boolean;
  output?: string;
  planSummary?: {
    add: number;
    change: number;
    destroy: number;
  };
  outputs?: Record<string, any>;
  error?: string;
  requiresApproval?: boolean;
}

// ─── Sensitive Patterns to Filter ────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /password\s*=\s*"[^"]+"/gi,
  /secret\s*=\s*"[^"]+"/gi,
  /api_key\s*=\s*"[^"]+"/gi,
  /access_key\s*=\s*"[^"]+"/gi,
  /private_key\s*=\s*"[^"]+"/gi,
  /token\s*=\s*"[^"]+"/gi,
  /AWS_SECRET_ACCESS_KEY\s*=\s*\S+/gi,
];

function filterSensitiveOutput(output: string): string {
  let filtered = output;
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, '[REDACTED]');
  }
  return filtered;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function isValidVarName(name: string): boolean {
  // Terraform variable names: letters, digits, underscores, hyphens
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name);
}

function isValidVarValue(value: string): boolean {
  // Block shell metacharacters and command injection
  const dangerous = /[;&|`$(){}[\]<>\\!]/;
  return !dangerous.test(value);
}

function validateDirectory(
  dir: string,
  workspaceDir: string
): { valid: boolean; resolved: string; error?: string } {
  const resolved = path.resolve(workspaceDir, dir.replace(/^[/\\]+/, ''));
  const prefix = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  
  if (!resolved.startsWith(prefix) && resolved !== workspaceDir) {
    return {
      valid: false,
      resolved,
      error: `Directory "${dir}" is outside the workspace.`,
    };
  }
  
  return { valid: true, resolved };
}

// ─── terraform init ──────────────────────────────────────────────────────────

export async function terraformInit(
  input: TerraformInitInput,
  workspaceDir: string
): Promise<TerraformResult> {
  const { directory = 'terraform', upgrade = false, reconfigure = false } = input;

  // Validate directory
  const dirCheck = validateDirectory(directory, workspaceDir);
  if (!dirCheck.valid) {
    return { success: false, error: dirCheck.error };
  }

  // Check directory exists and contains .tf files
  if (!(await fs.pathExists(dirCheck.resolved))) {
    return { success: false, error: `Directory "${directory}" does not exist.` };
  }

  const tfFiles = await fs.readdir(dirCheck.resolved);
  if (!tfFiles.some(f => f.endsWith('.tf'))) {
    return { success: false, error: `No Terraform files (*.tf) found in "${directory}".` };
  }

  logger.info('Running terraform init', { directory, upgrade, reconfigure });

  const args = ['init', '-input=false'];
  if (upgrade) args.push('-upgrade');
  if (reconfigure) args.push('-reconfigure');

  const result = await spawnTerraform(args, dirCheck.resolved);

  return {
    success: result.success,
    output: filterSensitiveOutput(result.stdout + '\n' + result.stderr),
    error: result.success ? undefined : filterSensitiveOutput(result.stderr),
  };
}

// ─── terraform plan ──────────────────────────────────────────────────────────

export async function terraformPlan(
  input: TerraformPlanInput,
  workspaceDir: string
): Promise<TerraformResult> {
  const { 
    directory = 'terraform', 
    vars = {}, 
    varFile, 
    destroy = false,
    out = 'tfplan',
  } = input;

  // Validate directory
  const dirCheck = validateDirectory(directory, workspaceDir);
  if (!dirCheck.valid) {
    return { success: false, error: dirCheck.error };
  }

  if (!(await fs.pathExists(dirCheck.resolved))) {
    return { success: false, error: `Directory "${directory}" does not exist.` };
  }

  // Validate vars
  for (const [key, value] of Object.entries(vars)) {
    if (!isValidVarName(key)) {
      return { success: false, error: `Invalid variable name: "${key}"` };
    }
    if (!isValidVarValue(value)) {
      return { success: false, error: `Invalid characters in variable "${key}". Shell metacharacters are not allowed.` };
    }
  }

  // Validate varFile if provided
  if (varFile) {
    const varFilePath = path.resolve(dirCheck.resolved, varFile.replace(/^[/\\]+/, ''));
    if (!varFilePath.startsWith(dirCheck.resolved)) {
      return { success: false, error: `Variable file "${varFile}" is outside the terraform directory.` };
    }
    if (!(await fs.pathExists(varFilePath))) {
      return { success: false, error: `Variable file "${varFile}" does not exist.` };
    }
  }

  logger.info('Running terraform plan', { directory, destroy, varsCount: Object.keys(vars).length });

  const args = ['plan', '-input=false', `-out=${out}`];
  if (destroy) args.push('-destroy');
  
  for (const [key, value] of Object.entries(vars)) {
    args.push('-var', `${key}=${value}`);
  }
  
  if (varFile) {
    args.push('-var-file', varFile);
  }

  const result = await spawnTerraform(args, dirCheck.resolved);

  // Parse plan summary
  let planSummary: { add: number; change: number; destroy: number } | undefined;
  const summaryMatch = result.stdout.match(/(\d+) to add, (\d+) to change, (\d+) to destroy/);
  if (summaryMatch) {
    planSummary = {
      add: parseInt(summaryMatch[1], 10),
      change: parseInt(summaryMatch[2], 10),
      destroy: parseInt(summaryMatch[3], 10),
    };
  }

  return {
    success: result.success,
    output: filterSensitiveOutput(result.stdout + '\n' + result.stderr),
    planSummary,
    error: result.success ? undefined : filterSensitiveOutput(result.stderr),
  };
}

// ─── terraform apply ─────────────────────────────────────────────────────────

export async function terraformApply(
  input: TerraformApplyInput,
  workspaceDir: string
): Promise<TerraformResult> {
  const { 
    directory = 'terraform', 
    planFile, 
    autoApprove = false,
    vars = {},
    varFile,
  } = input;

  // Validate directory
  const dirCheck = validateDirectory(directory, workspaceDir);
  if (!dirCheck.valid) {
    return { success: false, error: dirCheck.error };
  }

  if (!(await fs.pathExists(dirCheck.resolved))) {
    return { success: false, error: `Directory "${directory}" does not exist.` };
  }

  // ── Security gate: require explicit approval for apply ──────────────────────
  if (!autoApprove && !planFile) {
    return {
      success: false,
      requiresApproval: true,
      error: 'terraform apply requires either a saved plan file or autoApprove=true. ' +
             'For safety, run terraform_plan first to review changes, then apply the saved plan.',
    };
  }

  // Validate planFile if provided
  if (planFile) {
    const planFilePath = path.resolve(dirCheck.resolved, planFile.replace(/^[/\\]+/, ''));
    if (!planFilePath.startsWith(dirCheck.resolved)) {
      return { success: false, error: `Plan file "${planFile}" is outside the terraform directory.` };
    }
    if (!(await fs.pathExists(planFilePath))) {
      return { success: false, error: `Plan file "${planFile}" does not exist. Run terraform_plan first.` };
    }
  }

  // Validate vars
  for (const [key, value] of Object.entries(vars)) {
    if (!isValidVarName(key)) {
      return { success: false, error: `Invalid variable name: "${key}"` };
    }
    if (!isValidVarValue(value)) {
      return { success: false, error: `Invalid characters in variable "${key}".` };
    }
  }

  logger.info('Running terraform apply', { 
    directory, 
    planFile, 
    autoApprove,
    varsCount: Object.keys(vars).length,
  });

  const args = ['apply', '-input=false'];
  
  if (planFile) {
    // When applying a saved plan, we just pass the plan file
    args.push(planFile);
  } else if (autoApprove) {
    // Auto-approve without a plan (use with caution)
    args.push('-auto-approve');
    
    for (const [key, value] of Object.entries(vars)) {
      args.push('-var', `${key}=${value}`);
    }
    
    if (varFile) {
      args.push('-var-file', varFile);
    }
  }

  const result = await spawnTerraform(args, dirCheck.resolved, 600_000); // 10 min timeout for apply

  return {
    success: result.success,
    output: filterSensitiveOutput(result.stdout + '\n' + result.stderr),
    error: result.success ? undefined : filterSensitiveOutput(result.stderr),
  };
}

// ─── terraform destroy ───────────────────────────────────────────────────────

export async function terraformDestroy(
  input: TerraformDestroyInput,
  workspaceDir: string
): Promise<TerraformResult> {
  const { 
    directory = 'terraform', 
    autoApprove = false,
    vars = {},
    varFile,
  } = input;

  // Validate directory
  const dirCheck = validateDirectory(directory, workspaceDir);
  if (!dirCheck.valid) {
    return { success: false, error: dirCheck.error };
  }

  if (!(await fs.pathExists(dirCheck.resolved))) {
    return { success: false, error: `Directory "${directory}" does not exist.` };
  }

  // ── Security gate: always require explicit approval for destroy ─────────────
  if (!autoApprove) {
    return {
      success: false,
      requiresApproval: true,
      error: 'terraform destroy requires explicit autoApprove=true. ' +
             'This is a destructive operation that will delete infrastructure.',
    };
  }

  // Validate vars
  for (const [key, value] of Object.entries(vars)) {
    if (!isValidVarName(key)) {
      return { success: false, error: `Invalid variable name: "${key}"` };
    }
    if (!isValidVarValue(value)) {
      return { success: false, error: `Invalid characters in variable "${key}".` };
    }
  }

  logger.warn('Running terraform destroy', { directory, varsCount: Object.keys(vars).length });

  const args = ['destroy', '-input=false', '-auto-approve'];
  
  for (const [key, value] of Object.entries(vars)) {
    args.push('-var', `${key}=${value}`);
  }
  
  if (varFile) {
    args.push('-var-file', varFile);
  }

  const result = await spawnTerraform(args, dirCheck.resolved, 600_000); // 10 min timeout

  return {
    success: result.success,
    output: filterSensitiveOutput(result.stdout + '\n' + result.stderr),
    error: result.success ? undefined : filterSensitiveOutput(result.stderr),
  };
}

// ─── terraform output ────────────────────────────────────────────────────────

export async function terraformOutput(
  input: TerraformOutputInput,
  workspaceDir: string
): Promise<TerraformResult> {
  const { directory = 'terraform', name, json = true } = input;

  // Validate directory
  const dirCheck = validateDirectory(directory, workspaceDir);
  if (!dirCheck.valid) {
    return { success: false, error: dirCheck.error };
  }

  if (!(await fs.pathExists(dirCheck.resolved))) {
    return { success: false, error: `Directory "${directory}" does not exist.` };
  }

  // Validate output name if provided
  if (name && !isValidVarName(name)) {
    return { success: false, error: `Invalid output name: "${name}"` };
  }

  logger.info('Running terraform output', { directory, name, json });

  const args = ['output'];
  if (json) args.push('-json');
  if (name) args.push(name);

  const result = await spawnTerraform(args, dirCheck.resolved);

  let outputs: Record<string, any> | undefined;
  if (result.success && json) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed && typeof parsed === 'object') {
        // Filter sensitive outputs
        const filteredOutputs: Record<string, any> = {};
        for (const key of Object.keys(parsed)) {
          if (parsed[key]?.sensitive) {
            filteredOutputs[key] = { ...parsed[key], value: '[SENSITIVE]' };
          } else {
            filteredOutputs[key] = parsed[key];
          }
        }
        outputs = filteredOutputs;
      }
    } catch {
      // Not JSON, return as string
    }
  }

  return {
    success: result.success,
    output: filterSensitiveOutput(result.stdout),
    outputs,
    error: result.success ? undefined : filterSensitiveOutput(result.stderr),
  };
}

// ─── Internal spawn helper ───────────────────────────────────────────────────

interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function spawnTerraform(
  args: string[],
  cwd: string,
  timeout: number = 300_000
): Promise<SpawnResult> {
  const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB cap per stream

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;

    // Pass through AWS credentials and other env vars needed by Terraform
    const env = {
      ...process.env,
      // Force non-interactive mode
      TF_INPUT: '0',
      // Disable color for cleaner output
      TF_CLI_ARGS: '-no-color',
      // Ensure PATH cannot be overridden
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    };

    const child = spawn('terraform', args, {
      cwd,
      shell: false,  // No shell interpretation
      env: env as NodeJS.ProcessEnv,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10000);
      logger.warn('Terraform command timed out', { args: args.slice(0, 2), timeout });
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
      // If Terraform is not installed, provide helpful error
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({
          success: false,
          stdout: '',
          stderr: 'Terraform is not installed. Please install it from https://www.terraform.io/downloads',
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
