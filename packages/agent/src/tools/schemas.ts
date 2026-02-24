import { z } from 'zod';

// ─── File Tools ───────────────────────────────────────────────────────────────

export const ReadFileSchema = z.object({
  path: z.string().min(1, 'path is required'),
  encoding: z.enum(['utf8', 'base64', 'hex']).default('utf8'),
});

export const WriteFileSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
  createDirs: z.boolean().default(true),
});

export const ApplyPatchSchema = z.object({
  path: z.string().min(1, 'path is required'),
  patch: z.string().min(1, 'patch (unified diff) is required'),
});

export const DeleteFileSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const ListFilesSchema = z.object({
  directory: z.string().default('.'),
  pattern: z.string().default('**/*'),
  ignore: z.array(z.string()).default(['node_modules/**', '.git/**', 'dist/**']),
  maxDepth: z.number().int().min(1).max(10).default(5),
});

export const SearchFilesSchema = z.object({
  directory: z.string().default('.'),
  pattern: z.string().min(1, 'pattern is required'),
  fileGlob: z.string().default('**/*.{ts,tsx,js,jsx,json,md}'),
});


// ─── Git Tool ─────────────────────────────────────────────────────────────────

export const GitCheckpointSchema = z.object({
  message: z.string().min(1, 'commit message is required'),
  directory: z.string().optional(),
});

export const GitDiffSchema = z.object({
  directory: z.string().optional(),
  staged: z.boolean().default(false),
});

export const GitStatusSchema = z.object({
  directory: z.string().optional(),
});

export const GitPushSchema = z.object({
  directory: z.string().optional(),
  remote: z.string().default('origin'),
  branch: z.string().optional().describe('Branch to push. Defaults to current branch.'),
  force: z.boolean().default(false).describe('Force push. Use with caution.'),
  setUpstream: z.boolean().default(false).describe('Set upstream tracking reference.'),
});

export const GitPullSchema = z.object({
  directory: z.string().optional(),
  remote: z.string().default('origin'),
  branch: z.string().optional().describe('Branch to pull. Defaults to current branch.'),
  rebase: z.boolean().default(false).describe('Rebase instead of merge.'),
});

export const GitBranchSchema = z.object({
  directory: z.string().optional(),
  action: z.enum(['list', 'create', 'delete', 'switch']).default('list'),
  name: z.string().optional().describe('Branch name (required for create/delete/switch).'),
  startPoint: z.string().optional().describe('Starting point for new branch (commit hash or branch name).'),
  force: z.boolean().default(false).describe('Force delete or force switch.'),
});

export const GitLogSchema = z.object({
  directory: z.string().optional(),
  maxCount: z.number().int().min(1).max(100).default(20).describe('Maximum number of commits to show.'),
  branch: z.string().optional().describe('Branch to show logs for. Defaults to current branch.'),
  oneline: z.boolean().default(true).describe('Show condensed one-line format.'),
  author: z.string().optional().describe('Filter by author name or email.'),
});

export const GitCloneSchema = z.object({
  url: z.string().min(1).describe('Repository URL to clone.'),
  directory: z.string().optional().describe('Target directory name. Defaults to repo name.'),
  branch: z.string().optional().describe('Branch to checkout after clone.'),
  depth: z.number().int().min(1).optional().describe('Create a shallow clone with limited history.'),
});

export const GitMergeSchema = z.object({
  directory: z.string().optional(),
  branch: z.string().min(1).describe('Branch to merge into current branch.'),
  noFastForward: z.boolean().default(false).describe('Create a merge commit even if fast-forward is possible.'),
  squash: z.boolean().default(false).describe('Squash commits into a single commit.'),
  message: z.string().optional().describe('Custom merge commit message.'),
});

export const GitStashSchema = z.object({
  directory: z.string().optional(),
  action: z.enum(['push', 'pop', 'list', 'apply', 'drop', 'clear']).default('push'),
  message: z.string().optional().describe('Message for stash push.'),
  index: z.number().int().min(0).optional().describe('Stash index for pop/apply/drop.'),
  includeUntracked: z.boolean().default(false).describe('Include untracked files in stash.'),
});

export const GitResetSchema = z.object({
  directory: z.string().optional(),
  target: z.string().default('HEAD').describe('Commit hash, branch name, or HEAD~N.'),
  mode: z.enum(['soft', 'mixed', 'hard']).default('mixed').describe('Reset mode: soft (keep staged), mixed (unstage), hard (discard all).'),
});

export const GitRemoteSchema = z.object({
  directory: z.string().optional(),
  action: z.enum(['list', 'add', 'remove', 'get-url', 'set-url']).default('list'),
  name: z.string().optional().describe('Remote name (required for add/remove/get-url/set-url).'),
  url: z.string().optional().describe('Remote URL (required for add/set-url).'),
});

// ─── Test Tool ────────────────────────────────────────────────────────────────

export const RunTestsSchema = z.object({
  directory: z.string().optional(),
  testPattern: z.string().optional(),
  type: z.enum(['unit', 'integration', 'e2e', 'all']).default('all'),
  coverage: z.boolean().default(true),
  updateSnapshots: z.boolean().default(false),
});


// ─── Memory Tool ──────────────────────────────────────────────────────────────

export const MemorySetSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  category: z.string().default('general'),
});

export const MemoryGetSchema = z.object({
  key: z.string().min(1),
});

// ─── Deploy Tool ──────────────────────────────────────────────────────────────

export const DeploySchema = z.object({
  buildCommand: z.string().default('npm run build'),
  publishDir: z.string().default('dist'),
  environment: z.enum(['production', 'preview']).default('preview'),
});

// ─── Vercel Deploy Tool ──────────────────────────────────────────────────────

export const VercelDeploySchema = z.object({
  directory: z.string().default('.')
    .describe('Project directory, relative to workspace root.'),
  production: z.boolean().default(false)
    .describe('Deploy to production. Default is preview deployment.'),
  projectName: z.string().optional()
    .describe('Vercel project name. Auto-detected if not provided.'),
  buildCommand: z.string().optional()
    .describe('Override build command. Uses Vercel auto-detection by default.'),
  outputDirectory: z.string().optional()
    .describe('Override output directory. Uses Vercel auto-detection by default.'),
  env: z.record(z.string()).optional()
    .describe('Environment variables for the deployment.'),
});

// ─── AWS S3 Deploy Tool ──────────────────────────────────────────────────────

export const AWSS3DeploySchema = z.object({
  directory: z.string().default('.')
    .describe('Project directory, relative to workspace root.'),
  bucketName: z.string().min(1)
    .describe('S3 bucket name for deployment.'),
  buildDir: z.string().default('dist')
    .describe('Build output directory to upload.'),
  region: z.string().default('us-east-1')
    .describe('AWS region.'),
  buildCommand: z.string().optional()
    .describe('Build command to run before upload. Skipped if not provided.'),
  cloudFrontDistributionId: z.string().optional()
    .describe('CloudFront distribution ID for cache invalidation.'),
  deleteExisting: z.boolean().default(true)
    .describe('Delete existing files in bucket before upload.'),
});

// ─── Terraform Tool ──────────────────────────────────────────────────────────

export const TerraformInitSchema = z.object({
  directory: z.string().default('terraform')
    .describe('Directory containing Terraform files, relative to workspace root.'),
  upgrade: z.boolean().default(false)
    .describe('Upgrade provider plugins.'),
  reconfigure: z.boolean().default(false)
    .describe('Reconfigure backend, ignoring saved configuration.'),
});

export const TerraformPlanSchema = z.object({
  directory: z.string().default('terraform')
    .describe('Directory containing Terraform files, relative to workspace root.'),
  vars: z.record(z.string()).optional()
    .describe('Variable values to pass to Terraform (-var flags).'),
  varFile: z.string().optional()
    .describe('Path to a .tfvars file, relative to terraform directory.'),
  destroy: z.boolean().default(false)
    .describe('Generate a destroy plan.'),
  out: z.string().default('tfplan')
    .describe('Save plan to this file.'),
});

export const TerraformApplySchema = z.object({
  directory: z.string().default('terraform')
    .describe('Directory containing Terraform files, relative to workspace root.'),
  planFile: z.string().optional()
    .describe('Apply a saved plan file. If not provided, creates a new plan.'),
  autoApprove: z.boolean().default(false)
    .describe('Skip approval prompt. Use with caution!'),
  vars: z.record(z.string()).optional()
    .describe('Variable values (only used if no planFile).'),
  varFile: z.string().optional()
    .describe('Path to a .tfvars file (only used if no planFile).'),
});

export const TerraformDestroySchema = z.object({
  directory: z.string().default('terraform')
    .describe('Directory containing Terraform files, relative to workspace root.'),
  autoApprove: z.boolean().default(false)
    .describe('Skip approval prompt. Use with extreme caution!'),
  vars: z.record(z.string()).optional()
    .describe('Variable values to pass to Terraform.'),
  varFile: z.string().optional()
    .describe('Path to a .tfvars file.'),
});

export const TerraformOutputSchema = z.object({
  directory: z.string().default('terraform')
    .describe('Directory containing Terraform files, relative to workspace root.'),
  name: z.string().optional()
    .describe('Specific output to retrieve. Returns all outputs if not provided.'),
  json: z.boolean().default(true)
    .describe('Output as JSON.'),
});

// ─── Infrastructure Generation Tool ─────────────────────────────────────────

export const GenerateInfrastructureSchema = z.object({
  directory: z.string().default('.')
    .describe('Project directory to analyze, relative to workspace root.'),
  provider: z.enum(['aws', 'vercel', 'netlify'])
    .describe('Cloud provider to generate infrastructure for.'),
  type: z.enum(['static', 'serverless', 'container', 'fullstack']).default('static')
    .describe('Infrastructure type: static (S3/CDN), serverless (Lambda), container (ECS/Fargate), fullstack (multiple services).'),
  outputDir: z.string().default('terraform')
    .describe('Directory to write Terraform files to.'),
  projectName: z.string().optional()
    .describe('Project name for resource naming. Auto-detected from package.json if not provided.'),
  domain: z.string().optional()
    .describe('Custom domain for the deployment.'),
  options: z.object({
    enableCdn: z.boolean().default(true).describe('Enable CloudFront CDN (AWS only).'),
    enableHttps: z.boolean().default(true).describe('Enable HTTPS with ACM certificate (AWS only).'),
    enableWaf: z.boolean().default(false).describe('Enable AWS WAF protection.'),
    runtime: z.string().optional().describe('Lambda runtime (e.g., nodejs20.x, python3.11).'),
    memory: z.number().int().min(128).max(10240).optional().describe('Lambda memory in MB.'),
    timeout: z.number().int().min(1).max(900).optional().describe('Lambda timeout in seconds.'),
  }).optional(),
});

// ─── CI Tool ──────────────────────────────────────────────────────────────────

export const RunCISchema = z.object({
  directory: z.string().optional()
    .describe('Directory containing the git repo and .github/workflows. Defaults to workspace root.'),
  workflow: z.string().optional()
    .describe('Path to a specific workflow file, e.g. ".github/workflows/ci.yml". Runs all workflows if omitted.'),
  job: z.string().optional()
    .describe('Run only a specific job from the workflow. Runs all jobs if omitted.'),
  timeout: z.number().int().min(30_000).max(3_600_000).default(1_800_000)
    .describe('Timeout in milliseconds. Default 30 minutes.'),
});

export type RunCIInput = z.infer<typeof RunCISchema>;

// ─── Type exports ─────────────────────────────────────────────────────────────

export type ReadFileInput = z.infer<typeof ReadFileSchema>;
export type WriteFileInput = z.infer<typeof WriteFileSchema>;
export type ApplyPatchInput = z.infer<typeof ApplyPatchSchema>;
export type DeleteFileInput = z.infer<typeof DeleteFileSchema>;
export type ListFilesInput = z.infer<typeof ListFilesSchema>;
export type SearchFilesInput = z.infer<typeof SearchFilesSchema>;
export type GitCheckpointInput = z.infer<typeof GitCheckpointSchema>;
export type GitDiffInput = z.infer<typeof GitDiffSchema>;
export type GitStatusInput = z.infer<typeof GitStatusSchema>;
export type GitPushInput = z.infer<typeof GitPushSchema>;
export type GitPullInput = z.infer<typeof GitPullSchema>;
export type GitBranchInput = z.infer<typeof GitBranchSchema>;
export type GitLogInput = z.infer<typeof GitLogSchema>;
export type GitCloneInput = z.infer<typeof GitCloneSchema>;
export type GitMergeInput = z.infer<typeof GitMergeSchema>;
export type GitStashInput = z.infer<typeof GitStashSchema>;
export type GitResetInput = z.infer<typeof GitResetSchema>;
export type GitRemoteInput = z.infer<typeof GitRemoteSchema>;
export type RunTestsInput = z.infer<typeof RunTestsSchema>;
export type MemorySetInput = z.infer<typeof MemorySetSchema>;
export type MemoryGetInput = z.infer<typeof MemoryGetSchema>;
export type DeployInput = z.infer<typeof DeploySchema>;
export type VercelDeployInput = z.infer<typeof VercelDeploySchema>;
export type AWSS3DeployInput = z.infer<typeof AWSS3DeploySchema>;
export type TerraformInitInput = z.infer<typeof TerraformInitSchema>;
export type TerraformPlanInput = z.infer<typeof TerraformPlanSchema>;
export type TerraformApplyInput = z.infer<typeof TerraformApplySchema>;
export type TerraformDestroyInput = z.infer<typeof TerraformDestroySchema>;
export type TerraformOutputInput = z.infer<typeof TerraformOutputSchema>;
export type GenerateInfrastructureInput = z.infer<typeof GenerateInfrastructureSchema>;

// ─── Build Tool ───────────────────────────────────────────────────────────────

export const NpmInstallSchema = z.object({
  packages: z.array(z.string()).default([])
    .describe('Package names to install. Empty array runs "npm install" with no args (installs from package.json).'),
  packageDir: z.string().default('.')
    .describe('Directory containing package.json, relative to workspace root.'),
  saveDev: z.boolean().default(false)
    .describe('Save as devDependency (--save-dev). Default: save as dependency.'),
});

export const NpmRunSchema = z.object({
  script: z.string().min(1)
    .describe('Script name from the package.json "scripts" field (e.g. "build", "generate", "migrate").'),
  packageDir: z.string().default('.')
    .describe('Directory containing package.json, relative to workspace root.'),
  env: z.record(z.string()).optional()
    .describe('Additional environment variables to pass to the script.'),
  timeout: z.number().int().min(5000).max(600000).default(120000)
    .describe('Timeout in milliseconds. Default 120s. Increase for long-running builds.'),
});

export const TscCheckSchema = z.object({
  packageDir: z.string().default('.')
    .describe('Directory containing tsconfig.json, relative to workspace root.'),
  emitFiles: z.boolean().default(false)
    .describe('Emit compiled output. Default false (type-check only via --noEmit).'),
});

// ─── Lint Tool ────────────────────────────────────────────────────────────────

export const EslintCheckSchema = z.object({
  paths: z.array(z.string()).default(['.'])
    .describe('File paths or glob patterns to lint, relative to workspace root.'),
  fix: z.boolean().default(false)
    .describe('Automatically fix fixable issues. Default false (check only).'),
  packageDir: z.string().default('.')
    .describe('Directory to run ESLint from (affects config file resolution).'),
});

export const PrettierFormatSchema = z.object({
  paths: z.array(z.string()).default(['.'])
    .describe('File paths or glob patterns to format, relative to workspace root.'),
  check: z.boolean().default(false)
    .describe('Check formatting only — do not write files. Returns error if files need formatting.'),
  packageDir: z.string().default('.')
    .describe('Directory to run Prettier from.'),
});

// ─── Script Tool ──────────────────────────────────────────────────────────────

export const RunNodeScriptSchema = z.object({
  scriptPath: z.string().min(1)
    .describe('Path to the .js or .ts script file, relative to workspace root. Must be inside the workspace.'),
  args: z.array(z.string()).default([])
    .describe('Arguments to pass to the script. No shell metacharacters allowed.'),
  env: z.record(z.string()).optional()
    .describe('Additional environment variables.'),
  timeout: z.number().int().min(1000).max(300000).default(60000)
    .describe('Timeout in milliseconds.'),
  useTsNode: z.boolean().default(false)
    .describe('Run with ts-node instead of node (for .ts files that need direct execution).'),
});

// ─── Build · Lint · Script type exports ─────────────────────────────────────────────────────────────

export type NpmInstallInput    = z.infer<typeof NpmInstallSchema>;
export type NpmRunInput        = z.infer<typeof NpmRunSchema>;
export type TscCheckInput      = z.infer<typeof TscCheckSchema>;
export type EslintCheckInput   = z.infer<typeof EslintCheckSchema>;
export type PrettierFormatInput = z.infer<typeof PrettierFormatSchema>;
export type RunNodeScriptInput = z.infer<typeof RunNodeScriptSchema>;
