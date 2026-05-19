// Polls the momento SQLite index file's mtime every `intervalMs` and, when it
// changes, queries the most recently modified session and publishes a
// `session_indexed` event onto the bus.
//
// Deliberately a stat-based polling loop instead of chokidar: the indexer
// itself already uses chokidar; the web watcher is a passive read-only
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
    try {
      const st = await stat(this.dbPath);
      this.lastMtimeMs = st.mtimeMs;
    } catch {
      this.lastMtimeMs = 0;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let mtimeMs = 0;
    try {
      const st = await stat(this.dbPath);
      mtimeMs = st.mtimeMs;
    } catch {
      return; // db doesn't exist yet
    }
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
      if (!row) return;
      // De-dup: only publish if the latest session row changed (mtime can move
      // for vacuum, WAL checkpoint, etc. without a new session).
      const key = `${row.id}:${row.modified ?? ""}`;
      if (key === this.lastSessionId) return;
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
    } catch (err) {
      // Surface to stderr but don't kill the server; e.g. transient WAL state.
      process.stderr.write(
        `momento web watcher: ${(err as Error).message}\n`,
      );
    } finally {
      db?.close();
    }
  }
}
