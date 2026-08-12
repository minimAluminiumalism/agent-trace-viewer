#!/usr/bin/env python3
"""
Export an opencode session from its SQLite store to a `.jsonl` file that
`agent-trace-viewer` can open.

opencode stores each session across two tables:
  * `session`  — one row per session (id, title, model, agent, tokens, ...)
  * `message`  — one row per turn, `data` column is a JSON blob
                 { role, time, model?, agent?, error?, ... }
  * `part`     — one row per content fragment (text / reasoning / tool /
                 patch / file / step-start / step-finish), `data` column is
                 a JSON blob whose exact shape depends on `part.type`.

The exported jsonl has this shape (one JSON object per line):

  line 0: {"type": "opencode_session_meta", "session": {…}}
  line k: {"type": "opencode_message",
           "role": "user"|"assistant"|"tool"|"system",
           "message_id": "...",
           "time_created": <ms>,
           "parts": [ {…}, {…}, … ],
           "raw_message_data": {…}}

Parts are inlined; the viewer's `opencode.ts` parser knows how to flatten
those to `UnifiedMessage` blocks (one part → one block, mostly).

Usage:
  ./export-opencode.py --list                      # list sessions
  ./export-opencode.py <session_id> -o out.jsonl   # export one session
  ./export-opencode.py --recent 5                  # dump the 5 most recent
                                                   #   sessions to $CWD/*.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        sys.exit(f"error: opencode db not found at {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def list_sessions(conn: sqlite3.Connection, limit: int = 30) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT s.id, s.title, s.agent, s.model, s.time_created, s.time_updated,
               (SELECT COUNT(*) FROM message m WHERE m.session_id=s.id) AS n_messages,
               (SELECT COUNT(*) FROM part p WHERE p.session_id=s.id) AS n_parts
        FROM session s
        WHERE s.time_archived IS NULL
        ORDER BY s.time_updated DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def format_ts(ms: int | None) -> str:
    if not ms:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ms / 1000))


def print_session_table(rows: list[sqlite3.Row]) -> None:
    print(f"{'ID':<32}  {'UPDATED':<17}  {'MSGS':>5}  {'PARTS':>6}  {'MODEL':<26}  TITLE")
    print("-" * 120)
    for r in rows:
        title = (r["title"] or "").replace("\n", " ")
        if len(title) > 40:
            title = title[:37] + "..."
        print(
            f"{r['id']:<32}  {format_ts(r['time_updated']):<17}  "
            f"{r['n_messages']:>5}  {r['n_parts']:>6}  "
            f"{(r['model'] or '-'):<26}  {title}"
        )


def _json(cell: str) -> Any:
    if not cell:
        return None
    try:
        return json.loads(cell)
    except json.JSONDecodeError:
        return {"__parse_error": True, "raw": cell[:2000]}


def export_session(conn: sqlite3.Connection, session_id: str, out_path: Path) -> dict[str, int]:
    sess = conn.execute("SELECT * FROM session WHERE id = ?", (session_id,)).fetchone()
    if not sess:
        sys.exit(f"error: session {session_id!r} not found")

    session_meta = {k: sess[k] for k in sess.keys()}
    # `summary_diffs` and `metadata` are JSON columns — expand.
    for k in ("summary_diffs", "metadata"):
        if session_meta.get(k):
            session_meta[k] = _json(session_meta[k])

    messages = conn.execute(
        "SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id",
        (session_id,),
    ).fetchall()

    # Preload all parts once, group them by message_id.
    part_rows = conn.execute(
        "SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id",
        (session_id,),
    ).fetchall()
    parts_by_msg: dict[str, list[dict]] = {}
    for pr in part_rows:
        parts_by_msg.setdefault(pr["message_id"], []).append({
            "id": pr["id"],
            "time_created": pr["time_created"],
            "data": _json(pr["data"]),
        })

    n_msg = n_part = 0
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "opencode_session_meta", "session": session_meta},
                           ensure_ascii=False, default=str) + "\n")

        for m in messages:
            data = _json(m["data"]) or {}
            parts = parts_by_msg.get(m["id"], [])
            n_part += len(parts)
            n_msg += 1

            role = data.get("role", "user")
            f.write(json.dumps({
                "type": "opencode_message",
                "role": role,
                "message_id": m["id"],
                "time_created": m["time_created"],
                "time_updated": m["time_updated"],
                "parts": parts,
                "raw_message_data": data,
            }, ensure_ascii=False, default=str) + "\n")

    return {"messages": n_msg, "parts": n_part}


def slugify(s: str, maxlen: int = 40) -> str:
    keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
    out = "".join(c if c in keep else "-" for c in (s or "").strip())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")[:maxlen] or "session"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session_id", nargs="?", help="Session id (e.g. ses_30627...)")
    ap.add_argument("-o", "--out", type=Path, help="Output file path (defaults to <slug>.jsonl in CWD)")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"Path to opencode.db (default {DEFAULT_DB})")
    ap.add_argument("--list", action="store_true", help="List recent sessions and exit")
    ap.add_argument("--recent", type=int, metavar="N", help="Export the N most recently updated sessions")
    ap.add_argument("--outdir", type=Path, default=Path("."), help="Output directory for --recent (default: .)")
    args = ap.parse_args()

    conn = open_db(args.db)

    if args.list:
        rows = list_sessions(conn, limit=50)
        print_session_table(rows)
        return 0

    if args.recent:
        rows = list_sessions(conn, limit=args.recent)
        args.outdir.mkdir(parents=True, exist_ok=True)
        for r in rows:
            out = args.outdir / f"{r['id']}-{slugify(r['title'] or '')}.jsonl"
            stats = export_session(conn, r["id"], out)
            print(f"→ {out}  ({stats['messages']} msgs, {stats['parts']} parts)")
        return 0

    if not args.session_id:
        ap.error("session_id is required unless --list or --recent is used")

    if args.out is None:
        row = conn.execute("SELECT title FROM session WHERE id=?", (args.session_id,)).fetchone()
        title = row["title"] if row else ""
        args.out = Path(f"{args.session_id}-{slugify(title)}.jsonl")

    stats = export_session(conn, args.session_id, args.out)
    print(f"wrote {args.out}  ({stats['messages']} messages, {stats['parts']} parts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
