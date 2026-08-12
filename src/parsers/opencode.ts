/**
 * opencode session parser.
 *
 * opencode stores each session in SQLite (message + part rows). Sessions must
 * first be exported to jsonl via `scripts/export-opencode.py`. The exported
 * shape is:
 *
 *   line 0: {"type": "opencode_session_meta", "session": {...}}
 *   line k: {"type": "opencode_message", "role": ...,
 *            "message_id", "time_created", "parts": [ {id, time_created, data} ],
 *            "raw_message_data": {...}}
 *
 * Part `data.type` ∈ text | reasoning | tool | patch | file | step-start | step-finish.
 * We flatten those to one `UnifiedMessage` per meaningful part:
 *   text           → merge into the enclosing assistant/user block
 *   reasoning      → standalone reasoning block (purple)
 *   tool           → assistant "tool_call" block + follow-up "tool" (green) block
 *                    with the output; error state → red badge
 *   patch/file     → tool-like green block summarizing the artifact
 *   step-start/end → dropped (visible in Minimap density would be noise)
 */
import type { TranscriptDoc, UnifiedMessage, ToolCall } from '../types';

interface OpencodeLine {
  type?: 'opencode_session_meta' | 'opencode_message' | string;
  session?: any;
  role?: string;
  message_id?: string;
  time_created?: number;
  parts?: Array<{ id: string; time_created: number; data: any }>;
  raw_message_data?: any;
}

export function isOpencodeExport(firstLines: object[]): boolean {
  for (const o of firstLines) {
    const t = (o as OpencodeLine)?.type;
    if (t === 'opencode_session_meta' || t === 'opencode_message') return true;
  }
  return false;
}

function stringifyPretty(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}

function textFromToolOutput(out: unknown): string {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  return stringifyPretty(out);
}

export function parseOpencode(rawLines: string[], filename: string): TranscriptDoc {
  const lines: OpencodeLine[] = [];
  for (const raw of rawLines) {
    const s = raw.trim();
    if (!s) continue;
    try { lines.push(JSON.parse(s)); } catch { /* skip */ }
  }

  const sessionMeta = lines.find((l) => l.type === 'opencode_session_meta')?.session ?? {};

  const meta: Record<string, unknown> = {
    session_id: sessionMeta.id,
    title: sessionMeta.title,
    directory: sessionMeta.directory,
    version: sessionMeta.version,
    agent: sessionMeta.agent,
    model: sessionMeta.model,
    time_created: sessionMeta.time_created,
    time_updated: sessionMeta.time_updated,
    tokens_input: sessionMeta.tokens_input,
    tokens_output: sessionMeta.tokens_output,
    tokens_reasoning: sessionMeta.tokens_reasoning,
    cost: sessionMeta.cost,
  };

  const messages: UnifiedMessage[] = [];

  for (const line of lines) {
    if (line.type !== 'opencode_message') continue;

    const role = line.role;
    const parts = line.parts ?? [];
    const rawData = line.raw_message_data ?? {};

    // Assistant-side hard errors (e.g. 404 from provider) — emit a red block up-front.
    if (role === 'assistant' && rawData.error) {
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        isError: true,
        content: `**${rawData.error.name ?? 'Error'}**\n\n` +
                 '```json\n' + stringifyPretty(rawData.error) + '\n```',
        timestamp: line.time_created ? new Date(line.time_created).toISOString() : undefined,
        metadata: { provider_error: true, message_id: line.message_id },
      });
      if (parts.length === 0) continue;
    }

    // Bucketize parts. We rely on part order (already sorted by time_created).
    let textAccum: string[] = [];

    const flushTextBlock = () => {
      const merged = textAccum.join('\n\n').trim();
      if (!merged) { textAccum = []; return; }
      messages.push({
        blockIdx: messages.length,
        role: (role === 'user' || role === 'assistant' || role === 'system') ? role : 'assistant',
        content: merged,
        timestamp: line.time_created ? new Date(line.time_created).toISOString() : undefined,
        metadata: { message_id: line.message_id },
      });
      textAccum = [];
    };

    for (const p of parts) {
      const d = p.data ?? {};
      const pt = d.type;

      if (pt === 'text') {
        textAccum.push(String(d.text ?? ''));
        continue;
      }

      if (pt === 'reasoning') {
        flushTextBlock();
        const reasoningText = String(d.text ?? '');
        if (!reasoningText) continue;
        messages.push({
          blockIdx: messages.length,
          role: 'assistant',
          content: '',
          reasoning: reasoningText,
          timestamp: p.time_created ? new Date(p.time_created).toISOString() : undefined,
          metadata: { kind: 'reasoning', part_id: p.id, ...(d.metadata ? { anthropic_meta: !!d.metadata.anthropic } : {}) },
        });
        continue;
      }

      if (pt === 'tool') {
        flushTextBlock();
        const callId = d.callID ?? '';
        const toolName = d.tool ?? 'unknown';
        const state = d.state ?? {};
        const input = state.input;

        // 1) Assistant-side "tool_call" block
        const tc: ToolCall = {
          id: callId,
          name: toolName,
          arguments: stringifyPretty(input ?? {}),
          argumentsParsed: input,
        };
        messages.push({
          blockIdx: messages.length,
          role: 'assistant',
          content: '',
          toolCalls: [tc],
          timestamp: p.time_created ? new Date(p.time_created).toISOString() : undefined,
          metadata: { kind: 'tool_call', part_id: p.id, tool: toolName, status: state.status },
        });

        // 2) Tool-side output/error block (only if the tool actually resolved)
        if (state.status === 'completed' || state.status === 'error') {
          const output = state.status === 'error'
            ? (state.error ?? '(error)')
            : textFromToolOutput(state.output ?? state.metadata ?? '');
          messages.push({
            blockIdx: messages.length,
            role: 'tool',
            toolCallId: callId,
            toolName: toolName,
            isError: state.status === 'error',
            content: String(output),
            timestamp: p.time_created ? new Date(p.time_created).toISOString() : undefined,
            metadata: {
              status: state.status,
              title: state.title,
              tool_metadata: state.metadata,
              time: state.time,
            },
          });
        }
        continue;
      }

      if (pt === 'patch') {
        flushTextBlock();
        const files = Array.isArray(d.files) ? d.files : [];
        messages.push({
          blockIdx: messages.length,
          role: 'tool',
          toolName: 'patch',
          content: '**patch**\n\n' + files.map((f: string) => `- \`${f}\``).join('\n'),
          timestamp: p.time_created ? new Date(p.time_created).toISOString() : undefined,
          metadata: { kind: 'patch', hash: d.hash },
        });
        continue;
      }

      if (pt === 'file') {
        flushTextBlock();
        const mime = d.mime ?? 'application/octet-stream';
        const name = d.filename ?? '(file)';
        // Suppress giant base64 data URLs from the visible content.
        const url = typeof d.url === 'string' && d.url.startsWith('data:')
          ? `data:${mime}[…${(d.url.length / 1024).toFixed(0)}KB]`
          : String(d.url ?? '');
        messages.push({
          blockIdx: messages.length,
          role: 'tool',
          toolName: 'file',
          content: `**file** — \`${name}\` · ${mime}\n\n${url}`,
          timestamp: p.time_created ? new Date(p.time_created).toISOString() : undefined,
          metadata: { kind: 'file', mime, filename: name },
        });
        continue;
      }

      // step-start / step-finish — drop silently; would just be noise in the minimap.
      if (pt === 'step-start' || pt === 'step-finish') continue;

      // Unknown part.type — surface as a tool block for debugging visibility.
      flushTextBlock();
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        content: '```json\n' + stringifyPretty(d) + '\n```',
        timestamp: p.time_created ? new Date(p.time_created).toISOString() : undefined,
        metadata: { kind: 'unknown_part_type', part_type: pt, part_id: p.id },
      });
    }

    flushTextBlock();

    // Emit an "empty user turn" if the message has no parts at all and no error.
    if (parts.length === 0 && !rawData.error) {
      messages.push({
        blockIdx: messages.length,
        role: (role === 'user' || role === 'assistant' || role === 'system') ? role : 'assistant',
        content: '',
        timestamp: line.time_created ? new Date(line.time_created).toISOString() : undefined,
        metadata: { message_id: line.message_id, note: 'empty-turn' },
      });
    }
  }

  return {
    id: String(sessionMeta.id ?? filename),
    filename,
    source: 'opencode',
    meta,
    messages,
    title: (sessionMeta.title as string) ?? String(sessionMeta.id ?? filename).slice(0, 12),
  };
}
