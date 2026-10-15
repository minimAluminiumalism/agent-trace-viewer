import { FileText, ChevronLeft } from 'lucide-react';
import type { TranscriptDoc } from '../types';

interface Props {
  doc: TranscriptDoc;
  onReset: () => void;
}

/**
 * Left sidebar — mirrors Docent's Transcripts / Runs panel but stripped down.
 * Shows: source badge, session id, key metadata, message-count breakdown.
 */
export function Sidebar({ doc, onReset }: Props) {
  const byRole = doc.messages.reduce<Record<string, number>>((acc, m) => {
    const key = m.reasoning && !m.content ? 'reasoning' : m.role;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const sourceBadge = {
    codex: { text: 'Codex CLI', cls: 'bg-orange-100 text-orange-800 border-orange-300' },
    'claude-code': { text: 'Claude Code', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
    'openai-chat': { text: 'OpenAI Chat Completions', cls: 'bg-teal-100 text-teal-800 border-teal-300' },
    'openai-responses': { text: 'OpenAI Responses API', cls: 'bg-slate-100 text-slate-800 border-slate-300' },
    'anthropic-messages': { text: 'Anthropic Messages API', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
    'mini-swe-agent': { text: 'mini-swe-agent', cls: 'bg-purple-100 text-purple-800 border-purple-300' },
    opencode: { text: 'opencode', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
    devin: { text: 'Devin CLI', cls: 'bg-indigo-100 text-indigo-800 border-indigo-300' },
    generic: { text: 'Generic', cls: 'bg-gray-100 text-gray-800 border-gray-300' },
  }[doc.source];

  return (
    <aside className="w-72 bg-white border-r border-gray-200 flex flex-col overflow-y-auto custom-scrollbar">
      <div className="p-4 border-b border-gray-200">
        <button
          onClick={onReset}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"
        >
          <ChevronLeft className="w-4 h-4" /> Load another file
        </button>
        <div className="flex items-center gap-2 mb-2">
          <FileText className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-800 truncate" title={doc.filename}>
            {doc.filename}
          </span>
        </div>
        <span className={`inline-block text-[11px] px-2 py-0.5 rounded border ${sourceBadge.cls}`}>
          {sourceBadge.text}
        </span>
      </div>

      {/* Message counts by role */}
      <div className="p-4 border-b border-gray-200">
        <div className="text-xs font-medium text-gray-500 mb-2 uppercase">Blocks</div>
        <div className="space-y-1.5">
          {[
            { k: 'system', label: 'System', dot: 'bg-orange-500' },
            { k: 'user', label: 'User', dot: 'bg-gray-400' },
            { k: 'assistant', label: 'Assistant', dot: 'bg-blue-500' },
            { k: 'reasoning', label: 'Reasoning', dot: 'bg-purple-500' },
            { k: 'tool', label: 'Tool', dot: 'bg-green-500' },
          ].map((r) => (
            <div key={r.k} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-gray-700">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${r.dot}`} />
                {r.label}
              </div>
              <span className="text-gray-500 font-mono">{byRole[r.k] ?? 0}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-sm border-t pt-2 mt-2">
            <span className="font-medium text-gray-800">Total</span>
            <span className="font-mono text-gray-800">{doc.messages.length}</span>
          </div>
        </div>

        {/* Sources whose session storage doesn't persist system prompt get an
            explanatory note here (opencode / claude-code). This is by design,
            not a parser bug — see project README for details. */}
        {(byRole.system ?? 0) === 0 && (doc.source === 'opencode' || doc.source === 'claude-code') && (
          <div className="mt-3 text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded p-2 leading-snug">
            <span className="font-medium text-gray-700">No System block?</span>{' '}
            {doc.source === 'opencode' ? (
              <>opencode does not persist the system prompt in session data — it's injected at runtime from a template in the opencode source (per model provider).</>
            ) : (
              <>Claude Code session logs do not persist the system prompt; it is injected by the client at each request.</>
            )}
          </div>
        )}
      </div>

      {/* Session metadata */}
      <div className="p-4">
        <div className="text-xs font-medium text-gray-500 mb-2 uppercase">Session</div>
        <dl className="space-y-1.5 text-xs">
          {Object.entries(doc.meta)
            .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
            .map(([k, v]) => (
              <div key={k}>
                <dt className="text-gray-500">{k}</dt>
                <dd className="text-gray-800 font-mono break-all">{String(v)}</dd>
              </div>
            ))}
          {Object.entries(doc.meta)
            .filter(([, v]) => v != null && typeof v === 'object')
            .map(([k, v]) => (
              <details key={k} className="mt-2">
                <summary className="text-gray-500 cursor-pointer hover:text-gray-800">
                  {k}
                </summary>
                <pre className="mt-1 p-2 bg-gray-50 border border-gray-200 rounded text-[11px] overflow-x-auto text-gray-700">
                  {JSON.stringify(v, null, 2)}
                </pre>
              </details>
            ))}
        </dl>
      </div>
    </aside>
  );
}
