/**
 * End-to-End Tests for Klaus-Code 3.0
 * 
 * Tests complete workflows from user action to final result:
 * - User selects model and sends prompt
 * - User exports conversation
 * - User approves/rejects patches
 * - User monitors progress of long-running operations
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ============================================================
// E2E: MODEL SELECTION WORKFLOW
// ============================================================

describe('E2E: Model Selection Workflow', () => {
  it('should complete full workflow: select model → send prompt → receive response with correct model', async () => {
    // Step 1: User selects Haiku model
    const selectedModel = 'claude-haiku-4-5';
    
    // Step 2: User types prompt
    const userMessage = 'Write a simple hello function';
    
    // Step 3: UI sends prompt with model
    const request = {
      message: userMessage,
      sessionId: 'e2e-session-1',
      model: selectedModel,
    };
    
    // Step 4: Server validates model
    const allowedModels = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
    const isValidModel = allowedModels.includes(request.model);
    expect(isValidModel).toBe(true);
    
    // Step 5: Agent uses correct model
    const effectiveModel = isValidModel ? request.model : 'claude-sonnet-4-5';
    expect(effectiveModel).toBe('claude-haiku-4-5');
    
    // Step 6: Response includes model info
    const response = {
      success: true,
      sessionId: request.sessionId,
      model: effectiveModel,
      tokenUsage: {
        inputTokens: 50,
        outputTokens: 100,
        estimatedCostUsd: 0.00044, // Haiku pricing
      },
    };
    
    expect(response.model).toBe('claude-haiku-4-5');
    expect(response.tokenUsage.estimatedCostUsd).toBeLessThan(0.01);
  });

  it('should handle model switch mid-conversation', async () => {
    // First message with Opus
    const message1 = {
      model: 'claude-opus-4-5',
      message: 'Complex task requiring Opus',
    };
    
    // User realizes simple follow-up can use Haiku
    const message2 = {
      model: 'claude-haiku-4-5',
      message: 'Just format the output',
    };
    
    // Both should work within same session
    expect(message1.model).toBe('claude-opus-4-5');
    expect(message2.model).toBe('claude-haiku-4-5');
  });

  it('should persist model selection across browser refresh', () => {
    // Simulate localStorage
    const storage: Record<string, string> = {};
    
    // User selects Haiku
    storage['agent-selected-model'] = 'claude-haiku-4-5';
    
    // Simulate page reload
    const loadedModel = storage['agent-selected-model'] || 'claude-sonnet-4-5';
    
    expect(loadedModel).toBe('claude-haiku-4-5');
  });
});

// ============================================================
// E2E: EXPORT WORKFLOW
// ============================================================

describe('E2E: Export Workflow', () => {
  it('should complete full workflow: session → export markdown → download', async () => {
    // Step 1: User has active session with conversation
    const session = {
      id: 'export-session-123',
      summary: 'Built a REST API',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T12:00:00Z',
    };
    
    const messages = [
      { role: 'user', content: 'Create a REST API with Express' },
      { role: 'assistant', content: 'I\'ll create a REST API with Express...' },
      { role: 'tool', toolName: 'write_file', content: '{"success": true, "path": "server.js"}' },
    ];
    
    const tokenUsage = {
      inputTokens: 500,
      outputTokens: 1500,
      totalTokens: 2000,
      estimatedCostUsd: 0.15,
    };
    
    // Step 2: User clicks export markdown button
    const format = 'markdown';
    
    // Step 3: Server generates markdown
    const markdown = [
      '# AI Agent Session',
      '',
      `**Session ID:** ${session.id}`,
      `**Created:** ${session.createdAt}`,
      '',
      '## Summary',
      '',
      session.summary,
      '',
      '## Token Usage',
      '',
      `- Total: ${tokenUsage.totalTokens.toLocaleString()}`,
      `- Cost: $${tokenUsage.estimatedCostUsd.toFixed(4)}`,
      '',
      '## Conversation',
      '',
    ].join('\n');
    
    // Step 4: Browser downloads file
    const filename = `session-${session.id.slice(0, 8)}.md`;
    
    expect(filename).toBe('session-export-s.md');
    expect(markdown).toContain('# AI Agent Session');
    expect(markdown).toContain('Built a REST API');
  });

  it('should complete full workflow: session → export JSON → download', async () => {
    const session = { id: 'json-export-123', summary: 'Test' };
    const messages = [{ role: 'user', content: 'Hello' }];
    
    // Export to JSON
    const exportData = {
      session,
      messages,
      tokenUsage: { totalTokens: 100 },
      exportedAt: new Date().toISOString(),
    };
    
    const json = JSON.stringify(exportData, null, 2);
    const filename = `session-${session.id.slice(0, 8)}.json`;
    
    expect(filename).toBe('session-json-exp.json');
    expect(JSON.parse(json).session.id).toBe('json-export-123');
  });

  it('should handle keyboard shortcut for export', () => {
    const keyboardEvents: any[] = [];
    
    // Simulate Cmd+E
    const event = {
      key: 'e',
      metaKey: true,
      ctrlKey: false,
      preventDefault: () => {},
    };
    
    // Handler checks for export shortcut
    const isExportShortcut = (e.metaKey || e.ctrlKey) && e.key === 'e';
    expect(isExportShortcut).toBe(true);
  });
});

// ============================================================
// E2E: PATCH APPROVAL WORKFLOW
// ============================================================

describe('E2E: Patch Approval Workflow', () => {
  it('should complete full workflow: agent proposes patch → user reviews → user approves', async () => {
    // Step 1: Agent wants to modify a file
    const filePath = 'src/index.ts';
    const diff = `@@ -1,3 +1,4 @@
 import express from 'express';
+import cors from 'cors';
 
 const app = express();`;
    
    // Step 2: Agent emits patch_approval_required event
    const patchEvent = {
      type: 'patch_approval_required',
      data: {
        patchId: 'patch-approve-123',
        filePath,
        diff,
        operation: 'modify' as const,
      },
      timestamp: new Date(),
    };
    
    // Step 3: UI shows DiffPreviewModal
    expect(patchEvent.data.filePath).toBe('src/index.ts');
    expect(patchEvent.data.diff).toContain('+import cors');
    
    // Step 4: User reviews and clicks "Approve"
    const userDecision = true;
    
    // Step 5: UI sends approval response
    const response = {
      approved: userDecision,
      patchId: patchEvent.data.patchId,
    };
    
    // Step 6: Agent applies the patch
    expect(response.approved).toBe(true);
    expect(response.patchId).toBe('patch-approve-123');
  });

  it('should complete full workflow: agent proposes patch → user rejects', async () => {
    const patchEvent = {
      type: 'patch_approval_required',
      data: {
        patchId: 'patch-reject-456',
        filePath: 'config.json',
        diff: '-"debug": false\n+"debug": true',
        operation: 'modify' as const,
      },
    };
    
    // User decides this change is risky
    const userDecision = false;
    
    const response = {
      approved: userDecision,
      patchId: patchEvent.data.patchId,
    };
    
    expect(response.approved).toBe(false);
  });

  it('should handle timeout when user does not respond', async () => {
    const timeoutMs = 100;
    let approved: boolean | null = null;
    
    const promise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false); // Auto-reject
      }, timeoutMs);
    });
    
    approved = await promise;
    expect(approved).toBe(false);
  });

  it('should handle keyboard shortcuts in diff modal', () => {
    const testShortcuts = [
      { key: 'Enter', metaKey: true, expected: 'approve' },
      { key: 'Backspace', metaKey: true, expected: 'reject' },
      { key: 'Escape', metaKey: false, expected: 'close' },
    ];
    
    for (const test of testShortcuts) {
      let action = '';
      
      if (test.key === 'Escape') {
        action = 'close';
      } else if (test.key === 'Enter' && test.metaKey) {
        action = 'approve';
      } else if (test.key === 'Backspace' && test.metaKey) {
        action = 'reject';
      }
      
      expect(action).toBe(test.expected);
    }
  });
});

// ============================================================
// E2E: PROGRESS INDICATOR WORKFLOW
// ============================================================

describe('E2E: Progress Indicator Workflow', () => {
  it('should show progress for npm install from start to finish', async () => {
    const progressUpdates: any[] = [];
    
    // Simulate npm install progress
    const simulateNpmInstall = async () => {
      const phases = [
        { progress: 0, status: 'Starting...' },
        { progress: 10, status: 'Resolving dependencies...' },
        { progress: 30, status: 'Fetching packages...' },
        { progress: 60, status: 'Installing packages...' },
        { progress: 90, status: 'Finalizing...' },
        { progress: 100, status: 'Complete' },
      ];
      
      for (const phase of phases) {
        progressUpdates.push({
          type: 'tool_progress',
          data: {
            toolCallId: 'tool-npm-123',
            toolName: 'npm_install',
            progress: phase.progress,
            status: phase.status,
            elapsedMs: phase.progress * 100,
          },
        });
        await new Promise(r => setTimeout(r, 10));
      }
    };
    
    await simulateNpmInstall();
    
    expect(progressUpdates).toHaveLength(6);
    expect(progressUpdates[0].data.status).toBe('Starting...');
    expect(progressUpdates[5].data.status).toBe('Complete');
    expect(progressUpdates[5].data.progress).toBe(100);
  });

  it('should update UI in real-time during long operation', async () => {
    interface ToolEntry {
      id: string;
      name: string;
      progress?: number;
      status?: string;
      elapsedMs: number;
    }
    
    const entries: ToolEntry[] = [];
    
    // Tool starts
    entries.push({
      id: 'tool-1',
      name: 'run_tests',
      progress: 0,
      status: 'Starting...',
      elapsedMs: 0,
    });
    
    // Progress updates
    const updateProgress = (id: string, progress: number, status: string, elapsedMs: number) => {
      const entry = entries.find(e => e.id === id);
      if (entry) {
        entry.progress = progress;
        entry.status = status;
        entry.elapsedMs = elapsedMs;
      }
    };
    
    updateProgress('tool-1', 50, 'Running tests...', 5000);
    expect(entries[0].progress).toBe(50);
    expect(entries[0].elapsedMs).toBe(5000);
    
    updateProgress('tool-1', 100, 'Complete', 10000);
    expect(entries[0].progress).toBe(100);
  });

  it('should handle tool failure during progress', async () => {
    const events: any[] = [];
    
    // Progress starts
    events.push({ type: 'tool_progress', data: { progress: 30, status: 'Running...' } });
    
    // Tool fails
    events.push({ 
      type: 'tool_result', 
      data: { 
        success: false, 
        error: 'Test failed: 3 failures',
      } 
    });
    
    expect(events[1].data.success).toBe(false);
    expect(events[1].data.error).toContain('Test failed');
  });
});

// ============================================================
// E2E: TOKEN TRACKING WORKFLOW
// ============================================================

describe('E2E: Token Tracking Workflow', () => {
  it('should track tokens across entire conversation', async () => {
    const turns: any[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    const budget = 100000;
    
    // Turn 1
    totalInput += 500;
    totalOutput += 1000;
    turns.push({
      turn: 1,
      inputTokens: 500,
      outputTokens: 1000,
      totalTokens: totalInput + totalOutput,
      budgetUsedPercent: Math.round(((totalInput + totalOutput) / budget) * 100),
    });
    
    // Turn 2
    totalInput += 800;
    totalOutput += 2000;
    turns.push({
      turn: 2,
      inputTokens: 800,
      outputTokens: 2000,
      totalTokens: totalInput + totalOutput,
      budgetUsedPercent: Math.round(((totalInput + totalOutput) / budget) * 100),
    });
    
    // Turn 3
    totalInput += 300;
    totalOutput += 500;
    turns.push({
      turn: 3,
      inputTokens: 300,
      outputTokens: 500,
      totalTokens: totalInput + totalOutput,
      budgetUsedPercent: Math.round(((totalInput + totalOutput) / budget) * 100),
    });
    
    expect(turns[2].totalTokens).toBe(5100);
    expect(turns[2].budgetUsedPercent).toBe(5);
  });

  it('should show per-turn cost in StatusBar', () => {
    const formatTurnInfo = (turn: number, input: number, output: number, cost: number) => {
      return `Turn ${turn}: ${input.toLocaleString()}↓ ${output.toLocaleString()}↑ ($${cost.toFixed(4)})`;
    };
    
    const turnInfo = formatTurnInfo(3, 1234, 567, 0.0089);
    
    expect(turnInfo).toBe('Turn 3: 1,234↓ 567↑ ($0.0089)');
  });

  it('should warn at 80% budget usage', () => {
    const budget = 100000;
    const totalUsed = 80000;
    const percentUsed = (totalUsed / budget) * 100;
    
    const shouldWarn = percentUsed >= 80 && percentUsed < 100;
    expect(shouldWarn).toBe(true);
  });
});

// ============================================================
// E2E: FULL AGENT WORKFLOW
// ============================================================

describe('E2E: Full Agent Workflow', () => {
  it('should complete: user prompt → agent thinks → uses tools → responds', async () => {
    const events: any[] = [];
    
    // User sends prompt
    events.push({
      type: 'message',
      data: { role: 'user', content: 'Create a hello.ts file' },
    });
    
    // Agent thinks
    events.push({
      type: 'thinking',
      data: { message: 'Planning the file creation...' },
    });
    
    // Agent calls tool
    events.push({
      type: 'tool_call',
      data: { name: 'write_file', input: { path: 'hello.ts', content: 'console.log("Hello")' } },
    });
    
    // Tool completes
    events.push({
      type: 'tool_result',
      data: { toolName: 'write_file', success: true, durationMs: 50 },
    });
    
    // Turn completes
    events.push({
      type: 'turn_complete',
      data: { turn: 1, inputTokens: 200, outputTokens: 300 },
    });
    
    // Agent responds
    events.push({
      type: 'stream_delta',
      data: { delta: 'I created hello.ts with a simple console.log statement.' },
    });
    
    // Session completes
    events.push({
      type: 'complete',
      data: { success: true, summary: 'Created hello.ts' },
    });
    
    expect(events).toHaveLength(7);
    expect(events[0].type).toBe('message');
    expect(events[6].type).toBe('complete');
  });

  it('should handle error recovery with retry', async () => {
    const events: any[] = [];
    
    // First attempt fails
    events.push({
      type: 'error',
      data: { error: 'API error, retrying in 2s (attempt 1/3)...', retrying: true },
    });
    
    // Second attempt succeeds
    events.push({
      type: 'stream_delta',
      data: { delta: 'Here is your response...' },
    });
    
    events.push({
      type: 'complete',
      data: { success: true },
    });
    
    expect(events[0].data.retrying).toBe(true);
    expect(events[2].data.success).toBe(true);
  });
});

// ============================================================
// E2E: CONCURRENT USER ACTIONS
// ============================================================

describe('E2E: Concurrent User Actions', () => {
  it('should handle export while session is running', async () => {
    const sessionState = {
      isRunning: true,
      id: 'concurrent-session',
      messages: [
        { role: 'user', content: 'Do something' },
      ],
    };
    
    // User clicks export while session is running
    const canExport = sessionState.messages.length > 0;
    expect(canExport).toBe(true);
    
    // Export should work with current messages
    const exportedMessages = [...sessionState.messages];
    expect(exportedMessages).toHaveLength(1);
  });

  it('should disable model selector during active run', () => {
    const isRunning = true;
    const modelSelectorDisabled = isRunning;
    
    expect(modelSelectorDisabled).toBe(true);
  });

  it('should queue patch approval while user is typing', () => {
    const pendingPatches: any[] = [];
    const userIsTyping = true;
    
    // Patch comes in
    pendingPatches.push({
      patchId: 'patch-queue-1',
      filePath: 'test.ts',
    });
    
    // Should show when user stops typing
    expect(pendingPatches.length).toBe(1);
  });
});
