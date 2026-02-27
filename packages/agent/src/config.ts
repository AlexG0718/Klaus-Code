import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';

const ConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  AGENT_WORKSPACE: z.string().default(process.cwd()),
  // Host path for workspace - used by Docker sandbox for bind mounts in DooD mode.
  // In Docker, AGENT_WORKSPACE is /workspace (container path), but sandbox containers
  // need the HOST path to mount the same directory. Falls back to AGENT_WORKSPACE.
  AGENT_HOST_WORKSPACE: z.string().optional(),
  AGENT_DB_PATH: z
    .string()
    .default(path.join(os.homedir(), '.klaus-code', 'memory.db')),
  AGENT_LOG_DIR: z
    .string()
    .default(path.join(os.homedir(), '.klaus-code', 'logs')),
  AGENT_MODEL: z.string().default('claude-opus-4-5'),
  AGENT_MAX_TOKENS: z.coerce.number().default(8192),
  AGENT_MAX_RETRIES: z.coerce.number().default(3),
  AGENT_API_SECRET: z.string().min(16).optional(),
  AGENT_MAX_CONTEXT_MESSAGES: z.coerce.number().default(30),

  // Per-session token budget. Loop halts when input+output tokens reach this.
  // Set to 0 to disable (not recommended for unattended use).
  AGENT_TOKEN_BUDGET: z.coerce.number().min(0).default(100_000),

  // Dynamic token budget tiers (optional). When all three are set (non-zero),
  // sessions start at TIER1 and escalate based on complexity signals (repeated
  // test failures, scope expansion). Leave at 0 to use the flat AGENT_TOKEN_BUDGET.
  AGENT_TOKEN_BUDGET_TIER1: z.coerce.number().min(0).default(0),
  AGENT_TOKEN_BUDGET_TIER2: z.coerce.number().min(0).default(0),
  AGENT_TOKEN_BUDGET_TIER3: z.coerce.number().min(0).default(0),

  // Maximum tool calls per session. Halts stuck retry loops before they burn
  // the full token budget. Independent of the token budget — whichever limit
  // is hit first stops the loop.
  AGENT_MAX_TOOL_CALLS: z.coerce.number().min(0).default(50),

  // Maximum number of sessions that can be running concurrently.
  // Additional requests are rejected with 429 until a slot frees up.
  AGENT_MAX_CONCURRENT_SESSIONS: z.coerce.number().min(1).default(3),

  // Allowed CORS origin for the HTTP API and Socket.IO.
  // Use '*' for fully open (local dev only). Use a specific origin in production.
  AGENT_CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Maximum prompt length in characters. Requests larger than this are rejected
  // before they reach the API — prevents accidental or malicious oversized inputs.
  AGENT_MAX_PROMPT_CHARS: z.coerce.number().min(100).default(32_000),

  // Trust proxy setting for Express. Required for correct IP detection behind
  // reverse proxies, load balancers, or Docker networks. Values:
  // - 'false' or '0': Disable (default, direct connections only)
  // - 'true' or '1': Trust first proxy
  // - Number (e.g., '2'): Trust N proxies deep
  // - 'loopback': Trust loopback addresses
  // - Comma-separated IPs: Trust specific proxy IPs
  AGENT_TRUST_PROXY: z.string().default('false'),

  // Maximum results returned by searchInFiles tool. Prevents unbounded memory
  // usage and context window overflow from broad regex matches.
  AGENT_MAX_SEARCH_RESULTS: z.coerce.number().min(1).default(500),

  // WebSocket rate limiting: max events per socket per minute
  AGENT_WS_RATE_LIMIT: z.coerce.number().min(1).default(30),

  // Graceful shutdown timeout in ms. Force-terminates after this duration.
  AGENT_SHUTDOWN_TIMEOUT: z.coerce.number().min(1000).default(30_000),

  // Webhook URL for session completion notifications (optional)
  AGENT_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),

  // Maximum tool result size stored in database (bytes). Larger results are truncated.
  AGENT_MAX_TOOL_RESULT_SIZE: z.coerce.number().min(1024).default(10_240),

  // Enable Prometheus metrics endpoint at /metrics
  AGENT_METRICS_ENABLED: z
    .string()
    .transform((v: string) => v === 'true')
    .default('true'),

  // Session TTL in milliseconds. Sessions idle longer than this are auto-expired.
  // Set to 0 to disable (sessions live forever). Default: 24 hours.
  AGENT_SESSION_TTL: z.coerce.number().min(0).default(86_400_000),

  // Session cleanup interval in milliseconds. How often to check for expired sessions.
  // Default: 5 minutes.
  AGENT_SESSION_CLEANUP_INTERVAL: z.coerce
    .number()
    .min(60_000)
    .default(300_000),

  // Require human approval for file-modifying patches (diff preview)
  AGENT_REQUIRE_PATCH_APPROVAL: z
    .string()
    .transform((v: string) => v === 'true')
    .default('false'),

  // ─── API Retry Settings ───────────────────────────────────────────────────
  // Number of retries for transient API errors (429, 500, 503, network errors)
  AGENT_API_RETRY_COUNT: z.coerce.number().min(0).max(10).default(3),
  // Initial delay between retries in ms. Doubles with each retry (exponential backoff).
  AGENT_API_RETRY_DELAY: z.coerce.number().min(100).default(1000),
  // Maximum delay between retries in ms.
  AGENT_API_RETRY_MAX_DELAY: z.coerce.number().min(1000).default(30_000),

  // ─── Tool Output Context Limit ────────────────────────────────────────────
  // Maximum characters of tool output to include in Claude's context.
  // Larger outputs are summarized to save tokens. Set to 0 for no limit.
  AGENT_MAX_TOOL_OUTPUT_CONTEXT: z.coerce.number().min(0).default(8_000),

  // ─── Debug Mode ───────────────────────────────────────────────────────────
  // When enabled, logs full prompts/responses to debug log file for troubleshooting.
  // WARNING: This logs sensitive data including your prompts. Use only for debugging.
  AGENT_DEBUG_MODE: z
    .string()
    .transform((v: string) => v === 'true')
    .default('false'),

  NETLIFY_AUTH_TOKEN: z.string().optional(),
  NETLIFY_SITE_ID: z.string().optional(),
  VERCEL_TOKEN: z.string().optional(),
  // AWS credentials are read from environment by AWS CLI/SDK directly
  // AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
  DOCKER_ENABLED: z
    .string()
    .transform((v: string) => v !== 'false')
    .default('true'),
  PORT: z.coerce.number().default(3001),
});

export type Config = {
  apiKey: string;
  workspaceDir: string;
  hostWorkspaceDir?: string; // Host path for Docker sandbox bind mounts (defaults to workspaceDir)
  dbPath: string;
  logDir: string;
  model: string;
  maxTokens: number;
  maxRetries: number;
  apiSecret?: string;
  maxContextMessages: number;
  tokenBudget: number;
  tokenBudgetTier1: number;
  tokenBudgetTier2: number;
  tokenBudgetTier3: number;
  maxToolCalls: number;
  maxConcurrentSessions: number;
  corsOrigin: string;
  maxPromptChars: number;
  trustProxy: string | boolean | number;
  maxSearchResults: number;
  wsRateLimit: number;
  shutdownTimeout: number;
  webhookUrl?: string;
  maxToolResultSize: number;
  metricsEnabled: boolean;
  sessionTtl: number;
  sessionCleanupInterval: number;
  requirePatchApproval: boolean;
  apiRetryCount: number;
  apiRetryDelay: number;
  apiRetryMaxDelay: number;
  maxToolOutputContext: number;
  debugMode: boolean;
  netlifyToken?: string;
  netlifySiteId?: string;
  vercelToken?: string;
  dockerEnabled: boolean;
  port: number;
};

export function loadConfig(): Config {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  try {
    require('dotenv').config();
  } catch {
    /* optional */
  }

  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      '❌ Config validation failed:',
      JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)
    );
    process.exit(1);
  }

  const env = parsed.data;

  if (!env.DOCKER_ENABLED) {
    console.warn(
      '\n⚠️  WARNING: DOCKER_ENABLED=false — child processes run on your host machine.\n'
    );
  }
  if (!env.AGENT_API_SECRET) {
    console.warn(
      '\n⚠️  WARNING: AGENT_API_SECRET not set — API endpoints are unauthenticated.\n' +
        '   Generate one: openssl rand -hex 32\n'
    );
  }
  if (env.AGENT_CORS_ORIGIN === '*') {
    console.warn(
      '\n⚠️  WARNING: AGENT_CORS_ORIGIN=* — API is open to all origins.\n'
    );
  }

  // Parse trust proxy setting
  const parseTrustProxy = (value: string): string | boolean | number => {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    const num = parseInt(value, 10);
    if (!isNaN(num)) return num;
    return value; // 'loopback' or comma-separated IPs
  };

  return {
    apiKey: env.ANTHROPIC_API_KEY,
    workspaceDir: env.AGENT_WORKSPACE,
    hostWorkspaceDir: env.AGENT_HOST_WORKSPACE || env.AGENT_WORKSPACE,
    dbPath: env.AGENT_DB_PATH,
    logDir: env.AGENT_LOG_DIR,
    model: env.AGENT_MODEL,
    maxTokens: env.AGENT_MAX_TOKENS,
    maxRetries: env.AGENT_MAX_RETRIES,
    apiSecret: env.AGENT_API_SECRET,
    maxContextMessages: env.AGENT_MAX_CONTEXT_MESSAGES,
    tokenBudget: env.AGENT_TOKEN_BUDGET,
    tokenBudgetTier1: env.AGENT_TOKEN_BUDGET_TIER1,
    tokenBudgetTier2: env.AGENT_TOKEN_BUDGET_TIER2,
    tokenBudgetTier3: env.AGENT_TOKEN_BUDGET_TIER3,
    maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    maxConcurrentSessions: env.AGENT_MAX_CONCURRENT_SESSIONS,
    corsOrigin: env.AGENT_CORS_ORIGIN,
    maxPromptChars: env.AGENT_MAX_PROMPT_CHARS,
    trustProxy: parseTrustProxy(env.AGENT_TRUST_PROXY),
    maxSearchResults: env.AGENT_MAX_SEARCH_RESULTS,
    wsRateLimit: env.AGENT_WS_RATE_LIMIT,
    shutdownTimeout: env.AGENT_SHUTDOWN_TIMEOUT,
    webhookUrl: env.AGENT_WEBHOOK_URL || undefined,
    maxToolResultSize: env.AGENT_MAX_TOOL_RESULT_SIZE,
    metricsEnabled: env.AGENT_METRICS_ENABLED,
    sessionTtl: env.AGENT_SESSION_TTL,
    sessionCleanupInterval: env.AGENT_SESSION_CLEANUP_INTERVAL,
    requirePatchApproval: env.AGENT_REQUIRE_PATCH_APPROVAL,
    apiRetryCount: env.AGENT_API_RETRY_COUNT,
    apiRetryDelay: env.AGENT_API_RETRY_DELAY,
    apiRetryMaxDelay: env.AGENT_API_RETRY_MAX_DELAY,
    maxToolOutputContext: env.AGENT_MAX_TOOL_OUTPUT_CONTEXT,
    debugMode: env.AGENT_DEBUG_MODE,
    netlifyToken: env.NETLIFY_AUTH_TOKEN,
    netlifySiteId: env.NETLIFY_SITE_ID,
    vercelToken: env.VERCEL_TOKEN,
    dockerEnabled: env.DOCKER_ENABLED,
    port: env.PORT,
  };
}
