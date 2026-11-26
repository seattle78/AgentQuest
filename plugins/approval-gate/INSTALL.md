# Approval Gate — install guide

The gate is deterministic: regexes, path resolution and allow-lists only.
It never needs to "recognize" a prompt injection — it only needs to
recognize irreversible **actions**. What each file does is listed in
[README.md](README.md).

Two install routes: as a plugin (recommended) or standalone, by copying the
files into `~/.claude/approval-gate/` and merging a settings template.

## Route A — plugin install

From the Conductor kit marketplace:

```bash
claude plugin marketplace add seattle78/AgentQuest
claude plugin install approval-gate@conductor-kit
```

The plugin registers the three hooks from `hooks/hooks.json`
(PreToolUse → `hook.py`, PostToolUse → `audit.py`, SessionStart →
`session_start.py`) and reads its default scope from the `scope.json`
shipped beside the scripts. Runtime state (audit log, baseline) is kept
under `~/.claude/approval-gate/` regardless of install route.

Then do step 3 below (your MCP servers) — the default scope allows only
`github`.

## Route B — standalone install

### 1. Copy the files into place

```sh
mkdir -p ~/.claude/approval-gate
cp -r /path/to/plugins/approval-gate/* ~/.claude/approval-gate/
```

No dependencies beyond system Python 3. No network calls, no LLM calls.

### 2. Merge `settings.json` (never overwrite)

If `~/.claude/settings.json` already exists, **merge** — replacing it
wholesale with this folder's `settings.json` would wipe your existing
settings (model, permission rules).

1. Open `~/.claude/settings.json` (create it if missing).
2. Copy the whole `hooks` block from this folder's `settings.json` into it.
   If you already have `hooks`, add the PreToolUse / PostToolUse /
   SessionStart entries to the existing lists — hooks are lists and merge
   across files, so existing hooks keep working.
3. Adding `permissions` and `disableBypassPermissionsMode` from the
   template is recommended: they are Claude Code's own permission rules
   and double up with the hook.

Settings precedence (verified 2026-11-25): Claude Code reads settings
from highest to lowest — managed, CLI `--settings`, project local
(`.claude/settings.local.json`), shared project (`.claude/settings.json`),
user (`~/.claude/settings.json`). Scalars: the higher file wins. Lists
(`permissions.allow` / `deny`, `hooks`) are **merged from all files**.

What that means for installation:

- Installing at user level (`~/.claude/settings.json`) covers every
  project on the machine.
- A project file cannot remove your user-level hooks — lists merge, they
  do not replace. (A project can add hooks of its own.)
- A `deny` rule beats an `allow` at any level.
- **`--dangerously-skip-permissions` cannot bypass a PreToolUse deny.**
  The hook still runs and still blocks the call.

## 3. Add your MCP servers (required)

The default scope allows exactly one MCP server: `github`. **List every
server you use in `allowed_mcp_servers` in `scope.json`** (plugin route:
the `scope.json` in the plugin folder; standalone: the copy in
`~/.claude/approval-gate/`). Write the name exactly as Claude Code shows
it — the `<server>` part of `mcp__<server>__<tool>`. Calls from unlisted
servers are denied.

The `device` and `research` scopes ship with an empty allow-list; fill
them the same way if you need servers there.

## 4. Pick a scope

Default is `scope.json` (`coding`). Selection order:

1. `--scope <name|path>` argument on the hook command
2. `APPROVAL_GATE_SCOPE` environment variable (path to a scope JSON)
3. A scope name in `~/.claude/approval-gate/active-scope` (one line)
4. `scope.json`

Switch to the device-control scope:

```sh
echo device > ~/.claude/approval-gate/active-scope
```

Back to default:

```sh
rm ~/.claude/approval-gate/active-scope
```

## 5. Verify the install

```sh
cd ~/.claude/approval-gate        # or the plugin folder
python3 tests/run_tests.py        # everything must pass
```

In Claude Code, `/hooks` shows the three hooks. Spot-check by asking the
agent to run:

- `cat ~/.ssh/id_rsa` — must be **denied**
- `git push --force` — must **ask**
- `git status` — must pass **silently**

## Baseline (rug-pull detection)

At session start, `session_start.py` hashes the watched config files
(`.mcp.json`, the Claude Code settings files). If one changes mid-session,
the next tool call is blocked or asks.

If you edited `.mcp.json` on purpose, re-take the baseline:

```sh
python3 ~/.claude/approval-gate/hook.py --refresh-baseline
```

## Kill switch (emergencies only)

```sh
APPROVAL_GATE_DISABLE=1 claude     # gate off for this session only
```

Or set `"enabled": false` in the scope file. Do not leave it off.

## Audit log

Default location: `~/.claude/approval-gate/audit.jsonl` (one JSON line per
tool call). Override with `GATE_AUDIT_LOG`.

```sh
tail -f ~/.claude/approval-gate/audit.jsonl
```

## Maintenance

- Re-check your scopes whenever you update an MCP server or a skill (a
  free scanner such as `mcp-scan` shows whether tool descriptions
  changed).
- Add domains and servers to a scope with least privilege only.
- If anything behaves oddly, suspect the gate first and re-run
  `tests/run_tests.py`.
