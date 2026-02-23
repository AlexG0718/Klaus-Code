import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import type { AgentEvent } from '../lib/types';

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:3001';
const API_SECRET = import.meta.env.VITE_API_SECRET ?? '';

// Maximum number of event handlers to prevent memory leaks
const MAX_HANDLERS = 50;

export type ModelOption =
  | 'claude-opus-4-5'
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5';

export const MODEL_INFO: Record<
  ModelOption,
  { name: string; description: string; costMultiplier: number }
> = {
  'claude-opus-4-5': {
    name: 'Opus',
    description: 'Most capable, highest cost',
    costMultiplier: 1,
  },
  'claude-sonnet-4-5': {
    name: 'Sonnet',
    description: 'Balanced performance/cost',
    costMultiplier: 0.2,
  },
  'claude-haiku-4-5': {
    name: 'Haiku',
    description: 'Fast and affordable',
    costMultiplier: 0.05,
  },
};

interface UseAgentSocketReturn {
  connected: boolean;
  isRunning: boolean;
  currentSessionId: string | null;
  selectedModel: ModelOption;
  setSelectedModel: (model: ModelOption) => void;
  sendPrompt: (message: string, sessionId?: string) => string;
  cancelSession: (sessionId: string) => void;
  onEvent: (handler: (event: AgentEvent) => void) => () => void;
  respondToPatchApproval: (approved: boolean, patchId: string) => void;
}

export function useAgentSocket(): UseAgentSocketReturn {
  const [connected, setConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelOption>(() => {
    try {
      const saved = localStorage.getItem('agent-selected-model');
      if (saved && saved in MODEL_INFO) return saved as ModelOption;
    } catch {
      /* localStorage unavailable */
    }
    return 'claude-sonnet-4-5'; // Default to Sonnet for balanced cost/performance
  });
  const socketRef = useRef<Socket | null>(null);
  // Use a Set to prevent duplicate handlers and track them by reference
  const handlersRef = useRef<Set<(event: AgentEvent) => void>>(new Set());
  const currentSessionIdRef = useRef<string | null>(null);

  // Persist model selection
  useEffect(() => {
    try {
      localStorage.setItem('agent-selected-model', selectedModel);
    } catch {
      /* localStorage unavailable */
    }
  }, [selectedModel]);

  // Keep ref in sync with state
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    const socket = io(AGENT_URL, {
      transports: ['websocket'],
      auth: API_SECRET ? { token: API_SECRET } : {},
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // On reconnect, rejoin the active session so we don't miss events
      const sid = socketRef.current ? currentSessionIdRef.current : null;
      if (sid) {
        socket.emit('join_session', sid);
      }
    });
    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('agent_event', (event: AgentEvent) => {
      handlersRef.current.forEach((h) => {
        try {
          h(event);
        } catch {
          /* handler error, continue */
        }
      });
      if (event.type === 'complete' || event.type === 'error') {
        setIsRunning(false);
      }
    });

    socket.on('prompt_complete', () => setIsRunning(false));

    return () => {
      socket.disconnect();
      // Clear all handlers on cleanup to prevent leaks
      handlersRef.current.clear();
    };
  }, []);

  const onEvent = useCallback((handler: (event: AgentEvent) => void) => {
    // Prevent adding too many handlers (indicates a leak)
    if (handlersRef.current.size >= MAX_HANDLERS) {
      console.warn(
        `Event handler limit (${MAX_HANDLERS}) reached. Possible memory leak.`
      );
      // Remove oldest handler to make room
      const first = handlersRef.current.values().next().value;
      if (first) handlersRef.current.delete(first);
    }

    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const sendPrompt = useCallback(
    (message: string, sessionId?: string): string => {
      const sid = sessionId ?? uuidv4();
      setCurrentSessionId(sid);
      setIsRunning(true);
      socketRef.current?.emit('join_session', sid);
      socketRef.current?.emit('prompt', {
        message,
        sessionId: sid,
        model: selectedModel,
      });
      return sid;
    },
    [selectedModel]
  );

  const cancelSession = useCallback((sessionId: string) => {
    socketRef.current?.emit('cancel', sessionId);
    setIsRunning(false);
  }, []);

  const respondToPatchApproval = useCallback(
    (approved: boolean, patchId: string) => {
      socketRef.current?.emit('patch_approval_response', { approved, patchId });
    },
    []
  );

  return {
    connected,
    isRunning,
    currentSessionId,
    selectedModel,
    setSelectedModel,
    sendPrompt,
    cancelSession,
    onEvent,
    respondToPatchApproval,
  };
}
