/**
 * Codex CLI rollout jsonl parser.
 *
 * Format (verified against real rollouts, codex_cli_rs v0.106.x):
 *   Each line: { timestamp, type, payload }
 *   type ∈ { session_meta, turn_context, event_msg, response_item }
 *
 * We prefer `response_item` (canonical persisted form) over `event_msg`
 * (streaming events) for the visible message stream — event_msg messages
 * would otherwise show up twice.
 */
import type { TranscriptDoc, UnifiedMessage, ToolCall, Role } from '../types';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: any;
}

interface CodexContentItem {
  type?: string;         // 'input_text' | 'output_text' | 'summary_text' | ...
  text?: string;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as CodexContentItem[])
      .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function tryParseJson(s: string): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Return true if raw looks like a Codex rollout jsonl (first non-empty line is session_meta). */
export function isCodexRollout(firstLines: object[]): boolean {
  for (const o of firstLines) {
    const t = (o as CodexLine)?.type;
    if (t === 'session_meta') return true;
    if (t === 'response_item' || t === 'event_msg' || t === 'turn_context') return true;
  }
  return false;
}

export function parseCodex(rawLines: string[], filename: string): TranscriptDoc {
  const lines: CodexLine[] = [];
  for (const raw of rawLines) {
    const s = raw.trim();
    if (!s) continue;
    try { lines.push(JSON.parse(s)); } catch { /* skip malformed line */ }
  }

  // 1) Session meta -> transcript-level metadata
  const metaLine = lines.find((l) => l.type === 'session_meta');
  const sessionMeta = metaLine?.payload ?? {};

  const meta: Record<string, unknown> = {
    session_id: sessionMeta.id,
    cwd: sessionMeta.cwd,
    cli_version: sessionMeta.cli_version,
    model_provider: sessionMeta.model_provider,
    originator: sessionMeta.originator,
    timestamp: sessionMeta.timestamp,
  };

  // Track latest turn_context (contains model / sandbox_policy for the turn)
  let currentModel: string | undefined;
  let currentSandbox: unknown;
  let currentApproval: unknown;

  // Buffer of blocks we build. `event_msg/user_message` and
  // `event_msg/agent_message` duplicate what appears in response_item/message,
  // so we skip those and use response_item as the source of truth.
  const messages: UnifiedMessage[] = [];

  // Add session_meta base_instructions as the SYSTEM block (block 0)
  const sysText = extractText(sessionMeta?.base_instructions?.text ?? sessionMeta?.base_instructions);
  if (sysText) {
    messages.push({
      blockIdx: messages.length,
      role: 'system',
      content: sysText,
      metadata: {
        source: 'session_meta.base_instructions',
        cli_version: sessionMeta.cli_version,
      },
    });
  }

  // Map call_id -> tool name for enriching function_call_output later.
  const callIdToName = new Map<string, string>();

  for (const line of lines) {
    if (!line || !line.type) continue;
    if (line.type === 'session_meta') continue; // already handled above

    if (line.type === 'turn_context') {
      const p = line.payload ?? {};
      currentModel = p.model ?? currentModel;
      currentSandbox = p.sandbox_policy ?? currentSandbox;
      currentApproval = p.approval_policy ?? currentApproval;
      continue;
    }

    if (line.type === 'event_msg') {
      const p = line.payload ?? {};
      // Skip messages that will re-appear as response_item (avoid duplicates).
      // Also skip noisy telemetry.
      if (p.type === 'user_message' || p.type === 'agent_message' || p.type === 'agent_reasoning'
        || p.type === 'token_count' || p.type === 'task_started' || p.type === 'task_complete') {
        continue;
      }
      // Surface errors / aborts / other rare event types as a small "error"-ish block.
      if (p.type === 'turn_aborted' || p.type === 'error' || String(p.type).endsWith('_error')) {
        messages.push({
          blockIdx: messages.length,
          role: 'tool', // rendered green (Docent has no "error" role either — uses metadata badge)
          isError: true,
          content: `**${p.type}**\n\n${JSON.stringify(p, null, 2)}`,
          timestamp: line.timestamp,
          metadata: p,
        });
      }
      continue;
    }

    if (line.type !== 'response_item') continue;

    const p = line.payload ?? {};

    if (p.type === 'message') {
      const rawRole: string = p.role ?? 'user';
      // 'developer' in Codex maps to a system-ish role. Keep it labeled explicitly in metadata.
      const role: Role = (rawRole === 'developer' ? 'system'
                        : (rawRole as Role));
      messages.push({
        blockIdx: messages.length,
        role,
        content: extractText(p.content),
        timestamp: line.timestamp,
        metadata: rawRole === 'developer' ? { codex_role: 'developer' } : undefined,
      });
      continue;
    }

    if (p.type === 'reasoning') {
      // Codex stores model reasoning as a separate response item.
      // We render this as a purple-tinted block (assistant reasoning).
      const summaryText = extractText(p.summary);
      const bodyText = extractText(p.content);
      const text = [summaryText, bodyText].filter(Boolean).join('\n\n');
      if (!text) continue;
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        reasoning: text,
        timestamp: line.timestamp,
        metadata: { kind: 'reasoning', encrypted: !!p.encrypted_content },
      });
      continue;
    }

    if (p.type === 'function_call') {
      const parsedArgs = tryParseJson(p.arguments ?? '');
      const tc: ToolCall = {
        id: p.call_id ?? '',
        name: p.name ?? 'unknown',
        arguments: p.arguments ?? '',
        argumentsParsed: parsedArgs,
      };
      if (tc.id) callIdToName.set(tc.id, tc.name);
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        toolCalls: [tc],
        timestamp: line.timestamp,
        metadata: { kind: 'function_call' },
      });
      continue;
    }

    if (p.type === 'function_call_output') {
      const name = callIdToName.get(p.call_id ?? '') ?? p.name;
      const outputText = typeof p.output === 'string'
        ? p.output
        : (p.output?.content ? extractText(p.output.content) : JSON.stringify(p.output, null, 2));
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        toolCallId: p.call_id,
        toolName: name,
        content: outputText ?? '',
        timestamp: line.timestamp,
        metadata: { kind: 'function_call_output' },
      });
      continue;
    }

    // Unknown response_item.type: surface as tool block with metadata for debugging.
    messages.push({
      blockIdx: messages.length,
      role: 'tool',
      content: '```json\n' + JSON.stringify(p, null, 2) + '\n```',
      timestamp: line.timestamp,
      metadata: { kind: 'unknown_response_item', payload_type: p.type },
    });
  }

  if (currentModel) meta.model = currentModel;
  if (currentSandbox) meta.sandbox_policy = currentSandbox;
  if (currentApproval) meta.approval_policy = currentApproval;

  return {
    id: (sessionMeta.id as string) || filename,
    filename,
    source: 'codex',
    meta,
    messages,
    title: (sessionMeta.id as string)?.slice(0, 8) ?? filename,
  };
}
