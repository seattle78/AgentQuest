# Approval Gate

A deterministic approval gate for Claude Code. Every tool call is decided —
**allow / ask / deny** — by regexes, path resolution and allow-lists only.
No LLM calls, no network. The gate does not try to recognize prompt injection;
it recognizes the irreversible *actions* injection tries to cause, and puts
those in front of you before they happen.

Part of the [Conductor kit](../../README.md) (AgentQuest). It also works on
its own, in any Claude Code session.

## Why

The realistic attack on a coding agent today is indirect prompt injection: a
web page, a file, an issue comment or an MCP tool description talks the agent
into sending mail it should not send, paying, deleting, or reading
credentials. Defenses that ask the model to notice the attack fail exactly
when the attack works. A hook that runs *before* the tool call and judges
only the call — its resolved paths, its recipients, its command line — cannot
be talked out of its decision.

## What happens to each kind of call

| Call | Verdict |
|---|---|
| Reads inside the project, `git status`, local build/test commands on the allow-list | **allow**, silently |
| Sends and posts (mail, messages, publishes), file writes outside the project, `git push`, downloads that execute | **ask** — the approval screen shows the resolved target, the full arguments, and where the instruction came from |
| Credential reads (`~/.ssh`, `.env`, `~/.aws`, …), `rm -rf /`, `sudo`, pipe-to-shell (`curl … \| sh`), payment POSTs, MCP servers not on the allow-list | **deny**, no appeal |
| Unknown tool | **ask** |
| Any error inside the gate | **deny** (fail closed) |

A hook `deny` holds even under `--dangerously-skip-permissions`.

## Files

| File | Role |
|---|---|
| `hook.py` | PreToolUse hook — the gate itself |
| `audit.py` | PostToolUse hook — appends every tool call to a JSONL audit log |
| `session_start.py` | SessionStart hook — hashes watched config files (`.mcp.json`, Claude Code settings) as a baseline; a mid-session change stops the next call (rug-pull detection) |
| `gate_common.py` | Shared helpers: scope loading, path resolution, baseline, audit log, masking |
| `scope.json` | Default scope, `coding` |
| `scopes/device.json` | Device-control scope: automation always asks, shell heavily restricted, no send/payment MCP servers |
| `scopes/research.json` | Research scope: web reading only, no MCP servers, no writes outside the notes folder |
| `settings.json` | Settings template for the standalone (non-plugin) install |
| `tests/` | Test harness: `python3 tests/run_tests.py` |

## Install

Plugin route (from the kit marketplace):

```bash
claude plugin install approval-gate@conductor-kit
```

Standalone route, scopes, switching scopes, the kill switch and the audit
log: see [INSTALL.md](INSTALL.md).

**Required after install:** the default scope allows only the `github` MCP
server. Add every MCP server you actually use to `allowed_mcp_servers` in
`scope.json` — calls from unlisted servers are denied.

## Honest limits

- **Server-side additions are invisible.** If a compromised MCP server adds a
  recipient (for example a BCC) while sending, that recipient never appears
  in the tool call, so the gate cannot show it to you. The defense is the
  scope allow-list: only run MCP servers you trust at all.
- **Poisoned judgment is out of scope.** The gate cannot stop an agent from
  misreading or mis-summarizing content it was allowed to read. It controls
  actions, not beliefs.
- **The audit log lives on the same machine.** An agent that can write the
  log can in principle tamper with it. Point `GATE_AUDIT_LOG` somewhere the
  agent cannot write if you need tamper evidence.
- **Approval fatigue is the biggest design risk.** If everything asks, users
  turn the gate off. That is why safe reads pass silently and only the
  irreversible asks. Do not widen `allowed_bash_prefixes` with broad prefixes
  like `npm` or `cat` — a wide prefix makes the fast path meaningless.
- **Name-based send detection over-asks on reads.** MCP tools with `message`
  or `post` in the name (for example `get_message`) also ask, because the
  gate matches name substrings to never miss a real send tool. If that
  annoys you, narrow `send_tool_patterns` in your scope and list your send
  tools by exact name instead. Servers that rename tools to dodge the
  patterns are stopped by the server allow-list.
- **An approval you do not read is worth nothing.** The approval screen
  shows the resolved path, the full arguments, the recipient/amount/URL and
  the provenance. Decide from those, not from the model's explanation.

## Tests

```bash
python3 tests/run_tests.py
```

90 checks: known attack shapes are blocked, normal coding work passes, and
the infrastructure (scope loading, baseline, audit) behaves. All must pass.

## License

Apache License 2.0 — see the kit's [LICENSE](../../LICENSE).
