// Codex CLI session parser. Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
//
// Each line is a JSON RolloutLine (post-PR #3380):
//   { "type": "session_meta", "payload": { id, cwd, timestamp, ... } }
//   { "type": "response_item", "payload": { type, role, content, ... } }
//   { "type": "event_msg",     "payload": { type, ... } }   ← skipped
//   { "type": "turn_context",  "payload": { ... } }         ← skipped
//
// Legacy rollouts (pre-PR #3380) emit bare ResponseItem/SessionMeta lines without
// the {type, payload} envelope. Both shapes are supported below.
//
// Schema reference: https://github.com/openai/codex (RolloutLine)

import { createReadStream, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { ParsedMessage, ToolCall, FileTouch } from "./types.js";
import type { SessionRef, ParsedSession, IndexedSessionMeta } from "./parser.js";
import { MomentoConfig, loadConfig, pathExcluded } from "./config.js";

// File path tools across the OpenAI CLI. The keys we know to extract are best-
// effort — Codex tools are user-configurable, so this list will drift. We index
// the standard built-ins and let everything else fall through.
const FILE_TOOL_OP: Record<string, "read" | "write" | "edit"> = {
  shell: "read", // ambiguous; tagged read so it's at least findable
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  apply_patch: "edit",
};

interface CodexEnvelope {
  type: string;
  payload?: unknown;
}

interface CodexSessionMeta {
  id?: string;
  cwd?: string;
  timestamp?: string;
  cli_version?: string;
  git?: { commit?: string; branch?: string };
}

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface CodexResponseItem {
  type?: string; // "message" | "function_call" | "function_call_output" | "reasoning"
  role?: string; // "user" | "assistant" | "system" (for type=message)
  content?: unknown;
  // function_call
  name?: string;
  arguments?: string;
  call_id?: string;
  // function_call_output
  output?: unknown;
  // reasoning
  summary?: unknown;
  encrypted_content?: string;
}

// Walk content blocks within a Codex `response_item.payload` of type "message"
// or "reasoning". Codex tags blocks `input_text` (user) or `output_text`
// (assistant); reasoning carries plain `text` blocks.
function extractTextFromBlocks(blocks: unknown, includeReasoning: boolean): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks as CodexContentBlock[]) {
    if (!b || typeof b !== "object") continue;
    const t = b.type;
    if (
      (t === "input_text" || t === "output_text" || t === "text") &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
    } else if (
      includeReasoning &&
      (t === "reasoning_text" || t === "summary_text") &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

// Walk a YYYY/MM/DD-partitioned codex sessions directory and yield refs. The
// projectDir slot is filled in at parse time from session_meta.cwd; until then
// we use the rollout's parent dir so callers have a usable string.
export async function* iterateCodexSessions(rootDir: string): AsyncGenerator<SessionRef> {
  let years: string[];
  try {
    years = await readdir(rootDir);
  } catch {
    return;
  }
  for (const y of years) {
    const yPath = join(rootDir, y);
    let months: string[];
    try {
      const st = await stat(yPath);
      if (!st.isDirectory()) continue;
      months = await readdir(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      const mPath = join(yPath, m);
      let days: string[];
      try {
        days = await readdir(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        const dPath = join(mPath, d);
        let files: string[];
        try {
          files = await readdir(dPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          // Codex filename is rollout-<timestamp>-<uuid>.jsonl. The session id
          // is the trailing UUID; pull it off cleanly so it matches what's in
          // session_meta.id.
          const trimmed = f.slice("rollout-".length, -".jsonl".length);
          const sessionId = extractSessionIdFromFilename(trimmed);
          yield { projectDir: dPath, sessionId, jsonlPath: join(dPath, f) };
        }
      }
    }
  }
}

function extractSessionIdFromFilename(stem: string): string {
  // Codex filenames look like "2025-11-26T19-01-53-019ac2d4-bdf8-7de3-b57e-7792f72f36a8".
  // The session_id (UUID v7) is the trailing 5 hex groups. If the shape is
  // unfamiliar we keep the whole stem — better than silently corrupting the id.
  const parts = stem.split("-");
  if (parts.length >= 8) return parts.slice(-5).join("-");
  return stem;
}

export async function parseCodexSession(
  jsonlPath: string,
  config?: MomentoConfig,
): Promise<ParsedSession & { meta: IndexedSessionMeta }> {
  const cfg = config ?? loadConfig();
  const messages: ParsedMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const filesTouched: FileTouch[] = [];
  let sessionId = "";
  const meta: IndexedSessionMeta = {};
  let firstUserPrompt: string | null = null;

  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  let lastTimestamp = "";

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

    // Unwrap the {type, payload} envelope when present. Pre-#3380 rollouts
    // ship bare ResponseItem/SessionMeta lines (no `.payload` key), so detect
    // by structure rather than by the value of `.type` alone.
    const env = json as CodexEnvelope;
    const isEnveloped = "payload" in env && env.payload !== undefined;
    const outerType = isEnveloped && typeof env.type === "string" ? env.type : null;
    const payload = isEnveloped ? env.payload : json;

    if (outerType === "session_meta" || (!isEnveloped && isSessionMeta(json))) {
      const sm = payload as CodexSessionMeta;
      if (typeof sm.id === "string" && !sessionId) sessionId = sm.id;
      if (typeof sm.cwd === "string") meta.projectPath = sm.cwd;
      if (typeof sm.timestamp === "string") {
        meta.created = sm.timestamp;
        lastTimestamp = sm.timestamp;
      }
      if (sm.git?.branch) meta.gitBranch = sm.git.branch;
      continue;
    }

    if (outerType === "response_item" || (!isEnveloped && isResponseItem(json))) {
      const ri = payload as CodexResponseItem;
      const innerType = typeof ri.type === "string" ? ri.type : "";
      // Codex doesn't stamp per-item timestamps; carry forward the latest
      // session-level timestamp we've seen.
      const ts = lastTimestamp;

      if (innerType === "message") {
        const role: "user" | "assistant" =
          ri.role === "user" ? "user" : "assistant";
        const text = extractTextFromBlocks(ri.content, false);
        if (text) {
          messages.push({
            uuid: `${jsonlPath}:${lineNum}`, // codex has no per-message uuid; use a stable synthetic one
            role,
            text,
            timestamp: ts,
          });
          if (role === "user" && firstUserPrompt === null) firstUserPrompt = text;
        }
      } else if (innerType === "reasoning" && cfg.indexThinking) {
        const text = extractTextFromBlocks(ri.content, true);
        if (text) {
          messages.push({
            uuid: `${jsonlPath}:${lineNum}`,
            role: "assistant",
            text,
            timestamp: ts,
          });
        }
      } else if (innerType === "function_call") {
        const name = typeof ri.name === "string" ? ri.name : "(unknown)";
        const argsJson =
          typeof ri.arguments === "string" ? ri.arguments : JSON.stringify(ri.arguments ?? null);
        toolCalls.push({ toolName: name, inputJson: argsJson, timestamp: ts });
        recordFileTouch(name, argsJson, ts, cfg, filesTouched);
      }
      // function_call_output is informational; we already emitted the call.
      continue;
    }
    // event_msg, turn_context, and unknown types are ignored — they don't
    // contribute durable session content.
  }

  if (firstUserPrompt) meta.firstPrompt = firstUserPrompt;
  meta.messageCount = messages.length;
  if (messages.length > 0) {
    const last = messages[messages.length - 1].timestamp;
    if (last) meta.modified = last;
  }

  return { sessionId, messages, toolCalls, filesTouched, meta };
}

function isSessionMeta(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.cwd === "string";
}

function isResponseItem(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.type === "string" && (r.type === "message" || r.type === "function_call" || r.type === "function_call_output" || r.type === "reasoning");
}

function recordFileTouch(
  toolName: string,
  argsJson: string,
  timestamp: string,
  cfg: MomentoConfig,
  out: FileTouch[],
): void {
  const op = FILE_TOOL_OP[toolName];
  if (!op) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const args = parsed as Record<string, unknown>;
  // Codex tools commonly use `path`, `file_path`, or `target_file` for the
  // operand. Try each in order; whichever resolves first wins.
  const candidate =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.target_file === "string" && args.target_file) ||
    null;
  if (!candidate) return;
  let canonical = candidate;
  try {
    canonical = realpathSync(candidate);
  } catch {
    /* file gone or unreadable; keep original */
  }
  if (pathExcluded(cfg, canonical)) return;
  out.push({ filePath: canonical, operation: op, timestamp });
}
