import { type Role, type UnifiedMessage } from '../types';
import clsx from 'clsx';

/**
 * Docent-style role palette. Keep in sync with tailwind.config.js.
 */
export const ROLE_COLORS: Record<Role, { bg: string; border: string; dot: string; label: string }> = {
  system:    { bg: 'bg-orange-50', border: 'border-orange-300', dot: 'bg-orange-500', label: 'System' },
  user:      { bg: 'bg-gray-50',   border: 'border-gray-300',   dot: 'bg-gray-400',   label: 'User' },
  assistant: { bg: 'bg-blue-50',   border: 'border-blue-300',   dot: 'bg-blue-500',   label: 'Assistant' },
  tool:      { bg: 'bg-green-50',  border: 'border-green-300',  dot: 'bg-green-500',  label: 'Tool' },
};

interface Props {
  messages: UnifiedMessage[];
  activeIdx: number | null;
  onJump: (idx: number) => void;
}

/**
 * Horizontal minimap — one small color cell per message.
 * Click to scroll to that block. Active cell gets a dark ring.
 */
export function Minimap({ messages, activeIdx, onJump }: Props) {
  return (
    <div className="border-b bg-white sticky top-0 z-10 px-4 py-3">
      {/* Title + legend */}
      <div className="flex items-center gap-4 mb-2 text-xs">
        <span className="font-medium text-gray-700">
          Minimap ({messages.length} messages)
        </span>
        <div className="flex items-center gap-3 text-gray-600">
          {(['system', 'user', 'assistant', 'tool'] as Role[]).map((r) => (
            <span key={r} className="flex items-center gap-1">
              <span className={clsx('inline-block w-2.5 h-2.5 rounded-full', ROLE_COLORS[r].dot)} />
              {ROLE_COLORS[r].label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="inline-block w-0 h-0 border-l-4 border-r-4 border-b-[7px] border-l-transparent border-r-transparent border-b-red-500" />
            Error
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-purple-500" />
            Reasoning
          </span>
        </div>
      </div>

      {/* Cell strip */}
      <div className="flex flex-wrap gap-1 items-center">
        {messages.map((m) => {
          const isReasoning = !!m.reasoning && !m.content;
          const isActive = activeIdx === m.blockIdx;
          const base = isReasoning
            ? 'bg-purple-300'
            : m.isError
              ? 'bg-red-400'
              : ROLE_COLORS[m.role].dot;
          return (
            <button
              key={m.blockIdx}
              title={`Block ${m.blockIdx} — ${m.role}${isReasoning ? ' (reasoning)' : ''}${m.toolCalls?.length ? ' (tool_call)' : ''}${m.images?.length ? ` (image x${m.images.length})` : ''}`}
              onClick={() => onJump(m.blockIdx)}
              className={clsx(
                'h-5 w-5 rounded-sm transition-all cursor-pointer',
                base,
                m.images?.length && 'outline outline-2 outline-pink-400 outline-offset-1',
                isActive
                  ? 'ring-2 ring-gray-900 ring-offset-1 scale-110'
                  : 'hover:scale-110 hover:ring-1 hover:ring-gray-500'
              )}
            />
          );
        })}
      </div>
    </div>
  );
}
