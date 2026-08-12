import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronDown, ChevronRight, AlertTriangle, Wrench, Brain } from 'lucide-react';
import clsx from 'clsx';
import type { UnifiedMessage, ToolCall } from '../types';
import { ROLE_COLORS } from './Minimap';

interface Props {
  message: UnifiedMessage;
  highlighted: boolean;
}

function ToolCallView({ tc }: { tc: ToolCall }) {
  // Prefer pretty-printed parsed JSON if available.
  const pretty =
    tc.argumentsParsed && typeof tc.argumentsParsed === 'object'
      ? JSON.stringify(tc.argumentsParsed, null, 2)
      : tc.arguments;
  return (
    <div className="mt-2 rounded border border-blue-200 bg-white/60">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-blue-100/60 border-b border-blue-200 rounded-t">
        <Wrench className="w-3.5 h-3.5 text-blue-700" />
        <span className="font-mono font-medium text-blue-900">{tc.name}</span>
        {tc.id && <span className="text-gray-500 font-mono">· {tc.id.slice(0, 12)}</span>}
      </div>
      <pre className="text-[12px] p-3 overflow-x-auto whitespace-pre-wrap break-words text-gray-800">
        {pretty}
      </pre>
    </div>
  );
}

function ReasoningView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 rounded border border-purple-200 bg-purple-50/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-purple-800 hover:bg-purple-100/70 rounded"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Brain className="w-3.5 h-3.5" />
        <span className="font-medium">Reasoning</span>
        <span className="text-gray-500 ml-2">
          {text.length > 60 ? text.slice(0, 60).replace(/\n/g, ' ') + '…' : text.replace(/\n/g, ' ')}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 pt-1 text-sm text-purple-900 md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

/**
 * A single message "block" — mirrors Docent's per-message card:
 *  - left color bar per role
 *  - "Block N | Role" header with optional badges
 *  - content rendered as markdown (assistant/user), monospace pre for tool output.
 */
export function MessageBlock({ message, highlighted }: Props) {
  const color = ROLE_COLORS[message.role];
  const [metaOpen, setMetaOpen] = useState(false);

  // Content-area rendering rules — three modes:
  //   'pretty-json' : trim() is a valid JSON object/array → render as fenced
  //                   ```json block with syntax highlighting
  //   'mono'        : shell/env dump / raw output — use <pre>, NO markdown
  //                   (avoids `__init__` being mangled into <strong>init</strong>,
  //                    `1_000_000` being italicized, tables collapsing, etc.)
  //   'markdown'    : normal prose — full markdown + gfm + code highlight
  //
  // Tool blocks are ALWAYS mono unless their content parses cleanly as JSON.
  // Assistant/user blocks default to markdown but flip to mono when the content
  // trips known markdown-hostile patterns.
  const renderMode: 'markdown' | 'pretty-json' | 'mono' = (() => {
    const s = message.content.trim();
    if (!s) return 'markdown';

    // 1. JSON detection wins across all roles — nicer than raw dump.
    if ((s.startsWith('{') || s.startsWith('[')) && s.length > 20) {
      try {
        JSON.parse(s);
        return 'pretty-json';
      } catch { /* not JSON, keep going */ }
    }

    // 2. Tool output is almost always raw shell / structured text.
    if (message.role === 'tool') return 'mono';

    // 3. Markdown-hostile patterns for user / assistant / system:
    //   - XML/HTML tag envelope (Codex uses <environment_context>, <returncode>...)
    //   - Python dunder identifiers (`__init__`, `__pycache__`) — markdown reads
    //     `__x__` as <strong>x</strong> and eats the underscores
    //   - Shell prompts (root@host:...#, user@host:...$)
    //   - Common CLI-agent tool-result prefixes on a user turn ("New Terminal
    //     Output:", "STDOUT:", "Exit code N") — the agent shoved the tool
    //     result into a plain user message instead of using the tool role
    if (/^\s*</.test(s)) return 'mono';
    if (/__\w[\w]*__/.test(s)) return 'mono';
    if (/^[\w.-]+@[\w.-]+:.*[#$]\s/m.test(s)) return 'mono';
    if (message.role === 'user' &&
        /^\s*(New Terminal Output|Terminal Output|STDOUT|STDERR|Exit code|<returncode>)/im.test(s)) return 'mono';

    return 'markdown';
  })();

  // Pretty-print JSON once when we chose 'pretty-json'.
  const jsonPretty = (() => {
    if (renderMode !== 'pretty-json') return '';
    try { return JSON.stringify(JSON.parse(message.content.trim()), null, 2); }
    catch { return message.content; }
  })();

  return (
    <div
      id={`block-${message.blockIdx}`}
      className={clsx(
        'rounded-md border-l-4 px-4 py-3 transition-all',
        color.bg,
        color.border,
        highlighted && 'flash-highlight ring-2 ring-blue-400'
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-700">
            Block {message.blockIdx} <span className="text-gray-400">|</span>{' '}
            <span className="capitalize">{color.label}</span>
          </span>
          {message.reasoning && !message.content && (
            <span className="flex items-center gap-1 text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded text-[11px]">
              <Brain className="w-3 h-3" /> reasoning
            </span>
          )}
          {message.toolCalls?.length ? (
            <span className="flex items-center gap-1 text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded text-[11px]">
              <Wrench className="w-3 h-3" /> tool_call
            </span>
          ) : null}
          {message.isError && (
            <span className="flex items-center gap-1 text-red-700 bg-red-100 px-1.5 py-0.5 rounded text-[11px]">
              <AlertTriangle className="w-3 h-3" /> error
            </span>
          )}
          {message.toolName && (
            <span className="text-gray-500 font-mono text-[11px]">→ {message.toolName}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {message.timestamp && (
            <span className="text-[11px] text-gray-400 font-mono">
              {new Date(message.timestamp).toISOString().slice(11, 19)}
            </span>
          )}
          {message.metadata && Object.keys(message.metadata).length > 0 && (
            <button
              onClick={() => setMetaOpen(!metaOpen)}
              className="text-[11px] text-gray-500 hover:text-gray-800 underline decoration-dotted"
            >
              {metaOpen ? 'hide meta' : 'meta'}
            </button>
          )}
        </div>
      </div>

      {metaOpen && message.metadata && (
        <pre className="text-[11px] mb-2 p-2 bg-white/70 border border-gray-200 rounded overflow-x-auto text-gray-700">
          {JSON.stringify(message.metadata, null, 2)}
        </pre>
      )}

      {/* Reasoning (if present and there's ALSO content, show a collapsible above content). */}
      {message.reasoning && message.content && <ReasoningView text={message.reasoning} />}

      {/* Standalone reasoning-only block: show inline (already flagged in header). */}
      {message.reasoning && !message.content && (
        <div className="text-sm text-purple-900 md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.reasoning}</ReactMarkdown>
        </div>
      )}

      {/* Main content */}
      {message.content && (
        renderMode === 'pretty-json' ? (
          <div className="md-body text-[14px] text-gray-900">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {'```json\n' + jsonPretty + '\n```'}
            </ReactMarkdown>
          </div>
        ) : renderMode === 'mono' ? (
          <pre className="text-[12.5px] whitespace-pre-wrap break-words leading-snug text-gray-900 font-mono">
            {message.content}
          </pre>
        ) : (
          <div className="md-body text-[14px] text-gray-900">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )
      )}

      {/* Tool calls (assistant messages that emitted them) */}
      {message.toolCalls?.map((tc, i) => (
        <ToolCallView key={tc.id || i} tc={tc} />
      ))}
    </div>
  );
}
