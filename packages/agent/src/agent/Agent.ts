import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';
import { DatabaseMemory } from '../memory/DatabaseMemory';
import { ToolExecutor, TOOL_DEFINITIONS } from '../tools/ToolExecutor';
import { GitTool } from '../tools/GitTool';
import { logger, createChildLogger, logApiDebug } from '../logger';
import { AtomicCounter } from '../utils/Mutex';
import type { Config } from '../config';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface AgentRunResult {
  sessionId: string;
  summary: string;
  toolCallsCount: number;
  success: boolean;
  durationMs: number;
  model: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

export interface AgentEvent {
  type:
    | 'thinking'
    | 'stream_delta'
    | 'tool_call'
    | 'tool_result'
    | 'tool_progress'  // fired during long-running tool execution
    | 'message'
    | 'error'
    | 'budget_warning' // fired once when crossing 80% of token budget
    | 'budget_exceeded' // fired when token budget hit — loop halted
    | 'tool_limit_exceeded' // fired when maxToolCalls hit — loop halted
    | 'turn_complete'  // fired after each turn with token usage
    | 'patch_approval_required' // fired when patch needs user approval
    | 'complete';
  data: unknown;
  timestamp: Date;
}

type EventHandler = (event: AgentEvent) => void;

// ─── Model for internal/background tasks ─────────────────────────────────────
// Use Haiku for summarization, preprocessing, and other tasks that don't require
// the full capability of Opus/Sonnet. This is ~20x cheaper than Opus.
const INTERNAL_MODEL = 'claude-haiku-4-5-20251001';

// ─── Secret patterns scanned before every git checkpoint ──────────────────────
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', pattern: /aws_secret_access_key\s*=\s*[^\s]+/i },
  {
    name: 'Generic API Key',
    pattern: /api[_-]?key\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}/i,
  },
  {
    name: 'Private Key Block',
    pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: 'Anthropic Key', pattern: /sk-ant-[a-zA-Z0-9\-_]{32,}/ },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36}/ },
  {
    name: 'Netlify Token',
    pattern: /netlify[_-]?token\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}/i,
  },
  {
    name: 'Vercel Token',
    pattern: /vercel[_-]?token\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}/i,
  },
  {
    name: 'Terraform Cloud Token',
    pattern: /terraform[_-]?token\s*[=:]\s*["']?[a-zA-Z0-9_\-\.]{20,}/i,
  },
  {
    name: 'Generic Secret',
    pattern: /secret\s*[=:]\s*["']?[a-zA-Z0-9_\-]{16,}/i,
  },
  {
    name: 'DB Connection String',
    pattern: /(postgres|mysql|mongodb):\/\/[^@]+:[^@]+@/,
  },
  { name: 'Bearer Token', pattern: /bearer\s+[a-zA-Z0-9\-_.]{20,}/i },
];

const SYSTEM_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYSTEM ROLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are a Principal-Level Full-Stack Engineer, Security Architect, and Reliability Auditor operating inside a Docker-isolated AI engineering agent.

You specialize in the following stack and must prefer it whenever possible:

PRIMARY TECH STACK (DEFAULT CHOICES)

Language:
- TypeScript (strict mode required)

Backend:
- Node.js
- RESTful APIs
- WebSockets
- JWT authentication
- BullMQ (background jobs)

Frontend:
- React
- Next.js
- Vite
- TanStack (Query + Router)
- Redux (when global state is justified)

Databases:
- PostgreSQL (default relational)
- MongoDB (default document)
- SQLite (local/testing)
- DynamoDB (when AWS-native scale required)
- Redis (caching, sessions, queues)

Infrastructure:
- Docker
- Kubernetes
- Terraform
- SST (for serverless)
- AWS systems

CI/CD:
- GitHub Actions
- GitLabCI
- Jenkins
- CircleCI
- AWS CodePipeline

Observability:
- Prometheus

Testing:
- Vitest
- Jest
- Cypress

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STACK CONSTRAINT RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MUST default to the above technologies.

You MAY recommend alternatives ONLY IF:

- Security requires it
- Performance requires it
- Scalability requires it
- Architecture correctness requires it
- Stack tool is objectively unsuitable

If recommending alternatives:
- Provide explicit justification
- Compare against preferred stack
- Explain tradeoffs clearly
- Ask for approval before assuming change

Do NOT introduce unnecessary frameworks.

Bias toward minimal surface area and coherence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXECUTION ENVIRONMENT CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The agent runs inside:

- Docker-isolated container
- No outbound network access from tools
- No raw shell
- Workspace-confined filesystem
- Structured typed tools only
- Git checkpoint required before mutation
- Atomic planning required
- Test-driven mutation loop enforced

When reviewing, evaluate:

- Assumptions about network availability
- Assumptions about shell access
- Filesystem traversal safety
- child_process usage
- Runtime installs
- Deterministic dependency resolution
- Lockfile presence
- Docker hardening
- Kubernetes misconfiguration risks
- Terraform drift risks

Sandbox escape risk = HIGH severity minimum.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENGINEERING PREFERENCES (NON-NEGOTIABLE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- DRY is critical.
- Test coverage is non-negotiable.
- Prefer too many tests over too few.
- Code must be engineered enough.
- Handle more edge cases, not fewer.
- Validate all external boundaries.
- Production readiness mandatory.
- Deterministic builds preferred.
- Explicit configuration over implicit defaults.
- Avoid clever abstractions unless justified.

Do not assume scaling or timeline priorities — ask.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MODE SELECTION (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before analysis, ask:

1️⃣ BIG CHANGE  
Review in this order:
1. Automated Vulnerability Scan
2. Architecture
3. Security (Threat Modeling)
4. Data Integrity
5. Code Quality
6. Tests
7. Performance
8. Observability
9. Infrastructure (Docker/K8s/Terraform/AWS)
10. Container & Sandbox Boundaries

Limit to top 4 highest-risk issues per section unless asked for exhaustive review.

2️⃣ SMALL CHANGE  
Review ONE prioritized issue per section.

Do not proceed until mode selected.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTOMATED VULNERABILITY SCANNING (PHASE 1)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Perform offline static analysis only.

1️⃣ Dependency Risk Scan
- Verify lockfile exists
- Detect wildcard versions
- Detect Git/URL dependencies
- Detect lifecycle scripts
- Detect duplicate versions
- Detect runtime installs
- Ensure strict TypeScript config

Missing lockfile → HIGH  
Runtime installs → CRITICAL  

2️⃣ Runtime Risk Surface Scan
Search for:
- child_process
- eval / new Function
- dynamic require
- unsanitized fs usage
- path traversal
- prototype pollution
- absolute paths
- temp file misuse

3️⃣ Secret Exposure Scan
Detect:
- JWT secrets
- AWS keys
- DB credentials
- Private keys
- Committed .env

Hardcoded secrets → CRITICAL

4️⃣ Input Validation Scan
Verify:
- All REST endpoints validated
- WebSocket payloads validated
- JWT properly verified
- Env variables validated

5️⃣ Supply Chain Hardening
- Lockfile committed
- No floating versions
- No postinstall scripts executing remote code
- Proper separation of dev/prod dependencies

6️⃣ Deterministic Build Check
- Reproducible dependency graph
- Docker base image pinned (no node:latest)
- No runtime dependency resolution

If any CRITICAL vulnerability found:
STOP.
Present issue.
Require approval before continuing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRODUCTION-READINESS CRITERIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Verify:

- Strict TypeScript enabled
- No any types unless justified
- Centralized error handling
- Structured logging
- Prometheus metrics hooks where appropriate
- Health check endpoint
- Graceful shutdown
- Proper JWT rotation strategy
- Rate limiting where appropriate
- Redis usage justified if present
- BullMQ job retry & backoff configured
- DB indexing strategy present
- Deterministic builds

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVIEW SECTIONS (ORDERED)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ Architecture Review  
- Next.js + API boundary correctness
- REST + WebSocket separation
- Redux usage justified vs TanStack
- DB selection justified
- Queue boundaries (BullMQ)
- Cache boundaries (Redis)
- Scaling characteristics (K8s ready?)

2️⃣ Security Review (Threat Modeling)  
- JWT lifecycle
- Token storage strategy
- Injection risks (SQL/NoSQL)
- CORS misconfiguration
- AWS IAM misuse
- Privilege escalation
- Replay risk
- Rate limiting gaps

3️⃣ Data Integrity Review  
- PostgreSQL transaction usage
- Mongo consistency
- Dynamo partition design
- Concurrency & race conditions
- Idempotency
- Migration safety

4️⃣ Code Quality Review  
- DRY violations
- Type safety gaps
- Edge case blind spots
- Over/under-engineering
- Implicit behavior

5️⃣ Test Review  
Coverage minimum:
- Lines ≥ 80%
- Branches ≥ 75%
- Functions ≥ 80%

6️⃣ Verify:
- Vitest/Jest unit coverage
- Integration tests for APIs
- WebSocket tests
- BullMQ job tests
- Cypress e2e only if requested
- Error paths tested

7️⃣ Performance Review  
- N+1 queries
- Missing DB indexes
- Redis caching opportunities
- Blocking Node patterns
- Memory pressure risks

8️⃣ Observability Review  
- Structured logs
- Prometheus metrics
- Auth audit logs
- Queue monitoring
- Error traceability

9️⃣ Infrastructure Review  
- Dockerfile hardening
- Non-root container
- Kubernetes readiness probes
- Terraform state safety
- CI pipeline security
- AWS IAM least privilege

1️⃣0️⃣ Container & Sandbox Boundary Review  
- child_process usage
- Directory traversal risks
- Shell assumptions
- Network assumptions
- Workspace boundary violations

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ISSUE REPORTING FORMAT (STRICT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Issue #:
Title:
Category:
Vulnerability Type (if applicable):
Severity:
Likelihood:
Combined Risk:
User Impact:
Security Impact:
Sandbox Impact:
Files Affected:

Problem Description:

Options:

A) Recommended Option
- Implementation Effort:
- Risk:
- Impact:
- Maintenance Burden:
- Tradeoffs:

B) Alternative Option
(same structure)

C) Do Nothing (if reasonable)

Recommendation:
Tie to engineering preferences and stack alignment.

AskUserQuestion:
"For Issue X, do you approve Option A?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RISK PRIORITIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Classify each issue by:

- Severity
- Likelihood
- Production Impact
- Security Impact
- Sandbox Impact

Prioritize highest combined risk first.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERACTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Do NOT proceed without approval.
- After each section:
  - Provide risk summary.
  - Identify highest combined risk issue.
  - Pause.
- If CRITICAL vulnerability exists → block progression.
- This is ANALYSIS ONLY — no mutation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<summary>
✅ COMPLETED: <goal>

FILES CHANGED:
- path/to/file  (created | modified | deleted)

TEST RESULTS:
- <suite>: X/Y passed  [coverage: lines N%]

GIT CHECKPOINTS:
- <hash> — <message>

NOTES:
- <follow-up items or warnings>
</summary>
`;

export class Agent {
  private client: Anthropic;
  private log = createChildLogger({ component: 'Agent' });
  private cancelControllers = new Map<string, AbortController>();
  // Atomic counter for concurrent session tracking.
  // Uses mutex-protected compare-and-swap to prevent race conditions
  // where multiple requests could exceed maxConcurrentSessions.
  private sessionCounter = new AtomicCounter();
  
  // Pending patch approvals: patchId -> { resolve, reject }
  private pendingApprovals = new Map<string, { 
    resolve: (approved: boolean) => void; 
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private readonly config: Config,
    private readonly memory: DatabaseMemory
  ) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  // ─── Cancel a running session ────────────────────────────────────────────

  cancel(sessionId: string): boolean {
    const ctrl = this.cancelControllers.get(sessionId);
    if (ctrl) {
      ctrl.abort();
      this.cancelControllers.delete(sessionId);
      this.log.info('Agent run cancelled', { sessionId });
      return true;
    }
    return false;
  }

  // ─── Patch approval resolution ────────────────────────────────────────────
  
  resolvePatchApproval(patchId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(patchId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(patchId);
      pending.resolve(approved);
      this.log.info('Patch approval resolved', { patchId, approved });
    } else {
      this.log.warn('Patch approval not found', { patchId });
    }
  }
  
  // Request patch approval from user, returns true if approved
  async requestPatchApproval(
    patchId: string, 
    filePath: string, 
    diff: string, 
    operation: 'create' | 'modify' | 'delete',
    emit: (event: AgentEvent) => void,
    timeoutMs = 120000 // 2 minute timeout
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(patchId);
        this.log.warn('Patch approval timed out', { patchId });
        resolve(false); // Auto-reject on timeout
      }, timeoutMs);
      
      this.pendingApprovals.set(patchId, { resolve, reject, timeout });
      
      emit({
        type: 'patch_approval_required',
        data: { patchId, filePath, diff, operation },
        timestamp: new Date(),
      });
    });
  }

  get activeSessionCount(): number {
    return this.sessionCounter.value;
  }

  // ─── Cost estimation ─────────────────────────────────────────────────────
  // Pricing per million tokens (Anthropic pricing as of Jan 2025)
  private estimateCost(inputTokens: number, outputTokens: number, modelName?: string): number {
    const model = (modelName || this.config.model).toLowerCase();
    let inputPrice = 15.0;  // Opus default ($/M tokens)
    let outputPrice = 75.0;
    
    if (model.includes('haiku')) {
      inputPrice = 0.80;
      outputPrice = 4.0;
    } else if (model.includes('sonnet')) {
      inputPrice = 3.0;
      outputPrice = 15.0;
    }
    
    return (inputTokens / 1_000_000) * inputPrice + 
           (outputTokens / 1_000_000) * outputPrice;
  }

  // ─── Main run loop ───────────────────────────────────────────────────────

  async run(
    userMessage: string,
    sessionId?: string,
    onEvent?: EventHandler,
    options?: { model?: string }
  ): Promise<AgentRunResult> {
    const sid = sessionId ?? uuidv4();
    const start = Date.now();
    
    // Model override (validated against allowed list)
    const allowedModels = [
      'claude-opus-4-5',
      'claude-sonnet-4-5', 
      'claude-haiku-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
    ];
    const requestedModel = options?.model || this.config.model;
    const model = allowedModels.some(m => requestedModel.includes(m.replace('-4-5', ''))) 
      ? requestedModel 
      : this.config.model;

    // ── Concurrent session limit (atomic check-and-increment) ─────────────
    const maxConcurrent = this.config.maxConcurrentSessions;
    const acquired = await this.sessionCounter.tryIncrement(maxConcurrent);
    if (!acquired) {
      const err =
        `Too many concurrent sessions (${this.sessionCounter.value}/${maxConcurrent}). ` +
        `Wait for a running session to finish or cancel one.`;
      this.log.warn('Concurrent session limit reached', {
        activeSessions: this.sessionCounter.value,
        maxConcurrent,
        sessionId: sid,
      });
      throw new Error(err);
    }

    // ── Prompt size guard ───────────────────────────────────────────────────
    const maxChars = this.config.maxPromptChars;
    if (userMessage.length > maxChars) {
      // Release the session slot before throwing
      await this.sessionCounter.decrement();
      throw new Error(
        `Prompt too large: ${userMessage.length.toLocaleString()} characters ` +
          `(limit: ${maxChars.toLocaleString()}). Split the request into smaller parts.`
      );
    }

    this.log.info('Agent run started', {
      sessionId: sid,
      messageLength: userMessage.length,
      activeSessions: this.sessionCounter.value,
    });

    // Abort controller for cancel support
    const abortController = new AbortController();
    this.cancelControllers.set(sid, abortController);

    const emit = (event: AgentEvent) => {
      try {
        onEvent?.(event);
      } catch {
        /* handler errors never crash the agent */
      }
    };

    // Session
    if (!this.memory.getSession(sid)) {
      this.memory.createSession(sid, this.config.workspaceDir);
    }

    this.memory.addMessage({
      id: uuidv4(),
      sessionId: sid,
      role: 'user',
      content: userMessage,
      metadata: { workspaceDir: this.config.workspaceDir },
    });
    emit({
      type: 'message',
      data: { role: 'user', content: userMessage },
      timestamp: new Date(),
    });

    // Context window management — summarise if over limit
    const messages = await this.buildContext(sid, userMessage);

    // Knowledge injection
    const knowledge = this.memory.listKnowledge();
    const knowledgeContext =
      knowledge.length > 0
        ? '\n\n## Persistent Knowledge:\n' +
          knowledge
            .map((k) => `[${k.category}] ${k.key}: ${k.value}`)
            .join('\n')
        : '';

    // Custom project context — read .agentcontext or .agent/context.md if present
    const projectContext = await this.loadProjectContext();

    const executor = new ToolExecutor(this.config, this.memory, sid);
    const git = new GitTool(this.config.workspaceDir);
    await git.ensureRepo();

    let toolCallsCount = 0;
    let finalSummary = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turnCount = 0;
    // Track unique tool names used for better summary generation
    const toolsUsed = new Set<string>();
    // Tracks whether the 80% budget warning has already fired this run.
    // A boolean avoids the fragile "infer from previous turn total" approach.
    let budgetWarningFired = false;
    const toolCallLimit = this.config.maxToolCalls;

    // always decrement activeSessions whether we return normally, throw, or break
    try {
      // ─── Agentic loop ──────────────────────────────────────────────────────
      while (true) {
        if (abortController.signal.aborted) {
          this.log.info('Agent run aborted by cancel', { sessionId: sid });
          emit({
            type: 'error',
            data: { error: 'Cancelled by user', sessionId: sid },
            timestamp: new Date(),
          });
          break;
        }

        emit({
          type: 'thinking',
          data: { messageCount: messages.length },
          timestamp: new Date(),
        });
        this.log.debug('Calling Claude API (streaming)', {
          sessionId: sid,
          messageCount: messages.length,
        });

        // ── Streaming API call with retry logic ───────────────────────────────
        let fullText = '';
        const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
        let stopReason = '';
        let inputTokens = 0;
        let outputTokens = 0;
        let rawContent: Anthropic.ContentBlock[] = [];

        const systemPrompt = SYSTEM_PROMPT + knowledgeContext + projectContext;
        
        // Debug log the request
        logApiDebug('request', {
          sessionId: sid,
          model: model,
          messages: messages,
          tools: TOOL_DEFINITIONS.map(t => t.name),
        });

        // Retry loop for transient API errors
        let lastError: any = null;
        for (let attempt = 0; attempt <= this.config.apiRetryCount; attempt++) {
          if (attempt > 0) {
            const delay = getRetryDelay(
              attempt - 1,
              this.config.apiRetryDelay,
              this.config.apiRetryMaxDelay,
              lastError
            );
            this.log.warn('Retrying API call after transient error', {
              sessionId: sid,
              attempt,
              maxAttempts: this.config.apiRetryCount,
              delayMs: delay,
              error: lastError?.message,
            });
            emit({
              type: 'error',
              data: { 
                error: `API error, retrying in ${Math.round(delay/1000)}s (attempt ${attempt}/${this.config.apiRetryCount})...`,
                retrying: true,
              },
              timestamp: new Date(),
            });
            await sleep(delay);
          }

          try {
            fullText = '';
            toolUseBlocks.length = 0;
            
            const stream = this.client.messages.stream({
              model: model,
              max_tokens: this.config.maxTokens,
              // Use prompt caching for the system prompt to reduce costs on subsequent calls
              // The ~3,500 token system prompt is cached at 90% discount after first call
              system: [
                {
                  type: 'text',
                  text: systemPrompt,
                  cache_control: { type: 'ephemeral' },
                } as any,
              ],
              tools: TOOL_DEFINITIONS as any,
              messages,
            });

            // Stream text deltas to UI in real time
            stream.on('text', (delta) => {
              fullText += delta;
              emit({
                type: 'stream_delta',
                data: { delta, sessionId: sid },
                timestamp: new Date(),
              });
            });

            // Check for cancel mid-stream
            abortController.signal.addEventListener(
              'abort',
              () => stream.abort(),
              { once: true }
            );

            const finalMsg = await stream.finalMessage();
            rawContent = finalMsg.content;
            stopReason = finalMsg.stop_reason ?? '';
            inputTokens = finalMsg.usage.input_tokens;
            outputTokens = finalMsg.usage.output_tokens;

            for (const block of rawContent) {
              if (block.type === 'tool_use') toolUseBlocks.push(block);
            }

            // Debug log the successful response
            logApiDebug('response', {
              sessionId: sid,
              response: {
                stopReason,
                contentBlocks: rawContent.length,
                toolCalls: toolUseBlocks.map(t => t.name),
                textLength: fullText.length,
              },
              tokens: { input: inputTokens, output: outputTokens },
              attempt: attempt > 0 ? attempt : undefined,
            });

            // Success - break out of retry loop
            lastError = null;
            break;
            
          } catch (err: any) {
            lastError = err;
            
            // Check for user cancellation
            if (err?.name === 'AbortError' || abortController.signal.aborted) {
              break;
            }
            
            // Debug log the error
            logApiDebug('error', {
              sessionId: sid,
              error: {
                message: err?.message,
                status: err?.status,
                code: err?.code,
              },
              attempt,
            });
            
            // Check if error is retryable
            if (!isRetryableError(err) || attempt === this.config.apiRetryCount) {
              this.log.error('Claude API error (non-retryable or max retries exceeded)', {
                error: err?.message,
                sessionId: sid,
                attempt,
                retryable: isRetryableError(err),
              });
              emit({
                type: 'error',
                data: { error: err?.message },
                timestamp: new Date(),
              });
              throw err;
            }
            // Continue to next retry attempt
          }
        }

        // If we broke out due to cancellation, exit the main loop
        if (abortController.signal.aborted) break;

        // Record token usage
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        this.memory.recordTokenUsage(
          sid,
          inputTokens,
          outputTokens,
          model
        );

        const totalUsed = totalInputTokens + totalOutputTokens;
        const budget = this.config.tokenBudget;

        this.log.debug('API response', {
          stopReason,
          inputTokens,
          outputTokens,
          tools: toolUseBlocks.length,
          totalUsed,
          budgetRemaining: budget > 0 ? budget - totalUsed : 'unlimited',
        });

        // ── Emit turn_complete with token usage for UI ────────────────────────
        // This allows the UI to show per-turn costs and help identify expensive operations
        const estimatedCostThisTurn = this.estimateCost(inputTokens, outputTokens, model);
        emit({
          type: 'turn_complete',
          data: {
            sessionId: sid,
            turn: turnCount,
            inputTokens,
            outputTokens,
            totalTokensThisTurn: inputTokens + outputTokens,
            estimatedCostThisTurn,
            totalInputTokens,
            totalOutputTokens,
            totalTokens: totalUsed,
            budgetUsedPercent: budget > 0 ? Math.round((totalUsed / budget) * 100) : null,
            budgetRemaining: budget > 0 ? budget - totalUsed : null,
          },
          timestamp: new Date(),
        });
        
        turnCount++; // Increment turn counter for next iteration

        // ── Token budget enforcement ─────────────────────────────────────────
        if (budget > 0) {
          const pct = totalUsed / budget;

          // Warn exactly once when crossing 80%. Using a boolean flag avoids the
          // edge case where a single large turn jumps from <80% to >100%, which
          // caused the old inference-based check to silently skip the warning.
          if (!budgetWarningFired && pct >= 0.8 && pct < 1.0) {
            budgetWarningFired = true;
            this.log.warn('Token budget 80% warning', {
              totalUsed,
              budget,
              sessionId: sid,
            });
            emit({
              type: 'budget_warning',
              data: { totalUsed, budget, percentUsed: Math.round(pct * 100) },
              timestamp: new Date(),
            });
          }

          // Halt when budget is exhausted
          if (totalUsed >= budget) {
            this.log.error('Token budget exceeded — halting loop', {
              totalUsed,
              budget,
              sessionId: sid,
            });
            emit({
              type: 'budget_exceeded',
              data: { totalUsed, budget, percentUsed: Math.round(pct * 100) },
              timestamp: new Date(),
            });
            if (fullText)
              this.memory.updateSessionSummary(sid, fullText.slice(0, 500));
            break;
          }
        }

        // ── Tool call limit enforcement ───────────────────────────────────────
        // Independent of the token budget — whichever ceiling is hit first stops
        // the loop. This catches stuck retry cycles before they drain the budget.
        if (toolCallLimit > 0 && toolCallsCount >= toolCallLimit) {
          this.log.error('Tool call limit reached — halting loop', {
            toolCallsCount,
            toolCallLimit,
            sessionId: sid,
          });
          emit({
            type: 'tool_limit_exceeded',
            data: {
              toolCallsCount,
              limit: toolCallLimit,
              message:
                `Tool call limit reached (${toolCallsCount}/${toolCallLimit}). ` +
                `The agent may be stuck in a retry loop. Review the session and ` +
                `increase AGENT_MAX_TOOL_CALLS if the task genuinely needs more steps.`,
            },
            timestamp: new Date(),
          });
          if (fullText)
            this.memory.updateSessionSummary(sid, fullText.slice(0, 500));
          break;
        }

        // Emit complete text message
        if (fullText) {
          finalSummary = fullText;
          emit({
            type: 'message',
            data: { role: 'assistant', content: fullText },
            timestamp: new Date(),
          });
          this.memory.addMessage({
            id: uuidv4(),
            sessionId: sid,
            role: 'assistant',
            content: fullText,
            metadata: { model: this.config.model, inputTokens, outputTokens },
          });
        }

        messages.push({ role: 'assistant', content: rawContent });

        if (
          stopReason === 'end_turn' ||
          stopReason !== 'tool_use' ||
          toolUseBlocks.length === 0
        )
          break;

        // ── Parallel tool execution ──────────────────────────────────────────
        // Classify which tools are safe to run in parallel (reads/memory) vs
        // must run sequentially (writes, shell, git — to avoid race conditions)
        const { parallel, sequential } = classifyTools(toolUseBlocks);

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        // Progress callback for long-running tools
        const onToolProgress = (progress: { toolCallId: string; toolName: string; progress: number; status: string; elapsedMs: number }) => {
          emit({
            type: 'tool_progress',
            data: progress,
            timestamp: new Date(),
          });
        };

        // Run read-only tools in parallel
        if (parallel.length > 0) {
          this.log.debug('Running tools in parallel', {
            count: parallel.length,
            tools: parallel.map((t) => t.name),
          });
          const results = await Promise.all(
            parallel.map(async (toolUse) => {
              toolCallsCount++;
              toolsUsed.add(toolUse.name); // Track for summary generation
              emit({
                type: 'tool_call',
                data: {
                  name: toolUse.name,
                  input: toolUse.input,
                  id: toolUse.id,
                },
                timestamp: new Date(),
              });
              const result = await executor.execute(
                { name: toolUse.name, input: toolUse.input },
                this.config.maxRetries,
                onToolProgress
              );
              emit({
                type: 'tool_result',
                data: {
                  toolCallId: toolUse.id,
                  toolName: toolUse.name,
                  success: result.success,
                  result: result.result,
                  durationMs: result.durationMs,
                },
                timestamp: new Date(),
              });
              return { toolUse, result };
            })
          );
          for (const { toolUse, result } of results) {
            const { param, serialized } = buildToolResultParam(
              toolUse.id, 
              result,
              this.config.maxToolOutputContext
            );
            this.persistToolResult(sid, toolUse, result, serialized);
            toolResults.push(param);
          }
        }

        // Run write/side-effect tools sequentially
        for (const toolUse of sequential) {
          if (abortController.signal.aborted) break;
          toolCallsCount++;
          toolsUsed.add(toolUse.name); // Track for summary generation

          // Secret scan before any git checkpoint
          if (toolUse.name === 'git_checkpoint') {
            const secretHits = await this.scanForSecrets();
            if (secretHits.length > 0) {
              const warning = `⚠️ Secret scan blocked checkpoint: ${secretHits.join(', ')}. Remove secrets before committing.`;
              this.log.warn('Secret scan blocked git checkpoint', {
                hits: secretHits,
                sessionId: sid,
              });
              emit({
                type: 'error',
                data: { error: warning },
                timestamp: new Date(),
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: warning,
                is_error: true,
              });
              continue;
            }
          }

          emit({
            type: 'tool_call',
            data: { name: toolUse.name, input: toolUse.input, id: toolUse.id },
            timestamp: new Date(),
          });
          const result = await executor.execute(
            { name: toolUse.name, input: toolUse.input },
            this.config.maxRetries,
            onToolProgress
          );
          emit({
            type: 'tool_result',
            data: {
              toolCallId: toolUse.id,
              toolName: toolUse.name,
              success: result.success,
              result: result.result,
              durationMs: result.durationMs,
            },
            timestamp: new Date(),
          });
          const { param, serialized } = buildToolResultParam(
            toolUse.id, 
            result,
            this.config.maxToolOutputContext
          );
          this.persistToolResult(sid, toolUse, result, serialized);
          toolResults.push(param);
        }

        messages.push({ role: 'user', content: toolResults });
      }

      this.cancelControllers.delete(sid);

      // Generate a high-quality summary using Haiku (cheap) instead of truncating
      // This creates much better session titles for the session list
      if (finalSummary || toolsUsed.size > 0) {
        try {
          const betterSummary = await this.generateSessionSummary(
            userMessage,
            finalSummary,
            Array.from(toolsUsed)
          );
          if (betterSummary) {
            finalSummary = betterSummary;
          }
        } catch (err) {
          // Fall back to truncated response if Haiku call fails
          this.log.warn('Failed to generate session summary with Haiku', { 
            error: (err as Error).message 
          });
        }
      }
      
      if (finalSummary)
        this.memory.updateSessionSummary(sid, finalSummary.slice(0, 500));

      const durationMs = Date.now() - start;
      const tokenUsageSummary = this.memory.getSessionTokenUsage(sid);

      this.log.info('Agent run finished', {
        sessionId: sid,
        toolCallsCount,
        durationMs,
        totalInputTokens,
        totalOutputTokens,
        estimatedCostUsd: tokenUsageSummary.estimatedCostUsd.toFixed(4),
      });

      emit({
        type: 'complete',
        data: {
          sessionId: sid,
          toolCallsCount,
          durationMs,
          summary: finalSummary,
          tokenUsage: tokenUsageSummary,
        },
        timestamp: new Date(),
      });

      return {
        sessionId: sid,
        summary: finalSummary,
        toolCallsCount,
        success: true,
        durationMs,
        model,
        tokenUsage: tokenUsageSummary,
      };
    } finally {
      // Always release the slot — even if we threw, cancelled, or hit a limit
      // Note: decrement is async but we don't await in finally to avoid blocking.
      // The AtomicCounter ensures thread-safety regardless.
      this.sessionCounter.decrement().then(() => {
        this.log.debug('Session slot released', {
          sessionId: sid,
          activeSessions: this.sessionCounter.value,
        });
      }).catch((err) => {
        this.log.error('Failed to release session slot', { sessionId: sid, error: err.message });
      });
    }
  }

  // ─── Context window management ───────────────────────────────────────────

  private async buildContext(
    sessionId: string,
    currentMessage: string
  ): Promise<MessageParam[]> {
    const messageCount = this.memory.countMessages(sessionId);
    const limit = this.config.maxContextMessages;

    if (messageCount <= limit) {
      const history = this.memory.getMessages(sessionId, limit);
      return this.historyToParams(history, currentMessage);
    }

    // Over limit — check if we already have a stored summary
    const existingSummary = this.memory.getKnowledge(
      `ctx_summary_${sessionId}`
    );

    // Summarise the oldest messages, keep the most recent verbatim.
    // getRecentMessages returns the LAST N messages by created_at, which is
    // what we need — the previous code used getMessages(limit).slice() which
    // only returned the first `limit` rows and silently dropped anything newer.
    const halfLimit = Math.floor(limit / 2);
    const oldMessages = this.memory.getMessages(sessionId, halfLimit);
    const recentMessages = this.memory.getRecentMessages(sessionId, halfLimit);

    if (!existingSummary || messageCount % Math.floor(limit / 2) === 0) {
      this.log.info(
        'Context window limit reached — summarising older messages',
        { sessionId, messageCount }
      );
      const summary = await this.summariseMessages(oldMessages);
      this.memory.setKnowledge(`ctx_summary_${sessionId}`, summary, 'context');
      this.log.info('Context summary stored', {
        sessionId,
        summaryLength: summary.length,
      });
    }

    const summaryText =
      this.memory.getKnowledge(`ctx_summary_${sessionId}`) ??
      existingSummary ??
      '';
    const messages: MessageParam[] = [];

    if (summaryText) {
      messages.push({
        role: 'user',
        content: `[CONTEXT SUMMARY — earlier conversation]\n${summaryText}`,
      });
      messages.push({
        role: 'assistant',
        content: 'Understood. Continuing from where we left off.',
      });
    }

    for (const entry of recentMessages) {
      if (entry.role === 'user' || entry.role === 'assistant') {
        messages.push({ role: entry.role, content: entry.content });
      }
    }

    // Ensure current message is the last
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== currentMessage) {
      messages.push({ role: 'user', content: currentMessage });
    }

    return messages;
  }

  private async summariseMessages(messages: any[]): Promise<string> {
    const content = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`)
      .join('\n\n');

    const response = await this.client.messages.create({
      model: INTERNAL_MODEL, // Haiku for summarization — 20x cheaper than Opus
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            `Summarise the following conversation history into a concise 2-4 paragraph context summary. ` +
            `Preserve: decisions made, files changed, patterns established, errors encountered and resolved.\n\n${content}`,
        },
      ],
    });

    return (response.content[0] as any)?.text ?? '';
  }

  // ─── Generate session summary using cheap model ─────────────────────────────
  // Creates a one-line summary of what was accomplished, used for session list display.
  // Uses Haiku to generate a high-quality summary at minimal cost (~$0.0001 per summary).
  private async generateSessionSummary(
    userMessage: string,
    assistantResponse: string,
    toolsUsed: string[]
  ): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: INTERNAL_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: `Generate a concise one-line summary (max 80 chars) of this coding session.
User asked: "${userMessage.slice(0, 200)}"
Assistant did: ${toolsUsed.length > 0 ? `Used tools: ${toolsUsed.join(', ')}. ` : ''}${assistantResponse.slice(0, 300)}

Summary (be specific about what was done, e.g. "Added auth middleware to Express API"):`,
          },
        ],
      });

      const summary = ((response.content[0] as any)?.text ?? '').trim();
      // Ensure it's not too long and remove any quotes
      return summary.replace(/^["']|["']$/g, '').slice(0, 100);
    } catch (err) {
      this.log.warn('Failed to generate session summary with Haiku', { error: (err as Error).message });
      // Fallback to simple truncation
      return assistantResponse.slice(0, 100).split('\n')[0];
    }
  }

  private historyToParams(
    history: any[],
    currentMessage: string
  ): MessageParam[] {
    const messages: MessageParam[] = [];
    for (const entry of history) {
      if (entry.role === 'user' || entry.role === 'assistant') {
        // Merge adjacent same-role messages to satisfy Claude's alternation requirement
        const last = messages[messages.length - 1];
        if (last && last.role === entry.role) {
          // Append to previous message with separator
          last.content = `${last.content}\n\n${entry.content}`;
        } else {
          messages.push({ role: entry.role, content: entry.content });
        }
      }
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== currentMessage) {
      // Merge if last is also user
      if (last && last.role === 'user') {
        last.content = `${last.content}\n\n${currentMessage}`;
      } else {
        messages.push({ role: 'user', content: currentMessage });
      }
    }
    return messages;
  }

  // ─── Secret scanning ─────────────────────────────────────────────────────

  private async scanForSecrets(): Promise<string[]> {
    const hits: string[] = [];
    try {
      const git = new GitTool(this.config.workspaceDir);
      // Use async .diff() instead of blocking execSync to avoid stalling the event loop
      const diff = await git.diff(['--cached']);
      if (!diff) return [];

      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(diff)) hits.push(name);
      }
    } catch {
      // Not a git repo yet or no staged files — skip
    }
    return hits;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private persistToolResult(
    sessionId: string,
    toolUse: Anthropic.ToolUseBlock,
    result: any,
    serializedResult?: string
  ): void {
    const output = serializedResult ?? JSON.stringify(result.result);
    this.memory.addMessage({
      id: uuidv4(),
      sessionId,
      role: 'tool',
      content: output,
      toolName: toolUse.name,
      toolResult: result.error,
      metadata: { durationMs: result.durationMs, success: result.success },
    });
  }

  // ─── Custom project context ─────────────────────────────────────────────────
  // Reads .agentcontext or .agent/context.md from workspace for project-specific
  // instructions like coding standards, tech stack notes, etc.

  private async loadProjectContext(): Promise<string> {
    const workspace = this.config.workspaceDir;
    const contextPaths = [
      path.join(workspace, '.agentcontext'),
      path.join(workspace, '.agent', 'context.md'),
      path.join(workspace, '.agent', 'CONTEXT.md'),
    ];

    for (const contextPath of contextPaths) {
      try {
        if (await fs.pathExists(contextPath)) {
          const content = await fs.readFile(contextPath, 'utf8');
          // Limit context size to prevent overwhelming the model
          const maxContextSize = 10_000;
          const trimmed = content.length > maxContextSize
            ? content.slice(0, maxContextSize) + '\n...[TRUNCATED]'
            : content;
          
          this.log.info('Loaded project context', { 
            path: contextPath, 
            size: content.length,
            truncated: content.length > maxContextSize 
          });
          
          return `\n\n## Project Context (from ${path.basename(contextPath)}):\n${trimmed}`;
        }
      } catch (err: any) {
        this.log.debug('Could not load project context', { path: contextPath, error: err.message });
      }
    }

    return '';
  }
}

// ─── Parallel tool classification ─────────────────────────────────────────────
// Read-only tools are safe to parallelise. Anything that writes files, runs
// shell commands, or touches git must be sequential to avoid race conditions.

const READ_ONLY_TOOLS = new Set([
  // File reads — no side effects, safe to parallelise
  'read_file',
  'list_files',
  'search_files',
  // Git reads
  'git_status',
  'git_diff',
  // Memory reads
  'memory_get',
  // Type checking (reads only, --noEmit default)
  'tsc_check',
]);

function classifyTools(blocks: Anthropic.ToolUseBlock[]): {
  parallel: Anthropic.ToolUseBlock[];
  sequential: Anthropic.ToolUseBlock[];
} {
  const parallel: Anthropic.ToolUseBlock[] = [];
  const sequential: Anthropic.ToolUseBlock[] = [];
  for (const block of blocks) {
    (READ_ONLY_TOOLS.has(block.name) ? parallel : sequential).push(block);
  }
  return { parallel, sequential };
}

// ─── Tool Output Summarization ────────────────────────────────────────────────
// Summarizes large tool outputs before sending to Claude to save context space.
// This significantly reduces token usage for tools that return verbose output.

function summarizeLargeOutput(
  toolName: string,
  output: string,
  maxChars: number
): string {
  if (maxChars === 0 || output.length <= maxChars) {
    return output;
  }

  // Tool-specific summarization strategies
  const summarizers: Record<string, (o: string) => string> = {
    list_files: (o) => {
      try {
        const files = JSON.parse(o);
        if (Array.isArray(files) && files.length > 50) {
          const dirs = new Set<string>();
          const extensions = new Map<string, number>();
          for (const f of files) {
            const parts = f.split('/');
            if (parts.length > 1) dirs.add(parts.slice(0, -1).join('/'));
            const ext = f.includes('.') ? f.split('.').pop() : 'no-ext';
            extensions.set(ext!, (extensions.get(ext!) || 0) + 1);
          }
          const extSummary = Array.from(extensions.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([ext, count]) => `${ext}: ${count}`)
            .join(', ');
          return JSON.stringify({
            _summary: true,
            totalFiles: files.length,
            directories: dirs.size,
            extensions: extSummary,
            sample: files.slice(0, 20),
            message: `Showing 20 of ${files.length} files. Use more specific patterns to narrow results.`,
          }, null, 2);
        }
      } catch { /* not JSON, fall through */ }
      return o;
    },
    
    search_files: (o) => {
      try {
        const results = JSON.parse(o);
        if (Array.isArray(results) && results.length > 20) {
          const byFile = new Map<string, number>();
          for (const r of results) {
            if (r.file) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);
          }
          return JSON.stringify({
            _summary: true,
            totalMatches: results.length,
            filesWithMatches: byFile.size,
            topFiles: Array.from(byFile.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([file, count]) => ({ file, matches: count })),
            sample: results.slice(0, 15),
            message: `Showing 15 of ${results.length} matches. Refine your search pattern for more targeted results.`,
          }, null, 2);
        }
      } catch { /* not JSON, fall through */ }
      return o;
    },
    
    run_tests: (o) => {
      // Keep test results but truncate verbose output
      if (o.length > maxChars) {
        const keepStart = Math.floor(maxChars * 0.3);
        const keepEnd = Math.floor(maxChars * 0.5);
        return o.slice(0, keepStart) + 
          `\n\n... [${o.length - keepStart - keepEnd} characters truncated] ...\n\n` +
          o.slice(-keepEnd);
      }
      return o;
    },
  };

  // Use tool-specific summarizer if available
  if (summarizers[toolName]) {
    const summarized = summarizers[toolName](output);
    if (summarized.length <= maxChars) return summarized;
  }

  // Generic truncation with context preservation
  const keepStart = Math.floor(maxChars * 0.6);
  const keepEnd = Math.floor(maxChars * 0.3);
  return output.slice(0, keepStart) + 
    `\n\n... [${output.length - keepStart - keepEnd} characters truncated for context efficiency] ...\n\n` +
    output.slice(-keepEnd);
}

function buildToolResultParam(
  toolUseId: string,
  result: any,
  maxOutputContext: number = 0
): { param: Anthropic.ToolResultBlockParam; serialized: string } {
  let serialized = result.success
    ? JSON.stringify(result.result, null, 2)
    : `ERROR: ${result.error}`;
  
  // Summarize large outputs to save context space
  if (maxOutputContext > 0 && serialized.length > maxOutputContext) {
    serialized = summarizeLargeOutput(
      result.toolName || 'unknown',
      serialized,
      maxOutputContext
    );
  }
  
  return {
    param: {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: serialized,
      is_error: !result.success,
    },
    serialized,
  };
}

// ─── API Retry Logic ──────────────────────────────────────────────────────────
// Retries transient API errors (429, 500, 503, network errors) with exponential backoff.

function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }
  
  // HTTP status codes
  const status = error.status || error.statusCode;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  
  // Anthropic SDK specific errors
  if (error.message?.includes('overloaded') || error.message?.includes('rate limit')) {
    return true;
  }
  
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  error?: any
): number {
  // Check for Retry-After header
  const retryAfter = error?.headers?.['retry-after'];
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return Math.min(seconds * 1000, maxDelay);
    }
  }
  
  // Exponential backoff with jitter
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}
