'use strict';
/**
 * config.js — where the conductor kit keeps its state, and the project's settings.
 *
 * Everything lives under one folder in the main checkout, `<main>/.conductor/`, so every worktree
 * and every session of a project shares one registry, one board and one handoff store. The main
 * checkout is the parent of the absolute git common dir, which is the same for a linked worktree.
 * CONDUCTOR_KIT_MAIN and CONDUCTOR_KIT_WORKTREE_BASE override the two locations (tests use them).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULTS = Object.freeze({
  user_name: 'you',
  language: 'English',
  board_language: 'en',
  remote: 'origin',
  deploy_branch: 'main',
  integration_branch: 'integration',
  test_command: '',
  build_command: '',
  pipeline_wait_command: '',
  version_file: '',
  version_pattern: '',
  worktree_base: '',
  db_write_default_patterns: true,
  db_write_patterns: [],
  review_max_rounds: 2,
  // Terminal mode: work sessions run as tmux windows. Empty socket means the default tmux server.
  tmux_session: 'conductor-kit',
  tmux_socket: '',
  claude_command: 'claude',
});

/**
 * The main checkout of the repository that holds `cwd`.
 * @param {string} [cwd] - directory to start from
 * @returns {string|null} absolute path, or null outside a normal git repository
 */
function mainCheckout(cwd = process.cwd()) {
  if (process.env.CONDUCTOR_KIT_MAIN) return path.resolve(process.env.CONDUCTOR_KIT_MAIN);
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd, encoding: 'utf8', timeout: 5000,
  });
  const common = r.status === 0 ? r.stdout.trim() : '';
  if (!common || path.basename(common) !== '.git') return null;
  return path.dirname(common);
}

/**
 * Every path the kit reads or writes for one main checkout.
 * @param {string} main - main checkout
 * @returns {object} named absolute paths
 */
function paths(main) {
  const root = path.join(main, '.conductor');
  return {
    root,
    config: path.join(root, 'config.json'),
    plans: path.join(root, 'plans'),
    handoffs: path.join(root, 'handoffs'),
    board: path.join(root, 'board'),
    state: path.join(root, 'state'),
    registry: path.join(root, 'state', 'registry.json'),
    workflow: path.join(root, 'state', 'workflow'),
    lock: path.join(root, 'state', 'registry.lock'),
    buildLock: path.join(root, 'state', 'build-lock.json'),
    tmuxSessions: path.join(root, 'state', 'tmux-sessions.json'),
    sessionStatus: path.join(root, 'sessions'),
    inbox: path.join(root, 'inbox'),
    briefs: path.join(root, 'briefs'),
  };
}

/** Expand a leading ~ to the home directory. */
function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * The project's settings: `.conductor/config.json` over the defaults. A missing or unreadable file
 * gives the defaults; an unknown key is kept so a later version can read it.
 * @param {string} main - main checkout
 * @returns {object} settings, with worktree_base resolved to an absolute path
 */
function loadConfig(main) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(paths(main).config, 'utf8')); } catch { /* defaults */ }
  const cfg = { ...DEFAULTS, ...file };
  const base = process.env.CONDUCTOR_KIT_WORKTREE_BASE || cfg.worktree_base ||
    path.join(os.homedir(), '.conductor-kit', 'worktrees', path.basename(main));
  cfg.worktree_base = path.resolve(expandHome(base));
  return cfg;
}

module.exports = { DEFAULTS, mainCheckout, paths, loadConfig };
