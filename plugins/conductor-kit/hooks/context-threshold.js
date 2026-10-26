#!/usr/bin/env node
/**
 * context-threshold.js — PostToolBatch, UserPromptSubmit and SessionStart(compact) hook
 *
 * Keeps a chat from losing its work when the context fills. A command hook gets no context figure
 * on stdin, so this reads the session transcript the way the engine counts the window (DI over p7
 * in Claude Code 2.1.304): input, cache and output tokens of the last main-chain assistant usage,
 * and for a response with server-side iterations (an advisor call) its last non-advisor iteration,
 * never the summed top level, which reads about twice the real context. Against the engine's
 * auto-compact point (compaction window - min(maxOutput, 20k) - 13k: 967k on 1M, 167k on 200k) it
 * injects:
 *
 *   stage 1 (80% of a 1M window by default): run the conductor-kit:handoff skill now, then keep working
 *   and keep the handoff current;
 *   stage 2 (90% by default): at the next safe point refresh the handoff, tell the user in one line
 *   that auto-compaction will resume from it, do not wait, then keep working. With auto-compaction
 *   off (DISABLE_AUTO_COMPACT, DISABLE_COMPACT, or autoCompactEnabled false in ~/.claude.json or a
 *   user, project or local settings file) nothing compacts by itself, so stage 2 still asks the user
 *   to run /compact or /clear, which the model cannot run itself; DISABLE_COMPACT also disables
 *   manual /compact, so then it offers only /clear or a new window.
 *
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE lowers the compaction point and both stages with it (40%: 392k,
 * 312k, 352k on 1M).
 *
 * Each stage fires once per fill. The stage reached is kept per session in a tmpdir guard file,
 * which SessionStart(compact) deletes (the engine runs it after every compaction); a changed window
 * or a drop below half of where the stage fired also re-arms it. Subagents are skipped. PostToolBatch
 * fires once per batch, so parallel tool calls cannot race the guard. `--status <transcript>` prints
 * the figures for a manual check.
 *
 * Silent in a repository that has not opted in: it acts only where `<main checkout>/.conductor/`
 * exists (created by the kit's setup).
 *
 * Fails open: any error prints nothing and exits 0.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mainCheckout } = require('../scripts/lib/config.js');

const SMALL_WINDOW = 200000;
const LARGE_WINDOW = 1000000;
const MIN_ENV_WINDOW = 100000;
const OUTPUT_RESERVE = 20000; // the engine reserves min(maxOutputTokens, 20000); the cap applies to every current model
const COMPACT_BUFFER = 13000;
const BLOCKING_BUFFER = 3000;
const MAX_HEADROOM = 40000;
const FIRST_CHUNK = 256 * 1024;
const MAX_TAIL = 16 * 1024 * 1024;
const INPUT_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
// Models the engine catalog runs on a native 1M window (every 5.x family and later generations,
// opus 4.7 and 4.8, mythos-preview); an id missed here falls back to 200k and fires early.
const LARGE_MODELS = /^claude-(?:(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|[1-9]\d)|opus-4-[78]|mythos-preview)/;

/** True when an environment flag is set to something other than empty, 0 or false. */
function flag(value) {
  return value !== undefined && value !== '' && value !== '0' && String(value).toLowerCase() !== 'false';
}

/** Auto-compaction switched off by the environment. */
function envCompactOff(env) {
  return flag(env.DISABLE_AUTO_COMPACT) || flag(env.DISABLE_COMPACT);
}

/**
 * The autoCompactEnabled setting, which /config writes to the user settings file (~/.claude.json is
 * the legacy place). Files are read lowest precedence first, so the last one that sets it wins. The
 * --settings flag and managed policy rank above these and are not read here.
 * @param {object} env - process environment (HOME and CLAUDE_PROJECT_DIR)
 * @param {string} cwd - the hook's cwd, used when CLAUDE_PROJECT_DIR is unset
 * @returns {boolean} true when the setting resolves to false
 */
function settingsCompactOff(env, cwd) {
  const home = env.HOME || os.homedir();
  const project = env.CLAUDE_PROJECT_DIR || cwd;
  const files = [path.join(home, '.claude.json'), path.join(home, '.claude', 'settings.json')];
  if (project) files.push(path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json'));
  let enabled = true;
  for (const file of files) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')).autoCompactEnabled;
      if (typeof v === 'boolean') enabled = v;
    } catch { /* missing or unreadable: no say */ }
  }
  return !enabled;
}

/** Parse an engine window size: an integer, or a number with a k or M suffix; null otherwise. */
function parseWindow(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(value || ''));
  if (!m) return null;
  return Math.round(Number(m[1]) * (/k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : 1));
}

/**
 * The model's own window: 200k unless the model or the observed tokens show 1M.
 * @param {string} model - model id from the transcript
 * @param {number} tokens - observed tokens
 * @param {object} env - process environment
 * @returns {number} window in tokens
 */
function modelWindow(model, tokens, env) {
  if (flag(env.CLAUDE_CODE_DISABLE_1M_CONTEXT)) return SMALL_WINDOW;
  return LARGE_MODELS.test(model || '') || tokens > SMALL_WINDOW ? LARGE_WINDOW : SMALL_WINDOW;
}

/**
 * The window the engine compacts against: the model window, lowered by
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW (clamped to 100k-1M as the engine clamps it).
 * @param {string} model - model id from the transcript
 * @param {number} tokens - observed tokens
 * @param {object} env - process environment
 * @returns {number} compaction window in tokens
 */
function windowFor(model, tokens, env) {
  const window = modelWindow(model, tokens, env);
  const fromEnv = parseWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  return fromEnv ? Math.min(window, Math.max(MIN_ENV_WINDOW, Math.min(LARGE_WINDOW, fromEnv))) : window;
}

/**
 * Stage thresholds: the engine's compaction point, then two stages below it with headroom for one
 * handoff plus the tool batch the transcript does not show yet.
 * @param {number} window - compaction window in tokens
 * @param {object} env - process environment
 * @param {number} [rawWindow] - the model's own window; with auto-compaction off the engine stops at
 *   its blocking limit, which is on this window, not on the compaction window
 * @returns {{window:number, compactAt:number, stage1:number, stage2:number}}
 */
function thresholds(window, env, rawWindow = window) {
  const effective = window - OUTPUT_RESERVE;
  let compactAt = effective - COMPACT_BUFFER;
  const pct = parseFloat(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (pct > 0 && pct <= 100) compactAt = Math.min(Math.floor(effective * (pct / 100)), compactAt);
  if (envCompactOff(env)) {
    window = rawWindow;
    compactAt = rawWindow - OUTPUT_RESERVE - BLOCKING_BUFFER;
  }
  const headroom = Math.min(MAX_HEADROOM, Math.round(0.2 * compactAt));
  const stage2 = Math.min(Math.round(0.9 * window), compactAt - headroom);
  const stage1 = Math.min(Math.round(0.8 * window), stage2 - headroom);
  return { window, compactAt, stage1, stage2 };
}

/**
 * Tokens of one assistant usage as the engine counts the window: input, cache and output tokens of
 * the last iteration that is not an advisor or compaction step, when that iteration is a complete
 * message entry; otherwise of the top level. A zero top-level input means zero (the records a
 * compaction preserves carry zero usage but stale iterations).
 * @param {object} usage - message.usage
 * @returns {number} tokens
 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const input = (u) => INPUT_FIELDS.reduce((acc, k) => acc + (Number(u[k]) || 0), 0);
  const total = (u) => input(u) + (Number(u.output_tokens) || 0);
  if (!input(usage)) return 0;
  if (!Array.isArray(usage.iterations)) return total(usage);
  const last = [...usage.iterations].reverse()
    .find((it) => !(it && typeof it === 'object' && (it.type === 'advisor_message' || it.type === 'compaction')));
  const complete = last && typeof last === 'object' && (last.type === 'message' || last.type === 'fallback_message')
    && [...INPUT_FIELDS, 'output_tokens'].every((k) => typeof last[k] === 'number') && input(last) > 0;
  return complete ? total(last) : total(usage);
}

/**
 * The count one transcript record settles, or undefined when it says nothing.
 * @param {object} rec - parsed JSONL record
 * @returns {{tokens:number, model:string}|undefined}
 */
function fromRecord(rec) {
  if (!rec || rec.isSidechain === true) return undefined;
  if (rec.type === 'system' && rec.subtype === 'compact_boundary') return { tokens: 0, model: '' };
  if (rec.type !== 'assistant' || !rec.message) return undefined;
  const model = rec.message.model || '';
  if (model === '<synthetic>') return undefined;
  const tokens = usageTokens(rec.message.usage);
  return tokens ? { tokens, model } : undefined;
}

/**
 * Read the transcript backward from its end until a record settles the count.
 * @param {string} file - transcript path
 * @returns {{tokens:number, model:string}|null} null when unreadable or nothing settles it
 */
function readUsage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (let span = FIRST_CHUNK; ; span *= 2) {
      const len = Math.min(span, size, MAX_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift(); // the first line of a partial window is cut; never parse it
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].trim()) continue;
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { continue; }
        const hit = fromRecord(rec);
        if (hit) return hit;
      }
      if (len >= size || len >= MAX_TAIL) return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The guard file of a session; the id is reduced to safe filename characters. */
function stateFile(sid) {
  return path.join(os.tmpdir(), 'conductor-kit-context', `${String(sid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** Read the guard state; a missing or bad file is stage 0. */
function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { stage: Number(s.stage) || 0, firedAt: Number(s.firedAt) || 0, window: Number(s.window) || 0 };
  } catch {
    return { stage: 0, firedAt: 0, window: 0 };
  }
}

/** Write the guard state atomically, so a reader never sees half a file. */
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/**
 * Decide which stage to emit and the next guard state.
 * @param {number} tokens - current tokens
 * @param {{window:number, stage1:number, stage2:number}} t - thresholds
 * @param {{stage:number, firedAt:number, window:number}} state - guard state
 * @returns {{emit:number, next:object|null}} emit 0, 1 or 2; next is null when nothing changes
 */
function decide(tokens, t, state) {
  let { stage, firedAt } = state;
  let changed = false;
  // SessionStart(compact) deletes the guard. A new window (an unknown model past 200k, a model
  // switch) gets its own stages, and a large drop covers a reset that never ran.
  if (stage > 0 && (state.window !== t.window || tokens < firedAt / 2)) { stage = 0; firedAt = 0; changed = true; }
  let emit = 0;
  if (tokens >= t.stage2 && stage < 2) emit = 2;
  else if (tokens >= t.stage1 && stage < 1) emit = 1;
  if (emit) { stage = emit; firedAt = tokens; changed = true; }
  return { emit, next: changed ? { stage, firedAt, window: t.window } : null };
}

/** The topic of the newest live handoff this session wrote in the main checkout's store, or ''. */
function boundTopic(cwd, sid) {
  try {
    const g = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5000 });
    const common = g.status === 0 ? g.stdout.trim() : '';
    if (!common || path.basename(common) !== '.git') return '';
    const dir = path.join(path.dirname(common), '.conductor', 'handoffs');
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!/^HANDOFF_.*\.md$/.test(name)) continue;
      const file = path.join(dir, name);
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8'));
      if (!head) continue;
      const fm = {};
      for (const line of head[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
        if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
      if (fm.session_id !== sid || fm.status === 'closed' || !/^[\w.-]+$/.test(fm.topic || '')) continue;
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { topic: fm.topic, mtime };
    }
    return best ? best.topic : '';
  } catch {
    return '';
  }
}

/**
 * The instruction injected for a stage.
 * @param {number} stage - 1 or 2
 * @param {number} tokens - current tokens
 * @param {{window:number, compactAt:number}} t - thresholds
 * @param {string} topic - bound topic, or '' for the naming rule
 * @param {boolean} [compactOff] - auto-compaction is disabled, so only the user can compact
 * @param {boolean} [manualOff] - DISABLE_COMPACT: manual /compact is disabled too
 * @returns {string} English text for additionalContext
 */
function message(stage, tokens, t, topic, compactOff = false, manualOff = false) {
  const pct = Math.round((tokens / t.window) * 100);
  const where = `this session's context is at ${pct}% (${tokens} of ${t.window} tokens); auto-compact runs near ${t.compactAt}`;
  const topicText = topic
    ? `"${topic}" (the topic this session already writes; the skill adds the next seq)`
    : 'equal to the task_id this session works on, or "conductor" in the conductor window, or the topic of the handoff that session start showed as bound to this session, otherwise a short kebab-case name for the work';
  // Work done after the handoff exists only in the compaction summary, so the handoff is refreshed
  // after each step that a resumed session must not redo or lose.
  const keepCurrent = 'until the compaction, refresh the handoff right after every user decision, gate record, commit, '
    + 'integrate or push, so the compaction loses nothing';
  if (stage === 1) {
    return `[context-threshold] Stage 1 of 2: ${where}. Run the conductor-kit:handoff skill now with topic ${topicText}. `
      + `Then continue the current work; do not stop or ask the user about it; ${keepCurrent}.`;
  }
  if (compactOff) {
    const ask = manualOff ? 'to run /clear now or open a new window (manual /compact is disabled)' : 'to run /compact now, or /clear';
    const restore = manualOff ? '/clear' : '/compact or /clear';
    return `[context-threshold] Stage 2 of 2: ${where}. Now: (1) run the conductor-kit:handoff skill again with topic ${topicText}, `
      + 'so the handoff holds the latest state; (2) tell the user, in the language of the conversation, '
      + `${ask}, and that ${restore} restores the handoff while a new window needs the resume line pasted, and give them `
      + 'the "Resume: read <path>" line the skill prints; you cannot run /compact or /clear yourself; '
      + '(3) then continue the current work: once the handoff is written, a compaction loses nothing.';
  }
  return `[context-threshold] Stage 2 of 2: ${where}. Now: (1) at the next safe point (once a commit, integrate, push or approval `
    + `in progress is done) run the conductor-kit:handoff skill again with topic ${topicText}, so the handoff holds the latest state; `
    + '(2) tell the user, in the language of the conversation, in one line, the handoff path and the '
    + '"Resume: read <path>" line the skill prints, that auto-compaction will resume from it, and that /compact does it sooner if they want; '
    + 'do not ask them to do it and do not wait for an answer; '
    + `you cannot run /compact or /clear yourself; (3) then continue the current work; ${keepCurrent}.`;
}

/** Print the figures for a transcript: the manual check. */
function status(file, env) {
  const u = readUsage(file);
  if (!u) { console.log(`[context-threshold] no usage found in ${file}`); return; }
  const t = thresholds(windowFor(u.model, u.tokens, env), env, modelWindow(u.model, u.tokens, env));
  const stageNow = u.tokens >= t.stage2 ? 2 : u.tokens >= t.stage1 ? 1 : 0;
  console.log(JSON.stringify({ tokens: u.tokens, model: u.model, ...t, stageNow }, null, 2));
}

/** Run as a hook: read stdin, decide, print additionalContext JSON when a stage fires. */
function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  if (!input || input.agent_id) return;
  const sid = input.session_id;
  if (typeof sid !== 'string' || !sid) return;
  const sf = stateFile(sid);
  if (input.hook_event_name === 'SessionStart') { // after a compaction the next fill starts over
    fs.rmSync(sf, { force: true });
    return;
  }
  const file = input.transcript_path;
  if (typeof file !== 'string' || !file) return;
  const main = mainCheckout(input.cwd || process.cwd());
  if (!main || !fs.existsSync(path.join(main, '.conductor'))) return;
  const u = readUsage(file);
  if (!u) return;
  const env = process.env;
  const cwd = input.cwd || process.cwd();
  // The settings value changes only the text, never the stages: a source this hook cannot read may
  // force auto-compaction on, and stages placed by the blocking limit would then come too late.
  const compactOff = envCompactOff(env) || settingsCompactOff(env, cwd);
  const t = thresholds(windowFor(u.model, u.tokens, env), env, modelWindow(u.model, u.tokens, env));
  const { emit, next } = decide(u.tokens, t, readState(sf));
  if (next) writeState(sf, next);
  if (!emit) return;
  const event = input.hook_event_name === 'UserPromptSubmit' ? 'UserPromptSubmit' : 'PostToolBatch';
  const text = message(emit, u.tokens, t, boundTopic(cwd, sid), compactOff, flag(env.DISABLE_COMPACT));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--status') status(process.argv[3] || '', process.env);
    else main();
  } catch { /* fail open: a session must never be blocked by this hint */ }
  process.exit(0);
}

module.exports = { settingsCompactOff, parseWindow, modelWindow, windowFor, thresholds, usageTokens, readUsage, decide, message, stateFile };
