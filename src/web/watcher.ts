// Polls the momento SQLite index file's mtime every `intervalMs` and, when it
// changes, queries the most recently modified session and publishes a
// `session_indexed` event onto the bus.
//
// Deliberately a stat-based polling loop instead of a filesystem watcher: the
// indexer already owns the watches; the web watcher is a passive read-only
// observer of the DB file and shouldn't add a second filesystem watcher.

import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import type { EventBus } from "./events.js";

export interface WatcherOptions {
  bus: EventBus;
  dbPath: string;
  intervalMs?: number;
}

export class IndexWatcher {
  private readonly bus: EventBus;
  private readonly dbPath: string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastMtimeMs = 0;
  private lastSessionId: string | null = null;
  // Watermark for tool_calls / file_touches streaming. Timestamps are ISO
  // strings written by the indexer, which sort lexically. Seeded from the
  // current max on first tick so reconnects don't replay history.
  private lastActivityTs = "";
  private stopped = false;

  constructor(opts: WatcherOptions) {
    this.bus = opts.bus;
    this.dbPath = opts.dbPath;
    this.intervalMs = opts.intervalMs ?? 2000;
  }

  start(): void {
    if (this.timer) return;
    // Seed lastMtime so we don't immediately fire on startup.
    void this.seed();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the process alive solely on this polling timer.
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async seed(): Promise<void> {
    this.lastMtimeMs = await this.maxMtimeMs();
  }

  // Returns the most recent mtime across the main DB file and the WAL/SHM
  // sidecars. With WAL journaling, writes touch the -wal file long before
  // the main file is checkpointed, so polling just the main file misses
  // bursts of activity for tens of seconds at a time.
  private async maxMtimeMs(): Promise<number> {
    const paths = [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`];
    const stats = await Promise.all(
      paths.map((p) => stat(p).then((s) => s.mtimeMs).catch(() => 0)),
    );
    return Math.max(0, ...stats);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const mtimeMs = await this.maxMtimeMs();
    if (mtimeMs === 0) return; // db doesn't exist yet
    if (mtimeMs === this.lastMtimeMs) return;
    this.lastMtimeMs = mtimeMs;
    this.publishLatest();
  }

  private publishLatest(): void {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const row = db
        .prepare(
          `SELECT id, project_path AS projectPath, summary, first_prompt AS firstPrompt,
                  modified, client, message_count AS messageCount
           FROM sessions ORDER BY modified DESC LIMIT 1`,
        )
        .get() as
        | {
            id: string;
            projectPath: string;
            summary: string | null;
            firstPrompt: string | null;
            modified: string | null;
            client: string;
            messageCount: number | null;
          }
        | undefined;
      if (row) {
        // De-dup: only publish if the latest session row changed (mtime can
        // move for vacuum, WAL checkpoint, etc. without a new session).
        const key = `${row.id}:${row.modified ?? ""}`;
        if (key !== this.lastSessionId) {
          this.lastSessionId = key;
          this.bus.publish("session_indexed", {
            session_id: row.id,
            project_path: row.projectPath,
            summary: row.summary,
            first_prompt: row.firstPrompt,
            modified: row.modified,
            client: row.client,
            message_count: row.messageCount,
          });
        }
      }
      this.publishActivity(db);
    } catch (err) {
      // Surface to stderr but don't kill the server; e.g. transient WAL state.
      process.stderr.write(
        `momento web watcher: ${(err as Error).message}\n`,
      );
    } finally {
      db?.close();
    }
  }

  // Stream tool calls and file touches added since the last watermark. Emits
  // one SSE event per row so the dashboard can render them as live lines.
  // First call seeds the watermark to the current max so existing history
  // isn't replayed when the server (re)starts.
  private publishActivity(db: DatabaseSync): void {
    if (!this.lastActivityTs) {
      const r = db
        .prepare(
          "SELECT MAX(t) AS t FROM (SELECT timestamp AS t FROM tool_calls UNION ALL SELECT timestamp AS t FROM file_touches)",
        )
        .get() as { t: string | null } | undefined;
      this.lastActivityTs = r?.t ?? "1970-01-01T00:00:00Z";
      return;
    }
    // Join sessions for project_path so the dashboard can show a meaningful
    // label instead of an opaque session id. input_json is truncated here so
    // a single giant Bash command can't blow up the SSE payload.
    const tools = db
      .prepare(
        `SELECT tc.session_id AS sessionId, tc.tool_name AS toolName,
                substr(tc.input_json, 1, 240) AS inputJson,
                tc.timestamp, s.project_path AS projectPath
         FROM tool_calls tc LEFT JOIN sessions s ON s.id = tc.session_id
         WHERE tc.timestamp > ?
         ORDER BY tc.timestamp ASC LIMIT 50`,
      )
      .all(this.lastActivityTs) as {
      sessionId: string;
      toolName: string;
      inputJson: string | null;
      timestamp: string;
      projectPath: string | null;
    }[];
    const touches = db
      .prepare(
        `SELECT ft.session_id AS sessionId, ft.file_path AS filePath,
                ft.operation, ft.timestamp, s.project_path AS projectPath
         FROM file_touches ft LEFT JOIN sessions s ON s.id = ft.session_id
         WHERE ft.timestamp > ? AND ft.touch_source = 'native'
         ORDER BY ft.timestamp ASC LIMIT 50`,
      )
      .all(this.lastActivityTs) as {
      sessionId: string;
      filePath: string;
      operation: string;
      timestamp: string;
      projectPath: string | null;
    }[];
    let maxTs = this.lastActivityTs;
    for (const t of tools) {
      this.bus.publish("tool_call", {
        session_id: t.sessionId,
        tool_name: t.toolName,
        input_json: t.inputJson,
        project_path: t.projectPath,
        timestamp: t.timestamp,
      });
      if (t.timestamp > maxTs) maxTs = t.timestamp;
    }
    for (const f of touches) {
      this.bus.publish("file_touch", {
        session_id: f.sessionId,
        file_path: f.filePath,
        operation: f.operation,
        project_path: f.projectPath,
        timestamp: f.timestamp,
      });
      if (f.timestamp > maxTs) maxTs = f.timestamp;
    }
    this.lastActivityTs = maxTs;
  }
}
