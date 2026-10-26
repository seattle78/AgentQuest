---
name: setup
description: First-run setup of the conductor kit in the current repository. Creates the .conductor/ state folder and its config, detects the deploy branch and test command, asks only for what cannot be detected, and checks the repository is ready for isolated worktrees. Use once per repository, or when the user says "set up the conductor kit", "configure conductor", or a kit command reports a missing config.
user-invocable: true
---

# Conductor kit setup

$ARGUMENTS

SM below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.js"`.

1. **Initialize.** Run `SM init`. It creates `.conductor/` (config, plans, handoffs, board, state)
   in the main checkout and adds `.conductor/` to `.gitignore`. Tell the user in one line that
   `.gitignore` changed, if it did; do not commit it for them.
2. **Detect, do not ask.** Fill what the repository already says, and state each value in one line:
   - `deploy_branch`: the remote's default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`,
     without the `origin/` prefix), else `main`.
   - `remote`: `origin` when it exists, else the only remote.
   - `test_command`: the project's own full test command (for example `npm test`, `pytest -q`,
     `go test ./...`, `cargo test`, `make test`), read from its manifest or contributing guide. This is
     the command the release manager runs once per batch in the integration worktree.
   - `build_command`: only when the project has a build step that two sessions must not run at
     once (a container build, a shared cache). Otherwise leave it empty.
   - `version_file` and `version_pattern`: only when the project keeps one version string in one
     file (for example `package.json` with `"version":\s*"([^"]+)"`). The pattern needs exactly
     one capture group around the version. Otherwise leave both empty, and releases skip the bump.
3. **Ask once, only for what has no safe default**, as one numbered list with the default for each:
   the user's name for reports (`user_name`, default "you"), the chat language (`language`,
   default English), the board language (`board_language`, `en` or `ko`), and a
   `pipeline_wait_command` if pushing to the deploy branch starts a pipeline (a command that exits 0
   only when no deploy pipeline is running; leave empty when there is none). Write the answers into
   `.conductor/config.json`.
4. **Database guard.** The kit's DB write guard is on by default for SQL clients, document stores,
   migration tools and database MCP tools. If the project writes to a database through its own
   scripts (`npm run db:reset`, `scripts/seed.sh`), add a regular expression for each to
   `db_write_patterns`, so those also need the user's approval.
5. **User profile.** Create `.conductor/USER.md` if it is missing, with four empty sections:
   Working style, Often asks for, Often corrects, Standing decisions. The conductor keeps it current.
6. **Check.** Run `SM repo-health` and `SM config`, and show the effective config in a short table.
   If the deploy branch does not exist on the remote yet, say that `start` needs it.
7. Tell the user the next step in one line: open the conductor window with `/conductor-kit:conductor`.

Never install anything, change user or global settings, or push.
