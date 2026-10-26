# Conductor kit 1.1.0

Run many Claude Code sessions on one repository without losing track or shipping something
nobody approved. You talk to one **conductor** window. It hands each change to its own **work
session** in an isolated git worktree, and one **release manager** integrates the finished work
and pushes it only after you approve the exact commit.

Open `product.html` in a browser for the one-page overview.

## What is in the kit

| Plugin | What it adds |
|---|---|
| `conductor-kit` | Skills: `setup`, `conductor`, `work-session`, `release-manager`, `analyze`, `review-loop`, `handoff`. Agents: `reviewer` (read-only, top tier) and `tester`. Hooks: a database write guard, a context-threshold warning, handoff resume, and for terminal mode a session-status recorder and a tmux guard. Script: `scripts/session-manager.js` (task registry, file ownership, build lock, integration lane, tmux sessions). |
| `conductor-board` (optional) | A live status board pane (`/board`) beside the conductor chat: what waits on you, what is running, and each task's progress, refreshed every 20 seconds with no model call. |

## Requirements

- Claude Code with plugin support (the `claude plugin` command).
- Node.js 18 or later (tested on Node 26) and git 2.20 or later on `PATH`.
- A git repository with a remote and a deploy branch (default `main`).
- **For multiple sessions, one of:**
  - the Claude desktop app's Code tab, which provides the session tools the conductor uses to start
    and steer other chats; or
  - **tmux 3.x** in a terminal: each work session opens as a tmux window (see "Terminal mode").
  With neither, the conductor gives you a ready-to-paste brief for each work session instead.
- **For the board pane:** a Claude surface that renders plugin panes (the desktop app, or a terminal
  that supports them). Without it, the conductor shows the board as markdown. In a terminal the
  pane lists the tmux work sessions. If `/board` does not appear after installing, run
  `/reload-plugins`.

## Install

Unzip `conductor-kit-1.1.0.zip` anywhere you keep tools, for example `~/tools/conductor-kit`. Then:

```bash
claude plugin marketplace add ~/tools/conductor-kit
```

```bash
claude plugin install conductor-kit@conductor-kit
```

Optional, the board pane:

```bash
claude plugin install conductor-board@conductor-kit
```

Use the absolute path of the folder you unzipped (the one that contains `.claude-plugin/` and
`plugins/`). Restart Claude Code, or start a new session, so the plugins load.

## First run (once per repository)

1. Open Claude Code in the repository's main checkout.
2. Run `/conductor-kit:setup`. It creates `.conductor/` (added to `.gitignore`), detects the deploy
   branch, remote and test command, and asks one numbered list for what it cannot detect: your
   name for reports, the chat and board languages, and an optional pipeline-wait command.
3. Run `/conductor-kit:conductor` to open the conductor window. Ask for work in plain language.

## Terminal mode (tmux)

No desktop app needed. Work sessions run as windows of one tmux session.

```bash
tmux new -s work
```

Then, inside tmux, in your repository:

```bash
claude
```

and run `/conductor-kit:conductor`. When the conductor starts work, it opens a tmux window per work
session (named after the task) and one for the release manager.

- **Switch windows** with `Ctrl-b w` (a list) or `Ctrl-b n` / `Ctrl-b p`. Window 0 is your conductor.
- **Approval prompts** appear in the window that needs them. Answer them there; the conductor shows
  that session as "needs you".
- **The release approval** is typed by you in the `release-manager` window.
- **Updates:** sessions never type into your conductor window. The conductor checks every session at
  the start of each of your turns (and hourly in away mode), so say anything, for example "status",
  to get the latest.
- A session stuck in "starting" is usually showing the folder-trust question in its window.
- If the conductor is not itself inside tmux, it creates a detached tmux session named
  `conductor-kit`; attach with `tmux attach -t conductor-kit`.

How it stays safe: the conductor relays messages through a file inbox and types only one fixed
"read your inbox" line into a session's window, never your words, so a relayed message can never
pass for your approval. It types only while that session is idle at its prompt, never into an
open approval or trust dialog. Raw `tmux send-keys` from a session is denied by the kit's tmux
guard.

Working alone, without a conductor: `/conductor-kit:work-session <what you want changed>` runs one
change end to end and asks you for the release approval at the end.

## How a change flows

```text
you -> conductor -> work session (own worktree)
         analyze -> plan review -> start (branch from the deploy branch)
         -> failing tests -> implement -> one review-and-test round (2 rounds at most)
         -> commit -> integrate
       -> release manager (integration worktree)
         -> one version bump + release notes -> combined checks pinned to one SHA
         -> your approval of that SHA -> non-force push -> finalize
```

## Configuration

`.conductor/config.json` in the main checkout. Every field has a default; `setup` fills what it can.

| Field | Default | Meaning |
|---|---|---|
| `user_name` | `you` | How reports address you. |
| `language` | `English` | Chat language. Files on disk stay English. |
| `board_language` | `en` | Board labels: `en` or `ko`. |
| `remote` | `origin` | Remote to fetch from and push to. |
| `deploy_branch` | `main` | Where released code goes. Task branches start here. |
| `integration_branch` | `integration` | The lane where finished tasks are merged and verified. |
| `test_command` | empty | Full test command the release manager runs once per batch. Empty means checks are run by hand and recorded. |
| `build_command` | empty | A build two sessions must not run at once; run through the build lock. |
| `pipeline_wait_command` | empty | Exits 0 only when no deploy pipeline is running. Checked before the push; any other exit blocks the push. |
| `version_file`, `version_pattern` | empty | One file and a regex with one capture group around the version. Empty skips the version bump. |
| `worktree_base` | `~/.conductor-kit/worktrees/<repo>` | Where task and integration worktrees live. A path under `/tmp` is refused. |
| `db_write_default_patterns` | `true` | Built-in database write detection (SQL clients, document stores, migration tools, database MCP tools). |
| `db_write_patterns` | `[]` | Extra regular expressions for your own write commands, such as a seed script. |
| `review_max_rounds` | `2` | Review rounds before an open finding stops the task. |
| `tmux_session` | `conductor-kit` | Terminal mode: the tmux session for work-session windows when the conductor is not inside tmux. |
| `tmux_socket` | empty | Terminal mode: a separate tmux server (`tmux -L <name>`); empty uses your default server. |
| `claude_command` | `claude` | Terminal mode: the command each work-session window runs, for example `claude --model sonnet`. |

Environment overrides: `CONDUCTOR_KIT_MAIN` (main checkout path) and
`CONDUCTOR_KIT_WORKTREE_BASE` (worktree folder).

## Safety rules (on by default)

- **Only the approved SHA ships.** The release push takes a literal 40-character SHA that must equal
  the verified integration HEAD, and pushes it without force. If anything moves after your
  approval, the approval is void and you are asked again.
- **Fail closed before the push.** With a `pipeline_wait_command`, any non-zero exit (including
  "cannot tell") blocks the push.
- **Relayed approvals are refused for writes.** A work session does not act on an approval another
  session relays for a database write or an external call; you approve it in that session's window.
- **Every database write needs your approval.** The guard denies the first run and shows the
  report (Background, Why, How, Who, When); the identical re-run asks you. Subagents and
  auto-accepting permission modes are always denied.
- **Two review rounds at most.** A critical or major finding left after round 2 stops the task and
  comes to you.
- **Gates need evidence.** A gate is recorded only with an approved verdict and agent-run evidence;
  `integrate` needs both gates, a clean worktree and a real commit beyond the base.
- **Ownership.** A task whose files overlap a live task is queued, never run in parallel.

## Files the kit keeps

All under `.conductor/` in the main checkout (git-ignored): `config.json`, `USER.md` (your working
profile), `plans/WORK_PLAN_<task>.md`, `handoffs/`, `notes/<task>.md` (release-note drafts),
`board/BOARD.json`, `AWAY_DIGEST.md`, and `state/` (registry, per-task workflow state, build lock).

## Run the kit's own tests

From the unzipped folder:

```bash
node plugins/conductor-kit/tests/test_session_manager.js
```

```bash
node plugins/conductor-kit/tests/test_db_write_guard.js
```

```bash
node plugins/conductor-kit/tests/test_context_and_handoff_hooks.js
```

```bash
node plugins/conductor-kit/tests/test_tmux_mode.js
```

```bash
claude plugin test plugins/conductor-board
```

The session-manager tests create throwaway git repositories in your temp folder; they never touch
your projects. The tmux tests use a private tmux server that they shut down at the end, and print
"skipped" when tmux is not installed.

## Limits

- Starting and steering other sessions needs the desktop app's Code tab or tmux. Without either,
  the conductor writes each work session's brief for you to paste into a new terminal
  (`cd <repo> && claude`), or runs small work as a subagent.
- In terminal mode the conductor learns about sessions when you write to it (or on the hourly
  check), not the moment a session finishes. The tmux guard is a guard rail for the model, not a
  sandbox.
- The kit's hooks start a short Node process on each tool call (the guards before Bash, the session
  recorder after each tool). Outside a conductor repository they exit at once.
- The database guard sees commands and MCP tool calls. It cannot see writes your application code
  makes internally; add those scripts to `db_write_patterns`.
- The database guard is active in every repository once the plugin is installed, not only where
  `.conductor/` exists; outside a set-up repository it uses the default patterns. Set
  `db_write_default_patterns` to `false` in a repository's config to turn the defaults off there.
- The away-mode hourly check uses `/loop` and runs only while the conductor window is open.
- Deploy pipelines are not assumed. If pushing the deploy branch starts one, set
  `pipeline_wait_command` and confirm the deploy yourself before `finalize`.

## Uninstall

```bash
claude plugin uninstall conductor-board@conductor-kit
```

```bash
claude plugin uninstall conductor-kit@conductor-kit
```

```bash
claude plugin marketplace remove conductor-kit
```

`.conductor/` and the worktrees under `worktree_base` stay until you delete them.

## License and credits

Copyright 2026 SeungSup Shin. Licensed under the Apache License, Version 2.0
(see LICENSE). The handoff document's section structure is adapted from
REMvisual/claude-handoff (MIT); that attribution is retained.
