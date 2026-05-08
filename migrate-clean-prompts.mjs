import Database from 'better-sqlite3';
import { cleanFirstPrompt } from './dist/parser.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new Database(join(homedir(), '.momento', 'index.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const rows = db.prepare(`SELECT id, first_prompt, summary FROM sessions WHERE first_prompt IS NOT NULL`).all();
const updSess = db.prepare(`UPDATE sessions SET first_prompt = ? WHERE id = ?`);
const delFts = db.prepare(`DELETE FROM sessions_fts WHERE session_id = ?`);
const insFts = db.prepare(`INSERT INTO sessions_fts(session_id, summary, first_prompt) VALUES (?, ?, ?)`);

let changed = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    const cleaned = cleanFirstPrompt(r.first_prompt);
    if (cleaned !== r.first_prompt) {
      updSess.run(cleaned, r.id);
      delFts.run(r.id);
      insFts.run(r.id, r.summary ?? '', cleaned ?? '');
      changed++;
    }
  }
});
tx();
console.log(`migrated ${changed}/${rows.length} rows`);
db.close();
