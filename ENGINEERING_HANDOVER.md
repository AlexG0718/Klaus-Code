# Klaus-Code 4.0 — Engineering Handover Document

**Version:** 4.0.0  
**Last Updated:** February 2026  
**Author:** AI Agent Development Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [System Flowchart](#3-system-flowchart)
4. [Directory Structure](#4-directory-structure)
5. [Component Deep Dive](#5-component-deep-dive)
6. [Data Flow](#6-data-flow)
7. [Tool System](#7-tool-system)
8. [Security Model](#8-security-model)
9. [Configuration Reference](#9-configuration-reference)
10. [Database Schema](#10-database-schema)
11. [WebSocket Events](#11-websocket-events)
12. [Error Handling](#12-error-handling)
13. [Testing Strategy](#13-testing-strategy)
14. [Debugging Guide](#14-debugging-guide)
15. [Common Issues & Solutions](#15-common-issues--solutions)
16. [Extension Points](#16-extension-points)

---

## 1. Executive Summary

Klaus-Code is a **production-grade AI coding agent** powered by Claude. It can:
- **Ideate & Plan**: Discuss architecture, break down tasks
- **Generate**: Write code, create files, scaffold projects
- **Build**: Run npm scripts, compile TypeScript
- **Test**: Execute test suites, analyze failures
- **Refactor**: Apply patches, restructure code
- **Deploy**: Push to Netlify (with more targets possible)

### Key Design Principles

1. **Security First**: All code execution happens in isolated Docker containers
2. **Cost Awareness**: Token tracking, budgets, internal tasks use cheap models
3. **Human-in-the-Loop**: Optional patch approval, clear audit trails
4. **Operational Excellence**: Graceful shutdown, rate limiting, health checks

### Tech Stack

| Layer | Technology |
|-------|------------|
| AI Backend | Claude API (Anthropic) |
| Server | Node.js + Express + Socket.IO |
| Database | SQLite (better-sqlite3, synchronous) |
| Frontend | React 18 + TypeScript + Vite |
| Sandbox | Docker (DooD architecture) |
| Styling | Tailwind CSS |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HOST MACHINE                                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         DOCKER NETWORK                               │   │
│  │                                                                      │   │
│  │  ┌──────────────────────┐      ┌──────────────────────┐            │   │
│  │  │     UI Container     │      │    Agent Container    │            │   │
│  │  │    (React + Vite)    │◄────►│  (Node.js + Express)  │            │   │
│  │  │                      │ WS   │                       │            │   │
│  │  │  - Chat interface    │      │  - Claude API client  │            │   │
│  │  │  - Session list      │      │  - Tool executor      │            │   │
│  │  │  - File viewer       │      │  - SQLite database    │            │   │
│  │  │  - Model selector    │      │  - WebSocket server   │            │   │
│  │  │                      │      │                       │            │   │
│  │  │  Port 5173           │      │  Port 3001            │            │   │
│  │  └──────────────────────┘      └───────────┬───────────┘            │   │
│  │                                            │                         │   │
│  │                                            │ Docker Socket           │   │
│  │                                            ▼                         │   │
│  │                                ┌───────────────────────┐            │   │
│  │                                │   Sandbox Container   │ (spawned)  │   │
│  │                                │   (node:20-alpine)    │            │   │
│  │                                │                       │            │   │
│  │                                │  - npm install/run    │            │   │
│  │                                │  - tsc, eslint        │            │   │
│  │                                │  - test execution     │            │   │
│  │                                │  - git operations     │            │   │
│  │                                │                       │            │   │
│  │                                │  NetworkMode: none    │            │   │
│  │                                │  AutoRemove: true     │            │   │
│  │                                └───────────────────────┘            │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────┐    ┌─────────────────────┐                        │
│  │ /your/workspace     │    │ Docker Socket       │                        │
│  │ (bind mount)        │    │ /var/run/docker.sock│                        │
│  └─────────────────────┘    └─────────────────────┘                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

External:
┌─────────────────────┐    ┌─────────────────────┐
│   Anthropic API     │    │   Netlify API       │
│   (Claude models)   │    │   (deployments)     │
└─────────────────────┘    └─────────────────────┘
```

### DooD (Docker-outside-of-Docker) Explained

The agent container mounts the host's Docker socket (`/var/run/docker.sock`). When a tool needs to run code (npm, tsc, tests), it spawns a **sibling container** on the host's Docker daemon, not a nested container. This is:

- **Faster**: No nested virtualization overhead
- **Safer**: Sandbox containers have `NetworkMode: none` (no internet access)
- **Cleaner**: Containers auto-remove on exit (`AutoRemove: true`)

---

## 3. System Flowchart

### 3.1 Request Lifecycle

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  User   │     │   UI    │     │ Server  │     │  Agent  │     │ Claude  │
│         │     │ (React) │     │(Express)│     │  Loop   │     │   API   │
└────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘
     │               │               │               │               │
     │ Type prompt   │               │               │               │
     │──────────────►│               │               │               │
     │               │               │               │               │
     │               │ WS: 'prompt'  │               │               │
     │               │──────────────►│               │               │
     │               │               │               │               │
     │               │               │ agent.run()   │               │
     │               │               │──────────────►│               │
     │               │               │               │               │
     │               │               │               │ messages.stream()
     │               │               │               │──────────────►│
     │               │               │               │               │
     │               │               │               │◄──────────────│
     │               │               │               │  Stream chunks│
     │               │               │               │               │
     │               │◄──────────────┼───────────────│               │
     │               │ WS: stream_delta              │               │
     │               │               │               │               │
     │◄──────────────│               │               │               │
     │ See typing... │               │               │               │
     │               │               │               │               │
     │               │               │               │ Tool call     │
     │               │               │               │ detected      │
     │               │               │               │               │
     │               │◄──────────────┼───────────────│               │
     │               │ WS: tool_call │               │               │
     │               │               │               │               │
     │               │               │               │───┐           │
     │               │               │               │   │ Execute   │
     │               │               │               │   │ in Docker │
     │               │               │               │◄──┘           │
     │               │               │               │               │
     │               │◄──────────────┼───────────────│               │
     │               │ WS: tool_result               │               │
     │               │               │               │               │
     │               │               │               │ Continue loop │
     │               │               │               │──────────────►│
     │               │               │               │               │
     │               │               │               │◄──────────────│
     │               │               │               │ stop_reason:  │
     │               │               │               │ end_turn      │
     │               │               │               │               │
     │               │◄──────────────┼───────────────│               │
     │               │ WS: complete  │               │               │
     │               │               │               │               │
     │◄──────────────│               │               │               │
     │ Final response│               │               │               │
     │               │               │               │               │
```

### 3.2 Agentic Loop (Agent.run)

```
                              ┌─────────────────┐
                              │   User Prompt   │
                              └────────┬────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Load Context    │
                              │ - System prompt │
                              │ - History       │
                              │ - Knowledge     │
                              └────────┬────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────┐
                    │         AGENTIC LOOP            │
                    │                                 │
                    │  ┌──────────────────────────┐  │
                    │  │   Call Claude API        │  │
                    │  │   (streaming)            │  │
                    │  └────────────┬─────────────┘  │
                    │               │                │
                    │               ▼                │
                    │  ┌──────────────────────────┐  │
                    │  │   Process Response       │  │
                    │  │   - Text → stream_delta  │  │
                    │  │   - Tool → tool_call     │  │
                    │  └────────────┬─────────────┘  │
                    │               │                │
                    │               ▼                │
                    │       ┌───────────────┐        │
                    │       │  stop_reason? │        │
                    │       └───────┬───────┘        │
                    │               │                │
                    │    ┌──────────┼──────────┐     │
                    │    │          │          │     │
                    │    ▼          ▼          ▼     │
                    │ end_turn  tool_use   max_tokens│
                    │    │          │          │     │
                    │    │          ▼          │     │
                    │    │  ┌─────────────┐    │     │
                    │    │  │Execute Tools│    │     │
                    │    │  │(parallel or │    │     │
                    │    │  │ sequential) │    │     │
                    │    │  └──────┬──────┘    │     │
                    │    │         │           │     │
                    │    │         ▼           │     │
                    │    │  ┌─────────────┐    │     │
                    │    │  │ Append tool │    │     │
                    │    │  │ results to  │    │     │
                    │    │  │ messages    │    │     │
                    │    │  └──────┬──────┘    │     │
                    │    │         │           │     │
                    │    │         └───────────┼─────┼──► Loop back
                    │    │                     │     │
                    │    ▼                     ▼     │
                    │  EXIT                  EXIT    │
                    │                                │
                    └────────────────────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Persist Session │
                              │ - Summary       │
                              │ - Token usage   │
                              │ - Git checkpoint│
                              └─────────────────┘
```

### 3.3 Tool Execution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TOOL EXECUTION                                │
│                                                                      │
│  Input: Array of tool_use blocks from Claude                        │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                     CLASSIFY TOOLS                           │    │
│  │                                                              │    │
│  │  Read-only (parallel):        Write/Side-effect (sequential):│    │
│  │  - read_file                  - write_file                   │    │
│  │  - list_files                 - apply_patch                  │    │
│  │  - search_files               - delete_file                  │    │
│  │  - memory_get                 - npm_install                  │    │
│  │  - git_status                 - npm_run                      │    │
│  │  - git_log                    - git_checkpoint               │    │
│  │  - git_diff                   - deploy_netlify               │    │
│  │                               - run_tests                    │    │
│  │                               - run_node_script              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                          │                   │                       │
│                          ▼                   ▼                       │
│              ┌───────────────────┐  ┌───────────────────┐           │
│              │  Promise.all()   │  │  for...of loop    │           │
│              │  (concurrent)    │  │  (one at a time)  │           │
│              └────────┬──────────┘  └────────┬──────────┘           │
│                       │                      │                       │
│                       └──────────┬───────────┘                       │
│                                  │                                   │
│                                  ▼                                   │
│                    ┌─────────────────────────┐                       │
│                    │   NEEDS SANDBOX?        │                       │
│                    │   npm_*, run_*, tsc_*,  │                       │
│                    │   eslint_*, prettier_*  │                       │
│                    └────────────┬────────────┘                       │
│                           │           │                              │
│                     YES   │           │  NO                          │
│                           ▼           ▼                              │
│              ┌───────────────┐  ┌───────────────┐                   │
│              │DockerSandbox  │  │ Direct exec   │                   │
│              │.execute()     │  │ (fs, git CLI) │                   │
│              └───────┬───────┘  └───────┬───────┘                   │
│                      │                  │                            │
│                      └────────┬─────────┘                            │
│                               │                                      │
│                               ▼                                      │
│                    ┌─────────────────────────┐                       │
│                    │   Build tool_result     │                       │
│                    │   - success/failure     │                       │
│                    │   - output (truncated)  │                       │
│                    │   - duration_ms         │                       │
│                    └─────────────────────────┘                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Directory Structure

```
Klaus-Code_4.0/
├── packages/
│   ├── agent/                    # Backend (Node.js)
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   └── Agent.ts      # ⭐ Core agentic loop
│   │   │   ├── server/
│   │   │   │   └── AgentServer.ts # ⭐ HTTP + WebSocket server
│   │   │   ├── tools/
│   │   │   │   ├── ToolExecutor.ts # ⭐ Tool dispatch + validation
│   │   │   │   ├── FileTool.ts     # read/write/patch/delete
│   │   │   │   ├── BuildTool.ts    # npm install/run
│   │   │   │   ├── LintTool.ts     # tsc/eslint/prettier
│   │   │   │   ├── ScriptTool.ts   # run_node_script
│   │   │   │   ├── TestTool.ts     # jest/vitest runner
│   │   │   │   ├── GitTool.ts      # all git operations
│   │   │   │   ├── DeployTool.ts   # netlify deployment
│   │   │   │   └── schemas.ts      # Zod validation schemas
│   │   │   ├── memory/
│   │   │   │   └── DatabaseMemory.ts # ⭐ SQLite persistence
│   │   │   ├── sandbox/
│   │   │   │   └── DockerSandbox.ts  # ⭐ Docker container exec
│   │   │   ├── logger/
│   │   │   │   └── index.ts        # Winston logger
│   │   │   ├── config.ts           # Zod config validation
│   │   │   └── index.ts            # CLI entry point
│   │   ├── __tests__/
│   │   │   ├── unit/               # Unit tests
│   │   │   ├── integration/        # Integration tests
│   │   │   └── e2e/                # End-to-end tests
│   │   └── package.json
│   │
│   └── ui/                       # Frontend (React)
│       ├── src/
│       │   ├── components/
│       │   │   ├── ChatArea.tsx    # Message display
│       │   │   ├── InputArea.tsx   # Prompt input
│       │   │   ├── SessionList.tsx # Session sidebar
│       │   │   ├── ToolLog.tsx     # Tool call display
│       │   │   ├── StatusBar.tsx   # Token usage display
│       │   │   ├── ModelSelector.tsx # Model dropdown
│       │   │   ├── DiffPreviewModal.tsx # Patch approval
│       │   │   └── ...
│       │   ├── hooks/
│       │   │   └── useAgentSocket.ts # ⭐ WebSocket hook
│       │   ├── lib/
│       │   │   └── types.ts        # TypeScript interfaces
│       │   ├── App.tsx             # Main app component
│       │   └── main.tsx            # React entry point
│       └── package.json
│
├── docker/
│   ├── Dockerfile.agent          # Agent container build
│   ├── Dockerfile.ui             # UI container build
│   └── entrypoint.sh             # Agent startup script
│
├── docker-compose.yml            # ⭐ Full stack orchestration
├── klaus                         # ⭐ CLI client script
├── .env.example                  # Configuration template
├── package.json                  # Root workspace config
├── CHANGES.md                    # Feature changelog
└── README.md                     # User documentation
```

---

## 5. Component Deep Dive

### 5.1 Agent.ts — The Brain

**Location:** `packages/agent/src/agent/Agent.ts`

This is the core of the system. Key responsibilities:

| Method | Purpose |
|--------|---------|
| `run(message, sessionId?, onEvent?, options?)` | Main entry point — runs the agentic loop |
| `buildMessages()` | Constructs context window (system + history + knowledge) |
| `summariseMessages()` | Compresses old history using Haiku (cheap) |
| `generateSessionSummary()` | Creates session titles using Haiku |
| `scanForSecrets()` | Checks workspace for leaked credentials |
| `requestPatchApproval()` | Human-in-the-loop for file changes |
| `resolvePatchApproval()` | Handles user's approve/reject decision |

**Key Data Structures:**

```typescript
// Event emitted during execution
type AgentEvent = {
  type: 'thinking' | 'stream_delta' | 'tool_call' | 'tool_result' | 
        'tool_progress' | 'message' | 'error' | 'complete' | 
        'turn_complete' | 'budget_warning' | 'patch_approval_required';
  data: any;
  timestamp: Date;
};

// Result returned after run completes
interface AgentRunResult {
  sessionId: string;
  summary: string;
  toolCallsCount: number;
  success: boolean;
  durationMs: number;
  model: string;
  tokenUsage: TokenUsageSummary;
}
```

**Model Selection Logic:**

```typescript
// Line ~590-605
const allowedModels = [
  'claude-opus-4-5',
  'claude-sonnet-4-5', 
  'claude-haiku-4-5',
  // + dated variants
];

// User-requested model validated against allowlist
// Falls back to config.model if invalid
const model = allowedModels.some(m => requestedModel.includes(m.replace('-4-5', ''))) 
  ? requestedModel 
  : this.config.model;
```

**Internal Tasks Use Haiku:**

```typescript
const INTERNAL_MODEL = 'claude-haiku-4-5-20251001';

// Used for:
// - Context summarization (summariseMessages)
// - Session title generation (generateSessionSummary)
// This saves ~$0.05-0.20 per session on internal operations
```

### 5.2 AgentServer.ts — The Gateway

**Location:** `packages/agent/src/server/AgentServer.ts`

Express + Socket.IO server handling all external communication.

**REST Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (used by Docker) |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/sessions/:id/export` | Export as MD or JSON |
| POST | `/api/prompt` | Send prompt (SSE streaming) |
| GET | `/api/files` | List workspace files |
| GET | `/api/files/*` | Read file content |
| PATCH | `/api/sessions/:id` | Update session (pin, title) |
| GET | `/metrics` | Prometheus metrics |

**WebSocket Events (Socket.IO):**

| Event | Direction | Purpose |
|-------|-----------|---------|
| `prompt` | Client → Server | Start agent run |
| `cancel` | Client → Server | Abort current run |
| `join_session` | Client → Server | Subscribe to session events |
| `leave_session` | Client → Server | Unsubscribe |
| `patch_approval_response` | Client → Server | Approve/reject patch |
| `thinking` | Server → Client | Agent is processing |
| `stream_delta` | Server → Client | Incremental text |
| `tool_call` | Server → Client | Tool invoked |
| `tool_result` | Server → Client | Tool completed |
| `tool_progress` | Server → Client | Progress update |
| `error` | Server → Client | Error occurred |
| `complete` | Server → Client | Run finished |
| `turn_complete` | Server → Client | API turn finished |
| `patch_approval_required` | Server → Client | Needs user approval |

**Security Middleware:**

```typescript
// Rate limiting per socket
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

// API authentication
if (config.apiSecret) {
  // Bearer token validation with timing-safe comparison
}

// CSP headers
res.setHeader('Content-Security-Policy', "default-src 'self'; ...");
```

### 5.3 ToolExecutor.ts — The Hands

**Location:** `packages/agent/src/tools/ToolExecutor.ts`

Validates and dispatches tool calls to appropriate handlers.

**Tool Categories:**

```typescript
// Read-only tools (can run in parallel)
const READ_TOOLS = new Set([
  'read_file', 'list_files', 'search_files', 
  'memory_get', 'git_status', 'git_log', 'git_diff'
]);

// Write/side-effect tools (run sequentially)
const WRITE_TOOLS = new Set([
  'write_file', 'apply_patch', 'delete_file',
  'npm_install', 'npm_run', 'git_checkpoint', 'deploy_netlify'
]);

// Long-running tools (get progress indicators)
const LONG_RUNNING_TOOLS = new Set([
  'npm_install', 'npm_run', 'run_tests', 'git_clone', 
  'deploy_netlify', 'tsc_check', 'eslint_check', 'prettier_format'
]);
```

**Validation Flow:**

```typescript
// 1. Parse tool input against Zod schema
const parsed = schema.safeParse(input);
if (!parsed.success) {
  return { success: false, error: parsed.error.message };
}

// 2. Security checks (path traversal, etc.)
if (!resolvedPath.startsWith(workspaceDir)) {
  throw new Error('Path traversal blocked');
}

// 3. Execute via appropriate handler
const result = await this.dispatch(toolName, parsed.data);
```

### 5.4 DatabaseMemory.ts — The Memory

**Location:** `packages/agent/src/memory/DatabaseMemory.ts`

SQLite wrapper for persistent storage. Uses better-sqlite3 (synchronous API).

**Tables:**

| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata (id, workspace, summary, pinned) |
| `messages` | Conversation history |
| `tool_calls` | Tool execution log |
| `token_usage` | Per-turn token accounting |
| `knowledge` | Persistent facts across sessions |

**Key Methods:**

```typescript
// Session management
createSession(workspaceDir): string
getSession(id): Session | null
updateSessionSummary(id, summary): void
deleteSession(id): boolean

// Message storage
addMessage(sessionId, role, content): void
getMessages(sessionId, limit): Message[]
getRecentMessages(sessionId, limit): Message[]

// Token tracking
recordTokenUsage(sessionId, model, input, output): void
getSessionTokenUsage(sessionId): TokenUsageSummary
estimateCost(input, output, model?): number

// Knowledge base
setKnowledge(key, value, category): void
getKnowledge(key): string | null
listKnowledge(category?): Knowledge[]
```

### 5.5 DockerSandbox.ts — The Isolation

**Location:** `packages/agent/src/sandbox/DockerSandbox.ts`

Spawns isolated containers for code execution.

**Container Configuration:**

```typescript
const container = await this.docker.createContainer({
  Image: 'node:20-alpine',
  Cmd: ['sh', '-c', command],
  WorkingDir: '/workspace',
  HostConfig: {
    Binds: [`${workspaceDir}:/workspace`],
    NetworkMode: 'none',           // No network access
    AutoRemove: true,              // Cleanup on exit
    Memory: memoryMb * 1024 * 1024,
    NanoCpus: cpus * 1e9,
  },
  User: 'node',                    // Non-root
});
```

**Timeout Handling:**

```typescript
// Race between completion and timeout
const result = await Promise.race([
  container.wait(),
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout')), timeout)
  )
]);
```

### 5.6 useAgentSocket.ts — The Bridge

**Location:** `packages/ui/src/hooks/useAgentSocket.ts`

React hook managing WebSocket connection and state.

**State Management:**

```typescript
interface AgentState {
  isConnected: boolean;
  isRunning: boolean;
  currentSession: string | null;
  messages: Message[];
  toolCalls: ToolCall[];
  tokenUsage: TokenUsage | null;
  error: string | null;
}
```

**Model Selection:**

```typescript
export type ModelOption = 'claude-opus-4-5' | 'claude-sonnet-4-5' | 'claude-haiku-4-5';

export const MODEL_INFO: Record<ModelOption, ModelInfo> = {
  'claude-opus-4-5': { name: 'Opus', description: 'Most capable', costMultiplier: 1 },
  'claude-sonnet-4-5': { name: 'Sonnet', description: 'Balanced', costMultiplier: 0.2 },
  'claude-haiku-4-5': { name: 'Haiku', description: 'Fast & cheap', costMultiplier: 0.05 },
};
```

---

## 6. Data Flow

### 6.1 Prompt Submission Flow

```
User types "add auth to my app"
         │
         ▼
┌─────────────────────┐
│ InputArea.tsx       │
│ onSubmit()          │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ useAgentSocket.ts   │
│ sendPrompt(msg,     │
│   sessionId, model) │
└──────────┬──────────┘
           │
           ▼ socket.emit('prompt', {...})
           │
┌──────────┴──────────┐
│ AgentServer.ts      │
│ socket.on('prompt') │
└──────────┬──────────┘
           │
           ▼ agent.run(message, sessionId, emit, {model})
           │
┌──────────┴──────────┐
│ Agent.ts            │
│ run()               │
└──────────┬──────────┘
           │
           ▼ this.client.messages.stream({...})
           │
┌──────────┴──────────┐
│ Anthropic API       │
│ Claude model        │
└──────────┬──────────┘
           │
           ▼ Streaming response chunks
           │
┌──────────┴──────────┐
│ Agent.ts            │
│ Process chunks      │
│ Emit events         │
└──────────┬──────────┘
           │
           ▼ emit({type: 'stream_delta', data: {delta: '...'}})
           │
┌──────────┴──────────┐
│ AgentServer.ts      │
│ socket.emit(event)  │
└──────────┬──────────┘
           │
           ▼ WebSocket message
           │
┌──────────┴──────────┐
│ useAgentSocket.ts   │
│ socket.on(type)     │
│ Update state        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ ChatArea.tsx        │
│ Re-render with      │
│ new message         │
└─────────────────────┘
```

### 6.2 Tool Execution Flow

```
Claude returns tool_use block
         │
         ▼
┌─────────────────────┐
│ Agent.ts            │
│ Classify tool       │
│ (read vs write)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ ToolExecutor.ts     │
│ execute()           │
└──────────┬──────────┘
           │
           ├─── File tool? ───► FileTool.ts ───► fs-extra
           │
           ├─── Build tool? ──► BuildTool.ts ──► DockerSandbox
           │
           ├─── Lint tool? ───► LintTool.ts ───► DockerSandbox
           │
           ├─── Test tool? ───► TestTool.ts ───► DockerSandbox
           │
           ├─── Git tool? ────► GitTool.ts ────► simple-git
           │
           └─── Deploy? ──────► DeployTool.ts ─► Netlify CLI
                   │
                   ▼
         ┌─────────────────────┐
         │ DockerSandbox.ts    │
         │ (if sandboxed)      │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │ Spawn container     │
         │ - Mount workspace   │
         │ - Run command       │
         │ - Capture output    │
         │ - Auto-remove       │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │ Return result       │
         │ {success, output,   │
         │  durationMs}        │
         └─────────────────────┘
```

---

## 7. Tool System

### 7.1 Adding a New Tool

**Step 1: Define Schema** (`packages/agent/src/tools/schemas.ts`)

```typescript
export const MyToolSchema = z.object({
  input1: z.string().min(1, 'input1 is required'),
  input2: z.number().optional().default(10),
});
```

**Step 2: Add to TOOL_DEFINITIONS** (`packages/agent/src/tools/ToolExecutor.ts`)

```typescript
{
  name: 'my_tool',
  description: 'Does something useful. Call this when user wants X.',
  input_schema: {
    type: 'object',
    properties: {
      input1: { type: 'string', description: 'What to process' },
      input2: { type: 'number', description: 'How many times' },
    },
    required: ['input1'],
  },
},
```

**Step 3: Implement Handler** (`packages/agent/src/tools/MyTool.ts`)

```typescript
import { MyToolSchema } from './schemas';

export async function myTool(
  input: z.infer<typeof MyToolSchema>,
  workspaceDir: string
): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    // Implementation
    return { success: true, result: '...' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
```

**Step 4: Add Dispatch Case** (`packages/agent/src/tools/ToolExecutor.ts`)

```typescript
private async dispatch(name: string, input: unknown): Promise<unknown> {
  switch (name) {
    // ... existing cases
    case 'my_tool':
      return myTool(input as z.infer<typeof MyToolSchema>, this.workspaceDir);
  }
}
```

**Step 5: Classify Tool** (`packages/agent/src/tools/ToolExecutor.ts`)

```typescript
// If read-only, add to READ_TOOLS
// If has side effects, add to WRITE_TOOLS
// If long-running, add to LONG_RUNNING_TOOLS
```

### 7.2 Tool Validation

All tools are validated against Zod schemas before execution:

```typescript
// In ToolExecutor.execute()
const schema = this.getSchema(toolCall.name);
const parsed = schema.safeParse(toolCall.input);

if (!parsed.success) {
  return {
    success: false,
    error: `Validation failed: ${parsed.error.format()}`,
  };
}
```

### 7.3 Tool Output Summarization

Large outputs are summarized to save tokens:

```typescript
function summarizeLargeOutput(
  toolName: string,
  output: string,
  maxLength: number
): string {
  if (output.length <= maxLength) return output;
  
  switch (toolName) {
    case 'list_files':
      // Return file count + extension distribution + sample
      return summarizeListFiles(output);
    
    case 'search_files':
      // Return match count + top files + sample results
      return summarizeSearchFiles(output);
    
    default:
      // Keep 60% start + 30% end
      const startLen = Math.floor(maxLength * 0.6);
      const endLen = Math.floor(maxLength * 0.3);
      return output.slice(0, startLen) + 
             '\n\n[... truncated ...]\n\n' + 
             output.slice(-endLen);
  }
}
```

### 7.4 Deployment Tools

Klaus-Code supports multi-cloud deployment with built-in security controls.

#### Available Deployment Tools

| Tool | Provider | Purpose |
|------|----------|---------|
| `deploy_netlify` | Netlify | Deploy static sites |
| `deploy_vercel` | Vercel | Deploy Next.js, React, static |
| `deploy_aws_s3` | AWS | Deploy to S3 + CloudFront |
| `terraform_init` | Any | Initialize Terraform |
| `terraform_plan` | Any | Preview infrastructure changes |
| `terraform_apply` | Any | Apply infrastructure changes |
| `terraform_destroy` | Any | Destroy infrastructure |
| `terraform_output` | Any | Retrieve Terraform outputs |
| `generate_infrastructure` | AWS/Vercel/Netlify | Auto-generate Terraform configs |

#### Security Controls

**Vercel Deployment:**
```typescript
// Token passed via environment, never in command args
const deployEnv = {
  VERCEL_TOKEN: token,
  PATH: process.env.PATH,  // Prevent PATH injection
};

// Project name validation
if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
  return { success: false, error: 'Invalid project name' };
}
```

**AWS Deployment:**
```typescript
// Bucket name validation (S3 naming rules)
function isValidBucketName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) && 
         !name.includes('..') &&
         !name.includes('.-') &&
         !name.includes('-.');
}

// Region validation
function isValidRegion(region: string): boolean {
  return /^[a-z]{2}-[a-z]+-\d+$/.test(region);
}
```

**Terraform Security:**
```typescript
// Variable name validation (prevent injection)
function isValidVarName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name);
}

// Block shell metacharacters in values
function isValidVarValue(value: string): boolean {
  const dangerous = /[;&|`$(){}[\]<>\\!]/;
  return !dangerous.test(value);
}

// Approval gates
if (!autoApprove && !planFile) {
  return { requiresApproval: true };  // terraform apply
}
if (!autoApprove) {
  return { requiresApproval: true };  // terraform destroy ALWAYS
}

// Sensitive output filtering
const SENSITIVE_PATTERNS = [
  /password\s*=\s*"[^"]+"/gi,
  /secret\s*=\s*"[^"]+"/gi,
  /api_key\s*=\s*"[^"]+"/gi,
  /AWS_SECRET_ACCESS_KEY\s*=\s*\S+/gi,
];
```

#### Infrastructure Generator

Analyzes projects and generates Terraform configurations:

```typescript
// Project type detection
async function analyzeProject(projectDir: string): Promise<ProjectAnalysis> {
  const pkg = await fs.readJson(path.join(projectDir, 'package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  
  if (deps['next']) return { type: 'nextjs', ... };
  if (deps['react']) return { type: 'react', ... };
  if (deps['express']) return { type: 'node-api', ... };
  // etc.
}

// Generated files:
// - main.tf (resources)
// - variables.tf (inputs)
// - outputs.tf (deployment URLs, etc.)
// - terraform.tfvars.example (sample values)
```

#### Adding a New Deployment Provider

1. Create `packages/agent/src/tools/NewProviderTool.ts`
2. Add schema to `schemas.ts`
3. Add to `ToolExecutor.ts` TOOL_DEFINITIONS and dispatch
4. Add to LONG_RUNNING_TOOLS set
5. Add secret pattern to Agent.ts SECRET_PATTERNS
6. Update `.env.example` with required credentials

---

## 8. Security Model

### 8.1 Layers of Defense

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Network Isolation                                      │
│ - Sandbox containers have NetworkMode: none                    │
│ - Agent container on internal Docker network                   │
│ - no-new-privileges security option                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: Authentication                                         │
│ - AGENT_API_SECRET required for production                     │
│ - Bearer token with timing-safe comparison                     │
│ - Rate limiting per socket (30 events/minute)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: Input Validation                                       │
│ - Zod schemas for all tool inputs                              │
│ - Prompt size limits (32KB default)                            │
│ - Model allowlist validation                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4: Path Security                                          │
│ - All paths resolved and checked against workspace             │
│ - Symlink resolution with realpath                             │
│ - No access to parent directories                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 5: Secret Scanning                                        │
│ - Scans workspace before git checkpoint                        │
│ - Blocks commits containing API keys, tokens, etc.             │
│ - Patterns: AWS, GitHub, Anthropic, private keys, etc.         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 6: Resource Limits                                        │
│ - Token budget per session (default: 100K)                     │
│ - Tool call limit per session (default: 50)                    │
│ - Concurrent session limit (default: 3)                        │
│ - Container memory/CPU/timeout limits                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 7: Audit Logging                                          │
│ - All sensitive operations logged                              │
│ - Session deletes, exports logged                              │
│ - Tool calls persisted to database                             │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 Secret Patterns

```typescript
const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', pattern: /aws_secret_access_key\s*=\s*[^\s]+/i },
  { name: 'Generic API Key', pattern: /api[_-]?key\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}/i },
  { name: 'Private Key Block', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Anthropic Key', pattern: /sk-ant-[a-zA-Z0-9\-_]{32,}/ },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36}/ },
  { name: 'Netlify Token', pattern: /netlify[_-]?token\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}/i },
  { name: 'Generic Secret', pattern: /secret\s*[=:]\s*["']?[a-zA-Z0-9_\-]{16,}/i },
  { name: 'DB Connection', pattern: /(postgres|mysql|mongodb):\/\/[^@]+:[^@]+@/ },
  { name: 'Bearer Token', pattern: /bearer\s+[a-zA-Z0-9\-_.]{20,}/i },
];
```

---

## 9. Configuration Reference

### 9.1 Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ANTHROPIC_API_KEY` | string | — | **Required.** Claude API key |
| `AGENT_WORKSPACE` | path | `$PWD` | Directory agent works in |
| `AGENT_API_SECRET` | string | — | Bearer token for auth |
| `AGENT_MODEL` | string | `claude-opus-4-5` | Default Claude model |
| `AGENT_TOKEN_BUDGET` | number | `100000` | Max tokens per session |
| `AGENT_MAX_TOOL_CALLS` | number | `50` | Max tool calls per session |
| `AGENT_MAX_CONCURRENT_SESSIONS` | number | `3` | Concurrent session limit |
| `AGENT_MAX_TOKENS` | number | `8192` | Max output tokens per turn |
| `AGENT_MAX_RETRIES` | number | `3` | Tool validation retries |
| `AGENT_MAX_PROMPT_CHARS` | number | `32000` | Max prompt length |
| `AGENT_MAX_TOOL_OUTPUT_CONTEXT` | number | `8000` | Max tool output in context |
| `AGENT_MAX_TOOL_RESULT_SIZE` | number | `10240` | Max result stored in DB |
| `AGENT_MAX_SEARCH_RESULTS` | number | `500` | Max search results |
| `AGENT_WS_RATE_LIMIT` | number | `30` | Events/socket/minute |
| `AGENT_SHUTDOWN_TIMEOUT` | number | `30000` | Graceful shutdown (ms) |
| `AGENT_REQUIRE_PATCH_APPROVAL` | boolean | `false` | Human-in-the-loop mode |
| `AGENT_CORS_ORIGIN` | string | `localhost:5173` | Allowed CORS origin |
| `AGENT_TRUST_PROXY` | string | `false` | Express trust proxy |
| `AGENT_METRICS_ENABLED` | boolean | `true` | Prometheus /metrics |
| `AGENT_WEBHOOK_URL` | string | — | Completion webhook |
| `DOCKER_ENABLED` | boolean | `true` | Use Docker sandbox |
| `NETLIFY_AUTH_TOKEN` | string | — | Netlify deploy token |
| `NETLIFY_SITE_ID` | string | — | Netlify site ID |
| `LOG_LEVEL` | string | `info` | Logging verbosity |
| `GIT_CREDENTIALS` | string | — | Git auth URL |
| `GIT_USER_EMAIL` | string | — | Git commit email |
| `GIT_USER_NAME` | string | — | Git commit name |

### 9.2 Config Validation

All config is validated at startup using Zod:

```typescript
// packages/agent/src/config.ts
const ConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  AGENT_WORKSPACE: z.string().default(process.cwd()),
  AGENT_TOKEN_BUDGET: z.coerce.number().default(100000),
  // ... etc
});

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Config validation failed: ${result.error.format()}`);
  }
  return result.data;
}
```

---

## 10. Database Schema

### 10.1 Tables

```sql
-- Sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_dir TEXT NOT NULL,
  summary TEXT,
  pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Messages table
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,  -- 'user' | 'assistant' | 'tool'
  content TEXT NOT NULL,
  tool_name TEXT,      -- for role='tool'
  tool_call_id TEXT,   -- for role='tool'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Tool calls table
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,      -- JSON
  output TEXT,              -- JSON (truncated)
  success INTEGER,
  duration_ms INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Token usage table
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Knowledge base table
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_token_usage_session ON token_usage(session_id);
CREATE INDEX idx_knowledge_category ON knowledge(category);
```

### 10.2 Cost Calculation

```typescript
function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  // Per-million token pricing (January 2025)
  const pricing: Record<string, { input: number; output: number }> = {
    opus:   { input: 15.00, output: 75.00 },
    sonnet: { input: 3.00,  output: 15.00 },
    haiku:  { input: 0.80,  output: 4.00 },
  };
  
  const tier = model.includes('haiku') ? 'haiku' 
             : model.includes('sonnet') ? 'sonnet' 
             : 'opus';
  
  const { input, output } = pricing[tier];
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}
```

---

## 11. WebSocket Events

### 11.1 Client → Server Events

| Event | Payload | Description |
|-------|---------|-------------|
| `prompt` | `{message, sessionId?, model?}` | Start agent run |
| `cancel` | `{sessionId}` | Abort current run |
| `join_session` | `{sessionId}` | Subscribe to session |
| `leave_session` | `{sessionId}` | Unsubscribe |
| `patch_approval_response` | `{patchId, approved}` | Respond to approval request |

### 11.2 Server → Client Events

| Event | Payload | When |
|-------|---------|------|
| `thinking` | `{messageCount}` | Starting API call |
| `stream_delta` | `{delta}` | Text chunk from Claude |
| `tool_call` | `{name, input, id}` | Tool invoked |
| `tool_result` | `{toolCallId, result, success, durationMs}` | Tool completed |
| `tool_progress` | `{toolCallId, progress, status, elapsedMs}` | Long-running tool update |
| `error` | `{error, sessionId?, retrying?}` | Error occurred |
| `turn_complete` | `{turn, inputTokens, outputTokens, ...}` | API turn finished |
| `budget_warning` | `{percentUsed, totalTokens}` | 80% budget used |
| `budget_exceeded` | `{totalTokens, limit}` | Budget exhausted |
| `patch_approval_required` | `{patchId, filePath, diff, operation}` | Needs approval |
| `complete` | `{sessionId, summary, tokenUsage, ...}` | Run finished |

---

## 12. Error Handling

### 12.1 Error Categories

| Category | Handling | Retryable |
|----------|----------|-----------|
| API 429 (Rate Limit) | Exponential backoff | Yes |
| API 5xx (Server Error) | Exponential backoff | Yes |
| API 4xx (Client Error) | Fail immediately | No |
| Network errors | Exponential backoff | Yes |
| Tool validation | Return error to Claude | Yes (by Claude) |
| Tool execution | Return error to Claude | Yes (by Claude) |
| Path traversal | Block and log | No |
| Token budget | Stop gracefully | No |
| Timeout | Kill container | No |

### 12.2 Retry Logic

```typescript
function isRetryableError(error: any): boolean {
  const status = error.status || error.statusCode;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) return true;
  return false;
}

function getRetryDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}
```

### 12.3 Graceful Shutdown

```typescript
// On SIGTERM/SIGINT:
// 1. Cancel all active agent sessions
// 2. Wait for in-flight requests to drain
// 3. Close HTTP server
// 4. Close database connection
// 5. Exit cleanly
```

---

## 13. Testing Strategy

### 13.1 Test Categories

| Category | Location | Purpose |
|----------|----------|---------|
| Unit | `__tests__/unit/` | Individual functions/classes |
| Integration | `__tests__/integration/` | Component interactions |
| E2E | `__tests__/e2e/` | Full workflows |
| Security | `__tests__/unit/Security.test.ts` | Security patterns |

### 13.2 Running Tests

```bash
# All tests
npm run test

# Specific category
npm run test:unit
npm run test:integration
npm run test:e2e

# With coverage
npm run test -- --coverage

# Watch mode
npm run test -- --watch
```

### 13.3 Key Test Files

| File | Tests |
|------|-------|
| `NewFeatures.test.ts` | Model selection, progress, export, retry |
| `Security.test.ts` | Auth, validation, path traversal, secrets |
| `AgentServer.test.ts` | REST endpoints, WebSocket events |
| `ToolExecutor.test.ts` | Tool dispatch, validation |
| `workflow.test.ts` | End-to-end agent workflows |

---

## 14. Debugging Guide

### 14.1 Log Levels

```bash
# In .env
LOG_LEVEL=debug  # debug | info | warn | error
```

### 14.2 Viewing Logs

```bash
# Docker logs
docker compose logs -f agent

# Log file (inside container)
docker compose exec agent cat /data/logs/agent-$(date +%Y-%m-%d).log

# Database queries
docker compose exec agent sqlite3 /data/memory.db "SELECT * FROM sessions;"
```

### 14.3 Common Debug Points

```typescript
// Agent.ts - Add logging
this.log.debug('API response received', { 
  stopReason: response.stop_reason,
  toolCalls: response.content.filter(c => c.type === 'tool_use').length,
});

// ToolExecutor.ts - Add logging
logger.debug('Tool execution', { 
  tool: name, 
  input: JSON.stringify(input).slice(0, 200),
});
```

### 14.4 Docker Sandbox Debugging

```bash
# List running containers
docker ps -a | grep node:20-alpine

# Check for orphaned containers
docker ps -a --filter "status=exited" | grep node:20-alpine

# Manual sandbox test
docker run --rm -v /your/workspace:/workspace node:20-alpine sh -c "npm --version"
```

### 14.5 Database Inspection

```bash
# Enter SQLite shell
docker compose exec agent sqlite3 /data/memory.db

# Useful queries
.tables
SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 5;
SELECT session_id, SUM(input_tokens), SUM(output_tokens) FROM token_usage GROUP BY session_id;
SELECT tool_name, COUNT(*) FROM tool_calls GROUP BY tool_name ORDER BY 2 DESC;
```

---

## 15. Common Issues & Solutions

### Issue: "Docker daemon not reachable"

**Cause:** Docker socket not mounted or Docker not running.

**Solution:**
```bash
# Check Docker is running
docker ps

# Verify socket mount in docker-compose.yml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

### Issue: "Path traversal blocked"

**Cause:** Agent tried to access file outside workspace.

**Solution:** This is expected security behavior. If legitimate, adjust AGENT_WORKSPACE.

### Issue: "Token budget exceeded"

**Cause:** Session used more tokens than allowed.

**Solution:**
```bash
# Increase budget
AGENT_TOKEN_BUDGET=200000  # or 0 for unlimited
```

### Issue: WebSocket disconnects frequently

**Cause:** Network issues or server restart.

**Solution:** The UI auto-reconnects. Check agent container logs for crashes.

### Issue: "ECONNRESET during tool execution"

**Cause:** Container killed mid-execution (timeout or OOM).

**Solution:**
```bash
# Increase container limits in DockerSandbox.ts
const { timeout = 120000, memoryMb = 1024 } = options;
```

### Issue: Slow npm install in sandbox

**Cause:** No npm cache between container runs.

**Solution:** This is by design for isolation. Consider adding a volume for `.npm` cache if acceptable for your security model.

---

## 16. Extension Points

### 16.1 Adding a New Model

```typescript
// packages/agent/src/agent/Agent.ts
const allowedModels = [
  'claude-opus-4-5',
  'claude-sonnet-4-5', 
  'claude-haiku-4-5',
  'claude-new-model-4-5',  // Add new model
];

// packages/ui/src/hooks/useAgentSocket.ts
export type ModelOption = 
  | 'claude-opus-4-5' 
  | 'claude-sonnet-4-5' 
  | 'claude-haiku-4-5'
  | 'claude-new-model-4-5';  // Add here too

export const MODEL_INFO: Record<ModelOption, ModelInfo> = {
  // ... existing
  'claude-new-model-4-5': { name: 'New', description: '...', costMultiplier: 0.5 },
};
```

### 16.2 Adding a Deployment Target

```typescript
// Create packages/agent/src/tools/VercelTool.ts
export async function deployToVercel(options: VercelDeployOptions): Promise<DeployResult> {
  // Implementation using Vercel CLI
}

// Add to ToolExecutor.ts TOOL_DEFINITIONS and dispatch()
```

### 16.3 Adding Authentication Providers

```typescript
// packages/agent/src/server/AgentServer.ts
// Add before existing auth middleware:

if (config.auth.provider === 'oauth') {
  app.use(passport.initialize());
  passport.use(new OAuth2Strategy({...}));
}
```

### 16.4 Adding a New Event Type

```typescript
// packages/agent/src/agent/Agent.ts
type AgentEvent = 
  | { type: 'existing_event'; data: ExistingData }
  | { type: 'my_new_event'; data: MyNewData };  // Add new event

// packages/ui/src/lib/types.ts
export interface MyNewEvent {
  type: 'my_new_event';
  data: { field: string };
}

// packages/ui/src/hooks/useAgentSocket.ts
socket.on('my_new_event', (event: MyNewEvent) => {
  // Handle new event
});
```

---

## Appendix: Quick Reference

### File Locations

| What | Where |
|------|-------|
| Main agent logic | `packages/agent/src/agent/Agent.ts` |
| HTTP/WS server | `packages/agent/src/server/AgentServer.ts` |
| Tool definitions | `packages/agent/src/tools/ToolExecutor.ts` |
| Docker sandbox | `packages/agent/src/sandbox/DockerSandbox.ts` |
| Database | `packages/agent/src/memory/DatabaseMemory.ts` |
| **Vercel deployment** | `packages/agent/src/tools/VercelTool.ts` |
| **AWS S3 deployment** | `packages/agent/src/tools/AWSTool.ts` |
| **Terraform IaC** | `packages/agent/src/tools/TerraformTool.ts` |
| **Infrastructure gen** | `packages/agent/src/tools/InfrastructureGenerator.ts` |
| React app | `packages/ui/src/App.tsx` |
| WebSocket hook | `packages/ui/src/hooks/useAgentSocket.ts` |
| Configuration | `packages/agent/src/config.ts` |
| CLI entry | `packages/agent/src/index.ts` |
| CLI client | `./klaus` |

### Commands

```bash
# Start (Docker)
npm run serve

# Start (detached)
npm run serve:detach

# Stop
npm run stop

# View logs
docker compose logs -f agent

# CLI prompt
./klaus "your prompt here"

# Database stats
docker compose exec agent node dist/index.js db stats

# Clear sessions
docker compose exec agent node dist/index.js db clear-sessions
```

### Token Costs (January 2025)

| Model | Input | Output | 100K session |
|-------|-------|--------|--------------|
| Opus | $15/M | $75/M | ~$8.75 |
| Sonnet | $3/M | $15/M | ~$1.75 |
| Haiku | $0.80/M | $4/M | ~$0.35 |

---

**Document Version:** 1.0  
**Last Updated:** February 2026  
**Maintainer:** Engineering Team
