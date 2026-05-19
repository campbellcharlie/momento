import type { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface SearchHit {
  sessionId: string;
  projectPath: string;
  summary: string | null;
  snippet: string;
  role: string;
  score: number;
  client: string;
}

export interface SessionRow {
  id: string;
  projectPath: string;
  summary: string | null;
  firstPrompt: string | null;
  created: string | null;
  modified: string | null;
  gitBranch: string | null;
  messageCount: number | null;
  jsonlPath: string;
  client: string;
  score?: number;
  topEditedPaths?: string[];
}

// Bucket a touched file path to the deepest meaningful repo dir under a known src root.
// e.g. ~/src/myrepo/foo/bar.ts -> ~/src/myrepo
// Canonicalize once at module load so symlinked roots collapse to a single bucket prefix.
// Configurable via MOMENTO_SRC_ROOTS (colon-separated). Defaults to ~/src.
const SRC_ROOTS = (process.env.MOMENTO_SRC_ROOTS
  ? process.env.MOMENTO_SRC_ROOTS.split(":").filter(Boolean)
  : [`${process.env.HOME ?? ""}/src`]
).map(canonicalize);
function bucketPath(filePath: string): string | null {
  const fullPath = canonicalize(filePath);
  for (const root of SRC_ROOTS) {
    if (!root) continue;
    if (fullPath.startsWith(root + "/")) {
      const rest = fullPath.slice(root.length + 1);
      const repo = rest.split("/")[0];
      if (repo) return `${root}/${repo}`;
    }
  }
  return null;
}

function attachTopEditedPaths(db: DatabaseSync, sessions: SessionRow[]): void {
  if (sessions.length === 0) return;
  const placeholders = sessions.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, file_path AS filePath
       FROM file_touches
       WHERE session_id IN (${placeholders})
         AND operation IN ('write','edit')
         AND touch_source = 'native'`,
    )
    .all(...sessions.map((s) => s.id)) as unknown as { sessionId: string; filePath: string }[];
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const bucket = bucketPath(r.filePath);
    if (!bucket) continue;
    let m = counts.get(r.sessionId);
    if (!m) { m = new Map(); counts.set(r.sessionId, m); }
    m.set(bucket, (m.get(bucket) ?? 0) + 1);
  }
  for (const s of sessions) {
    const m = counts.get(s.id);
    s.topEditedPaths = m
      ? [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p)
      : [];
  }
}

const FTS_SAFE = /[^A-Za-z0-9_\s]/g;
// Common English tokens that show up in nearly every session and would force
// AND queries to over-constrain. Matches cli.ts's STOPWORDS list so the
// hook and the MCP tools agree on what counts as a "rare" token.
const FTS_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "but", "by", "for", "from", "get", "give",
  "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our",
  "please", "review", "show", "that", "the", "their", "them", "then", "this", "to",
  "use", "was", "what", "with", "you", "your",
]);

function ftsTokens(q: string): string[] {
  return q.replace(FTS_SAFE, " ").trim().split(/\s+/).filter(Boolean);
}

function ftsEscape(q: string): string {
  return ftsTokens(q).map((t) => `"${t}"`).join(" OR ");
}

// AND query over rare (non-stopword, >1 char) tokens. Returns empty string
// if no tokens qualify — caller should fall back to OR. The AND query
// guarantees every meaningful token appears at least once in each match,
// which kills the long-tail noise BM25-OR pulls in when one common token
// (like "category" or "api") matches thousands of sessions.
function ftsAndQuery(tokens: string[]): string {
  const rare = tokens.filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t.toLowerCase()));
  return rare.map((t) => `"${t}"`).join(" AND ");
}

export function search(
  db: DatabaseSync,
  q: string,
  opts: { limit?: number; projectPath?: string } = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  const fts = ftsEscape(q);
  if (!fts) return [];
  const sql = `
    SELECT m.session_id AS sessionId, s.project_path AS projectPath, s.summary AS summary,
           snippet(messages_fts, 2, '[', ']', '...', 12) AS snippet,
           m.role AS role,
           bm25(messages_fts) AS score,
           s.client AS client
    FROM messages_fts m JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ?
      ${opts.projectPath ? "AND s.project_path = ?" : ""}
    ORDER BY score ASC
    LIMIT ?
  `;
  const params = (opts.projectPath ? [fts, opts.projectPath, limit] : [fts, limit]) as (string | number)[];
  return db.prepare(sql).all(...params) as unknown as SearchHit[];
}

export function getProject(db: DatabaseSync, projectPath: string): {
  sessions: SessionRow[];
  toolCallCount: number;
  fileTouchCount: number;
} {
  const sessions = db
    .prepare(
      `SELECT id, project_path AS projectPath, summary, first_prompt AS firstPrompt,
              created, modified, git_branch AS gitBranch, message_count AS messageCount, jsonl_path AS jsonlPath, client
       FROM sessions WHERE project_path = ? ORDER BY modified DESC`,
    )
    .all(projectPath) as unknown as SessionRow[];
  const ids = sessions.map((s) => s.id);
  if (ids.length === 0) return { sessions, toolCallCount: 0, fileTouchCount: 0 };
  const placeholders = ids.map(() => "?").join(",");
  const tc = db
    .prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE session_id IN (${placeholders})`)
    .get(...ids) as { n: number };
  const ft = db
    .prepare(`SELECT COUNT(*) AS n FROM file_touches WHERE session_id IN (${placeholders})`)
    .get(...ids) as { n: number };
  attachTopEditedPaths(db, sessions);
  return { sessions, toolCallCount: tc.n, fileTouchCount: ft.n };
}

// Keyword/BM25 ranking over session summaries and message contents. Despite
// the historical name `findSimilar`, this is keyword overlap, not embedding-
// based similarity — synonyms won't match. See `findByTopic`, the preferred
// name.
export type MatchType = "and" | "or" | "none";

export interface RankedTopicResult {
  hits: SessionRow[];
  matchType: MatchType;
}

// Two-pass: stricter AND over rare tokens first, OR fallback only if AND
// returns nothing. Callers can trust an "and" match without re-checking raw
// BM25 scores (which are degenerate on small corpora). AND-first is the
// load-bearing fix for the BM25-OR noise problem — without it, every
// long-tail session sharing one common query word pollutes the candidate
// pool. Pattern matches cli.ts's prompt-hook behavior so the MCP tool and
// the hook see the same candidate set on the same query.
export function findByTopicRanked(
  db: DatabaseSync,
  description: string,
  limit = 10,
): RankedTopicResult {
  const tokens = ftsTokens(description);
  if (tokens.length === 0) return { hits: [], matchType: "none" };
  const sql = `
    WITH per_msg AS (
      SELECT session_id AS sid, bm25(messages_fts) AS s
      FROM messages_fts WHERE messages_fts MATCH ?
    ),
    per_sess AS (
      SELECT session_id AS sid, bm25(sessions_fts) * 2 AS s
      FROM sessions_fts WHERE sessions_fts MATCH ?
    ),
    combined AS (SELECT sid, s FROM per_msg UNION ALL SELECT sid, s FROM per_sess),
    ranked AS (SELECT sid, MIN(s) AS score FROM combined GROUP BY sid)
    SELECT s.id, s.project_path AS projectPath, s.summary, s.first_prompt AS firstPrompt,
           s.created, s.modified, s.git_branch AS gitBranch, s.message_count AS messageCount, s.jsonl_path AS jsonlPath,
           s.client AS client,
           r.score AS score
    FROM ranked r JOIN sessions s ON s.id = r.sid
    ORDER BY r.score ASC
    LIMIT ?
  `;
  const run = (fts: string): SessionRow[] =>
    db.prepare(sql).all(fts, fts, limit) as unknown as SessionRow[];
  const andQ = ftsAndQuery(tokens);
  let hits = andQ ? run(andQ) : [];
  let matchType: MatchType = hits.length > 0 ? "and" : "none";
  if (hits.length === 0) {
    const orQ = tokens.map((t) => `"${t}"`).join(" OR ");
    if (orQ) {
      hits = run(orQ);
      if (hits.length > 0) matchType = "or";
    }
  }
  attachTopEditedPaths(db, hits);
  return { hits, matchType };
}

export function findByTopic(
  db: DatabaseSync,
  description: string,
  limit = 10,
): SessionRow[] {
  return findByTopicRanked(db, description, limit).hits;
}

/** @deprecated Use {@link findByTopic}. Kept for callers that haven't updated yet. */
export const findSimilar = findByTopic;

// Same as findByTopic but adds a recency lane via Reciprocal Rank Fusion.
// RRF fuses multiple ranked lanes: each session's per-lane rank becomes
// 1/(k + rank), summed across lanes. Higher is better (opposite of BM25
// scores). Pattern from graymatter (pkg/memory/recall.go:75-94, MIT) — works
// well when BM25 alone produces ties or near-ties on small corpora.
//
// Weights mirror findByTopic's emphasis: sessions_fts at 2x (summary/prompt
// matches are stronger signal), messages_fts at 1x, recency at 0.4x (a tie-
// breaker, not a primary signal). k=60 is the RRF paper's default.
//
// Candidate cap (CAP_FACTOR * limit, min 30): each BM25 lane only contributes
// its top-N matches to recency_ranked. Without this, every long-tail BM25 hit
// (sessions that share a single common word in passing) enters the recency
// lane, and the most-recent of THOSE wins regardless of relevance. The cap
// is the load-bearing fix for the "find_by_topic_recent surfaces recent-but-
// off-topic sessions on sparse BM25 queries" failure mode observed in the
// May 2026 borrow-validation pass — see project_improvements.md.
export function findByTopicWithRecency(
  db: DatabaseSync,
  description: string,
  limit = 10,
): SessionRow[] {
  const tokens = ftsTokens(description);
  if (tokens.length === 0) return [];
  const cap = Math.max(30, limit * 3);
  const sql = `
    WITH msg_ranked AS (
      SELECT session_id AS sid,
             ROW_NUMBER() OVER (ORDER BY bm25(messages_fts)) AS rnk
      FROM messages_fts WHERE messages_fts MATCH ?
    ),
    sess_ranked AS (
      SELECT session_id AS sid,
             ROW_NUMBER() OVER (ORDER BY bm25(sessions_fts)) AS rnk
      FROM sessions_fts WHERE sessions_fts MATCH ?
    ),
    candidates AS (
      -- Cap each lane to top-N so recency can't drag in low-confidence
      -- matches. Sessions outside the cap never enter the recency lane and
      -- never contribute to RRF — they're not relevant enough to consider.
      SELECT sid FROM msg_ranked WHERE rnk <= ?
      UNION
      SELECT sid FROM sess_ranked WHERE rnk <= ?
    ),
    recency_ranked AS (
      SELECT s.id AS sid,
             ROW_NUMBER() OVER (ORDER BY s.modified DESC) AS rnk
      FROM sessions s JOIN candidates c ON c.sid = s.id
    ),
    fused AS (
      SELECT sid, 1.0 / (60.0 + rnk) AS contrib FROM msg_ranked WHERE rnk <= ?
      UNION ALL
      SELECT sid, 2.0 / (60.0 + rnk) AS contrib FROM sess_ranked WHERE rnk <= ?
      UNION ALL
      SELECT sid, 0.4 / (60.0 + rnk) AS contrib FROM recency_ranked
    ),
    scored AS (SELECT sid, SUM(contrib) AS rrf FROM fused GROUP BY sid)
    SELECT s.id, s.project_path AS projectPath, s.summary, s.first_prompt AS firstPrompt,
           s.created, s.modified, s.git_branch AS gitBranch, s.message_count AS messageCount,
           s.jsonl_path AS jsonlPath, s.client AS client,
           scored.rrf AS score
    FROM scored JOIN sessions s ON s.id = scored.sid
    ORDER BY scored.rrf DESC
    LIMIT ?
  `;
  const run = (fts: string): SessionRow[] =>
    db.prepare(sql).all(fts, fts, cap, cap, cap, cap, limit) as unknown as SessionRow[];

  // AND-first matches findByTopic so the BM25 candidate pool is already
  // clean — RRF is then purely a relevance/recency tiebreaker, not a noise
  // ranker. The cap stays as defense-in-depth for OR-fallback cases.
  let sessions: SessionRow[] = [];
  const andQ = ftsAndQuery(tokens);
  if (andQ) sessions = run(andQ);
  if (sessions.length === 0) {
    const orQ = tokens.map((t) => `"${t}"`).join(" OR ");
    if (orQ) sessions = run(orQ);
  }
  attachTopEditedPaths(db, sessions);
  return sessions;
}

export function getRecent(db: DatabaseSync, n = 20, projectPath?: string): SessionRow[] {
  const sql = `
    SELECT id, project_path AS projectPath, summary, first_prompt AS firstPrompt,
           created, modified, git_branch AS gitBranch, message_count AS messageCount, jsonl_path AS jsonlPath, client
    FROM sessions
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY modified DESC
    LIMIT ?
  `;
  const sessions = (
    projectPath ? db.prepare(sql).all(projectPath, n) : db.prepare(sql).all(n)
  ) as unknown as SessionRow[];
  attachTopEditedPaths(db, sessions);
  return sessions;
}

export function getRecentByEditedPath(
  db: DatabaseSync,
  path: string,
  n = 20,
): SessionRow[] {
  // Find sessions that have at least one write/edit touch under `path` (prefix match),
  // then return them ordered by most recently modified, with topEditedPaths attached.
  // Canonicalize so e.g. ~/src/foo matches stored /Volumes/Raid1_Storage/src/foo.
  const like = `${canonicalize(path)}%`;
  const sessions = db
    .prepare(
      `SELECT s.id, s.project_path AS projectPath, s.summary, s.first_prompt AS firstPrompt,
              s.created, s.modified, s.git_branch AS gitBranch, s.message_count AS messageCount,
              s.jsonl_path AS jsonlPath, s.client AS client
       FROM sessions s
       WHERE s.id IN (
         SELECT DISTINCT session_id FROM file_touches
         WHERE operation IN ('write','edit')
           AND touch_source = 'native'
           AND file_path LIKE ?
       )
       ORDER BY s.modified DESC
       LIMIT ?`,
    )
    .all(like, n) as unknown as SessionRow[];
  attachTopEditedPaths(db, sessions);
  return sessions;
}

// Sessions whose turn classification includes at least one turn of the given
// category. Returns rows ordered by most-recent-matching-turn DESC so the
// caller sees the freshest debugging/feature/etc. work first. The category
// dimension is per-turn (codeburn-style); a session can match multiple
// categories.
//
// `minTurns` lets the caller require that the category showed up more than
// once in the session (default 1) — useful when you want a session that
// actually was about that category, not one that brushed it.
export function findByCategory(
  db: DatabaseSync,
  category: string,
  opts: { limit?: number; projectPath?: string; minTurns?: number } = {},
): SessionRow[] {
  const limit = opts.limit ?? 20;
  const minTurns = Math.max(1, opts.minTurns ?? 1);
  // GROUP BY + HAVING gives us both the count filter and the per-session
  // last-matching-turn for ordering. JOIN-then-aggregate beats two round
  // trips since turn_categories is indexed on (category) and the join key
  // (session_id) is the sessions PK.
  const sql = `
    SELECT s.id, s.project_path AS projectPath, s.summary, s.first_prompt AS firstPrompt,
           s.created, s.modified, s.git_branch AS gitBranch, s.message_count AS messageCount,
           s.jsonl_path AS jsonlPath, s.client AS client,
           MAX(tc.timestamp) AS lastMatch,
           COUNT(*) AS matchingTurns
    FROM turn_categories tc JOIN sessions s ON s.id = tc.session_id
    WHERE tc.category = ?
      ${opts.projectPath ? "AND s.project_path = ?" : ""}
    GROUP BY s.id
    HAVING matchingTurns >= ?
    ORDER BY lastMatch DESC
    LIMIT ?
  `;
  const params = (opts.projectPath
    ? [category, opts.projectPath, minTurns, limit]
    : [category, minTurns, limit]) as (string | number)[];
  const sessions = db.prepare(sql).all(...params) as unknown as SessionRow[];
  attachTopEditedPaths(db, sessions);
  return sessions;
}

// Per-session breakdown: how many turns of each category. Useful to surface
// the session's "shape" alongside its summary.
export function sessionCategoryBreakdown(
  db: DatabaseSync,
  sessionId: string,
): { category: string; turns: number }[] {
  return db
    .prepare(
      `SELECT category, COUNT(*) AS turns
       FROM turn_categories
       WHERE session_id = ?
       GROUP BY category
       ORDER BY turns DESC`,
    )
    .all(sessionId) as unknown as { category: string; turns: number }[];
}

export function filesTouched(
  db: DatabaseSync,
  pattern: string,
): {
  sessionId: string;
  filePath: string;
  operation: string;
  source: string;
  projectPath: string;
  summary: string | null;
}[] {
  const like = pattern.includes("%") ? pattern : `%${pattern}%`;
  return db
    .prepare(
      `SELECT DISTINCT ft.session_id AS sessionId, ft.file_path AS filePath, ft.operation,
              ft.touch_source AS source,
              s.project_path AS projectPath, s.summary
       FROM file_touches ft JOIN sessions s ON s.id = ft.session_id
       WHERE ft.file_path LIKE ?
       ORDER BY ft.timestamp DESC
       LIMIT 100`,
    )
    .all(like) as unknown as {
    sessionId: string;
    filePath: string;
    operation: string;
    source: string;
    projectPath: string;
    summary: string | null;
  }[];
}
