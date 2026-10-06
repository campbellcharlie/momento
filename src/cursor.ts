// Cursor IDE + cursor-agent (CLI) session parser.
//
// Both clients write the same layout under `~/.cursor/projects`:
//   <encoded-workspace>/agent-transcripts/<uuid>/<uuid>.jsonl
//
// Encoding (from agent-cli): non-alnum → `-`, collapse runs, trim edges.
// The real workspace path is usually recorded in a sibling
// `.workspace-trusted` JSON (`workspacePath`); when missing we fall back to
// absolute paths seen in tool inputs / Shell `working_directory`.
//
// Each JSONL line is either:
//   { "role": "user"|"assistant", "message": { "content": ContentBlock[] } }
//   { "type": "turn_ended", "status": ... }   ← skipped
//
// Content blocks: `{type:"text", text}` or `{type:"tool_use", name, input}`.
// Tool results are not persisted in these transcripts — file touches come
// only from tool_use inputs (Read/Write/StrReplace/Delete/Shell).

import { createReadStream, realpathSync, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";
import type { ParsedMessage, ToolCall, FileTouch } from "./types.js";
import type { SessionRef, ParsedSession, IndexedSessionMeta } from "./parser.js";
import { MomentoConfig, loadConfig, pathExcluded } from "./config.js";
import { inferShellFileTouches } from "./infer_touches.js";

// Cursor / cursor-agent native file tools. `path` is the operand (not Claude's
// `file_path`). Exported for the conformance drift sentinel.
export const CURSOR_FILE_TOOL_OP: Record<string, "read" | "write" | "edit"> = {
  Read: "read",
  Write: "write",
  StrReplace: "edit",
  Delete: "edit",
  // Older / alternate names seen in some builds
  Edit: "edit",
  MultiEdit: "edit",
};

interface CursorContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown> | null;
  id?: string;
}

interface CursorLine {
  role?: string;
  message?: { content?: unknown };
  type?: string;
  status?: string;
}

export async function* iterateCursorSessions(rootDir: string): AsyncGenerator<SessionRef> {
  // rootDir = ~/.cursor/projects
  let projectDirs: string[];
  try {
    projectDirs = await readdir(rootDir);
  } catch {
    return;
  }
  for (const name of projectDirs) {
    if (name.startsWith(".")) continue;
    const projectDir = join(rootDir, name);
    const transcriptsRoot = join(projectDir, "agent-transcripts");
    let sessionDirs: string[];
    try {
      const st = await stat(transcriptsRoot);
      if (!st.isDirectory()) continue;
      sessionDirs = await readdir(transcriptsRoot);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      const sessionDir = join(transcriptsRoot, sessionId);
      let st;
      try {
        st = await stat(sessionDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
      if (!existsSync(jsonlPath)) {
        // Tolerate a lone .jsonl whose basename differs from the dir.
        let files: string[];
        try {
          files = await readdir(sessionDir);
        } catch {
          continue;
        }
        const alt = files.find((f) => f.endsWith(".jsonl"));
        if (!alt) continue;
        yield {
          projectDir,
          sessionId: alt.slice(0, -".jsonl".length),
          jsonlPath: join(sessionDir, alt),
        };
        continue;
      }
      yield { projectDir, sessionId, jsonlPath };
    }
  }
}

function readWorkspacePath(projectDir: string): string | undefined {
  const trustPath = join(projectDir, ".workspace-trusted");
  try {
    const raw = readFileSync(trustPath, "utf8");
    const json = JSON.parse(raw) as { workspacePath?: unknown };
    if (typeof json.workspacePath === "string" && json.workspacePath) {
      return json.workspacePath;
    }
  } catch {
    /* missing / unreadable — fall through */
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as CursorContentBlock[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function extractToolUses(content: unknown): CursorContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: CursorContentBlock[] = [];
  for (const b of content as CursorContentBlock[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use" && typeof b.name === "string") out.push(b);
  }
  return out;
}

function pathFromInput(input: Record<string, unknown> | null | undefined): string | null {
  if (!input || typeof input !== "object") return null;
  for (const key of ["path", "file_path", "target_file"] as const) {
    const v = input[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function canonicalizePath(fp: string): string {
  try {
    return realpathSync(fp);
  } catch {
    return fp;
  }
}

export async function parseCursorSession(
  jsonlPath: string,
  config?: MomentoConfig,
): Promise<ParsedSession & { meta: IndexedSessionMeta }> {
  const cfg = config ?? loadConfig();
  const messages: ParsedMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const filesTouched: FileTouch[] = [];
  const meta: IndexedSessionMeta = {};

  // projectDir = ~/.cursor/projects/<encoded>
  const sessionDir = dirname(jsonlPath);
  const transcriptsRoot = dirname(sessionDir);
  const projectDir = dirname(transcriptsRoot);
  const sessionIdFromPath = sessionDir.split(/[/\\]/).pop() ?? "";

  let workspace = readWorkspacePath(projectDir);
  let firstUserPrompt: string | null = null;
  let inferredCwd: string | null = null;
  let lineNum = 0;
  // mtime fallback — Cursor lines carry no timestamps.
  let fileMtimeIso = "";
  try {
    const st = await stat(jsonlPath);
    fileMtimeIso = st.mtime.toISOString();
    meta.modified = fileMtimeIso;
    meta.created = st.birthtime?.toISOString?.() || fileMtimeIso;
  } catch {
    /* ignore */
  }

  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    lineNum++;
    if (!raw.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`momento: parse error ${jsonlPath}:${lineNum}: ${(err as Error).message}\n`);
      continue;
    }
    if (!json || typeof json !== "object") continue;
    const line = json as CursorLine;
    // Lifecycle markers (turn_ended, etc.) — no content.
    if (!line.role) continue;
    if (line.role !== "user" && line.role !== "assistant") continue;

    const content = line.message?.content;
    const ts = fileMtimeIso;
    const text = extractText(content);
    if (text) {
      messages.push({
        uuid: `${jsonlPath}:${lineNum}`,
        role: line.role,
        text,
        timestamp: ts,
      });
      if (line.role === "user" && firstUserPrompt === null) firstUserPrompt = text;
    }

    if (line.role !== "assistant") continue;
    for (const tu of extractToolUses(content)) {
      const name = tu.name ?? "(unknown)";
      const input = tu.input ?? null;
      const inputJson = JSON.stringify(input);
      toolCalls.push({ toolName: name, inputJson, timestamp: ts });

      if (!inferredCwd && input && typeof input.working_directory === "string" && input.working_directory) {
        inferredCwd = input.working_directory;
      }

      const op = CURSOR_FILE_TOOL_OP[name];
      if (op) {
        const fp = pathFromInput(input);
        if (fp) {
          const canonical = canonicalizePath(fp);
          if (!pathExcluded(cfg, canonical)) {
            filesTouched.push({
              filePath: canonical,
              operation: op,
              timestamp: ts,
              source: "native",
            });
          }
        }
      }

      if (name === "Shell" && input && typeof input.command === "string") {
        for (const ft of inferShellFileTouches(input.command, ts)) {
          let fp = ft.filePath;
          if (isAbsolute(fp)) fp = canonicalizePath(fp);
          if (pathExcluded(cfg, fp)) continue;
          filesTouched.push({ ...ft, filePath: fp });
        }
      }
    }
  }

  if (!workspace && inferredCwd) workspace = inferredCwd;
  if (workspace) {
    meta.projectPath = canonicalizePath(workspace);
  }
  if (firstUserPrompt) meta.firstPrompt = firstUserPrompt;
  meta.messageCount = messages.length;

  return {
    sessionId: sessionIdFromPath,
    messages,
    toolCalls,
    filesTouched,
    meta,
  };
}
