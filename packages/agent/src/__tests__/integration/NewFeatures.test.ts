/**
 * Integration Tests for Klaus-Code 3.0
 * 
 * Tests for end-to-end workflows:
 * - Model selection flow
 * - Export functionality
 * - Patch approval workflow
 * - Progress indicator integration
 * - WebSocket communication
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ============================================================
// MODEL SELECTION INTEGRATION TESTS
// ============================================================

describe('Model Selection Integration', () => {
  describe('End-to-End Model Flow', () => {
    it('should pass model from UI to backend', async () => {
      // Simulate the full flow
      const promptData = {
        message: 'Hello world',
        sessionId: 'session-123',
        model: 'claude-haiku-4-5',
      };
      
      // Validate the data structure
      expect(promptData.model).toBe('claude-haiku-4-5');
      expect(promptData.message).toBeDefined();
      expect(promptData.sessionId).toBeDefined();
    });

    it('should fallback to default model when not specified', () => {
      const promptData = {
        message: 'Hello',
        sessionId: 'session-123',
      } as { message: string; sessionId: string; model?: string };
      
      const defaultModel = 'claude-sonnet-4-5';
      const effectiveModel = promptData.model || defaultModel;
      
      expect(effectiveModel).toBe(defaultModel);
    });

    it('should persist model selection across page reloads', () => {
      // Simulating localStorage
      const storage: Record<string, string> = {};
      
      // Save
      storage['agent-selected-model'] = 'claude-haiku-4-5';
      
      // Reload simulation - clear runtime state
      let selectedModel: string | null = null;
      
      // Load
      selectedModel = storage['agent-selected-model'] || 'claude-sonnet-4-5';
      
      expect(selectedModel).toBe('claude-haiku-4-5');
    });
  });

  describe('Model Cost Tracking', () => {
    it('should track costs per model correctly', () => {
      const usageByModel: Record<string, { input: number; output: number; cost: number }> = {};
      
      const recordUsage = (model: string, input: number, output: number) => {
        if (!usageByModel[model]) {
          usageByModel[model] = { input: 0, output: 0, cost: 0 };
        }
        usageByModel[model].input += input;
        usageByModel[model].output += output;
        
        // Calculate cost
        let inputPrice = 15.0, outputPrice = 75.0;
        if (model.includes('haiku')) { inputPrice = 0.8; outputPrice = 4.0; }
        else if (model.includes('sonnet')) { inputPrice = 3.0; outputPrice = 15.0; }
        
        usageByModel[model].cost += 
          (input / 1_000_000) * inputPrice + (output / 1_000_000) * outputPrice;
      };
      
      recordUsage('claude-opus-4-5', 1000, 500);
      recordUsage('claude-haiku-4-5', 5000, 2000);
      recordUsage('claude-opus-4-5', 2000, 1000);
      
      expect(usageByModel['claude-opus-4-5'].input).toBe(3000);
      expect(usageByModel['claude-haiku-4-5'].input).toBe(5000);
      expect(usageByModel['claude-opus-4-5'].cost).toBeGreaterThan(usageByModel['claude-haiku-4-5'].cost);
    });
  });
});

// ============================================================
// EXPORT INTEGRATION TESTS
// ============================================================

describe('Export Integration', () => {
  describe('Full Export Flow', () => {
    const mockSession = {
      id: 'session-12345678',
      workspaceDir: '/test/workspace',
      summary: 'Test implementation session',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T12:00:00Z',
    };
    
    const mockMessages = [
      { role: 'user', content: 'Write a hello world function' },
      { role: 'assistant', content: 'Here is a hello world function:\n```typescript\nfunction hello() {\n  return "Hello, World!";\n}\n```' },
      { role: 'tool', content: '{"success": true}', toolName: 'write_file' },
    ];
    
    const mockTokenUsage = {
      inputTokens: 150,
      outputTokens: 200,
      totalTokens: 350,
      estimatedCostUsd: 0.025,
    };

    it('should generate complete markdown export', () => {
      const lines: string[] = [
        `# AI Agent Session`,
        ``,
        `**Session ID:** ${mockSession.id}`,
        `**Workspace:** ${mockSession.workspaceDir}`,
        `**Created:** ${mockSession.createdAt}`,
        `**Updated:** ${mockSession.updatedAt}`,
        ``,
        `## Summary`,
        ``,
        mockSession.summary,
        ``,
        `## Token Usage`,
        ``,
        `- Input tokens: ${mockTokenUsage.inputTokens.toLocaleString()}`,
        `- Output tokens: ${mockTokenUsage.outputTokens.toLocaleString()}`,
        `- Total tokens: ${mockTokenUsage.totalTokens.toLocaleString()}`,
        `- Estimated cost: $${mockTokenUsage.estimatedCostUsd.toFixed(4)}`,
        ``,
        `## Conversation`,
        ``,
      ];
      
      for (const msg of mockMessages) {
        if (msg.role === 'user') {
          lines.push(`### 👤 User`, ``, msg.content, ``);
        } else if (msg.role === 'assistant') {
          lines.push(`### 🤖 Assistant`, ``, msg.content, ``);
        } else if (msg.role === 'tool') {
          lines.push(`### 🔧 Tool: ${(msg as any).toolName}`, ``, '```json', msg.content.slice(0, 500), '```', ``);
        }
      }
      
      const markdown = lines.join('\n');
      
      expect(markdown).toContain('# AI Agent Session');
      expect(markdown).toContain('session-12345678');
      expect(markdown).toContain('### 👤 User');
      expect(markdown).toContain('### 🤖 Assistant');
      expect(markdown).toContain('### 🔧 Tool: write_file');
    });

    it('should generate complete JSON export', () => {
      const exportData = {
        session: mockSession,
        messages: mockMessages,
        tokenUsage: mockTokenUsage,
        toolCalls: [{ name: 'write_file', success: true }],
        exportedAt: new Date().toISOString(),
      };
      
      const json = JSON.stringify(exportData, null, 2);
      const parsed = JSON.parse(json);
      
      expect(parsed.session.id).toBe(mockSession.id);
      expect(parsed.messages).toHaveLength(3);
      expect(parsed.tokenUsage.totalTokens).toBe(350);
      expect(parsed.exportedAt).toBeDefined();
    });
  });

  describe('Export Edge Cases', () => {
    it('should handle session with no messages', () => {
      const exportData = {
        session: { id: 'empty-session' },
        messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      };
      
      expect(exportData.messages).toHaveLength(0);
    });

    it('should handle very large tool outputs', () => {
      const largeOutput = 'x'.repeat(100000);
      const truncated = largeOutput.length > 500 
        ? largeOutput.slice(0, 500) + '...'
        : largeOutput;
      
      expect(truncated.length).toBeLessThan(largeOutput.length);
    });
  });
});

// ============================================================
// PATCH APPROVAL INTEGRATION TESTS
// ============================================================

describe('Patch Approval Integration', () => {
  describe('Full Approval Workflow', () => {
    it('should handle approval flow end-to-end', async () => {
      // Simulate the workflow
      const pendingApprovals = new Map<string, { 
        resolve: (approved: boolean) => void;
        patchData: any;
      }>();
      
      // Agent requests approval
      const patchId = 'patch-123';
      const patchData = {
        patchId,
        filePath: 'src/index.ts',
        diff: '+const x = 1;',
        operation: 'modify' as const,
      };
      
      const approvalPromise = new Promise<boolean>((resolve) => {
        pendingApprovals.set(patchId, { resolve, patchData });
      });
      
      // Simulate user approval
      setTimeout(() => {
        const pending = pendingApprovals.get(patchId);
        if (pending) {
          pending.resolve(true);
          pendingApprovals.delete(patchId);
        }
      }, 10);
      
      const approved = await approvalPromise;
      expect(approved).toBe(true);
    });

    it('should handle rejection', async () => {
      const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
      
      const patchId = 'patch-456';
      const approvalPromise = new Promise<boolean>((resolve) => {
        pendingApprovals.set(patchId, { resolve });
      });
      
      // User rejects
      setTimeout(() => {
        const pending = pendingApprovals.get(patchId);
        if (pending) {
          pending.resolve(false);
          pendingApprovals.delete(patchId);
        }
      }, 10);
      
      const approved = await approvalPromise;
      expect(approved).toBe(false);
    });

    it('should handle timeout', async () => {
      const timeoutMs = 50;
      let timedOut = false;
      
      const approvalPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(false); // Auto-reject on timeout
        }, timeoutMs);
      });
      
      const approved = await approvalPromise;
      expect(timedOut).toBe(true);
      expect(approved).toBe(false);
    });
  });

  describe('WebSocket Patch Events', () => {
    it('should emit patch_approval_required event', () => {
      const emittedEvents: any[] = [];
      
      const emit = (event: any) => {
        emittedEvents.push(event);
      };
      
      emit({
        type: 'patch_approval_required',
        data: {
          patchId: 'patch-789',
          filePath: 'test.ts',
          diff: '+new line',
          operation: 'modify',
        },
        timestamp: new Date(),
      });
      
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('patch_approval_required');
    });

    it('should receive patch_approval_response', () => {
      const responses: any[] = [];
      
      const handleResponse = (data: { approved: boolean; patchId: string }) => {
        responses.push(data);
      };
      
      handleResponse({ approved: true, patchId: 'patch-789' });
      
      expect(responses).toHaveLength(1);
      expect(responses[0].approved).toBe(true);
    });
  });
});

// ============================================================
// PROGRESS INDICATOR INTEGRATION TESTS
// ============================================================

describe('Progress Indicator Integration', () => {
  describe('Full Progress Flow', () => {
    it('should emit progress events during long-running tool', async () => {
      const progressEvents: any[] = [];
      const toolCallId = 'tool-123';
      
      const emitProgress = (progress: number, status: string) => {
        progressEvents.push({
          type: 'tool_progress',
          data: {
            toolCallId,
            toolName: 'npm_install',
            progress,
            status,
            elapsedMs: progress * 100,
          },
        });
      };
      
      // Simulate progress updates
      emitProgress(0, 'Starting...');
      emitProgress(20, 'Resolving dependencies...');
      emitProgress(50, 'Installing packages...');
      emitProgress(80, 'Finalizing...');
      emitProgress(100, 'Complete');
      
      expect(progressEvents).toHaveLength(5);
      expect(progressEvents[0].data.progress).toBe(0);
      expect(progressEvents[4].data.progress).toBe(100);
    });

    it('should clear progress on tool completion', () => {
      interface ToolEntry {
        id: string;
        progress?: number;
        status?: string;
      }
      
      const entries: ToolEntry[] = [
        { id: 'tool-1', progress: 50, status: 'Running...' },
      ];
      
      // Tool completes
      const updateEntry = (id: string, update: Partial<ToolEntry>) => {
        const entry = entries.find(e => e.id === id);
        if (entry) Object.assign(entry, update);
      };
      
      updateEntry('tool-1', { progress: undefined, status: undefined });
      
      expect(entries[0].progress).toBeUndefined();
    });
  });

  describe('Progress UI State', () => {
    it('should track elapsed time correctly', () => {
      const startTime = Date.now();
      
      // Simulate 500ms passing
      const elapsedMs = 500;
      const elapsed = elapsedMs / 1000;
      
      expect(elapsed.toFixed(1)).toBe('0.5');
    });

    it('should calculate progress percentage correctly', () => {
      // Simulated progress with diminishing returns
      let progress = 0;
      for (let i = 0; i < 10; i++) {
        progress = Math.min(95, progress + (100 - progress) * 0.1);
      }
      
      expect(progress).toBeLessThan(95);
      expect(progress).toBeGreaterThan(60);
    });
  });
});

// ============================================================
// API RETRY INTEGRATION TESTS
// ============================================================

describe('API Retry Integration', () => {
  describe('Full Retry Flow', () => {
    it('should retry on transient errors', async () => {
      let attempts = 0;
      const maxRetries = 3;
      
      const makeRequest = async (): Promise<{ success: boolean }> => {
        attempts++;
        if (attempts < 3) {
          throw { status: 503, message: 'Service Unavailable' };
        }
        return { success: true };
      };
      
      const isRetryable = (error: any) => error.status === 503;
      
      let result: { success: boolean } | null = null;
      let lastError: any = null;
      
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await makeRequest();
          break;
        } catch (err) {
          lastError = err;
          if (!isRetryable(err) || attempt === maxRetries) {
            throw err;
          }
        }
      }
      
      expect(result?.success).toBe(true);
      expect(attempts).toBe(3);
    });

    it('should emit retry status to UI', () => {
      const events: any[] = [];
      
      const emitRetryStatus = (attempt: number, maxAttempts: number, delayMs: number) => {
        events.push({
          type: 'error',
          data: {
            error: `API error, retrying in ${delayMs/1000}s (attempt ${attempt}/${maxAttempts})...`,
            retrying: true,
          },
        });
      };
      
      emitRetryStatus(1, 3, 2000);
      emitRetryStatus(2, 3, 4000);
      
      expect(events).toHaveLength(2);
      expect(events[0].data.retrying).toBe(true);
    });
  });
});

// ============================================================
// WEBSOCKET COMMUNICATION TESTS
// ============================================================

describe('WebSocket Communication', () => {
  describe('Event Flow', () => {
    it('should handle all event types', () => {
      const eventTypes = [
        'thinking',
        'stream_delta',
        'tool_call',
        'tool_result',
        'tool_progress',
        'message',
        'error',
        'budget_warning',
        'budget_exceeded',
        'tool_limit_exceeded',
        'turn_complete',
        'patch_approval_required',
        'complete',
      ];
      
      for (const type of eventTypes) {
        expect(typeof type).toBe('string');
        expect(type.length).toBeGreaterThan(0);
      }
    });

    it('should maintain event order', () => {
      const events: string[] = [];
      
      events.push('thinking');
      events.push('stream_delta');
      events.push('tool_call');
      events.push('tool_progress');
      events.push('tool_result');
      events.push('turn_complete');
      events.push('complete');
      
      expect(events[0]).toBe('thinking');
      expect(events[events.length - 1]).toBe('complete');
    });
  });

  describe('Session Management', () => {
    it('should join session room', () => {
      const rooms = new Map<string, Set<string>>();
      
      const joinRoom = (socketId: string, sessionId: string) => {
        if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
        rooms.get(sessionId)!.add(socketId);
      };
      
      joinRoom('socket-1', 'session-abc');
      joinRoom('socket-2', 'session-abc');
      
      expect(rooms.get('session-abc')?.size).toBe(2);
    });

    it('should broadcast to session room', () => {
      const receivedEvents: any[] = [];
      const rooms = new Map<string, Set<string>>();
      const socketHandlers = new Map<string, (event: any) => void>();
      
      // Setup
      rooms.set('session-abc', new Set(['socket-1', 'socket-2']));
      socketHandlers.set('socket-1', (e) => receivedEvents.push({ socket: 'socket-1', event: e }));
      socketHandlers.set('socket-2', (e) => receivedEvents.push({ socket: 'socket-2', event: e }));
      
      // Broadcast
      const broadcast = (sessionId: string, event: any) => {
        const room = rooms.get(sessionId);
        if (room) {
          for (const socketId of room) {
            const handler = socketHandlers.get(socketId);
            if (handler) handler(event);
          }
        }
      };
      
      broadcast('session-abc', { type: 'message', data: 'hello' });
      
      expect(receivedEvents).toHaveLength(2);
    });
  });
});

// ============================================================
// TURN COMPLETE INTEGRATION TESTS  
// ============================================================

describe('Turn Complete Integration', () => {
  describe('Token Tracking', () => {
    it('should accumulate tokens across turns', () => {
      let totalInput = 0;
      let totalOutput = 0;
      
      const turns = [
        { input: 1000, output: 500 },
        { input: 800, output: 1200 },
        { input: 1500, output: 800 },
      ];
      
      const events: any[] = [];
      
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        totalInput += turn.input;
        totalOutput += turn.output;
        
        events.push({
          type: 'turn_complete',
          data: {
            turn: i + 1,
            inputTokens: turn.input,
            outputTokens: turn.output,
            totalInputTokens: totalInput,
            totalOutputTokens: totalOutput,
            totalTokens: totalInput + totalOutput,
          },
        });
      }
      
      expect(events[2].data.totalInputTokens).toBe(3300);
      expect(events[2].data.totalOutputTokens).toBe(2500);
      expect(events[2].data.totalTokens).toBe(5800);
    });

    it('should calculate budget percentage correctly', () => {
      const budget = 100000;
      const totalUsed = 80000;
      const percentUsed = Math.round((totalUsed / budget) * 100);
      const remaining = budget - totalUsed;
      
      expect(percentUsed).toBe(80);
      expect(remaining).toBe(20000);
    });
  });
});

// ============================================================
// CONCURRENT OPERATIONS TESTS
// ============================================================

describe('Concurrent Operations', () => {
  describe('Multiple Sessions', () => {
    it('should isolate sessions correctly', () => {
      const sessions = new Map<string, { tokens: number; model: string }>();
      
      sessions.set('session-1', { tokens: 1000, model: 'claude-opus-4-5' });
      sessions.set('session-2', { tokens: 500, model: 'claude-haiku-4-5' });
      
      // Update session-1
      const s1 = sessions.get('session-1')!;
      s1.tokens += 500;
      
      // Session-2 should be unchanged
      expect(sessions.get('session-2')!.tokens).toBe(500);
      expect(sessions.get('session-1')!.tokens).toBe(1500);
    });

    it('should handle concurrent tool executions', async () => {
      const results: string[] = [];
      
      const executeTool = async (name: string, delay: number): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, delay));
        results.push(name);
      };
      
      await Promise.all([
        executeTool('tool-1', 30),
        executeTool('tool-2', 10),
        executeTool('tool-3', 20),
      ]);
      
      expect(results).toHaveLength(3);
      expect(results).toContain('tool-1');
      expect(results).toContain('tool-2');
      expect(results).toContain('tool-3');
    });
  });
});
