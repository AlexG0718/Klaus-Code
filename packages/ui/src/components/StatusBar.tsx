import { useEffect, useState, useRef } from 'react';
import type { AgentEvent, TokenUsage, TurnCompleteEvent } from '../lib/types';

// Simple notification sound using Web Audio API
function playNotificationSound() {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch {
    // Audio not supported or blocked
  }
}

interface Props {
  connected:   boolean;
  isRunning:   boolean;
  sessionId:   string | null;
  tokenUsage?: TokenUsage | null;
  onEvent:     (handler: (e: AgentEvent) => void) => () => void;
  budget:      number;  // 0 = unlimited
}

type AlertState = 'ok' | 'warning' | 'exceeded' | 'tool_limit';

interface TurnUsage {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export function StatusBar({ connected, isRunning, sessionId, tokenUsage, onEvent, budget }: Props) {
  const [alertState, setAlertState] = useState<AlertState>('ok');
  const [liveUsed,   setLiveUsed]   = useState(0);
  const [toolCount,  setToolCount]  = useState<number | null>(null);
  const [lastTurn, setLastTurn]     = useState<TurnUsage | null>(null);
  const [showTurnInfo, setShowTurnInfo] = useState(false);
  
  // Sound notification preference (stored in localStorage)
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try {
      return localStorage.getItem('agent-sound-enabled') !== 'false';
    } catch {
      return true;
    }
  });
  
  // Track if we were running to know when to play sound
  const wasRunningRef = useRef(false);

  const toggleSound = () => {
    const newValue = !soundEnabled;
    setSoundEnabled(newValue);
    try {
      localStorage.setItem('agent-sound-enabled', String(newValue));
    } catch { /* localStorage blocked */ }
  };

  useEffect(() => {
    const unsubscribe = onEvent((event: AgentEvent) => {
      if (event.type === 'budget_warning') {
        const d = event.data as any;
        setLiveUsed(d.totalUsed);
        setAlertState('warning');
      }
      if (event.type === 'budget_exceeded') {
        const d = event.data as any;
        setLiveUsed(d.totalUsed);
        setAlertState('exceeded');
      }
      if (event.type === 'tool_limit_exceeded') {
        const d = event.data as any;
        setToolCount(d.toolCallsCount);
        setAlertState('tool_limit');
      }
      if (event.type === 'turn_complete') {
        const d = (event as TurnCompleteEvent).data;
        setLiveUsed(d.totalTokens);
        setLastTurn({
          turn: d.turn,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
          totalTokens: d.totalTokensThisTurn,
          cost: d.estimatedCostThisTurn,
        });
        setShowTurnInfo(true);
        // Hide turn info after 5 seconds
        setTimeout(() => setShowTurnInfo(false), 5000);
      }
      if (event.type === 'complete') {
        setAlertState('ok');
        setToolCount(null);
        // Play notification sound if session was running long enough
        if (wasRunningRef.current && soundEnabled) {
          playNotificationSound();
        }
      }
    });
    return unsubscribe;
  }, [onEvent, soundEnabled]);

  // Track running state
  useEffect(() => {
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    if (tokenUsage) setLiveUsed(tokenUsage.totalTokens);
  }, [tokenUsage]);

  // Reset turn info when session changes
  useEffect(() => {
    setLastTurn(null);
    setShowTurnInfo(false);
  }, [sessionId]);

  const usedTokens = liveUsed || tokenUsage?.totalTokens || 0;
  const budgetPct  = budget > 0 ? Math.min(usedTokens / budget, 1) : 0;
  const costStr    = tokenUsage ? `$${tokenUsage.estimatedCostUsd.toFixed(3)}` : null;

  const barColour =
    alertState === 'exceeded'   ? 'bg-red-500' :
    alertState === 'tool_limit' ? 'bg-orange-500' :
    alertState === 'warning'    ? 'bg-yellow-400' :
    budgetPct > 0.6             ? 'bg-orange-400' :
                                   'bg-purple-500';

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-t border-gray-800 text-xs text-gray-400 flex-shrink-0">

      {/* Connection */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <div
          className={`w-2 h-2 rounded-full transition-colors ${connected ? 'bg-green-400' : 'bg-red-500'}`}
          style={connected ? { boxShadow: '0 0 6px #4ade80' } : {}}
        />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>

      {/* Running pulse */}
      {isRunning && alertState === 'ok' && (
        <div className="flex items-center gap-1.5 text-purple-400 flex-shrink-0">
          <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
          <span>Running…</span>
        </div>
      )}

      {/* Per-turn token info (shows temporarily after each turn) */}
      {showTurnInfo && lastTurn && isRunning && (
        <div className="flex items-center gap-1.5 text-cyan-400 flex-shrink-0 transition-opacity">
          <span className="opacity-75">Turn {lastTurn.turn}:</span>
          <span className="font-mono">
            {lastTurn.inputTokens.toLocaleString()}↓ {lastTurn.outputTokens.toLocaleString()}↑
          </span>
          <span className="opacity-75">
            (${lastTurn.cost.toFixed(4)})
          </span>
        </div>
      )}

      {/* Alert banners — only one shows at a time, most severe wins */}
      {alertState === 'exceeded' && (
        <div className="flex items-center gap-1.5 text-red-400 font-semibold flex-shrink-0">
          🛑 Token budget exceeded — session halted
        </div>
      )}
      {alertState === 'tool_limit' && (
        <div className="flex items-center gap-1.5 text-orange-400 font-semibold flex-shrink-0">
          🔁 Tool call limit reached ({toolCount} calls) — session halted
        </div>
      )}
      {alertState === 'warning' && (
        <div className="flex items-center gap-1.5 text-yellow-400 flex-shrink-0">
          ⚠️ Approaching token budget
        </div>
      )}

      {/* Session ID */}
      {sessionId && (
        <span className="text-gray-600 font-mono flex-shrink-0">
          {sessionId.slice(0, 8)}…
        </span>
      )}

      {/* Right side: cost + budget meter */}
      <div className="ml-auto flex items-center gap-3 flex-shrink-0">
        {/* Sound toggle */}
        <button
          onClick={toggleSound}
          className={`text-sm transition-colors ${soundEnabled ? 'text-purple-400 hover:text-purple-300' : 'text-gray-600 hover:text-gray-500'}`}
          title={soundEnabled ? 'Sound notifications on (click to disable)' : 'Sound notifications off (click to enable)'}
        >
          {soundEnabled ? '🔔' : '🔕'}
        </button>

        {costStr && <span className="text-gray-500">{costStr}</span>}

        {budget > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-gray-500 tabular-nums">
              {(usedTokens / 1000).toFixed(1)}k / {(budget / 1000).toFixed(0)}k tokens
            </span>
            <div className="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColour}`}
                style={{ width: `${Math.round(budgetPct * 100)}%` }}
              />
            </div>
            <span className={`tabular-nums w-8 text-right ${
              alertState === 'exceeded'   ? 'text-red-400 font-bold' :
              alertState === 'tool_limit' ? 'text-orange-400 font-bold' :
              alertState === 'warning'    ? 'text-yellow-400' :
                                            'text-gray-500'
            }`}>
              {Math.round(budgetPct * 100)}%
            </span>
          </div>
        ) : (
          usedTokens > 0 && (
            <span className="text-gray-500 tabular-nums">
              {(usedTokens / 1000).toFixed(1)}k tokens
            </span>
          )
        )}
      </div>
    </div>
  );
}
