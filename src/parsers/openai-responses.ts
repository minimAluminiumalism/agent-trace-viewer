/**
 * OpenAI Responses API parser (both request and response bodies).
 *
 * The Responses API superseded Chat Completions with a new shape:
 *   - request:  { model, instructions, input[], tools[], reasoning, ... }
 *   - response: { object:"response", model, instructions, output[], usage, ... }
 *
 * `input[]` / `output[]` share the same item schema:
 *
 *   { type:"message", role:"user"|"assistant"|"developer"|"system",
 *     content: [{type:"input_text"|"output_text", text}] }
 *   { type:"reasoning", summary:[{type:"summary_text",text}], encrypted_content?, content? }
 *   { type:"function_call", name, arguments (JSON string), call_id }
 *   { type:"function_call_output", call_id, output }
 *   { type:"web_search_call"|"file_search_call"|"code_interpreter_call", status, ... }
 *
 * This format is what a gateway captures when a Codex CLI (or any Responses
 * API client) talks to OpenAI. It shares 90% of its item schema with what
 * Codex writes into local rollout jsonls under `response_item.payload`.
 */
import type { TranscriptDoc, UnifiedMessage, ToolCall, Role } from '../types';

interface ContentItem {
  type?: string;         // input_text | output_text | summary_text | ...
  text?: string;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentItem[])
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

export function isOpenAIResponses(root: unknown): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const o = root as any;
  // Request shape: has instructions + input[]
  if (typeof o.instructions === 'string' && Array.isArray(o.input)) return true;
  // Response shape: object === "response" or has output[] + typical Responses fields
  if (o.object === 'response') return true;
  if (Array.isArray(o.output) && (o.reasoning !== undefined || 'previous_response_id' in o)) return true;
  return false;
}

export function parseOpenAIResponses(root: any, filename: string): TranscriptDoc {
  // Merge: response bodies carry `instructions` too; both use the same item shape.
  const isResponse = root.object === 'response' || Array.isArray(root.output);
  const items: any[] = isResponse
    ? (Array.isArray(root.output) ? root.output : [])
    : (Array.isArray(root.input)  ? root.input  : []);

  const messages: UnifiedMessage[] = [];

  // 1) instructions → System block 0.
  const instr = typeof root.instructions === 'string' ? root.instructions : '';
  if (instr) {
    messages.push({
      blockIdx: messages.length,
      role: 'system',
      content: instr,
      metadata: { source: 'openai-responses.instructions' },
    });
  }

  // 2) Track call_id → tool name so tool outputs can display the function name.
  const callIdToName = new Map<string, string>();

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const t = it.type;

    if (t === 'message') {
      const rawRole: string = it.role ?? 'user';
      // 'developer' is OpenAI's system-adjacent role for tool/permission instructions.
      const role: Role = rawRole === 'developer' ? 'system' : (rawRole as Role);
      messages.push({
        blockIdx: messages.length,
        role,
        content: extractText(it.content),
        metadata: {
          ...(rawRole === 'developer' ? { openai_role: 'developer' } : {}),
          ...(it.id ? { item_id: it.id } : {}),
          ...(it.status ? { status: it.status } : {}),
          ...(it.phase ? { phase: it.phase } : {}),
        },
      });
      continue;
    }

    if (t === 'reasoning') {
      const summaryText = extractText(it.summary);
      const bodyText = extractText(it.content);
      const text = [summaryText, bodyText].filter(Boolean).join('\n\n');
      if (!text) {
        // Reasoning with only encrypted_content — still surface a placeholder block
        // so the reader sees "there was reasoning here".
        if (it.encrypted_content) {
          messages.push({
            blockIdx: messages.length,
            role: 'assistant',
            content: '',
            reasoning: '_[encrypted reasoning — no summary]_',
            metadata: { kind: 'reasoning', encrypted: true, item_id: it.id },
          });
        }
        continue;
      }
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        reasoning: text,
        metadata: { kind: 'reasoning', encrypted: !!it.encrypted_content, item_id: it.id },
      });
      continue;
    }

    if (t === 'function_call') {
      const parsedArgs = tryParseJson(it.arguments ?? '');
      const tc: ToolCall = {
        id: it.call_id ?? '',
        name: it.name ?? 'unknown',
        arguments: it.arguments ?? '',
        argumentsParsed: parsedArgs,
      };
      if (tc.id) callIdToName.set(tc.id, tc.name);
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: '',
        toolCalls: [tc],
        metadata: { kind: 'function_call', status: it.status },
      });
      continue;
    }

    if (t === 'function_call_output') {
      const name = callIdToName.get(it.call_id ?? '');
      const outputText = typeof it.output === 'string'
        ? it.output
        : (it.output != null ? JSON.stringify(it.output, null, 2) : '');
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        toolCallId: it.call_id,
        toolName: name,
        content: outputText,
        metadata: { kind: 'function_call_output' },
      });
      continue;
    }

    // Built-in Responses tools (web_search_call, file_search_call,
    // code_interpreter_call, computer_call, ...): surface as a compact tool block.
    if (typeof t === 'string' && (t.endsWith('_call') || t.endsWith('_call_output'))) {
      const parts: string[] = [`**${t}**`];
      if (it.status) parts.push(`status: \`${it.status}\``);
      // Include any structured payload (queries, code, etc.)
      const extra = { ...it };
      delete extra.type; delete extra.status; delete extra.id;
      if (Object.keys(extra).length > 0) {
        parts.push('```json\n' + JSON.stringify(extra, null, 2) + '\n```');
      }
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        toolName: t,
        content: parts.join('\n\n'),
        metadata: { kind: 'builtin_tool', item_id: it.id, status: it.status },
      });
      continue;
    }

    // Unknown item type — surface for debugging visibility.
    messages.push({
      blockIdx: messages.length,
      role: 'tool',
      content: '```json\n' + JSON.stringify(it, null, 2) + '\n```',
      metadata: { kind: 'unknown_item', item_type: t, item_id: it.id },
    });
  }

  // 3) Session-level metadata for the sidebar.
  const meta: Record<string, unknown> = {
    kind: isResponse ? 'openai-responses response body' : 'openai-responses request body',
    model: root.model,
    reasoning_effort: root.reasoning?.effort,
    reasoning_summary: root.reasoning?.summary,
    tool_choice: root.tool_choice,
    parallel_tool_calls: root.parallel_tool_calls,
    stream: root.stream,
    store: root.store,
    text_verbosity: root.text?.verbosity,
  };
  if (root.client_metadata) meta.client_metadata = root.client_metadata;
  if (root.metadata) meta.metadata = root.metadata;
  if (root.prompt_cache_key) meta.prompt_cache_key = root.prompt_cache_key;
  if (root.include) meta.include = root.include;
  // Response-body only
  if (root.usage) meta.usage = root.usage;
  if (root.status) meta.response_status = root.status;
  if (root.id) meta.response_id = root.id;
  if (root.previous_response_id) meta.previous_response_id = root.previous_response_id;
  // Registered tool names for reference.
  if (Array.isArray(root.tools)) {
    meta.tools_declared = root.tools.map((t: any) => t?.name).filter(Boolean);
  }

  // Client detection: Codex CLI signature in client_metadata.
  const cm = root.client_metadata ?? {};
  const isCodexClient = !!(cm['x-codex-window-id'] || cm['x-codex-installation-id']);
  const title = isCodexClient
    ? `Codex via Responses API (${root.model ?? '?'})`
    : `OpenAI Responses (${root.model ?? '?'})`;

  const sessionId = cm.session_id ?? cm.thread_id ?? root.prompt_cache_key ?? root.id ?? filename;

  return {
    id: String(sessionId),
    filename,
    source: 'openai-responses',
    meta,
    messages,
    title,
  };
}
