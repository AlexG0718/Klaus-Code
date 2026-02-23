import { useRef, useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '../lib/types';
import { TAG_COLORS } from '../lib/types';

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:3001';
const API_SECRET = import.meta.env.VITE_API_SECRET ?? '';
const headers: Record<string, string> = API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {};

interface Props {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

// Toast notification for undo functionality
function UndoToast({ 
  onUndo, 
  onDismiss 
}: { 
  sessionId: string; 
  onUndo: () => void; 
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 flex items-center gap-3 shadow-lg z-50 animate-fade-in">
      <span className="text-sm text-gray-300">Session deleted</span>
      <button
        onClick={onUndo}
        className="text-sm font-semibold text-purple-400 hover:text-purple-300 transition-colors"
      >
        Undo
      </button>
      <button
        onClick={onDismiss}
        className="text-gray-500 hover:text-gray-400"
      >
        ✕
      </button>
    </div>
  );
}

// Inline rename input
function RenameInput({
  initialName,
  onSave,
  onCancel,
}: {
  initialName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim()) onSave(value.trim());
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => { if (value.trim()) onSave(value.trim()); else onCancel(); }}
      className="w-full bg-gray-900 border border-purple-500 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
      maxLength={200}
    />
  );
}

export function SessionList({ activeSessionId, onSelectSession, onNewSession }: Props) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  
  // Track pending deletion for undo functionality
  const [pendingDelete, setPendingDelete] = useState<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  
  // Track rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  
  // Track focused index for keyboard navigation
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // Debounce search with useRef
  const handleSearch = (v: string) => {
    setSearch(v);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => setDebouncedSearch(v), 350);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    
    // If there's already a pending deletion, execute it immediately
    if (pendingDelete) {
      clearTimeout(pendingDelete.timer);
      executeDelete(pendingDelete.id);
    }
    
    // Set up new pending deletion with 5 second delay
    const timer = setTimeout(() => {
      executeDelete(id);
      setPendingDelete(null);
    }, 5000);
    
    setPendingDelete({ id, timer });
    
    // Immediately hide from UI (optimistic update)
    queryClient.setQueryData(['sessions', debouncedSearch], (old: { sessions: Session[] } | undefined) => {
      if (!old) return old;
      return {
        ...old,
        sessions: old.sessions.filter(s => s.id !== id)
      };
    });
    
    if (activeSessionId === id) onNewSession();
  };

  const executeDelete = async (id: string) => {
    try {
      await fetch(`${AGENT_URL}/api/sessions/${id}`, { method: 'DELETE', headers });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch { /* ignore */ }
  };

  const handleUndo = () => {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    setPendingDelete(null);
    // Refetch to restore the session in the list
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  const handleDismissToast = () => {
    if (!pendingDelete) return;
    // Timer will execute the delete when it fires
    setPendingDelete(null);
  };

  const handleRename = async (id: string, newName: string) => {
    setRenamingId(null);
    try {
      await fetch(`${AGENT_URL}/api/sessions/${id}/rename`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch { /* ignore */ }
  };

  const handleTogglePin = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`${AGENT_URL}/api/sessions/${id}/pin`, {
        method: 'POST',
        headers,
      });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch { /* ignore */ }
  };

  const handleExport = async (id: string, format: 'markdown' | 'json', e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${AGENT_URL}/api/sessions/${id}/export?format=${format}`, { headers });
      if (!res.ok) throw new Error('Export failed');
      
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const { data, isLoading, error } = useQuery<{ sessions: Session[] }>({
    queryKey: ['sessions', debouncedSearch],
    queryFn: async () => {
      const url = debouncedSearch
        ? `${AGENT_URL}/api/sessions?q=${encodeURIComponent(debouncedSearch)}`
        : `${AGENT_URL}/api/sessions`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error('Failed to load sessions');
      return res.json();
    },
    refetchInterval: 10000,
  });

  const sessions = data?.sessions ?? [];

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!sessions.length) return;
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((prev) => Math.min(prev + 1, sessions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && focusedIndex >= 0) {
      e.preventDefault();
      onSelectSession(sessions[focusedIndex].id);
    }
  }, [sessions, focusedIndex, onSelectSession]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    
    list.addEventListener('keydown', handleKeyDown);
    return () => list.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex >= 0) {
      const items = listRef.current?.querySelectorAll('[data-session-item]');
      items?.[focusedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-gray-800">
        <button
          onClick={onNewSession}
          className="w-full py-2 px-3 bg-purple-700 hover:bg-purple-600 text-white rounded-lg text-sm font-semibold transition-colors text-left flex items-center gap-2"
        >
          <span>＋</span> New Session
        </button>
        <input
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search sessions…"
          className="mt-2 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500"
        />
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto" tabIndex={0}>
        {isLoading && (
          <div className="p-4 text-xs text-gray-500 text-center">Loading…</div>
        )}
        {error && (
          <div className="p-4 text-xs text-red-400 text-center">Failed to load sessions</div>
        )}
        {sessions.length === 0 && !isLoading && (
          <div className="p-4 text-xs text-gray-500 text-center">
            {debouncedSearch ? 'No sessions match your search' : 'No sessions yet'}
          </div>
        )}
        {sessions.map((session, index) => (
          <div
            key={session.id}
            data-session-item
            onClick={() => onSelectSession(session.id)}
            onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(session.id); }}
            className={`w-full text-left px-3 py-3 border-b border-gray-800/50 hover:bg-gray-800 transition-colors group relative cursor-pointer ${
              activeSessionId === session.id ? 'bg-gray-800 border-l-2 border-l-purple-500' : ''
            } ${focusedIndex === index ? 'ring-1 ring-purple-500 ring-inset' : ''} ${
              session.pinned ? 'bg-yellow-900/10' : ''
            }`}
          >
            {/* Pin indicator */}
            {session.pinned && (
              <span className="absolute top-1 left-1 text-xs text-yellow-500">📌</span>
            )}
            {renamingId === session.id ? (
              <RenameInput
                initialName={session.summary ?? 'New session'}
                onSave={(name) => handleRename(session.id, name)}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <p className={`text-xs text-gray-200 font-medium truncate leading-snug pr-16 ${session.pinned ? 'pl-4' : ''}`}>
                {session.summary ?? 'New session'}
              </p>
            )}
            {/* Tags */}
            {session.tags && session.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {session.tags.map((tag) => (
                  <span
                    key={tag}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      TAG_COLORS[tag] || TAG_COLORS.default
                    }`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500">
                {new Date(session.updatedAt).toLocaleDateString()}
              </span>
              {session.tokenUsage && session.tokenUsage.totalTokens > 0 && (
                <span className="text-xs text-gray-600">
                  · {(session.tokenUsage.totalTokens / 1000).toFixed(1)}k tokens
                  · ${session.tokenUsage.estimatedCostUsd.toFixed(3)}
                </span>
              )}
            </div>
            {/* Action buttons */}
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <span
                onClick={(e) => handleTogglePin(session.id, e)}
                className={`text-xs cursor-pointer ${session.pinned ? 'text-yellow-500' : 'text-gray-600 hover:text-yellow-400'}`}
                title={session.pinned ? 'Unpin session' : 'Pin session'}
              >
                📌
              </span>
              <span
                onClick={(e) => { e.stopPropagation(); setRenamingId(session.id); }}
                className="text-gray-600 hover:text-purple-400 text-xs cursor-pointer"
                title="Rename session"
              >
                ✏️
              </span>
              <span
                onClick={(e) => handleExport(session.id, 'markdown', e)}
                className="text-gray-600 hover:text-blue-400 text-xs cursor-pointer"
                title="Export to Markdown"
              >
                📄
              </span>
              <span
                onClick={(e) => handleExport(session.id, 'json', e)}
                className="text-gray-600 hover:text-green-400 text-xs cursor-pointer"
                title="Export to JSON"
              >
                📋
              </span>
              <span
                onClick={(e) => handleDeleteSession(session.id, e)}
                className="text-gray-600 hover:text-red-400 text-xs cursor-pointer"
                title="Delete session"
              >
                ✕
              </span>
            </div>
          </div>
        ))}
      </div>
      
      {/* Keyboard hint */}
      <div className="p-2 border-t border-gray-800 text-xs text-gray-600 text-center">
        ↑↓ navigate · Enter select · Double-click rename
      </div>
      
      {/* Undo toast */}
      {pendingDelete && (
        <UndoToast
          sessionId={pendingDelete.id}
          onUndo={handleUndo}
          onDismiss={handleDismissToast}
        />
      )}
    </div>
  );
}
