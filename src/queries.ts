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
  for (const root of SRC_ROOTS) {
    if (!root) continue;
    if (filePath.startsWith(root + "/")) {
      const rest = filePath.slice(root.length + 1);
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
       WHERE session_id IN (${placeholders}) AND operation IN ('write','edit')`,
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
function ftsEscape(q: string): string {
  return q.replace(FTS_SAFE, " ").trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(" OR ");
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
           bm25(messages_fts) AS score
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
              created, modified, git_branch AS gitBranch, message_count AS messageCount, jsonl_path AS jsonlPath
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

// Keyword/BM25 ranking over session summaries and message contents. Despite the
// historical name `findSimilar`, this is keyword overlap, not embedding-based
// similarity — synonyms won't match. See `findByTopic`, the preferred name.
export function findByTopic(
  db: DatabaseSync,
  description: string,
  limit = 10,
): SessionRow[] {
  const fts = ftsEscape(description);
  if (!fts) return [];
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
           s.created, s.modified, s.git_branch AS gitBranch, s.message_count AS messageCount, s.jsonl_path AS jsonlPath
    FROM ranked r JOIN sessions s ON s.id = r.sid
    ORDER BY r.score ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(fts, fts, limit) as unknown as SessionRow[];
}

/** @deprecated Use {@link findByTopic}. Kept for callers that haven't updated yet. */
export const findSimilar = findByTopic;

export function getRecent(db: DatabaseSync, n = 20, projectPath?: string): SessionRow[] {
  const sql = `
    SELECT id, project_path AS projectPath, summary, first_prompt AS firstPrompt,
           created, modified, git_branch AS gitBranch, message_count AS messageCount, jsonl_path AS jsonlPath
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
              s.jsonl_path AS jsonlPath
       FROM sessions s
       WHERE s.id IN (
         SELECT DISTINCT session_id FROM file_touches
         WHERE operation IN ('write','edit') AND file_path LIKE ?
       )
       ORDER BY s.modified DESC
       LIMIT ?`,
    )
    .all(like, n) as unknown as SessionRow[];
  attachTopEditedPaths(db, sessions);
  return sessions;
}

export function filesTouched(
  db: DatabaseSync,
  pattern: string,
): { sessionId: string; filePath: string; operation: string; projectPath: string; summary: string | null }[] {
  const like = pattern.includes("%") ? pattern : `%${pattern}%`;
  return db
    .prepare(
      `SELECT DISTINCT ft.session_id AS sessionId, ft.file_path AS filePath, ft.operation,
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
    projectPath: string;
    summary: string | null;
  }[];
}
