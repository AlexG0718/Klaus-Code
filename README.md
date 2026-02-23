# 🤖 Klaus-Code 4.0

A production-grade autonomous AI software engineering agent powered by Claude. It runs on your local machine inside Docker, has full access to a workspace you point it at, and can build applications, write tests, refactor code, and deploy to **Netlify, Vercel, or AWS** — all without human intervention.

---

## Architecture

```
Klaus-Code_4.0/
├── packages/
│   ├── agent/                        # Node.js backend (TypeScript)
│   │   └── src/
│   │       ├── agent/
│   │       │   └── Agent.ts              # 🧠 Core agentic loop (Claude integration)
│   │       ├── tools/
│   │       │   ├── schemas.ts            # 🔍 Zod validation for all tool inputs
│   │       │   ├── ToolExecutor.ts       # ⚙️  Tool dispatch + retry + sandbox routing
│   │       │   ├── FileTool.ts           # 📁 File R/W + patch-based diffs
│   │       │   ├── BuildTool.ts          # 🔨 npm install / run / tsc
│   │       │   ├── LintTool.ts           # 🧹 ESLint + Prettier
│   │       │   ├── ScriptTool.ts         # 📜 node/ts-node script runner
│   │       │   ├── GitTool.ts            # 📌 Git checkpoints + diffs
│   │       │   ├── TestTool.ts           # 🧪 Jest/Vitest runner + result parsing
│   │       │   └── DeployTool.ts         # 🚀 Netlify build + deploy
│   │       ├── memory/
│   │       │   └── DatabaseMemory.ts     # 🗃️  SQLite persistent memory
│   │       ├── sandbox/
│   │       │   └── DockerSandbox.ts      # 🐳 Isolated per-command container execution
│   │       ├── server/
│   │       │   └── AgentServer.ts        # 🌐 Express + Socket.IO API server
│   │       ├── logger/
│   │       │   └── index.ts              # 📝 Winston rotating file logger
│   │       └── config.ts                 # ⚙️  Env-validated config (Zod)
│   │
│   └── ui/                           # React frontend (TypeScript + Vite)
│       └── src/
│           ├── components/
│           │   ├── ChatView.tsx          # 💬 Main chat interface
│           │   ├── ToolLog.tsx           # 🔧 Real-time tool activity panel
│           │   ├── SessionList.tsx       # 📋 Session history sidebar
│           │   └── StatusBar.tsx         # 📊 Token budget meter + status
│           ├── hooks/
│           │   └── useAgentSocket.ts     # 🔌 WebSocket integration
│           └── lib/
│               └── types.ts              # 📐 Shared TypeScript types
│
├── docker/
│   ├── Dockerfile.agent              # 🐳 Agent container image
│   └── Dockerfile.ui                 # 🐳 UI container image (static serve)
├── docker-compose.yml                # 🐳 Full-stack compose (agent + UI)
└── .github/workflows/ci.yml          # 🔄 CI pipeline
```

---

## Features

| Feature                      | Detail                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agentic loop**             | Streams Claude responses, dispatches tool calls in parallel where safe, loops until `end_turn`                                                                                      |
| **Token budget**             | Per-session token ceiling with live progress bar; 80% warning + hard halt at 100%                                                                                                   |
| **Prompt caching**           | System prompt uses Anthropic's `cache_control` for 90% discount on cached tokens after first call                                                                                   |
| **Tool call limit**          | Max tool calls per session catches stuck retry loops before the budget is drained                                                                                                   |
| **Concurrent session cap**   | Configurable max concurrent sessions; excess requests get a `429`                                                                                                                   |
| **Docker sandbox**           | Every `build`, `lint`, `test`, and `script` tool call runs in its own isolated container — no network, read-only root, dropped capabilities, default seccomp profile, memory limits |
| **Persistent memory**        | SQLite via `better-sqlite3` — sessions, messages, knowledge, tool stats, token usage                                                                                                |
| **Zod validation**           | All tool inputs schema-validated before execution                                                                                                                                   |
| **Retry logic**              | Up to 3 retries with exponential backoff on validation failure                                                                                                                      |
| **Git checkpoints**          | Auto-commit before mutations via `simple-git`; async secret scan blocks credentials from commits                                                                                    |
| **Parallel tool execution**  | Read-only tools run with `Promise.all`; write tools run sequentially to prevent races                                                                                               |
| **Graceful shutdown**        | `SIGTERM`/`SIGINT` handlers drain active sessions with configurable timeout, flush SQLite WAL, close HTTP server cleanly                                                            |
| **Rate limiting**            | 60 req/min per IP on HTTP; configurable events/min per socket on WebSocket; works behind proxies with `AGENT_TRUST_PROXY`                                                           |
| **CORS**                     | Restricted to configured origin (`AGENT_CORS_ORIGIN`); preflight caching; warns at startup if set to `*`                                                                            |
| **Prometheus metrics**       | `/metrics` endpoint exposes requests, tool calls, tokens, sessions, errors for monitoring                                                                                           |
| **Deep health checks**       | `/health` endpoint verifies database connectivity and Docker availability                                                                                                           |
| **Webhook notifications**    | Optional webhook URL receives POST when sessions complete or fail — for CI/CD or Slack                                                                                              |
| **Netlify deploy**           | `deploy_netlify` tool or `npm run deploy` CLI — auth token passed as env var, never in args                                                                                         |
| **Vercel deploy**            | `deploy_vercel` tool with auto-detection of React, Next.js, Vue, Angular — preview and production modes                                                                             |
| **AWS S3 deploy**            | `deploy_aws_s3` tool syncs build directory to S3 with optional CloudFront CDN invalidation                                                                                          |
| **Terraform IaC**            | Full Terraform lifecycle: `terraform_init`, `terraform_plan`, `terraform_apply`, `terraform_destroy`, `terraform_output`                                                            |
| **Infrastructure generator** | `generate_infrastructure` analyzes project and creates Terraform configs for AWS static, serverless, or container deployments                                                       |
| **Logging**                  | Winston with daily rotating files, error-specific log, structured JSON                                                                                                              |
| **Session management**       | Delete (with 5s undo), rename (double-click), export to Markdown/JSON from the UI                                                                                                   |
| **Session history**          | Clicking a past session in the sidebar loads its full conversation history                                                                                                          |
| **Session export**           | Export full conversation, tool calls, and results to Markdown or JSON for documentation                                                                                             |
| **File viewer**              | Click any file in the workspace tree to preview; syntax highlighting; binary file detection; image rendering                                                                        |
| **Workspace rollback**       | Rollback button discards uncommitted changes and reverts to last git checkpoint                                                                                                     |
| **Workspace tree caching**   | ETag-based caching returns `304 Not Modified` when tree hasn't changed                                                                                                              |
| **Error boundary**           | React error boundary prevents white-screen crashes; shows retry button                                                                                                              |
| **Collapsible panels**       | Toggle left/right sidebars with `Ctrl+B` / `Ctrl+]` to maximize chat space                                                                                                          |
| **Keyboard shortcuts**       | `Ctrl+Enter` to send, `Escape` to cancel/close, `↑↓` to navigate sessions                                                                                                           |
| **Copy code blocks**         | Hover over code blocks in chat to reveal copy button                                                                                                                                |
| **Output capping**           | Process stdout/stderr capped at 5MB to prevent memory exhaustion from runaway output                                                                                                |
| **Context summarization**    | Uses `claude-haiku-4-5` for context window summarization (~20× cheaper than Opus)                                                                                                   |
| **Bounded search**           | `search_files` capped at configurable limit (default 500) to prevent context window overflow                                                                                        |

---

## Quick Start

### 1. Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running
- Node.js 20+ (only needed for `npm run dev` local mode)
- An [Anthropic API key](https://console.anthropic.com/)

### 2. Install

```bash
git clone <this-repo>
cd Klaus-Code_4.0
cp .env.example .env
npm install
```

Dependency deprecations and warnings (Intentional)

ESLint 8 → 9: Requires config migration to flat config format. Medium effort, can do later.
Major version bumps that could break APIs (kept diff, inquirer, zustand at compatible versions)

The remaining warnings are cosmetic — the application will work correctly and the production security is solid.

### 3. Configure

Open `.env` and set at minimum:

```bash
ANTHROPIC_API_KEY=sk-ant-...\nAGENT_WORKSPACE=/path/to/your/project   # the directory the agent will work in
AGENT_API_SECRET=<random-32-char-string> # protects the API; generate with: openssl rand -hex 32
```

> **⚠️ Never commit `.env` to version control.** If your `.env` has been shared or committed, rotate your `ANTHROPIC_API_KEY` and `AGENT_API_SECRET` immediately.

### 4. Start

```bash
# Recommended: fully containerised (agent + UI in Docker)
npm run serve

# Open the UI
open http://localhost:5173
```

The agent and UI run inside Docker containers on your local machine. Your workspace is bind-mounted in so the agent can read and write your project files. The database persists in a Docker named volume across restarts.

---

## Running Modes

| Command                | Where it runs                     | Use when                                     |
| ---------------------- | --------------------------------- | -------------------------------------------- |
| `npm run serve`        | Docker (agent + UI containerised) | Normal use — full sandbox isolation          |
| `npm run serve:detach` | Docker (background)               | You want it running without a terminal       |
| `npm run stop`         | —                                 | Shut down containers (database is preserved) |
| `npm run dev`          | Host machine (no Docker)          | Developing the agent itself                  |

> **Note:** `npm run serve` builds the Docker images on first run, which takes 1–2 minutes. Subsequent starts are fast.

---

## CLI Client

Once the server is running, you can send prompts directly from your terminal (VSCode, iTerm, etc.):

```bash
# Basic usage
./klaus "run tests for backend"
./klaus "lint src folder"
./klaus "find all TODO comments"

# Use a cheaper/faster model for simple tasks
./klaus --model haiku "format all files"

# Use the most capable model for complex tasks
./klaus --model opus "refactor the auth system"

# Resume a previous session
./klaus --session abc123 "now add error handling"
```

The CLI streams responses in real-time, shows tool execution, and displays token costs.

**Environment variables:**

- `KLAUS_URL` — Server URL (default: `http://localhost:3001`)
- `KLAUS_API_SECRET` — API secret if configured
- `KLAUS_SESSION` — Default session to resume

---

## Environment Variables

| Variable                        | Default                 | Description                                                                                                                                |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`             | —                       | **Required.** Your Anthropic API key                                                                                                       |
| `AGENT_WORKSPACE`               | `$PWD`                  | Directory the agent reads and writes                                                                                                       |
| `AGENT_API_SECRET`              | —                       | Bearer token protecting the API (strongly recommended)                                                                                     |
| `AGENT_MODEL`                   | `claude-opus-4-5`       | Claude model to use                                                                                                                        |
| `AGENT_TOKEN_BUDGET`            | `100000`                | Per-session token limit (input + output). `0` = unlimited                                                                                  |
| `AGENT_MAX_TOOL_CALLS`          | `50`                    | Max tool calls per session. `0` = unlimited                                                                                                |
| `AGENT_MAX_CONCURRENT_SESSIONS` | `3`                     | Max simultaneous agent sessions                                                                                                            |
| `AGENT_CORS_ORIGIN`             | `http://localhost:5173` | Allowed HTTP origin for API and WebSocket                                                                                                  |
| `AGENT_MAX_PROMPT_CHARS`        | `32000`                 | Max characters per prompt                                                                                                                  |
| `AGENT_MAX_SEARCH_RESULTS`      | `500`                   | Max results from `search_files` tool (prevents context overflow)                                                                           |
| `AGENT_TRUST_PROXY`             | `false`                 | Trust proxy setting for correct IP detection behind reverse proxies. Values: `false`, `true`, `1`, `2`, `loopback`, or comma-separated IPs |
| `AGENT_WS_RATE_LIMIT`           | `30`                    | Max WebSocket events per socket per minute                                                                                                 |
| `AGENT_SHUTDOWN_TIMEOUT`        | `30000`                 | Graceful shutdown timeout in milliseconds                                                                                                  |
| `AGENT_WEBHOOK_URL`             | —                       | Optional URL for session completion/failure notifications                                                                                  |
| `AGENT_MAX_TOOL_RESULT_SIZE`    | `10240`                 | Max tool result size stored in database (bytes)                                                                                            |
| `AGENT_METRICS_ENABLED`         | `true`                  | Enable `/metrics` endpoint for Prometheus                                                                                                  |
| `AGENT_REQUIRE_PATCH_APPROVAL`  | `false`                 | Require human approval before applying patches                                                                                             |
| `AGENT_MAX_TOKENS`              | `8192`                  | Max output tokens per Claude API call                                                                                                      |
| `AGENT_MAX_RETRIES`             | `3`                     | Tool call retries on validation failure                                                                                                    |
| `DOCKER_ENABLED`                | `true`                  | Route tool commands through Docker sandbox                                                                                                 |
| `NETLIFY_AUTH_TOKEN`            | —                       | Netlify personal access token for deploys                                                                                                  |
| `NETLIFY_SITE_ID`               | —                       | Netlify site ID for deploys                                                                                                                |
| `LOG_LEVEL`                     | `info`                  | Winston log level (`debug`, `info`, `warn`, `error`)                                                                                       |

---

## Tool Reference

The agent has access to these tools, all Zod-validated. Read-only tools run in parallel; write tools run sequentially.

### File & Git Tools

| Tool             | Sandboxed | Description                                      |
| ---------------- | --------- | ------------------------------------------------ |
| `read_file`      | —         | Read file contents                               |
| `write_file`     | —         | Write new files (workspace-confined)             |
| `apply_patch`    | —         | Apply unified diff patches (preferred for edits) |
| `delete_file`    | —         | Delete files/directories                         |
| `list_files`     | —         | Glob file listing                                |
| `search_files`   | —         | Regex search across files                        |
| `git_checkpoint` | —         | Create git commit; blocks credentials            |
| `git_diff`       | —         | View uncommitted changes                         |
| `git_status`     | —         | View workspace status                            |
| `git_push`       | —         | Push to remote                                   |
| `git_pull`       | —         | Pull from remote                                 |
| `git_branch`     | —         | List/create/switch branches                      |
| `git_log`        | —         | View commit history                              |
| `git_clone`      | ✅        | Clone a repository                               |
| `git_merge`      | —         | Merge branches                                   |
| `git_stash`      | —         | Stash/unstash changes                            |
| `git_reset`      | —         | Reset to commit                                  |
| `git_remote`     | —         | Manage remotes                                   |

### Build & Test Tools

| Tool              | Sandboxed | Description                                |
| ----------------- | --------- | ------------------------------------------ |
| `npm_install`     | ✅        | Install packages (validates package names) |
| `npm_run`         | ✅        | Run a script defined in `package.json`     |
| `tsc_check`       | ✅        | TypeScript type check (`--noEmit`)         |
| `eslint_check`    | ✅        | Lint files with ESLint                     |
| `prettier_format` | ✅        | Format files with Prettier                 |
| `run_node_script` | ✅        | Run a `.js`/`.ts` script                   |
| `run_tests`       | ✅        | Run Jest/Vitest (unit / integration / e2e) |

### Memory Tools

| Tool         | Sandboxed | Description                         |
| ------------ | --------- | ----------------------------------- |
| `memory_set` | —         | Store a key/value fact persistently |
| `memory_get` | —         | Retrieve a stored fact              |

### Deployment Tools

| Tool                      | Sandboxed | Description                                         |
| ------------------------- | --------- | --------------------------------------------------- |
| `deploy_netlify`          | —         | Build + deploy to Netlify                           |
| `deploy_vercel`           | —         | Deploy to Vercel (preview or production)            |
| `deploy_aws_s3`           | —         | Sync to S3 + CloudFront invalidation                |
| `terraform_init`          | —         | Initialize Terraform directory                      |
| `terraform_plan`          | —         | Generate execution plan                             |
| `terraform_apply`         | —         | Apply changes (requires approval)                   |
| `terraform_destroy`       | —         | Destroy infrastructure (requires explicit approval) |
| `terraform_output`        | —         | Retrieve Terraform outputs                          |
| `generate_infrastructure` | —         | Auto-generate Terraform configs for project         |

---

## REST API

All endpoints except `/health` and `/metrics` require `Authorization: Bearer <AGENT_API_SECRET>`.

| Method   | Endpoint                       | Description                                                                                            |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET`    | `/health`                      | Deep health check (unauthenticated) — verifies database, Docker, returns active sessions, token budget |
| `GET`    | `/metrics`                     | Prometheus metrics (unauthenticated) — requests, tool calls, tokens, sessions, errors                  |
| `POST`   | `/api/prompt`                  | Send a prompt to the agent. Body: `{ message, sessionId? }`                                            |
| `POST`   | `/api/sessions/:id/cancel`     | Cancel a running session                                                                               |
| `GET`    | `/api/sessions`                | List sessions (optionally filter with `?q=search`)                                                     |
| `GET`    | `/api/sessions/:id`            | Get session detail with messages, token usage, and tool stats                                          |
| `DELETE` | `/api/sessions/:id`            | Delete a session and all its history                                                                   |
| `PUT`    | `/api/sessions/:id/rename`     | Rename a session. Body: `{ name }`                                                                     |
| `GET`    | `/api/sessions/:id/export`     | Export session to Markdown or JSON. Query: `?format=markdown\|json`                                    |
| `GET`    | `/api/workspace/tree`          | Get the workspace file tree (supports `If-None-Match` ETag for caching)                                |
| `GET`    | `/api/workspace/file?path=...` | Read a workspace file's content (max 5MB, workspace-confined)                                          |
| `POST`   | `/api/workspace/rollback`      | Rollback workspace to last git checkpoint (discards uncommitted changes)                               |
| `GET`    | `/api/usage`                   | Get total token usage summary                                                                          |

### WebSocket Events

Connect to the server with Socket.IO. Pass `{ token: AGENT_API_SECRET }` in `auth`.

WebSocket connections are rate-limited to `AGENT_WS_RATE_LIMIT` events per minute per socket.

| Event (client → server) | Description                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| `join_session`          | Join a session room to receive events (validates session ID format) |
| `prompt`                | Send a prompt: `{ message, sessionId? }`                            |
| `cancel`                | Cancel a running session                                            |

| Event (server → client) | Description                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_event`           | All agent events: `thinking`, `stream_delta`, `tool_call`, `tool_result`, `message`, `error`, `budget_warning`, `budget_exceeded`, `tool_limit_exceeded`, `complete` |
| `prompt_complete`       | Prompt finished successfully                                                                                                                                         |
| `joined`                | Acknowledgement of `join_session`                                                                                                                                    |
| `error_event`           | Error message (e.g., rate limit exceeded, invalid session ID)                                                                                                        |
| `server_shutdown`       | Server is shutting down gracefully                                                                                                                                   |

---

## Database

The agent stores everything in a SQLite database. By default this lives in:

| Mode                     | Location                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Docker (`npm run serve`) | Docker named volume `klaus-code_agent-data` — persists across `docker compose down` / `up` |
| Local (`npm run dev`)    | `~/.klaus-code/memory.db`                                                                  |

The database has five tables:

- **`sessions`** — each conversation, with workspace path, summary, and token totals
- **`messages`** — full conversation history for every session
- **`tool_calls`** — every tool call with input, output, success, and timing
- **`token_usage`** — per-session token counts and estimated cost
- **`knowledge`** — key/value facts the agent stores with `memory_set` for future sessions

### Inspecting the database

```bash
# Show a summary of what's stored
npm run db:stats
```

Example output:

```
── Database stats ──────────────────────────────
  Path        : /Users/you/.klaus-code/memory.db
  Sessions    : 24
  Messages    : 847
  Tool calls  : 312
  Knowledge   : 7 entries
  Total cost  : $3.1420
────────────────────────────────────────────────
```

### Change history

Two commands give you a complete audit trail of every code change the agent has made.

**`db changes`** — queries the database for every file-mutating tool call (file creates, patches, deletes, and git commits) in chronological order:

```bash
# All changes across all sessions
npm run db:changes

# Changes for a specific session only
npm run db:changes -- --session <session-id>

# Include full file content / patch text for each change
npm run db:changes -- --diff
```

Example output:

```
────────────────────────────────────────────────────────────────
Session   a3f2c1d8-...
Workspace /Users/you/myproject
────────────────────────────────────────────────────────────────
2025-11-14 10:22:01  COMMIT   Add authentication module
2025-11-14 10:22:04  CREATE   src/auth/login.ts          (312ms)
2025-11-14 10:22:06  CREATE   src/auth/register.ts       (287ms)
2025-11-14 10:22:09  MODIFY   src/routes/index.ts        (94ms)
2025-11-14 10:22:15  COMMIT   Add auth routes and tests
2025-11-14 10:22:18  CREATE   src/auth/__tests__/login.test.ts
2025-11-14 10:22:31  MODIFY   src/auth/login.ts          (103ms)
```

**`db git-log`** — shows the git history of all commits made by the agent in the workspace:

```bash
# Show all agent commits
npm run db:git-log

# Limit to the last 10 commits
npm run db:git-log -- --limit 10

# Show the full diff for a specific commit
npm run db:git-log -- --show a3f2c1d8

# Show all commits with their full diffs inline
npm run db:git-log -- --patch

# Inspect a different workspace than the default
npm run db:git-log -- --workspace /path/to/project
```

Example output:

```
Agent commit history  (6 commits, workspace: /Users/you/myproject)

a3f2c1d8  2025-11-14 10:22:01  [AI Agent] Add authentication module
b7e9f243  2025-11-14 10:22:15  [AI Agent] Add auth routes and tests
c1d4a892  2025-11-14 10:35:02  [AI Agent] Fix login validation edge case
...

Use --show <hash> to see the full diff for a specific commit.
Use --patch to include diffs for all commits above.
```

The two commands are complementary: `db changes` shows the tool-level view (what the agent did and when, including failed attempts), while `db git-log` shows the git-level view (only what was actually committed, with full diffs).

### Clearing the database

Three surgical commands let you clear selectively without touching the rest:

```bash
# Delete all session history (messages, tool calls, token usage).
# Knowledge entries are kept.
npm run db:clear-sessions

# Delete all knowledge entries the agent has stored.
# Sessions and history are kept.
npm run db:clear-knowledge

# Delete a single category of knowledge entries only.
npm run db:clear-knowledge -- --category project

# Delete everything — sessions, history, and knowledge.
# The schema is preserved; the agent starts fresh on next run.
npm run db:clear-all
```

All three commands ask for confirmation before deleting. Pass `--yes` to skip the prompt in scripts:

```bash
npm run db:clear-all -- --yes
```

### When to clear

**Between projects:** generally not necessary. Session history is scoped to its workspace path and won't interfere with a different project. The only cross-project data is `knowledge` — run `db:clear-knowledge` if the agent has stored project-specific facts that shouldn't carry over.

**Clear sessions when:** the history has grown very large and you want to reclaim space, or you're done with a project and don't need the history any more.

**Clear all when:** starting completely fresh, handing the environment to someone else, or recovering from a corrupt state.

### Wiping the Docker volume entirely

If you want to delete the database file itself (not just its contents) when using Docker:

```bash
# Stops containers AND deletes the named volume
docker compose down -v

# Or delete just the volume without stopping other containers
docker volume rm klaus-code_agent-data
```

The volume is recreated automatically on the next `npm run serve`.

---

## CLI Reference

All commands run via `ts-node packages/agent/src/index.ts <command>` or through the npm scripts listed here.

```bash
# Start the server (Docker)
npm run serve

# Start in background
npm run serve:detach

# Stop containers (preserves database)
npm run stop

# Local dev mode (no Docker)
npm run dev

# Send a single prompt via CLI (no UI needed)
npx ts-node packages/agent/src/index.ts prompt \
  --workspace /path/to/your/project \
  "Build a React authentication form with Zod validation and unit tests"

# Deploy workspace to Netlify
npx ts-node packages/agent/src/index.ts deploy \
  --workspace /path/to/your/project

# Database commands
npm run db:stats
npm run db:clear-sessions
npm run db:clear-knowledge
npm run db:clear-knowledge -- --category <name>
npm run db:clear-all
npm run db:clear-all -- --yes          # skip confirmation
```

---

## Running Tests

```bash
# All unit tests
npm test

# Unit tests only
npm run test:unit -w packages/agent

# Integration tests
npm run test:integration -w packages/agent

# E2E (makes real API calls — requires ANTHROPIC_API_KEY and E2E=true)
E2E=true npm run test:e2e -w packages/agent

# With coverage report
npm test -- --coverage
```

---

## Security Model

| Layer                            | Detail                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker sandbox**               | Every `build`, `lint`, `test`, and `script` tool call runs in a `node:20-alpine` container with `NetworkMode: none`, read-only root filesystem, all Linux capabilities dropped, Docker's default seccomp profile, non-root user, `PidsLimit: 256`, and configurable memory limits |
| **No raw shell**                 | The agent can only call typed tool handlers (`npm_install`, `npm_run`, `tsc_check`, etc.) — there is no code path that constructs or executes a raw shell string from agent input                                                                                                 |
| **Workspace confinement**        | All file and path operations are validated against `AGENT_WORKSPACE` before execution — path traversal is rejected                                                                                                                                                                |
| **Credential isolation**         | `ANTHROPIC_API_KEY` and `AGENT_API_SECRET` are scrubbed from child process environments; never appear in tool arguments, logs, or the database                                                                                                                                    |
| **Secret scanning**              | Git checkpoints are blocked if credential patterns are detected in staged files (async to avoid blocking)                                                                                                                                                                         |
| **Timing-safe auth**             | API and WebSocket authentication use `crypto.timingSafeEqual` to prevent brute-force via timing side-channel                                                                                                                                                                      |
| **WebSocket session validation** | `join_session` validates session ID format and tracks ownership to prevent session hijacking                                                                                                                                                                                      |
| **WebSocket rate limiting**      | Per-socket event rate limiting prevents clients from spamming via WebSocket                                                                                                                                                                                                       |
| **Auth**                         | All API endpoints (except `/health` and `/metrics`) require `Authorization: Bearer <AGENT_API_SECRET>`                                                                                                                                                                            |
| **CORS**                         | Restricted to `AGENT_CORS_ORIGIN` (default `http://localhost:5173`) on both HTTP and WebSocket; preflight caching enabled                                                                                                                                                         |
| **HTTP rate limiting**           | 60 requests per minute per IP; excess requests get `429`. Works correctly behind reverse proxies when `AGENT_TRUST_PROXY` is configured                                                                                                                                           |
| **Prompt size**                  | Prompts over `AGENT_MAX_PROMPT_CHARS` (default 32,000) are rejected before reaching the API                                                                                                                                                                                       |
| **Output capping**               | Process stdout/stderr is capped at 5MB to prevent memory exhaustion from runaway output                                                                                                                                                                                           |
| **Search result capping**        | `search_files` results capped at `AGENT_MAX_SEARCH_RESULTS` to prevent context window overflow                                                                                                                                                                                    |
| **Non-root container**           | The agent Dockerfile runs as the `node` user (uid 1000), not root                                                                                                                                                                                                                 |
| **Graceful shutdown**            | Configurable timeout ensures active requests complete before force-termination                                                                                                                                                                                                    |
| **Docker socket**                | The Docker socket is mounted for sandbox container spawning. For production, replace with a socket proxy (e.g. `tecnativa/docker-socket-proxy`) that restricts API calls                                                                                                          |

---

## Logs

| Mode   | Location                                                        |
| ------ | --------------------------------------------------------------- |
| Docker | `docker compose exec agent cat /data/logs/agent-YYYY-MM-DD.log` |
| Local  | `~/.klaus-code/logs/`                                           |
| Export | `docker compose cp agent:/data/logs ./logs-backup`              |

Log files:

- `agent-YYYY-MM-DD.log` — all logs at configured level and above
- `agent-error-YYYY-MM-DD.log` — errors only
- `exceptions.log` — uncaught exceptions
- `rejections.log` — unhandled promise rejections
