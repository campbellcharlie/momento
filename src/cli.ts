#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import {
  findByTopicRanked,
  sessionCategoryBreakdown,
  type MatchType,
  type SessionRow,
} from "./queries.js";

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
// When there is NO current-repo anchor (cwd isn't in a repo — e.g. a background
// job or a home-dir session), the same-repo filter can't run, so injection
// otherwise falls back to the raw BM25 pool and a single incidental shared token
// surfaces off-topic sessions. In that case require a hit to match at least this
// many distinct query terms before it's eligible to inject.
const parsedNoRepoMinTerms = Number(process.env.MOMENTO_INJECT_NO_REPO_MIN_TERMS ?? "2");
const NO_REPO_MIN_MATCHED_TERMS = Number.isFinite(parsedNoRepoMinTerms)
  ? Math.max(1, Math.trunc(parsedNoRepoMinTerms))
  : 2;
// Recency decay: sessions older than this many days get a soft score penalty
// at hit-selection time. Tiny vs BM25 magnitudes (~5-10) so it only matters
// when two hits are otherwise close — exactly when recency should break ties.
const parsedRecencyHalfLife = Number(process.env.MOMENTO_INJECT_RECENCY_HALF_LIFE_DAYS ?? "14");
const RECENCY_HALF_LIFE_DAYS = Number.isFinite(parsedRecencyHalfLife) && parsedRecencyHalfLife > 0
  ? parsedRecencyHalfLife
  : 14;
// When the prompt looks like code-work (debugging/refactor/feature/test/etc.),
// demote hits whose turn categories are mostly chat. The pattern matches a few
// rare-enough terms; intentionally narrow to avoid over-firing on prose.
const CODE_WORK_HINTS = /\b(bug|fix|debug|error|broken|failing|crash|refactor|implement|test|deploy|build|compile|patch|stack\s*trace|exception)\b/i;
const CHAT_CATEGORIES = new Set(["conversation", "brainstorming"]);
// Strip the most common synthetic prefixes when deriving a snippet from FTS —
// Codex sessions bury the real first prompt under <environment_context>,
// Claude Code wraps slash-commands and shell prefixes in <command-...> tags,
// and local-command transcripts get a long <local-command-caveat> header.
// Mirrors parser.ts's PREFIX_PATTERNS so the FTS-derived snippet sees the same
// cleanup that summary/firstPrompt already received at index time.
const SNIPPET_PREFIX_STRIP = [
  // Claude Code's slash-command and local-shell wrappers — caveat, stdout,
  // stderr, name, message, args. Match any tag prefixed with `command-` or
  // `local-command-`. Repeated globally because a single message can carry
  // several stacked tags (e.g. caveat + name + stdout).
  /<(?:local-)?command-[a-z]+>[\s\S]*?<\/(?:local-)?command-[a-z]+>\s*/gi,
  // Codex synthetic context dump.
  /<environment_context>[\s\S]*?<\/environment_context>\s*/gi,
  // System reminders injected by various clients.
  /<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi,
];
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
)
  .map(canonicalize)
  .sort((a, b) => b.length - a.length);

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

// Score adjustment: BM25 is lower-is-better, so we ADD penalties. Returns the
// adjusted score (still lower-better) so caller can sort ascending as before.
function adjustScore(
  baseScore: number,
  modified: string | null,
  breakdown: { category: string; turns: number }[],
  promptLooksCodeWork: boolean,
): number {
  let s = baseScore;
  // Recency: linear penalty proportional to age. Half-life is the soft scale
  // at which the penalty equals 0.5 — small vs BM25 noise so it only breaks
  // ties between near-equal candidates.
  if (modified) {
    const ageMs = Date.now() - Date.parse(modified);
    const ageDays = ageMs > 0 ? ageMs / 86_400_000 : 0;
    if (Number.isFinite(ageDays)) s += (ageDays / RECENCY_HALF_LIFE_DAYS) * 0.5;
  }
  // Category: when the user's prompt is code-work, demote hits whose
  // classified turns are >=85% conversation/brainstorming. Threshold matches
  // the classifier's "no tool use, casual chat" cluster — see classifier.ts.
  if (promptLooksCodeWork && breakdown.length > 0) {
    const total = breakdown.reduce((acc, b) => acc + b.turns, 0);
    const chat = breakdown
      .filter((b) => CHAT_CATEGORIES.has(b.category))
      .reduce((acc, b) => acc + b.turns, 0);
    if (total > 0 && chat / total >= 0.85) s += 2.0;
  }
  return s;
}

// When summary and firstPrompt are both empty (common for Codex sessions and
// some encoded Claude entries), pull the first user message from FTS as a
// fallback snippet. The strip patterns above remove the synthetic wrappers
// that would otherwise bury the real content.
function deriveSnippet(db: DatabaseSync, sessionId: string): string | null {
  // Walk a few user messages — the very first is often pure boilerplate
  // (slash-command transcripts, environment_context dumps). Stop at the first
  // one with meaningful content remaining after the synthetic prefixes are
  // stripped. 8 is enough in practice without slowing the hook.
  const rows = db
    .prepare(
      `SELECT content FROM messages_fts WHERE session_id = ? AND role = 'user' LIMIT 8`,
    )
    .all(sessionId) as { content?: string }[];
  for (const row of rows) {
    if (!row?.content) continue;
    let text = row.content;
    let changed = true;
    while (changed) {
      changed = false;
      for (const re of SNIPPET_PREFIX_STRIP) {
        const next = text.replace(re, "");
        if (next !== text) {
          text = next;
          changed = true;
        }
      }
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length >= 8) return text.slice(0, 120);
  }
  return null;
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
  // Wait out a writer's checkpoint rather than returning empty. The indexer
  // holds the write lock (busy_timeout 5000) while indexing large transcripts;
  // at 50ms this hook silently injected nothing under contention, which reads
  // as "no relevant sessions" instead of "could not look".
  db.exec("PRAGMA busy_timeout = 500");
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
    // Rerank by recency + category before slicing. AND-first BM25 gives a clean
    // candidate set; this stage breaks ties on (a) freshness and (b) whether
    // the hit actually contains code-work turns when the user's prompt is
    // about code-work. See adjustScore for the exact penalties.
    const promptLooksCodeWork = CODE_WORK_HINTS.test(prompt);
    const reranked = selected.hits.map((h) => {
      const baseScore = typeof h.score === "number" ? h.score : 0;
      const breakdown = sessionCategoryBreakdown(db, h.id);
      return {
        hit: h,
        adjusted: adjustScore(baseScore, h.modified, breakdown, promptLooksCodeWork),
        breakdown,
      };
    });
    reranked.sort((a, b) => a.adjusted - b.adjusted);
    let selectedHits = reranked.slice(0, MAX_SELECTED_HITS).map((r) => r.hit);
    // No repo anchor → drop hits that matched only a single incidental term, so
    // the raw-pool fallback can't inject off-topic sessions (see constant above).
    if (selected.selectionReason === "no_repo_context") {
      selectedHits = selectedHits.filter(
        (h) => (h.why?.matchedTerms?.length ?? 0) >= NO_REPO_MIN_MATCHED_TERMS,
      );
    }
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
      promptLooksCodeWork,
      selectedHitIds: selectedHits.map((h) => h.id),
      hits: hits.map((h) => ({
        id: h.id,
        projectPath: h.projectPath,
        score: h.score ?? null,
        topEditedPaths: h.topEditedPaths ?? [],
      })),
      reranked: reranked.map((r) => ({
        id: r.hit.id,
        baseScore: r.hit.score ?? null,
        adjusted: r.adjusted,
        breakdown: r.breakdown,
      })),
    });
    if (!decision.inject) return;
    // The no-repo term filter above can empty the set — skip rather than emit a
    // header with nothing under it.
    if (selectedHits.length === 0) {
      debugLog({ event: "skip", reason: "no_repo_weak_match", selectionReason: selected.selectionReason, cwd, currentRepo: selected.currentRepo });
      return;
    }
    const lines: string[] = ["<!-- momento: relevant past sessions -->"];
    for (const h of selectedHits) {
      const name = displayNameForHit(h);
      const date = (h.modified ?? "").slice(0, 10);
      const rawSummary =
        (h.summary && h.summary.trim()) ||
        (h.firstPrompt && h.firstPrompt.trim()) ||
        deriveSnippet(db, h.id) ||
        "(no summary)";
      const summary = rawSummary.replace(/\s+/g, " ").slice(0, 120);
      // Outcome marker tells the agent whether this precedent actually worked,
      // so a "✗" session reads as a what-not-to-repeat rather than a model to
      // follow. Empty when unknown (null) — no marker, line is unchanged.
      const mark =
        h.outcome === "success" ? "✓ " :
        h.outcome === "failure" ? "✗ " :
        h.outcome === "mixed" ? "~ " : "";
      lines.push(`- [${name}] ${mark}${summary} (${date}) - ${h.id}`);
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
