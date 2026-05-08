import { DatabaseSync, StatementSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import { dirname, basename } from "node:path";
import {
  iterateSessions,
  parseSession,
  readSessionsIndex,
  cleanFirstPrompt,
  IndexedSessionMeta,
} from "./parser.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  summary TEXT,
  first_prompt TEXT,
  created TEXT,
  modified TEXT,
  git_branch TEXT,
  message_count INTEGER,
  jsonl_path TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  role UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  summary,
  first_prompt,
  tokenize = 'porter unicode61'
);
CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT,
  tool_name TEXT,
  input_json TEXT,
  timestamp TEXT
);
CREATE TABLE IF NOT EXISTS file_touches (
  session_id TEXT,
  file_path TEXT,
  operation TEXT,
  timestamp TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_file_touches_path ON file_touches(file_path);
`;

export interface IndexProgress {
  done: number;
  total?: number;
  current: string;
}

export class Indexer {
  readonly db: DatabaseSync;
  private watcher?: FSWatcher;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private indexCache = new Map<string, Map<string, IndexedSessionMeta>>();

  private stmtUpsertSession!: StatementSync;
  private stmtSessionMtime!: StatementSync;
  private stmtDelSession!: StatementSync;
  private stmtDelFts!: StatementSync;
  private stmtDelTools!: StatementSync;
  private stmtDelTouches!: StatementSync;
  private stmtInsFts!: StatementSync;
  private stmtInsTool!: StatementSync;
  private stmtInsTouch!: StatementSync;
  private stmtDelSessFts!: StatementSync;
  private stmtInsSessFts!: StatementSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.db.exec("PRAGMA user_version = 1");
    this.prepare();
  }

  private prepare(): void {
    this.stmtUpsertSession = this.db.prepare(`
      INSERT INTO sessions (id, project_path, summary, first_prompt, created, modified, git_branch, message_count, jsonl_path)
      VALUES (@id, @project_path, @summary, @first_prompt, @created, @modified, @git_branch, @message_count, @jsonl_path)
      ON CONFLICT(id) DO UPDATE SET
        project_path=excluded.project_path,
        summary=excluded.summary,
        first_prompt=excluded.first_prompt,
        created=excluded.created,
        modified=excluded.modified,
        git_branch=excluded.git_branch,
        message_count=excluded.message_count,
        jsonl_path=excluded.jsonl_path
    `);
    this.stmtSessionMtime = this.db.prepare(`SELECT modified FROM sessions WHERE id = ?`);
    this.stmtDelSession = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    this.stmtDelFts = this.db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`);
    this.stmtDelTools = this.db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`);
    this.stmtDelTouches = this.db.prepare(`DELETE FROM file_touches WHERE session_id = ?`);
    this.stmtInsFts = this.db.prepare(
      `INSERT INTO messages_fts(session_id, role, content) VALUES (?, ?, ?)`,
    );
    this.stmtInsTool = this.db.prepare(
      `INSERT INTO tool_calls(session_id, tool_name, input_json, timestamp) VALUES (?, ?, ?, ?)`,
    );
    this.stmtInsTouch = this.db.prepare(
      `INSERT INTO file_touches(session_id, file_path, operation, timestamp) VALUES (?, ?, ?, ?)`,
    );
    this.stmtDelSessFts = this.db.prepare(`DELETE FROM sessions_fts WHERE session_id = ?`);
    this.stmtInsSessFts = this.db.prepare(
      `INSERT INTO sessions_fts(session_id, summary, first_prompt) VALUES (?, ?, ?)`,
    );
  }

  async buildAll(rootDir: string, onProgress?: (p: IndexProgress) => void): Promise<void> {
    let done = 0;
    for await (const ref of iterateSessions(rootDir)) {
      try {
        const st = await stat(ref.jsonlPath);
        const mtimeIso = st.mtime.toISOString();
        const existing = this.stmtSessionMtime.get(ref.sessionId) as { modified?: string } | undefined;
        if (existing?.modified && existing.modified >= mtimeIso) {
          done++;
          onProgress?.({ done, current: ref.jsonlPath });
          continue;
        }
        await this.indexSession(ref.jsonlPath, ref.projectDir, ref.sessionId);
      } catch (err) {
        process.stderr.write(`momento: index failed ${ref.jsonlPath}: ${(err as Error).message}\n`);
      }
      done++;
      onProgress?.({ done, current: ref.jsonlPath });
    }
  }

  async indexSession(jsonlPath: string, projectDir: string, sessionId: string): Promise<void> {
    const parsed = await parseSession(jsonlPath);
    const id = parsed.sessionId || sessionId;
    let meta = this.indexCache.get(projectDir);
    if (!meta) {
      meta = await readSessionsIndex(projectDir);
      this.indexCache.set(projectDir, meta);
    }
    const m = meta.get(id) ?? {};
    const st = await stat(jsonlPath);
    const firstUser = parsed.messages.find((x) => x.role === "user");
    const projectPath = m.projectPath ?? projectDir;
    const created = m.created ?? parsed.messages[0]?.timestamp ?? st.birthtime.toISOString();
    const modified = m.modified ?? parsed.messages[parsed.messages.length - 1]?.timestamp ?? st.mtime.toISOString();

    const summary = m.summary ?? null;
    const firstPrompt = cleanFirstPrompt(m.firstPrompt ?? firstUser?.text ?? null);

    this.db.exec("BEGIN");
    try {
      this.stmtDelFts.run(id);
      this.stmtDelTools.run(id);
      this.stmtDelTouches.run(id);
      this.stmtDelSessFts.run(id);
      this.stmtUpsertSession.run({
        id,
        project_path: projectPath,
        summary,
        first_prompt: firstPrompt,
        created,
        modified,
        git_branch: m.gitBranch ?? null,
        message_count: m.messageCount ?? parsed.messages.length,
        jsonl_path: jsonlPath,
      });
      this.stmtInsSessFts.run(id, summary ?? "", firstPrompt ?? "");
      for (const msg of parsed.messages) this.stmtInsFts.run(id, msg.role, msg.text);
      for (const tc of parsed.toolCalls) this.stmtInsTool.run(id, tc.toolName, tc.inputJson, tc.timestamp);
      for (const ft of parsed.filesTouched) this.stmtInsTouch.run(id, ft.filePath, ft.operation, ft.timestamp);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  watch(rootDir: string): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(rootDir, {
      ignoreInitial: true,
      ignored: (p, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        return !p.endsWith(".jsonl");
      },
    });
    const schedule = (path: string, kind: "upsert" | "remove") => {
      const prev = this.debounceTimers.get(path);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        this.debounceTimers.delete(path);
        if (kind === "remove") {
          const id = basename(path, ".jsonl");
          this.db.exec("BEGIN");
          try {
            this.stmtDelFts.run(id);
            this.stmtDelTools.run(id);
            this.stmtDelTouches.run(id);
            this.stmtDelSessFts.run(id);
            this.stmtDelSession.run(id);
            this.db.exec("COMMIT");
          } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
          }
        } else {
          const projectDir = dirname(path);
          const sessionId = basename(path, ".jsonl");
          this.indexCache.delete(projectDir);
          this.indexSession(path, projectDir, sessionId).catch((err) =>
            process.stderr.write(`momento: watch reindex failed ${path}: ${err.message}\n`),
          );
        }
      }, 500);
      this.debounceTimers.set(path, t);
    };
    this.watcher.on("add", (p) => schedule(p, "upsert"));
    this.watcher.on("change", (p) => schedule(p, "upsert"));
    this.watcher.on("unlink", (p) => schedule(p, "remove"));
  }

  close(): void {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.watcher?.close().catch(() => {});
    this.db.close();
  }
}
