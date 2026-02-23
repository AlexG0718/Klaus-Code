export type AgentEventType =
  | 'thinking'
  | 'stream_delta'
  | 'tool_call'
  | 'tool_result'
  | 'tool_progress'
  | 'message'
  | 'error'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'tool_limit_exceeded'
  | 'turn_complete'
  | 'patch_approval_required'
  | 'complete';

export interface BudgetEvent extends AgentEvent {
  type: 'budget_warning' | 'budget_exceeded';
  data: { totalUsed: number; budget: number; percentUsed: number };
}

export interface ToolLimitEvent extends AgentEvent {
  type: 'tool_limit_exceeded';
  data: { toolCallsCount: number; limit: number; message: string };
}

export interface TurnCompleteEvent extends AgentEvent {
  type: 'turn_complete';
  data: {
    sessionId: string;
    turn: number;
    inputTokens: number;
    outputTokens: number;
    totalTokensThisTurn: number;
    estimatedCostThisTurn: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    budgetUsedPercent: number | null;
    budgetRemaining: number | null;
  };
}

export interface ToolProgressEvent extends AgentEvent {
  type: 'tool_progress';
  data: {
    toolCallId: string;
    toolName: string;
    progress: number; // 0-100
    status: string;
    elapsedMs: number;
  };
}

export interface PatchApprovalEvent extends AgentEvent {
  type: 'patch_approval_required';
  data: {
    patchId: string;
    filePath: string;
    diff: string;
    operation: 'create' | 'modify' | 'delete';
  };
}

export interface AgentEvent {
  type: AgentEventType;
  data: unknown;
  timestamp: string | Date;
}

export interface StreamDeltaEvent extends AgentEvent {
  type: 'stream_delta';
  data: { delta: string; sessionId: string };
}

export interface MessageEvent extends AgentEvent {
  type: 'message';
  data: { role: 'user' | 'assistant'; content: string };
}

export interface ToolCallEvent extends AgentEvent {
  type: 'tool_call';
  data: { name: string; input: Record<string, unknown>; id: string };
}

export interface ToolResultEvent extends AgentEvent {
  type: 'tool_result';
  data: {
    toolCallId: string;
    toolName: string;
    success: boolean;
    result: unknown;
    durationMs: number;
  };
}

export interface Session {
  id: string;
  workspaceDir: string;
  summary?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  pinned: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  tokenUsage?: TokenUsage;
}

// Predefined tag colors for consistency
export const TAG_COLORS: Record<string, string> = {
  feature: 'bg-blue-900/50 text-blue-300 border-blue-700',
  bugfix: 'bg-red-900/50 text-red-300 border-red-700',
  refactor: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  docs: 'bg-green-900/50 text-green-300 border-green-700',
  test: 'bg-purple-900/50 text-purple-300 border-purple-700',
  deploy: 'bg-cyan-900/50 text-cyan-300 border-cyan-700',
  default: 'bg-gray-800/50 text-gray-300 border-gray-700',
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  size?: number;
}
