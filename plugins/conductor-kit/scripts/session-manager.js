#!/usr/bin/env node
'use strict';
/**
 * session-manager.js — the conductor kit's task registry and integration lane.
 *
 * One task = one approved Work Plan, one `task/<id>` branch cut from the deploy branch, one
 * worktree, and the files the plan owns. Tasks are merged one at a time into a shared integration
 * worktree; the combined checks are pinned to the exact integration commit they ran on; the
 * release pushes only that verified commit, non-force, to the deploy branch; and `finalize`
 * removes a task's worktree only once the deploy branch contains it.
 *
 * Every command prints one JSON object. Blocked and error results exit 1, except the read-only
 * reports (`status`, `next`, `release-ready`, `owned-by`, `config`), which exit 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mainCheckout, paths, loadConfig, DEFAULTS } = require('./lib/config.js');

const SELF = __filename;
const SM = `node "${SELF}"`;
const TERMINAL = ['merged', 'dropped'];
const BUILD_LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const LOCK_TIMEOUT_MS = 15000;
const LOCK_STALE_MS = 60000;
const BUMP_RANK = { major: 3, minor: 2, patch: 1 };
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_RE = /^[A-Za-z0-9][\w.-]*$/;

// ── Output ─────────────────────────────────────────────────────────────────

/** Print a JSON result and exit: 0 for ok-like statuses, 1 otherwise. */
function out(obj, code) {
  console.log(JSON.stringify(obj, null, 2));
  process.exit(code === undefined ? (['ok', 'queued', 'already_exists'].includes(obj.status) ? 0 : 1) : code);
}

/** Print a usage line and exit 1. */
function usage(text) {
  console.error(`Usage: ${text}`);
  process.exit(1);
}

// ── Context ────────────────────────────────────────────────────────────────

const MAIN = mainCheckout();
if (!MAIN) out({ status: 'error', message: 'Not inside a git repository with a .git folder.' });
const P = paths(MAIN);
const CFG = loadConfig(MAIN);
const REMOTE = CFG.remote;
const DEPLOY = CFG.deploy_branch;
const INTEGRATION = CFG.integration_branch;

/** Run git; returns {status, stdout, stderr} with trimmed output. */
function run(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** Run git and throw on failure. */
function git(cwd, ...args) {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** True when `a` is an ancestor of (or equal to) `b`. */
function isAncestor(a, b) {
  return !!a && !!b && run(MAIN, ['merge-base', '--is-ancestor', a, b]).status === 0;
}

function now() { return new Date().toISOString(); }

/** Resolve a path through symlinks when it exists, so /var and /private/var compare equal. */
function canonical(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function validTaskId(id) {
  return typeof id === 'string' && TASK_RE.test(id) && !id.includes('..');
}

function requireTaskId(id, cmd) {
  if (!validTaskId(id)) usage(`${cmd} <task_id>  (letters, digits, dot, dash, underscore)`);
}

// ── State files ────────────────────────────────────────────────────────────

/** Write JSON atomically, so a concurrent reader never sees half a file. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readRegistry() {
  const r = readJson(P.registry, null);
  return r && typeof r.sessions === 'object' ? r : { sessions: {} };
}

/** Sleep synchronously; the CLI is single-threaded and short-lived. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let lockHeld = false;
// out() exits from inside locked sections, where a finally block never runs, so the lock is
// released on process exit instead.
process.on('exit', () => { if (lockHeld) fs.rmSync(P.lock, { force: true }); });

/**
 * Run `fn` holding the registry lock, so two sessions never interleave a read-modify-write.
 * A lock older than LOCK_STALE_MS is a crashed holder and is taken over.
 */
function withLock(fn) {
  if (lockHeld) return fn();
  fs.mkdirSync(path.dirname(P.lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(P.lock, String(process.pid), { flag: 'wx' });
      lockHeld = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(P.lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(P.lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) out({ status: 'error', message: `Timed out waiting for ${P.lock}; nothing ran. Re-run the same command.` });
      sleepMs(100);
    }
  }
  try { return fn(); } finally { fs.rmSync(P.lock, { force: true }); lockHeld = false; }
}

function workflowFile(taskId) {
  return path.join(P.workflow, `${taskId}.json`);
}

function readWorkflow(taskId) {
  return readJson(workflowFile(taskId), {});
}

/** Gate verdicts come only from the task's workflow file, which only `set-gate` writes. */
function gates(taskId) {
  const w = readWorkflow(taskId);
  return {
    gate1: w.gate1 || 'pending', gate1_agent_run: w.gate1_agent_run === true,
    gate2: w.gate2 || 'pending', gate2_agent_run: w.gate2_agent_run === true,
  };
}

/** A gate passes only with an approved verdict from an independent agent run. */
function gatePassed(g, gate) {
  return g[gate] === 'approved' && g[`${gate}_agent_run`] === true;
}

/** The active (non-terminal) session of a task, or the newest one when `activeOnly` is false. */
function findSession(reg, taskId, activeOnly = true) {
  const all = Object.entries(reg.sessions).filter(([, s]) => s.task_id === taskId)
    .sort((a, b) => String(b[1].created).localeCompare(String(a[1].created)));
  const hit = activeOnly ? all.find(([, s]) => !TERMINAL.includes(s.status)) : all[0];
  return hit ? { key: hit[0], session: hit[1] } : null;
}

// ── Work Plans and ownership ───────────────────────────────────────────────

function planFile(taskId) {
  return path.join(P.plans, `WORK_PLAN_${taskId}.md`);
}

/**
 * The approved plan's owned paths: every backticked repository path under `### Files to Edit`.
 * @returns {{status:string, paths:string[]}} status is `approved`, `missing` or the plan's own status
 */
function readPlan(taskId) {
  let text;
  try { text = fs.readFileSync(planFile(taskId), 'utf8'); } catch { return { status: 'missing', paths: [] }; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const status = fm && (/^status:\s*(\S+)/m.exec(fm[1]) || [])[1];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^###\s+Files to Edit\s*$/i.test(l));
  const owned = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,3}\s/.test(line)) break;
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const p = m[1].replace(/^\.\//, '');
        if (!path.isAbsolute(p) && !p.split('/').includes('..')) owned.push(p);
      }
    }
  }
  return { status: status || 'missing', paths: [...new Set(owned)] };
}

/** True when two owned paths overlap: equal, or one is a folder holding the other. */
function overlaps(a, b) {
  const x = a.endsWith('/') ? a : `${a}/`;
  const y = b.endsWith('/') ? b : `${b}/`;
  return a === b || x.startsWith(y) || y.startsWith(x);
}

/** Owned-path conflicts between a candidate and every other live, non-queued session. */
function detectConflicts(taskId, candidate, sessions) {
  const conflicts = [];
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.task_id === taskId || TERMINAL.includes(s.status) || s.status === 'queued') continue;
    for (const c of candidate) {
      for (const o of s.owned_paths || []) {
        if (overlaps(c, o)) conflicts.push({ session: sid, task_id: s.task_id, path: c, owned_as: o });
      }
    }
  }
  return conflicts;
}

// ── Refs and worktrees ─────────────────────────────────────────────────────

/** Fetch the deploy branch into its remote-tracking ref; quiet when there is no remote. */
function fetchDeploy() {
  if (run(MAIN, ['remote', 'get-url', REMOTE]).status !== 0) return false;
  return run(MAIN, ['fetch', '--quiet', REMOTE, `+refs/heads/${DEPLOY}:refs/remotes/${REMOTE}/${DEPLOY}`]).status === 0;
}

/** The deploy baseline: the remote-tracking ref when it exists, else the local branch. */
function deployRef() {
  const remoteRef = `refs/remotes/${REMOTE}/${DEPLOY}`;
  return run(MAIN, ['rev-parse', '--verify', '--quiet', remoteRef]).status === 0 ? remoteRef : `refs/heads/${DEPLOY}`;
}

function worktreeBase() {
  const base = CFG.worktree_base;
  // The OS purges /tmp and leaves half-deleted worktrees behind.
  if (/^\/(private\/)?tmp(\/|$)/.test(base)) {
    out({ status: 'error', message: `worktree_base ${base} is under /tmp, which the OS purges. Set worktree_base in ${P.config}.` });
  }
  return base;
}

function registeredWorktrees() {
  const list = run(MAIN, ['worktree', 'list', '--porcelain']).stdout;
  return list.split('\n').filter(l => l.startsWith('worktree ')).map(l => canonical(l.slice(9)));
}

function integrationPath(reg) {
  return reg.integration_worktree || path.join(worktreeBase(), '_integration');
}

/** Create the integration worktree on first use, from the deploy baseline. */
function ensureIntegration(reg) {
  const wt = integrationPath(reg);
  if (registeredWorktrees().includes(canonical(wt))) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const exists = run(MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${INTEGRATION}`]).status === 0;
  if (exists) git(MAIN, 'worktree', 'add', wt, INTEGRATION);
  else git(MAIN, 'worktree', 'add', '-b', INTEGRATION, wt, deployRef());
  reg.integration_worktree = wt;
  return wt;
}

/** The integration worktree's head; throws when it is missing, on the wrong branch, or dirty. */
function inspectIntegration(reg) {
  const wt = integrationPath(reg);
  if (!registeredWorktrees().includes(canonical(wt))) throw new Error(`Integration worktree ${wt} does not exist; run init-integration.`);
  const branch = git(wt, 'branch', '--show-current');
  if (branch !== INTEGRATION) throw new Error(`Integration worktree is on ${branch}, not ${INTEGRATION}.`);
  if (git(wt, 'status', '--porcelain')) throw new Error(`Integration worktree ${wt} has uncommitted changes.`);
  return { worktree: wt, head: git(wt, 'rev-parse', 'HEAD') };
}

// ── Next action ────────────────────────────────────────────────────────────

/** The single next step for a session, derived from recorded evidence only. */
function nextAction(s, g) {
  const id = s.task_id;
  const r = (action, command = null, blocking = null) => ({ action, command, blocking_reason: blocking });
  switch (s.status) {
    case 'queued': return r('Wait for the owner of the overlapping files to finalize or drop, then start again.', `${SM} start ${id}`, 'owned-path conflict');
    case 'parked': return r('Resume the preserved task in its existing worktree.', `${SM} unpark ${id}`);
    case 'integrated_pending_verification':
      return r('Run the combined checks at the integration HEAD, then record them against that exact SHA.',
        `${SM} combined-check`);
    case 'ready_to_promote': return r('Ask the user for the single release approval of the verified SHA.', `${SM} release-ready`);
    case 'merged': return r('No action. The task is on the deploy branch and finalized.');
    case 'dropped': return r('No action. The task was abandoned.', null, 'terminal task');
    default: break;
  }
  const w = readWorkflow(id);
  if (w.dev_done !== true) return r('Implement the plan in the task worktree, then record it.', `${SM} update ${id} dev_done true`);
  if (g.gate1 === 'rejected') return r('Fix the independent review findings and request review again.', null, 'Gate 1 rejected');
  if (!gatePassed(g, 'gate1')) return r('Obtain the independent Gate 1 review. Self-review does not approve this gate.',
    `${SM} set-gate ${id} gate1 approved --agent-run --evidence "<reviewer verdict>"`);
  if (w.tests_done !== true) return r('Run the plan\'s targeted tests, then record them.', `${SM} update ${id} tests_done true`);
  if (g.gate2 === 'rejected') return r('Fix the failed verification and rerun the affected checks.', null, 'Gate 2 rejected');
  if (!gatePassed(g, 'gate2')) return r('Record the passing targeted verification as Gate 2.',
    `${SM} set-gate ${id} gate2 approved --agent-run --evidence "<tester result>"`);
  if (s.committed !== true) return r('Commit the owned files in the task worktree, then record it.', `${SM} update ${id} committed true`);
  return r('Merge the reviewed task into the integration lane.', `${SM} integrate ${id}`);
}

// ── Commands ───────────────────────────────────────────────────────────────

function cmdConfig() {
  out({ status: 'ok', main: MAIN, state_root: P.root, config_file: P.config, config_exists: fs.existsSync(P.config), config: CFG }, 0);
}

/** Create the state folders and the config file, and keep `.conductor/` out of git. */
function cmdInit() {
  for (const d of [P.plans, P.handoffs, P.board, P.workflow]) fs.mkdirSync(d, { recursive: true });
  const created = !fs.existsSync(P.config);
  if (created) writeJson(P.config, { ...DEFAULTS });
  const gi = path.join(MAIN, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const ignored = text.split(/\r?\n/).some(l => ['.conductor', '.conductor/', '/.conductor/'].includes(l.trim()));
  if (!ignored) fs.appendFileSync(gi, `${text && !text.endsWith('\n') ? '\n' : ''}.conductor/\n`);
  out({ status: 'ok', state_root: P.root, config_created: created, gitignore_updated: !ignored, config_file: P.config });
}

function cmdRepoHealth() {
  const problems = [];
  if (run(MAIN, ['rev-parse', '--verify', 'HEAD']).status !== 0) problems.push('HEAD does not resolve');
  if (/\/(Library\/Mobile Documents|Library\/CloudStorage|Dropbox|OneDrive|Google Drive|iCloud)/i.test(MAIN)) {
    problems.push('the main checkout is inside a cloud-synced folder; move it to a plain local folder');
  }
  if (process.argv.includes('--full')) {
    const f = run(MAIN, ['fsck', '--connectivity-only', '--no-progress']);
    if (f.status !== 0) problems.push(`git fsck failed: ${f.stderr.split('\n')[0]}`);
  }
  out({ status: problems.length ? 'blocked' : 'ok', main: MAIN, problems });
}

function cmdStatus() {
  const reg = readRegistry();
  const sessions = Object.entries(reg.sessions).map(([sid, s]) => {
    const g = gates(s.task_id);
    return { session_id: sid, task_id: s.task_id, status: s.status, branch: s.branch, worktree: s.worktree,
      gate1: g.gate1, gate2: g.gate2, committed: s.committed === true, owned_paths: s.owned_paths || [],
      integrated_commit: s.integrated_commit || null, last_updated: s.last_updated };
  });
  out({ status: 'ok', deploy_branch: DEPLOY, integration_branch: INTEGRATION,
    integration_worktree: reg.integration_worktree || null, sessions }, 0);
}

function cmdNext(taskId) {
  requireTaskId(taskId, 'next');
  const found = findSession(readRegistry(), taskId, false);
  if (!found) {
    const plan = readPlan(taskId);
    out({ status: 'not_found', task_id: taskId, plan: plan.status,
      next_action: plan.status === 'approved' ? 'Start the task from its approved plan.' : 'Write and approve the Work Plan first.',
      next_command: plan.status === 'approved' ? `${SM} start ${taskId}` : null }, 0);
  }
  const g = gates(taskId);
  const n = nextAction(found.session, g);
  out({ status: 'ok', task_id: taskId, session_id: found.key, lifecycle_status: found.session.status,
    branch: found.session.branch, worktree: found.session.worktree, ...g,
    blocking_reason: n.blocking_reason, next_action: n.action, next_command: n.command }, 0);
}

function cmdStart(taskId) {
  requireTaskId(taskId, 'start');
  const plan = readPlan(taskId);
  if (plan.status !== 'approved' || plan.paths.length === 0) {
    out({ status: 'blocked', task_id: taskId, message: `Start needs an approved plan with owned paths under "### Files to Edit": ${planFile(taskId)} (status: ${plan.status}, ${plan.paths.length} paths).` });
  }
  fetchDeploy();
  withLock(() => {
    const reg = readRegistry();
    const existing = findSession(reg, taskId);
    if (existing && existing.session.status !== 'queued') {
      out({ status: 'already_exists', task_id: taskId, session_id: existing.key, worktree: existing.session.worktree,
        message: `Task ${taskId} already has a ${existing.session.status} session. Resume it, or drop it explicitly.` });
    }
    const conflicts = detectConflicts(taskId, plan.paths, reg.sessions);
    const sid = existing ? existing.key : `${taskId}-${Date.now().toString(36)}`;
    const branch = `task/${taskId}`;
    const worktree = path.join(worktreeBase(), taskId);
    if (conflicts.length) {
      reg.sessions[sid] = { session_id: sid, task_id: taskId, status: 'queued', branch, worktree,
        owned_paths: plan.paths, created: existing ? existing.session.created : now(), last_updated: now() };
      writeJson(P.registry, reg);
      out({ status: 'queued', task_id: taskId, session_id: sid, waiting_for: [...new Set(conflicts.map(c => c.task_id))], conflicts,
        message: 'Queued on owned-path overlap. Do not edit anywhere. Start again once the owner finalizes or drops.' });
    }
    if (run(MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
      out({ status: 'blocked', task_id: taskId, message: `Branch ${branch} already exists with no live session. Inspect it; start never reuses or deletes it.` });
    }
    const base = deployRef();
    let baseSha;
    try { baseSha = git(MAIN, 'rev-parse', base); } catch {
      out({ status: 'error', message: `Deploy baseline ${base} does not exist. Push or fetch ${DEPLOY} first.` });
    }
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    try { git(MAIN, 'worktree', 'add', '--no-track', '-b', branch, worktree, baseSha); } catch (e) {
      out({ status: 'error', message: e.message });
    }
    reg.sessions[sid] = { session_id: sid, task_id: taskId, status: 'in_progress', branch, worktree,
      base_commit: baseSha, owned_paths: plan.paths, committed: false,
      created: existing ? existing.session.created : now(), last_updated: now() };
    writeJson(P.registry, reg);
    writeJson(workflowFile(taskId), { task_id: taskId, session_id: sid, dev_done: false, tests_done: false,
      gate1: 'pending', gate1_agent_run: false, gate2: 'pending', gate2_agent_run: false, notes: [] });
    out({ status: 'ok', task_id: taskId, session_id: sid, branch, worktree, base_ref: base, base_commit: baseSha,
      owned_paths: plan.paths, message: `Work only in ${worktree}. Pass this absolute path to every subagent.` });
  });
}

function cmdOwnedBy(file) {
  if (!file) usage('owned-by <path>');
  const rel = path.isAbsolute(file) ? path.relative(MAIN, file) : file.replace(/^\.\//, '');
  const owners = Object.values(readRegistry().sessions)
    .filter(s => !TERMINAL.includes(s.status) && s.status !== 'queued' && (s.owned_paths || []).some(o => overlaps(rel, o)))
    .map(s => ({ task_id: s.task_id, status: s.status, owned_as: (s.owned_paths || []).find(o => overlaps(rel, o)) }));
  out({ status: 'ok', path: rel, owned: owners.length > 0, owners }, 0);
}

const UPDATE_KEYS = ['dev_done', 'tests_done', 'committed', 'note'];

function cmdUpdate(taskId, key, value) {
  requireTaskId(taskId, 'update');
  if (!UPDATE_KEYS.includes(key) || value === undefined) usage(`update <task_id> <${UPDATE_KEYS.join('|')}> <value>`);
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    const w = readWorkflow(taskId);
    if (key === 'note') {
      w.notes = [...(w.notes || []), { at: now(), text: value }];
    } else {
      if (!['true', 'false'].includes(value)) usage(`update <task_id> ${key} true|false`);
      const v = value === 'true';
      if (key === 'committed') {
        if (v) {
          const s = found.session;
          const dirty = run(s.worktree, ['status', '--porcelain']).stdout;
          const tip = run(s.worktree, ['rev-parse', 'HEAD']).stdout;
          if (dirty || !tip || tip === s.base_commit) {
            out({ status: 'blocked', message: 'committed=true needs a clean task worktree with at least one commit beyond its base.' });
          }
        }
        found.session.committed = v;
      } else {
        w[key] = v;
      }
    }
    found.session.last_updated = now();
    writeJson(workflowFile(taskId), w);
    writeJson(P.registry, reg);
    out({ status: 'ok', task_id: taskId, [key]: value });
  });
}

/**
 * Record a gate verdict. An approval needs --agent-run (the verdict came from an independent agent,
 * never the author) and --evidence; Gate 2 cannot be approved before Gate 1.
 */
function cmdSetGate(argv) {
  const [taskId, gate, verdict] = argv;
  requireTaskId(taskId, 'set-gate');
  if (!['gate1', 'gate2'].includes(gate) || !['approved', 'rejected', 'pending'].includes(verdict)) {
    usage('set-gate <task_id> <gate1|gate2> <approved|rejected|pending> [--agent-run] --evidence "<text>"');
  }
  const ei = argv.indexOf('--evidence');
  const evidence = ei >= 0 ? argv[ei + 1] : '';
  const agentRun = argv.includes('--agent-run');
  if (verdict === 'approved' && (!agentRun || !evidence)) {
    out({ status: 'blocked', message: 'An approval needs --agent-run (an independent reviewer or tester produced it) and --evidence "<what it checked>".' });
  }
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    if (gate === 'gate2' && verdict === 'approved' && !gatePassed(gates(taskId), 'gate1')) {
      out({ status: 'blocked', message: 'Gate 2 cannot be approved before Gate 1.' });
    }
    const w = readWorkflow(taskId);
    w[gate] = verdict;
    w[`${gate}_agent_run`] = verdict === 'approved' ? agentRun : false;
    w[`${gate}_evidence`] = evidence;
    w[`${gate}_at`] = now();
    writeJson(workflowFile(taskId), w);
    found.session.last_updated = now();
    writeJson(P.registry, reg);
    out({ status: 'ok', task_id: taskId, gate, verdict });
  });
}

function cmdInitIntegration() {
  withLock(() => {
    const reg = readRegistry();
    fetchDeploy();
    try {
      const wt = ensureIntegration(reg);
      writeJson(P.registry, reg);
      out({ status: 'ok', deploy_branch: DEPLOY, integration_branch: INTEGRATION, integration_worktree: wt });
    } catch (e) {
      out({ status: 'error', message: e.message });
    }
  });
}

function cmdIntegrate(taskId) {
  requireTaskId(taskId, 'integrate');
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    const s = found.session;
    const g = gates(taskId);
    if (!gatePassed(g, 'gate1') || !gatePassed(g, 'gate2')) {
      out({ status: 'blocked', message: 'Both gates need approved verdicts from independent agent runs before integrate.' });
    }
    const branch = `task/${taskId}`;
    if (s.branch !== branch || !registeredWorktrees().includes(canonical(s.worktree)) ||
        run(s.worktree, ['branch', '--show-current']).stdout !== branch) {
      out({ status: 'blocked', message: `The registered worktree must exist and be on ${branch}.` });
    }
    if (run(s.worktree, ['status', '--porcelain']).stdout) {
      out({ status: 'blocked', message: `The task worktree has uncommitted changes: ${s.worktree}.` });
    }
    const tip = git(s.worktree, 'rev-parse', 'HEAD');
    if (s.committed !== true || tip === s.base_commit || !isAncestor(s.base_commit, tip) || git(MAIN, 'rev-parse', branch) !== tip) {
      out({ status: 'blocked', message: 'Record a clean committed task tip beyond the registered base (update committed true) first.' });
    }
    let wt;
    try {
      wt = ensureIntegration(reg);
      if (git(wt, 'status', '--porcelain')) throw new Error(`Integration worktree ${wt} is dirty; find each path's owner before touching it.`);
      git(wt, 'merge', '--no-ff', branch, '-m', `merge(${taskId}): integration candidate`);
      if (!isAncestor(tip, git(wt, 'rev-parse', 'HEAD'))) throw new Error('Integration HEAD does not contain the task tip.');
    } catch (e) {
      if (wt) run(wt, ['merge', '--abort']);
      out({ status: 'merge_conflict', message: e.message, recovery: `Resolve in ${s.worktree} (merge ${INTEGRATION} or the deploy branch there), commit, and integrate again. The task branch and worktree were kept.` });
    }
    Object.assign(s, { status: 'integrated_pending_verification', integrated_at: now(), integrated_task_commit: tip,
      integrated_commit: git(wt, 'rev-parse', 'HEAD'), integration_verified: false, integration_verified_commit: null,
      last_updated: now() });
    writeJson(P.registry, reg);
    out({ status: 'ok', task_id: taskId, integration_worktree: wt, integrated_commit: s.integrated_commit,
      retained_task_worktree: s.worktree,
      next: `Record the integration HEAD SHA before any check, run the combined checks (${SM} combined-check), then verify-integration ${taskId} <that-sha> "<tests>" "<smoke>".` });
  });
}

/**
 * Run the configured test command in the integration worktree, pinned to the HEAD it started on.
 * Prints the SHA to pass to verify-integration; refuses to run with nothing configured.
 */
function cmdCombinedCheck() {
  const reg = readRegistry();
  let integ;
  try { integ = inspectIntegration(reg); } catch (e) { out({ status: 'blocked', message: e.message }); }
  if (!CFG.test_command) {
    out({ status: 'blocked', sha: integ.head, message: `No test_command in ${P.config}. Run the batch's checks by hand at ${integ.head} in ${integ.worktree}, or set test_command.` });
  }
  const r = spawnSync(CFG.test_command, { cwd: integ.worktree, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const head = git(integ.worktree, 'rev-parse', 'HEAD');
  const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
  if (head !== integ.head) out({ status: 'blocked', sha: integ.head, message: 'The integration HEAD moved while the checks ran; record the new HEAD and run them again.' });
  out({ status: r.status === 0 ? 'ok' : 'failed', sha: integ.head, command: CFG.test_command, exit_code: r.status, output_tail: tail,
    next: r.status === 0 ? `verify-integration <task_id> ${integ.head} "<tests summary>" "<smoke summary>" for each task in the batch` : 'Fix the failing task in its worktree, integrate again, and re-run.' });
}

function cmdVerifyIntegration(taskId, sha, tests, smoke) {
  requireTaskId(taskId, 'verify-integration');
  if (!sha || !SHA_RE.test(sha) || !tests || !smoke) {
    usage('verify-integration <task_id> <full-40-hex-sha-recorded-before-the-checks> "<tests summary>" "<smoke summary>"');
  }
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    const s = found.session;
    if (!['integrated_pending_verification', 'ready_to_promote'].includes(s.status)) {
      out({ status: 'blocked', message: `Task ${taskId} is ${s.status}; integrate it first.` });
    }
    let integ;
    try { integ = inspectIntegration(reg); } catch (e) { out({ status: 'blocked', message: e.message }); }
    if (sha !== integ.head) {
      out({ status: 'blocked', message: `Integration HEAD ${integ.head} differs from ${sha}: the checks did not run on this commit. Record the current HEAD, re-run, and verify that SHA.` });
    }
    if (!isAncestor(s.integrated_task_commit, integ.head)) {
      out({ status: 'blocked', message: `Integration HEAD does not contain task commit ${s.integrated_task_commit}.` });
    }
    Object.assign(s, { status: 'ready_to_promote', integration_verified: true, integration_verified_commit: sha,
      integration_tests_summary: tests, integration_smoke_summary: smoke, integration_verified_at: now(), last_updated: now() });
    writeJson(P.registry, reg);
    out({ status: 'ok', task_id: taskId, verified_commit: sha, message: 'Recorded. The release still needs the user\'s explicit approval of this SHA.' });
  });
}

/**
 * Whether the integration HEAD may ship. Selection is by what is in HEAD, not by status: a parked
 * or dropped task's merge stays in HEAD, so every non-terminal task merged into HEAD and not yet on
 * the deploy branch must be verified at exactly this HEAD.
 */
function releaseState() {
  const reg = readRegistry();
  const sessions = Object.values(reg.sessions);
  const pending = sessions.filter(s => s.status === 'integrated_pending_verification').map(s => s.task_id);
  let head = null;
  let message = null;
  try { head = inspectIntegration(reg).head; } catch (e) { message = e.message; }
  const verifiedAt = (s) => s.status === 'ready_to_promote' && s.integration_verified === true &&
    s.integration_verified_commit === head && gatePassed(gates(s.task_id), 'gate1') && gatePassed(gates(s.task_id), 'gate2');
  const stale = [];
  const ready = [];
  if (head) {
    const deploy = deployRef();
    for (const s of sessions) {
      if (!s.integrated_task_commit || s.status === 'merged') continue;
      if (!isAncestor(s.integrated_task_commit, head) || isAncestor(s.integrated_task_commit, deploy)) continue;
      if (verifiedAt(s)) ready.push(s.task_id); else stale.push(s.task_id);
    }
    if (stale.length) message = `Integration HEAD ${head} is not verified for: ${stale.join(', ')}. Re-run the combined checks at this HEAD and verify each.`;
    else if (!ready.length) message = 'Nothing verified to release.';
  }
  const ok = !!head && pending.length === 0 && stale.length === 0 && ready.length > 0;
  return { ok, head, ready, pending, stale, message };
}

function cmdReleaseReady() {
  fetchDeploy();
  const st = releaseState();
  out({ status: st.ok ? 'ok' : 'blocked', deploy_branch: DEPLOY, integration_branch: INTEGRATION,
    integration_head: st.head, ready: st.ready, pending_verification: st.pending, stale_verification: st.stale,
    message: st.message,
    approval_needed: st.ok ? `Push verified commit ${st.head} (tasks: ${st.ready.join(', ')}) to ${DEPLOY}?` : null,
    push_command: st.ok ? `${SM} push-approved ${st.head}` : null }, 0);
}

/**
 * Push exactly the SHA the user approved, non-force. Refuses unless that SHA is the verified
 * integration HEAD now, waits for the configured pipeline check (fail closed), and lets git reject
 * a non-fast-forward rather than overwrite.
 */
function cmdPushApproved(sha) {
  if (!sha || !SHA_RE.test(sha)) usage('push-approved <full-40-hex-sha-the-user-approved>');
  fetchDeploy();
  const st = releaseState();
  if (!st.ok) out({ status: 'blocked', message: st.message || 'release-ready is blocked.', release: st });
  if (sha !== st.head) {
    out({ status: 'blocked', message: `The approved SHA ${sha} is not the verified integration HEAD ${st.head}. Report the new HEAD and ask again; never push a SHA the user did not approve.` });
  }
  if (!isAncestor(deployRef(), sha)) {
    out({ status: 'blocked', message: `${DEPLOY} has commits that ${sha} lacks. Merge ${DEPLOY} into ${INTEGRATION}, re-verify, and ask for approval of the new SHA.` });
  }
  if (CFG.pipeline_wait_command) {
    const w = spawnSync(CFG.pipeline_wait_command, { cwd: MAIN, shell: true, encoding: 'utf8' });
    if (w.status !== 0) {
      out({ status: 'blocked', message: `pipeline_wait_command exited ${w.status}; an unknown pipeline state counts as busy. Nothing was pushed.`, output: `${w.stdout}${w.stderr}`.trim().slice(-2000) });
    }
  }
  const p = run(MAIN, ['push', REMOTE, `${sha}:refs/heads/${DEPLOY}`]);
  if (p.status !== 0) out({ status: 'error', message: `git push was rejected (no force is ever used): ${p.stderr}` });
  out({ status: 'ok', pushed: sha, to: `${REMOTE}/${DEPLOY}`, tasks: st.ready, next: `finalize each task: ${st.ready.map(t => `${SM} finalize ${t}`).join(' ; ')}` });
}

function cmdFinalize(taskId) {
  requireTaskId(taskId, 'finalize');
  fetchDeploy();
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    const s = found.session;
    const g = gates(taskId);
    if (s.status !== 'ready_to_promote' || !s.integration_verified || !gatePassed(g, 'gate1') || !gatePassed(g, 'gate2')) {
      out({ status: 'blocked', message: `Task ${taskId} is not a verified integration candidate (${s.status}).` });
    }
    const deploy = deployRef();
    if (!isAncestor(s.integration_verified_commit, deploy) || !isAncestor(s.integrated_task_commit, deploy)) {
      out({ status: 'blocked', message: `${deploy} does not contain the verified commit ${s.integration_verified_commit}. Push and fetch first; nothing was removed.` });
    }
    const branch = `task/${taskId}`;
    const registered = registeredWorktrees().includes(canonical(s.worktree));
    if (registered) {
      const exact = run(s.worktree, ['branch', '--show-current']).stdout === branch && !run(s.worktree, ['status', '--porcelain']).stdout &&
        run(s.worktree, ['rev-parse', 'HEAD']).stdout === s.integrated_task_commit;
      if (!exact) out({ status: 'blocked', message: 'The task worktree must be clean and exactly at the integrated task commit; nothing was removed.' });
      const rm = run(MAIN, ['worktree', 'remove', s.worktree]);
      if (rm.status !== 0) out({ status: 'blocked', message: `Non-destructive cleanup refused: ${rm.stderr}` });
    }
    // -d (never -D) from the integration worktree, whose HEAD contains the task: git itself then
    // refuses to delete a branch whose commits are not merged.
    const integ = integrationPath(reg);
    const del = run(fs.existsSync(integ) ? integ : MAIN, ['branch', '-d', branch]);
    Object.assign(s, { status: 'merged', deployed_ref: deploy, deployed_at: now(), owned_paths: [], last_updated: now() });
    writeJson(P.registry, reg);
    let archived = null;
    if (fs.existsSync(planFile(taskId))) {
      archived = path.join(P.plans, 'archive', `${taskId}_${now().slice(0, 10)}.md`);
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      fs.renameSync(planFile(taskId), archived);
    }
    out({ status: 'ok', task_id: taskId, deployed_ref: deploy, worktree_removed: !fs.existsSync(s.worktree),
      branch_deleted: del.status === 0, branch_note: del.status === 0 ? undefined : del.stderr, plan_archived: archived });
  });
}

function setStatus(taskId, from, to, extra = {}) {
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    if (from && !from.includes(found.session.status)) out({ status: 'blocked', message: `Task ${taskId} is ${found.session.status}.` });
    Object.assign(found.session, { status: to, last_updated: now(), ...extra });
    writeJson(P.registry, reg);
    out({ status: 'ok', task_id: taskId, new_status: to, worktree: found.session.worktree, branch: found.session.branch });
  });
}

/** Pause a task; its branch, worktree and ownership stay, so resuming needs no reconstruction. */
function cmdPark(taskId) {
  requireTaskId(taskId, 'park');
  setStatus(taskId, ['in_progress'], 'parked', { parked_at: now() });
}

function cmdUnpark(taskId) {
  requireTaskId(taskId, 'unpark');
  setStatus(taskId, ['parked'], 'in_progress');
}

/**
 * Abandon a task on an explicit decision. Ownership is released; the branch is always kept, so the
 * work stays recoverable; the worktree is removed only when it is clean (or with --force).
 */
function cmdDrop(argv) {
  const taskId = argv[0];
  requireTaskId(taskId, 'drop');
  const force = argv.includes('--force');
  withLock(() => {
    const reg = readRegistry();
    const found = findSession(reg, taskId);
    if (!found) out({ status: 'error', message: `No active session for ${taskId}.` });
    const s = found.session;
    let removed = false;
    if (registeredWorktrees().includes(canonical(s.worktree))) {
      if (run(s.worktree, ['status', '--porcelain']).stdout && !force) {
        out({ status: 'blocked', message: `The worktree has uncommitted changes. Commit them on ${s.branch}, or drop with --force to keep the worktree as it is.` });
      }
      removed = !force && run(MAIN, ['worktree', 'remove', s.worktree]).status === 0;
    }
    Object.assign(s, { status: 'dropped', dropped_at: now(), owned_paths: [], last_updated: now() });
    writeJson(P.registry, reg);
    out({ status: 'ok', task_id: taskId, branch_kept: s.branch, worktree_removed: removed,
      warning: s.integrated_task_commit ? 'This task was already merged into integration; dropping does not remove its code there.' : undefined });
  });
}

function cmdCombinedBump(levels) {
  let best = null;
  for (const l of levels) if (BUMP_RANK[l] && (!best || BUMP_RANK[l] > BUMP_RANK[best])) best = l;
  if (!best) usage('combined-bump <major|minor|patch> ...');
  out({ status: 'ok', bump: best });
}

/**
 * The one version write per batch, in the integration worktree: version_file's first match of
 * version_pattern (one capture group around the version) is replaced. Skips when unconfigured.
 */
function cmdApplyVersionBump(version) {
  if (!version || !/^\d+\.\d+\.\d+([.-][\w.]+)?$/.test(version)) usage('apply-version-bump <x.y.z>');
  if (!CFG.version_file || !CFG.version_pattern) {
    out({ status: 'skipped', message: 'No version_file and version_pattern in the config; no version bump is made.' }, 0);
  }
  const reg = readRegistry();
  const file = path.join(integrationPath(reg), CFG.version_file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { out({ status: 'error', message: `Cannot read ${file}: ${e.message}` }); }
  let re;
  try { re = new RegExp(CFG.version_pattern, 'm'); } catch (e) { out({ status: 'error', message: `Bad version_pattern: ${e.message}` }); }
  const m = re.exec(text);
  if (!m || m[1] === undefined) out({ status: 'error', message: `version_pattern has no match with a capture group in ${file}.` });
  const at = m.index + m[0].indexOf(m[1]);
  fs.writeFileSync(file, text.slice(0, at) + version + text.slice(at + m[1].length));
  out({ status: 'ok', file, from: m[1], to: version });
}

// ── Build lock ─────────────────────────────────────────────────────────────

function readBuildLock() {
  return readJson(P.buildLock, null);
}

/** A lock older than BUILD_LOCK_MAX_AGE_MS (far longer than any build) is abandoned. */
function lockStale(lock) {
  return !lock || Date.now() - Date.parse(lock.acquired_at) > BUILD_LOCK_MAX_AGE_MS;
}

function tryAcquire(taskId) {
  return withLock(() => {
    const lock = readBuildLock();
    if (lock && lock.owner !== taskId && !lockStale(lock)) return { ok: false, lock };
    const mine = { owner: taskId, acquired_at: now(), pid: process.pid };
    writeJson(P.buildLock, mine);
    return { ok: true, lock: mine, took_over: lock && lock.owner !== taskId ? lock.owner : undefined };
  });
}

function cmdAcquireBuildLock(taskId) {
  requireTaskId(taskId, 'acquire-build-lock');
  const r = tryAcquire(taskId);
  out(r.ok ? { status: 'ok', ...r } : { status: 'blocked', held_by: r.lock.owner, since: r.lock.acquired_at, message: `Held by ${r.lock.owner}; use wait-build-lock.` });
}

function cmdWaitBuildLock(taskId, timeoutS) {
  requireTaskId(taskId, 'wait-build-lock');
  const deadline = Date.now() + (Number(timeoutS) || 600) * 1000;
  for (;;) {
    const r = tryAcquire(taskId);
    if (r.ok) out({ status: 'ok', ...r });
    if (Date.now() > deadline) out({ status: 'timeout', held_by: r.lock.owner, message: 'Still held; nothing was built.' });
    sleepMs(2000);
  }
}

function cmdReleaseBuildLock(taskId, force) {
  requireTaskId(taskId, 'release-build-lock');
  withLock(() => {
    const lock = readBuildLock();
    if (!lock) out({ status: 'ok', message: 'No lock held.' });
    if (lock.owner !== taskId && !force) out({ status: 'blocked', message: `Held by ${lock.owner}, not ${taskId}. Check its session before --force.` });
    fs.rmSync(P.buildLock, { force: true });
    out({ status: 'ok', released: lock.owner });
  });
}

function cmdBuildLockStatus() {
  const lock = readBuildLock();
  out({ status: 'ok', held: !!lock && !lockStale(lock), lock, stale: !!lock && lockStale(lock) }, 0);
}

/** Run build_command under the build lock, in the task's worktree or the integration worktree. */
function cmdBuild(target) {
  if (!target) usage('build <task_id|integration>');
  if (!CFG.build_command) out({ status: 'skipped', message: `No build_command in ${P.config}.` }, 0);
  const reg = readRegistry();
  let cwd;
  if (target === 'integration') {
    try { cwd = inspectIntegration(reg).worktree; } catch (e) { out({ status: 'blocked', message: e.message }); }
  } else {
    requireTaskId(target, 'build');
    const found = findSession(reg, target);
    if (!found) out({ status: 'error', message: `No active session for ${target}.` });
    cwd = found.session.worktree;
  }
  const owner = target;
  const deadline = Date.now() + 600000;
  let got = tryAcquire(owner);
  while (!got.ok && Date.now() < deadline) { sleepMs(2000); got = tryAcquire(owner); }
  if (!got.ok) out({ status: 'timeout', held_by: got.lock.owner, message: 'Build lock still held; nothing was built.' });
  let r;
  try {
    r = spawnSync(CFG.build_command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } finally {
    withLock(() => { const l = readBuildLock(); if (l && l.owner === owner) fs.rmSync(P.buildLock, { force: true }); });
  }
  out({ status: r.status === 0 ? 'ok' : 'failed', cwd, command: CFG.build_command, exit_code: r.status,
    output_tail: `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n') });
}

// ── Terminal mode (tmux) ───────────────────────────────────────────────────

// The only text `send` ever types. A message body goes to the inbox file instead, so keystrokes in
// a work session's window never carry anyone's words and cannot pass for the user's approval.
const WAKE_LINE = 'conductor-kit: a relayed message from the conductor is in your inbox; read it, then move it into the read/ folder there';
const LAST_MESSAGE_SHOWN = 2000;

/** Run tmux on the configured server; returns {status, stdout, stderr}. */
function tmux(args) {
  const sock = CFG.tmux_socket ? ['-L', CFG.tmux_socket] : [];
  const r = spawnSync('tmux', [...sock, ...args], { encoding: 'utf8' });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function requireTmux() {
  if (tmux(['-V']).status !== 0) {
    out({ status: 'error', message: 'tmux is not installed or not on PATH. Terminal mode needs tmux 3.x; without it, paste each brief into a new terminal.' });
  }
}

/** Window ids of every live tmux window on the configured server. */
function liveWindows() {
  const r = tmux(['list-windows', '-a', '-F', '#{window_id}']);
  return new Set(r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []);
}

function statusFile(name) { return path.join(P.sessionStatus, `${name}.json`); }

/** Unread inbox messages: the .md files directly in the session's inbox (read ones move to read/). */
function unread(name) {
  try { return fs.readdirSync(path.join(P.inbox, name)).filter(f => f.endsWith('.md')).length; } catch { return 0; }
}

/**
 * The tmux session new windows go into: the caller's own session when it runs inside tmux on the
 * default server, else the configured session, created detached when missing.
 */
function tmuxTarget() {
  if (process.env.TMUX && !CFG.tmux_socket) {
    const r = tmux(['display-message', '-p', '#{session_id}']);
    if (r.status === 0 && r.stdout) return { target: r.stdout, created: false, inside: true };
  }
  const name = CFG.tmux_session;
  if (tmux(['has-session', '-t', `=${name}`]).status === 0) return { target: `=${name}`, created: false, inside: false };
  const r = tmux(['new-session', '-d', '-s', name, '-c', MAIN]);
  if (r.status !== 0) out({ status: 'error', message: `Could not create tmux session ${name}: ${r.stderr}` });
  return { target: `=${name}`, created: true, inside: false };
}

/** Start a work session as a tmux window running Claude Code on a brief file. */
function cmdSpawn(name, briefFile) {
  if (!validTaskId(name) || !briefFile) usage('spawn <name> <brief-file>  (name: letters, digits, dot, dash, underscore)');
  requireTmux();
  const src = path.resolve(briefFile);
  if (!fs.existsSync(src)) out({ status: 'error', message: `No brief file at ${src}.` });
  const reg = readJson(P.tmuxSessions, {});
  if (reg[name] && liveWindows().has(reg[name].window_id)) {
    out({ status: 'blocked', message: `Session ${name} is already running in window ${reg[name].window_id}. Use send, or pick another name.` });
  }
  const brief = path.join(P.briefs, `${name}.md`);
  fs.mkdirSync(P.briefs, { recursive: true });
  if (canonical(src) !== canonical(brief)) fs.copyFileSync(src, brief);
  // Reset the status before the window exists, so the new session's first hook write wins.
  writeJson(statusFile(name), { name, state: 'starting', updated: now() });
  const { target, created, inside } = tmuxTarget();
  const prompt = `Read ${brief} and follow it. The conductor started you in tmux as session "${name}"; ` +
    `its messages arrive in ${path.join(P.inbox, name)}.`;
  // Argument form: no shell parses the brief path or the prompt; claude_command is the user's own setting.
  const r = tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${target}:`, '-n', name, '-c', MAIN,
    '-e', `CONDUCTOR_KIT_SESSION=${name}`, 'sh', '-c', `${CFG.claude_command} "$1"`, 'sh', prompt]);
  if (r.status !== 0 || !/^@\d+$/.test(r.stdout)) out({ status: 'error', message: `tmux new-window failed: ${r.stderr || r.stdout}` });
  reg[name] = { window_id: r.stdout, tmux_target: target, brief, started_at: now() };
  writeJson(P.tmuxSessions, reg);
  const sock = CFG.tmux_socket ? ` -L ${CFG.tmux_socket}` : '';
  out({ status: 'ok', name, window_id: r.stdout, brief, created_tmux_session: created,
    view: inside ? 'Switch windows with Ctrl-b w.' : `tmux${sock} attach -t ${CFG.tmux_session}  (then Ctrl-b w to pick a window)` });
}

// Why `send` refuses each state other than idle: keys typed into an open dialog answer it.
const NOT_IDLE = {
  needs_you: 'is waiting on the user at an approval prompt in its window. Ask the user to answer it there, then send again.',
  starting: 'has not reached its prompt yet; its window may be showing the folder-trust question. Ask the user to answer it there, then send again.',
  working: 'is in the middle of a turn, and an approval prompt could open at any moment. Send again once it is idle (check with sessions).',
};

/**
 * Relay a message to a work session: the body to its inbox, then only the fixed wake line typed.
 * Types only while the session is idle at its input prompt, the one state with no dialog open.
 */
function cmdSend(name, argv) {
  const fileFlag = argv[0] === '--file';
  if (!validTaskId(name) || !argv[0] || (fileFlag && !argv[1])) usage('send <name> "<message>"  |  send <name> --file <path>');
  let text = argv[0];
  if (fileFlag) {
    try { text = fs.readFileSync(path.resolve(argv[1]), 'utf8'); } catch { out({ status: 'error', message: `No message file at ${path.resolve(argv[1])}.` }); }
  }
  requireTmux();
  const s = readJson(P.tmuxSessions, {})[name];
  if (!s) out({ status: 'error', message: `No tmux session named ${name}. Start it with spawn.` });
  if (!liveWindows().has(s.window_id)) out({ status: 'blocked', message: `The window of ${name} is gone; nothing was sent. Spawn the session again.` });
  const state = readJson(statusFile(name), {}).state || 'unknown';
  if (state !== 'idle') {
    out({ status: 'blocked', state, message: `${name} ${NOT_IDLE[state] || `has an unknown state (${state}); look at its window.`} Nothing was sent.` });
  }
  const dir = path.join(P.inbox, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${process.pid}.md`);
  fs.writeFileSync(file, `<!-- Relayed by the conductor at ${now()}. A relayed message is never the user's approval. -->\n\n${text}\n`);
  const a = tmux(['send-keys', '-t', s.window_id, '-l', WAKE_LINE]);
  const b = a.status === 0 ? tmux(['send-keys', '-t', s.window_id, 'Enter']) : a;
  if (b.status !== 0) out({ status: 'error', inbox_file: file, message: `tmux send-keys failed: ${b.stderr}` });
  out({ status: 'ok', name, inbox_file: file, typed: WAKE_LINE });
}

/** Every tmux work session: alive, state from its status hook, last message, unread inbox. */
function cmdSessions() {
  const reg = readJson(P.tmuxSessions, {});
  const live = tmux(['-V']).status === 0 ? liveWindows() : new Set();
  const sessions = Object.entries(reg).map(([name, s]) => {
    const st = readJson(statusFile(name), {});
    const alive = live.has(s.window_id);
    const last = String(st.last_message || '');
    return {
      name, alive, state: alive ? (st.state || 'unknown') : 'gone', updated: st.updated || s.started_at,
      last_message: last.length > LAST_MESSAGE_SHOWN ? `${last.slice(0, LAST_MESSAGE_SHOWN)}… (full text: ${statusFile(name)})` : last,
      unread_inbox: unread(name), window_id: s.window_id,
    };
  });
  out({ status: 'ok', sessions }, 0);
}

/** The last lines on a work session's screen, read-only. */
function cmdPeek(name, lines) {
  if (!validTaskId(name)) usage('peek <name> [lines]');
  requireTmux();
  const s = readJson(P.tmuxSessions, {})[name];
  if (!s || !liveWindows().has(s.window_id)) out({ status: 'error', message: `No live tmux session named ${name}.` });
  const n = Math.min(Math.max(parseInt(lines, 10) || 40, 1), 500);
  const r = tmux(['capture-pane', '-p', '-J', '-t', s.window_id, '-S', `-${n}`]);
  if (r.status !== 0) out({ status: 'error', message: r.stderr });
  out({ status: 'ok', name, screen: r.stdout.split('\n').slice(-n).join('\n') }, 0);
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
const HELP = `conductor kit session manager

  init                          create .conductor/ and its config; ignore it in git
  config                        print the effective config and state paths
  repo-health [--full]          block work on a broken or cloud-synced checkout
  status                        every task, its gates and owned paths
  next <task_id>                the single next step for a task
  start <task_id>               worktree + branch from the deploy branch, per the approved plan
  owned-by <path>               which live task owns a path
  update <task_id> <dev_done|tests_done|committed|note> <value>
  set-gate <task_id> <gate1|gate2> <approved|rejected|pending> [--agent-run] --evidence "<text>"
  park|unpark <task_id>         pause or resume a task, keeping everything
  drop <task_id> [--force]      abandon a task; its branch is kept
  init-integration              create the integration worktree
  integrate <task_id>           merge a gated, committed task into integration
  combined-check                run test_command at the integration HEAD; prints the SHA
  verify-integration <task_id> <sha> "<tests>" "<smoke>"
  release-ready                 may the integration HEAD ship? prints the approval to ask
  push-approved <sha>           push exactly that verified SHA to the deploy branch, non-force
  finalize <task_id>            after the push: remove the task worktree and branch
  combined-bump <levels...>     highest of patch|minor|major
  apply-version-bump <x.y.z>    the one version write per batch (needs version_file/pattern)
  acquire-build-lock|wait-build-lock|release-build-lock <task_id>   build-lock-status
  build <task_id|integration>   run build_command under the build lock

  Terminal mode (tmux):
  spawn <name> <brief-file>     start a work session as a tmux window on that brief
  send <name> "<message>"       save the message to its inbox, type only a fixed wake line (idle only)
  send <name> --file <path>     the same, with the message read from a file (exact words)
  sessions                      every tmux session: alive, state, last message, unread inbox
  peek <name> [lines]           the last lines on its screen`;

switch (cmd) {
  case 'init': cmdInit(); break;
  case 'config': cmdConfig(); break;
  case 'repo-health': cmdRepoHealth(); break;
  case 'status': cmdStatus(); break;
  case 'next': cmdNext(args[0]); break;
  case 'start': cmdStart(args[0]); break;
  case 'owned-by': cmdOwnedBy(args[0]); break;
  case 'update': cmdUpdate(args[0], args[1], args[2]); break;
  case 'set-gate': cmdSetGate(args); break;
  case 'park': cmdPark(args[0]); break;
  case 'unpark': cmdUnpark(args[0]); break;
  case 'drop': cmdDrop(args); break;
  case 'init-integration': cmdInitIntegration(); break;
  case 'integrate': cmdIntegrate(args[0]); break;
  case 'combined-check': cmdCombinedCheck(); break;
  case 'verify-integration': cmdVerifyIntegration(args[0], args[1], args[2], args[3]); break;
  case 'release-ready': cmdReleaseReady(); break;
  case 'push-approved': cmdPushApproved(args[0]); break;
  case 'finalize': cmdFinalize(args[0]); break;
  case 'combined-bump': cmdCombinedBump(args); break;
  case 'apply-version-bump': cmdApplyVersionBump(args[0]); break;
  case 'acquire-build-lock': cmdAcquireBuildLock(args[0]); break;
  case 'wait-build-lock': cmdWaitBuildLock(args[0], args[1]); break;
  case 'release-build-lock': cmdReleaseBuildLock(args[0], args[1] === '--force'); break;
  case 'build-lock-status': cmdBuildLockStatus(); break;
  case 'build': cmdBuild(args[0]); break;
  case 'spawn': cmdSpawn(args[0], args[1]); break;
  case 'send': cmdSend(args[0], args.slice(1)); break;
  case 'sessions': cmdSessions(); break;
  case 'peek': cmdPeek(args[0], args[1]); break;
  default:
    console.log(HELP);
    process.exit(cmd ? 1 : 0);
}
