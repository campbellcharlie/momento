import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// All knobs live here. Read once at process start; pass into the indexer.
export interface MomentoConfig {
  // Index assistant `thinking` blocks. Default off — they often contain internal
  // deliberation the user never saw. Set MOMENTO_INDEX_THINKING=1 to opt in.
  indexThinking: boolean;
  // Compiled rules matched against the project directory (the
  // `~/.claude/projects/-Users-...-foo` slug). Sessions in matching projects
  // are skipped at index time.
  excludeProjects: Rule[];
  // Compiled rules matched against the canonicalized file path of each tool
  // touch. Matching touches are dropped before insert. Useful for keeping
  // sensitive repos out of `files_touched` / `get_recent_by_edited_path` results.
  excludePaths: Rule[];
  // Raw input strings, preserved for diagnostic output (e.g. `momento --status`).
  rawProjectPatterns: string[];
  rawPathPatterns: string[];
}

export interface Rule {
  raw: string;
  negate: boolean;
  test: (path: string) => boolean;
}

function splitEnvList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function envFlag(v: string | undefined): boolean {
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function readIgnoreFile(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out.push(trimmed);
  }
  return out;
}

const GLOB_CHARS = /[*?[]/;

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

// Convert a gitignore-style glob to a regex source. Supports:
//   **    any number of path segments (including zero)
//   *     any chars except `/`
//   ?     a single char except `/`
//   [abc] character class; `[!abc]` negated
function globToRegexSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        // A trailing slash after `**` is absorbed (so `**/foo` matches
        // `foo` at the root and `a/b/foo`).
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
      } else {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += "[" + body + "]";
        i = close;
      }
    } else {
      re += escapeRegex(c);
    }
  }
  return re;
}

// Compile one .momentoignore line (or env entry) to a Rule. Semantics:
//   - Leading `!` negates a previous match (re-includes).
//   - If the pattern has no glob metacharacters, fall back to substring match
//     for backward compatibility with existing configs.
//   - With globs:
//       * Leading `/` anchors the pattern to the start of the path.
//       * Otherwise, a pattern containing `/` matches anywhere inside the path.
//       * A pattern with no `/` matches against any single path component
//         (gitignore "basename" rule).
export function compileRule(input: string): Rule {
  let raw = input;
  let negate = false;
  if (raw.startsWith("!")) {
    negate = true;
    raw = raw.slice(1);
  }
  if (!GLOB_CHARS.test(raw)) {
    const needle = raw;
    return { raw: input, negate, test: (p: string) => p.includes(needle) };
  }
  const anchored = raw.startsWith("/");
  const hasSlash = raw.includes("/") && !anchored;
  let re: RegExp;
  if (anchored) {
    // Paths are absolute and also start with `/`, so we keep the leading `/`
    // in the regex and anchor at the start of the path.
    re = new RegExp("^" + globToRegexSource(raw));
  } else if (hasSlash) {
    re = new RegExp(globToRegexSource(raw));
  } else {
    // Basename rule: match any single path component.
    re = new RegExp("(^|/)" + globToRegexSource(raw) + "(/|$)");
  }
  return { raw: input, negate, test: (p: string) => re.test(p) };
}

// Last matching rule wins, gitignore-style. A negation rule re-includes a path
// that an earlier rule excluded.
export function matchRules(rules: Rule[], path: string): boolean {
  let excluded = false;
  for (const r of rules) {
    if (r.test(path)) excluded = !r.negate;
  }
  return excluded;
}

export interface LoadConfigOptions {
  // Override the .momentoignore lookup path. Defaults to ~/.momentoignore.
  ignoreFile?: string;
  // Override env. Useful for tests.
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(opts: LoadConfigOptions = {}): MomentoConfig {
  const env = opts.env ?? process.env;
  const ignorePath = opts.ignoreFile ?? join(homedir(), ".momentoignore");
  const filePatterns = readIgnoreFile(ignorePath);

  // .momentoignore lines starting with "project:" filter projects; everything
  // else filters file paths. Keeps a single config file for both axes.
  const filePatternsRaw = splitEnvList(env.MOMENTO_EXCLUDE_PATHS);
  const projectPatternsRaw = splitEnvList(env.MOMENTO_EXCLUDE_PROJECTS);
  for (const p of filePatterns) {
    if (p.startsWith("project:")) projectPatternsRaw.push(p.slice("project:".length).trim());
    else filePatternsRaw.push(p);
  }

  const projectPatterns = projectPatternsRaw.filter(Boolean);
  const pathPatterns = filePatternsRaw.filter(Boolean);

  return {
    indexThinking: envFlag(env.MOMENTO_INDEX_THINKING),
    excludeProjects: projectPatterns.map(compileRule),
    excludePaths: pathPatterns.map(compileRule),
    rawProjectPatterns: projectPatterns,
    rawPathPatterns: pathPatterns,
  };
}

export function projectExcluded(cfg: MomentoConfig, projectDir: string): boolean {
  return matchRules(cfg.excludeProjects, projectDir);
}

export function pathExcluded(cfg: MomentoConfig, filePath: string): boolean {
  return matchRules(cfg.excludePaths, filePath);
}
