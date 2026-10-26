#!/usr/bin/env node
// Lifecycle test for session-manager.js against a throwaway repository with a bare remote.
// Covers: plan-gated start, owned-path queueing, gate rules, integrate, the SHA pin, stale
// verification by what is in HEAD, the approved non-force push with a fail-closed pipeline wait,
// finalize, park/drop, the version bump and the build lock.
// Run: node tests/test_session_manager.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SM = path.join(__dirname, '..', 'scripts', 'session-manager.js');
// Scratch must NOT be under /tmp: session-manager itself refuses a /tmp worktree_base
// (the OS purges it), so the old os.tmpdir() base made every start fail. Use a sibling
// scratch dir next to this test file instead; it is removed at the end of a passing run.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(__dirname, '.ck-sm-')));
const REMOTE = path.join(TMP, 'remote.git');
const MAIN = path.join(TMP, 'main');
const WT = path.join(TMP, 'worktrees');
const ENV = { ...process.env, CONDUCTOR_KIT_WORKTREE_BASE: WT, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test-author',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test-author' };
delete ENV.CONDUCTOR_KIT_MAIN;

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...a) => sh(cwd, 'git', a);
function sm(...a) {
  const r = spawnSync('node', [SM, ...a], { cwd: MAIN, env: ENV, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* usage text */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
function setConfig(patch) {
  const file = path.join(MAIN, '.conductor', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2));
}
function plan(id, files, status = 'approved') {
  fs.writeFileSync(path.join(MAIN, '.conductor', 'plans', `WORK_PLAN_${id}.md`),
    `---\ntask_id: ${id}\nstatus: ${status}\n---\n\n# Plan\n\n## Scope\n\n### Files to Edit\n${files.map(f => `- \`${f}\``).join('\n')}\n\n## Test plan\n- none\n`);
}
function commitIn(worktree, file, text) {
  fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  fs.writeFileSync(path.join(worktree, file), text);
  git(worktree, 'add', file);
  git(worktree, 'commit', '-qm', `change ${file}`);
}
function gateUp(id) {
  assert.strictEqual(sm('update', id, 'dev_done', 'true').code, 0);
  assert.strictEqual(sm('set-gate', id, 'gate1', 'approved', '--agent-run', '--evidence', 'reviewer: 0 critical 0 major').code, 0);
  assert.strictEqual(sm('update', id, 'tests_done', 'true').code, 0);
  assert.strictEqual(sm('set-gate', id, 'gate2', 'approved', '--agent-run', '--evidence', 'tester: 3 passed').code, 0);
  assert.strictEqual(sm('update', id, 'committed', 'true').code, 0);
}
const remoteMain = () => git(REMOTE, 'rev-parse', 'refs/heads/main');
const lockLeft = () => fs.existsSync(path.join(MAIN, '.conductor', 'state', 'registry.lock'));

// Repository: a bare remote and a main checkout on main.
git(TMP, 'init', '-q', '--bare', '-b', 'main', REMOTE);
git(TMP, 'clone', '-q', REMOTE, MAIN);
git(MAIN, 'checkout', '-q', '-b', 'main');
fs.writeFileSync(path.join(MAIN, 'README.md'), 'demo\n');
fs.writeFileSync(path.join(MAIN, 'VERSION'), '1.4.2\n');
git(MAIN, 'add', '.');
git(MAIN, 'commit', '-qm', 'initial');
git(MAIN, 'push', '-q', 'origin', 'main');

test('init creates the state root and ignores it in git', () => {
  const r = sm('init');
  assert.strictEqual(r.json.status, 'ok');
  assert(fs.existsSync(path.join(MAIN, '.conductor', 'config.json')));
  assert(/^\.conductor\/$/m.test(fs.readFileSync(path.join(MAIN, '.gitignore'), 'utf8')));
  git(MAIN, 'add', '.gitignore');
  git(MAIN, 'commit', '-qm', 'ignore state');
  git(MAIN, 'push', '-q', 'origin', 'main');
  assert.strictEqual(sm('init').json.gitignore_updated, false, 'init is idempotent');
});

test('start refuses without an approved plan', () => {
  assert.strictEqual(sm('start', 'task-a').json.status, 'blocked');
  plan('task-a', ['src/a.js'], 'draft');
  assert.strictEqual(sm('start', 'task-a').json.status, 'blocked');
});

let A;
test('start cuts task/<id> from the deploy branch in its own worktree', () => {
  plan('task-a', ['src/a.js']);
  const r = sm('start', 'task-a');
  assert.strictEqual(r.json.status, 'ok', r.stdout);
  A = r.json.worktree;
  assert.strictEqual(git(A, 'branch', '--show-current'), 'task/task-a');
  assert.strictEqual(r.json.base_commit, remoteMain());
  assert.strictEqual(sm('start', 'task-a').json.status, 'already_exists');
});

test('an overlapping plan is queued, never started', () => {
  plan('task-b', ['src/']);
  const r = sm('start', 'task-b');
  assert.strictEqual(r.json.status, 'queued');
  assert.deepStrictEqual(r.json.waiting_for, ['task-a']);
  assert(!fs.existsSync(path.join(WT, 'task-b')));
  const o = sm('owned-by', 'src/a.js').json;
  assert.deepStrictEqual(o.owners.map(x => x.task_id), ['task-a']);
});

test('gates: approval needs agent evidence, and gate2 needs gate1', () => {
  assert.strictEqual(sm('set-gate', 'task-a', 'gate1', 'approved', '--evidence', 'self').json.status, 'blocked');
  assert.strictEqual(sm('set-gate', 'task-a', 'gate2', 'approved', '--agent-run', '--evidence', 'x').json.status, 'blocked');
  assert.strictEqual(sm('integrate', 'task-a').json.status, 'blocked');
  assert.strictEqual(sm('update', 'task-a', 'committed', 'true').json.status, 'blocked', 'nothing committed yet');
  assert(!lockLeft(), 'a blocked command inside the lock leaves no lock file');
});

test('next walks the recorded evidence to integrate', () => {
  commitIn(A, 'src/a.js', 'module.exports = 1;\n');
  assert(/dev_done/.test(sm('next', 'task-a').json.next_command));
  gateUp('task-a');
  assert(/integrate task-a/.test(sm('next', 'task-a').json.next_command));
});

let H1;
// The first verified integration HEAD: a real commit on top of the deploy branch, later superseded.
let OLD;
test('integrate merges into the integration worktree and keeps the task', () => {
  const r = sm('integrate', 'task-a');
  assert.strictEqual(r.json.status, 'ok', r.stdout);
  H1 = r.json.integrated_commit;
  assert(fs.existsSync(A), 'task worktree retained');
  assert.strictEqual(sm('release-ready').json.status, 'blocked');
  assert.deepStrictEqual(sm('release-ready').json.pending_verification, ['task-a']);
});

test('verify-integration pins the exact SHA', () => {
  assert.strictEqual(sm('verify-integration', 'task-a', 'HEAD', 't', 's').code, 1, 'a ref name is refused');
  assert.strictEqual(sm('verify-integration', 'task-a', '0'.repeat(40), 't', 's').json.status, 'blocked');
  assert.strictEqual(sm('combined-check').json.status, 'blocked', 'no test_command configured');
  setConfig({ test_command: 'node -e "process.exit(0)"' });
  const c = sm('combined-check').json;
  assert.strictEqual(c.status, 'ok');
  assert.strictEqual(c.sha, H1);
  assert.strictEqual(sm('verify-integration', 'task-a', H1, 'unit 3/3', 'smoke ok').json.status, 'ok');
});

test('a later integrate makes the earlier verification stale', () => {
  plan('task-c', ['lib/c.js']);
  const C = sm('start', 'task-c').json.worktree;
  commitIn(C, 'lib/c.js', 'c\n');
  gateUp('task-c');
  const H2 = sm('integrate', 'task-c').json.integrated_commit;
  assert.notStrictEqual(H2, H1);
  assert.strictEqual(sm('verify-integration', 'task-c', H2, 'unit', 'smoke').json.status, 'ok');
  const rr = sm('release-ready').json;
  assert.strictEqual(rr.status, 'blocked');
  assert.deepStrictEqual(rr.stale_verification, ['task-a']);
  assert.strictEqual(sm('verify-integration', 'task-a', H2, 'unit', 'smoke').json.status, 'ok');
  OLD = H1;
  H1 = H2;
});

test('release-ready names the verified SHA, never a branch', () => {
  const rr = sm('release-ready').json;
  assert.strictEqual(rr.status, 'ok', JSON.stringify(rr));
  assert.strictEqual(rr.integration_head, H1);
  assert(rr.push_command.endsWith(`push-approved ${H1}`));
  assert.deepStrictEqual(rr.ready.sort(), ['task-a', 'task-c']);
});

test('push-approved pushes only the approved SHA, after the pipeline wait', () => {
  const before = remoteMain();
  assert.strictEqual(sm('push-approved', 'f'.repeat(40)).json.status, 'blocked');
  const stale = sm('push-approved', OLD).json;
  assert.strictEqual(stale.status, 'blocked');
  assert(/not the verified integration HEAD/.test(stale.message), stale.message);
  assert.strictEqual(remoteMain(), before, 'an approved SHA that is no longer HEAD pushes nothing');
  setConfig({ pipeline_wait_command: 'node -e "process.exit(3)"' });
  const busy = sm('push-approved', H1).json;
  assert.strictEqual(busy.status, 'blocked');
  assert.strictEqual(remoteMain(), before, 'a failed pipeline check pushes nothing');
  setConfig({ pipeline_wait_command: 'node -e "process.exit(0)"' });
  const ok = sm('push-approved', H1).json;
  assert.strictEqual(ok.status, 'ok', JSON.stringify(ok));
  assert.strictEqual(remoteMain(), H1);
});

test('finalize removes the worktree and branch only once deploy contains it', () => {
  const r = sm('finalize', 'task-a').json;
  assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  assert(!fs.existsSync(A));
  assert.strictEqual(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/task/task-a'], { cwd: MAIN }).status, 1);
  assert.strictEqual(sm('finalize', 'task-c').json.status, 'ok');
  assert.strictEqual(sm('start', 'task-b').json.status, 'ok', 'the queued task starts once the owner is gone');
});

test('finalize refuses a task the deploy branch lacks', () => {
  plan('task-d', ['docs/d.md']);
  const D = sm('start', 'task-d').json.worktree;
  commitIn(D, 'docs/d.md', 'd\n');
  gateUp('task-d');
  sm('integrate', 'task-d');
  const h = sm('combined-check').json.sha;
  sm('verify-integration', 'task-d', h, 'unit', 'smoke');
  assert.strictEqual(sm('finalize', 'task-d').json.status, 'blocked');
  assert(fs.existsSync(D));
});

test('park keeps everything; drop releases ownership and keeps the branch', () => {
  assert.strictEqual(sm('park', 'task-b').json.status, 'ok');
  assert(/unpark/.test(sm('next', 'task-b').json.next_command));
  assert.strictEqual(sm('unpark', 'task-b').json.status, 'ok');
  const B = path.join(WT, 'task-b');
  fs.mkdirSync(path.join(B, 'src'), { recursive: true });
  fs.writeFileSync(path.join(B, 'src', 'dirty.js'), 'x');
  assert.strictEqual(sm('drop', 'task-b').json.status, 'blocked', 'dirty worktree');
  fs.rmSync(path.join(B, 'src', 'dirty.js'));
  const d = sm('drop', 'task-b').json;
  assert.strictEqual(d.status, 'ok');
  assert.strictEqual(d.branch_kept, 'task/task-b');
  assert.strictEqual(sm('owned-by', 'src/a.js').json.owned, false);
});

test('combined bump and the one version write', () => {
  assert.strictEqual(sm('combined-bump', 'patch', 'minor', 'patch').json.bump, 'minor');
  assert.strictEqual(sm('apply-version-bump', '1.5.0').json.status, 'skipped');
  setConfig({ version_file: 'VERSION', version_pattern: '^(\\d+\\.\\d+\\.\\d+)$' });
  const r = sm('apply-version-bump', '1.5.0').json;
  assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  assert.strictEqual(r.from, '1.4.2');
  const integ = sm('status').json.integration_worktree;
  assert.strictEqual(fs.readFileSync(path.join(integ, 'VERSION'), 'utf8'), '1.5.0\n');
  assert.strictEqual(fs.readFileSync(path.join(MAIN, 'VERSION'), 'utf8'), '1.4.2\n', 'never the main checkout');
});

test('build lock: one holder, owner-only release, build runs under it', () => {
  assert.strictEqual(sm('acquire-build-lock', 'x').json.status, 'ok');
  assert.strictEqual(sm('acquire-build-lock', 'y').json.status, 'blocked');
  assert.strictEqual(sm('release-build-lock', 'y').json.status, 'blocked');
  assert.strictEqual(sm('release-build-lock', 'x').json.status, 'ok');
  assert.strictEqual(sm('build', 'task-d').json.status, 'skipped');
  setConfig({ build_command: 'node -e "require(\'fs\').writeFileSync(\'built.txt\', \'1\')"' });
  const b = sm('build', 'task-d').json;
  assert.strictEqual(b.status, 'ok', JSON.stringify(b));
  assert(fs.existsSync(path.join(WT, 'task-d', 'built.txt')));
  assert.strictEqual(sm('build-lock-status').json.held, false, 'released after the build');
});

test('worktree_base under /tmp is refused', () => {
  const r = spawnSync('node', [SM, 'start', 'task-z'], { cwd: MAIN, encoding: 'utf8',
    env: { ...ENV, CONDUCTOR_KIT_WORKTREE_BASE: '/tmp/ck-wt' } });
  plan('task-z', ['z.txt']);
  const r2 = spawnSync('node', [SM, 'start', 'task-z'], { cwd: MAIN, encoding: 'utf8',
    env: { ...ENV, CONDUCTOR_KIT_WORKTREE_BASE: '/tmp/ck-wt' } });
  assert.notStrictEqual(r.status, 0);
  assert(/under \/tmp/.test(r2.stdout));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed`);
