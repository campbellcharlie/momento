import { DatabaseSync, StatementSync } from "node:sqlite";
import { watch, existsSync, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";
import { cleanFirstPrompt, IndexedSessionMeta } from "./parser.js";
import { MomentoConfig, loadConfig, projectExcluded } from "./config.js";
import { ClientName, Source, defaultSources } from "./sources.js";
import { buildTurns, classifyTurn } from "./classifier.js";
import { detectOutcome } from "./outcome.js";
import { indexLedgerInto, indexAuditInto, indexTimelineInto } from "./external.js";

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
  jsonl_path TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'claude_code',
  outcome TEXT
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
  timestamp TEXT,
  is_error INTEGER  -- 1 error / 0 ok / NULL unknown (source carries no result status)
);
CREATE TABLE IF NOT EXISTS file_touches (
  session_id TEXT,
  file_path TEXT,
  operation TEXT,
  timestamp TEXT,
  touch_source TEXT NOT NULL DEFAULT 'native'
);
CREATE TABLE IF NOT EXISTS turn_categories (
  session_id TEXT NOT NULL,
  turn_idx INTEGER NOT NULL,
  category TEXT NOT NULL,
  timestamp TEXT,
  PRIMARY KEY (session_id, turn_idx)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_file_touches_path ON file_touches(file_path);
CREATE INDEX IF NOT EXISTS idx_turn_categories_category ON turn_categories(category);
-- External append-only sources (ISE ledger, marshal audit). Optional & additive: populated only if the
-- files exist; re-ingested per-file on mtime change (tracked in external_sources). See external.ts.
CREATE TABLE IF NOT EXISTS external_sources (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mtime TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(
  source_path UNINDEXED, entry_id UNINDEXED, outcome UNINDEXED, module UNINDEXED,
  stack UNINDEXED, klass UNINDEXED, ts UNINDEXED, content,
  tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
  source_path UNINDEXED, backend UNINDEXED, tool UNINDEXED, event UNINDEXED,
  ok UNINDEXED, ms UNINDEXED, ts UNINDEXED, content,
  tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS timeline_fts USING fts5(
  source_path UNINDEXED, job_id UNINDEXED, state UNINDEXED, ts UNINDEXED, content,
  tokenize = 'porter unicode61'
);
-- Consolidated SEMANTIC FACTS derived from the raw episodic tables above (see consolidate.ts). Kept in a
-- separate table so raw source rows are never rewritten. Bi-temporal: valid_to IS NULL = currently
-- believed; a superseded fact keeps its row with valid_to set (invalidate, don't delete).
CREATE TABLE IF NOT EXISTS facts (
  fact_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL,                 -- logical key (e.g. 'tool:momento.search'); many rows share it over time
  kind TEXT NOT NULL,              -- 'tool_reliability' | 'ledger_pattern' | …
  subject TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  n INTEGER NOT NULL,              -- support: how many observations back this fact
  provenance TEXT,                -- JSON: the numbers/sources it was derived from
  valid_from TEXT NOT NULL,
  valid_to TEXT,                  -- NULL = current belief; set = invalidated at this time
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_current ON facts(id, valid_to);
CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind, valid_to);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  fact_id UNINDEXED, kind UNINDEXED, subject, statement,
  tokenize = 'porter unicode61'
);
`;
// idx_sessions_client lives in migrate() so the index isn't built against a
// table that pre-dates the `client` column. SCHEMA has to be safe to apply
// against both fresh DBs and v1 DBs (where `client` doesn't exist yet); any
// new-column-dependent DDL belongs in a migration step.

// Schema versioning. Bump SCHEMA_VERSION and add a migration block when adding
// columns/tables. Migrations are idempotent — they read PRAGMA user_version and
// ALTER only if needed. Existing rows get sane defaults so the DB is queryable
// before the first reindex.
const SCHEMA_VERSION = 8;

function migrate(db: DatabaseSync): void {
  const cur = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= SCHEMA_VERSION) return;
  if (cur < 2) {
    // v2: add `client` column. New DBs already have it via SCHEMA above; only
    // pre-v2 DBs need the ALTER. Probe via PRAGMA table_info to stay idempotent.
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "client")) {
      db.exec("ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'claude_code'");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client)");
  }
  if (cur < 3) {
    // v3: add file_touches.touch_source column. Probe before ALTER so the
    // migration stays idempotent.
    const cols = db.prepare("PRAGMA table_info(file_touches)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "touch_source")) {
      db.exec("ALTER TABLE file_touches ADD COLUMN touch_source TEXT NOT NULL DEFAULT 'native'");
    }
  }
  if (cur < 4) {
    // v4: add turn_categories table. SCHEMA above already CREATE IF NOT
    // EXISTS'd it, so this is the explicit upgrade marker. Existing sessions
    // stay un-categorized until reindexed (find_by_category just returns
    // empty for those, never errors).
    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_categories (
        session_id TEXT NOT NULL,
        turn_idx INTEGER NOT NULL,
        category TEXT NOT NULL,
        timestamp TEXT,
        PRIMARY KEY (session_id, turn_idx)
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_turn_categories_category ON turn_categories(category)",
    );
  }
  if (cur < 5) {
    // v5: add sessions.outcome (success|failure|mixed|null). Probe before ALTER
    // so the migration stays idempotent. Existing rows stay null until
    // reindexed; recall treats null as "unknown", never as failure.
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "outcome")) {
      db.exec("ALTER TABLE sessions ADD COLUMN outcome TEXT");
    }
  }
  if (cur < 6) {
    // v6: add external_sources + ledger_fts + audit_fts for indexing ISE ledger + marshal audit.
    // SCHEMA above already CREATE IF NOT EXISTS'd them; this is the explicit version marker. They stay
    // empty (and every external search returns []) until the sources exist and get indexed — never errors.
  }
  if (cur < 7) {
    // v7: add facts + facts_fts for memory consolidation (consolidate.ts). SCHEMA above already CREATE IF
    // NOT EXISTS'd them; explicit version marker. Stay empty until `momento --consolidate` runs — additive.
  }
  if (cur < 8) {
    // v8: add tool_calls.is_error (1 error / 0 ok / NULL unknown), joined from tool_result.is_error.
    // Probe before ALTER so the migration is idempotent; existing rows stay NULL until reindexed, so an
    // un-reindexed call reads as "unknown outcome", never as a spurious success.
    const cols = db.prepare("PRAGMA table_info(tool_calls)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "is_error")) {
      db.exec("ALTER TABLE tool_calls ADD COLUMN is_error INTEGER");
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export interface IndexProgress {
  done: number;
  total?: number;
  current: string;
}

export class Indexer {
  readonly db: DatabaseSync;
  readonly config: MomentoConfig;
  private watchers: FSWatcher[] = [];
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
  private stmtDelTurnCats!: StatementSync;
  private stmtInsTurnCat!: StatementSync;

  constructor(dbPath: string, config?: MomentoConfig) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.config = config ?? loadConfig();
    this.prepare();
  }

  private prepare(): void {
    this.stmtUpsertSession = this.db.prepare(`
      INSERT INTO sessions (id, project_path, summary, first_prompt, created, modified, git_branch, message_count, jsonl_path, client, outcome)
      VALUES (@id, @project_path, @summary, @first_prompt, @created, @modified, @git_branch, @message_count, @jsonl_path, @client, @outcome)
      ON CONFLICT(id) DO UPDATE SET
        project_path=excluded.project_path,
        summary=excluded.summary,
        first_prompt=excluded.first_prompt,
        created=excluded.created,
        modified=excluded.modified,
        git_branch=excluded.git_branch,
        message_count=excluded.message_count,
        jsonl_path=excluded.jsonl_path,
        client=excluded.client,
        outcome=excluded.outcome
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
      `INSERT INTO tool_calls(session_id, tool_name, input_json, timestamp, is_error) VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtInsTouch = this.db.prepare(
      `INSERT INTO file_touches(session_id, file_path, operation, timestamp, touch_source) VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtDelSessFts = this.db.prepare(`DELETE FROM sessions_fts WHERE session_id = ?`);
    this.stmtInsSessFts = this.db.prepare(
      `INSERT INTO sessions_fts(session_id, summary, first_prompt) VALUES (?, ?, ?)`,
    );
    this.stmtDelTurnCats = this.db.prepare(`DELETE FROM turn_categories WHERE session_id = ?`);
    this.stmtInsTurnCat = this.db.prepare(
      `INSERT INTO turn_categories(session_id, turn_idx, category, timestamp) VALUES (?, ?, ?, ?)`,
    );
  }

  // Single-source convenience for the original Claude Code path. Construct a
  // one-element source list pointing at `rootDir` and delegate.
  async buildAll(rootDir: string, onProgress?: (p: IndexProgress) => void): Promise<void> {
    const claude = defaultSources().find((s) => s.client === "claude_code");
    if (!claude) throw new Error("claude_code source missing from defaultSources()");
    const source: Source = { ...claude, root: rootDir };
    await this.buildAllSources([source], onProgress);
  }

  // Multi-client buildAll. Iterates each source's layout and indexSessions
  // dispatched through the source's parser.
  async buildAllSources(sources: Source[], onProgress?: (p: IndexProgress) => void): Promise<void> {
    let done = 0;
    for (const source of sources) {
      for await (const ref of source.iterate(source.root)) {
        if (projectExcluded(this.config, ref.projectDir)) {
          done++;
          onProgress?.({ done, current: ref.jsonlPath });
          continue;
        }
        try {
          const st = await stat(ref.jsonlPath);
          const mtimeIso = st.mtime.toISOString();
          const existing = this.stmtSessionMtime.get(ref.sessionId) as { modified?: string } | undefined;
          if (existing?.modified && existing.modified >= mtimeIso) {
            done++;
            onProgress?.({ done, current: ref.jsonlPath });
            continue;
          }
          await this.indexSessionFromSource(ref.jsonlPath, ref.projectDir, ref.sessionId, source);
        } catch (err) {
          process.stderr.write(`momento: index failed ${ref.jsonlPath}: ${(err as Error).message}\n`);
        }
        done++;
        onProgress?.({ done, current: ref.jsonlPath });
      }
    }
    this.indexExternal();
  }

  // Index the optional external append-only sources (ISE ledger, marshal audit). Each is re-ingested
  // only on mtime change, so this is cheap to call opportunistically (rebuild, and before an external
  // search). Absent sources are a no-op — momento works fully without ISE or marshal.
  indexExternal(): void {
    try { indexLedgerInto(this.db); } catch (e) { process.stderr.write(`momento: ledger index skipped: ${(e as Error).message}\n`); }
    try { indexAuditInto(this.db); } catch (e) { process.stderr.write(`momento: audit index skipped: ${(e as Error).message}\n`); }
    try { indexTimelineInto(this.db); } catch (e) { process.stderr.write(`momento: timeline index skipped: ${(e as Error).message}\n`); }
  }

  // Single-source convenience for the original Claude Code watcher.
  watch(rootDir: string): void {
    const claude = defaultSources().find((s) => s.client === "claude_code");
    if (!claude) throw new Error("claude_code source missing from defaultSources()");
    this.watchSources([{ ...claude, root: rootDir }]);
  }

  // Multi-client watcher. One recursive directory watch per source root; file
  // events route to the right parser via the `path → source` map.
  //
  // Native fs.watch rather than chokidar: chokidar v4 opens an fs.watch handle
  // per discovered FILE, which on this corpus meant thousands of descriptors
  // held open for the lifetime of the server. macOS backs a recursive directory
  // watch with FSEvents, so an entire tree costs one handle instead.
  watchSources(sources: Source[]): void {
    if (this.watchers.length > 0) return;
    const sourceByPath = (p: string): Source | null => {
      for (const s of sources) if (p.startsWith(s.root)) return s;
      return null;
    };
    const allowedExts = new Set(sources.map((s) => s.fileExt));
    const schedule = (path: string) => {
      const prev = this.debounceTimers.get(path);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        this.debounceTimers.delete(path);
        const source = sourceByPath(path);
        if (!source) return;
        // fs.watch reports "rename" for both creation and deletion, so the kind
        // of change is decided here by whether the file is still on disk.
        if (!existsSync(path)) {
          const id = basename(path, source.fileExt);
          this.db.exec("BEGIN");
          try {
            this.stmtDelFts.run(id);
            this.stmtDelTools.run(id);
            this.stmtDelTouches.run(id);
            this.stmtDelTurnCats.run(id);
            this.stmtDelSessFts.run(id);
            this.stmtDelSession.run(id);
            this.db.exec("COMMIT");
          } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
          }
        } else {
          const projectDir = dirname(path);
          const sessionId = basename(path, source.fileExt);
          if (projectExcluded(this.config, projectDir)) return;
          this.indexCache.delete(projectDir);
          this.indexSessionFromSource(path, projectDir, sessionId, source).catch((err) =>
            process.stderr.write(`momento: watch reindex failed ${path}: ${err.message}\n`),
          );
        }
      }, 500);
      this.debounceTimers.set(path, t);
    };
    for (const source of sources) {
      try {
        const watcher = watch(source.root, { recursive: true }, (_event, filename) => {
          // A null filename means the platform dropped the event detail (buffer
          // overflow); there is no path to act on, so skip rather than rescan.
          if (!filename) return;
          const path = join(source.root, filename.toString());
          if (!allowedExts.has(extname(path))) return;
          schedule(path);
        });
        watcher.on("error", (err: Error) =>
          process.stderr.write(`momento: watch error on ${source.root}: ${err.message}\n`),
        );
        this.watchers.push(watcher);
      } catch (err) {
        // A source root that does not exist yet is not fatal: the remaining
        // sources still index, and a later rebuild picks the tree up.
        process.stderr.write(
          `momento: not watching ${source.root}: ${(err as Error).message}\n`,
        );
      }
    }
  }

  // Per-session indexer. Dispatches to the source's parser, merges in metadata
  // (sidecar for Claude, parser-emitted for Codex/Gemini), and upserts.
  async indexSessionFromSource(
    jsonlPath: string,
    projectDir: string,
    sessionId: string,
    source: Source,
  ): Promise<void> {
    const parsed = await source.parse(jsonlPath, this.config);
    const id = parsed.sessionId || sessionId;
    const sidecarMeta = source.resolveMeta
      ? await source.resolveMeta(id, projectDir, this.indexCache)
      : {};
    const m: IndexedSessionMeta = { ...(parsed.meta ?? {}), ...sidecarMeta };
    const st = await stat(jsonlPath);
    const firstUser = parsed.messages.find((x) => x.role === "user");
    const projectPath = m.projectPath ?? projectDir;
    const created = m.created ?? parsed.messages[0]?.timestamp ?? st.birthtime.toISOString();
    const modified = m.modified ?? parsed.messages[parsed.messages.length - 1]?.timestamp ?? st.mtime.toISOString();

    const summary = m.summary ?? null;
    const firstPrompt = cleanFirstPrompt(m.firstPrompt ?? firstUser?.text ?? null);

    // Classify turns once, before the transaction, so any classifier work
    // happens outside the DB lock. Classification is deterministic and cheap
    // (~13 regex passes per turn) — total cost is dominated by JSON.parse of
    // bash input strings, which we already paid in parser.ts.
    const turns = buildTurns(parsed.messages, parsed.toolCalls);
    const turnCats = turns.map((t) => classifyTurn(t));
    const outcome = detectOutcome(parsed.messages, parsed.toolCalls);

    this.db.exec("BEGIN");
    try {
      this.stmtDelFts.run(id);
      this.stmtDelTools.run(id);
      this.stmtDelTouches.run(id);
      this.stmtDelTurnCats.run(id);
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
        client: source.client,
        outcome,
      });
      this.stmtInsSessFts.run(id, summary ?? "", firstPrompt ?? "");
      for (const msg of parsed.messages) this.stmtInsFts.run(id, msg.role, msg.text);
      for (const tc of parsed.toolCalls)
        this.stmtInsTool.run(
          id,
          tc.toolName,
          tc.inputJson,
          tc.timestamp,
          tc.isError === undefined ? null : tc.isError ? 1 : 0,
        );
      for (const ft of parsed.filesTouched) {
        this.stmtInsTouch.run(id, ft.filePath, ft.operation, ft.timestamp, ft.source);
      }
      for (let i = 0; i < turnCats.length; i++) {
        this.stmtInsTurnCat.run(id, i, turnCats[i]!, turns[i]!.timestamp);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // Backward-compatible wrapper for the existing Claude Code-only call path.
  // Tests still drive this; new code should use indexSessionFromSource.
  async indexSession(jsonlPath: string, projectDir: string, sessionId: string): Promise<void> {
    const claude = defaultSources().find((s) => s.client === "claude_code");
    if (!claude) throw new Error("claude_code source missing from defaultSources()");
    await this.indexSessionFromSource(jsonlPath, projectDir, sessionId, claude);
  }

  close(): void {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.db.close();
  }
}

// Exported so callers can spin up the default 3-source set without importing
// from sources.ts directly. Keeps server.ts and admin.ts coupled to indexer.ts.
export { defaultSources, type Source, type ClientName };
