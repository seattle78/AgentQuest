#!/usr/bin/env python3
"""SessionStart hook -- snapshot the rug-pull baseline.

At the start of every Claude Code session, hash the watched config
files (.mcp.json, Claude Code settings files) and store the hashes in
the gate state dir. hook.py (PreToolUse) re-hashes them on every tool
call; a mid-session change is the rug-pull signal (Invariant /
MCPoison / postmark-mcp v1.0.16 pattern: clean at approval, malicious
after).

Also logs the session start to the audit log.

Usage (Claude Code settings.json):
    "SessionStart": [{"hooks": [{"type": "command",
      "command": "python3 ~/.claude/approval-gate/session_start.py"}]}]

Manual refresh (e.g. after you intentionally edit .mcp.json yourself):
    python3 ~/.claude/approval-gate/hook.py --refresh-baseline
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate_common as gc


def main():
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except Exception:
        event = {}
    cwd = event.get("cwd") or os.getcwd()
    snap = gc.snapshot_configs(cwd)
    gc.save_baseline({
        "files": snap,
        "session": event.get("session_id"),
        "source": event.get("source"),
    })
    gc.append_audit({
        "hook": "SessionStart",
        "session_id": event.get("session_id"),
        "note": "baseline snapshotted: %d watched config files" % len(snap),
        "cwd": cwd,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
