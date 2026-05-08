#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { findSimilar } from "./queries.js";

const DB_PATH = join(homedir(), ".momento", "index.db");
const TIMEOUT_MS = 200;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return process.argv.slice(2).join(" ");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) return;
  const raw = (await readStdin()).trim();
  if (!raw) return;
  let prompt = raw;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      const o = j as { prompt?: unknown; user_prompt?: unknown };
      if (typeof o.user_prompt === "string") prompt = o.user_prompt;
      else if (typeof o.prompt === "string") prompt = o.prompt;
    }
  } catch {
    /* plain string */
  }
  if (!prompt) return;

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 50");
  try {
    const hits = findSimilar(db, prompt, 3);
    if (hits.length === 0) return;
    const lines: string[] = ["<!-- momento: relevant past sessions -->"];
    for (const h of hits) {
      const name = basename(h.projectPath || "");
      const date = (h.modified ?? "").slice(0, 10);
      const summary = (h.summary ?? h.firstPrompt ?? "(no summary)").replace(/\s+/g, " ").slice(0, 120);
      lines.push(`- [${name}] ${summary} (${date}) - ${h.id}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    db.close();
  }
}

const timer = setTimeout(() => process.exit(0), TIMEOUT_MS);
timer.unref();

main()
  .catch(() => {
    /* never block the user */
  })
  .finally(() => {
    clearTimeout(timer);
  });
