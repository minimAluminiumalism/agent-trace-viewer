/**
 * Claude Code / generic OpenAI Chat jsonl parser.
 *
 * Claude Code stores per-session `.jsonl` under `~/.claude/projects/<slug>/<uuid>.jsonl`.
 * Historical layouts vary; we handle the common shapes we've observed and fall back
 * to the "OpenAI Chat rollout" shape (each line a `{role, content, ...}` message).
 */
import type { TranscriptDoc, UnifiedMessage, Role, ToolCall } from '../types';

interface CCLine {
  type?: string;              // 'user' | 'assistant' | 'summary' | 'system' | 'tool_use' | ...
  role?: string;              // fallback
  message?: any;              // some CC lines nest the OpenAI-shape message here
  content?: any;
  timestamp?: string;
  toolUseResult?: any;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  // Sidecar-only lines (metadata jsonl): { type: "last-prompt" | "ai-title" | "mode", ... }
  // These are silently ignored.
}

function extractContent(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) {
    return x.map((it) => {
      if (typeof it === 'string') return it;
      if (typeof it === 'object' && it) {
        const anyIt = it as any;
        if (anyIt.type === 'text') return String(anyIt.text ?? '');
        if (anyIt.type === 'tool_use') return ''; // handled separately
        if (anyIt.type === 'tool_result') return typeof anyIt.content === 'string'
          ? anyIt.content : JSON.stringify(anyIt.content);
        return String(anyIt.text ?? '');
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof x === 'object') {
    const anyX = x as any;
    return anyX.text ?? anyX.content ?? JSON.stringify(x);
  }
  return String(x);
}

function collectToolCalls(content: unknown): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: ToolCall[] = [];
  for (const it of content) {
    if (typeof it === 'object' && it && (it as any).type === 'tool_use') {
      const anyIt = it as any;
      out.push({
        id: anyIt.id ?? '',
        name: anyIt.name ?? 'unknown',
        arguments: typeof anyIt.input === 'string' ? anyIt.input : JSON.stringify(anyIt.input ?? {}, null, 2),
        argumentsParsed: anyIt.input,
      });
    }
  }
  return out.length ? out : undefined;
}

export function isClaudeCodeOrGeneric(firstLines: object[]): boolean {
  for (const o of firstLines as CCLine[]) {
    // Ignore metadata sidecar lines
    if (['last-prompt', 'ai-title', 'mode', 'summary'].includes(String(o?.type))) continue;
    const role = o?.role ?? o?.type ?? (o?.message as any)?.role;
    if (['user', 'assistant', 'system', 'tool'].includes(String(role))) return true;
  }
  return false;
}

export function parseClaudeCodeOrGeneric(rawLines: string[], filename: string): TranscriptDoc {
  const lines: CCLine[] = [];
  for (const raw of rawLines) {
    const s = raw.trim();
    if (!s) continue;
    try { lines.push(JSON.parse(s)); } catch { /* skip */ }
  }

  const messages: UnifiedMessage[] = [];
  const meta: Record<string, unknown> = {};

  for (const line of lines) {
    // Skip Claude Code sidecar metadata rows (they carry no message content)
    const rawType = line.type ?? '';
    if (['last-prompt', 'ai-title', 'mode', 'summary'].includes(rawType)) {
      if (line.sessionId) meta.session_id = line.sessionId;
      if ((line as any).aiTitle) meta.title = (line as any).aiTitle;
      continue;
    }

    // Unwrap: some CC lines wrap the message under .message, some don't.
    const inner = line.message ?? line;
    const roleRaw: string = String(inner.role ?? line.type ?? '');
    if (!['user', 'assistant', 'system', 'tool'].includes(roleRaw)) continue;

    const role = roleRaw as Role;
    const content = extractContent(inner.content);
    const toolCalls = collectToolCalls(inner.content);

    // If it was a "tool_use only" turn (no text), still emit an assistant block for the tool call.
    if (!content && toolCalls) {
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        toolCalls,
        timestamp: line.timestamp,
        metadata: { uuid: line.uuid, parentUuid: line.parentUuid },
      });
      continue;
    }

    // If this is a "tool" message (tool_result), pull id/name from CC's shape.
    if (role === 'tool') {
      let toolCallId: string | undefined;
      let toolName: string | undefined;
      const c = inner.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (it && typeof it === 'object' && (it as any).type === 'tool_result') {
            toolCallId = (it as any).tool_use_id ?? toolCallId;
          }
        }
      }
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        content,
        toolCallId,
        toolName,
        timestamp: line.timestamp,
        metadata: { uuid: line.uuid, parentUuid: line.parentUuid },
      });
      continue;
    }

    messages.push({
      blockIdx: messages.length,
      role,
      content,
      toolCalls,
      timestamp: line.timestamp,
      metadata: { uuid: line.uuid, parentUuid: line.parentUuid },
    });
  }

  // Session id: prefer first sessionId we saw
  const sid = (lines.find((l) => l.sessionId)?.sessionId) ?? filename;

  return {
    id: String(sid),
    filename,
    source: 'claude-code',
    meta,
    messages,
    title: (meta.title as string) ?? String(sid).slice(0, 8),
  };
}
