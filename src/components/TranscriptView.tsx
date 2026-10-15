import { useEffect, useRef, useState, useCallback } from 'react';
import type { TranscriptDoc } from '../types';
import { Minimap } from './Minimap';
import { MessageBlock } from './MessageBlock';

interface Props {
  doc: TranscriptDoc;
  /** Basename → objectURL for user-supplied image files. */
  imageUrls?: Map<string, string>;
}

/**
 * Renders the transcript column: sticky Minimap + scrollable block list.
 * The "active" block is the one with the largest visible area — same
 * heuristic Docent uses in AgentRunViewer.tsx.
 */
export function TranscriptView({ doc, imageUrls }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const clearHighlightTimer = useRef<number | null>(null);

  // Compute the block whose visible area (intersect with viewport) is largest.
  const recomputeActive = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();

    let bestIdx: number | null = null;
    let bestVisible = 0;

    for (const m of doc.messages) {
      const el = document.getElementById(`block-${m.blockIdx}`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, cRect.top);
      const bottom = Math.min(r.bottom, cRect.bottom);
      const visible = Math.max(0, bottom - top);
      if (visible > bestVisible) {
        bestVisible = visible;
        bestIdx = m.blockIdx;
      }
    }
    if (bestIdx != null) setActiveIdx(bestIdx);
  }, [doc.messages]);

  useEffect(() => {
    recomputeActive();
    const container = scrollRef.current;
    if (!container) return;
    const onScroll = () => recomputeActive();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [recomputeActive]);

  const jumpTo = useCallback((idx: number) => {
    const el = document.getElementById(`block-${idx}`);
    const container = scrollRef.current;
    if (!el || !container) return;
    const target =
      el.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      16;
    container.scrollTo({ top: target, behavior: 'smooth' });
    setHighlighted(idx);
    if (clearHighlightTimer.current) window.clearTimeout(clearHighlightTimer.current);
    clearHighlightTimer.current = window.setTimeout(() => setHighlighted(null), 1200);
  }, []);

  return (
    <div className="flex flex-col flex-1 min-w-0 bg-gray-50">
      {/* Breadcrumb */}
      <div className="px-4 py-2 border-b bg-white text-xs text-gray-600 flex items-center gap-2">
        <span>Collection</span>
        <span className="text-gray-300">›</span>
        <span>Agent Run</span>
        <span className="text-gray-300">›</span>
        <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-700">
          {doc.id.slice(0, 8)}
        </span>
        <span className="text-gray-300">›</span>
        <span className="font-medium text-gray-800">Transcript</span>
      </div>

      <Minimap messages={doc.messages} activeIdx={activeIdx} onJump={jumpTo} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-4 py-4">
        <div className="max-w-5xl mx-auto space-y-3 pb-24">
          {doc.messages.map((m) => (
            <MessageBlock
              key={m.blockIdx}
              message={m}
              highlighted={highlighted === m.blockIdx}
              imageUrls={imageUrls}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
