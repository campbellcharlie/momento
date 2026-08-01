import { createReadStream, realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";
import { inferShellFileTouches } from "./infer_touches.js";
import {
  JsonlEntryZ,
  ParsedMessage,
  ToolCall,
  FileTouch,
  extractText,
  extractToolUses,
  extractToolResults,
  UserMessageZ,
  AssistantMessageZ,
} from "./types.js";
import { MomentoConfig, loadConfig, pathExcluded } from "./config.js";

export interface SessionRef {
  projectDir: string;
  sessionId: string;
  jsonlPath: string;
}

export interface ParsedSession {
  sessionId: string;
  messages: ParsedMessage[];
  toolCalls: ToolCall[];
  filesTouched: FileTouch[];
}

export interface IndexedSessionMeta {
  summary?: string;
  firstPrompt?: string;
  gitBranch?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  projectPath?: string;
}

// Exported so the conformance drift sentinel can assert the exact set of tool
// names this parser recognizes as native file ops — an upstream rename fails a
// test instead of silently dropping touches.
export const FILE_TOOL_OP: Record<string, "read" | "write" | "edit"> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
};

const PREFIX_PATTERNS: RegExp[] = [
  /^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i,
  /^<command-(name|message|args)>[\s\S]*?<\/command-\1>\s*/gi,
  /^PREVIOUS AI RESPONSE \([^)]*\):\s*/i,
  /^RECENT CONVERSATION:\s*/i,
  /^CONTEXT:\s*/i,
  /^TASK:\s*(TASK:\s*)?/i,
  /^STATE:\s*/i,
  /^CURRENT MESSAGE:\s*/i,
];

export function cleanFirstPrompt(text: string | undefined | null): string | null {
  if (!text) return null;
  let out = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PREFIX_PATTERNS) {
      const next = out.replace(re, "");
      if (next !== out) {
        out = next.trim();
        changed = true;
      }
    }
  }
  return out.slice(0, 500) || null;
}

export async function* iterateSessions(rootDir: string): AsyncGenerator<SessionRef> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(rootDir);
  } catch {
    return;
  }
  for (const name of projectDirs) {
    const projectDir = join(rootDir, name);
    let st;
    try {
      st = await stat(projectDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = f.slice(0, -".jsonl".length);
      yield { projectDir, sessionId, jsonlPath: join(projectDir, f) };
    }
  }
}

export async function parseSession(
  jsonlPath: string,
  config?: MomentoConfig,
): Promise<ParsedSession & { meta?: IndexedSessionMeta }> {
  const cfg = config ?? loadConfig();
  const messages: ParsedMessage[] = [];
  const toolCalls: ToolCall[] = [];
  // tool_use id → its ToolCall, so a tool_result in a later user message can stamp is_error
  // onto the call the assistant already recorded (they live in different transcript lines).
  const toolById = new Map<string, ToolCall>();
  const filesTouched: FileTouch[] = [];
  let sessionId = "";
  // Capture the first cwd we see. Claude Code stores sessions under
  // ~/.claude/projects/<encoded-launch-dir>/<uuid>.jsonl — the encoded dir
  // round-trips poorly (it's lossy hyphen-collapsed and ignores symlinks).
  // Every JSONL entry carries the real cwd; the first one is authoritative.
  // Used to override projectPath downstream so repoRootForPath and
  // get_recent_by_edited_path see real filesystem paths instead of encoded
  // launch dirs.
  let cwd: string | undefined;

  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
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
    const parsed = JsonlEntryZ.safeParse(json);
    if (!parsed.success) continue;
    const entry = parsed.data as { type: string; sessionId?: string; cwd?: string };
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (!cwd && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;

    if (entry.type === "user") {
      const u = UserMessageZ.safeParse(json);
      if (!u.success) continue;
      // User content never carries `thinking` blocks today, but pass the flag
      // through so behavior is uniform if that changes.
      const text = extractText(u.data.message.content, { includeThinking: cfg.indexThinking });
      if (text) {
        messages.push({ uuid: u.data.uuid, role: "user", text, timestamp: u.data.timestamp });
      }
      // Stamp pass/fail onto the tool_use these results answer. Direct assignment (not only
      // on error) so a known-successful call stores is_error = 0, not NULL — only calls that
      // never received a result stay unknown.
      for (const tr of extractToolResults(u.data.message.content)) {
        const call = toolById.get(tr.toolUseId);
        if (call) call.isError = tr.isError;
      }
    } else if (entry.type === "assistant") {
      const a = AssistantMessageZ.safeParse(json);
      if (!a.success) continue;
      const text = extractText(a.data.message.content, { includeThinking: cfg.indexThinking });
      if (text) {
        messages.push({ uuid: a.data.uuid, role: "assistant", text, timestamp: a.data.timestamp });
      }
      for (const tu of extractToolUses(a.data.message.content)) {
        const call: ToolCall = {
          toolName: tu.name,
          inputJson: JSON.stringify(tu.input ?? null),
          timestamp: a.data.timestamp,
        };
        toolCalls.push(call);
        if (tu.id) toolById.set(tu.id, call);
        const op = FILE_TOOL_OP[tu.name];
        if (op) {
          const fp = (tu.input as { file_path?: string } | null)?.file_path;
          if (typeof fp === "string" && fp) {
            // Resolve symlinks so the same repo doesn't get indexed under two prefixes
            // (e.g. ~/src -> /abs/path/src). Falls back to the raw path
            // if the file no longer exists.
            let canonical = fp;
            try {
              canonical = realpathSync(fp);
            } catch {
              /* file gone or unreadable; keep original */
            }
            if (pathExcluded(cfg, canonical)) continue;
            filesTouched.push({
              filePath: canonical,
              operation: op,
              timestamp: a.data.timestamp,
              source: "native",
            });
          }
        }
        // Bash commands write files via redirects (`>`, `tee`, `sed -i`, ...)
        // that leave no structured file-tool call. Infer those targets and tag
        // them `inferred` so they enrich files_touched without polluting the
        // native path-views.
        if (tu.name === "Bash") {
          const command = (tu.input as { command?: string } | null)?.command;
          if (typeof command === "string") {
            for (const ft of inferShellFileTouches(command, a.data.timestamp)) {
              let fp = ft.filePath;
              if (isAbsolute(fp)) {
                try {
                  fp = realpathSync(fp);
                } catch {
                  /* file gone; keep literal */
                }
              }
              if (pathExcluded(cfg, fp)) continue;
              filesTouched.push({ ...ft, filePath: fp });
            }
          }
        }
      }
    }
  }

  // Canonicalize the captured cwd so symlinked roots collapse to the same
  // project_path across sessions (e.g. ~/src -> /abs/path/src).
  // Falls back silently if the path is gone — the encoded projectDir will
  // be used as the project_path instead in indexer.
  let resolvedCwd: string | undefined;
  if (cwd) {
    try {
      resolvedCwd = realpathSync(cwd);
    } catch {
      resolvedCwd = cwd;
    }
  }
  const meta: IndexedSessionMeta | undefined = resolvedCwd
    ? { projectPath: resolvedCwd }
    : undefined;
  return { sessionId, messages, toolCalls, filesTouched, meta };
}

export async function readSessionsIndex(
  projectDir: string,
): Promise<Map<string, IndexedSessionMeta>> {
  const out = new Map<string, IndexedSessionMeta>();
  const path = join(projectDir, "sessions-index.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return out;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return out;
  }
  const entries = (json as { entries?: unknown[] } | null)?.entries;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const sid = typeof o.sessionId === "string" ? o.sessionId : null;
    if (!sid) continue;
    out.set(sid, {
      summary: typeof o.summary === "string" ? o.summary : undefined,
      firstPrompt: typeof o.firstPrompt === "string" ? o.firstPrompt : undefined,
      gitBranch: typeof o.gitBranch === "string" ? o.gitBranch : undefined,
      messageCount: typeof o.messageCount === "number" ? o.messageCount : undefined,
      created: typeof o.created === "string" ? o.created : undefined,
      modified: typeof o.modified === "string" ? o.modified : undefined,
      projectPath: typeof o.projectPath === "string" ? o.projectPath : undefined,
    });
  }
  return out;
}
