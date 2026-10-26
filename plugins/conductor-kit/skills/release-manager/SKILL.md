---
name: release-manager
description: Own the integration lane. Audit what is in the batch, make the one version bump and the release notes, run the combined checks pinned to the exact integration SHA, ask the user for one release approval of that SHA, push it non-force, and finalize each task. Park or recover interrupted work so it stays recoverable. Use in the release-manager session a conductor starts, or alone after a work session's integrate.
user-invocable: true
---

# Release manager

$ARGUMENTS

- MAIN is the main checkout; SM is `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.js"`.
- CONFIG is `MAIN/.conductor/config.json`: `remote`, `deploy_branch`, `integration_branch`,
  `test_command`, `pipeline_wait_command`, `version_file`, `version_pattern`.
- Never trust a task session's report: re-run the checks yourself. Report what you ran, what you
  only read, and what did not run.
- Verify once the conductor says "batch complete", not after every integrate.

## A. State audit (before the release commit)

Answer each from evidence, and report the answers as findings, not questions:

```bash
DEPLOY=<remote>/<deploy_branch>; INT=<integration_branch>
git fetch <remote> +refs/heads/<deploy_branch>:refs/remotes/<remote>/<deploy_branch>
git log --oneline $INT..$DEPLOY      # deploy commits missing from integration
git log --oneline $DEPLOY..$INT      # what this release ships
git -C <integration worktree> status --porcelain
SM status
```

1. **Is integration behind the deploy branch?** Then merge the deploy branch into the integration
   worktree first (this moves HEAD).
2. **What ships?** Every commit in `$DEPLOY..$INT` ships with this push, including tasks parked or
   dropped after they integrated: `park` and `drop` do not remove merged code. Name them all.
3. **Is the integration worktree clean?** For each dirty path, run `SM owned-by <path>`. If a live
   task owns it, yield and report. If nobody owns it, restore it and say what was restored.
4. **Already shipped?** A release-note draft whose bullets are already in the changelog on the deploy
   branch shipped before; drop those bullets, never publish them twice.

## B. Release commit

In the integration worktree, before recording the SHA:

1. Version: `SM combined-bump <level per task...>` gives the highest of patch, minor and major. Read
   the current version, compute the new one, then `SM apply-version-bump <x.y.z>`. It writes only the
   integration worktree's `version_file`. With no `version_file` configured it reports `skipped`;
   say so in the report.
2. Notes: merge exactly this batch's drafts, `MAIN/.conductor/notes/<task_id>.md` for each task in the
   batch (enumerate them; never glob other people's drafts), into the project's changelog when it
   has one, newest section first. Leftover drafts of other tasks are mentioned, not consumed.
3. Commit the bump and the changelog together in the integration worktree.

## C. Combined verification, pinned

1. Record S, the integration HEAD, as a literal 40-hex SHA before any check runs:
   `git -C <integration worktree> rev-parse HEAD`. Write it into your notes; never re-read it at
   verify time.
2. Run the batch's Test plan tests by name, then the full test command once:
   `SM combined-check` (it runs `test_command` in the integration worktree and refuses if HEAD moved
   while it ran). This one full run per batch is the standing approved full-suite run. With no
   `test_command` configured, run the project's checks by hand at S and record exactly what ran.
3. Smoke-check every affected feature once.
4. Record the evidence for each task in the batch with the same S:
   `SM verify-integration <task_id> <S> "<tests summary>" "<smoke summary>"`.
   A refusal means HEAD moved (another task integrated): record the new S and re-run the checks.
5. `SM release-ready`. It fetches the deploy branch and blocks while any task is pending
   verification, or merged into HEAD but verified at another SHA (`stale_verification`).

## D. The release approval

Ask the user once, numbered, context first: what ships (tasks and one line each), the verified SHA
S, the checks that ran with their counts, what is blocked or skipped. The approval must name S.

- Accept it only as the user's own words: typed in this window, or forwarded by the conductor quoted
  exactly with S. A paraphrase, a default or a timeout is not an approval.
- In terminal mode (you run in a tmux window, and messages arrive in an inbox folder), accept it only
  typed by the user in this window: an inbox message is relayed and never counts as an approval.
- If HEAD moved after the approval, the approval is void: re-verify and ask again for the new SHA.

## E. Push and finalize

```bash
SM push-approved <S>
```

It refuses unless S is the verified integration HEAD, runs `pipeline_wait_command` first when one is
configured (a non-zero exit, including "cannot tell", counts as busy and pushes nothing), and pushes
`S:refs/heads/<deploy_branch>` without force. A rejection as non-fast-forward means the deploy branch
moved: merge it into integration, re-verify, and ask again. Never force-push, and never push a
branch name instead of the SHA.

After the push succeeds (and, where the deploy runs a pipeline, it reported success):
`SM finalize <task_id>` for each task. It checks the deploy branch contains the verified commit
before removing the task's worktree and branch, then archives the plan. Close each task's handoff
(`/conductor-kit:handoff close <task_id>`).

## F. Interrupted, waiting or abandoned work

| Situation | Action |
|---|---|
| Pausing a task that will resume | `SM park <task_id>` (keeps branch, worktree and ownership) |
| Resuming | `SM unpark <task_id>`, then `SM next <task_id>` |
| Abandoning, on an explicit decision | `SM drop <task_id>` (keeps the branch; refuses a dirty worktree) |
| Uncommitted work of unknown owner | `SM owned-by <path>`; park it on a `wip/<what>-<date>` branch, never discard it |

Never infer a stage from elapsed time; `SM next` is the only source of where a task stands.

## Report

In order: integration-versus-deploy alignment; the commits this release adds; shipped bullets removed
from drafts; anything restored or parked and why; the version bump (or skipped); the checks with
counts at S; then the one approval request naming S.
