#!/usr/bin/env node
'use strict';
/**
 * db-write-guard.js — PreToolUse hook (Bash | Monitor | mcp__.*)
 *
 * Every database write needs the user's approval; reads never do. A call counts as a write when:
 *   - a SQL client (psql, mysql, sqlite3, ...) runs a write statement, or reads statements the guard
 *     cannot see (-f file, < file);
 *   - a document or key-value client (mongosh, redis-cli) runs a write command;
 *   - a schema migration or restore tool runs (alembic upgrade, prisma migrate, rails db:migrate, ...);
 *   - an MCP tool whose name says database runs a write statement or a write operation;
 *   - the command matches a project pattern from `.conductor/config.json` `db_write_patterns`
 *     (`db_write_default_patterns: false` keeps only the project's patterns).
 * Writes from inside application code (an ORM call in a script) are not visible to a command
 * check; projects add patterns for their own scripts.
 *
 * Flow: a main-session call is denied the first time, with the report the agent must post first;
 * the identical call run again is asked, so the approval prompt reaches the user. A subagent is
 * always denied (its text does not reach the user), and so is every call in acceptEdits,
 * bypassPermissions and dontAsk, where an "ask" is not guaranteed to prompt.
 * A crash never silently allows a likely write: it asks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { mainCheckout, loadConfig, DEFAULTS } = require('../scripts/lib/config.js');

const FAIL_CLOSED_MODES = ['acceptEdits', 'bypassPermissions', 'dontAsk'];
const REPORT_HEADINGS = [
  'Background',
  'Why',
  'How (the exact statement or command, the target database and host alias without secrets, the rows affected, the backup and rollback)',
  'Who (this session or agent)',
  'When (now, or after which step)',
];

const SQL_CLIENT = /\b(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse(-client)?|cqlsh|duckdb|cockroach\s+sql|snowsql|bq\s+query)\b/i;
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+[\w."`\[\]]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|UPSERT\s+INTO|REPLACE\s+INTO|TRUNCATE|DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|USER|ROLE)|ALTER\s+(TABLE|DATABASE|SCHEMA|USER|ROLE)|CREATE\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|USER|ROLE)|GRANT\s|REVOKE\s|COPY\s+\S+\s+FROM)\b/i;
// Statements the guard cannot read: a script file or redirected input.
const SQL_UNSEEN = /(^|\s)(-f|--file|-i|--init-command|\.read)\s*\S|<\s*[^<\s]|\bsource\s+\S+\.sql\b/;
const DOC_WRITE = /\b(mongosh?|mongo)\b[\s\S]*\.(insert(One|Many)?|update(One|Many)?|delete(One|Many)?|remove|replaceOne|findOneAndUpdate|findOneAndDelete|bulkWrite|drop(Database)?|createCollection|renameCollection)\s*\(|\bredis-cli\b[\s\S]*\b(SET|SETEX|MSET|DEL|UNLINK|FLUSHALL|FLUSHDB|HSET|HDEL|LPUSH|RPUSH|LPOP|RPOP|SADD|SREM|ZADD|ZREM|EXPIRE|INCR|DECR|RENAME)\b/i;
const MIGRATION = /\b(alembic\s+(upgrade|downgrade|stamp)|prisma\s+(migrate\s+(dev|deploy|reset)|db\s+(push|seed|execute))|rails\s+db:(migrate|rollback|seed|reset|drop|setup|schema:load)|rake\s+db:\w+|knex\s+(migrate|seed):\w+|manage\.py\s+(migrate|flush|loaddata)|flyway\s+(migrate|clean|repair|baseline|undo)|liquibase\s+(update|rollback|drop-all|dropAll)|sequelize(-cli)?\s+db:(migrate|seed)\S*|dbmate\s+(up|down|migrate|rollback|drop|create)|goose\s+(\S+\s+){0,2}(up|down|reset|redo)\b|typeorm\s+(migration:(run|revert)|schema:(sync|drop))|diesel\s+(migration\s+(run|redo|revert)|database\s+reset)|sqlx\s+(migrate\s+run|database\s+(drop|reset))|atlas\s+(schema|migrate)\s+apply|drizzle-kit\s+(push|migrate)|supabase\s+db\s+(push|reset)|(dropdb|createdb|pg_restore|mysqlimport|mongorestore|mongoimport)\b)/i;
const SQL_READ = /\b(SELECT|SHOW|DESCRIBE|EXPLAIN|PRAGMA)\b/i;
const DB_MCP =/^mcp__.*(sql|postgres|mysql|maria|sqlite|database|\bdb\b|_db|db_|mongo|redis|supabase|bigquery|snowflake|clickhouse|dynamo|firestore)/i;
const MCP_WRITE_OP = /(execute|exec|write|insert|update|delete|upsert|mutate|drop|create|alter|migrat|apply)/i;

/** The project's guard settings: defaults outside a configured repository. */
function guardConfig(cwd) {
  const main = mainCheckout(cwd);
  const cfg = main ? loadConfig(main) : { ...DEFAULTS };
  const extra = (Array.isArray(cfg.db_write_patterns) ? cfg.db_write_patterns : []).flatMap((p) => {
    try { return [new RegExp(p, 'i')]; } catch { return []; }
  });
  return { defaults: cfg.db_write_default_patterns !== false, extra };
}

/**
 * What in one tool call can write to a database.
 * @param {object} input - PreToolUse payload
 * @param {{defaults:boolean, extra:RegExp[]}} g - guard settings
 * @returns {string[]} one finding per reason; empty for a call that cannot write
 */
function findings(input, g) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const found = [];
  if (tool === 'Bash' || tool === 'Monitor') {
    const cmd = String(ti.command || '');
    if (g.defaults) {
      if (SQL_CLIENT.test(cmd) && SQL_WRITE.test(cmd)) found.push('a SQL client runs a write statement');
      else if (SQL_CLIENT.test(cmd) && SQL_UNSEEN.test(cmd)) found.push('a SQL client runs statements the guard cannot see (a file or redirected input)');
      if (DOC_WRITE.test(cmd)) found.push('a document or key-value client runs a write command');
      if (MIGRATION.test(cmd)) found.push('a schema migration, seed or restore tool runs');
    }
    for (const re of g.extra) if (re.test(cmd)) found.push(`the command matches the project pattern /${re.source}/`);
  } else if (tool.startsWith('mcp__')) {
    const text = JSON.stringify(ti);
    if (g.defaults && DB_MCP.test(tool)) {
      // SQL in the input decides; the tool's name decides only when there is none (execute_sql with a SELECT is a read).
      if (SQL_WRITE.test(text)) found.push(`database tool ${tool} runs a write statement`);
      else if (!SQL_READ.test(text) && MCP_WRITE_OP.test(tool.split('__').pop())) found.push(`database tool ${tool} is a write operation`);
      if (DOC_WRITE.test(`mongosh ${text}`)) found.push(`database tool ${tool} runs a write command`);
    }
    for (const re of g.extra) if (re.test(`${tool} ${text}`)) found.push(`the call matches the project pattern /${re.source}/`);
  }
  return [...new Set(found)];
}

function report() {
  return REPORT_HEADINGS.map((h, i) => `${i + 1}. ${h}`).join('\n');
}

/** A stable id for one exact tool call, so its identical re-run can be recognized. */
function callHash(input) {
  return crypto.createHash('sha256').update(JSON.stringify([input.tool_name, input.tool_input])).digest('hex').slice(0, 32);
}

function output(decision, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

/**
 * Decide the hook output for one call.
 * @param {object} input - PreToolUse payload
 * @param {object} [opts] - {stateDir, guard} for tests
 * @returns {object|null} hook output, or null to leave the call to the normal permission flow
 */
function decide(input, opts = {}) {
  const g = opts.guard || guardConfig(input.cwd || process.cwd());
  const what = findings(input, g);
  if (!what.length) return null;
  const head = `DB write guard (conductor kit): this call can write to a database:\n- ${what.join('\n- ')}\n\n`;
  if (input.agent_id) {
    return output('deny', `${head}Every database write needs the user's approval, and a subagent's text does not reach the user. ` +
      `Do not run it. Hand this step back to the session that dispatched you, with the exact command and a report under these headings:\n${report()}`);
  }
  if (FAIL_CLOSED_MODES.includes(input.permission_mode)) {
    return output('deny', `${head}This session runs in ${input.permission_mode} mode, where an approval prompt is not guaranteed, ` +
      `so the guard never lets a database write through here. Post the user a report under these headings:\n${report()}\n` +
      'and ask the user to run the command or to switch this session to default mode.');
  }
  const stateDir = opts.stateDir || path.join(os.tmpdir(), 'conductor-kit-db-guard');
  const sid = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const marker = path.join(stateDir, sid, callHash(input));
  if (!fs.existsSync(marker)) {
    let written = true;
    try { fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 }); fs.writeFileSync(marker, String(Date.now())); } catch { written = false; }
    // A marker that cannot be written asks at once: a deny that could never become an ask would deadlock.
    if (written) {
      return output('deny', `${head}Every database write needs the user's approval. First post the user a short report, in the ` +
        `user's language, with exactly these headings in this order:\n${report()}\nThen run exactly the same call again: ` +
        'Claude Code will show the user an approval prompt. If a conductor started this session, tell it you are waiting on the user.');
    }
  }
  return output('ask', `DB write guard (conductor kit): this can write to a database:\n- ${what.join('\n- ')}\n` +
    'Approve only if the agent posted the report (Background / Why / How / Who / When) for this exact call just above.');
}

const STRONG_SIGNAL = /\b(psql|mysql|sqlite3|mongosh?|redis-cli|alembic|prisma|migrate|dropdb|pg_restore)\b/i;

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let res = null;
    try { res = decide(JSON.parse(raw)); } catch (e) {
      if (STRONG_SIGNAL.test(raw)) res = output('ask', `DB write guard (conductor kit) could not read this call (${e && e.message}); it looks like it can write to a database. Approve only if the agent explained it.`);
    }
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(0);
  });
}

module.exports = { decide, findings, guardConfig, REPORT_HEADINGS };
