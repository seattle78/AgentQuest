# Changelog

## 1.2.0 — 2026-11-25

First GitHub release of the kit as AgentQuest.

### Added

- **Approval Gate plugin** (`plugins/approval-gate/`): a deterministic
  approval gate for every Claude Code tool call. A PreToolUse hook decides
  allow / ask / deny using only regexes, path resolution and allow-lists —
  no LLM calls, no network.
  - Safe reads and allow-listed local commands pass silently; sends,
    payments, deletes, force pushes and other irreversible calls ask first,
    with the resolved target, full arguments and provenance on the approval
    screen; credential reads, `rm -rf /`, `sudo`, pipe-to-shell and
    unlisted MCP servers are denied outright. Fail closed on any error;
    a hook deny holds under `--dangerously-skip-permissions`.
  - Three scopes: `coding` (default), `device`, `research`, switchable via
    an `active-scope` file or `APPROVAL_GATE_SCOPE`.
  - PostToolUse audit log (JSONL) and a SessionStart baseline that hashes
    MCP and config files and stops the next call if one changes
    mid-session (rug-pull detection).
  - 90-check test suite: `python3 plugins/approval-gate/tests/run_tests.py`.
- This changelog.

### Changed

- README and product page describe the gate alongside the conductor's
  release gates; install and uninstall instructions cover all three
  plugins.
- All plugin versions aligned at 1.2.0.

## 1.1.0 — 2026-10-26

- Conductor kit: conductor window, work sessions in isolated worktrees,
  release manager with SHA-pinned verification and one approved non-force
  push, handoffs, context-threshold hook, database write guard, tmux
  terminal mode.
- Optional conductor-board plugin: live `/board` status pane.
