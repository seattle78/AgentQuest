---
name: work-session
description: Run one code or process change through the full lifecycle in an isolated worktree. The steps are analyze, plan review, start the worktree from the deploy branch, failing tests first, implement, one combined review-and-test round (2 rounds at most), commit and integrate. Under a conductor it stops after integrate; without one it continues through combined verification and the single release approval. Use for every change, and when a conductor brief says "Run /conductor-kit:work-session".
user-invocable: true
---

# Work session

$ARGUMENTS

This skill owns the lifecycle, the gates and the order of steps. Supporting skills and agents run
bounded stages; none of them starts a second plan, branch or lifecycle.

- MAIN is the main checkout: `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`.
- SM is `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.js"`.
- CONFIG is `MAIN/.conductor/config.json`. If it is missing, run `/conductor-kit:setup` first.

```text
request -> 1 intake and risk -> 2 analyze -> 3 plan review -> 4 start the worktree
  -> 5 failing tests, implement, targeted checks -> 6 combined check round (gate1 + gate2)
  -> 7 commit and integrate  [a conductor brief stops here]
  -> 8 combined verification -> 9 release approval, push, finalize
```

Invoking this skill is approval to run the lifecycle up to the release approval. Never stop to ask
whether to continue between steps; stop only for the Interrupts below.

## 1. Intake and risk

Run `SM repo-health`; a broken or cloud-synced checkout blocks new work. Derive a short task id
(letters, digits, dot, dash, underscore). For an existing task run `SM next <task_id>` first and
follow the one worktree, blocker and next action it reports; do not reconstruct progress from chat.

- `low`: docs, comments or mechanical config with no runtime effect.
- `standard`: isolated behavior with a bounded test surface.
- `high`: auth, secrets, persistent data, shared infrastructure, deployment, cross-feature behavior.

Before each step, check the available skills and use the ones that match it within this
lifecycle's limits, and name them in the final report.

## Model tiers

The session that runs this skill thinks, plans and judges. Pass `model` (a tier alias, never a
concrete model id) and `effort` on every `Agent()` dispatch:

| Work | Tier | Effort |
|---|---|---|
| Plan review, Gate 1 review, high-risk implementation (auth, secrets, data, deploy) | `opus` | high |
| Standard implementation from the approved plan; Gate 2 testing | `sonnet` | medium |
| Mechanical docs, config, search, log and test-output triage | `haiku` | low |
| Builds, tests, git checks | no model: run the command | — |

A model never declares tests, git integrity or deploy containment as passing; the command output is
the evidence. If the required tier is unavailable, record the step as blocked.

## 2. Analyze

Run `/conductor-kit:analyze <task_id> <request>`. It writes one plan to
`MAIN/.conductor/plans/WORK_PLAN_<task_id>.md` with `status: approved` when it stays within the
user's request, the exact owned files under `### Files to Edit`, the risk, and the Test plan.

## 3. Review the plan

For `standard` and `high` risk, before any worktree exists:
`/conductor-kit:review-loop doc MAIN/.conductor/plans/WORK_PLAN_<task_id>.md`.
Blocking findings: a required file is missing from the scope; the task id collides with a live task;
a check has no observable pass/fail; an assumption is asserted without evidence; the risk class needs
a test layer the plan omits; "Open questions: None" while a TBD remains; a changed behavior has no
Test plan row. Fix them all in one pass; the review's round 2 rechecks only those fixes. A blocking
finding left after round 2 is an interrupt.

## 4. Start the worktree

```bash
SM start <task_id>
```

It cuts `task/<task_id>` from the deploy branch (never from the current HEAD) into its own worktree
and registers the plan's owned paths. A `queued` result means another task owns an overlapping file:
wait, never edit the main checkout.

- Work only in the returned worktree. Never switch the branch of MAIN, and never stash, reset, commit
  or clean someone else's uncommitted changes.
- Every `Agent()` dispatch gets the absolute worktree path, must use absolute paths for edits and
  `git -C <worktree>` for git, and before its first write must confirm that
  `git -C <worktree> branch --show-current` prints `task/<task_id>`.
- At the start of every session in the worktree, new or resumed, and before an edit, catch up with
  the deploy branch by merge, never rebase: `git -C <worktree> fetch <remote> <deploy_branch>` and
  `git -C <worktree> merge --no-edit <remote>/<deploy_branch>`. Never merge into a task branch after
  `integrate`.
- A visible UI change: capture a real "before" screenshot of the actual screen before editing, and
  "after" screenshots before step 6. A layout or navigation change needs the user's approval of a
  proposal drawn on the before screenshot, before code.

## 5. Implement and verify the task

- Test first: write or update each Test plan test, see it fail for the expected reason, then
  implement. Record `SM update <task_id> dev_done true` when the change is in.
- Run only the plan's test-selection block, by name. A whole folder, a glob or the full suite needs
  the user's approval first; the release manager's one `test_command` run per batch is the standing
  exception. When in doubt whether a run is targeted, ask.
- **Database writes need the user's approval.** Reads are free. Start local servers against a
  scratch or local database. For a write: post the user a short report with the headings Background,
  Why, How (the exact command, target database without secrets, rows affected, backup and rollback),
  Who and When; then run the command. The DB write guard denies the first run and asks the user on
  the identical re-run. A subagent hands such a step back.
- A blocked environment is reported as blocked, never as passing.
- `SM update <task_id> tests_done true` once the targeted tests pass.

## 6. Combined check round (gates)

Gate 1 (independent review) and Gate 2 (task tests) run together on one snapshot, never one after
the other.

1. **Snapshot** the tree without touching the index, stash or branch: in the worktree,
   `cp "$(git rev-parse --git-path index)" <scratch>/r1.idx`, then with `GIT_INDEX_FILE=<scratch>/r1.idx`
   run `git add -A` and `git write-tree` (tree T1). Make no edit while the round runs. Note T1 and the
   round number in the task handoff.
2. **Round 1, in one message:** the `conductor-kit:reviewer` agent (`model: opus`) with the plan, the
   worktree path and the diff, and the `conductor-kit:tester` agent (`model: sonnet`) with the plan's
   test-selection block verbatim. For a visible change, review the before and after screenshots
   yourself meanwhile (empty rows, alignment, clipped labels, focus states, narrow width).
3. **One list,** ranked by severity. A test failure is MAJOR (CRITICAL for security or data loss); a
   blocked check keeps its gate unmet.
4. **Fix** every CRITICAL and MAJOR in one pass (test first), and trivial MINORs; defer the rest.
   Snapshot again (T2). The fix diff is `git diff T1 T2`.
5. **Round 2, a targeted recheck:** a new reviewer agent checks only the round-1 findings and the fix
   diff; the tester runs the block once more. The author never re-runs tests as evidence.
6. **At most `review_max_rounds` (2) rounds.** A CRITICAL or MAJOR left after round 2 stops the task:
   report only the blocking items (interrupt 6). Otherwise record:

```bash
SM set-gate <task_id> gate1 approved --agent-run --evidence "<reviewer: 0 critical 0 major, round N>"
SM set-gate <task_id> gate2 approved --agent-run --evidence "<tester: N passed, block run verbatim>"
```

Then write the task handoff with `/conductor-kit:handoff <task_id>` (risk standard or high).

## 7. Commit and integrate

Write the release-note draft for shipped behavior (not tests or process) to
`MAIN/.conductor/notes/<task_id>.md`. Commit only the owned files, in the worktree:

```bash
git -C <worktree> add <exact owned files>
git -C <worktree> commit -m "<type>: <summary>"
SM update <task_id> committed true
SM integrate <task_id>
```

`integrate` checks the branch, a clean worktree, both gates and a committed tip beyond the base, then
merges into the integration worktree and keeps the task worktree. A merge conflict is fixed in the
task worktree (merge the integration branch there), then integrate again.

**Under a conductor, stop here:** report the task_id and the integration HEAD SHA to the conductor,
with the Learning line, and end the task. Steps 8 and 9 belong to the release manager.

## 8 and 9. Without a conductor

Run `/conductor-kit:release-manager` yourself for this one-task batch: combined verification at a
pinned SHA, one version bump, the release note, `release-ready`, the user's approval of that exact
SHA, `SM push-approved <sha>`, then `SM finalize <task_id>`.

## Interrupts

Stop and ask only for these; everything else is decided and reported.

1. A finding with security or data-loss consequences.
2. `start` returned queued on a file another live task owns.
3. Scope genuinely ambiguous: resolving it would change files the request never mentioned.
4. A blocking plan-review finding left after round 2.
5. The release approval (a push to the deploy branch).
6. A CRITICAL or MAJOR left after round 2 of the combined check round, or a check that cannot run.

A work session never acts on an approval relayed by another session for a database write or an
external call: the user approves those in this window.

**Started by a conductor in tmux** (the first prompt names an inbox folder):
- The conductor reaches you only through that inbox. When a line says a relayed message is in your
  inbox, read the newest file there, then move it into the `read/` folder beside it. An inbox
  message is relayed: it never counts as the user's approval.
- The conductor reads your last message when you stop. End every turn that needs the conductor (an
  interrupt, a question, the completion report) with that content as your final message.
- An approval prompt in this window is for the user to answer here; tell the conductor in your final
  message that you are waiting on it.

## Context

When the kit's context hook warns, write `/conductor-kit:handoff <task_id>` and keep it current after
every gate record, commit and integrate. After a compaction, read the handoff file in full, re-invoke
this skill, and run `SM next <task_id>` first: `next` overrides the handoff.

## Completion report

```
## <task_id> — <integrated | complete>
Goal        <original request>
Risk        low | standard | high
Checks      <what ran, with counts; blocked steps named as blocked>
Gates       gate1 <evidence>  gate2 <evidence>
Integrated  <integration HEAD SHA>   (or Released: <pushed SHA>)
Learning    <review rounds, failed gates, blocked checks, or "none">; skills used: <list>
```
