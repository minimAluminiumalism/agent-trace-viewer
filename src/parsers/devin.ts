/**
 * Devin CLI session transcript parser (ATIF schema).
 *
 * Devin CLI persists one JSON file per session under
 *   ~/.local/share/devin/cli/transcripts/<session-name>.json
 *
 * Shape (verified against schema_version "ATIF-v1.7"):
 *   {
 *     schema_version: "ATIF-v1.7",
 *     session_id: "equatorial-bestseller",
 *     agent: { name: "devin", version, model_name, extra: { backend, permission_mode } },
 *     steps: [{
 *       step_id, timestamp,
 *       source: "system" | "user" | "agent",
 *       message: string | Array<{type:"text",text} | {type:"image",source:{media_type,path}}>,
 *       reasoning_content?: string,                               // agent only
 *       tool_calls?: [{ tool_call_id, function_name, arguments }],// agent only
 *       observation?: { results: [{ source_call_id, content }] }, // agent only
 *       metrics?: { prompt_tokens, completion_tokens, cached_tokens },
 *     }],
 *     final_metrics: { total_prompt_tokens, total_completion_tokens, ... },
 *   }
 *
 * Notes:
 *   - An "agent" step carries BOTH its tool_calls and the observation results
 *     for those calls. We emit one assistant block (text + reasoning + calls)
 *    followed by one `tool` block per result.
 *   - `message` image items reference local file paths (clipboard screenshots),
 *     which the browser cannot read — surfaced via `UnifiedMessage.images` and
 *     resolved at render time against user-dropped files by basename.
 */
import type { TranscriptDoc, UnifiedMessage, TraceImage, ToolCall } from '../types';

interface AtifContentItem {
  type?: string;
  text?: string;
  source?: { media_type?: string; path?: string; url?: string; data?: string };
}

interface AtifToolCall {
  tool_call_id?: string;
  function_name?: string;
  arguments?: unknown;
}

interface AtifResult {
  source_call_id?: string;
  content?: unknown;
}

interface AtifStep {
  step_id?: number;
  timestamp?: string;
  source?: string;
  message?: string | AtifContentItem[];
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results?: AtifResult[] };
  metrics?: Record<string, unknown>;
  model_name?: string;
}

interface AtifRoot {
  schema_version?: string;
  session_id?: string;
  agent?: {
    name?: string;
    version?: string;
    model_name?: string;
    extra?: Record<string, unknown>;
  };
  steps?: AtifStep[];
  final_metrics?: Record<string, unknown>;
}

export function isDevin(root: unknown): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const r = root as AtifRoot;
  if (typeof r.schema_version === 'string' && r.schema_version.startsWith('ATIF')) return true;
  return r.agent?.name === 'devin' && Array.isArray(r.steps);
}

/** Split an ATIF `message` field into flat text + image refs. */
function splitMessage(message: AtifStep['message']): { text: string; images: TraceImage[] } {
  const images: TraceImage[] = [];
  if (typeof message === 'string') return { text: message, images };
  if (!Array.isArray(message)) return { text: '', images };

  const texts: string[] = [];
  for (const it of message) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'image') {
      const src = it.source ?? {};
      images.push({
        mediaType: src.media_type,
        path: src.path,
        url: src.url ?? (src.data ? `data:${src.media_type ?? 'image/png'};base64,${src.data}` : undefined),
      });
    } else {
      const t = typeof it.text === 'string' ? it.text : '';
      if (t) texts.push(t);
    }
  }
  return { text: texts.join('\n\n'), images };
}

function looksLikeToolError(content: string): boolean {
  const s = content.trim();
  if (/^Exit code: [1-9]\d*$/m.test(s)) return true;
  if (/^(Error|error|Traceback)\b/.test(s)) return true;
  return false;
}

export function parseDevin(root: AtifRoot, filename: string): TranscriptDoc {
  const steps = Array.isArray(root.steps) ? root.steps : [];
  const messages: UnifiedMessage[] = [];

  const meta: Record<string, unknown> = {
    session_id: root.session_id,
    agent: root.agent?.name,
    agent_version: root.agent?.version,
    model: root.agent?.model_name,
    backend: root.agent?.extra?.backend,
    permission_mode: root.agent?.extra?.permission_mode,
  };
  const fm = root.final_metrics ?? {};
  meta.prompt_tokens = fm.total_prompt_tokens;
  meta.completion_tokens = fm.total_completion_tokens;
  meta.cached_tokens = fm.total_cached_tokens;

  for (const step of steps) {
    const { text, images } = splitMessage(step.message);
    const stepMeta: Record<string, unknown> = { step_id: step.step_id };
    if (step.model_name) stepMeta.model = step.model_name;
    if (step.metrics) stepMeta.tokens = step.metrics;

    if (step.source === 'system') {
      if (!text) continue;
      messages.push({
        blockIdx: messages.length,
        role: 'system',
        content: text,
        images: images.length ? images : undefined,
        timestamp: step.timestamp,
        metadata: stepMeta,
      });
      continue;
    }

    if (step.source === 'user') {
      messages.push({
        blockIdx: messages.length,
        role: 'user',
        content: text,
        images: images.length ? images : undefined,
        timestamp: step.timestamp,
        metadata: stepMeta,
      });
      continue;
    }

    // ── agent step ────────────────────────────────────────────────────────
    const toolCalls: ToolCall[] = (step.tool_calls ?? []).map((tc) => ({
      id: tc.tool_call_id ?? '',
      name: tc.function_name ?? 'unknown',
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}, null, 2),
      argumentsParsed: tc.arguments,
    }));

    // Name lookup for tool-result blocks (source_call_id → function_name).
    const nameByCallId = new Map<string, string>();
    for (const tc of step.tool_calls ?? []) {
      if (tc.tool_call_id) nameByCallId.set(tc.tool_call_id, tc.function_name ?? 'unknown');
    }

    const hasVisibleBody = !!(text || step.reasoning_content || toolCalls.length || images.length);
    if (hasVisibleBody) {
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: text,
        reasoning: step.reasoning_content || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        images: images.length ? images : undefined,
        timestamp: step.timestamp,
        metadata: stepMeta,
      });
    }

    for (const r of step.observation?.results ?? []) {
      const content = typeof r.content === 'string'
        ? r.content
        : JSON.stringify(r.content ?? '', null, 2);
      messages.push({
        blockIdx: messages.length,
        role: 'tool',
        content,
        toolCallId: r.source_call_id,
        toolName: r.source_call_id ? nameByCallId.get(r.source_call_id) : undefined,
        isError: looksLikeToolError(content),
        timestamp: step.timestamp,
        metadata: { step_id: step.step_id },
      });
    }
  }

  const sid = String(root.session_id ?? filename);
  return {
    id: sid,
    filename,
    source: 'devin',
    meta,
    messages,
    title: sid,
  };
}
