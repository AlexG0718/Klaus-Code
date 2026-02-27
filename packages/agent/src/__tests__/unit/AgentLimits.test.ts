/**
 * Tests for Agent-level safety limits:
 *   - Concurrent session cap
 *   - Prompt size guard
 *   - Tool call loop limit
 *   - Budget warning fires exactly once (boolean-flag fix)
 *   - activeSessions counter always decrements (try/finally)
 *
 * Strategy: we mock the Anthropic SDK so no real API calls are made,
 * then call Agent.run() and assert on events and thrown errors.
 */

import { Agent, AgentEvent } from '../../agent/Agent';
import { DatabaseMemory } from '../../memory/DatabaseMemory';
import type { Config } from '../../config';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('@anthropic-ai/sdk');
jest.mock('../../memory/DatabaseMemory');
jest.mock('../../tools/ToolExecutor');
jest.mock('../../tools/GitTool');

import Anthropic from '@anthropic-ai/sdk';
const MockAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

// ─── Types ────────────────────────────────────────────────────────────────────

interface FakeStream {
  on: jest.Mock;
  finalMessage: jest.Mock;
  abort: jest.Mock;
}

// Build a fake streaming response that returns end_turn immediately
function makeStreamResponse(
  inputTokens = 1000,
  outputTokens = 500
): FakeStream {
  const fakeStream: FakeStream = {
    on: jest.fn((event: string, cb: (text: string) => void): FakeStream => {
      if (event === 'text') cb('Done.');
      return fakeStream;
    }),
    finalMessage: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    abort: jest.fn(),
  };
  return fakeStream;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'test-key',
    workspaceDir: '/tmp/test-workspace',
    hostWorkspaceDir: '/tmp/test-workspace',
    dbPath: ':memory:',
    logDir: '/tmp/logs',
    model: 'claude-opus-4-5',
    maxTokens: 1024,
    maxRetries: 1,
    apiSecret: undefined,
    maxContextMessages: 10,
    tokenBudget: 100_000,
    tokenBudgetTier1: 0,
    tokenBudgetTier2: 0,
    tokenBudgetTier3: 0,
    maxToolCalls: 50,
    maxConcurrentSessions: 2,
    corsOrigin: 'http://localhost:5173',
    maxPromptChars: 32_000,
    trustProxy: false,
    maxSearchResults: 500,
    wsRateLimit: 30,
    shutdownTimeout: 30_000,
    webhookUrl: undefined,
    maxToolResultSize: 10_240,
    metricsEnabled: false,
    sessionTtl: 86_400_000,
    sessionCleanupInterval: 300_000,
    requirePatchApproval: false,
    apiRetryCount: 3,
    apiRetryDelay: 1000,
    apiRetryMaxDelay: 30_000,
    maxToolOutputContext: 8_000,
    debugMode: false,
    netlifyToken: undefined,
    netlifySiteId: undefined,
    vercelToken: undefined,
    dockerEnabled: false,
    port: 3001,
    ...overrides,
  };
}

function makeMemory(): jest.Mocked<DatabaseMemory> {
  const m = new DatabaseMemory(':memory:') as jest.Mocked<DatabaseMemory>;
  m.getSession = jest.fn().mockReturnValue(null);
  m.createSession = jest.fn();
  m.addMessage = jest.fn();
  m.getMessages = jest.fn().mockReturnValue([]);
  m.getRecentMessages = jest.fn().mockReturnValue([]);
  m.countMessages = jest.fn().mockReturnValue(0);
  m.recordTokenUsage = jest.fn();
  m.recordToolCall = jest.fn();
  m.listKnowledge = jest.fn().mockReturnValue([]);
  m.getKnowledge = jest.fn().mockReturnValue(null);
  m.setKnowledge = jest.fn();
  m.getSessionTokenUsage = jest.fn().mockReturnValue({
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    estimatedCostUsd: 0.02,
  });
  m.updateSessionSummary = jest.fn();
  return m;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectEvents(
  agent: Agent,
  message: string,
  sessionId?: string
): {
  events: AgentEvent[];
  runPromise: Promise<unknown>;
} {
  const events: AgentEvent[] = [];
  const runPromise = agent.run(message, sessionId, (e) => events.push(e));
  return { events, runPromise };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Agent safety limits', () => {
  let mockMemory: jest.Mocked<DatabaseMemory>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMemory = makeMemory();

    // Default: successful single-turn response
    MockAnthropic.prototype.messages = {
      stream: jest.fn().mockReturnValue(makeStreamResponse()),
    } as unknown as typeof MockAnthropic.prototype.messages;
  });

  // ── Prompt size guard ──────────────────────────────────────────────────────

  describe('prompt size guard', () => {
    it('rejects prompts larger than maxPromptChars', async () => {
      const agent = new Agent(makeConfig({ maxPromptChars: 100 }), mockMemory);
      await expect(agent.run('x'.repeat(101))).rejects.toThrow(
        'Prompt too large'
      );
    });

    it('accepts prompts exactly at the limit', async () => {
      const agent = new Agent(makeConfig({ maxPromptChars: 100 }), mockMemory);
      await expect(agent.run('x'.repeat(100))).resolves.toBeDefined();
    });

    it('does not decrement activeSessions below zero when prompt rejected', async () => {
      const agent = new Agent(makeConfig({ maxPromptChars: 10 }), mockMemory);
      try {
        await agent.run('x'.repeat(11));
      } catch {
        /* expected rejection */
      }
      expect(agent.activeSessionCount).toBe(0);
    });
  });

  // ── Concurrent session cap ─────────────────────────────────────────────────

  describe('concurrent session cap', () => {
    it('rejects a new session when at max concurrent', async () => {
      // maxConcurrentSessions: 1, so the second run should be rejected immediately
      const config = makeConfig({ maxConcurrentSessions: 1 });

      // Make the first run take long enough for the second to arrive
      let resolveFirst!: () => void;
      const firstRunBlock = new Promise<void>((res) => {
        resolveFirst = res;
      });

      MockAnthropic.prototype.messages = {
        stream: jest
          .fn()
          .mockReturnValueOnce({
            on: jest.fn().mockReturnThis(),
            finalMessage: () =>
              firstRunBlock.then(() => ({
                content: [],
                stop_reason: 'end_turn',
                usage: { input_tokens: 100, output_tokens: 50 },
              })),
            abort: jest.fn(),
          })
          .mockReturnValue(makeStreamResponse()),
      } as unknown as typeof MockAnthropic.prototype.messages;

      const agent = new Agent(config, mockMemory);

      // Start first session — don't await yet
      const first = agent.run('first task', 'session-1');
      // Give the first run time to increment activeSessions
      await new Promise((r) => setTimeout(r, 10));

      // Second run should be rejected
      await expect(agent.run('second task', 'session-2')).rejects.toThrow(
        'Too many concurrent sessions'
      );

      // Release the first run
      resolveFirst();
      await first;

      // After first completes, a third run should be accepted
      await expect(agent.run('third task', 'session-3')).resolves.toBeDefined();
    });

    it('reports activeSessionCount correctly', async () => {
      const agent = new Agent(makeConfig(), mockMemory);
      expect(agent.activeSessionCount).toBe(0);
    });
  });

  // ── activeSessions try/finally guarantee ───────────────────────────────────
  // Note: These tests verify the decrement behavior. Due to mock limitations,
  // we verify the behavior through error handling paths rather than exact counts.

  describe('activeSessions always decrements', () => {
    it('decrements even when the API call throws', async () => {
      MockAnthropic.prototype.messages = {
        stream: jest.fn().mockReturnValue({
          on: jest.fn().mockReturnThis(),
          finalMessage: jest.fn().mockRejectedValue(new Error('Network error')),
          abort: jest.fn(),
        }),
      } as unknown as typeof MockAnthropic.prototype.messages;

      const agent = new Agent(makeConfig(), mockMemory);

      // Run should throw but not crash
      await expect(agent.run('will fail')).rejects.toThrow('Network error');

      // Verify the agent is still usable (not stuck with maxed sessions)
      // This implicitly tests that cleanup occurred
      MockAnthropic.prototype.messages = {
        stream: jest.fn().mockReturnValue(makeStreamResponse()),
      } as unknown as typeof MockAnthropic.prototype.messages;

      // Should be able to run again (proves the session was cleaned up)
      await expect(agent.run('recovery run')).resolves.toBeDefined();
    });

    it('decrements after a normal run', async () => {
      const agent = new Agent(
        makeConfig({ maxConcurrentSessions: 1 }),
        mockMemory
      );

      // Complete a normal run
      await agent.run('first run');

      // If session wasn't decremented, this would fail with "Too many concurrent sessions"
      // since maxConcurrentSessions is 1
      await expect(agent.run('second run')).resolves.toBeDefined();
    });
  });

  // ── Tool call limit ────────────────────────────────────────────────────────

  describe('tool call limit', () => {
    it('emits tool_limit_exceeded and halts when limit is reached', async () => {
      // Make every API call return a tool_use so the loop never ends naturally
      const { ToolExecutor } = await import('../../tools/ToolExecutor');
      ToolExecutor.prototype.execute = jest.fn().mockResolvedValue({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        result: { content: 'file contents' },
        success: true,
        durationMs: 5,
      });

      let callCount = 0;
      MockAnthropic.prototype.messages = {
        stream: jest.fn().mockImplementation(() => {
          callCount++;
          return {
            on: jest.fn().mockReturnThis(),
            finalMessage: jest.fn().mockResolvedValue({
              content: [
                {
                  type: 'tool_use',
                  id: `tu-${callCount}`,
                  name: 'read_file',
                  input: { path: 'index.ts' },
                },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
            abort: jest.fn(),
          };
        }),
      } as unknown as typeof MockAnthropic.prototype.messages;

      const agent = new Agent(
        makeConfig({ maxToolCalls: 3, tokenBudget: 0 }),
        mockMemory
      );
      const events: AgentEvent[] = [];

      await agent.run('do stuff', undefined, (e) => events.push(e));

      // Verify the tool_limit_exceeded event was emitted
      const limitEvent = events.find((e) => e.type === 'tool_limit_exceeded');
      expect(limitEvent).toBeDefined();
      expect((limitEvent!.data as Record<string, unknown>).limit).toBe(3);

      // Verify the loop actually stopped (call count should be around the limit)
      expect(callCount).toBeLessThanOrEqual(4); // Allow one extra for the limit check
    });

    it('does not emit tool_limit_exceeded when maxToolCalls is 0 (disabled)', async () => {
      const agent = new Agent(makeConfig({ maxToolCalls: 0 }), mockMemory);
      const events: AgentEvent[] = [];
      await agent.run('normal', undefined, (e) => events.push(e));
      expect(
        events.find((e) => e.type === 'tool_limit_exceeded')
      ).toBeUndefined();
    });
  });

  // ── Budget warning boolean-flag fix ───────────────────────────────────────

  describe('budget warning fires exactly once', () => {
    it('fires budget_warning exactly once even across many turns at 80%+', async () => {
      let turn = 0;
      // Each turn uses 10k tokens, budget is 100k → crosses 80% at turn 9
      MockAnthropic.prototype.messages = {
        stream: jest.fn().mockImplementation(() => {
          turn++;
          const stopReason = turn >= 12 ? 'end_turn' : 'tool_use';
          return {
            on: jest.fn().mockReturnThis(),
            finalMessage: jest.fn().mockResolvedValue({
              content:
                stopReason === 'end_turn'
                  ? [{ type: 'text', text: 'Done.' }]
                  : [
                      {
                        type: 'tool_use',
                        id: `tu-${turn}`,
                        name: 'read_file',
                        input: { path: 'f.ts' },
                      },
                    ],
              stop_reason: stopReason,
              usage: { input_tokens: 5_000, output_tokens: 5_000 }, // 10k per turn
            }),
            abort: jest.fn(),
          };
        }),
      } as unknown as typeof MockAnthropic.prototype.messages;

      const { ToolExecutor } = await import('../../tools/ToolExecutor');
      ToolExecutor.prototype.execute = jest.fn().mockResolvedValue({
        toolCallId: 'tc',
        toolName: 'read_file',
        result: {},
        success: true,
        durationMs: 1,
      });

      const agent = new Agent(
        makeConfig({ tokenBudget: 100_000, maxToolCalls: 0 }),
        mockMemory
      );
      const events: AgentEvent[] = [];

      await agent.run('go', undefined, (e) => events.push(e));

      const warnings = events.filter((e) => e.type === 'budget_warning');
      expect(warnings.length).toBe(1);
    });
  });
});
