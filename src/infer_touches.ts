// Infer file-touches from shell command strings captured in tool_calls.
//
// The three CLI parsers already record the raw command for shell tools (Claude
// `Bash`, Codex `shell`, Gemini `run_shell_command`), but a `> file` redirect or
// a `tee`/`sed -i`/`cp` invocation writes a file without any structured
// file-tool call. This module reconstructs those write targets from the command
// text so `files_touched` gains recall.
//
// CRITICAL: every touch returned here is tagged `source:"inferred"`. The
// path-trusted views (`getRecentByEditedPath`, `topEditedPaths`,
// `getRepoBreakdown`) filter `touch_source = 'native'`, so inferred touches
// enrich the best-effort content view WITHOUT polluting the honest native lanes.
//
// The tokenizer below is a minimal, self-contained implementation — no dependency.

import type { FileTouch } from "./types.js";

// A token is either a plain word (quotes stripped) or a shell operator.
type Token = string | { op: string };

// Tokenize a command line into words and the operators we care about. This is
// intentionally shallow: it understands single/double quotes, backslash escapes,
// redirect operators, and the control operators that separate commands. It does
// NOT model subshells, heredocs, or fd-precise redirects — those degrade to
// harmless extra word tokens, never to a false write target.
function tokenize(cmd: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let started = false; // did we open a word (empty quotes still count)?
  let quote: string | null = null;
  const flushWord = (): void => {
    if (started) {
      out.push(cur);
      cur = "";
      started = false;
    }
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < cmd.length) {
        cur += cmd[++i];
        started = true;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flushWord();
      continue;
    }
    if (c === ">" || c === "<" || c === "|" || c === "&" || c === ";") {
      flushWord();
      let op = c;
      const next = cmd[i + 1];
      if ((c === ">" || c === "<") && next === c) {
        op = c + c; // >> or <<
        i++;
      } else if (c === "&" && next === "&") {
        op = "&&";
        i++;
      } else if (c === "|" && next === "|") {
        op = "||";
        i++;
      } else if (c === "&" && next === ">") {
        op = "&>";
        i++;
      }
      out.push({ op });
      continue;
    }
    cur += c;
    started = true;
  }
  flushWord();
  return out;
}

// Reject targets we are not confident are real, on-disk writes. Precision beats
// recall here: a false "edit" is worse than a missed one because it lands in the
// files_touched view a human reads.
function isPlausibleTarget(raw: string): boolean {
  if (!raw) return false;
  if (raw === "-") return false; // stdout convention (e.g. `tee -`)
  if (raw.startsWith("/dev/")) return false; // /dev/null, /dev/stderr, ...
  if (raw.startsWith("<(") || raw.startsWith(">(")) return false; // process substitution
  if (/[$*?]/.test(raw)) return false; // unexpanded variable or glob — unknown target
  return true;
}

// Commands whose positional (non-flag) operands we treat as write targets.
// `extract` receives the args AFTER the command name (flags included).
const KNOWN_WRITERS: Record<string, (args: string[]) => string[]> = {
  // `tee [-a] FILE...` writes every FILE argument.
  tee: (args) => args.filter((a) => !a.startsWith("-")),
  // `touch FILE...` creates/updates every FILE argument.
  touch: (args) => args.filter((a) => !a.startsWith("-")),
  // `sed -i[SUFFIX] SCRIPT FILE...` edits in place — only when -i is present.
  // Conservatively take the last non-flag operand (the file), leaving the
  // script alone.
  sed: (args) => {
    if (!args.some((a) => a === "-i" || a.startsWith("-i"))) return [];
    const positional = args.filter((a) => !a.startsWith("-"));
    return positional.length > 1 ? positional.slice(-1) : [];
  },
  // `cp`/`mv`/`ln`/`install` write to their final operand (the destination).
  cp: (args) => lastPositional(args),
  mv: (args) => lastPositional(args),
  ln: (args) => lastPositional(args),
  install: (args) => lastPositional(args),
};

function lastPositional(args: string[]): string[] {
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.length > 0 ? positional.slice(-1) : [];
}

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

// Parse one command segment (already split on control operators). Records both
// redirect targets and known-writer operands via `add`.
function processSegment(seg: Token[], add: (raw: string) => void): void {
  // Redirect targets: the word immediately after `>`, `>>`, or `&>`.
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i];
    if (typeof t === "object" && (t.op === ">" || t.op === ">>" || t.op === "&>")) {
      const next = seg[i + 1];
      if (typeof next === "string") add(next);
    }
  }
  // Known-writer commands: match the first word (command name).
  const words = seg.filter((t): t is string => typeof t === "string");
  if (words.length === 0) return;
  const extract = KNOWN_WRITERS[baseName(words[0])];
  if (extract) {
    for (const target of extract(words.slice(1))) add(target);
  }
}

// Extract inferred write targets from a shell command string. All returned
// touches are `source:"inferred"` with `operation:"write"`. Paths are returned
// verbatim (relative or absolute) — canonicalization / exclusion is the caller's
// job so this stays a pure, DB-free, fs-free helper.
export function inferShellFileTouches(command: string, timestamp: string): FileTouch[] {
  if (!command) return [];
  const tokens = tokenize(command);
  const out: FileTouch[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    if (!isPlausibleTarget(raw) || seen.has(raw)) return;
    seen.add(raw);
    out.push({ filePath: raw, operation: "write", timestamp, source: "inferred" });
  };
  // Split into command segments on control operators, keeping redirect operators
  // inside their segment so the target stays adjacent.
  let segment: Token[] = [];
  const flush = (): void => {
    if (segment.length) processSegment(segment, add);
    segment = [];
  };
  for (const t of tokens) {
    if (
      typeof t === "object" &&
      (t.op === "|" || t.op === "||" || t.op === "&&" || t.op === ";" || t.op === "&")
    ) {
      flush();
    } else {
      segment.push(t);
    }
  }
  flush();
  return out;
}

// Codex/Gemini shell tools sometimes pass the command as an argv array
// (e.g. ["bash","-lc","echo x > f"]) rather than a string. Join array forms so
// the redirect/writer inside is still visible to the tokenizer.
export function extractShellCommand(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const cmd = (args as { command?: unknown }).command;
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) return cmd.filter((p) => typeof p === "string").join(" ");
  return null;
}
