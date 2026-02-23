import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, ToolCallEvent, ToolResultEvent, ToolProgressEvent } from '../lib/types';

interface ToolEntry {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'success' | 'error';
  result?: unknown;
  error?: string;
  durationMs?: number;
  expanded: boolean;
  isDiff: boolean;
  patchBefore?: string;
  patchAfter?: string;
  progress?: number;  // 0-100
  progressStatus?: string;
  elapsedMs?: number;
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '📄', write_file: '✍️', apply_patch: '🩹', delete_file: '🗑️',
  list_files: '📁', search_files: '🔍', shell_command: '⚙️',
  git_checkpoint: '📌', git_diff: '📊', git_status: '📋',
  git_push: '⬆️', git_pull: '⬇️', git_branch: '🌿', git_clone: '📥',
  git_merge: '🔀', git_stash: '📦', git_reset: '↩️', git_remote: '🌐',
  git_log: '📜',
  run_tests: '🧪', memory_set: '💾', memory_get: '🔑', deploy_netlify: '🚀',
  npm_install: '📦', npm_run: '▶️', tsc_check: '🔷', eslint_check: '✨',
  prettier_format: '💅', run_node_script: '🟢',
};

// Tools that typically take a long time
const LONG_RUNNING_TOOLS = new Set([
  'npm_install', 'npm_run', 'run_tests', 'git_clone', 'deploy_netlify',
  'tsc_check', 'eslint_check', 'prettier_format',
]);

interface Props {
  onEvent: (handler: (e: AgentEvent) => void) => () => void;
}

export function ToolLog({ onEvent }: Props) {
  const [entries, setEntries] = useState<ToolEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timerRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    const unsubscribe = onEvent((event: AgentEvent) => {
      if (event.type === 'tool_call') {
        const d = (event as ToolCallEvent).data;
        const isLongRunning = LONG_RUNNING_TOOLS.has(d.name);
        
        setEntries((prev) => [...prev, {
          id: d.id, name: d.name, input: d.input,
          status: 'pending', expanded: false,
          isDiff: d.name === 'apply_patch',
          progress: isLongRunning ? 0 : undefined,
          progressStatus: isLongRunning ? 'Starting...' : undefined,
          elapsedMs: 0,
        }]);
        
        // Start elapsed time counter for long-running tools
        if (isLongRunning) {
          const startTime = Date.now();
          const timer = setInterval(() => {
            setEntries((prev) => prev.map((e) => {
              if (e.id !== d.id || e.status !== 'pending') return e;
              return { ...e, elapsedMs: Date.now() - startTime };
            }));
          }, 100);
          timerRefs.current.set(d.id, timer);
        }
        
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
      
      if (event.type === 'tool_progress') {
        const d = (event as ToolProgressEvent).data;
        setEntries((prev) => prev.map((e) => {
          if (e.id !== d.toolCallId) return e;
          return {
            ...e,
            progress: d.progress,
            progressStatus: d.status,
            elapsedMs: d.elapsedMs,
          };
        }));
      }
      
      if (event.type === 'tool_result') {
        const d = (event as ToolResultEvent).data;
        
        // Clear timer if exists
        const timer = timerRefs.current.get(d.toolCallId);
        if (timer) {
          clearInterval(timer);
          timerRefs.current.delete(d.toolCallId);
        }
        
        setEntries((prev) => prev.map((e) => {
          if (e.id !== d.toolCallId) return e;
          // For apply_patch, extract before/after for diff view
          let patchBefore: string | undefined;
          let patchAfter: string | undefined;
          if (e.isDiff && d.result && typeof d.result === 'object') {
            const r = d.result as any;
            patchBefore = r.original ?? undefined;
            patchAfter = r.result ?? undefined;
          }
          return {
            ...e,
            status: d.success ? 'success' : 'error',
            result: d.result,
            error: !d.success ? String(d.result) : undefined,
            durationMs: d.durationMs,
            patchBefore,
            patchAfter,
            progress: undefined,
            progressStatus: undefined,
          };
        }));
      }
      if (event.type === 'complete') {
        // Don't clear — keep tool entries visible for review after the run.
        // Entries are cleared when a new prompt starts (via thinking event).
      }
      if (event.type === 'thinking') {
        // New prompt starting — clear previous entries and timers
        timerRefs.current.forEach((timer) => clearInterval(timer));
        timerRefs.current.clear();
        setEntries([]);
      }
    });
    
    return () => {
      unsubscribe();
      // Clear all timers on cleanup
      timerRefs.current.forEach((timer) => clearInterval(timer));
      timerRefs.current.clear();
    };
  }, [onEvent]);

  const toggle = (id: string) =>
    setEntries((prev) => prev.map((e) => e.id === id ? { ...e, expanded: !e.expanded } : e));

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-2 space-y-1.5">
        {entries.length === 0 && (
          <div className="text-center text-gray-600 text-xs mt-8">Tool activity will appear here</div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`rounded-lg border text-xs ${
              entry.status === 'pending'  ? 'border-yellow-700/50 bg-yellow-900/10' :
              entry.status === 'success'  ? 'border-green-700/40 bg-green-900/10' :
                                            'border-red-700/50 bg-red-900/10'
            }`}
          >
            {/* Header */}
            <button
              onClick={() => toggle(entry.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left"
            >
              <span>{TOOL_ICONS[entry.name] ?? '🔧'}</span>
              <span className="font-semibold text-gray-200 flex-1">{entry.name.replace(/_/g, ' ')}</span>
              <span className={
                entry.status === 'pending' ? 'text-yellow-400' :
                entry.status === 'success' ? 'text-green-400' : 'text-red-400'
              }>
                {entry.status === 'pending' ? '⏳' : entry.status === 'success' ? '✅' : '❌'}
              </span>
              {entry.durationMs !== undefined && (
                <span className="text-gray-500 ml-1">{entry.durationMs}ms</span>
              )}
              {entry.status === 'pending' && entry.elapsedMs !== undefined && (
                <span className="text-gray-500 ml-1">{(entry.elapsedMs / 1000).toFixed(1)}s</span>
              )}
              <span className="text-gray-600 ml-1">{entry.expanded ? '▴' : '▾'}</span>
            </button>

            {/* Progress bar for long-running tools */}
            {entry.status === 'pending' && entry.progress !== undefined && (
              <div className="px-3 pb-2">
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-yellow-500 rounded-full transition-all duration-300"
                      style={{ width: `${Math.max(entry.progress, 5)}%` }}
                    />
                  </div>
                  <span className="text-yellow-400 text-xs w-10 text-right">
                    {entry.progress > 0 ? `${entry.progress}%` : '...'}
                  </span>
                </div>
                {entry.progressStatus && (
                  <div className="text-gray-500 text-xs truncate">{entry.progressStatus}</div>
                )}
              </div>
            )}

            {/* Quick summary line */}
            {!entry.expanded && entry.progress === undefined && (
              <div className="px-3 pb-2 text-gray-400 truncate">
                {formatInputSummary(entry.input)}
              </div>
            )}

            {/* Expanded detail */}
            {entry.expanded && (
              <div className="px-3 pb-3 space-y-2">
                <div className="bg-gray-900 rounded p-2 text-gray-300 text-xs overflow-x-auto">
                  <div className="text-gray-500 mb-1">INPUT</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(entry.input, null, 2)}</pre>
                </div>

                {/* Diff view for apply_patch */}
                {entry.isDiff && entry.patchBefore !== undefined && entry.patchAfter !== undefined ? (
                  <DiffView before={entry.patchBefore} after={entry.patchAfter} />
                ) : entry.result !== undefined ? (
                  <div className="bg-gray-900 rounded p-2 text-xs overflow-x-auto">
                    <div className="text-gray-500 mb-1">OUTPUT</div>
                    <pre className={`whitespace-pre-wrap ${entry.status === 'error' ? 'text-red-300' : 'text-green-300'}`}>
                      {typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Diff viewer ──────────────────────────────────────────────────────────────

function DiffView({ before, after }: { before: string; after: string }) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Simple line-by-line diff: mark removed and added lines
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const diffLines: Array<{ type: 'context' | 'removed' | 'added'; text: string }> = [];

  for (let i = 0; i < maxLen; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      diffLines.push({ type: 'context', text: b ?? '' });
    } else {
      if (b !== undefined) diffLines.push({ type: 'removed', text: b });
      if (a !== undefined) diffLines.push({ type: 'added',   text: a });
    }
  }

  return (
    <div className="rounded overflow-hidden border border-gray-700">
      <div className="bg-gray-800 px-3 py-1 text-xs text-gray-400 font-semibold">Diff</div>
      <div className="bg-gray-950 p-2 overflow-x-auto max-h-60 overflow-y-auto">
        {diffLines.map((line, i) => (
          <div key={i} className={`font-mono text-xs whitespace-pre ${
            line.type === 'removed' ? 'bg-red-900/30 text-red-300' :
            line.type === 'added'   ? 'bg-green-900/30 text-green-300' :
                                      'text-gray-400'
          }`}>
            {line.type === 'removed' ? '- ' : line.type === 'added' ? '+ ' : '  '}
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatInputSummary(input: Record<string, unknown>): string {
  if (input.path) return String(input.path);
  if (input.command) return String(input.command);
  if (input.message) return String(input.message).slice(0, 60);
  if (input.key) return String(input.key);
  if (input.directory) return String(input.directory);
  return JSON.stringify(input).slice(0, 60);
}
