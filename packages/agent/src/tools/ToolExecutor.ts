import { ZodSchema } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { FileTool }    from './FileTool';
import { BuildTool }   from './BuildTool';
import { LintTool }    from './LintTool';
import { ScriptTool }  from './ScriptTool';
import { GitTool }     from './GitTool';
import { TestTool }    from './TestTool';
import { CITool }      from './CITool';
import { deployToNetlify } from './DeployTool';
import { deployToVercel }  from './VercelTool';
import { deployToS3 }      from './AWSTool';
import { 
  terraformInit, 
  terraformPlan, 
  terraformApply, 
  terraformDestroy, 
  terraformOutput 
} from './TerraformTool';
import { generateInfrastructure } from './InfrastructureGenerator';
import { DockerSandbox }   from '../sandbox/DockerSandbox';
import {
  // File
  ReadFileSchema, WriteFileSchema, ApplyPatchSchema,
  DeleteFileSchema, ListFilesSchema, SearchFilesSchema,
  // Build
  NpmInstallSchema, NpmRunSchema, TscCheckSchema,
  // Lint
  EslintCheckSchema, PrettierFormatSchema,
  // Script
  RunNodeScriptSchema,
  // Git
  GitCheckpointSchema, GitDiffSchema, GitStatusSchema, GitPushSchema, GitPullSchema,
  GitBranchSchema, GitLogSchema, GitCloneSchema, GitMergeSchema, GitStashSchema,
  GitResetSchema, GitRemoteSchema,
  // Test
  RunTestsSchema,
  // CI
  RunCISchema,
  // Memory
  MemorySetSchema, MemoryGetSchema,
  // Deploy
  DeploySchema,
  VercelDeploySchema,
  AWSS3DeploySchema,
  TerraformInitSchema,
  TerraformPlanSchema,
  TerraformApplySchema,
  TerraformDestroySchema,
  TerraformOutputSchema,
  GenerateInfrastructureSchema,
} from './schemas';
import { DatabaseMemory } from '../memory/DatabaseMemory';
import { logger }         from '../logger';
import type { Config }    from '../config';

export interface ToolCall   { name: string; input: unknown; }
export interface ToolResult {
  toolCallId: string; toolName: string; result: unknown;
  success: boolean; error?: string; durationMs: number;
}

export interface ToolProgress {
  toolCallId: string;
  toolName: string;
  progress: number;  // 0-100
  status: string;
  elapsedMs: number;
}

export type ProgressCallback = (progress: ToolProgress) => void;

// Long-running tools that benefit from progress tracking
const LONG_RUNNING_TOOLS = new Set([
  'npm_install', 'npm_run', 'run_tests', 'git_clone',
  'run_ci',
  'deploy_netlify', 'deploy_vercel', 'deploy_aws_s3',
  'terraform_init', 'terraform_plan', 'terraform_apply', 'terraform_destroy',
  'generate_infrastructure',
  'tsc_check', 'eslint_check', 'prettier_format',
]);

// ─── Tool definitions (what Claude sees) ─────────────────────────────────────
// shell_command is intentionally absent. Every capability is now a typed tool.

export const TOOL_DEFINITIONS = [

  // ── File ──────────────────────────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Returns its content.',
    input_schema: {
      type: 'object',
      properties: {
        path:     { type: 'string', description: 'File path relative to workspace root.' },
        encoding: { type: 'string', enum: ['utf8', 'base64', 'hex'], default: 'utf8' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a new file. For existing files use apply_patch instead.',
    input_schema: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'File path relative to workspace root.' },
        content:    { type: 'string', description: 'Full file content to write.' },
        createDirs: { type: 'boolean', default: true },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to an existing file. Always prefer this over write_file for modifications.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'File path relative to workspace root.' },
        patch: { type: 'string', description: 'Valid unified diff patch string.' },
      },
      required: ['path', 'patch'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory from the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a workspace directory matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', default: '.' },
        pattern:   { type: 'string', default: '**/*' },
        ignore:    { type: 'array', items: { type: 'string' }, default: ['node_modules/**', '.git/**', 'dist/**'] },
        maxDepth:  { type: 'number', default: 5 },
      },
    },
  },
  {
    name: 'search_files',
    description: 'Search for a regex pattern across files in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', default: '.' },
        pattern:   { type: 'string', description: 'Regex pattern to search for.' },
        fileGlob:  { type: 'string', default: '**/*.{ts,tsx,js,jsx,json,md}' },
      },
      required: ['pattern'],
    },
  },

  // ── Build ─────────────────────────────────────────────────────────────────
  {
    name: 'npm_install',
    description:
      'Install npm dependencies. Call with no packages to run "npm install" from package.json. ' +
      'Call with a packages list to add specific packages.',
    input_schema: {
      type: 'object',
      properties: {
        packages:   { type: 'array', items: { type: 'string' }, default: [],
                      description: 'Package names to install. Empty = install from package.json.' },
        packageDir: { type: 'string', default: '.', description: 'Directory containing package.json.' },
        saveDev:    { type: 'boolean', default: false, description: 'Save as devDependency.' },
      },
    },
  },
  {
    name: 'npm_run',
    description:
      'Run a named script from the package.json "scripts" field. ' +
      'Only scripts that exist in package.json can be run — the tool verifies this before executing.',
    input_schema: {
      type: 'object',
      properties: {
        script:     { type: 'string', description: 'Script name (e.g. "build", "generate", "migrate").' },
        packageDir: { type: 'string', default: '.', description: 'Directory containing package.json.' },
        env:        { type: 'object', additionalProperties: { type: 'string' },
                      description: 'Extra environment variables for this script.' },
        timeout:    { type: 'number', default: 120000, description: 'Timeout ms. Increase for slow builds.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'tsc_check',
    description:
      'Run the TypeScript compiler to check for type errors (--noEmit by default). ' +
      'Always run this after modifying TypeScript files before creating a git checkpoint.',
    input_schema: {
      type: 'object',
      properties: {
        packageDir: { type: 'string', default: '.', description: 'Directory containing tsconfig.json.' },
        emitFiles:  { type: 'boolean', default: false, description: 'Emit compiled output. Default: type-check only.' },
      },
    },
  },

  // ── Lint ──────────────────────────────────────────────────────────────────
  {
    name: 'eslint_check',
    description:
      'Run ESLint on workspace files. Use fix:false to check only (default), fix:true to auto-fix. ' +
      'Run this before every git checkpoint to catch code quality issues.',
    input_schema: {
      type: 'object',
      properties: {
        paths:      { type: 'array', items: { type: 'string' }, default: ['.'],
                      description: 'Paths or globs to lint, relative to workspace root.' },
        fix:        { type: 'boolean', default: false, description: 'Auto-fix fixable issues.' },
        packageDir: { type: 'string', default: '.' },
      },
    },
  },
  {
    name: 'prettier_format',
    description:
      'Run Prettier on workspace files. Use check:false to format in-place (default), ' +
      'check:true to verify formatting without writing.',
    input_schema: {
      type: 'object',
      properties: {
        paths:      { type: 'array', items: { type: 'string' }, default: ['.'],
                      description: 'Paths or globs to format, relative to workspace root.' },
        check:      { type: 'boolean', default: false, description: 'Check only — do not write files.' },
        packageDir: { type: 'string', default: '.' },
      },
    },
  },

  // ── Script ────────────────────────────────────────────────────────────────
  {
    name: 'run_node_script',
    description:
      'Execute a specific .js or .ts file inside the workspace using node or ts-node. ' +
      'Use this for one-off scripts like database seeds, migrations, or code generators ' +
      'that are not covered by a named npm script. ' +
      'The script MUST exist inside the workspace — no external paths allowed.',
    input_schema: {
      type: 'object',
      properties: {
        scriptPath: { type: 'string', description: 'Path to the script, relative to workspace root.' },
        args:       { type: 'array', items: { type: 'string' }, default: [],
                      description: 'Arguments to pass to the script.' },
        env:        { type: 'object', additionalProperties: { type: 'string' } },
        timeout:    { type: 'number', default: 60000 },
        useTsNode:  { type: 'boolean', default: false,
                      description: 'Use ts-node for direct TypeScript execution without pre-compiling.' },
      },
      required: ['scriptPath'],
    },
  },

  // ── Git ───────────────────────────────────────────────────────────────────
  {
    name: 'git_checkpoint',
    description:
      'Create a git commit. MUST be called before the first file mutation in any task, ' +
      'and again after all changes are verified via tests.',
    input_schema: {
      type: 'object',
      properties: {
        message:   { type: 'string', description: 'Commit message describing the change.' },
        directory: { type: 'string', description: 'Subdirectory to commit (default: entire workspace).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_diff',
    description: 'Show the current git diff — unstaged by default, or staged changes.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        staged:    { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'git_status',
    description: 'Get git status: modified, created, and deleted files.',
    input_schema: {
      type: 'object',
      properties: { directory: { type: 'string' } },
    },
  },
  {
    name: 'git_push',
    description:
      'Push commits to a remote repository. Requires GIT_CREDENTIALS to be configured in Docker mode. ' +
      'Always create a git_checkpoint before pushing.',
    input_schema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', description: 'Subdirectory containing the git repo (default: workspace root).' },
        remote:      { type: 'string', default: 'origin', description: 'Remote name.' },
        branch:      { type: 'string', description: 'Branch to push. Defaults to current branch.' },
        force:       { type: 'boolean', default: false, description: 'Force push. Use with extreme caution.' },
        setUpstream: { type: 'boolean', default: false, description: 'Set upstream tracking reference (-u).' },
      },
    },
  },
  {
    name: 'git_pull',
    description:
      'Pull changes from a remote repository. Requires GIT_CREDENTIALS to be configured in Docker mode. ' +
      'Consider committing local changes first to avoid merge conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Subdirectory containing the git repo (default: workspace root).' },
        remote:    { type: 'string', default: 'origin', description: 'Remote name.' },
        branch:    { type: 'string', description: 'Branch to pull. Defaults to current branch.' },
        rebase:    { type: 'boolean', default: false, description: 'Rebase instead of merge.' },
      },
    },
  },
  {
    name: 'git_branch',
    description:
      'Manage git branches: list, create, delete, or switch branches. ' +
      'Use action="list" to see all branches, action="create" to create a new branch, etc.',
    input_schema: {
      type: 'object',
      properties: {
        directory:  { type: 'string', description: 'Subdirectory containing the git repo.' },
        action:     { type: 'string', enum: ['list', 'create', 'delete', 'switch'], default: 'list' },
        name:       { type: 'string', description: 'Branch name (required for create/delete/switch).' },
        startPoint: { type: 'string', description: 'Starting point for new branch (commit or branch name).' },
        force:      { type: 'boolean', default: false, description: 'Force delete (-D) or force switch.' },
      },
    },
  },
  {
    name: 'git_log',
    description:
      'View commit history. Returns recent commits with hash, message, author, and date.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Subdirectory containing the git repo.' },
        maxCount:  { type: 'number', default: 20, description: 'Maximum commits to show (1-100).' },
        branch:    { type: 'string', description: 'Branch to show logs for. Defaults to current.' },
        oneline:   { type: 'boolean', default: true, description: 'Condensed one-line format.' },
        author:    { type: 'string', description: 'Filter by author name or email.' },
      },
    },
  },
  {
    name: 'git_clone',
    description:
      'Clone a repository into the workspace. Requires GIT_CREDENTIALS for private repos in Docker mode.',
    input_schema: {
      type: 'object',
      properties: {
        url:       { type: 'string', description: 'Repository URL to clone.' },
        directory: { type: 'string', description: 'Target directory name. Defaults to repo name.' },
        branch:    { type: 'string', description: 'Branch to checkout after clone.' },
        depth:     { type: 'number', description: 'Shallow clone depth (e.g., 1 for latest only).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'git_merge',
    description:
      'Merge a branch into the current branch. Reports any conflicts that need resolution.',
    input_schema: {
      type: 'object',
      properties: {
        directory:     { type: 'string', description: 'Subdirectory containing the git repo.' },
        branch:        { type: 'string', description: 'Branch to merge into current branch.' },
        noFastForward: { type: 'boolean', default: false, description: 'Create merge commit even if fast-forward possible.' },
        squash:        { type: 'boolean', default: false, description: 'Squash commits into single commit.' },
        message:       { type: 'string', description: 'Custom merge commit message.' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'git_stash',
    description:
      'Stash or restore uncommitted changes. Useful for temporarily saving work-in-progress.',
    input_schema: {
      type: 'object',
      properties: {
        directory:        { type: 'string', description: 'Subdirectory containing the git repo.' },
        action:           { type: 'string', enum: ['push', 'pop', 'list', 'apply', 'drop', 'clear'], default: 'push' },
        message:          { type: 'string', description: 'Message for stash push.' },
        index:            { type: 'number', description: 'Stash index for pop/apply/drop (0 = most recent).' },
        includeUntracked: { type: 'boolean', default: false, description: 'Include untracked files in stash.' },
      },
    },
  },
  {
    name: 'git_reset',
    description:
      'Reset current HEAD to a specified state. Use with caution - hard reset discards changes!',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Subdirectory containing the git repo.' },
        target:    { type: 'string', default: 'HEAD', description: 'Commit hash, branch name, or HEAD~N.' },
        mode:      { type: 'string', enum: ['soft', 'mixed', 'hard'], default: 'mixed',
                     description: 'soft=keep staged, mixed=unstage, hard=discard all.' },
      },
    },
  },
  {
    name: 'git_remote',
    description:
      'Manage remote repositories: list, add, remove, or update remote URLs.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Subdirectory containing the git repo.' },
        action:    { type: 'string', enum: ['list', 'add', 'remove', 'get-url', 'set-url'], default: 'list' },
        name:      { type: 'string', description: 'Remote name (required for add/remove/get-url/set-url).' },
        url:       { type: 'string', description: 'Remote URL (required for add/set-url).' },
      },
    },
  },

  // ── Test ──────────────────────────────────────────────────────────────────
  {
    name: 'run_tests',
    description:
      'Run automated tests and return structured results including pass/fail counts, ' +
      'failure messages, and coverage. Auto-detects Jest or Vitest from package.json.',
    input_schema: {
      type: 'object',
      properties: {
        directory:       { type: 'string', description: 'Directory containing the project under test.' },
        testPattern:     { type: 'string', description: 'Filter tests by filename pattern.' },
        type:            { type: 'string', enum: ['unit', 'integration', 'e2e', 'all'], default: 'all' },
        coverage:        { type: 'boolean', default: true },
        updateSnapshots: { type: 'boolean', default: false },
      },
    },
  },

  // ── CI ────────────────────────────────────────────────────────────────────
  {
    name: 'run_ci',
    description:
      'Run GitHub Actions workflows locally using `act` before pushing commits. ' +
      'Executes: act -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:full-latest --container-architecture linux/amd64. ' +
      'Returns pass/fail status, raw output, and a list of failure lines. ' +
      'MUST be called before git_push to verify CI passes. ' +
      'If CI fails, analyse the raw_output and failures, fix the issues, then re-run before pushing.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory containing .github/workflows. Defaults to workspace root.' },
        workflow:  { type: 'string', description: 'Specific workflow file path (e.g. ".github/workflows/ci.yml"). All workflows run if omitted.' },
        job:       { type: 'string', description: 'Specific job name to run. All jobs run if omitted.' },
        timeout:   { type: 'number', default: 1800000, description: 'Timeout ms. Default 30 min.' },
      },
    },
  },

  // ── Memory ────────────────────────────────────────────────────────────────
  {
    name: 'memory_set',
    description: 'Store a persistent fact that will be available in future sessions.',
    input_schema: {
      type: 'object',
      properties: {
        key:      { type: 'string', description: 'Unique key.' },
        value:    { type: 'string', description: 'Value to store.' },
        category: { type: 'string', default: 'general' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'memory_get',
    description: 'Retrieve a previously stored value from persistent memory.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
    },
  },

  // ── Deploy ────────────────────────────────────────────────────────────────
  {
    name: 'deploy_netlify',
    description: 'Build and deploy the project to Netlify.',
    input_schema: {
      type: 'object',
      properties: {
        buildCommand: { type: 'string', default: 'npm run build' },
        publishDir:   { type: 'string', default: 'dist' },
        environment:  { type: 'string', enum: ['production', 'preview'], default: 'preview' },
      },
    },
  },
  {
    name: 'deploy_vercel',
    description: 
      'Deploy a project to Vercel. Supports React, Next.js, Vue, and other frameworks. ' +
      'Requires VERCEL_TOKEN environment variable.',
    input_schema: {
      type: 'object',
      properties: {
        directory:       { type: 'string', default: '.', description: 'Project directory relative to workspace.' },
        production:      { type: 'boolean', default: false, description: 'Deploy to production (vs preview).' },
        projectName:     { type: 'string', description: 'Vercel project name. Auto-detected if not provided.' },
        buildCommand:    { type: 'string', description: 'Override build command.' },
        outputDirectory: { type: 'string', description: 'Override output directory.' },
        env:             { type: 'object', description: 'Environment variables for deployment.' },
      },
    },
  },
  {
    name: 'deploy_aws_s3',
    description: 
      'Deploy static files to AWS S3 with optional CloudFront CDN invalidation. ' +
      'Requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.',
    input_schema: {
      type: 'object',
      properties: {
        directory:                 { type: 'string', default: '.', description: 'Project directory.' },
        bucketName:                { type: 'string', description: 'S3 bucket name (required).' },
        buildDir:                  { type: 'string', default: 'dist', description: 'Build output directory to upload.' },
        region:                    { type: 'string', default: 'us-east-1', description: 'AWS region.' },
        buildCommand:              { type: 'string', description: 'Build command to run before upload.' },
        cloudFrontDistributionId:  { type: 'string', description: 'CloudFront distribution ID for cache invalidation.' },
        deleteExisting:            { type: 'boolean', default: true, description: 'Delete existing files in bucket.' },
      },
      required: ['bucketName'],
    },
  },

  // ── Terraform / IaC ────────────────────────────────────────────────────────
  {
    name: 'terraform_init',
    description: 
      'Initialize Terraform working directory. Downloads providers and sets up backend. ' +
      'Run this before plan/apply.',
    input_schema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', default: 'terraform', description: 'Directory containing .tf files.' },
        upgrade:     { type: 'boolean', default: false, description: 'Upgrade provider plugins.' },
        reconfigure: { type: 'boolean', default: false, description: 'Reconfigure backend.' },
      },
    },
  },
  {
    name: 'terraform_plan',
    description: 
      'Generate an execution plan showing what Terraform will do. ' +
      'Review this before running terraform_apply.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', default: 'terraform', description: 'Directory containing .tf files.' },
        vars:      { type: 'object', description: 'Variable values to pass (-var flags).' },
        varFile:   { type: 'string', description: 'Path to .tfvars file.' },
        destroy:   { type: 'boolean', default: false, description: 'Generate a destroy plan.' },
        out:       { type: 'string', default: 'tfplan', description: 'Save plan to this file.' },
      },
    },
  },
  {
    name: 'terraform_apply',
    description: 
      'Apply Terraform changes to create/update infrastructure. ' +
      'For safety, use a saved plan file from terraform_plan, or set autoApprove=true explicitly.',
    input_schema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', default: 'terraform', description: 'Directory containing .tf files.' },
        planFile:    { type: 'string', description: 'Apply a saved plan file (recommended).' },
        autoApprove: { type: 'boolean', default: false, description: 'Skip approval (use with caution!).' },
        vars:        { type: 'object', description: 'Variable values (only if no planFile).' },
        varFile:     { type: 'string', description: 'Path to .tfvars file (only if no planFile).' },
      },
    },
  },
  {
    name: 'terraform_destroy',
    description: 
      'Destroy all Terraform-managed infrastructure. ' +
      'WARNING: This is destructive and requires explicit autoApprove=true.',
    input_schema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', default: 'terraform', description: 'Directory containing .tf files.' },
        autoApprove: { type: 'boolean', default: false, description: 'REQUIRED: Set to true to confirm destruction.' },
        vars:        { type: 'object', description: 'Variable values.' },
        varFile:     { type: 'string', description: 'Path to .tfvars file.' },
      },
    },
  },
  {
    name: 'terraform_output',
    description: 
      'Retrieve outputs from Terraform state (URLs, IDs, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', default: 'terraform', description: 'Directory containing .tf files.' },
        name:      { type: 'string', description: 'Specific output to retrieve. Returns all if not provided.' },
        json:      { type: 'boolean', default: true, description: 'Output as JSON.' },
      },
    },
  },
  {
    name: 'generate_infrastructure',
    description: 
      'Analyze a project and generate infrastructure-as-code (Terraform) for deployment. ' +
      'Detects project type (React, Node.js, etc.) and generates appropriate AWS, Vercel, or Netlify configs.',
    input_schema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', default: '.', description: 'Project directory to analyze.' },
        provider:    { type: 'string', enum: ['aws', 'vercel', 'netlify'], description: 'Cloud provider.' },
        type:        { type: 'string', enum: ['static', 'serverless', 'container', 'fullstack'], default: 'static',
                       description: 'Infrastructure type.' },
        outputDir:   { type: 'string', default: 'terraform', description: 'Directory for Terraform files.' },
        projectName: { type: 'string', description: 'Project name for resource naming.' },
        domain:      { type: 'string', description: 'Custom domain.' },
        options:     { type: 'object', description: 'Provider-specific options (enableCdn, enableHttps, etc.).' },
      },
      required: ['provider'],
    },
  },

] as const;

// ─── Schema map — Zod validates every input before dispatch ──────────────────

const schemaMap: Record<string, ZodSchema> = {
  read_file:        ReadFileSchema,
  write_file:       WriteFileSchema,
  apply_patch:      ApplyPatchSchema,
  delete_file:      DeleteFileSchema,
  list_files:       ListFilesSchema,
  search_files:     SearchFilesSchema,
  npm_install:      NpmInstallSchema,
  npm_run:          NpmRunSchema,
  tsc_check:        TscCheckSchema,
  eslint_check:     EslintCheckSchema,
  prettier_format:  PrettierFormatSchema,
  run_node_script:  RunNodeScriptSchema,
  git_checkpoint:   GitCheckpointSchema,
  git_diff:         GitDiffSchema,
  git_status:       GitStatusSchema,
  git_push:         GitPushSchema,
  git_pull:         GitPullSchema,
  git_branch:       GitBranchSchema,
  git_log:          GitLogSchema,
  git_clone:        GitCloneSchema,
  git_merge:        GitMergeSchema,
  git_stash:        GitStashSchema,
  git_reset:        GitResetSchema,
  git_remote:       GitRemoteSchema,
  run_tests:        RunTestsSchema,
  run_ci:           RunCISchema,
  memory_set:       MemorySetSchema,
  memory_get:       MemoryGetSchema,
  deploy_netlify:   DeploySchema,
  deploy_vercel:    VercelDeploySchema,
  deploy_aws_s3:    AWSS3DeploySchema,
  terraform_init:   TerraformInitSchema,
  terraform_plan:   TerraformPlanSchema,
  terraform_apply:  TerraformApplySchema,
  terraform_destroy: TerraformDestroySchema,
  terraform_output: TerraformOutputSchema,
  generate_infrastructure: GenerateInfrastructureSchema,
};

// ─── Progress status messages ─────────────────────────────────────────────────

function getProgressStatus(toolName: string, progress: number): string {
  const stages: Record<string, string[]> = {
    npm_install: ['Resolving dependencies...', 'Downloading packages...', 'Linking packages...', 'Building modules...'],
    npm_run: ['Starting script...', 'Running...', 'Processing...', 'Finishing...'],
    run_tests: ['Collecting tests...', 'Running tests...', 'Generating coverage...', 'Finalizing...'],
    run_ci: ['Pulling runner image...', 'Starting workflow jobs...', 'Running CI steps...', 'Finalizing...'],
    git_clone: ['Connecting to remote...', 'Receiving objects...', 'Resolving deltas...', 'Checking out files...'],
    deploy_netlify: ['Preparing build...', 'Uploading files...', 'Processing deploy...', 'Finalizing...'],
    deploy_vercel: ['Connecting to Vercel...', 'Building project...', 'Deploying...', 'Finalizing...'],
    deploy_aws_s3: ['Preparing files...', 'Uploading to S3...', 'Invalidating CDN...', 'Finalizing...'],
    terraform_init: ['Loading providers...', 'Downloading modules...', 'Initializing backend...', 'Ready...'],
    terraform_plan: ['Loading configuration...', 'Refreshing state...', 'Calculating changes...', 'Generating plan...'],
    terraform_apply: ['Loading plan...', 'Applying changes...', 'Creating resources...', 'Finalizing...'],
    terraform_destroy: ['Loading state...', 'Calculating destruction...', 'Destroying resources...', 'Cleaning up...'],
    generate_infrastructure: ['Analyzing project...', 'Detecting framework...', 'Generating templates...', 'Writing files...'],
    tsc_check: ['Loading config...', 'Type checking...', 'Validating...', 'Finishing...'],
    eslint_check: ['Loading rules...', 'Linting files...', 'Generating report...', 'Finishing...'],
    prettier_format: ['Loading config...', 'Formatting files...', 'Writing changes...', 'Finishing...'],
  };
  
  const toolStages = stages[toolName] || ['Processing...', 'Working...', 'Almost there...', 'Finishing...'];
  const stageIndex = Math.min(Math.floor(progress / 25), toolStages.length - 1);
  return toolStages[stageIndex];
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export class ToolExecutor {
  private fileTool:   FileTool;
  private buildTool:  BuildTool;
  private lintTool:   LintTool;
  private scriptTool: ScriptTool;
  private gitTool:    GitTool;
  private testTool:   TestTool;
  private ciTool:     CITool;

  constructor(
    private readonly config:    Config,
    private readonly memory:    DatabaseMemory,
    private readonly sessionId: string,
  ) {
    // One sandbox instance shared across all tools in this session.
    // DockerSandbox lazy-initialises on first execute() call, so constructing
    // it here is cheap — no Docker connection is made until the first tool call
    // that routes through it. The agent-level initialize() at startup already
    // verified Docker is reachable, so the lazy init will always succeed.
    const sandbox = config.dockerEnabled ? new DockerSandbox() : null;

    if (sandbox) {
      logger.info('Docker sandbox enabled — tool commands will run in isolated containers', {
        sessionId,
      });
    }

    this.fileTool   = new FileTool(config.workspaceDir);
    this.buildTool  = new BuildTool(config.workspaceDir,  sandbox);
    this.lintTool   = new LintTool(config.workspaceDir,   sandbox);
    this.scriptTool = new ScriptTool(config.workspaceDir, sandbox);
    this.gitTool    = new GitTool(config.workspaceDir);
    this.testTool   = new TestTool(config.workspaceDir,   sandbox);
    this.ciTool     = new CITool(config.workspaceDir);
  }

  async execute(
    toolCall: ToolCall, 
    maxRetries = 3,
    onProgress?: ProgressCallback
  ): Promise<ToolResult> {
    const toolCallId = uuidv4();
    const start      = Date.now();

    logger.info('Executing tool', { toolName: toolCall.name, toolCallId, sessionId: this.sessionId });

    // ── Schema validation ────────────────────────────────────────────────
    const schema = schemaMap[toolCall.name];
    if (!schema) {
      const error = `Unknown tool: "${toolCall.name}". Available tools: ${Object.keys(schemaMap).join(', ')}`;
      logger.error(error);
      return { toolCallId, toolName: toolCall.name, result: null, success: false, error, durationMs: 0 };
    }

    let validatedInput: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const parsed = schema.safeParse(toolCall.input);
      if (parsed.success) { validatedInput = parsed.data; break; }

      logger.warn('Tool input validation failed', {
        toolName: toolCall.name, attempt, errors: parsed.error.flatten(),
      });

      if (attempt === maxRetries) {
        const error = `Validation failed after ${maxRetries} attempts: ${JSON.stringify(parsed.error.flatten())}`;
        return { toolCallId, toolName: toolCall.name, result: null, success: false, error, durationMs: 0 };
      }

      await new Promise((r) => setTimeout(r, 200 * attempt));
    }

    // ── Progress tracking for long-running tools ──────────────────────────
    let progressInterval: NodeJS.Timeout | undefined;
    const isLongRunning = LONG_RUNNING_TOOLS.has(toolCall.name);
    
    if (isLongRunning && onProgress) {
      // Emit initial progress
      onProgress({
        toolCallId,
        toolName: toolCall.name,
        progress: 0,
        status: 'Starting...',
        elapsedMs: 0,
      });
      
      // Emit progress updates every 500ms with simulated progress
      let simulatedProgress = 0;
      progressInterval = setInterval(() => {
        // Simulate progress with diminishing returns (never reaches 100%)
        simulatedProgress = Math.min(95, simulatedProgress + (100 - simulatedProgress) * 0.05);
        onProgress({
          toolCallId,
          toolName: toolCall.name,
          progress: Math.round(simulatedProgress),
          status: getProgressStatus(toolCall.name, simulatedProgress),
          elapsedMs: Date.now() - start,
        });
      }, 500);
    }

    // ── Dispatch ─────────────────────────────────────────────────────────
    let result: unknown;
    let success = false;
    let error: string | undefined;

    try {
      result  = await this.dispatch(toolCall.name, validatedInput!);
      success = true;
      logger.info('Tool succeeded', { toolName: toolCall.name, toolCallId, durationMs: Date.now() - start });
    } catch (err: any) {
      error  = err?.message ?? String(err);
      result = { error };
      logger.error('Tool failed', { toolName: toolCall.name, toolCallId, error, stack: err?.stack });
    } finally {
      // Stop progress tracking
      if (progressInterval) {
        clearInterval(progressInterval);
        // Emit final progress
        if (onProgress) {
          onProgress({
            toolCallId,
            toolName: toolCall.name,
            progress: success ? 100 : -1,
            status: success ? 'Complete' : 'Failed',
            elapsedMs: Date.now() - start,
          });
        }
      }
    }

    const durationMs = Date.now() - start;

    // Truncate output for storage while preserving full result for API response
    const outputJson = JSON.stringify(result);
    const maxSize = this.config.maxToolResultSize;
    const truncatedOutput = outputJson.length > maxSize
      ? outputJson.slice(0, maxSize) + '...[TRUNCATED]'
      : outputJson;

    this.memory.recordToolCall({
      id: toolCallId, sessionId: this.sessionId,
      toolName: toolCall.name,
      input:  JSON.stringify(toolCall.input),
      output: truncatedOutput,
      success, durationMs,
    });

    return { toolCallId, toolName: toolCall.name, result, success, error, durationMs };
  }

  private async dispatch(name: string, input: unknown): Promise<unknown> {
    switch (name) {
      // ── File ────────────────────────────────────────────────────────────
      case 'read_file':       return this.fileTool.readFile(input as any);
      case 'write_file':      return this.fileTool.writeFile(input as any);
      case 'apply_patch':     return this.fileTool.applyPatch(input as any);
      case 'delete_file':     return this.fileTool.deleteFile(input as any);
      case 'list_files':      return this.fileTool.listFiles(input as any);
      case 'search_files':    return this.fileTool.searchInFiles(input as any, this.config.maxSearchResults);
      // ── Build ───────────────────────────────────────────────────────────
      case 'npm_install':     return this.buildTool.npmInstall(input as any);
      case 'npm_run':         return this.buildTool.npmRun(input as any);
      case 'tsc_check':       return this.buildTool.tscCheck(input as any);
      // ── Lint ────────────────────────────────────────────────────────────
      case 'eslint_check':    return this.lintTool.eslintCheck(input as any);
      case 'prettier_format': return this.lintTool.prettierFormat(input as any);
      // ── Script ──────────────────────────────────────────────────────────
      case 'run_node_script': return this.scriptTool.runNodeScript(input as any);
      // ── Git ─────────────────────────────────────────────────────────────
      case 'git_checkpoint':  return this.gitTool.checkpoint(input as any);
      case 'git_diff':        return this.gitTool.diff(input as any);
      case 'git_status':      return this.gitTool.status(input as any);
      case 'git_push':        return this.gitTool.push(input as any);
      case 'git_pull':        return this.gitTool.pull(input as any);
      case 'git_branch':      return this.gitTool.branch(input as any);
      case 'git_log':         return this.gitTool.log(input as any);
      case 'git_clone':       return this.gitTool.clone(input as any);
      case 'git_merge':       return this.gitTool.merge(input as any);
      case 'git_stash':       return this.gitTool.stash(input as any);
      case 'git_reset':       return this.gitTool.reset(input as any);
      case 'git_remote':      return this.gitTool.remote(input as any);
      // ── Test ────────────────────────────────────────────────────────────
      case 'run_tests':       return this.testTool.runTests(input as any);
      // ── CI ──────────────────────────────────────────────────────────────
      case 'run_ci':          return this.ciTool.runCI(input as any);
      // ── Memory ──────────────────────────────────────────────────────────
      case 'memory_set': {
        const { key, value, category } = input as any;
        this.memory.setKnowledge(key, value, category);
        return { success: true, key };
      }
      case 'memory_get': {
        const { key } = input as any;
        const value = this.memory.getKnowledge(key);
        return { key, value: value ?? null, found: value !== undefined };
      }
      // ── Deploy ──────────────────────────────────────────────────────────
      case 'deploy_netlify':
        return deployToNetlify({
          workspaceDir: this.config.workspaceDir,
          siteId:       this.config.netlifySiteId,
          authToken:    this.config.netlifyToken,
          ...(input as any),
        });
      
      case 'deploy_vercel':
        return deployToVercel(
          input as any,
          this.config.workspaceDir,
          this.config.vercelToken
        );
      
      case 'deploy_aws_s3':
        return deployToS3(input as any, this.config.workspaceDir);
      
      // ── Terraform / IaC ──────────────────────────────────────────────────
      case 'terraform_init':
        return terraformInit(input as any, this.config.workspaceDir);
      
      case 'terraform_plan':
        return terraformPlan(input as any, this.config.workspaceDir);
      
      case 'terraform_apply':
        return terraformApply(input as any, this.config.workspaceDir);
      
      case 'terraform_destroy':
        return terraformDestroy(input as any, this.config.workspaceDir);
      
      case 'terraform_output':
        return terraformOutput(input as any, this.config.workspaceDir);
      
      case 'generate_infrastructure':
        return generateInfrastructure(input as any, this.config.workspaceDir);

      default:
        throw new Error(`Unimplemented tool: ${name}`);
    }
  }
}
