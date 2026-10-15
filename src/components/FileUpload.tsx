import { useRef } from 'react';
import { Upload, FileText } from 'lucide-react';
import type { TranscriptDoc } from '../types';
import { parseFile } from '../parsers/detect';

interface Props {
  onLoaded: (doc: TranscriptDoc, images: Map<string, string>) => void;
  onError: (msg: string) => void;
}

/** Basename → objectURL map for images dropped alongside the transcript. */
function buildImageMap(files: File[], exclude: File): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    if (f === exclude) continue;
    if (!f.type.startsWith('image/')) continue;
    map.set(f.name, URL.createObjectURL(f));
  }
  return map;
}

export function FileUpload({ onLoaded, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: File[]) {
    const transcript =
      files.find((f) => /\.(jsonl?|ndjson|txt)$/i.test(f.name)) ?? files[0];
    if (!transcript) return;
    try {
      const text = await transcript.text();
      const doc = parseFile(text, transcript.name);
      if (doc.messages.length === 0) {
        onError(`No messages found in ${transcript.name}. Is this a supported format?`);
        return;
      }
      onLoaded(doc, buildImageMap(files, transcript));
    } catch (e) {
      onError(`Failed to parse ${transcript.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void handleFiles(files);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Agent Trace Viewer</h1>
          <p className="text-gray-600">
            Drop an agent session file below — supports{' '}
            <code className="bg-gray-200 px-1.5 py-0.5 rounded text-sm">.jsonl</code> (Codex CLI, Claude Code, opencode export) and{' '}
            <code className="bg-gray-200 px-1.5 py-0.5 rounded text-sm">.json</code>{' '}
            (mini-swe-agent traj, Devin CLI transcripts, OpenAI Responses / Anthropic Messages gateway bodies).
          </p>
        </div>

        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="border-2 border-dashed border-gray-300 rounded-lg p-16 text-center cursor-pointer
                     hover:border-blue-400 hover:bg-blue-50/50 transition-colors bg-white"
        >
          <Upload className="w-12 h-12 mx-auto text-gray-400 mb-4" />
          <p className="text-lg font-medium text-gray-700 mb-1">
            Drag &amp; drop, or click to choose a file
          </p>
          <p className="text-sm text-gray-500">
            All parsing happens locally in your browser &mdash; nothing leaves the page.
            Drop the transcript together with its image files to resolve embedded screenshots.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".jsonl,.json,application/x-ndjson,application/json,text/plain,image/*"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void handleFiles(files);
            }}
          />
        </div>

        <div className="mt-8 grid grid-cols-2 gap-4 text-sm">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-orange-500" />
              Codex CLI
            </div>
            <code className="block text-xs text-gray-600 break-all">
              ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-blue-500" />
              Claude Code
            </div>
            <code className="block text-xs text-gray-600 break-all">
              ~/.claude/projects/&lt;slug&gt;/&lt;uuid&gt;.jsonl
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-purple-500" />
              mini-swe-agent
            </div>
            <code className="block text-xs text-gray-600 break-all">
              &lt;anywhere&gt;/*.traj.json
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-emerald-500" />
              opencode
            </div>
            <code className="block text-xs text-gray-600 break-all">
              scripts/export-opencode.py &gt; out.jsonl
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-slate-500" />
              OpenAI Responses API
            </div>
            <code className="block text-xs text-gray-600 break-all">
              POST /v1/responses
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-amber-500" />
              Anthropic Messages API
            </div>
            <code className="block text-xs text-gray-600 break-all">
              POST /v1/messages
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-teal-500" />
              OpenAI Chat Completions
            </div>
            <code className="block text-xs text-gray-600 break-all">
              POST /v1/chat/completions
            </code>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 font-medium text-gray-800 mb-2">
              <FileText className="w-4 h-4 text-indigo-500" />
              Devin CLI
            </div>
            <code className="block text-xs text-gray-600 break-all">
              ~/.local/share/devin/cli/transcripts/*.json
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}
