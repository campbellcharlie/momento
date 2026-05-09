import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// All knobs live here. Read once at process start; pass into the indexer.
export interface MomentoConfig {
  // Index assistant `thinking` blocks. Default off — they often contain internal
  // deliberation the user never saw. Set MOMENTO_INDEX_THINKING=1 to opt in.
  indexThinking: boolean;
  // Substrings matched against the project directory name (the
  // `~/.claude/projects/-Users-...-foo` slug). Sessions in matching projects are
  // skipped at index time.
  excludeProjects: string[];
  // Substrings matched against the canonicalized file path of each tool touch.
  // Matching touches are dropped before insert. Useful for keeping sensitive
  // repos out of `files_touched` / `get_recent_by_edited_path` results.
  excludePaths: string[];
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
  const fileExcludes = splitEnvList(env.MOMENTO_EXCLUDE_PATHS);
  const projectExcludes = splitEnvList(env.MOMENTO_EXCLUDE_PROJECTS);
  for (const p of filePatterns) {
    if (p.startsWith("project:")) projectExcludes.push(p.slice("project:".length).trim());
    else fileExcludes.push(p);
  }

  return {
    indexThinking: envFlag(env.MOMENTO_INDEX_THINKING),
    excludeProjects: projectExcludes.filter(Boolean),
    excludePaths: fileExcludes.filter(Boolean),
  };
}

export function projectExcluded(cfg: MomentoConfig, projectDir: string): boolean {
  for (const pat of cfg.excludeProjects) {
    if (projectDir.includes(pat)) return true;
  }
  return false;
}

export function pathExcluded(cfg: MomentoConfig, filePath: string): boolean {
  for (const pat of cfg.excludePaths) {
    if (filePath.includes(pat)) return true;
  }
  return false;
}
