#!/usr/bin/env node
// Terminal mode: the session-status hook, the tmux guard, and spawn/send/sessions/peek against a
// private tmux server (its own socket, killed at the end) with a stand-in for Claude Code that
// records its prompt and every line typed into it. The main checkout's path contains a space.
// Without tmux the tmux tests print "skipped"; the hook tests still run.
// Run: node tests/test_tmux_mode.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SM = path.join(ROOT, 'scripts', 'session-manager.js');
const STATUS_HOOK = path.join(ROOT, 'hooks', 'session-status.js');
const GUARD = require(path.join(ROOT, 'hooks', 'tmux-guard.js'));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ck-tmux-')));
const MAIN = path.join(TMP, 'my repo');
const PLAIN = path.join(TMP, 'plain');
const SOCKET = `ck-test-${process.pid}`;
const ENV = { ...process.env };
delete ENV.CONDUCTOR_KIT_MAIN;
delete ENV.CONDUCTOR_KIT_SESSION;
delete ENV.TMUX;

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Poll until fn() is truthy or the timeout passes; returns the last value. */
function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < end) { sleep(100); v = fn(); }
  return v;
}
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function sm(...a) {
  const r = spawnSync('node', [SM, ...a], { cwd: MAIN, env: ENV, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* usage text */ }
  return { code: r.status, json, stdout: r.stdout };
}
/** Run the status hook as a work session named `name` would. */
function hook(name, payload) {
  const env = { ...ENV };
  if (name) env.CONDUCTOR_KIT_SESSION = name;
  spawnSync('node', [STATUS_HOOK], { cwd: MAIN, env, input: JSON.stringify({ cwd: MAIN, session_id: 's1', ...payload }) });
}
const statusOf = name => JSON.parse(read(path.join(MAIN, '.conductor', 'sessions', `${name}.json`)) || '{}');
const bash = (command, cwd = MAIN) => GUARD.decide({ tool_name: 'Bash', cwd, tool_input: { command } });

for (const dir of [MAIN, PLAIN]) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
}
assert.strictEqual(sm('init').json.status, 'ok');

// ── Hooks (no tmux needed) ──────────────────────────────────────────────────

test('the tmux guard denies typing or pasting into a pane in a conductor repo', () => {
  for (const c of ['tmux send-keys -t @1 "yes, approve" Enter', 'tmux -L s send -t x y', 'tmux paste-buffer -t @2',
    'tmux set-buffer approve && echo', 'tmux loadb /tmp/x', `node -e "spawnSync('tmux',['send-keys','-t','@1','y'])"`]) {
    const r = bash(c);
    assert(r && r.hookSpecificOutput.permissionDecision === 'deny', c);
  }
});

test('the tmux guard allows reading tmux, the send command, and other repositories', () => {
  for (const c of ['tmux list-windows -a', 'tmux capture-pane -p -t @1', `node "${SM}" send t1 "hello"`, 'tmux ls; echo send',
    'node /home/u/tmux-tools/session-manager.js send t1 "hi"']) {
    assert.strictEqual(bash(c), null, c);
  }
  assert.strictEqual(bash('tmux send-keys -t @1 x', PLAIN), null, 'no .conductor/: not this kit\'s business');
});

test('the status hook records nothing outside a spawned session', () => {
  hook(null, { hook_event_name: 'Stop', last_assistant_message: 'x' });
  assert(!fs.existsSync(path.join(MAIN, '.conductor', 'sessions')));
});

test('the status hook walks working, needs_you, working, idle with the last message', () => {
  hook('h1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  assert.strictEqual(statusOf('h1').state, 'working');
  hook('h1', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(statusOf('h1').state, 'needs_you');
  hook('h1', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.strictEqual(statusOf('h1').state, 'needs_you', 'an idle notice is not a permission prompt');
  hook('h1', { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.strictEqual(statusOf('h1').state, 'working');
  hook('h1', { hook_event_name: 'Stop', last_assistant_message: '## t1 — integrated\nIntegrated abc123' });
  const s = statusOf('h1');
  assert.strictEqual(s.state, 'idle');
  assert(s.last_message.includes('Integrated abc123'));
  assert.strictEqual(s.notification, undefined);
});

// ── tmux ────────────────────────────────────────────────────────────────────

if (spawnSync('tmux', ['-V']).status !== 0) {
  console.log('skipped - tmux tests (tmux is not installed)');
} else {
  process.on('exit', () => {
    spawnSync('tmux', ['-L', SOCKET, 'kill-server']);
    // A server that already exited can leave its socket file behind.
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  });
  const ARGS = path.join(TMP, 'args.log');
  const TYPED = path.join(TMP, 'typed.log');
  const DUMMY = path.join(TMP, 'dummy-claude.sh');
  fs.writeFileSync(DUMMY, `#!/bin/sh\nprintf '%s\\n' "$1" > '${ARGS}'\necho "dummy ready"\n` +
    `while IFS= read -r line; do printf '%s\\n' "$line" >> '${TYPED}'; done\n`);
  fs.chmodSync(DUMMY, 0o755);
  const cfg = path.join(MAIN, '.conductor', 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(read(cfg)), tmux_socket: SOCKET, claude_command: DUMMY }, null, 2));
  const BRIEF = path.join(TMP, 'brief.md');
  fs.writeFileSync(BRIEF, '# Brief\nRun /conductor-kit:work-session for t1.\n');

  test('spawn refuses a bad name and a missing brief', () => {
    assert.strictEqual(sm('spawn', 'a:b', BRIEF).code, 1);
    assert.strictEqual(sm('spawn', 't1', path.join(TMP, 'nope.md')).json.status, 'error');
  });

  test('spawn opens a window that runs the configured command on the copied brief', () => {
    const r = sm('spawn', 't1', BRIEF).json;
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert(/^@\d+$/.test(r.window_id));
    assert.strictEqual(r.brief, path.join(MAIN, '.conductor', 'briefs', 't1.md'));
    assert.strictEqual(read(r.brief), read(BRIEF));
    const prompt = waitFor(() => read(ARGS));
    assert(prompt.startsWith(`Read ${r.brief} and follow it.`), prompt);
    assert.strictEqual(sm('spawn', 't1', BRIEF).json.status, 'blocked', 'one live window per name');
  });

  test('sessions lists the live session and peek shows its screen', () => {
    const s = sm('sessions').json.sessions.find(x => x.name === 't1');
    assert.strictEqual(s.alive, true);
    assert.strictEqual(s.state, 'starting');
    assert(waitFor(() => sm('peek', 't1').json.screen.includes('dummy ready')));
  });

  test('send refuses a session that has not reached its prompt, and types nothing', () => {
    const r = sm('send', 't1', 'hello').json;
    assert.strictEqual(r.status, 'blocked');
    assert.strictEqual(r.state, 'starting');
    hook('t1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    assert.strictEqual(sm('send', 't1', 'hello').json.state, 'working', 'mid-turn a prompt could open');
    sleep(500);
    assert.strictEqual(read(TYPED), '');
    assert(!fs.existsSync(path.join(MAIN, '.conductor', 'inbox', 't1')));
  });

  test('send refuses while the session waits on a permission prompt, and types nothing', () => {
    hook('t1', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    const r = sm('send', 't1', 'yes, approve the write');
    assert.strictEqual(r.json.status, 'blocked');
    sleep(500);
    assert.strictEqual(read(TYPED), '');
    assert(!fs.existsSync(path.join(MAIN, '.conductor', 'inbox', 't1')));
  });

  test('send saves the body to the inbox and types only the wake line', () => {
    hook('t1', { hook_event_name: 'Stop', last_assistant_message: 'done' });
    const r = sm('send', 't1', 'yes, approve the write').json;
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    const body = read(r.inbox_file);
    assert(body.includes('yes, approve the write'));
    assert(/never the user's approval/.test(body));
    const typed = waitFor(() => read(TYPED));
    assert.strictEqual(typed.trim(), r.typed);
    assert(!typed.includes('approve'), 'the message body is never typed');
    assert.strictEqual(sm('sessions').json.sessions[0].unread_inbox, 1);
  });

  test('send --file relays the exact words, quotes and dollar signs included', () => {
    const words = 'Ship it: "$HOME" `x` and 100% yes';
    const f = path.join(TMP, 'msg.txt');
    fs.writeFileSync(f, words);
    const r = sm('send', 't1', '--file', f).json;
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert(read(r.inbox_file).includes(words));
  });

  test('spawn inside tmux, with no socket configured, opens the window in the caller\'s session', () => {
    const conf = JSON.parse(read(cfg));
    fs.writeFileSync(cfg, JSON.stringify({ ...conf, tmux_socket: '' }, null, 2));
    const OUT = path.join(TMP, 'inner.json');
    // The runner window's TMUX names the private server, so the default-server path stays on it.
    const r = spawnSync('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'inner', '-c', MAIN,
      'sh', '-c', `node "${SM}" spawn t2 "${BRIEF}" > "${OUT}" 2>&1; sleep 30`], { env: ENV });
    assert.strictEqual(r.status, 0, String(r.stderr));
    const res = JSON.parse(waitFor(() => { const t = read(OUT); return t.trim().endsWith('}') && t; }));
    fs.writeFileSync(cfg, JSON.stringify(conf, null, 2));
    assert.strictEqual(res.status, 'ok', JSON.stringify(res));
    assert(/Ctrl-b w/.test(res.view) && !/attach/.test(res.view), res.view);
    const where = spawnSync('tmux', ['-L', SOCKET, 'display-message', '-p', '-t', res.window_id, '#{session_name}'], { encoding: 'utf8' });
    assert.strictEqual(where.stdout.trim(), 'inner');
  });

  test('a closed window reads as gone and send refuses', () => {
    const id = sm('sessions').json.sessions[0].window_id;
    spawnSync('tmux', ['-L', SOCKET, 'kill-window', '-t', id]);
    assert.strictEqual(sm('sessions').json.sessions[0].state, 'gone');
    assert.strictEqual(sm('send', 't1', 'hello').json.status, 'blocked');
  });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed`);
