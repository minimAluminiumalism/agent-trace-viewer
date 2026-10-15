/**
 * Unified data model — mirrors the shape Docent uses (AgentRun / Transcript / ChatMessage),
 * so parsers for different source formats all reduce to the same target structure.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Pretty-printed args (may be JSON). Kept as-is from the source. */
  arguments: string;
  /** Optional structured args if parseable. */
  argumentsParsed?: unknown;
}

export interface TraceImage {
  /** Original media type, e.g. image/png. */
  mediaType?: string;
  /**
   * Local file path recorded in the trace. Not loadable directly from the
   * browser — resolved against user-dropped files by basename.
   */
  path?: string;
  /** Inline data URL or remote URL, when the source embeds the bytes. */
  url?: string;
}

export interface UnifiedMessage {
  /** Stable per-transcript index (0-based, monotonically increasing over the block sequence). */
  blockIdx: number;
  role: Role;
  /** Primary text content (may be markdown). */
  content: string;
  /** For assistant messages — reasoning/thinking trace. */
  reasoning?: string;
  /** For assistant messages — tool calls emitted this turn. */
  toolCalls?: ToolCall[];
  /** For tool messages — the id linking back to the originating call. */
  toolCallId?: string;
  /** For tool messages — the tool/function name. */
  toolName?: string;
  /** True if this represents an error (rendered as red block). */
  isError?: boolean;
  /** Inline images attached to the message (screenshots, pastes). */
  images?: TraceImage[];
  /** Per-message metadata (rendered in a popover). */
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface TranscriptDoc {
  /** Session id, e.g. Codex session uuid. */
  id: string;
  /** File name it was parsed from. */
  filename: string;
  /** Original source format tag. */
  source: 'codex' | 'claude-code' | 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'mini-swe-agent' | 'opencode' | 'devin' | 'generic';
  /** Session-level metadata (cwd, model, cli version, etc.). */
  meta: Record<string, unknown>;
  /** Ordered block list (post-normalization / de-dup). */
  messages: UnifiedMessage[];
  /** Optional agent-run level notes. */
  title?: string;
}
