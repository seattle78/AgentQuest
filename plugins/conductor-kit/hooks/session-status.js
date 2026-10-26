#!/usr/bin/env node
'use strict';
/**
 * session-status.js — in terminal mode, record a work session's state for the conductor.
 *
 * Only a session started by `session-manager.js spawn` has CONDUCTOR_KIT_SESSION set; every other
 * session exits at once. The state goes to `.conductor/sessions/<name>.json`, which
 * `session-manager.js sessions` reads:
 * - UserPromptSubmit: working
 * - PostToolUse: working again after a permission prompt was answered
 * - Notification (a permission prompt): needs_you, so the conductor types nothing into that window
 * - Stop: idle, with the session's last message (its report reaches the conductor this way)
 */

const fs = require('fs');
const path = require('path');
const { mainCheckout, paths } = require('../scripts/lib/config.js');

const NAME_RE = /^[A-Za-z0-9][\w.-]*$/;
const LAST_MESSAGE_KEPT = 20000;

/** True when a Notification payload is a permission prompt waiting on the user. */
function isPermissionPrompt(input) {
  if (input.notification_type) return input.notification_type === 'permission_prompt';
  return /permission/i.test(String(input.message || ''));
}

/**
 * The status update one hook event makes, or null for none.
 * @param {object} input - hook payload
 * @param {object} prev - the current status file contents
 * @returns {object|null} fields to merge into the status
 */
function update(input, prev) {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'working' };
    case 'PostToolUse': return prev.state === 'needs_you' ? { state: 'working' } : null;
    case 'Notification':
      return isPermissionPrompt(input) ? { state: 'needs_you', notification: String(input.message || '').slice(0, 500) } : null;
    case 'Stop':
      return { state: 'idle', last_message: String(input.last_assistant_message || '').slice(0, LAST_MESSAGE_KEPT) };
    default: return null;
  }
}

/**
 * Apply one hook event to the session's status file.
 * @param {object} input - hook payload
 * @param {object} env - process environment
 * @returns {string|null} the status file written, or null
 */
function record(input, env) {
  const name = env.CONDUCTOR_KIT_SESSION;
  if (!name || !NAME_RE.test(name) || name.includes('..')) return null;
  const main = mainCheckout(input.cwd || process.cwd());
  if (!main || !fs.existsSync(paths(main).root)) return null;
  const file = path.join(paths(main).sessionStatus, `${name}.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first event */ }
  const change = update(input, prev);
  if (!change) return null;
  const next = { ...prev, ...change, name, session_id: input.session_id || prev.session_id, updated: new Date().toISOString() };
  if (change.state !== 'needs_you') delete next.notification;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

if (require.main === module) {
  // Every other session pays only this check.
  if (!process.env.CONDUCTOR_KIT_SESSION) process.exit(0);
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try { record(JSON.parse(raw), process.env); } catch { /* never block the session */ }
    process.exit(0);
  });
}

module.exports = { record, update, isPermissionPrompt };
