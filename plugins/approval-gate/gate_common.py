#!/usr/bin/env python3
"""Shared helpers for the deterministic approval gate.

Pure stdlib, no network, no LLM calls. Everything in this module is
deterministic: same input -> same output. Used by hook.py (PreToolUse),
audit.py (PostToolUse) and session_start.py (SessionStart).

Design notes (from the research report):
- The gate is the control of last resort: it does NOT need to recognise
  the attack (prompt injection is probabilistic and bypassable); it only
  needs to recognise that the *action* is irreversible.
- SymJack lesson: always resolve symlinks (realpath) before comparing a
  path against credential/config lists.
- Invariant lesson: show the FULL arguments, not the model's summary.
- postmark-mcp lesson: a malicious server can add recipients server-side
  that never appear in tool_input -- the gate can only show what the
  model sent, so scope allow-listing (which servers may run at all) is
  the real control for that case. This is documented, not hidden.
"""

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

GATE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SCOPE = os.path.join(GATE_DIR, "scope.json")

# ---------------------------------------------------------------- paths

# Files whose *contents* are credentials. Reading them is DENY and
# writing them is DENY (including .env files -- hook.py denies both).
CREDENTIAL_PATTERNS = [
    re.compile(r"(^|/)\.ssh(/|$)"),            # ~/.ssh/*
    re.compile(r"(^|/)\.gnupg(/|$)"),          # ~/.gnupg/*
    re.compile(r"(^|/)\.aws(/|$)"),            # ~/.aws/*
    re.compile(r"(^|/)\.docker(/|$)"),         # ~/.docker/config.json (creds)
    re.compile(r"(^|/)\.config/gh(/|$)"),      # gh hosts.yml (tokens)
    re.compile(r"(^|/)\.config/gcloud(/|$)"),  # gcloud credentials
    re.compile(r"(^|/)\.kube(/|$)"),           # kubeconfig (cluster creds)
    re.compile(r"(^|/)\.netrc$"),
    re.compile(r"(^|/)\.git-credentials$"),
    re.compile(r"(^|/)\.npmrc$"),
    re.compile(r"(^|/)\.pypirc$"),
    re.compile(r"(^|/)\.env(\.|$)"),           # .env, .env.local, .env.*
    re.compile(r"(^|/)id_rsa$"),
    re.compile(r"(^|/)id_ed25519$"),
    re.compile(r"(^|/)id_ecdsa$"),
    re.compile(r"(^|/)id_dsa$"),
    re.compile(r"\.pem$"),
    re.compile(r"\.key$"),
    re.compile(r"\.p12$"),
    re.compile(r"\.pfx$"),
    re.compile(r"(^|/)[^/]*\.keychain(-db)?$"),
    re.compile(r"keychain", re.IGNORECASE),
    re.compile(r"(^|/)credentials$"),          # ~/.aws/credentials etc.
    re.compile(r"(^|/)secrets?\.ya?ml$"),
]

# Files whose *modification* changes what the agent can do or what runs
# at startup. Writing them is ASK (or DENY for the most sensitive).
CONFIG_PATTERNS = [
    re.compile(r"(^|/)\.mcp\.json$"),          # MCP server definitions
    re.compile(r"(^|/)settings\.json$"),       # Claude Code settings
    re.compile(r"(^|/)settings\.local\.json$"),
    re.compile(r"(^|/)\.claude\.json$"),
    re.compile(r"(^|/)\.zshrc$"),
    re.compile(r"(^|/)\.bashrc$"),
    re.compile(r"(^|/)\.bash_profile$"),
    re.compile(r"(^|/)\.zprofile$"),
    re.compile(r"(^|/)\.profile$"),
    re.compile(r"(^|/)LaunchAgents(/|$)"),
    re.compile(r"(^|/)LaunchDaemons(/|$)"),
    re.compile(r"(^|/)\.vscode/settings\.json$"),   # IDEsaster: settings overwrite
    re.compile(r"(^|/)\.idea/workspace\.xml$"),
    re.compile(r"(^|/)SKILL\.md$"),           # skill file change = new instructions
]

# Config files whose hash is snapshotted at SessionStart and re-checked on
# every PreToolUse call. A mid-session change is the rug-pull signal
# (Invariant / MCPoison / postmark-mcp v1.0.16 pattern).
WATCHED_CONFIG_NAMES = [
    ".mcp.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude.json",
]

WATCHED_CONFIG_HOME = [
    os.path.expanduser("~/.claude/settings.json"),
    os.path.expanduser("~/.claude/settings.local.json"),
    os.path.expanduser("~/.claude.json"),
]

SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|token|secret|password|passwd|pwd|bearer|private[_-]?key|"
    r"auth|credential|session[_-]?key|access[_-]?key)",
    re.IGNORECASE,
)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL_RE = re.compile(r"https?://[^\s'\"\)\]]+")
CRYPTO_ADDR_RE = re.compile(r"\b0x[a-fA-F0-9]{40}\b|\bbc1[a-z0-9]{25,62}\b")
ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff\u2060\u00ad\u2028\u2029]")
JSFUCK_RE = re.compile(r"\[\]\(\)!\+{6,}|\[\]\[\(\)!\+")

# ---------------------------------------------------------------- state


def state_dir():
    return os.environ.get(
        "GATE_STATE_DIR",
        os.path.expanduser("~/.claude/approval-gate/state"),
    )


def audit_log_path():
    return os.environ.get(
        "GATE_AUDIT_LOG",
        os.path.expanduser("~/.claude/approval-gate/audit.jsonl"),
    )


def gate_dir():
    return os.environ.get("GATE_DIR", GATE_DIR)


def load_scope(cwd):
    """Resolve the active per-task scope. Precedence:
    1. --scope argument (handled by caller, passed as env override)
    2. $APPROVAL_GATE_SCOPE (path to a scope JSON)
    3. active-scope file in the gate dir (one scope name per line)
    4. scope.json next to the hook (default: coding)
    """
    path = os.environ.get("APPROVAL_GATE_SCOPE")
    if not path:
        active = os.path.join(gate_dir(), "active-scope")
        try:
            with open(active, "r", encoding="utf-8") as f:
                name = f.read().strip()
            if name:
                cand = os.path.join(gate_dir(), "scopes", name + ".json")
                if os.path.exists(cand):
                    path = cand
        except OSError:
            pass
    if not path:
        path = os.path.join(gate_dir(), "scope.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            scope = json.load(f)
    except (OSError, json.JSONDecodeError):
        scope = {}
    scope.setdefault("name", "default")
    scope.setdefault("allowed_roots", ["{cwd}"])
    scope.setdefault("extra_roots", [])
    scope.setdefault("allowed_mcp_servers", [])
    scope.setdefault("allowed_domains", [])
    scope.setdefault("allowed_bash_prefixes", [])
    scope.setdefault("extra_deny_regex", [])
    scope.setdefault("extra_ask_regex", [])
    scope.setdefault("send_tool_patterns", ["send", "email", "mail", "message", "post", "publish", "share", "invite"])
    scope.setdefault("payment_tool_patterns", ["pay", "payment", "transfer", "charge", "invoice", "payout", "donate"])
    scope.setdefault("enabled", True)
    return scope


def allowed_roots(scope, cwd):
    roots = []
    for r in scope.get("allowed_roots", ["{cwd}"]) + scope.get("extra_roots", []):
        r = r.replace("{cwd}", cwd or os.getcwd())
        r = os.path.expanduser(r)
        roots.append(os.path.realpath(r))
    return roots


def is_under(path, roots):
    """True if realpath(path) is inside one of roots."""
    rp = os.path.realpath(path)
    for root in roots:
        if rp == root or rp.startswith(root + os.sep):
            return True
    return False


def is_credential_path(path):
    return any(p.search(path) for p in CREDENTIAL_PATTERNS)


def is_config_path(path):
    return any(p.search(path) for p in CONFIG_PATTERNS)


def resolve_cmd_path(token, cwd):
    """Resolve a path token as it appears in a shell command: expand ~,
    $HOME and other env vars, make relative paths absolute against cwd,
    then resolve symlinks (SymJack defence)."""
    if not token:
        return token
    t = os.path.expanduser(os.path.expandvars(token))
    if not os.path.isabs(t):
        t = os.path.join(cwd or os.getcwd(), t)
    return os.path.realpath(os.path.normpath(t))


def sha256_file(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def watched_config_files(cwd):
    files = list(WATCHED_CONFIG_HOME)
    for name in WATCHED_CONFIG_NAMES:
        files.append(os.path.join(cwd or os.getcwd(), name))
    return files


def snapshot_configs(cwd):
    snap = {}
    for path in watched_config_files(cwd):
        digest = sha256_file(path)
        if digest is not None:
            snap[os.path.realpath(path)] = digest
    return snap


def baseline_path():
    return os.path.join(state_dir(), "baseline.json")


def load_baseline():
    try:
        with open(baseline_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def save_baseline(baseline):
    os.makedirs(state_dir(), exist_ok=True)
    tmp = baseline_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2, sort_keys=True)
    os.replace(tmp, baseline_path())


def check_baseline(cwd):
    """Compare current watched-config hashes with the SessionStart
    baseline. Returns (changed_paths, baseline_exists)."""
    baseline = load_baseline()
    if baseline is None:
        return [], False
    current = snapshot_configs(cwd)
    changed = []
    for path, digest in baseline.get("files", {}).items():
        if path in current and current[path] != digest:
            changed.append(path)
        elif path not in current:
            changed.append(path + " (deleted)")
    # New watched files that did not exist at baseline are also suspicious
    # only for .mcp.json (a server added mid-session).
    for path in current:
        if path not in baseline.get("files", {}) and path.endswith(".mcp.json"):
            changed.append(path + " (added)")
    return changed, True


def append_audit(record):
    """Append one JSONL line to the audit log. Best-effort: never raise."""
    try:
        path = audit_log_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        record.setdefault("ts", datetime.now(timezone.utc).isoformat())
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def redact_args(obj, depth=0):
    """Recursively redact values whose key looks like a secret."""
    if depth > 4:
        return "..."
    if isinstance(obj, dict):
        return {
            k: ("***REDACTED***" if SECRET_KEY_RE.search(str(k)) else redact_args(v, depth + 1))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact_args(v, depth + 1) for v in obj]
    if isinstance(obj, str) and len(obj) > 500:
        return obj[:500] + "…[truncated]"
    return obj


def extract_recipients_and_amounts(obj, out=None, depth=0):
    """Walk tool_input and pull out anything that looks like a recipient,
    amount, URL or webhook -- the fields a human must see before approving
    a send/payment. Returns a list of 'key=value' strings."""
    if out is None:
        out = []
    if depth > 4 or len(out) > 20:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            lk = str(k).lower()
            if re.search(r"bcc|cc$|to$|recipient|email|address|wallet|phone|webhook|url|amount|price|value|total|sum|currency", lk):
                if isinstance(v, (str, int, float)):
                    out.append("%s=%s" % (k, v))
                else:
                    extract_recipients_and_amounts(v, out, depth + 1)
            else:
                extract_recipients_and_amounts(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            extract_recipients_and_amounts(v, out, depth + 1)
    elif isinstance(obj, str):
        for m in EMAIL_RE.finditer(obj):
            out.append("email-in-text=%s" % m.group(0))
        for m in CRYPTO_ADDR_RE.finditer(obj):
            out.append("crypto-address=%s" % m.group(0))
    return out


def provenance(transcript_path, max_bytes=131072):
    """Best-effort provenance: what did the agent read just before this
    call, and what did the user last ask? Reads only the tail of the
    transcript JSONL. Deterministic, no LLM. Returns a short string."""
    if not transcript_path:
        return "provenance unavailable (no transcript path)"
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as f:
            f.seek(max(0, size - max_bytes))
            tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return "provenance unavailable (transcript unreadable)"
    last_user = None
    recent_sources = []
    for line in tail.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message", {})
        role = msg.get("role")
        content = msg.get("content")
        if role == "user" and isinstance(content, str):
            last_user = content.strip()
        elif role == "user" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    last_user = block.get("text", "").strip()
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    name = block.get("name", "")
                    inp = block.get("input", {}) or {}
                    src = None
                    if name in ("Read", "Write", "Edit", "NotebookEdit"):
                        src = inp.get("file_path")
                    elif name == "WebFetch":
                        src = inp.get("url")
                    elif name == "Bash":
                        src = "Bash: " + str(inp.get("command", ""))[:80]
                    if src:
                        recent_sources.append("%s -> %s" % (name, src))
    parts = []
    if last_user:
        parts.append("last user instruction: \"%s\"" % (last_user[:200],))
    if recent_sources:
        parts.append("recent reads: " + "; ".join(recent_sources[-3:]))
    if not parts:
        return "provenance unavailable (no prior context in transcript tail)"
    return " | ".join(parts)
