import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAgentSocket } from './hooks/useAgentSocket';
import { ChatView } from './components/ChatView';
import { SessionList } from './components/SessionList';
import { ToolLog } from './components/ToolLog';
import { WorkspaceTree } from './components/WorkspaceTree';
import { StatusBar } from './components/StatusBar';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { ModelSelector } from './components/ModelSelector';
import { DiffPreviewModal } from './components/DiffPreviewModal';
import type { TokenUsage, PatchApprovalEvent } from './lib/types';

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:3001';

// Error boundary component to prevent white-screen crashes
import React from 'react';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-100">
          <div className="text-center max-w-md">
            <div className="text-4xl mb-4">💥</div>
            <h1 className="text-lg font-bold mb-2">Something went wrong</h1>
            <p className="text-sm text-gray-400 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-semibold"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AgentApp() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [activeTab, setActiveTab] = useState<'tools' | 'tree'>('tools');
  
  // Collapsible panel state
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  
  // Keyboard shortcuts modal
  const [showShortcuts, setShowShortcuts] = useState(false);
  
  // Diff preview modal for patch approvals
  const [pendingPatch, setPendingPatch] = useState<PatchApprovalEvent['data'] | null>(null);

  const { 
    connected, isRunning, currentSessionId, 
    selectedModel, setSelectedModel,
    sendPrompt, cancelSession, onEvent, respondToPatchApproval 
  } = useAgentSocket();

  // Fetch server config including token budget
  const { data: serverConfig } = useQuery<{ tokenBudget: number; status: string; checks: { database: string; docker: string } }>({
    queryKey: ['server-health'],
    queryFn: async () => {
      const res = await fetch(`${AGENT_URL}/health`);
      if (!res.ok) throw new Error('Failed to fetch server config');
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: 10000, // Consider fresh for 10 seconds
  });

  const tokenBudget = serverConfig?.tokenBudget ?? Number(import.meta.env.VITE_TOKEN_BUDGET ?? 100_000);
  const serverHealthy = serverConfig?.status === 'ok';

  // Track token usage and patch approval events
  const handleEventForApp = useCallback((event: any) => {
    if (event.type === 'complete' && event.data?.tokenUsage) {
      setTokenUsage(event.data.tokenUsage);
    }
    if (event.type === 'patch_approval_required') {
      setPendingPatch((event as PatchApprovalEvent).data);
    }
  }, []);

  // Register app-level event listener with proper cleanup
  useEffect(() => {
    const unsubscribe = onEvent(handleEventForApp);
    return unsubscribe;
  }, [onEvent, handleEventForApp]);

  const handleSendPrompt = useCallback((message: string) => {
    const sid = sendPrompt(message, activeSessionId ?? undefined);
    setActiveSessionId(sid);
  }, [sendPrompt, activeSessionId]);

  const handleCancel = useCallback(() => {
    if (currentSessionId) cancelSession(currentSessionId);
  }, [cancelSession, currentSessionId]);

  const handleNewSession = useCallback(() => {
    setActiveSessionId(null);
    setTokenUsage(null);
  }, []);

  // Patch approval handlers
  const handleApprovePatch = useCallback((patchId: string) => {
    respondToPatchApproval(true, patchId);
    setPendingPatch(null);
  }, [respondToPatchApproval]);

  const handleRejectPatch = useCallback((patchId: string) => {
    respondToPatchApproval(false, patchId);
    setPendingPatch(null);
  }, [respondToPatchApproval]);

  // Export session
  const handleExportSession = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`${AGENT_URL}/api/sessions/${activeSessionId}/export?format=markdown`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${activeSessionId.slice(0, 8)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  }, [activeSessionId]);

  // Keyboard shortcut to toggle panels and show help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }
      
      // ? shows keyboard shortcuts (without modifiers)
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcuts(true);
      }
      // Ctrl/Cmd + B toggles left panel
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        setLeftPanelCollapsed(prev => !prev);
      }
      // Ctrl/Cmd + ] toggles right panel
      if ((e.ctrlKey || e.metaKey) && e.key === ']') {
        e.preventDefault();
        setRightPanelCollapsed(prev => !prev);
      }
      // Ctrl/Cmd + E exports session
      if ((e.ctrlKey || e.metaKey) && e.key === 'e' && activeSessionId) {
        e.preventDefault();
        handleExportSession();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSessionId, handleExportSession]);

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 font-mono">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-900 border-b border-gray-800 flex-shrink-0">
        <div 
          className={`w-2 h-2 rounded-full ${serverHealthy ? 'bg-green-400' : 'bg-yellow-400'}`}
          style={{ boxShadow: serverHealthy ? '0 0 6px #4ade80' : '0 0 6px #facc15' }}
          title={serverHealthy ? 'Server healthy' : 'Server degraded'}
        />
        <span className="text-sm font-bold text-purple-400">AI Dev Agent</span>
        
        {/* Model selector */}
        <ModelSelector
          selectedModel={selectedModel}
          onSelect={setSelectedModel}
          disabled={isRunning}
        />
        
        <span className="ml-auto text-xs bg-gray-800 px-2 py-0.5 rounded text-gray-400">
          {activeSessionId ? `session: ${activeSessionId.slice(0, 8)}…` : 'No active session'}
        </span>
        
        {/* Export button */}
        {activeSessionId && (
          <button
            onClick={handleExportSession}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title="Export session (⌘/Ctrl+E)"
          >
            📤 Export
          </button>
        )}
        
        {/* Panel toggle hints */}
        <span className="text-xs text-gray-600" title="Keyboard shortcuts">
          ? for shortcuts
        </span>
      </div>

      {/* Main layout: 3 columns */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Session list with external toggle */}
        <div className="flex flex-shrink-0">
          {/* Collapsible content */}
          <div 
            className={`border-r border-gray-800 transition-all duration-200 overflow-hidden ${
              leftPanelCollapsed ? 'w-0 border-r-0' : 'w-56'
            }`}
          >
            <SessionList
              activeSessionId={activeSessionId}
              onSelectSession={(id) => { setActiveSessionId(id); setTokenUsage(null); }}
              onNewSession={handleNewSession}
            />
          </div>
          {/* Toggle button - always visible */}
          <button
            onClick={() => setLeftPanelCollapsed(!leftPanelCollapsed)}
            className="w-5 flex-shrink-0 bg-gray-900 border-r border-gray-800 hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors flex items-center justify-center"
            title={`${leftPanelCollapsed ? 'Show' : 'Hide'} sessions (⌘/Ctrl+B)`}
          >
            <span className="text-xs">
              {leftPanelCollapsed ? '▶' : '◀'}
            </span>
          </button>
        </div>

        {/* Center: Chat */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <ChatView
            sessionId={activeSessionId}
            isRunning={isRunning}
            onEvent={onEvent}
            onSendPrompt={handleSendPrompt}
            onCancel={handleCancel}
          />
        </div>

        {/* Right: Tool log + workspace tree with external toggle */}
        <div className="flex flex-shrink-0">
          {/* Toggle button - always visible */}
          <button
            onClick={() => setRightPanelCollapsed(!rightPanelCollapsed)}
            className="w-5 flex-shrink-0 bg-gray-900 border-l border-gray-800 hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors flex items-center justify-center"
            title={`${rightPanelCollapsed ? 'Show' : 'Hide'} tools & files (⌘/Ctrl+])`}
          >
            <span className="text-xs">
              {rightPanelCollapsed ? '◀' : '▶'}
            </span>
          </button>
          {/* Collapsible content */}
          <div 
            className={`border-l border-gray-800 flex flex-col transition-all duration-200 overflow-hidden ${
              rightPanelCollapsed ? 'w-0 border-l-0' : 'w-80'
            }`}
          >
            {/* Tab switcher */}
            <div className="flex border-b border-gray-800 bg-gray-900 flex-shrink-0">
              {(['tools', 'tree'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                    activeTab === tab
                      ? 'text-purple-400 border-b-2 border-purple-500'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {tab === 'tools' ? '⚙ Tools' : '📁 Files'}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-hidden">
              {activeTab === 'tools'
                ? <ToolLog onEvent={onEvent} />
                : <WorkspaceTree />}
            </div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <StatusBar
        connected={connected}
        isRunning={isRunning}
        sessionId={activeSessionId}
        tokenUsage={tokenUsage}
        onEvent={onEvent}
        budget={tokenBudget}
      />
      
      {/* Keyboard shortcuts modal */}
      <KeyboardShortcutsModal 
        isOpen={showShortcuts} 
        onClose={() => setShowShortcuts(false)} 
      />
      
      {/* Diff preview modal for patch approvals */}
      <DiffPreviewModal
        patch={pendingPatch}
        onApprove={handleApprovePatch}
        onReject={handleRejectPatch}
        onClose={() => setPendingPatch(null)}
      />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AgentApp />
    </ErrorBoundary>
  );
}
