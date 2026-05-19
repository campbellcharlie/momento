#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { findByTopicRanked, type MatchType, type SessionRow } from "./queries.js";

const DB_PATH = join(homedir(), ".momento", "index.db");
const TIMEOUT_MS = 200;
const DEBUG_LOG_PATH = process.env.MOMENTO_INJECT_DEBUG_LOG ?? join(homedir(), ".momento", "inject.log");
const DEBUG_ENABLED = /^(1|true|yes)$/i.test(process.env.MOMENTO_INJECT_DEBUG ?? "");
const parsedMaxSelectedHits = Number(process.env.MOMENTO_INJECT_MAX_HITS ?? "3");
const MAX_SELECTED_HITS = Number.isFinite(parsedMaxSelectedHits)
  ? Math.max(1, Math.trunc(parsedMaxSelectedHits))
  : 3;
const parsedMinScore = Number(process.env.MOMENTO_INJECT_MIN_SCORE ?? "-1");
const MIN_SCORE = Number.isFinite(parsedMinScore) ? parsedMinScore : -1;
const parsedMinTokens = Number(process.env.MOMENTO_INJECT_MIN_TOKENS ?? "4");
const MIN_TOKENS = Number.isFinite(parsedMinTokens) ? Math.max(1, parsedMinTokens) : 4;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "but", "by", "for", "from", "get", "give",
  "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our",
  "please", "review", "show", "that", "the", "their", "them", "then", "this", "to",
  "use", "what", "with", "you", "your",
]);
const TRIVIAL_PROMPTS = new Set([
  "continue",
  "do it",
  "fix it",
  "go",
  "kill it",
  "ok",
  "okay",
  "ship it",
  "yes",
  "y",
]);

interface InjectDecision {
  inject: boolean;
  reason: string;
  tokenCount: number;
  topScore: number | null;
}

interface SelectedHits {
  hits: SessionRow[];
  selectionReason: string;
  currentRepo: string | null;
}

const SRC_ROOTS = (process.env.MOMENTO_SRC_ROOTS
  ? process.env.MOMENTO_SRC_ROOTS.split(":").filter(Boolean)
  : [join(homedir(), "src")]
).map(canonicalize);

function debugLog(entry: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  appendFileSync(
    DEBUG_LOG_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    "utf8",
  );
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function meaningfulTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s/.-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => /[a-z0-9]/.test(t));
  const unique: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  return unique;
}

function isMechanicalPrompt(prompt: string, tokens: string[]): boolean {
  const trimmed = prompt.trim().toLowerCase();
  if (TRIVIAL_PROMPTS.has(trimmed)) return true;
  if (tokens.length === 1) {
    const only = tokens[0];
    if (/^[./~]/.test(only)) return true;
    if (/\.(c|cc|cpp|go|java|js|json|jsx|md|py|rb|rs|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/.test(only)) {
      return true;
    }
  }
  if (/^\/[a-z0-9:_-]+$/i.test(trimmed)) return true;
  return false;
}

function decideInjection(
  hits: SessionRow[],
  tokens: string[],
  matchType: MatchType,
): InjectDecision {
  const topScore = typeof hits[0]?.score === "number" ? hits[0].score : null;
  if (hits.length === 0) {
    return { inject: false, reason: "no_hits", tokenCount: tokens.length, topScore };
  }
  // AND matches already enforce that every meaningful token appears, so
  // raw BM25 (which is degenerate on small corpora) isn't useful here.
  // Apply the score floor only on OR-fallback hits.
  if (matchType === "or") {
    if (topScore === null || !Number.isFinite(topScore) || topScore > MIN_SCORE) {
      return { inject: false, reason: "low_confidence", tokenCount: tokens.length, topScore };
    }
  }
  return { inject: true, reason: "inject", tokenCount: tokens.length, topScore };
}

function preflightDecision(prompt: string): InjectDecision | null {
  const tokens = meaningfulTokens(prompt);
  if (isMechanicalPrompt(prompt, tokens)) {
    return { inject: false, reason: "mechanical_prompt", tokenCount: tokens.length, topScore: null };
  }
  if (tokens.length < MIN_TOKENS) {
    return { inject: false, reason: "short_prompt", tokenCount: tokens.length, topScore: null };
  }
  return null;
}

function repoRootForPath(path: string): string | null {
  const fullPath = canonicalize(path);
  for (const root of SRC_ROOTS) {
    if (!root) continue;
    if (fullPath === root) return root;
    if (fullPath.startsWith(root + "/")) {
      const rest = fullPath.slice(root.length + 1);
      const repo = rest.split("/")[0];
      if (repo) return `${root}/${repo}`;
    }
  }
  return null;
}

// Walk up from cwd looking for a `.git` marker. Falls back to SRC_ROOTS
// bucketing so repos outside the configured roots still get detected.
function repoRootFromCwd(cwd: string): string | null {
  let dir = canonicalize(cwd);
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = canonicalize(join(dir, ".."));
    if (parent === dir) break;
    dir = parent;
  }
  return repoRootForPath(cwd);
}

// Short or generic names like `api`, `app`, `core` collide with English words
// in prompts and produce false "explicit_other_repo" hits. Require ≥4 chars
// and exclude a small stoplist of common directory names.
const COMMON_REPO_NAMES = new Set([
  "backend", "client", "code", "core", "docs", "frontend", "main",
  "mobile", "scripts", "server", "test", "tests", "tools",
]);

function isUsableRepoName(name: string): boolean {
  if (!name || name.length < 4) return false;
  return !COMMON_REPO_NAMES.has(name);
}

function repoNamesFromPath(path: string): string[] {
  const names = new Set<string>();
  if (!path) return [];
  const baseName = basename(path).trim().toLowerCase();
  if (baseName) names.add(baseName);
  const repoRoot = repoRootForPath(path);
  if (repoRoot) names.add(basename(repoRoot).trim().toLowerCase());
  const encodedTail = baseName.match(/(?:^|-)(?:src|projects)-(.+)$/i);
  if (encodedTail?.[1]) {
    names.add(encodedTail[1].replace(/^-+/, "").toLowerCase());
  }
  return [...names];
}

function projectRepoNames(hit: SessionRow): string[] {
  return repoNamesFromPath(hit.projectPath);
}

function touchedRepoNames(hit: SessionRow): string[] {
  const names = new Set<string>();
  for (const path of hit.topEditedPaths ?? []) {
    for (const name of repoNamesFromPath(path)) names.add(name);
  }
  return [...names];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptMentionsRepo(prompt: string, repoName: string): boolean {
  if (!repoName) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(repoName)}([^a-z0-9]|$)`, "i");
  return pattern.test(prompt);
}

// A hit belongs to the current repo if its launch dir resolves there OR any
// of its native top-edited paths fall under it. The latter catches Claude
// sessions, whose projectPath is an encoded launch dir that won't realpath.
function isSameRepoHit(hit: SessionRow, currentRepo: string): boolean {
  if (repoRootForPath(hit.projectPath) === currentRepo) return true;
  return (hit.topEditedPaths ?? []).some((p) => repoRootForPath(p) === currentRepo);
}

function displayNameForHit(hit: SessionRow): string {
  const repoRoot = repoRootForPath(hit.projectPath);
  if (repoRoot) return basename(repoRoot);
  const firstEditedRoot = (hit.topEditedPaths ?? [])
    .map((p) => repoRootForPath(p))
    .find((r): r is string => !!r);
  if (firstEditedRoot) return basename(firstEditedRoot);
  // Claude encodes launch dirs like `-Volumes-Raid1-Storage-src-momento`.
  const tail = hit.projectPath?.match(/[-/](?:src|projects)-([^/]+)$/i);
  if (tail?.[1]) return tail[1].replace(/^-+/, "");
  return basename(hit.projectPath || "") || hit.client || "session";
}

function selectHits(prompt: string, hits: SessionRow[]): SelectedHits {
  const currentRepo = repoRootFromCwd(process.cwd());
  const currentRepoName = currentRepo ? basename(currentRepo).toLowerCase() : null;

  // Explicit cross-repo: the prompt mentions a usable name belonging to a
  // candidate hit's project OR its touched paths.
  const explicitOtherRepos = new Set<string>();
  for (const hit of hits) {
    for (const name of [...projectRepoNames(hit), ...touchedRepoNames(hit)]) {
      if (!isUsableRepoName(name)) continue;
      if (name === currentRepoName) continue;
      if (promptMentionsRepo(prompt, name)) explicitOtherRepos.add(name);
    }
  }
  if (explicitOtherRepos.size > 0) {
    const selected = hits.filter((hit) =>
      [...projectRepoNames(hit), ...touchedRepoNames(hit)].some((name) =>
        explicitOtherRepos.has(name),
      ),
    );
    if (selected.length > 0) {
      return { hits: selected, selectionReason: "explicit_other_repo", currentRepo };
    }
  }

  if (currentRepo) {
    const same = hits.filter((hit) => isSameRepoHit(hit, currentRepo));
    if (same.length > 0) {
      return { hits: same, selectionReason: "same_repo", currentRepo };
    }
    return { hits: [], selectionReason: "no_same_repo_hits", currentRepo };
  }

  return { hits, selectionReason: "no_repo_context", currentRepo };
}

async function readStdin(): Promise<string> {
  const argvPrompt = process.argv.slice(2).join(" ").trim();
  if (process.stdin.isTTY) return argvPrompt;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const stdinPrompt = Buffer.concat(chunks).toString("utf8").trim();
  return stdinPrompt || argvPrompt;
}

async function main(): Promise<void> {
  const cwd = canonicalize(process.cwd());
  const currentRepo = repoRootFromCwd(cwd);
  if (!existsSync(DB_PATH)) {
    debugLog({ event: "skip", reason: "missing_db", dbPath: DB_PATH, cwd, currentRepo });
    return;
  }
  const raw = (await readStdin()).trim();
  if (!raw) {
    debugLog({ event: "skip", reason: "empty_input", cwd, currentRepo });
    return;
  }
  let prompt = raw;
  let payloadField = "plain";
  let currentSessionId: string | null = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      const o = j as { prompt?: unknown; user_prompt?: unknown; session_id?: unknown };
      if (typeof o.user_prompt === "string") {
        prompt = o.user_prompt;
        payloadField = "user_prompt";
      } else if (typeof o.prompt === "string") {
        prompt = o.prompt;
        payloadField = "prompt";
      }
      if (typeof o.session_id === "string" && o.session_id) {
        currentSessionId = o.session_id;
      }
    }
  } catch {
    /* plain string */
  }
  if (!prompt) {
    debugLog({ event: "skip", reason: "empty_prompt", payloadField, cwd, currentRepo });
    return;
  }
  const preflight = preflightDecision(prompt);
  if (preflight) {
    debugLog({
      event: "decision",
      reason: preflight.reason,
      payloadField,
      prompt,
      tokenCount: preflight.tokenCount,
      topScore: null,
      queryMs: 0,
      hits: [],
      cwd,
      currentRepo,
    });
    return;
  }
  const tokens = meaningfulTokens(prompt);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 50");
  try {
    const queryStarted = Date.now();
    const { hits: rawHits, matchType } = findByTopicRanked(db, prompt, 10);
    // Drop the active session itself: the indexer writes ongoing sessions to
    // FTS, so the current conversation is a real, high-scoring candidate
    // against its own prompt. Injecting it back is pure noise.
    const hits = currentSessionId
      ? rawHits.filter((h) => h.id !== currentSessionId)
      : rawHits;
    const selfHitFiltered = currentSessionId !== null && hits.length !== rawHits.length;
    const selected = selectHits(prompt, hits);
    const selectedHits = selected.hits.slice(0, MAX_SELECTED_HITS);
    const decision = decideInjection(selected.hits, tokens, matchType);
    debugLog({
      event: "decision",
      reason: decision.reason,
      matchType,
      selectionReason: selected.selectionReason,
      payloadField,
      prompt,
      tokenCount: decision.tokenCount,
      topScore: decision.topScore,
      candidateTopScore: typeof hits[0]?.score === "number" ? hits[0].score : null,
      queryMs: Date.now() - queryStarted,
      cwd,
      currentRepo: selected.currentRepo,
      currentSessionId,
      selfHitFiltered,
      selectedHitIds: selectedHits.map((h) => h.id),
      hits: hits.map((h) => ({
        id: h.id,
        projectPath: h.projectPath,
        score: h.score ?? null,
        topEditedPaths: h.topEditedPaths ?? [],
      })),
    });
    if (!decision.inject) return;
    const lines: string[] = ["<!-- momento: relevant past sessions -->"];
    for (const h of selectedHits) {
      const name = displayNameForHit(h);
      const date = (h.modified ?? "").slice(0, 10);
      const summary = (h.summary ?? h.firstPrompt ?? "(no summary)").replace(/\s+/g, " ").slice(0, 120);
      lines.push(`- [${name}] ${summary} (${date}) - ${h.id}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    db.close();
  }
}

const timer = setTimeout(() => {
  debugLog({ event: "timeout", timeoutMs: TIMEOUT_MS });
  process.exit(0);
}, TIMEOUT_MS);
timer.unref();

main()
  .catch((err: unknown) => {
    debugLog({
      event: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    /* never block the user */
  })
  .finally(() => {
    clearTimeout(timer);
  });
