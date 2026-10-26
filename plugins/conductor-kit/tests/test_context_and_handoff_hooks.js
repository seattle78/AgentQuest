#!/usr/bin/env node
// context-threshold: thresholds, stage firing once per fill, silence outside an opted-in repo.
// handoff-resume: only the bound handoff's next steps are printed; closed topics are hidden.
// Transcripts and handoffs here are synthetic. Run: node tests/test_context_and_handoff_hooks.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ct = require('../hooks/context-threshold.js');

const CT = path.join(__dirname, '..', 'hooks', 'context-threshold.js');
const HR = path.join(__dirname, '..', 'hooks', 'handoff-resume.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ck-hooks-')));
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }
const env = { ...process.env };
for (const k of ['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CONDUCTOR_KIT_MAIN']) delete env[k];

function repo(name, optIn) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q', dir]);
  if (optIn) fs.mkdirSync(path.join(dir, '.conductor', 'handoffs'), { recursive: true });
  return dir;
}
function transcript(tokens, model = 'claude-sonnet-5-5') {
  const file = path.join(TMP, `t-${tokens}-${Math.random().toString(36).slice(2)}.jsonl`);
  const rec = { type: 'assistant', message: { model, usage: { input_tokens: 10, cache_read_input_tokens: tokens - 20, cache_creation_input_tokens: 0, output_tokens: 10 } } };
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${JSON.stringify(rec)}\n`);
  return file;
}
function runCT(input) {
  return spawnSync('node', [CT], { input: JSON.stringify(input), encoding: 'utf8', env }).stdout;
}

test('thresholds follow the compaction point on 1M and 200k windows', () => {
  const big = ct.thresholds(1000000, {});
  assert.strictEqual(big.compactAt, 967000);
  assert.strictEqual(big.stage1, 800000);
  assert.strictEqual(big.stage2, 900000);
  const small = ct.thresholds(200000, {});
  assert.strictEqual(small.compactAt, 167000);
  assert(small.stage1 < small.stage2 && small.stage2 < small.compactAt);
});

test('each stage fires once per fill and re-arms after a large drop', () => {
  const t = ct.thresholds(1000000, {});
  let s = { stage: 0, firedAt: 0, window: 0 };
  let d = ct.decide(810000, t, s); assert.strictEqual(d.emit, 1); s = d.next;
  d = ct.decide(820000, t, s); assert.strictEqual(d.emit, 0);
  d = ct.decide(905000, t, s); assert.strictEqual(d.emit, 2); s = d.next;
  d = ct.decide(910000, t, s); assert.strictEqual(d.emit, 0);
  d = ct.decide(100000, t, s); assert.strictEqual(d.emit, 0); s = d.next;
  assert.strictEqual(s.stage, 0);
});

test('the hook is silent in a repository without .conductor/', () => {
  const dir = repo('plain', false);
  assert.strictEqual(runCT({ session_id: 'a1', transcript_path: transcript(950000), cwd: dir, hook_event_name: 'PostToolBatch' }), '');
});

test('in an opted-in repository it injects the handoff instruction once', () => {
  const dir = repo('opted', true);
  const sid = `b${Date.now()}`;
  const input = { session_id: sid, transcript_path: transcript(850000), cwd: dir, hook_event_name: 'PostToolBatch' };
  const out = JSON.parse(runCT(input));
  assert(/Stage 1 of 2/.test(out.hookSpecificOutput.additionalContext));
  assert(/conductor-kit:handoff/.test(out.hookSpecificOutput.additionalContext));
  assert.strictEqual(runCT(input), '', 'the same stage does not fire twice');
  runCT({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' });
  assert.notStrictEqual(runCT(input), '', 'SessionStart(compact) re-arms it');
  runCT({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' });
});

function handoff(dir, name, fm, body = '') {
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  const sections = ['The Goal', 'Where We Are', 'What We Tried', 'Key Decisions', 'Evidence & Data', 'User Feedback']
    .map(h => `## ${h}\nx\n`).join('\n');
  fs.writeFileSync(path.join(dir, '.conductor', 'handoffs', name),
    `---\n${head}\n---\n\n${sections}\n## Where We're Going\n${body || 'step one'}\n\n## Quick Start\nrun next\n`);
}
const runHR = (input) => spawnSync('node', [HR], { input: JSON.stringify(input), encoding: 'utf8', env }).stdout;

test('handoff-resume prints the bound handoff\'s next steps only into its own session', () => {
  const dir = repo('handoffs', true);
  const fm = { topic: 'task-x', seq: 1, previous: 'none', status: 'open', created: '2026-01-02', branch: 'task/task-x', worktree: dir, session_id: 'sess-1' };
  handoff(dir, 'HANDOFF_task-x_2026-01-02_seq1.md', fm, 'finish the parser');
  const own = runHR({ session_id: 'sess-1', cwd: dir, source: 'startup' });
  assert(/finish the parser/.test(own));
  const other = runHR({ session_id: 'sess-2', cwd: dir, source: 'startup' });
  assert(/HANDOFF_task-x/.test(other));
  assert(!/finish the parser/.test(other));
  assert(/No listed handoff is bound/.test(other));
});

test('a closed topic is hidden, and a missing store prints nothing', () => {
  const dir = repo('closed', true);
  const fm = { topic: 'done-x', seq: 2, previous: 'none', status: 'closed', created: '2026-01-02', branch: 'main', worktree: dir, session_id: 'sess-9' };
  handoff(dir, 'HANDOFF_done-x_2026-01-02_seq2.md', fm);
  assert.strictEqual(runHR({ session_id: 'sess-9', cwd: dir, source: 'startup' }), '');
  assert.strictEqual(runHR({ session_id: 'sess-9', cwd: repo('none', false), source: 'startup' }), '');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed`);
