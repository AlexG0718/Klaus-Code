import { useEffect, useCallback } from 'react';

interface PatchData {
  patchId: string;
  filePath: string;
  diff: string;
  operation: 'create' | 'modify' | 'delete';
}

interface Props {
  patch: PatchData | null;
  onApprove: (patchId: string) => void;
  onReject: (patchId: string) => void;
  onClose: () => void;
}

export function DiffPreviewModal({ patch, onApprove, onReject, onClose }: Props) {
  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!patch) return;
    
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      onApprove(patch.patchId);
    } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) {
      onReject(patch.patchId);
    }
  }, [patch, onApprove, onReject, onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!patch) return null;

  // Parse diff into lines with highlighting
  const diffLines = patch.diff.split('\n').map((line, index) => {
    let className = 'text-gray-300';
    let prefix = ' ';
    
    if (line.startsWith('+') && !line.startsWith('+++')) {
      className = 'bg-green-900/40 text-green-300';
      prefix = '+';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      className = 'bg-red-900/40 text-red-300';
      prefix = '-';
    } else if (line.startsWith('@@')) {
      className = 'bg-blue-900/40 text-blue-300';
      prefix = '@';
    } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
      className = 'text-gray-500';
    }
    
    return { line, className, prefix, index };
  });

  const operationColors = {
    create: 'text-green-400 bg-green-900/30',
    modify: 'text-yellow-400 bg-yellow-900/30',
    delete: 'text-red-400 bg-red-900/30',
  };

  const operationIcons = {
    create: '✨',
    modify: '📝',
    delete: '🗑️',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-xl border border-gray-700 shadow-2xl w-[90vw] max-w-4xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <span className={`px-2 py-1 rounded text-sm font-medium ${operationColors[patch.operation]}`}>
              {operationIcons[patch.operation]} {patch.operation.toUpperCase()}
            </span>
            <h2 className="text-lg font-semibold text-gray-100">Patch Approval Required</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* File path */}
        <div className="px-6 py-3 bg-gray-800/50 border-b border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-500">File:</span>
            <code className="font-mono text-purple-400">{patch.filePath}</code>
          </div>
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-auto p-4">
          <pre className="font-mono text-sm leading-relaxed">
            {diffLines.map(({ line, className, index }) => (
              <div key={index} className={`${className} px-2 py-0.5 -mx-2`}>
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>

        {/* Footer with actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-700 bg-gray-800/50">
          <div className="text-xs text-gray-500">
            <kbd className="px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">⌘/Ctrl + Enter</kbd> to approve,{' '}
            <kbd className="px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">⌘/Ctrl + ⌫</kbd> to reject,{' '}
            <kbd className="px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">Esc</kbd> to close
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => onReject(patch.patchId)}
              className="px-4 py-2 bg-red-900/30 hover:bg-red-900/50 text-red-400 rounded-lg border border-red-800 transition-colors"
            >
              ✕ Reject
            </button>
            <button
              onClick={() => onApprove(patch.patchId)}
              className="px-4 py-2 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded-lg border border-green-800 transition-colors"
            >
              ✓ Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
