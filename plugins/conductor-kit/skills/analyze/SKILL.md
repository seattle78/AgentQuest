---
name: analyze
description: Write one scoped, evidence-based Work Plan for a code change before any worktree exists. The plan names the exact files the task will own, the risk, the assumptions with their evidence, and the tests that prove each changed behavior. Used by work-session step 2; run standalone with /conductor-kit:analyze <task_id> <request> to stop after presenting the plan.
user-invocable: true
---

# Analyze: write the Work Plan

$ARGUMENTS

SM below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.js"`. MAIN is the main checkout
(`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`).

## Rules

- Inspect the code, the tests, the current sessions and the repository's own instructions (its
  CLAUDE.md, AGENTS.md or contributing guide) before asking anything.
- The task id is short and unique: letters, digits, dot, dash and underscore, for example
  `api.rate-limit` or `docs-install-guide`. Check `SM status` that no live task uses it.
- Read product code from the deploy branch (`git show <remote>/<deploy_branch>:<path>`), not from a
  checkout that may be stale.
- Check ownership before writing the plan: `SM owned-by <path>` for every target. Name every owner
  under Evidence, and never take over its files silently. An overlap means the conductor sends
  the work to that session instead, or the task gets new files of its own.
- Keep scope exact. Every backticked path under `### Files to Edit` becomes owned by this task.
  Backtick a path only there; write every other path as plain text.
- Shared single-writer files (the version file, the changelog) are never in a task's scope; the
  release manager changes them once per batch.
- A call from work-session counts as approval when the plan stays inside the user's request: write
  `status: approved`. Standalone, write `status: pending_approval` and stop after showing the plan.

## Risk and required evidence

| Risk | Typical scope | Task checks | Integration checks |
|---|---|---|---|
| low | docs, comments, mechanical config with no runtime effect | a focused check | none unless batched with code |
| standard | isolated behavior with a bounded test surface | the Test plan tests, by name | the batch's tests + `test_command` |
| high | auth, secrets, data, shared infrastructure, deployment, cross-feature | the Test plan tests + independent review + any required live check | the batch's tests + `test_command` + the risk-specific check |

## Work Plan format

Write `MAIN/.conductor/plans/WORK_PLAN_<task_id>.md`, never inside a worktree:

````markdown
---
status: approved | pending_approval
task_id: <task_id>
risk: low | standard | high
started: <UTC ISO time>
---

# Work Plan — <task_id>

## Outcome
<one sentence, in the user's terms>

## Scope

### Files to Edit
- `<exact path>` — <change>

## Evidence and assumptions
| Claim | Evidence (file:line or command output) | Verified |
|---|---|---|

## Test plan
| Changed behavior | Test (file and name) | Existing or new | Fails before the change? |
|---|---|---|---|

```test-selection
<one test id per line: a single test function, case or file the runner can run by name>
```

## Task verification
<the exact commands that run the test-selection block>

## Integration verification
<the batch tests by name, plus `test_command` once in the integration worktree>

## Out of scope
<plain text; no backticked paths>

## Open questions
<None, or each question with the default that applies if nobody answers>
````

## Test plan rules

- Every changed behavior has a row: the test that proves it, whether it is new, and that it is seen
  to fail before the change (test first). A docs or mechanical change writes `n/a` with the reason.
- The test-selection block names tests individually. Never a folder, a glob or the whole suite:
  a full-suite run needs the user's approval, except the release manager's one `test_command` run
  per batch.
- A test file this task creates or edits is listed under Files to Edit.
- "Open questions: None" with a TBD left in the body is a defect.

Ask one numbered batch of questions only when investigation cannot settle a choice that changes the
result. Otherwise state the safe default and proceed.
