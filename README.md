# Agent Trace Viewer

A minimal, **fully client-side** viewer for agent session traces. Inspired by [Transluce Docent](https://github.com/TransluceAI/docent), but
stripped to the presentation layer.

![Agent Trace Viewer](docs/screenshot.png)


## Supported formats

| Source | File | Detected by |
|---|---|---|
| Codex CLI rollouts | `.jsonl` | first line `type: "session_meta"` |
| Claude Code / generic chat | `.jsonl` | line-oriented `{role, content}` |
| mini-swe-agent trajectory | `.json` (array) | assistant `` ```mswea_bash_command `` fences |
| opencode sessions | `.jsonl` (via export script) | first line `type: "opencode_session_meta"` |
| Devin CLI transcripts | `.json` | `schema_version: "ATIF-*"` |
| OpenAI Responses API | `.json` | `input[]` + `instructions`, or `object: "response"` |
| Anthropic Messages API | `.json` | top-level `system` field, or content blocks with `tool_use` / `tool_result` / `thinking` |
| OpenAI Chat Completions | `.json` | `messages[]` / `choices[]` (also matches OpenAI-compatible endpoints — DeepSeek, Qwen, LiteLLM, vLLM, …) |


## Quick start

```bash
npm install
npm run dev        # → http://localhost:5173
```

Then drag any supported file into the drop zone.

Local session locations (if you have them):
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Claude Code: `~/.claude/projects/<slug>/<uuid>.jsonl`
- mini-swe-agent: any `*.traj.json`
- Devin CLI: `~/.local/share/devin/cli/transcripts/<name>.json`

For opencode, sessions live in SQLite — export first:

```bash
./scripts/export-opencode.py --list                    # list recent
./scripts/export-opencode.py <session_id> -o out.jsonl # export one
./scripts/export-opencode.py --recent 5 --outdir ./    # bulk-export
```

## Images in traces

Whether pasted screenshots render depends on how the source format stores them:

- **Path-only formats — Devin CLI**: transcripts record the local file path
  (`/private/tmp/.../Clipboard_Screenshot_*.png`), not the image bytes. The
  browser cannot read those paths, so images render as placeholder chips
  unless one of these applies:
  - `npm run dev`: the dev server exposes `/local-img?path=…`, which serves
    the file straight from disk — images "just work" for local sessions.
  - Drop the image files together with the transcript (matched by basename),
    or drop them onto the viewer afterwards.
  - Pre-embed them with `scripts/embed-images.py session.json -o out.json`
    to produce a self-contained file (base64 inline) that renders anywhere,
    including a hosted/static deployment.
- **Embedded formats — Anthropic Messages, OpenAI Chat**: the bytes travel in
  the file (base64 / `image_url`), but the parsers currently render them as
  small attachment descriptor blocks rather than inline images.
- **mini-swe-agent** is a text-only protocol — no images to begin with.

## Production build

```bash
npm run build
npm run preview
```

## Add a new source

1. Create `src/parsers/foo.ts` with:
   ```ts
   export function isFoo(firstLines: object[]): boolean { … }
   export function parseFoo(rawLines: string[], filename: string): TranscriptDoc { … }
   ```
2. Add a dispatch line in `src/parsers/detect.ts` (before the generic fallback).
3. Optional: add a badge color in `Sidebar.tsx` and a `source` literal in `types.ts`.
