/**
 * Anthropic Messages API parser (both request and response bodies).
 *
 *   request:  { model, system, messages[], max_tokens, tools?, thinking?, ... }
 *   response: { id, type:"message", role:"assistant", model, content[],
 *               stop_reason, usage, ... }
 *
 * `system` can be a plain string OR an array of content blocks
 *          `[{type:"text", text, cache_control?}, ...]`
 *
 * `messages[i].content` can be a plain string OR an array of blocks:
 *   { type:"text", text, cache_control? }
 *   { type:"thinking", thinking, signature }
 *   { type:"redacted_thinking", data }                 (present when thinking is redacted)
 *   { type:"tool_use", id:"toolu_...", name, input }   (assistant)
 *   { type:"tool_result", tool_use_id, content, is_error? }  (user)
 *   { type:"image", source:{type,media_type,data} }
 *   { type:"document", source:{...} }
 *
 * A response body is a single assistant "message" — its `content[]` items
 * follow the same schema (minus `tool_result`, which only user turns emit).
 */
import type { TranscriptDoc, UnifiedMessage, ToolCall } from '../types';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  cache_control?: unknown;
}

function extractTextOnly(blocks: AnthropicContentBlock[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n\n').trim();
}

function stringifyPretty(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}

function extractToolResultText(rawContent: unknown): string {
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return stringifyPretty(rawContent);
  // Array of {type:"text",text} | {type:"image",source} — join texts, mark images.
  return rawContent
    .map((it) => {
      if (typeof it === 'string') return it;
      const anyIt = it as any;
      if (anyIt?.type === 'text') return String(anyIt.text ?? '');
      if (anyIt?.type === 'image') return `_[image: ${anyIt.source?.media_type ?? 'unknown'}]_`;
      return JSON.stringify(anyIt);
    })
    .filter(Boolean)
    .join('\n');
}

export function isAnthropicMessages(root: unknown): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const o = root as any;

  // Response shape: type:"message" + role:"assistant" + content:[] + stop_reason
  if (o.type === 'message' && o.role === 'assistant' && Array.isArray(o.content) &&
      ('stop_reason' in o || 'usage' in o)) {
    return true;
  }

  // Request shape. `max_tokens` alone isn't enough (OpenAI Chat Completions
  // also carries `max_tokens`, deprecated but still common). We require one of:
  //   1. Anthropic-only top-level field `system` (string or array of blocks), OR
  //   2. Anthropic-only content-block types (`tool_use`, `tool_result`,
  //      `thinking`, `redacted_thinking`) appearing in any message's content, OR
  //   3. Anthropic-only top-level `thinking` config object (`{type:"enabled",
  //      budget_tokens}`) which no other API has.
  if (!Array.isArray(o.messages)) return false;

  if (o.system !== undefined) return true;

  if (o.thinking && typeof o.thinking === 'object' && 'budget_tokens' in o.thinking) return true;

  const hasAnthropicContentBlock = o.messages.some((m: any) =>
    Array.isArray(m?.content) &&
    m.content.some((c: any) =>
      c && typeof c === 'object' &&
      (c.type === 'tool_use' || c.type === 'tool_result' ||
       c.type === 'thinking' || c.type === 'redacted_thinking')
    )
  );
  if (hasAnthropicContentBlock) return true;

  return false;
}

export function parseAnthropicMessages(root: any, filename: string): TranscriptDoc {
  const isResponse = root.type === 'message' && root.role === 'assistant' && !Array.isArray(root.messages);

  const messages: UnifiedMessage[] = [];
  // Track tool_use blocks so tool_results can reference tool name.
  const useIdToName = new Map<string, string>();

  // 1) system → System block(s). May be string or array of {type:"text",text}.
  if (!isResponse) {
    const sys = root.system;
    if (typeof sys === 'string' && sys) {
      messages.push({
        blockIdx: messages.length,
        role: 'system',
        content: sys,
        metadata: { source: 'anthropic.system' },
      });
    } else if (Array.isArray(sys)) {
      for (const [i, s] of sys.entries()) {
        if (!s || typeof s !== 'object') continue;
        if (s.type !== 'text') continue;
        const text = String(s.text ?? '').trim();
        if (!text) continue;
        messages.push({
          blockIdx: messages.length,
          role: 'system',
          content: text,
          metadata: {
            source: `anthropic.system[${i}]`,
            ...(s.cache_control ? { cache_control: s.cache_control } : {}),
          },
        });
      }
    }
  }

  // 2) messages[] (request) OR just this one message (response).
  const turns: Array<{ role: string; content: unknown }> = isResponse
    ? [{ role: 'assistant', content: root.content }]
    : (Array.isArray(root.messages) ? root.messages : []);

  for (const m of turns) {
    const role = m.role;
    const raw = m.content;

    // Plain string content — simplest path.
    if (typeof raw === 'string') {
      messages.push({
        blockIdx: messages.length,
        role: role === 'user' ? 'user' : 'assistant',
        content: raw,
      });
      continue;
    }
    if (!Array.isArray(raw)) continue;
    const blocks = raw as AnthropicContentBlock[];

    // ─── ASSISTANT ─────────────────────────────────────────────────────────
    if (role === 'assistant') {
      const textStr = extractTextOnly(blocks);
      const thinkingBlocks = blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      // 2a) Standalone thinking blocks (before any text) — emit as reasoning.
      // Anthropic sends thinking first, so we emit thinking first, then text.
      for (const tb of thinkingBlocks) {
        const thinkText = tb.type === 'redacted_thinking'
          ? '_[redacted thinking]_'
          : String(tb.thinking ?? '');
        if (!thinkText) continue;
        messages.push({
          blockIdx: messages.length,
          role: 'assistant',
          content: '',
          reasoning: thinkText,
          metadata: {
            kind: 'thinking',
            redacted: tb.type === 'redacted_thinking',
            has_signature: !!tb.signature,
          },
        });
      }

      // 2b) Text content (if any) as an assistant block.
      if (textStr) {
        messages.push({
          blockIdx: messages.length,
          role: 'assistant',
          content: textStr,
        });
      }

      // 2c) Each tool_use → its own tool_call block.
      for (const tu of toolUses) {
        const tc: ToolCall = {
          id: tu.id ?? '',
          name: tu.name ?? 'unknown',
          arguments: stringifyPretty(tu.input ?? {}),
          argumentsParsed: tu.input,
        };
        if (tc.id) useIdToName.set(tc.id, tc.name);
        messages.push({
          blockIdx: messages.length,
          role: 'assistant',
          content: '',
          toolCalls: [tc],
          metadata: { kind: 'tool_use' },
        });
      }

      // If the assistant turn had nothing render-worthy, emit empty placeholder.
      if (!textStr && !thinkingBlocks.length && !toolUses.length) {
        messages.push({
          blockIdx: messages.length,
          role: 'assistant',
          content: '',
          metadata: { note: 'empty-turn' },
        });
      }
      continue;
    }

    // ─── USER ──────────────────────────────────────────────────────────────
    if (role === 'user') {
      // A user turn may bundle:
      //  - tool_result blocks (results from previous assistant tool_uses)
      //  - text blocks (the real user prompt)
      //  - image blocks
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textBlocks  = blocks.filter((b) => b.type === 'text');
      const images      = blocks.filter((b) => b.type === 'image' || b.type === 'document');

      // 3a) Emit tool_result blocks first (they logically follow assistant tool_use).
      for (const tr of toolResults) {
        const name = tr.tool_use_id ? useIdToName.get(tr.tool_use_id) : undefined;
        messages.push({
          blockIdx: messages.length,
          role: 'tool',
          toolCallId: tr.tool_use_id,
          toolName: name,
          isError: tr.is_error === true,
          content: extractToolResultText(tr.content),
          metadata: {
            kind: 'tool_result',
            ...(tr.is_error ? { is_error: true } : {}),
          },
        });
      }

      // 3b) Text (real user prompt).
      const textStr = textBlocks.map((b) => String(b.text ?? '')).join('\n\n').trim();
      if (textStr) {
        messages.push({
          blockIdx: messages.length,
          role: 'user',
          content: textStr,
          metadata: images.length ? { attachments: images.length } : undefined,
        });
      }

      // 3c) Image / document attachments — small tool-ish descriptor.
      for (const im of images) {
        const mt = im.source?.media_type ?? 'unknown';
        const preview = im.source?.data
          ? `data:${mt}[…${(im.source.data.length / 1024).toFixed(0)}KB base64]`
          : (im.source?.url ?? '');
        messages.push({
          blockIdx: messages.length,
          role: 'tool',
          toolName: im.type,
          content: `**${im.type} attachment** · ${mt}\n\n${preview}`,
          metadata: { kind: 'attachment', media_type: mt },
        });
      }

      if (!textStr && !toolResults.length && !images.length) {
        messages.push({
          blockIdx: messages.length,
          role: 'user',
          content: '',
          metadata: { note: 'empty-turn' },
        });
      }
      continue;
    }

    // Unknown role (rare) — pass through as user.
    messages.push({
      blockIdx: messages.length,
      role: 'user',
      content: extractTextOnly(blocks),
      metadata: { original_role: role },
    });
  }

  // 4) Sidebar metadata.
  const meta: Record<string, unknown> = {
    kind: isResponse ? 'anthropic-messages response body' : 'anthropic-messages request body',
    model: root.model,
    max_tokens: root.max_tokens,
    stream: root.stream,
    temperature: root.temperature,
  };
  if (root.thinking) meta.thinking = root.thinking;
  if (root.metadata) meta.metadata = root.metadata;
  if (Array.isArray(root.tools)) {
    meta.tools_declared = root.tools.map((t: any) => t?.name).filter(Boolean);
  }
  if (root.tool_choice) meta.tool_choice = root.tool_choice;
  // Response-only:
  if (root.stop_reason) meta.stop_reason = root.stop_reason;
  if (root.stop_sequence) meta.stop_sequence = root.stop_sequence;
  if (root.usage) meta.usage = root.usage;
  if (root.id) meta.response_id = root.id;

  // Client detection heuristics: user-agent-y hints in metadata.
  const userId = root.metadata?.user_id;
  const modelStr = String(root.model ?? '');
  const isClaudeAgentSDK = modelStr.startsWith('claude-') &&
    Array.isArray(root.system) && root.system.some((s: any) =>
      typeof s?.text === 'string' && s.text.startsWith('You are a Claude agent'));
  const title = isResponse
    ? `Anthropic response (${modelStr})`
    : isClaudeAgentSDK
      ? `Claude Agent SDK (${modelStr})`
      : `Anthropic Messages (${modelStr})`;

  return {
    id: String(userId ?? root.id ?? filename),
    filename,
    source: 'anthropic-messages',
    meta,
    messages,
    title,
  };
}
