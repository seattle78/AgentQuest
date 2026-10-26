---
name: review-loop
description: Adversarial review loop. An independent reviewer agent reports every finding in one exhaustive pass, the author fixes all CRITICAL and MAJOR findings at once, and one targeted recheck checks only those fixes. Two rounds at most. Modes are code, test-coverage and doc. Use for plan reviews and wherever the work-session lifecycle calls for a review.
user-invocable: true
model: opus
---

# Review loop

$ARGUMENTS

`$ARGUMENTS` is `<mode> <target...>`: mode `code`, `test-coverage` or `doc`; the target is file paths,
a git diff range or a description. With no valid mode, use `doc` on the whole argument and say so.

## Rules

- The reviewer is always a separate agent, never the author: `Agent(subagent_type="conductor-kit:reviewer",
  model="opus", effort="high", ...)`. Only the reviewer declares convergence; the author never
  self-approves.
- **Round 1, exhaustive.** Give the reviewer the full target and this instruction:
  > You are an independent, adversarial reviewer. Be critical and fact-based. Find bugs,
  > contradictions, gaps, security issues and false assumptions. Every finding needs evidence
  > (file:line or direct observation); an unevidenced finding is not a finding. Classify each as
  > CRITICAL / MAJOR / MINOR / INFO. Report every finding in this single pass: there is no other
  > open-ended round. Mode `test-coverage`: missing behavioral coverage is MAJOR. Say
  > "0 CRITICAL / 0 MAJOR" explicitly when there are none.
- **Converged** when round 1 reports 0 CRITICAL and 0 MAJOR. Otherwise:
- **One fix pass.** Fix every CRITICAL and MAJOR, test first for code, plus trivial MINORs; list the
  other MINORs as deferred. Keep the fix diff: `git diff` against the state before the fix pass, or a
  copy of an untracked file taken before it.
- **Round 2, a targeted recheck,** by a new reviewer agent: the target path, the round-1 findings and
  the fix diff, with the round-1 instruction minus its exhaustive-pass sentence, plus:
  > Targeted recheck, round 2 of 2: check only the listed round-1 findings and the fix diff. For
  > each finding say FIXED or NOT FIXED with evidence, then report defects the fix diff introduced.
  > Do not raise findings outside the fix diff.
- **Maximum `review_max_rounds` (2) rounds.** A CRITICAL or MAJOR left after round 2 stops the loop.
  Report only the blocking items to the caller: the conductor, or the user when there is none. The
  caller decides.
- **Confirm convergence.** Where an `advisor` tool exists, call it with the final verdict, the fixes
  and the deferred items; it confirms the result and says whether the user must decide anything. An
  advisor rejection counts as a finding in the same round budget. Without an advisor, the caller
  confirms.
- Recording the result in workflow state (`set-gate`) is the caller's job; this skill only runs the
  loop.
