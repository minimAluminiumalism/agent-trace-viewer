#!/usr/bin/env python3
"""
Embed local images referenced by a trace file as base64 data, producing a
single self-contained JSON that agent-trace-viewer can open anywhere
(including the production build, where the dev server's /local-img endpoint
is unavailable).

Currently handles Devin CLI transcripts (ATIF schema): each step's `message`
may be an array containing {"type": "image", "source": {"media_type", "path"}}
items. The script reads each referenced file and writes it back as
`source.data` (base64), keeping `path` for display.

Usage:
  ./embed-images.py session.json -o session-with-images.json
  ./embed-images.py ~/.local/share/devin/cli/transcripts/<name>.json -o out.json
"""
import argparse
import base64
import json
import mimetypes
import os
import sys


def embed(path: str) -> str | None:
    if not path or not os.path.isfile(path):
        return None
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def process(doc: dict) -> tuple[int, int]:
    embedded = missing = 0
    for step in doc.get('steps', []):
        msg = step.get('message')
        if not isinstance(msg, list):
            continue
        for item in msg:
            if not isinstance(item, dict) or item.get('type') != 'image':
                continue
            src = item.setdefault('source', {})
            if src.get('data') or src.get('url'):
                continue
            data = embed(src.get('path', ''))
            if data is None:
                missing += 1
                continue
            src['data'] = data
            if not src.get('media_type'):
                src['media_type'] = mimetypes.guess_type(src.get('path', ''))[0] or 'image/png'
            embedded += 1
    return embedded, missing


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='transcript JSON (e.g. a Devin ATIF file)')
    ap.add_argument('-o', '--output', required=True, help='output JSON path')
    args = ap.parse_args()

    with open(args.input) as f:
        doc = json.load(f)

    embedded, missing = process(doc)
    with open(args.output, 'w') as f:
        json.dump(doc, f, ensure_ascii=False)

    size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f'{args.output}: embedded {embedded} image(s), {missing} missing, {size_mb:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
