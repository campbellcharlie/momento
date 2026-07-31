// Background-job summaries. Each `~/.claude/jobs/<id>/state.json` carries the job's original ask
// (`intent`), a human `name`, final `state`, a structured `output` ({result}), and the `sessionId`
// of the transcript momento already indexes under ~/.claude/projects. We surface these as session
// metadata — firstPrompt = intent, summary = "[state] name — result" — keyed by that sessionId, so
// a background job's ask+outcome is recallable even though the raw transcript has no clean headline.
// Optional & additive: no jobs dir → empty map, nothing changes.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IndexedSessionMeta } from "./parser.js";

// The subset of IndexedSessionMeta a job's state.json can supply.
export type JobSummary = Pick<IndexedSessionMeta, "firstPrompt" | "summary" | "projectPath">;

function jobsRoot(home: string): string {
  return join(home, ".claude", "jobs");
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
// state.json `output` is normally { result: "…" }; fall back to a raw string or "".
function resultOf(output: unknown): string {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const r = (output as Record<string, unknown>).result;
    if (typeof r === "string") return r;
  }
  return typeof output === "string" ? output : "";
}

let cache: { home: string; map: Map<string, JobSummary> } | null = null;

// sessionId → JobSummary for every job whose state.json yields a usable headline. Memoized per home
// (a full rebuild reads state.json once); `_clearJobSummariesCache` is the test seam.
export function loadJobSummaries(home: string = homedir()): Map<string, JobSummary> {
  if (cache && cache.home === home) return cache.map;
  const map = new Map<string, JobSummary>();
  let ids: string[];
  try {
    ids = readdirSync(jobsRoot(home));
  } catch {
    cache = { home, map };
    return map; // no ~/.claude/jobs — nothing to add
  }
  for (const id of ids) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(readFileSync(join(jobsRoot(home), id, "state.json"), "utf8"));
    } catch {
      continue; // no state.json / unreadable — skip this job
    }
    const sid = str(d.sessionId).trim();
    if (!sid) continue;
    const intent = str(d.intent).trim();
    const name = str(d.name).trim();
    const state = str(d.state).trim();
    const result = resultOf(d.output).trim();
    const headline = [name, result].filter(Boolean).join(" — ");
    const summary = headline ? (state ? `[${state}] ${headline}` : headline) : "";
    const s: JobSummary = {};
    if (intent) s.firstPrompt = intent;
    if (summary) s.summary = summary;
    const cwd = str(d.cwd).trim();
    if (cwd) s.projectPath = cwd;
    if (s.firstPrompt || s.summary) map.set(sid, s);
  }
  cache = { home, map };
  return map;
}

// Drop the memoized map — used by probes/tests that build against a temp home.
export function _clearJobSummariesCache(): void {
  cache = null;
}
