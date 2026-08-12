/**
 * OpenAI Chat Completions API parser (both request and response bodies).
 *
 *   request:  { model, messages[], tools?, tool_choice?, reasoning_effort?, ... }
 *   response: { id, object:"chat.completion", created, model, choices[], usage }
 *             where choices[0].message == { role:"assistant", content, tool_calls?, ... }
 *
 * Six possible `role`s:
 *   - "system"    (classic)
 *   - "developer" (o1/o3 replacement for system)
 *   - "user"
 *   - "assistant" — may include `tool_calls[]` (new) or `function_call` (deprecated),
 *                   plus `refusal` (safety refusals)
 *   - "tool"      — a tool-result message, references `tool_call_id`
 *   - "function"  (deprecated) — old-style function-result message, has `name`
 *
 * `content` can be either a plain string OR an array of content parts:
 *   { type: "text",        text }
 *   { type: "image_url",   image_url: { url, detail? } }              (vision)
 *   { type: "input_audio", input_audio: { data (base64), format } }   (audio)
 *   { type: "file",        file: { file_id? | file_data? | filename } }
 *   { type: "refusal",     refusal }                                  (assistant only)
 *
 * Vendor extensions we handle:
 *   - `reasoning_content` on assistant messages (DeepSeek-R1 / Qwen / etc.)
 *     — same role as Anthropic's `thinking` block → rendered as purple reasoning.
 */
import type { TranscriptDoc, UnifiedMessage, ToolCall, Role } from '../types';

interface ContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string; detail?: string };
  input_audio?: { data?: string; format?: string };
  file?: { file_data?: string; file_id?: string; filename?: string };
  refusal?: string;
}

interface ChatMessage {
  role?: string;
  name?: string;
  content?: string | ContentPart[] | null;
  tool_calls?: Array<{
    id?: string;
    type?: 'function' | 'custom';
    function?: { name?: string; arguments?: string };
    custom?: { name?: string; input?: string };
  }>;
  function_call?: { name?: string; arguments?: string };
  tool_call_id?: string;
  refusal?: string | null;
  reasoning_content?: string;         // DeepSeek/Qwen extension
  reasoning?: string;                 // some proxies expose the same idea differently
}

function contentPartsToText(parts: ContentPart[]): { text: string; attachments: ContentPart[]; refusal: string | undefined } {
  const textPieces: string[] = [];
  const attachments: ContentPart[] = [];
  let refusal: string | undefined;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    switch (p.type) {
      case 'text':
        if (p.text) textPieces.push(p.text);
        break;
      case 'refusal':
        if (p.refusal) refusal = p.refusal;
        break;
      case 'image_url':
      case 'input_audio':
      case 'file':
        attachments.push(p);
        break;
      default:
        // Unknown part — stringify as a code fence so it's still visible.
        textPieces.push('```json\n' + JSON.stringify(p, null, 2) + '\n```');
    }
  }
  return { text: textPieces.join('\n\n').trim(), attachments, refusal };
}

function stringifyPretty(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}

function tryParseJson(s: string): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function truncateBase64(url: string, mime = 'unknown'): string {
  if (typeof url !== 'string') return String(url);
  if (!url.startsWith('data:')) return url;
  const commaIdx = url.indexOf(',');
  const header = commaIdx >= 0 ? url.slice(0, commaIdx) : `data:${mime}`;
  const bytes = commaIdx >= 0 ? url.length - commaIdx - 1 : 0;
  return `${header}[…${(bytes / 1024).toFixed(0)}KB base64]`;
}

/** Emit a small tool-ish block describing an attachment (image / audio / file). */
function attachmentBlock(idx: number, p: ContentPart): UnifiedMessage {
  if (p.type === 'image_url') {
    const url = p.image_url?.url ?? '';
    const preview = url.startsWith('data:') ? truncateBase64(url, 'image/*') : url;
    return {
      blockIdx: idx,
      role: 'tool',
      toolName: 'image_url',
      content: `**image attachment**${p.image_url?.detail ? ` (detail: \`${p.image_url.detail}\`)` : ''}\n\n${preview}`,
      metadata: { kind: 'attachment', part_type: 'image_url' },
    };
  }
  if (p.type === 'input_audio') {
    return {
      blockIdx: idx,
      role: 'tool',
      toolName: 'input_audio',
      content: `**audio attachment** · format: \`${p.input_audio?.format ?? '?'}\`\n\n${p.input_audio?.data ? `[…${(p.input_audio.data.length / 1024).toFixed(0)}KB base64]` : ''}`,
      metadata: { kind: 'attachment', part_type: 'input_audio', format: p.input_audio?.format },
    };
  }
  if (p.type === 'file') {
    const f = p.file ?? {};
    const label = f.filename ?? f.file_id ?? '(file)';
    const body = f.file_data ? `[…${(f.file_data.length / 1024).toFixed(0)}KB base64]` : (f.file_id ? `file_id: \`${f.file_id}\`` : '');
    return {
      blockIdx: idx,
      role: 'tool',
      toolName: 'file',
      content: `**file attachment** — \`${label}\`\n\n${body}`,
      metadata: { kind: 'attachment', part_type: 'file', file_id: f.file_id, filename: f.filename },
    };
  }
  return {
    blockIdx: idx,
    role: 'tool',
    content: '```json\n' + stringifyPretty(p) + '\n```',
    metadata: { kind: 'unknown_content_part' },
  };
}

export function isOpenAIChatCompletions(root: unknown): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const o = root as any;

  // Response body: strongest signal.
  if (o.object === 'chat.completion' || o.object === 'chat.completion.chunk') return true;
  if (Array.isArray(o.choices) && o.choices.length > 0 &&
      (o.choices[0]?.message || o.choices[0]?.delta || o.choices[0]?.finish_reason !== undefined)) return true;

  // Request body must have messages[]; and must NOT look like the other schemas
  // that also carry `messages`.
  if (!Array.isArray(o.messages)) return false;

  // OpenAI Responses uses `input[]` + `instructions`, not `messages[]`.
  if (Array.isArray(o.input) && typeof o.instructions === 'string') return false;

  // Anthropic Messages: `system` is a top-level field (string or array), AND uses
  // Anthropic-only content types (`tool_use` / `tool_result` / `thinking`).
  const looksAnthropic =
    o.system !== undefined ||
    o.messages.some((m: any) =>
      Array.isArray(m?.content) &&
      m.content.some((c: any) =>
        c && typeof c === 'object' &&
        (c.type === 'tool_use' || c.type === 'tool_result' || c.type === 'thinking' || c.type === 'redacted_thinking')
      )
    );
  if (looksAnthropic) return false;

  // Anything else with `messages[]` — treat as OpenAI Chat Completions.
  // Common OpenAI-specific signals (any of them boosts confidence):
  //   * `tool_calls` on assistant
  //   * `role === "tool"` or `role === "developer"` or `role === "function"`
  //   * `content[]` part with `type: "image_url"`
  //   * top-level `tools`/`tool_choice`/`response_format`/`reasoning_effort`
  // But we don't gate on them — a bare `[{role:"user", content:"hi"}]` request
  // is still a valid Chat Completions call.
  return true;
}

export function parseOpenAIChatCompletions(root: any, filename: string): TranscriptDoc {
  const isResponse = root.object === 'chat.completion' || root.object === 'chat.completion.chunk'
    || Array.isArray(root.choices);

  const messages: UnifiedMessage[] = [];

  // Track tool_call_id → function name so a subsequent `role: "tool"` message
  // can display the function it responded to.
  const callIdToName = new Map<string, string>();

  const processMessage = (m: ChatMessage, source: 'request' | 'response' | 'delta') => {
    if (!m || typeof m !== 'object') return;
    const rawRole = String(m.role ?? '');
    const role: Role = (
      rawRole === 'system' || rawRole === 'developer' ? 'system'
      : rawRole === 'user'      ? 'user'
      : rawRole === 'assistant' ? 'assistant'
      : rawRole === 'tool'      ? 'tool'
      : rawRole === 'function'  ? 'tool'
      : 'user'
    );

    // Normalize content.
    let text = '';
    let attachments: ContentPart[] = [];
    let refusal: string | undefined;
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const parsed = contentPartsToText(m.content);
      text = parsed.text;
      attachments = parsed.attachments;
      refusal = parsed.refusal;
    }

    // Top-level `refusal` on an assistant message wins over any content refusal.
    if (m.refusal) refusal = String(m.refusal);

    // Vendor-extension reasoning (DeepSeek `reasoning_content`, some proxies use `reasoning`).
    const reasoningText =
      (typeof m.reasoning_content === 'string' && m.reasoning_content) ? m.reasoning_content :
      (typeof m.reasoning === 'string' && m.reasoning) ? m.reasoning : '';

    // ─── Emit reasoning first (before the assistant's visible text) ──────────
    if (role === 'assistant' && reasoningText) {
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        reasoning: reasoningText,
        metadata: { kind: 'reasoning', source, vendor_field: m.reasoning_content ? 'reasoning_content' : 'reasoning' },
      });
    }

    // ─── Refusal as its own error block ─────────────────────────────────────
    if (role === 'assistant' && refusal) {
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        isError: true,
        content: `**Refusal**\n\n${refusal}`,
        metadata: { kind: 'refusal', source },
      });
    }

    // ─── Main content block (unless it's a tool result — handled separately) ─
    if (role === 'tool') {
      const name = m.tool_call_id ? callIdToName.get(m.tool_call_id) : undefined;
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        toolCallId: m.tool_call_id,
        toolName: name ?? (rawRole === 'function' ? m.name : undefined),
        content: text,
        metadata: {
          kind: rawRole === 'function' ? 'function_result' : 'tool_result',
          ...(rawRole === 'function' && m.name ? { function_name: m.name } : {}),
        },
      });
    } else if (text) {
      messages.push({
        blockIdx: messages.length,
        role,
        content: text,
        metadata: {
          ...(rawRole === 'developer' ? { openai_role: 'developer' } : {}),
          ...(m.name ? { name: m.name } : {}),
          ...(source !== 'request' ? { source } : {}),
        },
      });
    }

    // ─── Attachments: one small block each ──────────────────────────────────
    for (const att of attachments) {
      const blk = attachmentBlock(messages.length, att);
      messages.push(blk);
    }

    // ─── Assistant tool_calls (new schema) ──────────────────────────────────
    if (role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.type === 'custom' && tc.custom) {
          const call: ToolCall = {
            id: tc.id ?? '',
            name: tc.custom.name ?? 'custom_tool',
            arguments: typeof tc.custom.input === 'string'
              ? tc.custom.input
              : stringifyPretty(tc.custom.input),
            argumentsParsed: tryParseJson(tc.custom.input ?? ''),
          };
          if (call.id) callIdToName.set(call.id, call.name);
          messages.push({
            blockIdx: messages.length,
            role: 'assistant',
            content: '',
            toolCalls: [call],
            metadata: { kind: 'tool_call', custom: true },
          });
        } else {
          const f = tc.function ?? {};
          const call: ToolCall = {
            id: tc.id ?? '',
            name: f.name ?? 'unknown',
            arguments: f.arguments ?? '',
            argumentsParsed: tryParseJson(f.arguments ?? ''),
          };
          if (call.id) callIdToName.set(call.id, call.name);
          messages.push({
            blockIdx: messages.length,
            role: 'assistant',
            content: '',
            toolCalls: [call],
            metadata: { kind: 'tool_call' },
          });
        }
      }
    }

    // ─── Assistant function_call (deprecated schema) ────────────────────────
    if (role === 'assistant' && m.function_call && !m.tool_calls) {
      const fc = m.function_call;
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: `fn-${messages.length}`, // deprecated schema has no id
          name: fc.name ?? 'unknown',
          arguments: fc.arguments ?? '',
          argumentsParsed: tryParseJson(fc.arguments ?? ''),
        }],
        metadata: { kind: 'function_call', deprecated_schema: true },
      });
    }

    // Empty-turn placeholder so no message is silently dropped.
    if (!text && !refusal && !reasoningText && !m.tool_calls?.length && !m.function_call && !attachments.length && role !== 'tool') {
      messages.push({
        blockIdx: messages.length,
        role,
        content: '',
        metadata: { note: 'empty-turn', source },
      });
    }
  };

  // ── Request path ─────────────────────────────────────────────────────────
  if (!isResponse) {
    for (const m of (root.messages ?? []) as ChatMessage[]) {
      processMessage(m, 'request');
    }
  }
  // ── Response path ────────────────────────────────────────────────────────
  else {
    // Non-streaming response
    if (Array.isArray(root.choices) && root.choices.length > 0) {
      for (const [idx, choice] of root.choices.entries()) {
        const m = choice?.message ?? choice?.delta;
        if (!m) continue;
        processMessage(m as ChatMessage, choice?.delta ? 'delta' : 'response');
        if (root.choices.length > 1) {
          const last = messages[messages.length - 1];
          if (last?.metadata && typeof last.metadata === 'object') {
            (last.metadata as any).choice_index = idx;
          }
        }
      }
    }
  }

  // ── Sidebar metadata ─────────────────────────────────────────────────────
  const meta: Record<string, unknown> = {
    kind: isResponse ? 'openai-chat-completions response body' : 'openai-chat-completions request body',
    model: root.model,
    stream: root.stream,
    temperature: root.temperature,
    top_p: root.top_p,
    max_tokens: root.max_tokens,
    max_completion_tokens: root.max_completion_tokens,
    reasoning_effort: root.reasoning_effort,
    response_format: root.response_format,
    tool_choice: root.tool_choice,
    parallel_tool_calls: root.parallel_tool_calls,
    verbosity: root.verbosity,
    n: root.n,
    user: root.user,
    prompt_cache_key: root.prompt_cache_key,
    safety_identifier: root.safety_identifier,
  };
  if (Array.isArray(root.tools)) {
    meta.tools_declared = root.tools
      .map((t: any) => t?.function?.name ?? t?.custom?.name ?? t?.name)
      .filter(Boolean);
  }
  if (Array.isArray(root.functions)) {
    // deprecated schema
    meta.functions_declared = root.functions.map((f: any) => f?.name).filter(Boolean);
  }
  if (root.metadata) meta.metadata = root.metadata;
  if (root.web_search_options) meta.web_search_options = root.web_search_options;

  // Response-only fields
  if (root.id) meta.response_id = root.id;
  if (root.created) meta.created = root.created;
  if (root.system_fingerprint) meta.system_fingerprint = root.system_fingerprint;
  if (root.service_tier) meta.service_tier = root.service_tier;
  if (root.usage) meta.usage = root.usage;
  if (Array.isArray(root.choices) && root.choices[0]?.finish_reason) {
    meta.finish_reason = root.choices[0].finish_reason;
  }

  // Title heuristics.
  const modelStr = String(root.model ?? '?');
  const title = isResponse
    ? `Chat Completions response (${modelStr})`
    : `Chat Completions (${modelStr})`;

  return {
    id: String(root.id ?? root.prompt_cache_key ?? root.user ?? filename),
    filename,
    source: 'openai-chat',
    meta,
    messages,
    title,
  };
}
