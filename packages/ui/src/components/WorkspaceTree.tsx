import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileTreeNode } from '../lib/types';

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:3001';
const API_SECRET = import.meta.env.VITE_API_SECRET ?? '';
const headers: Record<string, string> = API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {};

const FILE_ICONS: Record<string, string> = {
  ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
  json: '📋', md: '📝', css: '🎨', html: '🌐',
  sh: '⚙️', yml: '⚙️', yaml: '⚙️', env: '🔑',
  test: '🧪', spec: '🧪',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
  mp3: '🎵', wav: '🎵', mp4: '🎬', mov: '🎬',
  pdf: '📕', zip: '📦', tar: '📦', gz: '📦',
};

// Binary file extensions that cannot be previewed as text
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff',
  'mp3', 'wav', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'pdf', 'zip', 'tar', 'gz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'sqlite', 'db', 'sqlite3',
]);

// Image extensions that can be rendered inline
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

// Language mapping for syntax highlighting class names
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', css: 'css', html: 'html',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', py: 'python', sql: 'sql',
};

function fileIcon(name: string): string {
  const parts = name.split('.');
  if (parts.length > 1) {
    const ext = parts[parts.length - 1].toLowerCase();
    if (ext === 'ts' && parts.includes('test')) return FILE_ICONS.test;
    return FILE_ICONS[ext] ?? '📄';
  }
  return '📄';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

// File viewer modal component
function FileViewerModal({ 
  filePath, 
  onClose 
}: { 
  filePath: string; 
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isBinary = isBinaryFile(filePath);
  const isImage = isImageFile(filePath);
  
  const { data, isLoading, error } = useQuery<{ content: string; size: number; path: string }>({
    queryKey: ['workspace-file', filePath],
    queryFn: async () => {
      const res = await fetch(`${AGENT_URL}/api/workspace/file?path=${encodeURIComponent(filePath)}`, { headers });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to load file');
      }
      return res.json();
    },
    enabled: !!filePath && !isBinary,
  });

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const lang = EXT_TO_LANG[ext] ?? 'text';

  const handleCopy = async () => {
    if (data) {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm">{fileIcon(filePath.split('/').pop() ?? '')}</span>
            <span className="text-sm text-gray-200 font-medium truncate">{filePath}</span>
            {data && (
              <span className="text-xs text-gray-500 flex-shrink-0">
                ({formatBytes(data.size)})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors p-1"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-auto p-4 bg-gray-950">
          {isBinary && !isImage && (
            <div className="text-gray-400 text-sm text-center py-8">
              <div className="text-4xl mb-4">{fileIcon(filePath.split('/').pop() ?? '')}</div>
              <p className="font-medium">Binary file — cannot preview</p>
              <p className="text-xs text-gray-500 mt-2">{ext.toUpperCase()} files are not supported for text preview</p>
            </div>
          )}
          {isImage && (
            <div className="text-center">
              <img 
                src={`${AGENT_URL}/api/workspace/file?path=${encodeURIComponent(filePath)}&raw=true`}
                alt={filePath}
                className="max-w-full max-h-[60vh] mx-auto rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}
          {!isBinary && isLoading && (
            <div className="text-gray-500 text-sm">Loading…</div>
          )}
          {!isBinary && error && (
            <div className="text-red-400 text-sm">
              Error: {error instanceof Error ? error.message : 'Failed to load file'}
            </div>
          )}
          {!isBinary && data && (
            <pre className={`text-xs text-gray-300 whitespace-pre-wrap break-words font-mono leading-relaxed language-${lang}`}>
              <code>{data.content}</code>
            </pre>
          )}
        </div>
        
        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-700 flex justify-end gap-2 flex-shrink-0">
          {!isBinary && (
            <button
              onClick={handleCopy}
              disabled={!data}
              className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors disabled:opacity-50"
            >
              {copied ? '✓ Copied' : 'Copy content'}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Rollback confirmation dialog
function RollbackDialog({ 
  onConfirm, 
  onCancel 
}: { 
  onConfirm: () => void; 
  onCancel: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div 
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-sm w-full shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-100 mb-2">Rollback Changes?</h3>
        <p className="text-sm text-gray-400 mb-4">
          This will discard all uncommitted changes and revert to the last git checkpoint.
          This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
          >
            Rollback
          </button>
        </div>
      </div>
    </div>
  );
}

function TreeNode({ 
  node, 
  depth = 0, 
  onFileClick 
}: { 
  node: FileTreeNode; 
  depth?: number;
  onFileClick: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 w-full text-left px-2 py-0.5 rounded hover:bg-gray-800 group"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span className="text-gray-500 text-xs">{open ? '▾' : '▸'}</span>
          <span className="text-xs">📂</span>
          <span className="text-xs text-gray-300 font-medium">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileClick(node.path)}
      className="flex items-center gap-1.5 w-full text-left px-2 py-0.5 rounded hover:bg-gray-800 group cursor-pointer"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span className="text-xs">{fileIcon(node.name)}</span>
      <span className="text-xs text-gray-400 group-hover:text-gray-200 flex-1 truncate">{node.name}</span>
      {node.size !== undefined && (
        <span className="text-xs text-gray-600 flex-shrink-0">{formatBytes(node.size)}</span>
      )}
    </button>
  );
}

export function WorkspaceTree() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showRollback, setShowRollback] = useState(false);
  const [rollbackStatus, setRollbackStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const queryClient = useQueryClient();
  
  const { data, isLoading, error, dataUpdatedAt } = useQuery<{ tree: FileTreeNode[]; workspace: string }>({
    queryKey: ['workspace-tree'],
    queryFn: async () => {
      const res = await fetch(`${AGENT_URL}/api/workspace/tree`, { headers });
      if (!res.ok) throw new Error('Failed to load workspace tree');
      return res.json();
    },
    refetchInterval: 10000,
  });

  const handleFileClick = (path: string) => {
    setSelectedFile(path);
  };

  const handleRollback = async () => {
    setRollbackStatus('loading');
    try {
      const res = await fetch(`${AGENT_URL}/api/workspace/rollback`, { 
        method: 'POST', 
        headers 
      });
      if (!res.ok) throw new Error('Rollback failed');
      setRollbackStatus('success');
      queryClient.invalidateQueries({ queryKey: ['workspace-tree'] });
      setTimeout(() => {
        setRollbackStatus('idle');
        setShowRollback(false);
      }, 1500);
    } catch (err) {
      setRollbackStatus('error');
      setTimeout(() => setRollbackStatus('idle'), 3000);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-800">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Workspace</span>
          <span className="text-xs text-gray-600">
            {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : ''}
          </span>
        </div>
        {data?.workspace && (
          <div className="text-xs text-gray-600 truncate max-w-full" title={data.workspace}>
            {data.workspace.split('/').slice(-2).join('/')}
          </div>
        )}
        {/* Rollback button */}
        <button
          onClick={() => setShowRollback(true)}
          className="mt-2 w-full py-1.5 px-2 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded border border-gray-700 transition-colors flex items-center justify-center gap-1"
          title="Discard uncommitted changes"
        >
          ↩️ Rollback to checkpoint
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && <div className="text-xs text-gray-500 text-center mt-4">Loading…</div>}
        {error && <div className="text-xs text-red-400 text-center mt-4">Cannot connect to agent</div>}
        {data?.tree.map((node) => (
          <TreeNode key={node.path} node={node} onFileClick={handleFileClick} />
        ))}
      </div>
      
      {/* File viewer modal */}
      {selectedFile && (
        <FileViewerModal 
          filePath={selectedFile} 
          onClose={() => setSelectedFile(null)} 
        />
      )}
      
      {/* Rollback confirmation dialog */}
      {showRollback && (
        <RollbackDialog
          onConfirm={handleRollback}
          onCancel={() => setShowRollback(false)}
        />
      )}
      
      {/* Rollback status toast */}
      {rollbackStatus !== 'idle' && (
        <div className={`fixed bottom-4 right-4 px-4 py-2 rounded-lg text-sm ${
          rollbackStatus === 'loading' ? 'bg-gray-800 text-gray-300' :
          rollbackStatus === 'success' ? 'bg-green-900 text-green-200' :
          'bg-red-900 text-red-200'
        }`}>
          {rollbackStatus === 'loading' && '↩️ Rolling back…'}
          {rollbackStatus === 'success' && '✓ Rollback complete'}
          {rollbackStatus === 'error' && '✕ Rollback failed'}
        </div>
      )}
    </div>
  );
}
