# Resume Feature Implementation Plan

## UX Design

### Core Concept
After the agent stops (cancel, budget limit, error, tool limit), a **Status Banner** appears
inline in the chat — between the last message and the input area. The user has two clear paths:

1. **Resume** — click the banner's button to continue exactly where the agent left off
2. **Re-prompt** — type a new message in the input box to redirect the agent

### Status Banner Design

The banner is a slim, full-width card that appears contextually. It uses the existing
dark theme with muted accent colors (not red/alarming — this is a normal workflow state).

```
After Cancel:
┌──────────────────────────────────────────────────────────┐
│  ⏸  Agent stopped by user                     [ Resume ] │
└──────────────────────────────────────────────────────────┘
   bg-gray-800/60  •  border border-gray-700  •  text-gray-300
   Button: bg-purple-600 hover:bg-purple-500 text-white rounded-lg

After Budget Exceeded:
┌──────────────────────────────────────────────────────────┐
│  ⚡ Budget limit reached (95% used)            [ Resume ] │
└──────────────────────────────────────────────────────────┘
   bg-amber-900/20  •  border border-amber-800/40  •  text-amber-200

After Error:
┌──────────────────────────────────────────────────────────┐
│  ⚠  Something went wrong                      [ Resume ] │
└──────────────────────────────────────────────────────────┘
   bg-red-900/20  •  border border-red-800/40  •  text-red-200

After Tool Limit:
┌──────────────────────────────────────────────────────────┐
│  🔧 Tool call limit reached                   [ Resume ] │
└──────────────────────────────────────────────────────────┘
   bg-amber-900/20  •  border border-amber-800/40  •  text-amber-200
```

**Key design choices:**
- Banner sits between messages and input — NOT a floating overlay, NOT a modal
- Disappears when user sends a new message or clicks Resume
- Resume button uses the primary purple accent (consistent with Send button)
- Banner is compact (single line, ~48px height) — doesn't push the chat around aggressively
- Uses subtle background tints to signal severity without being alarming
- Rounded corners (rounded-lg) matching existing card patterns

### Interaction Flow

```
User sends prompt
  → Agent runs (Stop button visible)
  → User clicks Stop / budget fires / error occurs
  → Agent halts, messages saved
  → Status Banner appears with Resume button
  → User choice:
      A) Click Resume → banner disappears, agent continues, Stop button reappears
      B) Type new message → banner disappears, agent runs with new direction
```

---

## Implementation Steps

### Step 1: useAgentSocket.ts — Track stop reason and expose resume

**Changes:**
- Add `stopReason` state: `null | 'cancelled' | 'budget_exceeded' | 'error' | 'tool_limit'`
- Set `stopReason` based on events:
  - `cancel_result` → `'cancelled'`
  - Agent event `budget_exceeded` → `'budget_exceeded'`
  - Agent event `error` → `'error'`
  - Agent event `tool_limit_exceeded` → `'tool_limit'`
- Clear `stopReason` when `sendPrompt()` or `resumeSession()` is called
- Add `resumeSession(sessionId: string)` method:
  - Emits `'resume'` WebSocket event with `{ sessionId }`
  - Sets `isRunning = true`
  - Clears `stopReason`
- Return `stopReason` and `resumeSession` from the hook

### Step 2: ChatView.tsx — Render Status Banner

**Changes:**
- Accept new props: `stopReason`, `onResume`
- Add a `StatusBanner` inline component (no separate file — it's small and contextual)
- Render the banner between the message list and the input area when:
  - `stopReason !== null` AND `!isRunning`
- Banner content varies by `stopReason`:
  - `cancelled`: "Agent stopped by user"
  - `budget_exceeded`: "Budget limit reached"
  - `error`: "Something went wrong"
  - `tool_limit`: "Tool call limit reached"
- Resume button onClick calls `onResume()`
- Banner dismisses when `stopReason` becomes null (cleared by resume or new prompt)

### Step 3: App.tsx — Wire up resume

**Changes:**
- Destructure `stopReason` and `resumeSession` from `useAgentSocket`
- Create `handleResume` callback:
  - Calls `resumeSession(currentSessionId)` if session exists
- Pass `stopReason` and `onResume={handleResume}` to ChatView
- Clear `stopReason` in the `handleSend` path (already handled by sendPrompt clearing it)

### Step 4: AgentServer.ts — WebSocket 'resume' handler

**Changes:**
- Add new WebSocket event handler for `'resume'`:
  ```
  socket.on('resume', rateLimitedHandler('resume', ({ sessionId }) => {
    // Same as 'prompt' handler but with a system-level resume message
    // Calls agent.run() with the session's existing context
  }))
  ```
- The resume prompt is a system instruction:
  `"[System: The user has requested you resume. Continue from where you left off. Do not repeat completed work. Pick up from your last action.]"`
- Uses the same model selection as last run (stored in session metadata)

### Step 5: Agent.ts — Resume-aware run

**Changes:**
- Add `isResume?: boolean` to run options
- When `isResume` is true:
  - Use `role: 'user'` with the resume system message (since Claude API requires user turn)
  - Load the budget continuation hint if it exists (`budget_halt_${sid}`)
  - Reset the budget check for the new run (allow a fresh budget allocation)
  - Log the resume event
- When the agent loop starts on resume, it has the full conversation history plus the
  resume instruction — it naturally continues

### Step 6: AgentServer.ts — REST endpoint (optional, for API users)

**Changes:**
- Add `POST /api/sessions/:id/resume` endpoint
- Calls `agent.run(resumePrompt, { sessionId: id, isResume: true })`
- Returns event stream or acknowledgment

---

## File Change Summary

| File | Changes |
|------|---------|
| `packages/ui/src/hooks/useAgentSocket.ts` | Add `stopReason` state, `resumeSession()`, event listeners |
| `packages/ui/src/components/ChatView.tsx` | Add StatusBanner component, accept new props |
| `packages/ui/src/App.tsx` | Wire `stopReason`, `onResume` to ChatView |
| `packages/agent/src/server/AgentServer.ts` | Add 'resume' WebSocket handler + REST endpoint |
| `packages/agent/src/agent/Agent.ts` | Add `isResume` option handling in run() |

---

## Edge Cases

1. **Resume after session switch**: If user switches sessions then comes back, the banner
   should still show if that session was interrupted (check session metadata)
2. **Double resume**: Prevent clicking Resume while agent is already running
3. **Budget resume**: On resume after budget_exceeded, grant a fresh budget window (otherwise
   it would immediately halt again)
4. **Stale resume**: If the conversation is very old, resume still works because the full
   message history is persisted in SQLite
5. **Network disconnect during resume**: Same retry/reconnect logic as regular prompts
