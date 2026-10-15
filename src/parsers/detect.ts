/**
 * Detect the source format from the first few lines / whole file, then delegate.
 *
 * Accepts BOTH:
 *   - `.jsonl` files (line-oriented) — Codex, Claude Code, opencode export
 *   - `.json`  files (single top-level value) — mini-swe-agent `.traj.json`
 */
import type { TranscriptDoc } from '../types';
import { isCodexRollout, parseCodex } from './codex';
import { isClaudeCodeOrGeneric, parseClaudeCodeOrGeneric } from './claude';
import { isMiniSweAgent, parseMiniSweAgent } from './mini-swe-agent';
import { isOpencodeExport, parseOpencode } from './opencode';
import { isOpenAIResponses, parseOpenAIResponses } from './openai-responses';
import { isAnthropicMessages, parseAnthropicMessages } from './anthropic-messages';
import { isOpenAIChatCompletions, parseOpenAIChatCompletions } from './openai-chat-completions';
import { isDevin, parseDevin } from './devin';

/** Best-effort: try to parse as a single JSON value; if that fails, fall through to jsonl. */
function tryParseSingleJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // If the first non-whitespace char isn't `{`/`[`, this can't be a single JSON value.
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export function parseFile(text: string, filename: string): TranscriptDoc {
  // ── 1. Try single-JSON shapes ────────────────────────────────────────────
  const single = tryParseSingleJson(text);
  if (single != null) {
    // Order matters: check the most-specific shapes BEFORE the fallback that
    // treats any {messages:[]} as generic OpenAI Chat Completions.
    if (isDevin(single)) return parseDevin(single as any, filename);
    if (isOpenAIResponses(single)) return parseOpenAIResponses(single, filename);
    if (isAnthropicMessages(single)) return parseAnthropicMessages(single, filename);
    if (isOpenAIChatCompletions(single)) return parseOpenAIChatCompletions(single, filename);
    if (isMiniSweAgent(single)) return parseMiniSweAgent(single as any[], filename);
    // Wrapped shapes / bare arrays fall through to the generic chat parser.
    if (single && typeof single === 'object' && !Array.isArray(single)) {
      const anyObj = single as any;
      if (Array.isArray(anyObj.messages)) {
        return parseClaudeCodeOrGeneric(
          anyObj.messages.map((m: unknown) => JSON.stringify(m)),
          filename,
        );
      }
      if (Array.isArray(anyObj.conversation)) {
        return parseClaudeCodeOrGeneric(
          anyObj.conversation.map((m: unknown) => JSON.stringify(m)),
          filename,
        );
      }
    }
    if (Array.isArray(single)) {
      return parseClaudeCodeOrGeneric(
        (single as unknown[]).map((m) => JSON.stringify(m)),
        filename,
      );
    }
  }

  // ── 2. jsonl shapes ──────────────────────────────────────────────────────
  const lines = text.split(/\r?\n/);
  const sample: object[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    try {
      sample.push(JSON.parse(t));
      if (sample.length >= 5) break;
    } catch { /* keep sampling */ }
  }

  if (isOpencodeExport(sample)) return parseOpencode(lines, filename);
  if (isCodexRollout(sample)) return parseCodex(lines, filename);
  if (isClaudeCodeOrGeneric(sample)) return parseClaudeCodeOrGeneric(lines, filename);

  // Fallback: try generic parse anyway.
  return parseClaudeCodeOrGeneric(lines, filename);
}

// Back-compat alias for the old public name.
export const parseJsonl = parseFile;
