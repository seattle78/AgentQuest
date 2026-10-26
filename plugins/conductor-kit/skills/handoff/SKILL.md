---
name: handoff
description: Condense the current session into a structured handoff document so the next session or another AI continues without losing context. Use when the context is getting long, before /compact, when ending or splitting a session, when the user says "handoff" or "hand this off", or when the kit's context hook asks for one. `/conductor-kit:handoff close <topic>` closes a topic.
user-invocable: true
---

# Handoff

Write one bounded, factual document that lets a fresh session resume the work. The kit's
SessionStart hook lists open handoffs by path, and prints a handoff's next steps only into the
session whose id it carries.

Section structure adapted from REMvisual/claude-handoff (MIT).

## Automatic trigger

The kit's context hook reads this session's context use and injects an instruction twice per fill,
from the compaction point (on a 1M window: 800k and 900k; on 200k: about 100k and 134k;
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` moves both).

- Stage 1: run this skill now, then continue. Until the compaction, refresh the handoff (next seq)
  right after every user decision, gate record, commit, integrate or push.
- Stage 2: at the next safe point run it again, tell the user in one line the handoff path and the
  resume line and that auto-compaction resumes from it, and continue without waiting. With
  auto-compaction off, ask the user to run /compact or /clear instead.

## Resolve the store

```bash
COMMON=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
[ "$(basename "$COMMON")" = ".git" ] || { echo "handoff store cannot be resolved"; exit 1; }
STORE="$(dirname "$COMMON")/.conductor/handoffs"; mkdir -p "$STORE" || exit 1
```

Never write into a worktree's own folder: every worktree shares this one store.

## Name, seq and previous

File: `HANDOFF_<topic>_<YYYY-MM-DD>_seq<N>.md`. The topic is the task_id verbatim for task work,
`conductor` for the conductor window, the topic this session already writes, or a short kebab-case
name. `seq` is the highest existing seq of that topic + 1 (1 if none); `previous` is that file's path
or `none`. After writing, set the previous file's frontmatter to `status: closed`.

## Frontmatter

```yaml
---
topic: <topic>
seq: <N>
previous: <path or none>
status: open
created: <YYYY-MM-DD>
branch: <git branch --show-current>
worktree: <absolute path of the current worktree>
session_id: ${CLAUDE_SESSION_ID}
---
```

`session_id` is always this run's id as filled in above, never copied from an earlier handoff.
`status` is exactly `open` or `closed`; `branch` has no whitespace; `worktree` exists.

## Sections (in this order, exactly these `## ` names)

1. **The Goal**: what the user wants and why, in two or three lines.
2. **Where We Are**: what is done, in progress and broken.
3. **What We Tried**: every approach, including failed ones and why they failed.
4. **Key Decisions**: decisions and their reasons, and who decided.
5. **Evidence & Data**: facts with file:line, commit SHAs, one-line command results.
6. **User Feedback**: corrections, preferences and constraints the user stated.
7. **Where We're Going**: the next steps in order, and what "done" looks like.
8. **Quick Start**: the exact commands and the first file to read. A task handoff starts with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.js" next <task_id>` and says that `next`
   overrides this handoff; a line that re-invokes the skill the work runs under comes after it.

## Must hold (task and conductor handoffs)

- The substituted `session_id`.
- The task_id (or `conductor`), worktree, branch and Work Plan path.
- Gate states with evidence, and the review round number and snapshot tree while a round is open.
- The user's approvals in the user's exact words, with the date.
- Owned paths, open questions, and every background reviewer or tester still running.
- For the conductor: open sessions with ids, pending approvals, the release manager id.
- The single next step.

## Rules

- Facts only; mark anything not checked as `unverified`. No credentials, tokens, keys or raw logs.
- Under 150 lines. Link files instead of pasting them. Do not copy an earlier handoff.

## Close

`close <topic>`: set `status: closed` on every `HANDOFF_<topic>_*` file in the store.

## After writing

Print the path and one line the user can paste to resume:
`Resume: read <path>, then continue from "Where We're Going".`
