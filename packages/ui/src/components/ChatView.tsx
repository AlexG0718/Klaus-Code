import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { AgentEvent, ChatMessage } from '../lib/types';
import type { StopReason } from '../hooks/useAgentSocket';

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:3001';
const API_SECRET = import.meta.env.VITE_API_SECRET ?? '';
const headers: Record<string, string> = API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {};

// Code block with copy button
function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <SyntaxHighlighter style={vscDarkPlus} language={language} PreTag="div">
        {children.replace(/\n$/, '')}
      </SyntaxHighlighter>
    </div>
  );
}

const STOP_REASON_CONFIG: Record<StopReason, { icon: string; label: string; bg: string; border: string; text: string }> = {
  cancelled: {
    icon: '\u23F8',
    label: 'Agent stopped by user',
    bg: 'bg-gray-800/60',
    border: 'border-gray-700',
    text: 'text-gray-300',
  },
  budget_exceeded: {
    icon: '\u26A1',
    label: 'Budget limit reached',
    bg: 'bg-amber-900/20',
    border: 'border-amber-800/40',
    text: 'text-amber-200',
  },
  error: {
    icon: '\u26A0',
    label: 'Something went wrong',
    bg: 'bg-red-900/20',
    border: 'border-red-800/40',
    text: 'text-red-200',
  },
  tool_limit: {
    icon: '\uD83D\uDD27',
    label: 'Tool call limit reached',
    bg: 'bg-amber-900/20',
    border: 'border-amber-800/40',
    text: 'text-amber-200',
  },
};

function StatusBanner({ stopReason, onResume }: { stopReason: StopReason; onResume: () => void }) {
  const config = STOP_REASON_CONFIG[stopReason];
  return (
    <div className={`mx-4 mb-3 px-4 py-3 rounded-lg border ${config.bg} ${config.border} flex items-center justify-between`}>
      <span className={`text-sm ${config.text}`}>
        {config.icon}{'  '}{config.label}
      </span>
      <button
        onClick={onResume}
        className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-sm font-semibold rounded-lg transition-colors"
      >
        Resume
      </button>
    </div>
  );
}

interface Props {
  sessionId: string | null;
  isRunning: boolean;
  stopReason: StopReason | null;
  onEvent: (handler: (e: AgentEvent) => void) => () => void;
  onSendPrompt: (message: string) => void;
  onCancel: () => void;
  onResume: () => void;
}

export function ChatView({ sessionId, isRunning, stopReason, onEvent, onSendPrompt, onCancel, onResume }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Register event handler for this session
  useEffect(() => {
    const unsubscribe = onEvent((event: AgentEvent) => {
      if (event.type === 'message') {
        const d = event.data as any;
        if (d.role === 'assistant') {
          // Replace streaming placeholder with final message
          setMessages((prev) => {
            const withoutStreaming = prev.filter((m) => !m.streaming);
            return [...withoutStreaming, {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: d.content,
              timestamp: new Date(),
              streaming: false,
            }];
          });
          setStreamingId(null);
        }
      } else if (event.type === 'stream_delta') {
        const d = event.data as any;
        setMessages((prev) => {
          const streamingMsg = prev.find((m) => m.streaming);
          if (streamingMsg) {
            return prev.map((m) =>
              m.streaming ? { ...m, content: m.content + d.delta } : m
            );
          }
          // Create streaming placeholder
          const id = crypto.randomUUID();
          setStreamingId(id);
          return [...prev, {
            id,
            role: 'assistant',
            content: d.delta,
            timestamp: new Date(),
            streaming: true,
          }];
        });
      } else if (event.type === 'error') {
        const d = event.data as any;
        // Clear any streaming message and show error
        setMessages((prev) => [
          ...prev.filter((m) => !m.streaming),
          { id: crypto.randomUUID(), role: 'system', content: `⚠️ ${d.error}`, timestamp: new Date() },
        ]);
        setStreamingId(null);
      } else if (event.type === 'complete') {
        // Ensure streaming is cleared on completion
        setStreamingId(null);
        setMessages((prev) => prev.filter((m) => !m.streaming || m.content.trim().length > 0));
      }
    });
    return unsubscribe;
  }, [onEvent]);

  // Load session history when switching to a past session
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }

    const controller = new AbortController();
    setLoadingHistory(true);

    fetch(`${AGENT_URL}/api/sessions/${sessionId}`, { headers, signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data?.messages) {
          const loaded: ChatMessage[] = data.messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant')
            .map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: new Date(m.createdAt),
            }));
          setMessages(loaded);
        } else {
          setMessages([]);
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setMessages([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingHistory(false);
      });

    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isRunning) return;
    const content = input.trim();
    setInput('');
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role: 'user', content, timestamp: new Date(),
    }]);
    onSendPrompt(content);
  }, [input, isRunning, onSendPrompt]);

  // Escape key cancels running agent
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isRunning) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRunning, onCancel]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loadingHistory && (
          <div className="text-center text-gray-500 mt-20">
            <div className="flex gap-1 justify-center mb-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-2 h-2 rounded-full bg-purple-400 animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </div>
            <p className="text-sm">Loading session history…</p>
          </div>
        )}
        {!loadingHistory && messages.length === 0 && (
          <div className="text-center text-gray-500 mt-20">
            <div className="text-4xl mb-4">🤖</div>
            <p className="text-lg font-medium text-gray-400">AI Agent ready</p>
            <p className="text-sm mt-2">Describe what you want to build, fix, or deploy.</p>
            <div className="mt-6 space-y-2 text-left max-w-md mx-auto">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => { setInput(p); }}
                  className="w-full text-left px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:border-purple-500 hover:text-white transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-purple-700 text-purple-50 rounded-br-sm'
                : msg.role === 'system'
                ? 'bg-red-900/40 border border-red-700 text-red-200'
                : 'bg-gray-800 border border-gray-700 text-gray-100 rounded-bl-sm'
            }`}>
              {msg.role === 'assistant' || msg.role === 'system' ? (
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown
                    components={{
                      code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const content = String(children);
                        return !inline && match ? (
                          <CodeBlock language={match[1]}>{content}</CodeBlock>
                        ) : (
                          <code className="bg-gray-900 px-1 py-0.5 rounded text-purple-300 text-xs" {...props}>
                            {children}
                          </code>
                        );
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                  {msg.streaming && (
                    <span className="inline-block w-2 h-4 bg-purple-400 ml-1 animate-pulse" />
                  )}
                </div>
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
          </div>
        ))}

        {isRunning && !streamingId && (
          <div className="flex justify-start">
            <div className="bg-gray-800 border border-gray-700 rounded-xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1 items-center text-purple-400 text-sm">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </div>
                <span className="ml-2">Thinking…</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Status banner — shown after cancel, budget limit, error, or tool limit */}
      {stopReason && !isRunning && (
        <StatusBanner stopReason={stopReason} onResume={onResume} />
      )}

      {/* Input */}
      <div className="border-t border-gray-800 p-4">
        <div className="flex gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSend(); }}
            disabled={isRunning}
            placeholder={isRunning ? 'Agent is running…' : 'Describe what you want to build… (Ctrl+Enter to send)'}
            rows={3}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500 resize-none disabled:opacity-50"
          />
          <div className="flex flex-col gap-2">
            <button
              onClick={handleSend}
              disabled={isRunning || !input.trim()}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              Send
            </button>
            {isRunning && (
              <button
                onClick={onCancel}
                className="px-4 py-2 bg-red-800 hover:bg-red-700 text-red-100 rounded-lg text-sm font-semibold transition-colors"
              >
                ✕ Stop
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1">Ctrl+Enter to send · Escape to stop</p>
      </div>
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  'Build a reusable <Modal> component with TypeScript and unit tests',
  'The tests in src/api/users.test.ts are failing — diagnose and fix',
  'Run the full test suite, then deploy to Netlify preview',
  'Refactor src/utils/auth.ts to use async/await and add error handling',
];
