# AI Agent Improvements - Implementation Summary

This document summarizes all improvements implemented based on the requirements document.

## Security (High Priority) ✅

### 1. Atomic Session Counter
- **File**: `packages/agent/src/utils/Mutex.ts` (new)
- **File**: `packages/agent/src/agent/Agent.ts` (modified)
- **Description**: Replaced non-atomic session counter with a mutex-protected `AtomicCounter` class that uses compare-and-swap pattern to prevent race conditions where more sessions than `maxConcurrentSessions` could start under high concurrency.

### 2. Content Security Policy
- **File**: `packages/agent/src/server/AgentServer.ts` (modified)
- **Description**: Added CSP headers to prevent XSS attacks from reflected tool output content:
  - `default-src 'self'`
  - `script-src 'self'`
  - `style-src 'self' 'unsafe-inline'`
  - `frame-ancestors 'none'`
  - Also added `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, and `Referrer-Policy` headers.

### 3. Session TTL / Auto-Expiry
- **Files**: `packages/agent/src/config.ts`, `packages/agent/src/memory/DatabaseMemory.ts`, `packages/agent/src/server/AgentServer.ts`
- **Config Options**:
  - `AGENT_SESSION_TTL` - Session idle timeout in milliseconds (default: 24 hours)
  - `AGENT_SESSION_CLEANUP_INTERVAL` - Cleanup check interval (default: 5 minutes)
- **Description**: Sessions that have been idle longer than the TTL are automatically deleted to free resources.

### 4. Audit Logging
- **File**: `packages/agent/src/logger/audit.ts` (new)
- **File**: `packages/agent/src/server/AgentServer.ts` (modified)
- **Description**: Created dedicated audit logger for sensitive operations:
  - Session deletion
  - Session export
  - Workspace rollback
  - Authentication failures
  - Rate limit events
- Audit logs are written to separate rotating log files with 90-day retention.

---

## Bugs (Medium Priority) ✅

### 1. Stale Socket Cleanup
- **File**: `packages/agent/src/server/AgentServer.ts`
- **Description**: Added periodic cleanup (every 60 seconds) that removes session ownership entries for sockets that are no longer connected. Handles cases where clients disconnect ungracefully without firing the `disconnect` event.

### 2. Tool Result Truncation for Storage
- **File**: `packages/agent/src/tools/ToolExecutor.ts`
- **Description**: Large tool outputs are now truncated to `AGENT_MAX_TOOL_RESULT_SIZE` before storage in the database, while the full result is still returned in the API response.

### 3. Agent Event Listener Leak Prevention
- **File**: `packages/ui/src/hooks/useAgentSocket.ts`
- **Description**: 
  - Changed handlers storage from Array to Set to prevent duplicate handlers
  - Added maximum handler limit (50) with automatic removal of oldest handler
  - Clear all handlers on cleanup to prevent memory leaks

---

## Features (Medium Priority) ✅

### 1. Custom Project Context
- **File**: `packages/agent/src/agent/Agent.ts`
- **Description**: The agent now reads `.agentcontext` or `.agent/context.md` from the workspace and appends it to the system prompt. Supports project-specific instructions, coding standards, and tech stack notes. Maximum context size: 10KB (truncated if larger).

### 2. Pin/Favorite Sessions
- **Files**: `packages/agent/src/memory/DatabaseMemory.ts`, `packages/agent/src/server/AgentServer.ts`, `packages/ui/src/components/SessionList.tsx`
- **Description**: 
  - Sessions can be pinned to stay at the top of the list
  - Added `POST /api/sessions/:id/pin` endpoint to toggle pin status
  - Pinned sessions show a 📌 indicator and have a subtle yellow background

### 3. Session Tags/Labels
- **Files**: `packages/agent/src/memory/DatabaseMemory.ts`, `packages/agent/src/server/AgentServer.ts`, `packages/ui/src/lib/types.ts`, `packages/ui/src/components/SessionList.tsx`
- **Description**:
  - Sessions can have up to 10 tags (max 50 chars each)
  - Predefined color-coded tags: feature, bugfix, refactor, docs, test, deploy
  - Added `PUT /api/sessions/:id/tags` endpoint
  - Tags displayed below session summary with color coding

### 4. Keyboard Shortcut Modal
- **File**: `packages/ui/src/components/KeyboardShortcutsModal.tsx` (new)
- **File**: `packages/ui/src/App.tsx` (modified)
- **Description**: Press `?` to show a modal with all available keyboard shortcuts organized by category.

### 5. Sound Notification
- **File**: `packages/ui/src/components/StatusBar.tsx`
- **Description**: 
  - Optional audio notification when a session completes
  - Toggle button (🔔/🔕) in status bar
  - Preference stored in localStorage
  - Uses Web Audio API for a pleasant notification tone

---

## Configuration Updates

### New Environment Variables (`.env.example`)
```env
# Session TTL (Auto-Expiry)
AGENT_SESSION_TTL=86400000          # 24 hours in ms, 0 to disable
AGENT_SESSION_CLEANUP_INTERVAL=300000  # 5 minutes in ms
```

---

## Database Schema Updates

The sessions table now includes:
- `pinned INTEGER NOT NULL DEFAULT 0` - Pin status
- `tags TEXT DEFAULT '[]'` - JSON array of tag strings

Migration is automatic - columns are added on first run if they don't exist.

---

## Files Created
1. `packages/agent/src/utils/Mutex.ts` - Mutex and AtomicCounter utilities
2. `packages/agent/src/utils/index.ts` - Utils module exports
3. `packages/agent/src/logger/audit.ts` - Audit logging system
4. `packages/ui/src/components/KeyboardShortcutsModal.tsx` - Keyboard shortcuts help modal

---

## Files Modified
1. `packages/agent/src/config.ts` - Added session TTL config
2. `packages/agent/src/agent/Agent.ts` - Atomic counter, project context
3. `packages/agent/src/server/AgentServer.ts` - CSP, audit logging, cleanups
4. `packages/agent/src/memory/DatabaseMemory.ts` - Pin/tags, session expiry
5. `packages/agent/src/tools/ToolExecutor.ts` - Tool result truncation
6. `packages/ui/src/App.tsx` - Keyboard shortcuts modal integration
7. `packages/ui/src/hooks/useAgentSocket.ts` - Event listener leak fix
8. `packages/ui/src/components/SessionList.tsx` - Pin/tag UI
9. `packages/ui/src/components/StatusBar.tsx` - Sound notification
10. `packages/ui/src/lib/types.ts` - Updated Session type with pin/tags
11. `.env.example` - Documented new config options

---

## Infrastructure ✅

### Correlation IDs (X-Request-ID)
- **File**: `packages/agent/src/server/AgentServer.ts`
- **Description**: Added correlation ID support for distributed tracing and debugging:
  - Middleware assigns unique UUID to each request (or uses existing `X-Request-ID` header from proxy)
  - Request ID attached to `req.requestId` and returned in `X-Request-ID` response header
  - ID included in all log messages via custom Morgan token format
  - ID included in JSON error responses for client-side debugging
  - CORS updated to accept and expose `X-Request-ID` header
- **Usage**: When debugging issues, search logs by request ID. Clients can capture the ID from error responses for support requests.

### API Retry with Exponential Backoff
- **File**: `packages/agent/src/agent/Agent.ts`
- **Config Options**:
  - `AGENT_API_RETRY_COUNT` - Number of retry attempts (default: 3)
  - `AGENT_API_RETRY_DELAY` - Initial delay between retries in ms (default: 1000)
  - `AGENT_API_RETRY_MAX_DELAY` - Maximum delay cap in ms (default: 30000)
- **Description**: Claude API calls now automatically retry on transient errors:
  - Rate limits (429)
  - Server errors (500, 502, 503, 504)
  - Network errors (ECONNRESET, ETIMEDOUT)
  - Respects `Retry-After` header when present
  - Exponential backoff with 0-30% jitter to prevent thundering herd
  - UI shows retry status with countdown

### Debug Mode
- **Files**: `packages/agent/src/logger/index.ts`, `packages/agent/src/agent/Agent.ts`
- **Config Option**: `AGENT_DEBUG_MODE=true`
- **Description**: When enabled, logs full API requests and responses to `debug-YYYY-MM-DD.log`:
  - Complete message arrays sent to Claude
  - Tool definitions
  - Full response content
  - Token counts per request
  - Error details with stack traces
- **Warning**: Contains sensitive data including prompts. Use only for debugging.

---

## Token Efficiency ✅

### Tool Output Summarization
- **File**: `packages/agent/src/agent/Agent.ts`
- **Config Option**: `AGENT_MAX_TOOL_OUTPUT_CONTEXT=8000` (characters)
- **Description**: Large tool outputs are now intelligently summarized before being sent to Claude:
  - **list_files**: Shows file count, directory count, extension distribution, and sample of 20 files
  - **search_files**: Shows match count, files with matches, top 10 files by match count, and sample of 15 results
  - **run_tests**: Preserves start/end of output, truncates middle with character count
  - **Generic**: Keeps 60% from start and 30% from end with truncation notice
- **Impact**: Significantly reduces token usage for tools that return verbose output (e.g., listing 1000+ files)

### Per-Turn Token Usage Display
- **Files**: `packages/agent/src/agent/Agent.ts`, `packages/ui/src/components/StatusBar.tsx`, `packages/ui/src/lib/types.ts`
- **Description**: Added `turn_complete` event that reports token usage after each API turn:
  - Input tokens and output tokens for the turn
  - Estimated cost for the turn
  - Running totals
  - Budget percentage used
- **UI**: StatusBar temporarily shows per-turn usage (e.g., "Turn 3: 1,234↓ 567↑ ($0.0089)") for 5 seconds after each turn

### Internal Tasks Use Haiku (Cost Optimization)
- **File**: `packages/agent/src/agent/Agent.ts`
- **Constant**: `INTERNAL_MODEL = 'claude-haiku-4-5-20251001'`
- **Description**: Background/auxiliary tasks now use Haiku instead of the user's selected model:
  - **Context summarization**: When conversation exceeds context window limit, older messages are summarized using Haiku (~$0.001 per summary)
  - **Session summary generation**: Creates high-quality one-line session titles using Haiku (~$0.0001 per summary)
  - **Future**: Error classification, intent detection, and other preprocessing tasks
- **Cost Savings**:
  - Haiku is **~20x cheaper** than Opus ($0.80/$4 vs $15/$75 per M tokens)
  - Typical session saves $0.05-$0.20 on internal operations
  - User's selected model (Opus/Sonnet) reserved for actual coding and reasoning tasks
- **Impact**: Users get the full power of Opus/Sonnet for coding while internal housekeeping runs on the most efficient model

---

## Git Operations ✅

### Full Git Toolset
- **File**: `packages/agent/src/tools/GitTool.ts`, `packages/agent/src/tools/schemas.ts`, `packages/agent/src/tools/ToolExecutor.ts`
- **New Tools**:
  - `git_branch` - List, create, delete, or switch branches
  - `git_log` - View commit history with filters
  - `git_clone` - Clone repositories into workspace
  - `git_merge` - Merge branches with conflict detection
  - `git_stash` - Push, pop, list, apply, drop, clear stashes
  - `git_reset` - Reset HEAD (soft/mixed/hard modes)
  - `git_remote` - Manage remote repositories
  - `git_push` - Push commits to remote (was added earlier)
  - `git_pull` - Pull changes from remote (was added earlier)

### Git Credentials for Docker Mode
- **Files**: `docker/entrypoint.sh` (new), `docker/Dockerfile.agent`, `docker-compose.yml`, `.env.example`
- **Config Options**:
  - `GIT_CREDENTIALS` - URL with embedded token (e.g., `https://user:ghp_xxx@github.com`)
  - `GIT_USER_EMAIL` - Git commit author email (optional)
  - `GIT_USER_NAME` - Git commit author name (optional)
- **Description**: Docker entrypoint script configures git credentials from environment variables, enabling push/pull operations in containerized deployments.

---

## Multi-Cloud Deployment ✅

### Vercel Deployment
- **File**: `packages/agent/src/tools/VercelTool.ts`
- **Tool**: `deploy_vercel`
- **Config**: `VERCEL_TOKEN` environment variable
- **Features**:
  - Preview and production deployments
  - Custom project naming
  - Build command override
  - Environment variable injection
- **Security**:
  - Auth token passed via environment (never in command args)
  - No shell execution (spawn with explicit args)
  - Path traversal protection
  - Project name validation (alphanumeric only)

### AWS S3 + CloudFront Deployment
- **File**: `packages/agent/src/tools/AWSTool.ts`
- **Tool**: `deploy_aws_s3`
- **Config**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- **Features**:
  - S3 bucket sync with `--delete` option
  - CloudFront cache invalidation
  - Optional build step before upload
  - File count reporting
- **Security**:
  - AWS credentials from environment variables
  - Bucket name validation (3-63 chars, lowercase, no consecutive dots)
  - Region format validation
  - CloudFront distribution ID validation
  - Path traversal protection

### Terraform / Infrastructure as Code
- **File**: `packages/agent/src/tools/TerraformTool.ts`
- **Tools**:
  - `terraform_init` - Initialize Terraform directory
  - `terraform_plan` - Generate execution plan
  - `terraform_apply` - Apply changes (with approval gate)
  - `terraform_destroy` - Destroy infrastructure (requires explicit approval)
  - `terraform_output` - Retrieve output values
- **Security**:
  - **Approval gates**: `terraform_apply` requires either a saved plan file or explicit `autoApprove=true`
  - **Approval gates**: `terraform_destroy` always requires explicit `autoApprove=true`
  - Variable name validation (no shell metacharacters)
  - Variable value validation (blocks `;&|$(){}[]` etc.)
  - Sensitive output filtering (passwords, API keys, etc.)
  - Path traversal protection for all directories
  - tfvars file validation (must be within terraform directory)

### Autonomous Infrastructure Generation
- **File**: `packages/agent/src/tools/InfrastructureGenerator.ts`
- **Tool**: `generate_infrastructure`
- **Description**: Analyzes a project and generates appropriate Terraform configurations.
- **Supported Providers**: AWS, Vercel, Netlify
- **Infrastructure Types**:
  - `static` - S3 + CloudFront (or equivalent)
  - `serverless` - Lambda + API Gateway
  - `container` - ECS/Fargate
  - `fullstack` - Multiple services combined
- **Features**:
  - Auto-detects project type (React, Next.js, Vue, Angular, Node.js API)
  - Generates `main.tf`, `variables.tf`, `outputs.tf`
  - Optional: CDN, HTTPS, WAF
  - Custom domain support
- **Security**:
  - Resource names sanitized (alphanumeric + hyphens only)
  - Sensitive values use Terraform variables (never hardcoded)
  - Generated files are Terraform code only (no execution)

### Secret Scanning (Enhanced)
- **File**: `packages/agent/src/agent/Agent.ts`
- **New Patterns Added**:
  - Vercel tokens
  - Terraform Cloud tokens
- **Description**: Git checkpoint operations are blocked if any deployment tokens are detected in the workspace.

---

## Configuration Updates

### New Environment Variables (`.env.example`)
```env
# API Retry Settings
AGENT_API_RETRY_COUNT=3
AGENT_API_RETRY_DELAY=1000
AGENT_API_RETRY_MAX_DELAY=30000

# Tool Output Context Limit
AGENT_MAX_TOOL_OUTPUT_CONTEXT=8000

# Debug Mode
AGENT_DEBUG_MODE=false

# Git Credentials (Docker mode)
GIT_CREDENTIALS=https://username:token@github.com
GIT_USER_EMAIL=you@example.com
GIT_USER_NAME=Your Name
```

---

## UX Improvements ✅

### 1. Model Selection Per-Task
- **Files**: 
  - `packages/agent/src/agent/Agent.ts` - Accept model override in run()
  - `packages/agent/src/server/AgentServer.ts` - Accept model in prompt endpoints
  - `packages/ui/src/hooks/useAgentSocket.ts` - Model selection state
  - `packages/ui/src/components/ModelSelector.tsx` - Model dropdown UI
- **Description**: Users can now select which Claude model to use per session:
  - **Opus**: Most capable, highest cost (default for complex tasks)
  - **Sonnet**: Balanced performance/cost (default)
  - **Haiku**: Fast and affordable (good for simple tasks)
- **Features**:
  - Model selection persisted in localStorage
  - Cost indicator dots show relative pricing
  - Disabled during active session to prevent mid-run changes
  - Agent validates model against allowlist before use

### 2. Progress Indicators for Long-Running Tools
- **Files**:
  - `packages/agent/src/tools/ToolExecutor.ts` - Progress callback support
  - `packages/agent/src/agent/Agent.ts` - Emit tool_progress events
  - `packages/ui/src/components/ToolLog.tsx` - Progress bar UI
  - `packages/ui/src/lib/types.ts` - ToolProgressEvent interface
- **Long-running tools tracked**:
  - npm_install, npm_run, run_tests
  - git_clone, deploy_netlify
  - tsc_check, eslint_check, prettier_format
- **Features**:
  - Animated progress bar with percentage
  - Elapsed time counter
  - Status text showing current phase
  - Simulated progress with diminishing returns (never hits 100% until complete)

### 3. Diff Preview for Patch Approval
- **Files**:
  - `packages/agent/src/agent/Agent.ts` - Patch approval mechanism
  - `packages/agent/src/server/AgentServer.ts` - Socket handler for approvals
  - `packages/ui/src/components/DiffPreviewModal.tsx` - Diff viewer modal
  - `packages/ui/src/App.tsx` - Modal integration
- **Config Option**: `AGENT_REQUIRE_PATCH_APPROVAL=true`
- **Features**:
  - Shows unified diff with syntax highlighting
  - Green for additions, red for deletions, blue for context
  - Operation indicator (CREATE/MODIFY/DELETE)
  - Keyboard shortcuts: ⌘+Enter to approve, ⌘+⌫ to reject, Esc to close
  - 2-minute timeout with auto-reject
  - File path displayed prominently

### 4. Conversation Export
- **Files**:
  - `packages/agent/src/server/AgentServer.ts` - Export endpoint
  - `packages/ui/src/components/SessionList.tsx` - Export buttons
  - `packages/ui/src/App.tsx` - Export keyboard shortcut
- **Formats**:
  - **Markdown** (.md): Human-readable with headers, formatting
  - **JSON** (.json): Machine-readable with full metadata
- **Features**:
  - Export buttons visible on hover in session list
  - Keyboard shortcut ⌘/Ctrl+E to export active session
  - Header button in main UI
  - Includes: session summary, token usage, all messages, tool results
  - Audit logged for compliance

---

## Not Implemented (Deferred)

These items from the requirements were noted but not implemented in this iteration:

### Optimization
- Message pagination (would require significant API changes)
- Virtualized session list (requires react-window integration)
- Lazy workspace tree (requires refactoring tree loading)
- Incremental tree updates via file watchers (high effort)

### Infrastructure
- Structured error codes (medium effort)
- OpenTelemetry tracing (high effort)
- Database migrations (medium effort)
- Multi-node support / PostgreSQL (high effort)

### UX
- Mobile responsiveness (medium effort)
- Drag-and-drop file upload (medium effort)
- Dark/light theme toggle (medium effort)
- Onboarding wizard (medium effort)
- Terminal colorization (medium effort)

### Features
- Session templates (medium effort)
- In-session search (medium effort)

---

## CLI Client ✅

### Standalone CLI for Running Server
- **File**: `./klaus` (root of project)
- **Purpose**: Send prompts to a running Klaus-Code server from your local terminal (VSCode, iTerm, etc.)
- **No dependencies**: Pure Node.js, no npm install needed

**Usage:**
```bash
# Basic usage
./klaus "run tests for backend"
./klaus "lint src folder"
./klaus "find all TODO comments"

# Use a specific model
./klaus --model haiku "format all files"
./klaus --model opus "refactor this complex function"

# Resume a session
./klaus --session abc123 "now add error handling"

# Custom server URL
./klaus --url http://192.168.1.100:3001 "your prompt"
```

**Environment Variables:**
- `KLAUS_URL` - Default server URL (default: http://localhost:3001)
- `KLAUS_API_SECRET` - API secret for authentication
- `KLAUS_SESSION` - Default session ID to resume

**Features:**
- Streams response in real-time
- Shows tool calls and results
- Displays token usage and cost per turn
- Provides session ID for continuation
- Color-coded output for readability

---

## Multi-Cloud Deployment ✅

Klaus-Code supports full deployment flexibility across multiple cloud providers with both direct deployment and Infrastructure-as-Code (IaC) capabilities.

### Supported Providers

| Provider | Tool | Description |
|----------|------|-------------|
| **Netlify** | `deploy_netlify` | Build and deploy static sites or Jamstack apps |
| **Vercel** | `deploy_vercel` | Deploy React, Next.js, Vue, and other frameworks |
| **AWS S3** | `deploy_aws_s3` | Static site hosting with optional CloudFront CDN |
| **AWS (IaC)** | `terraform_*` | Full infrastructure management via Terraform |

### 1. Direct Deployment Tools

#### Vercel (`deploy_vercel`)
```bash
# Example prompts:
"Deploy my React app to Vercel"
"Deploy to Vercel production"
"Deploy with custom build command"
```

**Features:**
- Auto-detects framework (React, Next.js, Vue, etc.)
- Preview and production deployments
- Custom build commands and output directories
- Environment variable support

**Configuration:**
```env
VERCEL_TOKEN=your_vercel_token
```

#### AWS S3 (`deploy_aws_s3`)
```bash
# Example prompts:
"Deploy to S3 bucket my-website"
"Deploy with CloudFront invalidation"
"Upload build folder to S3"
```

**Features:**
- Syncs build directory to S3
- Optional CloudFront cache invalidation
- Region selection
- Build command execution before upload

**Configuration:**
```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
```

### 2. Terraform / IaC Tools

Full infrastructure-as-code support for AWS (extendable to other providers).

#### `terraform_init`
Initialize Terraform working directory. Downloads providers and configures backend.

#### `terraform_plan`
Generate execution plan showing what will be created/modified/destroyed.
- Saves plan to file for safe apply
- Variable support via `-var` flags or `.tfvars` files
- Destroy planning mode

#### `terraform_apply`
Apply infrastructure changes.
- **Security:** Requires saved plan file OR explicit `autoApprove=true`
- Never auto-approves by default
- 10-minute timeout for complex deployments

#### `terraform_destroy`
Tear down infrastructure.
- **Security:** Always requires explicit `autoApprove=true`
- WARNING logged for audit trail

#### `terraform_output`
Retrieve outputs from Terraform state (URLs, resource IDs, etc.).
- JSON output format
- Sensitive values redacted

### 3. Infrastructure Generator (`generate_infrastructure`)

Autonomous infrastructure generation that analyzes your project and creates appropriate Terraform configurations.

```bash
# Example prompts:
"Generate AWS infrastructure for my React app"
"Create Terraform for serverless deployment"
"Set up ECS Fargate for my Node.js API"
```

**Supported Infrastructure Types:**

| Type | Description | AWS Resources |
|------|-------------|---------------|
| `static` | Static website hosting | S3, CloudFront, ACM, Route53 |
| `serverless` | Serverless functions | Lambda, API Gateway, CloudWatch |
| `container` | Container deployment | ECS Fargate, ECR, ALB |
| `fullstack` | Full application stack | Combines above resources |

**Project Detection:**
- React (Vite/CRA)
- Next.js
- Vue
- Angular
- Node.js API
- Static HTML

**Generated Files:**
- `main.tf` - Provider configuration, default tags
- `variables.tf` - Input variables (region, environment, etc.)
- `s3.tf` / `lambda.tf` / `ecs.tf` - Resource definitions
- `outputs.tf` - Exported values (URLs, IDs)

### Security Architecture

All deployment tools follow the same security principles as the rest of Klaus-Code:

| Security Layer | Implementation |
|----------------|----------------|
| **Path Traversal** | All directories validated against workspace |
| **Input Validation** | Zod schemas, bucket name validation, region validation |
| **Credential Safety** | Tokens via env vars (never in command args) |
| **Shell Safety** | No shell execution — spawn with explicit args |
| **Sensitive Output** | Passwords, keys, tokens filtered from logs |
| **Approval Gates** | `terraform_apply` and `terraform_destroy` require explicit approval |
| **Command Injection** | Variable names/values validated for shell metacharacters |

### Example Workflows

#### Deploy Static Site to AWS
```
User: "Deploy my React app to AWS with CloudFront"

Agent:
1. generate_infrastructure provider=aws type=static
2. terraform_init
3. terraform_plan
4. terraform_apply planFile=tfplan
5. deploy_aws_s3 (upload built files)
```

#### Set Up Serverless API
```
User: "Create a Lambda function for my Node.js API"

Agent:
1. Analyze package.json to detect Node.js API
2. generate_infrastructure provider=aws type=serverless
3. Generate Lambda function configuration
4. terraform_init && terraform_plan
5. terraform_apply (with approval)
```

#### Multi-Provider Comparison
```
User: "Deploy to both Vercel and AWS, compare the setup"

Agent:
1. deploy_vercel (quick preview)
2. generate_infrastructure provider=aws type=static
3. Compare: Vercel = zero-config, AWS = more control
```

### Testing

Comprehensive test suite in `packages/agent/src/__tests__/unit/DeploymentTools.test.ts`:

- **Security tests:** Path traversal, injection prevention, credential handling
- **Validation tests:** Bucket names, regions, project names
- **Happy path tests:** Minimal options, full configurations
- **Schema tests:** Zod validation for all inputs
- **Integration tests:** Full workflow simulation

Run tests:
```bash
npm run test -- --testPathPattern=DeploymentTools
```
