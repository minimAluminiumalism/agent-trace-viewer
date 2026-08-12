/**
 * mini-swe-agent trajectory parser.
 *
 * Source format: NOT jsonl — a single JSON file (`.traj.json`) whose top-level
 * value is a `[{role, content}, ...]` array. Only three roles ever appear
 * (system, user, assistant); tool interactions are embedded in the content:
 *
 *   assistant: "THOUGHT ...\n\n```mswea_bash_command\n<cmd>\n```\n"
 *              → we treat the fenced block as a synthesized tool_call.
 *
 *   user:      "<returncode>N</returncode>\n<output>\n...\n</output>"
 *              → we treat this as a synthesized tool result (role='tool').
 *
 * See mini-swe-agent's system prompt for the fence marker (`mswea_bash_command`).
 */
import type { TranscriptDoc, UnifiedMessage, ToolCall } from '../types';

interface MSweaRaw {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
  [key: string]: unknown;
}

const CMD_FENCE_RE = /```mswea_bash_command\s*\n([\s\S]*?)```/g;
const RESULT_RE = /^\s*<returncode>(-?\d+)<\/returncode>\s*\n<output>\s*\n?([\s\S]*?)\n?<\/output>\s*$/;

export function isMiniSweAgent(root: unknown): boolean {
  // Only match top-level arrays where every element looks like a chat message,
  // and at least one assistant content contains the mswea_bash_command fence
  // OR at least one user content matches the <returncode>+<output> pattern.
  // The fence pattern is very specific to mini-swe-agent's harness.
  if (!Array.isArray(root) || root.length === 0) return false;
  let looksLikeChat = 0;
  let hasSignal = false;
  for (const m of root as MSweaRaw[]) {
    if (m && typeof m === 'object' && typeof m.content === 'string' &&
        ['system', 'user', 'assistant'].includes(m.role)) {
      looksLikeChat++;
      if (/```mswea_bash_command/.test(m.content)) hasSignal = true;
      if (/<returncode>-?\d+<\/returncode>/.test(m.content)) hasSignal = true;
    }
  }
  return looksLikeChat === root.length && hasSignal;
}

/**
 * Extract the "thought" prefix and any tool-call fences from an assistant message.
 * Returns { thought, toolCalls[] } — thought is content minus the fence blocks.
 */
function splitAssistant(content: string): { thought: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let i = 0;
  CMD_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CMD_FENCE_RE.exec(content)) !== null) {
    const cmd = m[1].trim();
    toolCalls.push({
      id: `mswea-call-${i}`,
      name: 'bash',
      arguments: JSON.stringify({ cmd }, null, 2),
      argumentsParsed: { cmd },
    });
    i++;
  }
  // Remove fences from the visible "thought" content.
  const thought = content.replace(CMD_FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { thought, toolCalls };
}

/** If a user message is purely a <returncode>+<output> block, treat it as tool output. */
function tryParseToolResult(content: string): { rc: number; output: string } | null {
  const m = RESULT_RE.exec(content);
  if (!m) return null;
  return { rc: parseInt(m[1], 10), output: m[2] };
}

export function parseMiniSweAgent(root: MSweaRaw[], filename: string): TranscriptDoc {
  const messages: UnifiedMessage[] = [];
  let lastCallId: string | undefined;

  for (const raw of root) {
    const role = raw.role;
    const content = String(raw.content ?? '');

    if (role === 'assistant') {
      const { thought, toolCalls } = splitAssistant(content);
      lastCallId = toolCalls[toolCalls.length - 1]?.id;
      messages.push({
        blockIdx: messages.length,
        role: 'assistant',
        content: thought,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });
      continue;
    }

    if (role === 'user') {
      const tr = tryParseToolResult(content);
      if (tr) {
        messages.push({
          blockIdx: messages.length,
          role: 'tool',
          toolCallId: lastCallId,
          toolName: 'bash',
          isError: tr.rc !== 0,
          content: tr.output || '(empty output)',
          metadata: { returncode: tr.rc, synthesized_from: 'mini-swe-agent user message' },
        });
        continue;
      }
      // Real user prompt
      messages.push({
        blockIdx: messages.length,
        role: 'user',
        content,
      });
      continue;
    }

    if (role === 'system') {
      messages.push({
        blockIdx: messages.length,
        role: 'system',
        content,
      });
      continue;
    }

    // Unknown role — pass through as user
    messages.push({
      blockIdx: messages.length,
      role: 'user',
      content,
      metadata: { original_role: role },
    });
  }

  return {
    id: filename,
    filename,
    source: 'mini-swe-agent',
    meta: {
      format: 'mini-swe-agent .traj.json',
      message_count: root.length,
      block_count: messages.length,
    },
    messages,
    title: filename.replace(/\.traj\.json$/i, '').slice(0, 24),
  };
}
