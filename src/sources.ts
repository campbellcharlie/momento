// Multi-client source registry. Each `Source` knows where its CLI stores
// transcripts on disk, how to walk that layout, and how to turn one session
// file into a normalized `ParsedSession`.
//
// Adding a new client means: write a parser module, add an entry here, and
// teach the extension filter (in indexer.watchSources) about its
// file extension.

import { homedir } from "node:os";
import { join } from "node:path";
import type { MomentoConfig } from "./config.js";
import type { SessionRef, ParsedSession, IndexedSessionMeta } from "./parser.js";
import { iterateSessions, parseSession, readSessionsIndex } from "./parser.js";
import { iterateCodexSessions, parseCodexSession } from "./codex.js";
import { iterateGeminiSessions, parseGeminiSession } from "./gemini.js";
import { loadJobSummaries } from "./jobs.js";

export type ClientName = "claude_code" | "codex" | "gemini" | "halo";

export interface ParsedSessionWithMeta extends ParsedSession {
  // Optional metadata derived by the parser itself (set by Codex/Gemini, where
  // session id, cwd, and timestamps live inside the file). Claude Code reads
  // its metadata from a sibling `sessions-index.json` instead — see
  // resolveClaudeMeta below.
  meta?: IndexedSessionMeta;
}

export interface Source {
  client: ClientName;
  root: string;
  fileExt: string; // watcher extension filter + session-id derivation
  iterate(root: string): AsyncGenerator<SessionRef>;
  parse(jsonlPath: string, config?: MomentoConfig): Promise<ParsedSessionWithMeta>;
  // Per-client metadata resolver. Claude reads sessions-index.json sidecars;
  // Codex/Gemini already populate meta on the parser return value.
  resolveMeta?(
    sessionId: string,
    projectDir: string,
    sessionsIndexCache: Map<string, Map<string, IndexedSessionMeta>>,
  ): Promise<IndexedSessionMeta>;
}

export function defaultSources(home: string = homedir()): Source[] {
  return [
    {
      client: "claude_code",
      root: join(home, ".claude", "projects"),
      fileExt: ".jsonl",
      iterate: iterateSessions,
      parse: parseSession,
      resolveMeta: async (sessionId, projectDir, cache) => {
        let meta = cache.get(projectDir);
        if (!meta) {
          meta = await readSessionsIndex(projectDir);
          cache.set(projectDir, meta);
        }
        const base = meta.get(sessionId) ?? {};
        // Background-job sidecar: if this session is a bg job, its state.json intent/name/result is a
        // truer headline than the transcript-derived one — overlay firstPrompt/summary/projectPath.
        const job = loadJobSummaries().get(sessionId);
        return job ? { ...base, ...job } : base;
      },
    },
    {
      client: "codex",
      root: join(home, ".codex", "sessions"),
      fileExt: ".jsonl",
      iterate: iterateCodexSessions,
      parse: parseCodexSession,
    },
    {
      // Halo harness writes Claude-Code-shape JSONL to ~/.halo/sessions/<project>/<id>.jsonl,
      // so it reuses the Claude parser. No sessions-index sidecar (meta stays default).
      client: "halo",
      root: join(home, ".halo", "sessions"),
      fileExt: ".jsonl",
      iterate: iterateSessions,
      parse: parseSession,
    },
    {
      client: "gemini",
      // ~/.gemini/tmp holds <projectHash>/chats/session-*.json. The parser climbs
      // up to ~/.gemini to find projects.json for hash → path resolution.
      root: join(home, ".gemini", "tmp"),
      fileExt: ".json",
      iterate: iterateGeminiSessions,
      parse: parseGeminiSession,
    },
  ];
}
