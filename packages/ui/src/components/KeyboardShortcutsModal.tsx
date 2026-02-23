import { useEffect } from 'react';

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string; description: string }[];
}

const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: '?', description: 'Show this help' },
      { keys: 'Escape', description: 'Close modals / Stop running agent' },
      { keys: '⌘/Ctrl + B', description: 'Toggle sessions panel' },
      { keys: '⌘/Ctrl + ]', description: 'Toggle tools panel' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: '⌘/Ctrl + Enter', description: 'Send message' },
      { keys: 'Escape', description: 'Cancel running agent' },
    ],
  },
  {
    title: 'Sessions',
    shortcuts: [
      { keys: '↑ / ↓', description: 'Navigate sessions' },
      { keys: 'Enter', description: 'Select session' },
      { keys: 'Double-click', description: 'Rename session' },
    ],
  },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ isOpen, onClose }: Props) {
  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div 
        className="bg-gray-900 border border-gray-700 rounded-xl max-w-md w-full max-h-[80vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold text-white">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-xl"
          >
            ✕
          </button>
        </div>
        
        <div className="p-4 space-y-6">
          {SHORTCUTS.map((group) => (
            <div key={group.title}>
              <h3 className="text-sm font-semibold text-purple-400 uppercase tracking-wider mb-3">
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.shortcuts.map((shortcut) => (
                  <div 
                    key={shortcut.description}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-gray-300">{shortcut.description}</span>
                    <kbd className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-gray-400 text-xs font-mono">
                      {shortcut.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        
        <div className="p-4 border-t border-gray-700 text-center">
          <p className="text-xs text-gray-500">
            Press <kbd className="px-1 bg-gray-800 rounded">?</kbd> anytime to show this help
          </p>
        </div>
      </div>
    </div>
  );
}
