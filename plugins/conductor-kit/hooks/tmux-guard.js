#!/usr/bin/env node
'use strict';
/**
 * tmux-guard.js — PreToolUse(Bash): in a repository set up for the conductor kit, deny raw tmux
 * commands that type or paste into a pane.
 *
 * Keys typed into a session's window look exactly like the user typing there, so a relayed
 * "approve" could pass for the user's own words. `session-manager.js send` is the one way to reach
 * a work session: it saves the message to the session's inbox and types only a fixed wake line.
 * This is a guard rail for the model, not a sandbox.
 */

const fs = require('fs');
const { mainCheckout, paths } = require('../scripts/lib/config.js');

// tmux, as a command word rather than part of a path, then a subcommand (or alias) that puts text into a pane.
const RAW_INPUT = /(?:^|[\s;|&(`'",[])tmux(?=[\s'",\]])[^\n;|&]*?\b(send-keys|send|paste-buffer|pasteb|set-buffer|setb|load-buffer|loadb)\b/;

/**
 * Decide the hook output for one Bash call.
 * @param {object} input - PreToolUse payload
 * @returns {object|null} a deny, or null to leave the call alone
 */
function decide(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  const command = String((input.tool_input || {}).command || '');
  if (!RAW_INPUT.test(command)) return null;
  const main = mainCheckout(input.cwd || process.cwd());
  if (!main || !fs.existsSync(paths(main).root)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'tmux guard (conductor kit): do not type or paste into a tmux pane directly; keys there ' +
        'look like the user typing. Relay with `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.js" send <name> "<message>"`: ' +
        'it saves the message to the session\'s inbox and types only a fixed wake line.',
    },
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let res = null;
    try { res = decide(JSON.parse(raw)); } catch { /* unreadable input: leave the call alone */ }
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(0);
  });
}

module.exports = { decide, RAW_INPUT };
