#!/usr/bin/env python3
"""Deterministic approval gate -- Claude Code PreToolUse hook.

Reads the PreToolUse JSON event on stdin, applies deterministic rules
only (regexes, path resolution, allow-lists -- NO LLM calls, NO network),
and prints a hookSpecificOutput JSON decision:

    {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                            "permissionDecision": "allow"|"deny"|"ask",
                            "permissionDecisionReason": "..."}}

The permissionDecisionReason for "ask" is shown to the user in the
permission prompt -- it IS the approval screen. It therefore always
carries: the resolved target (symlinks resolved, SymJack lesson), the
FULL arguments (Invariant lesson), recipient/amount/URL where relevant,
and provenance (which file/URL/user instruction led here).

Fail-closed: any error -> DENY. Unknown tool -> ASK. Unknown MCP
server -> DENY. The most dangerous patterns -> DENY without asking
(rm -rf /, sudo, pipe-to-shell, payment POSTs, credential reads).

Usage (Claude Code settings.json):
    "PreToolUse": [{"matcher": "*",
      "hooks": [{"type": "command",
                 "command": "python3 ~/.claude/approval-gate/hook.py"}]}]

Scope selection: --scope <path|name> | $APPROVAL_GATE_SCOPE |
active-scope file | scope.json (default: coding).
Kill switch: $APPROVAL_GATE_DISABLE=1 (emergencies only).
"""

import json
import os
import re
import shlex
import sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate_common as gc

# ---------------------------------------------------------------- constants

READ_CONTENT_CMDS = {
    "cat", "head", "tail", "less", "more", "bat", "grep", "rg", "sed",
    "awk", "cp", "scp", "rsync", "tar", "zip", "unzip", "base64", "xxd",
    "openssl", "gpg", "jq", "yq", "strings", "xxd", "od", "hexdump",
    "pbcopy", "xclip", "curl", "wget", "nc", "netcat", "socat",
}
LIST_CMDS = {"ls", "stat", "file", "du", "find", "tree", "wc"}
ARCHIVE_CMDS = {"tar", "zip", "ditto", "hdiutil"}

PAYMENT_DOMAINS = {
    "paypal.me", "paypal.com", "stripe.com", "buy.stripe.com",
    "checkout.stripe.com", "venmo.com", "cash.app", "square.link",
    "checkout.square.site", "commerce.coinbase.com", "pay.coinbase.com",
}
PAYMENT_CMD_RE = re.compile(
    r"\b(cast\s+send|solana\s+transfer|bitcoin-cli\s+sendtoaddress|"
    r"eth\s+send|stripe\s+.*(charges\s+create|payment_links\s+create))\b",
    re.IGNORECASE,
)
PIPE_TO_SHELL_RE = re.compile(
    r"\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|python3?|node|perl|ruby|php)\b"
)
PIPE_TO_SHELL_NOSPACE_RE = re.compile(r"\|\s*(sh|bash)\s*$")

KNOWN_BENIGN_TOOLS = {
    "TodoWrite", "Skill", "AskUserQuestion", "ExitPlanMode",
    "Task",  # handled separately (prompt scan) -- listed here for clarity
}

# ---------------------------------------------------------------- findings


class Finding:
    def __init__(self, severity, label, detail=""):
        assert severity in ("deny", "ask")
        self.severity = severity
        self.label = label
        self.detail = detail

    def __str__(self):
        s = "%s — %s" % (self.severity.upper(), self.label)
        if self.detail:
            s += ": " + self.detail
        return s


class Ctx:
    def __init__(self, event):
        self.event = event
        self.tool = event.get("tool_name", "")
        self.input = event.get("tool_input") or {}
        self.cwd = event.get("cwd") or os.getcwd()
        self.scope = gc.load_scope(self.cwd)
        self.roots = gc.allowed_roots(self.scope, self.cwd)
        self.findings = []
        self.notes = []  # informational, shown in reason but not decisive

    def deny(self, label, detail=""):
        self.findings.append(Finding("deny", label, detail))

    def ask(self, label, detail=""):
        self.findings.append(Finding("ask", label, detail))

    def decision(self):
        if any(f.severity == "deny" for f in self.findings):
            return "deny"
        if any(f.severity == "ask" for f in self.findings):
            return "ask"
        return "allow"


# ---------------------------------------------------------------- shell parsing


def split_shell_commands(cmd):
    """Split a shell command into subcommands on top-level operators
    (&&, ||, ;, |, &, newline), respecting quotes, and extract command
    substitution contents $(...) / `...` as extra subcommands to analyse.
    Returns a list of subcommand strings."""
    subs = []
    top = []
    buf = []
    i, n = 0, len(cmd)
    in_single = in_double = False
    escaped = False
    depth = 0  # paren depth inside $(...)
    while i < n:
        ch = cmd[i]
        if escaped:
            buf.append(ch)
            escaped = False
            i += 1
            continue
        if ch == "\\" and not in_single:
            escaped = True
            buf.append(ch)
            i += 1
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            buf.append(ch)
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            buf.append(ch)
            i += 1
            continue
        if not in_single and not in_double:
            if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
                # command substitution: capture inner text (balanced parens)
                j = i + 2
                d = 1
                inner = []
                while j < n and d > 0:
                    if cmd[j] == "(":
                        d += 1
                    elif cmd[j] == ")":
                        d -= 1
                    if d > 0:
                        inner.append(cmd[j])
                    j += 1
                subs.append("".join(inner))
                buf.append("$(...)")
                i = j
                continue
            if ch == "`":
                j = cmd.find("`", i + 1)
                if j == -1:
                    j = n
                subs.append(cmd[i + 1:j])
                buf.append("`...`")
                i = j + 1
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(0, depth - 1)
            if depth == 0:
                two = cmd[i:i + 2]
                if two in ("&&", "||"):
                    top.append("".join(buf).strip())
                    buf = []
                    i += 2
                    continue
                if ch in ";|&\n":
                    top.append("".join(buf).strip())
                    buf = []
                    i += 1
                    continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        top.append(tail)
    out = [t for t in top if t]
    for s in subs:
        out.extend(split_shell_commands(s))
    return out


WRAPPERS = {"env", "nice", "nohup", "time", "command", "builtin", "xargs"}


def unwrap_argv(argv):
    """Strip leading VAR=x assignments and harmless wrappers, looping
    so a wrapper's own flags (nice -n 5, env FOO=bar, env -u X) cannot
    hide the real command. Returns (argv, was_xargs).

    Bare `env` (no command left) returns an empty argv: the caller
    treats that as an environment dump, not as a no-op."""
    argv = list(argv)
    was_xargs = False
    while argv:
        while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", argv[0]):
            argv.pop(0)
        if not argv:
            break
        base = os.path.basename(argv[0])
        if base not in WRAPPERS:
            break
        if base == "xargs":
            was_xargs = True
            argv.pop(0)
            # skip xargs flags (-0, -I{}, -n1, --replace ...)
            while argv and argv[0].startswith("-"):
                flag = argv.pop(0)
                if flag in ("-I", "--replace", "-n", "--max-args"):
                    if argv:
                        argv.pop(0)
            break  # the next token is the command xargs runs
        if base == "env":
            argv.pop(0)
            # skip env flags (-i, -u NAME) and VAR=x assignments
            while argv and (argv[0].startswith("-")
                           or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", argv[0])):
                flag = argv.pop(0)
                if flag == "-u" and argv:
                    argv.pop(0)
            continue  # the real command may itself be wrapped
        if base == "nice":
            argv.pop(0)
            while argv and argv[0].startswith("-"):
                flag = argv.pop(0)
                if flag in ("-n", "--adjustment"):
                    if argv:
                        argv.pop(0)
            continue
        # time, nohup, command, builtin: pop and keep unwrapping
        argv.pop(0)
    return argv, was_xargs


def shlex_split(s):
    try:
        return shlex.split(s, posix=True)
    except ValueError:
        return None


def extract_urls(text):
    return gc.URL_RE.findall(text or "")


def domain_of(url):
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def domain_allowed(domain, scope):
    if not domain:
        return False
    if domain in ("localhost", "127.0.0.1", "::1") or domain.endswith(".local"):
        return True
    for d in scope.get("allowed_domains", []):
        d = d.lower()
        if domain == d or domain.endswith("." + d):
            return True
    return False


# ---------------------------------------------------------------- Bash analysis


def analyse_bash(ctx, command):
    raw = command or ""
    if not raw.strip():
        return
    # Obfuscation detectors (deterministic, content-agnostic)
    if gc.ZERO_WIDTH_RE.search(raw):
        ctx.deny("obfuscated command (zero-width / invisible characters)",
                 "hidden characters in: %s" % raw[:120])
        return
    if gc.JSFUCK_RE.search(raw):
        ctx.deny("obfuscated command (JSFuck-style encoding)",
                 "only []()!+ characters: %s" % raw[:120])
        return
    if PIPE_TO_SHELL_RE.search(raw) or PIPE_TO_SHELL_NOSPACE_RE.search(raw):
        ctx.deny("pipe to shell/interpreter",
                 "output of one command is executed by another: %s" % raw[:200])
    if re.search(r"\|\s*base64\s+(-d|--decode)", raw) and PIPE_TO_SHELL_RE.search(raw):
        ctx.deny("decode-then-execute", "base64 output piped to a shell")
    if PAYMENT_CMD_RE.search(raw):
        ctx.deny("payment / crypto transfer command", raw[:200])
    for pat in ctx.scope.get("extra_deny_regex", []):
        if re.search(pat, raw):
            ctx.deny("matches scope deny pattern", pat)
    for pat in ctx.scope.get("extra_ask_regex", []):
        if re.search(pat, raw):
            ctx.ask("matches scope ask pattern", pat)

    # Known-safe fast path: ONLY for a single simple command with no
    # shell operators. A compound command ("git status && sudo ...")
    # must never fast-path on its first word. The fast path must also
    # never skip the credential/redirection checks: a prefix like
    # "git diff" can still read a credential file (git diff --no-index
    # ~/.ssh/id_rsa) or overwrite one (git status > ~/.ssh/config).
    # Anything unclean falls through to full subcommand analysis.
    stripped = raw.strip()
    if not re.search(r"(&&|\|\||[;|&\n]|\$\(|`)", stripped):
        for prefix in ctx.scope.get("allowed_bash_prefixes", []):
            if stripped == prefix or stripped.startswith(prefix + " "):
                argv = shlex_split(stripped)
                if argv is not None and _fast_path_is_clean(ctx, argv):
                    return

    for sub in split_shell_commands(raw):
        analyse_subcommand(ctx, sub)


def _fast_path_is_clean(ctx, argv):
    """True if a fast-pathed command contains no credential/config path
    and no shell redirection. False means: analyse it normally."""
    for token in argv:
        if token in (">", ">>"):
            return False
        if "/" in token or token.startswith("~") or token.startswith("."):
            path = gc.resolve_cmd_path(token, ctx.cwd)
            if gc.is_credential_path(path) or gc.is_config_path(path):
                return False
    return True


def analyse_subcommand(ctx, sub):
    argv = shlex_split(sub)
    if argv is None:
        ctx.ask("unparseable shell quoting", sub[:200])
        return
    if not argv:
        return
    orig = list(argv)
    argv, _ = unwrap_argv(argv)
    if not argv:
        # Only `env` can unwrap to nothing: bare `env` prints the
        # environment (secrets included). It is not a no-op.
        if orig and os.path.basename(orig[0]) == "env":
            analyse_env_dump(ctx, orig)
        return
    prog = os.path.basename(argv[0])

    # Subshell / brace group: (rm -rf /) and { rm -rf /; } hide the
    # real command from a dispatcher that looks at argv[0]. Strip the
    # group markers and analyse the inner command as its own command.
    if prog in ("(", "{") or prog.startswith("("):
        inner = " ".join(argv).strip()
        if inner.startswith("(") and inner.endswith(")"):
            inner = inner[1:-1]
        elif inner.startswith("{"):
            inner = inner[1:].strip()
            if inner.endswith("}"):
                inner = inner[:-1]
        if inner.strip():
            analyse_bash(ctx, inner)
        return
    # Function definition / group after another word: f() { rm -rf /; }
    if "{" in argv:
        idx = argv.index("{")
        rest = argv[idx + 1:]
        if rest and rest[-1] == "}":
            rest = rest[:-1]
        if rest:
            analyse_bash(ctx, " ".join(rest))
        return
    # Control-structure prefixes: if/then/do/else/while/until/! are not
    # commands; the command after them is.
    if prog in ("if", "then", "do", "else", "elif", "while", "until", "!"):
        analyse_bash(ctx, " ".join(argv[1:]))
        return

    # Redirection writes run BEFORE the per-program dispatch: a handler
    # like git/curl must not let `cmd > ~/.ssh/config` slip through.
    check_redirection(ctx, argv)

    # Shell-in-shell / eval: analyse the inner command as its own command.
    if prog in ("sh", "bash", "zsh", "dash", "ksh"):
        if "-c" in argv:
            idx = argv.index("-c")
            if idx + 1 < len(argv):
                analyse_bash(ctx, argv[idx + 1])
            return
        if len(argv) > 1 and argv[1].endswith((".sh", ".bash", ".zsh")):
            path = gc.resolve_cmd_path(argv[1], ctx.cwd)
            if gc.is_credential_path(path) or gc.is_config_path(path):
                ctx.deny("executing a sensitive script", path)
            elif not gc.is_under(path, ctx.roots):
                ctx.ask("executing a script outside the project", path)
            return
        return
    if prog == "eval":
        analyse_bash(ctx, " ".join(argv[1:]))
        return
    if prog in ("sudo", "doas", "su", "runuser"):
        ctx.deny("privilege escalation (%s)" % prog, " ".join(argv)[:200])
        return
    if prog in ("python", "python3", "node", "ruby", "perl"):
        analyse_script_run(ctx, prog, argv)
        return
    if prog == "osascript":
        ctx.ask("macOS automation (osascript) -- can control apps / Shortcuts / phone",
                " ".join(argv)[:300])
        return

    dispatch = {
        "rm": analyse_rm,
        "curl": analyse_curl_wget,
        "wget": analyse_curl_wget,
        "git": analyse_git,
        "npm": analyse_package_manager,
        "npx": analyse_package_manager,
        "yarn": analyse_package_manager,
        "pnpm": analyse_package_manager,
        "bun": analyse_package_manager,
        "bunx": analyse_package_manager,
        "pip": analyse_package_manager,
        "pip3": analyse_package_manager,
        "uv": analyse_package_manager,
        "uvx": analyse_package_manager,
        "brew": analyse_package_manager,
        "docker": analyse_docker,
        "kubectl": analyse_kubectl,
        "terraform": analyse_terraform,
        "aws": analyse_cloud_cli,
        "gcloud": analyse_cloud_cli,
        "az": analyse_cloud_cli,
        "gh": analyse_gh,
        "stripe": analyse_stripe,
        "security": analyse_security_cli,
        "op": analyse_op_cli,
        "launchctl": analyse_launchctl,
        "defaults": analyse_defaults,
        "crontab": analyse_crontab,
        "shortcuts": analyse_shortcuts,
        "find": analyse_find,
        "open": analyse_open,
        "ssh": analyse_ssh_like,
        "scp": analyse_ssh_like,
        "rsync": analyse_ssh_like,
        "sftp": analyse_ssh_like,
        "chmod": analyse_chmod,
        "chown": analyse_chown,
        "dd": analyse_destructive,
        "mkfs": analyse_destructive,
        "shutdown": analyse_destructive,
        "reboot": analyse_destructive,
        "halt": analyse_destructive,
        "poweroff": analyse_destructive,
        "kill": analyse_kill,
        "killall": analyse_kill,
        "pkill": analyse_kill,
        "env": analyse_env_dump,
        "printenv": analyse_env_dump,
        "set": analyse_env_dump,
        "history": analyse_history,
    }
    handler = dispatch.get(prog)
    if handler:
        handler(ctx, argv)
        return

    # Generic credential-path scan for any other command: any path-like
    # token resolving to a credential location is a denial for content
    # readers, an ask for listers.
    for token in argv[1:]:
        if "/" in token or token.startswith("~") or token.startswith("."):
            path = gc.resolve_cmd_path(token, ctx.cwd)
            if gc.is_credential_path(path):
                if prog in READ_CONTENT_CMDS or prog in ARCHIVE_CMDS:
                    ctx.deny("credential file accessed by %s" % prog, path)
                elif prog in LIST_CMDS:
                    ctx.ask("credential location listed by %s" % prog, path)
                else:
                    ctx.ask("credential path appears in %s arguments" % prog, path)
            elif gc.is_config_path(path) and prog in READ_CONTENT_CMDS:
                ctx.ask("config file read by %s" % prog, path)

    # Copy/move/tee destinations: the last argument is where data lands.
    # (Redirection is checked earlier, in check_redirection, so no
    # per-program handler can skip it.)
    if prog in ("cp", "mv") and len(argv) > 2:
        dest = gc.resolve_cmd_path(argv[-1], ctx.cwd)
        if not dest.startswith("/dev/") and not gc.is_under(dest, ctx.roots):
            ctx.ask("%s destination outside the project" % prog, dest)
    if prog == "tee":
        for token in argv[1:]:
            if token.startswith("-"):
                continue
            if "/" in token or token.startswith("~"):
                path = gc.resolve_cmd_path(token, ctx.cwd)
                if gc.is_credential_path(path) or gc.is_config_path(path):
                    ctx.deny("tee writes to a credential / config file", path)
                elif not gc.is_under(path, ctx.roots):
                    ctx.ask("tee writes outside the project", path)


def check_redirection(ctx, argv):
    """`cmd > /path` -- the target after > / >> / 2> / &> is a write
    even though the command itself looks harmless. /dev/* is exempt
    (the standard "throw output away" idiom). Runs for every command,
    before the per-program dispatch, so no handler can skip it."""
    for i, token in enumerate(argv):
        if re.match(r"^(\d+|&)?>>?$", token) and i + 1 < len(argv):
            target = gc.resolve_cmd_path(argv[i + 1], ctx.cwd)
            if target.startswith("/dev/"):
                continue
            if gc.is_credential_path(target) or gc.is_config_path(target):
                ctx.deny("shell redirection to a credential / config file", target)
            elif not gc.is_under(target, ctx.roots):
                ctx.ask("shell redirection writes outside the project", target)


def analyse_script_run(ctx, prog, argv):
    # python3 -c "..." / node -e "..." : inspect the code string.
    if "-c" in argv or "-e" in argv:
        idx = argv.index("-c") if "-c" in argv else argv.index("-e")
        code = argv[idx + 1] if idx + 1 < len(argv) else ""
        if gc.ZERO_WIDTH_RE.search(code) or gc.JSFUCK_RE.search(code):
            ctx.deny("obfuscated inline code (%s -c/-e)" % prog, code[:120])
            return
        for url in extract_urls(code):
            dom = domain_of(url)
            if dom in PAYMENT_DOMAINS:
                ctx.deny("payment URL in inline code", url)
            elif re.search(r"\b(post|put|patch|delete|fetch\(|requests\.post|urlopen|http\.request)\b", code, re.IGNORECASE):
                if domain_allowed(dom, ctx.scope):
                    ctx.ask("network write in inline code", url)
                else:
                    ctx.deny("network write to non-allowlisted host in inline code", url)
            elif not domain_allowed(dom, ctx.scope):
                ctx.ask("network fetch to non-allowlisted host in inline code", url)
        if re.search(r"open\(['\"]?(~|/|.*\.ssh|.*\.env)", code):
            ctx.ask("inline code opens a sensitive path", code[:200])
        if re.search(r"\b(os\.system|os\.popen|subprocess|eval\(|exec\()\b", code):
            ctx.ask("inline code executes nested commands", code[:200])
        return
    # python3 script.py : script file location decides.
    for token in argv[1:]:
        if token.endswith((".py", ".js", ".rb", ".pl")):
            path = gc.resolve_cmd_path(token, ctx.cwd)
            if not gc.is_under(path, ctx.roots):
                ctx.ask("running a script outside the project", path)
            return


def analyse_rm(ctx, argv):
    flags = [a for a in argv[1:] if a.startswith("-")]
    targets = [a for a in argv[1:] if not a.startswith("-") or a == "-"]
    recursive = any("r" in f.lstrip("-") for f in flags if f.startswith("-") and not f.startswith("--")) \
        or "--recursive" in flags
    force = any("f" in f.lstrip("-") for f in flags if f.startswith("-") and not f.startswith("--")) \
        or "--force" in flags
    if not targets:
        return
    for t in targets:
        if t in ("/", "~", "$HOME", "${HOME}", "$HOME/", "${HOME}/", "~/"):
            ctx.deny("rm target is the filesystem root / home directory", t)
            continue
        if "$" in t or "*" in t or "?" in t:
            # Unresolvable (variable / glob): cannot prove it is safe.
            if recursive and force:
                ctx.ask("rm -rf with unresolvable target (variable/glob)",
                        " ".join(argv)[:200])
            elif recursive:
                ctx.ask("rm -r with unresolvable target", " ".join(argv)[:200])
            continue
        path = gc.resolve_cmd_path(t, ctx.cwd)
        if path in ("/", os.path.expanduser("~")) or path == os.path.realpath(os.path.expanduser("~")):
            ctx.deny("rm target resolves to root / home", path)
            continue
        if gc.is_credential_path(path) or gc.is_config_path(path):
            ctx.deny("rm target is a credential / config file", path)
            continue
        if recursive and force:
            if gc.is_under(path, ctx.roots):
                ctx.ask("rm -rf inside the project (destructive)", path)
            else:
                ctx.deny("rm -rf outside the project", path)
        elif recursive:
            ctx.ask("recursive rm", path)
        else:
            if not gc.is_under(path, ctx.roots):
                ctx.ask("rm outside the project", path)


def analyse_curl_wget(ctx, argv):
    prog = os.path.basename(argv[0])
    urls = []
    data = False
    method = None
    output = None
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
                 "-F", "--form", "-T", "--upload-file", "--post-data", "--post-file"):
            data = True
        elif a.startswith("--data") or a.startswith("--post-"):
            data = True
        elif a in ("-X", "--request") and i + 1 < len(argv):
            method = argv[i + 1].upper()
            i += 1
        elif a in ("-o", "--output") and i + 1 < len(argv):
            output = argv[i + 1]
            i += 1
        elif a.startswith("http://") or a.startswith("https://"):
            urls.append(a)
        elif a.startswith("-"):
            pass
        else:
            urls.append(a)  # bare host
        i += 1
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        data = True
    if output:
        opath = gc.resolve_cmd_path(output, ctx.cwd)
        if gc.is_credential_path(opath) or gc.is_config_path(opath):
            ctx.deny("download target is a credential / config file", opath)
        elif not gc.is_under(opath, ctx.roots):
            ctx.ask("download target outside the project", opath)
    for url in urls:
        dom = domain_of(url if "://" in url else "https://" + url)
        if dom in PAYMENT_DOMAINS:
            ctx.deny("network call to a payment domain (%s)" % prog, url)
            continue
        if data:
            if domain_allowed(dom, ctx.scope):
                ctx.ask("network write (%s %s)" % (prog, method or "POST-data"), url)
            else:
                ctx.deny("network write to a non-allowlisted host", url)
        else:
            if not domain_allowed(dom, ctx.scope):
                ctx.ask("network fetch to a non-allowlisted host", url)


def analyse_git(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    # git subcommands that print arbitrary file content: diff --no-index,
    # show, cat-file, grep, blame. A credential path there is a read.
    if sub in ("diff", "show", "cat-file", "grep", "blame"):
        for token in argv[2:]:
            if "/" in token or token.startswith("~") or token.startswith("."):
                path = gc.resolve_cmd_path(token, ctx.cwd)
                if gc.is_credential_path(path):
                    ctx.deny("credential file read via git %s" % sub, path)
                    return
                if gc.is_config_path(path):
                    ctx.ask("config file read via git %s" % sub, path)
                    return
    if sub == "push":
        rest = argv[2:]
        if any("://" in a or a.startswith("git@") for a in rest):
            ctx.ask("git push to an explicit URL (new remote?)", " ".join(argv)[:200])
        else:
            # Only the remote token (first non-flag arg) is a remote;
            # the branch name after it must not trigger this rule.
            remote = next((a for a in rest if not a.startswith("-")), None)
            if remote is not None and remote not in ("origin", "upstream"):
                ctx.ask("git push to a non-standard remote", " ".join(argv)[:200])
            elif "--force" in rest:
                ctx.ask("git push --force", " ".join(argv)[:200])
    elif sub in ("remote",) and len(argv) > 2 and argv[2] in ("add", "set-url"):
        ctx.ask("git remote change", " ".join(argv)[:200])
    elif sub == "clone":
        ctx.ask("git clone (new code enters the machine)", " ".join(argv)[:200])
    elif sub == "clean" and "-f" in argv:
        ctx.ask("git clean -f (deletes untracked files)", " ".join(argv)[:200])
    elif sub == "reset" and "--hard" in argv:
        ctx.ask("git reset --hard (discards changes)", " ".join(argv)[:200])
    elif sub == "stash" and "drop" in argv:
        ctx.ask("git stash drop", " ".join(argv)[:200])


def analyse_package_manager(ctx, argv):
    prog = os.path.basename(argv[0])
    sub = argv[1] if len(argv) > 1 else ""
    if prog in ("npx", "bunx", "uvx"):
        ctx.ask("%s runs a package (possibly fetched) by name" % prog, " ".join(argv)[:200])
        return
    if prog in ("npm", "yarn", "pnpm") and sub in ("exec", "x", "dlx"):
        ctx.ask("%s %s runs a package binary by name" % (prog, sub), " ".join(argv)[:200])
        return
    if sub in ("install", "add", "i"):
        ctx.ask("%s install (new supply-chain code)" % prog, " ".join(argv)[:200])
    elif sub in ("uninstall", "remove", "rm"):
        ctx.ask("%s uninstall" % prog, " ".join(argv)[:200])
    elif prog == "brew" and sub in ("install", "upgrade"):
        ctx.ask("brew %s" % sub, " ".join(argv)[:200])


def analyse_docker(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    if sub in ("run", "create"):
        joined = " ".join(argv)
        if "--privileged" in argv or "--pid=host" in argv or "--network" in argv and "host" in argv:
            ctx.deny("docker run with host privileges", joined[:200])
        elif _docker_mounts_host_root(joined):
            ctx.deny("docker run mounting the host root", joined[:200])
        else:
            ctx.ask("docker run/create", joined[:200])
    elif sub in ("rm", "rmi", "volume", "system"):
        ctx.ask("docker %s" % sub, " ".join(argv)[:200])


def _docker_mounts_host_root(joined):
    """True if a -v/--volume/--mount flag mounts the host root (or
    home) into the container. The mount source is a separate token
    from the flag itself, so argv-token checks miss it."""
    m = re.search(r"(?:^|\s)(?:-v|--volume)(?:\s+|=)([^:\s]+):", joined)
    if m and m.group(1) in ("/", "~", "$HOME", "${HOME}"):
        return True
    if re.search(r"source=/(?:,|\s|$)", joined):
        return True
    return False


def analyse_kubectl(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    if sub in ("delete", "apply", "create", "scale", "rollout"):
        ctx.ask("kubectl %s (cluster mutation)" % sub, " ".join(argv)[:200])


def analyse_terraform(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    if sub in ("apply", "destroy"):
        ctx.ask("terraform %s (infrastructure change)" % sub, " ".join(argv)[:200])


def analyse_cloud_cli(ctx, argv):
    prog = os.path.basename(argv[0])
    joined = " ".join(argv)
    if argv[1:] in ([], ["--version"], ["--help"], ["help"]):
        return
    if prog == "aws" and argv[1:3] == ["sts", "get-caller-identity"]:
        return
    if "configure" in argv and "list" in argv:
        return
    ctx.ask("%s (cloud action)" % prog, joined[:200])


def analyse_gh(ctx, argv):
    joined = " ".join(argv)
    if len(argv) > 2 and argv[1] == "auth" and argv[2] == "token":
        ctx.deny("gh auth token (dumps a credential)", joined[:200])
        return
    if len(argv) > 1 and argv[1] == "api":
        if any(a in ("-X", "--method") for a in argv):
            ctx.ask("gh api with an explicit method (possible write)", joined[:200])
        elif any(a in ("-f", "--field", "--input") for a in argv):
            ctx.ask("gh api with a request body (possible write)", joined[:200])
        return
    if len(argv) > 1 and argv[1] in ("repo", "pr", "release") and len(argv) > 2 and argv[2] in ("create", "fork", "merge", "delete", "clone"):
        ctx.ask("gh %s %s" % (argv[1], argv[2]), joined[:200])


def analyse_stripe(ctx, argv):
    ctx.ask("stripe CLI (payment tool)", " ".join(argv)[:200])


def analyse_security_cli(ctx, argv):
    joined = " ".join(argv)
    if re.search(r"find-(generic|internet)-password|dump-keychain|export|unlock-keychain", joined):
        ctx.deny("macOS keychain credential access (security)", joined[:200])
    else:
        ctx.ask("macOS keychain tool (security)", joined[:200])


def analyse_op_cli(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    if sub in ("item", "read", "document", "signin", "signout"):
        ctx.ask("1Password CLI (%s) -- credential access" % sub, " ".join(argv)[:200])


def analyse_launchctl(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    if sub in ("load", "unload", "enable", "disable", "bootstrap", "bootout"):
        ctx.deny("launchctl %s (persistence change)" % sub, " ".join(argv)[:200])


def analyse_defaults(ctx, argv):
    sub = argv[1] if len(argv) > 1 else ""
    if sub in ("write", "delete"):
        ctx.ask("defaults %s (persistent macOS setting)" % sub, " ".join(argv)[:200])


def analyse_crontab(ctx, argv):
    ctx.ask("crontab (scheduled persistence)", " ".join(argv)[:200])


def analyse_shortcuts(ctx, argv):
    # macOS Shortcuts CLI: a shortcut can send messages, control apps
    # and the phone, and its actions are not visible in the command.
    ctx.ask("macOS Shortcuts CLI -- can control apps / phone, actions not visible here",
            " ".join(argv)[:300])


def analyse_find(ctx, argv):
    # find -delete and find -exec run their payload on every matched
    # file; the matched set is not visible in the command, so the
    # human must see it. -exec with a shell/rm is analysed as the
    # inner command.
    joined = " ".join(argv)
    if "-delete" in argv:
        ctx.ask("find -delete (deletes every matched file)", joined[:200])
        return
    for flag in ("-exec", "-execdir", "-ok", "-okdir"):
        if flag in argv:
            idx = argv.index(flag)
            rest = [t for t in argv[idx + 1:] if t not in (";", "+", "{}")]
            if not rest:
                break
            prog = os.path.basename(rest[0])
            if prog == "rm":
                ctx.ask("find %s rm (deletes matched files)" % flag, joined[:200])
            else:
                analyse_bash(ctx, " ".join(rest))
            break


def analyse_open(ctx, argv):
    ctx.ask("open (launches an app / URL)", " ".join(argv)[:200])


def analyse_ssh_like(ctx, argv):
    prog = os.path.basename(argv[0])
    if "-A" in argv or "--forward-agent" in argv:
        ctx.deny("SSH agent forwarding (-A) -- key can be used by the remote host",
                 " ".join(argv)[:200])
        return
    # scp/rsync of a credential file is exfiltration, not just access.
    for token in argv[1:]:
        if "/" in token or token.startswith("~"):
            path = gc.resolve_cmd_path(token, ctx.cwd)
            if gc.is_credential_path(path):
                ctx.deny("credential file sent via %s" % prog, path)
                return
    ctx.ask("%s (remote host access)" % prog, " ".join(argv)[:200])


def analyse_chmod(ctx, argv):
    joined = " ".join(argv)
    if "777" in argv or "a+rwx" in argv:
        ctx.ask("chmod 777 (world-writable)", joined[:200])
        return
    for token in argv[1:]:
        if "/" in token or token.startswith("~"):
            path = gc.resolve_cmd_path(token, ctx.cwd)
            if gc.is_credential_path(path):
                ctx.deny("chmod on a credential file", path)


def analyse_chown(ctx, argv):
    ctx.ask("chown/chgrp (ownership change)", " ".join(argv)[:200])


def analyse_destructive(ctx, argv):
    ctx.deny("destructive system command (%s)" % os.path.basename(argv[0]),
             " ".join(argv)[:200])


def analyse_kill(ctx, argv):
    ctx.ask("kill (%s) -- terminates a process" % os.path.basename(argv[0]),
            " ".join(argv)[:200])


def analyse_env_dump(ctx, argv):
    joined = " ".join(argv)
    if re.search(r"grep\s+(-i\s+)?['\"]?(key|token|secret|pass|auth|credential)", joined, re.IGNORECASE):
        ctx.deny("environment dump filtered for secrets", joined[:200])
    elif "|" in joined and re.search(r"(key|token|secret|pass)", joined, re.IGNORECASE):
        ctx.deny("environment piped through a secret filter", joined[:200])
    else:
        ctx.ask("environment dump (may print secrets)", joined[:200])


def analyse_history(ctx, argv):
    ctx.ask("shell history (may contain secrets)", " ".join(argv)[:200])


# ---------------------------------------------------------------- file tools


def analyse_file_tool(ctx, kind):
    inp = ctx.input
    path = inp.get("file_path") or inp.get("path") or ""
    if not path:
        return
    resolved = gc.resolve_cmd_path(path, ctx.cwd)
    given_real = os.path.realpath(path) if os.path.exists(path) else resolved
    symlink_note = ""
    if given_real != resolved and os.path.islink(path):
        symlink_note = " (symlink resolves to %s)" % given_real
        resolved = given_real
    if gc.is_credential_path(resolved):
        if kind == "Read":
            ctx.deny("reading a credential file", resolved + symlink_note)
        elif kind in ("Write", "Edit", "NotebookEdit"):
            ctx.deny("writing a credential file", resolved + symlink_note)
        return
    if gc.is_config_path(resolved):
        if kind in ("Write", "Edit", "NotebookEdit"):
            ctx.ask("editing a config file (changes what the agent can do)",
                    resolved + symlink_note)
        return
    gate = gc.gate_dir()
    if resolved == gate or resolved.startswith(gate + os.sep):
        if kind in ("Write", "Edit", "NotebookEdit"):
            ctx.ask("editing the approval gate itself", resolved)
        return
    if not gc.is_under(resolved, ctx.roots):
        ctx.ask("%s outside the project roots" % kind, resolved + symlink_note)
        return
    if kind in ("Write", "Edit", "NotebookEdit"):
        content = inp.get("content") or inp.get("new_string") or ""
        if "-----BEGIN" in content and "PRIVATE KEY-----" in content:
            ctx.ask("writing a private key into a file", resolved)


def analyse_glob_grep(ctx):
    path = ctx.input.get("path") or ""
    if path:
        resolved = gc.resolve_cmd_path(path, ctx.cwd)
        if not gc.is_under(resolved, ctx.roots):
            ctx.ask("%s outside the project roots" % ctx.tool, resolved)


# ---------------------------------------------------------------- MCP tools


def analyse_mcp(ctx):
    tool = ctx.tool
    m = re.match(r"^mcp__([^_]+)__(.+)$", tool)
    server = None
    if m:
        server, _tool = m.group(1), m.group(2)
    mcp = ctx.event.get("mcp_server") or {}
    if mcp.get("name"):
        server = mcp.get("name")
    allowed = ctx.scope.get("allowed_mcp_servers", [])
    if server is None:
        ctx.ask("MCP tool with an unparseable server name", tool)
        return
    if server not in allowed:
        ctx.deny("MCP server '%s' is not in this task's scope" % server,
                 "scope '%s' allows: %s" % (ctx.scope.get("name"), ", ".join(allowed) or "(none)"))
        return
    source = mcp.get("source")
    if source and source not in ("user", "project", "plugin", "sdk"):
        ctx.ask("MCP server '%s' has unknown provenance (source=%s)" % (server, source),
                "tool: %s" % tool)
    tool_lower = tool.lower()
    send_pats = ctx.scope.get("send_tool_patterns", [])
    pay_pats = ctx.scope.get("payment_tool_patterns", [])
    extras = gc.extract_recipients_and_amounts(ctx.input)
    if any(p in tool_lower for p in send_pats):
        detail = "; ".join(extras) if extras else json.dumps(gc.redact_args(ctx.input))[:400]
        ctx.ask("send/share tool via MCP server '%s' -- check recipients" % server, detail)
        if any(k.lower().startswith(("bcc", "cc")) for k in _flat_keys(ctx.input)):
            ctx.ask("hidden recipients (BCC/CC) present in the send call", "; ".join(extras)[:400])
        return
    if any(p in tool_lower for p in pay_pats):
        detail = "; ".join(extras) if extras else json.dumps(gc.redact_args(ctx.input))[:400]
        ctx.ask("payment tool via MCP server '%s' -- check recipient and amount" % server, detail)
        return
    if re.search(r"delete|remove|destroy|revoke|drop", tool_lower):
        ctx.ask("destructive MCP tool", tool)
        return


def _flat_keys(obj, prefix=""):
    keys = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.append(k)
            keys.extend(_flat_keys(v, prefix + str(k) + "."))
    elif isinstance(obj, list):
        for v in obj:
            keys.extend(_flat_keys(v, prefix))
    return keys


# ---------------------------------------------------------------- evaluation


def evaluate(event):
    ctx = Ctx(event)
    if not ctx.scope.get("enabled", True):
        return "allow", "gate disabled by scope (emergency kill switch)", ctx
    if os.environ.get("APPROVAL_GATE_DISABLE") == "1":
        return "allow", "gate disabled by APPROVAL_GATE_DISABLE=1", ctx

    # Rug-pull / config-integrity check (Invariant / MCPoison / postmark).
    changed, has_baseline = gc.check_baseline(ctx.cwd)
    if changed:
        detail = "; ".join(changed)
        if ctx.tool.startswith("mcp__"):
            ctx.deny("MCP config changed mid-session (possible rug pull)",
                     "changed: %s -- re-approve the config before any MCP call" % detail)
        elif ctx.tool in ("Bash", "PowerShell"):
            ctx.ask("config changed mid-session (possible rug pull)",
                    "changed: %s" % detail)
        ctx.notes.append("config changed mid-session: %s" % detail)

    tool = ctx.tool
    if tool.startswith("mcp__"):
        analyse_mcp(ctx)
    elif tool in ("Bash", "PowerShell"):
        analyse_bash(ctx, ctx.input.get("command", ""))
    elif tool in ("Read", "Write", "Edit", "NotebookEdit"):
        analyse_file_tool(ctx, tool)
    elif tool in ("Glob", "Grep"):
        analyse_glob_grep(ctx)
    elif tool == "Task":
        prompt = ctx.input.get("prompt", "") or ""
        if re.search(r"\b(send|email|pay|transfer|delete|rm\s|credential|password|secret|sudo|publish)\b", prompt, re.IGNORECASE):
            ctx.ask("subagent prompt contains a high-risk instruction",
                    prompt[:200])
    elif tool == "WebFetch":
        url = ctx.input.get("url", "")
        if re.search(r"https?://[^/]*:[^@/]+@", url):
            ctx.ask("URL contains embedded credentials", url)
    elif tool in ("WebSearch", "TodoWrite", "Skill", "AskUserQuestion", "ExitPlanMode"):
        pass  # benign by construction
    elif tool in KNOWN_BENIGN_TOOLS:
        pass
    else:
        ctx.ask("unknown tool -- ask by default", "tool: %s" % tool)

    decision = ctx.decision()
    reason = build_reason(ctx, decision)
    return decision, reason, ctx


def build_reason(ctx, decision):
    lines = []
    lines.append("🛡 APPROVAL GATE [%s] — scope: %s" % (decision.upper(), ctx.scope.get("name")))
    lines.append("Tool: %s" % ctx.tool)
    if ctx.tool in ("Bash", "PowerShell"):
        cmd = ctx.input.get("command", "")
        lines.append("Command: %s" % (cmd[:600] + ("…" if len(cmd) > 600 else "")))
    else:
        lines.append("Input: %s" % (json.dumps(gc.redact_args(ctx.input), ensure_ascii=False)[:600]))
    extras = gc.extract_recipients_and_amounts(ctx.input)
    if extras:
        lines.append("Recipients/amounts: %s" % "; ".join(extras)[:400])
    for f in ctx.findings:
        lines.append("• %s" % f)
    for n in ctx.notes:
        lines.append("• note: %s" % n)
    if decision == "allow":
        lines.append("No high-risk pattern matched; within scope.")
    elif decision == "ask":
        lines.append("Approve only the exact action above -- not the model's description of it.")
    prov = gc.provenance(ctx.event.get("transcript_path"))
    lines.append("Provenance: %s" % prov[:400])
    return "\n".join(lines)[:2000]


# ---------------------------------------------------------------- entry


def main(argv):
    if "--refresh-baseline" in argv:
        cwd = os.environ.get("APPROVAL_GATE_CWD") or os.getcwd()
        snap = gc.snapshot_configs(cwd)
        gc.save_baseline({"files": snap, "session": "manual-refresh"})
        print("baseline refreshed: %d watched files" % len(snap))
        return 0
    if "--scope" in argv:
        idx = argv.index("--scope")
        if idx + 1 < len(argv):
            os.environ["APPROVAL_GATE_SCOPE"] = argv[idx + 1]
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # fail closed
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "APPROVAL GATE: could not parse hook input (%s) -- failing closed." % exc,
            }
        }
        print(json.dumps(out))
        return 0
    try:
        decision, reason, ctx = evaluate(event)
    except Exception as exc:  # fail closed on any internal error
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "APPROVAL GATE: internal error (%s) -- failing closed. Tool: %s" % (exc, event.get("tool_name")),
            }
        }
        print(json.dumps(out))
        return 0
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(out))
    gc.append_audit({
        "hook": "PreToolUse",
        "session_id": event.get("session_id"),
        "tool_use_id": event.get("tool_use_id"),
        "tool": ctx.tool,
        "input": gc.redact_args(ctx.input),
        "decision": decision,
        "findings": [str(f) for f in ctx.findings],
        "scope": ctx.scope.get("name"),
        "cwd": ctx.cwd,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
