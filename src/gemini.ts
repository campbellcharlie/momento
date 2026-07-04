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
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ParsedMessage, ToolCall, FileTouch } from "./types.js";
import type { SessionRef, ParsedSession, IndexedSessionMeta } from "./parser.js";
import { MomentoConfig, loadConfig, pathExcluded } from "./config.js";
import { inferShellFileTouches, extractShellCommand } from "./infer_touches.js";

// Gemini's structured file tools. Their `args.file_path` is absolute and the
// operation is as trustworthy as Claude's native tools, so these produce
// `source:"native"` touches. Exported so the conformance drift sentinel can pin
// the recognized set. `run_shell_command` is handled separately (inferred).
export const GEMINI_FILE_TOOL_OP: Record<string, "read" | "write" | "edit"> = {
  read_file: "read",
  write_file: "write",
  replace: "edit",
};

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  status?: string; // "success" | "error" | "cancelled"
  timestamp?: string;
}

interface GeminiMessage {
  id?: string;
  type?: string; // "user" | "gemini" | "info" | (future)
  content?: unknown;
  timestamp?: string;
  toolCalls?: GeminiToolCall[]; // present on `gemini`-type messages
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

// `config` drives path exclusion for the file-touches extracted from each
// `gemini` message's `toolCalls` array (see the message loop below).
export async function parseGeminiSession(
  jsonPath: string,
  config?: MomentoConfig,
): Promise<ParsedSession & { meta: IndexedSessionMeta }> {
  const cfg = config ?? loadConfig();
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
    const msgTs = m.timestamp ?? meta.modified ?? meta.created ?? "";
    const text = stringifyContent(m.content);
    if (text) {
      messages.push({
        uuid: m.id ?? `${jsonPath}:${messages.length}`,
        role,
        text,
        timestamp: msgTs,
      });
      if (role === "user" && firstUserPrompt === null) firstUserPrompt = text;
    }

    // `gemini`-type messages carry a populated `toolCalls` array with absolute
    // `file_path` args. Extract every call as a tool_call, then record file
    // activity: structured file tools → native; run_shell_command → inferred.
    if (t === "gemini" && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (!tc || typeof tc !== "object" || typeof tc.name !== "string") continue;
        const tcTs = tc.timestamp ?? msgTs;
        toolCalls.push({
          toolName: tc.name,
          inputJson: JSON.stringify(tc.args ?? null),
          timestamp: tcTs,
        });
        recordGeminiFileTouch(tc, tcTs, cfg, filesTouched);
        if (tc.name === "run_shell_command" && (!tc.status || tc.status === "success")) {
          const command = extractShellCommand(tc.args);
          if (command) recordInferredShellTouches(command, tcTs, cfg, filesTouched);
        }
      }
    }
  }

  if (firstUserPrompt) meta.firstPrompt = firstUserPrompt;
  meta.messageCount = messages.length;
  return { sessionId, messages, toolCalls, filesTouched, meta };
}

// Record a native file-touch from a structured Gemini file tool. Skips tool
// calls that didn't succeed so we only log edits that actually happened.
function recordGeminiFileTouch(
  tc: GeminiToolCall,
  timestamp: string,
  cfg: MomentoConfig,
  out: FileTouch[],
): void {
  if (tc.status && tc.status !== "success") return; // skip error/cancelled
  const op = GEMINI_FILE_TOOL_OP[tc.name ?? ""];
  if (!op) return;
  const p = tc.args?.file_path;
  if (typeof p !== "string" || !p) return;
  let canonical = p;
  try {
    canonical = realpathSync(p);
  } catch {
    /* file gone or unreadable; keep original */
  }
  if (pathExcluded(cfg, canonical)) return;
  out.push({ filePath: canonical, operation: op, timestamp, source: "native" });
}

// Shared wiring for inferred shell-command touches (mirrors codex.ts): only
// absolute targets are canonicalized; all stay `source:"inferred"`.
function recordInferredShellTouches(
  command: string,
  timestamp: string,
  cfg: MomentoConfig,
  out: FileTouch[],
): void {
  for (const ft of inferShellFileTouches(command, timestamp)) {
    let fp = ft.filePath;
    if (isAbsolute(fp)) {
      try {
        fp = realpathSync(fp);
      } catch {
        /* file gone; keep literal */
      }
    }
    if (pathExcluded(cfg, fp)) continue;
    out.push({ ...ft, filePath: fp });
  }
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
