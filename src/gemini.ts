// Gemini CLI session parser. Reads `~/.gemini/tmp/<projectHash>/chats/session-*.json`.
//
// Each session file is a single JSON object — not JSONL — with shape:
//   { sessionId, projectHash, startTime, lastUpdated, messages: [
//     { id, type: "user"|"gemini"|"info", content, timestamp } ] }
//
// projectHash is plain `sha256(absolute_project_path)`. We reverse-resolve it
// via `~/.gemini/projects.json`, which records the registered project paths.
// Sessions whose hash isn't in the map fall back to using the hash as the
// project_path so they're still queryable, just under an opaque key.
//
// Schema reference: https://geminicli.com/docs/cli/session-management/

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedMessage, ToolCall, FileTouch } from "./types.js";
import type { SessionRef, ParsedSession, IndexedSessionMeta } from "./parser.js";
import type { MomentoConfig } from "./config.js";

interface GeminiMessage {
  id?: string;
  type?: string; // "user" | "gemini" | "info" | (future)
  content?: unknown;
  timestamp?: string;
}

interface GeminiSessionFile {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

// Hash → absolute project path. Built lazily on first parse so we don't pay
// for the file read when nothing's being indexed.
let projectHashMap: Map<string, string> | null = null;

async function loadProjectHashMap(geminiDir: string): Promise<Map<string, string>> {
  if (projectHashMap) return projectHashMap;
  const map = new Map<string, string>();
  try {
    const raw = await readFile(join(geminiDir, "projects.json"), "utf8");
    const json = JSON.parse(raw) as { projects?: Record<string, unknown> };
    const projects = json.projects ?? {};
    for (const path of Object.keys(projects)) {
      const hash = createHash("sha256").update(path).digest("hex");
      map.set(hash, path);
    }
  } catch {
    /* missing or unreadable projects.json — sessions will resolve under hash */
  }
  projectHashMap = map;
  return map;
}

// Reset the in-process cache. Useful for tests and after a `--rebuild` so we
// pick up newly-registered Gemini projects without restarting the server.
export function resetGeminiProjectMap(): void {
  projectHashMap = null;
}

export async function* iterateGeminiSessions(rootDir: string): AsyncGenerator<SessionRef> {
  // rootDir = ~/.gemini/tmp; subdirs are projectHash dirs each containing chats/.
  let hashes: string[];
  try {
    hashes = await readdir(rootDir);
  } catch {
    return;
  }
  for (const hash of hashes) {
    const projectDir = join(rootDir, hash);
    const chatsDir = join(projectDir, "chats");
    let files: string[];
    try {
      const st = await stat(chatsDir);
      if (!st.isDirectory()) continue;
      files = await readdir(chatsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      // Filename: session-<iso-date>-<short_id>.json. Use short_id as the
      // session id; if absent (malformed), fall back to the whole filename.
      const stem = f.slice("session-".length, -".json".length);
      const sessionId = stem.split("-").pop() ?? stem;
      yield { projectDir, sessionId, jsonlPath: join(chatsDir, f) };
    }
  }
}

// `config` is accepted for parity with the other client parsers; Gemini has no
// per-message config knobs today (no thinking blocks, no exclusion-eligible
// file paths in messages), so it's currently unused.
export async function parseGeminiSession(
  jsonPath: string,
  _config?: MomentoConfig,
): Promise<ParsedSession & { meta: IndexedSessionMeta }> {
  const messages: ParsedMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const filesTouched: FileTouch[] = [];
  const meta: IndexedSessionMeta = {};

  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch (err) {
    process.stderr.write(`momento: read failed ${jsonPath}: ${(err as Error).message}\n`);
    return { sessionId: "", messages, toolCalls, filesTouched, meta };
  }

  let parsed: GeminiSessionFile;
  try {
    parsed = JSON.parse(raw) as GeminiSessionFile;
  } catch (err) {
    process.stderr.write(`momento: parse error ${jsonPath}: ${(err as Error).message}\n`);
    return { sessionId: "", messages, toolCalls, filesTouched, meta };
  }

  const sessionId = parsed.sessionId ?? "";
  if (parsed.startTime) meta.created = parsed.startTime;
  if (parsed.lastUpdated) meta.modified = parsed.lastUpdated;

  // Resolve projectHash → real path via projects.json. The Gemini config dir
  // is the parent of the rollup of session files (path/.../<hash>/chats/<file>).
  // Climb up to ~/.gemini and load the map.
  const { dirname } = await import("node:path");
  const chatsDir = dirname(jsonPath);
  const hashDir = dirname(chatsDir);
  const tmpDir = dirname(hashDir);
  const geminiDir = dirname(tmpDir);
  if (parsed.projectHash) {
    const map = await loadProjectHashMap(geminiDir);
    meta.projectPath = map.get(parsed.projectHash) ?? parsed.projectHash;
  }

  let firstUserPrompt: string | null = null;
  for (const m of parsed.messages ?? []) {
    if (!m || typeof m !== "object") continue;
    const t = m.type;
    if (t !== "user" && t !== "gemini") continue; // skip "info" and unknown types
    const role: "user" | "assistant" = t === "user" ? "user" : "assistant";
    const text = stringifyContent(m.content);
    if (!text) continue;
    messages.push({
      uuid: m.id ?? `${jsonPath}:${messages.length}`,
      role,
      text,
      timestamp: m.timestamp ?? meta.modified ?? meta.created ?? "",
    });
    if (role === "user" && firstUserPrompt === null) firstUserPrompt = text;
  }

  if (firstUserPrompt) meta.firstPrompt = firstUserPrompt;
  meta.messageCount = messages.length;
  return { sessionId, messages, toolCalls, filesTouched, meta };
}

// Gemini messages have observed `content` as plain strings. Be defensive: if a
// future Gemini build emits structured blocks, stringify them rather than drop
// silently. Returns "" when there's nothing extractable.
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object" && "text" in (block as object)) {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") {
    const t = (content as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}
