#!/usr/bin/env python3
"""PostToolUse audit hook -- append-only audit trail (gap #3 in the
research report, delivered as a side-effect of the approval gate).

Reads the PostToolUse JSON event on stdin and appends one JSONL line to
the audit log: tool, redacted arguments, outcome, changed files, and
the tool_use_id (which correlates with the PreToolUse decision logged
by hook.py).

Also refreshes the config baseline after an *approved* Write/Edit to a
watched config file, so a legitimate config edit does not trip the
rug-pull detector on the next call.

The log path is $GATE_AUDIT_LOG or ~/.claude/approval-gate/audit.jsonl.
Limitation, stated honestly: the log lives on the same machine and user
as the agent, so a sufficiently privileged agent could tamper with it.
For tamper-evidence, point GATE_AUDIT_LOG at a directory the agent's
sandbox denies writing to (e.g. a separate macOS user, or an
append-only remote syslog). The log's job is detection and forensics,
not prevention -- prevention is hook.py.
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
        return 0  # audit must never block execution

    tool = event.get("tool_name", "")
    tool_input = event.get("tool_input") or {}
    response = event.get("tool_response") or {}
    cwd = event.get("cwd") or os.getcwd()

    changed = []
    if isinstance(response, dict):
        diff = response.get("bashEditDiff") or {}
        changed = diff.get("changedFiles") or []

    record = {
        "hook": "PostToolUse",
        "session_id": event.get("session_id"),
        "tool_use_id": event.get("tool_use_id"),
        "tool": tool,
        "input": gc.redact_args(tool_input),
        "success": response.get("is_error") is not True if isinstance(response, dict) else None,
        "changed_files": changed,
        "cwd": cwd,
    }
    gc.append_audit(record)

    # Refresh the rug-pull baseline after an approved config write.
    if tool in ("Write", "Edit", "NotebookEdit"):
        path = tool_input.get("file_path") or ""
        if path:
            resolved = gc.resolve_cmd_path(path, cwd)
            if any(resolved.endswith("/" + name) or resolved == os.path.join(cwd, name)
                   for name in gc.WATCHED_CONFIG_NAMES) or \
               resolved in [os.path.realpath(p) for p in gc.WATCHED_CONFIG_HOME]:
                snap = gc.snapshot_configs(cwd)
                gc.save_baseline({"files": snap, "session": event.get("session_id")})
                gc.append_audit({
                    "hook": "PostToolUse",
                    "note": "baseline refreshed after approved config write",
                    "session_id": event.get("session_id"),
                    "tool": tool,
                    "input": {"file_path": path},
                })
    return 0


if __name__ == "__main__":
    sys.exit(main())
