#!/usr/bin/env node
// DB write guard: reads pass; writes are denied once, then asked on the identical re-run;
// subagents and non-prompting modes are always denied; project patterns add to the defaults.
// Run: node tests/test_db_write_guard.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../hooks/db-write-guard.js');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-guard-'));
const guard = { defaults: true, extra: [] };
let n = 0;
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, session_id: `s${n++}`, permission_mode: 'default', ...extra });
const decision = (r) => (r ? r.hookSpecificOutput.permissionDecision : 'pass');

test('reads and ordinary commands pass', () => {
  for (const c of ['psql -c "SELECT count(*) FROM users"', 'node build.js', 'python3 app.py',
    'git commit -m "drop table support from the docs"', 'sqlite3 data.db ".tables"', 'npm test', 'ls -la']) {
    assert.strictEqual(decision(decide(bash(c), { guard, stateDir })), 'pass', c);
  }
});

test('a write is denied first, then asked on the identical re-run', () => {
  const call = bash('psql -h dbhost -c "INSERT INTO users(name) VALUES (\'x\')"');
  const first = decide(call, { guard, stateDir });
  assert.strictEqual(decision(first), 'deny');
  assert(/Background[\s\S]*Why[\s\S]*How[\s\S]*Who[\s\S]*When/.test(first.hookSpecificOutput.permissionDecisionReason));
  assert.strictEqual(decision(decide(call, { guard, stateDir })), 'ask');
  const other = { ...call, tool_input: { command: 'psql -c "DELETE FROM users"' } };
  assert.strictEqual(decision(decide(other, { guard, stateDir })), 'deny', 'a different call starts over');
});

test('unseen statements, document stores and migrations count as writes', () => {
  for (const c of ['psql mydb -f seed.sql', 'mysql app < dump.sql', 'mongosh app --eval "db.users.deleteMany({})"',
    'redis-cli FLUSHALL', 'npx prisma migrate deploy', 'alembic upgrade head', 'bin/rails db:migrate',
    'python manage.py migrate', 'pg_restore -d app backup.dump', 'docker exec db psql -c "DROP TABLE t"']) {
    assert.strictEqual(decision(decide(bash(c), { guard, stateDir })), 'deny', c);
  }
});

test('subagents and non-prompting modes are always denied', () => {
  const sub = bash('psql -c "UPDATE t SET a = 1"', { agent_id: 'agent-1' });
  assert.strictEqual(decision(decide(sub, { guard, stateDir })), 'deny');
  assert.strictEqual(decision(decide(sub, { guard, stateDir })), 'deny');
  for (const mode of ['acceptEdits', 'bypassPermissions', 'dontAsk']) {
    const c = bash('psql -c "UPDATE t SET a = 1"', { permission_mode: mode, session_id: 'same' });
    assert.strictEqual(decision(decide(c, { guard, stateDir })), 'deny', mode);
    assert.strictEqual(decision(decide(c, { guard, stateDir })), 'deny', `${mode} again`);
  }
});

test('MCP database tools: SQL decides, the tool name only without SQL', () => {
  const mcp = (tool_name, tool_input) => ({ tool_name, tool_input, session_id: `m${n++}`, permission_mode: 'default' });
  assert.strictEqual(decision(decide(mcp('mcp__postgres__execute_sql', { sql: 'SELECT 1' }), { guard, stateDir })), 'pass');
  assert.strictEqual(decision(decide(mcp('mcp__postgres__execute_sql', { sql: 'truncate events' }), { guard, stateDir })), 'deny');
  assert.strictEqual(decision(decide(mcp('mcp__mongo__insert_many', { docs: [] }), { guard, stateDir })), 'deny');
  assert.strictEqual(decision(decide(mcp('mcp__files__write_file', { path: 'a' }), { guard, stateDir })), 'pass');
});

test('project patterns add to the defaults, and can replace them', () => {
  const g = { defaults: true, extra: [/\bscripts\/reset-fixtures\.sh\b/i] };
  assert.strictEqual(decision(decide(bash('bash scripts/reset-fixtures.sh'), { guard: g, stateDir })), 'deny');
  const only = { defaults: false, extra: [/\bmytool\s+write\b/i] };
  assert.strictEqual(decision(decide(bash('alembic upgrade head'), { guard: only, stateDir })), 'pass');
  assert.strictEqual(decision(decide(bash('mytool write x'), { guard: only, stateDir })), 'deny');
});

test('config file patterns are read from .conductor/config.json', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-guard-repo-'));
  spawnSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, '.conductor'));
  fs.writeFileSync(path.join(repo, '.conductor', 'config.json'), JSON.stringify({ db_write_patterns: ['\\bseed-db\\b'] }));
  const r = decide({ ...bash('npm run seed-db'), cwd: repo }, { stateDir });
  assert.strictEqual(decision(r), 'deny');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('as a hook process: JSON on stdout, nothing for a read, ask on unreadable input', () => {
  const hook = path.join(__dirname, '..', 'hooks', 'db-write-guard.js');
  const run = (stdin) => spawnSync('node', [hook], { input: stdin, encoding: 'utf8' });
  assert.strictEqual(run(JSON.stringify(bash('ls'))).stdout, '');
  const w = JSON.parse(run(JSON.stringify(bash('psql -c "DROP TABLE x"', { session_id: `p${Date.now()}` }))).stdout);
  assert.strictEqual(w.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(JSON.parse(run('{not json psql').stdout).hookSpecificOutput.permissionDecision, 'ask');
});

fs.rmSync(stateDir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
