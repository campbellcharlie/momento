// Response budget for momento's MCP tool results.
//
// momento is on the recall-first hot path (queried before every non-trivial task), so an uncapped
// result dump floods the caller's context — the exact failure this tool exists to avoid. We cap the
// serialized result, mark any truncation EXPLICITLY (never silent), and steer empty hit-lists toward
// a narrower query instead of returning a bare "[]".
export const MAX_RESULT_CHARS = 20000;

export function formatToolResult(name: string, result: unknown): string {
  if (Array.isArray(result) && result.length === 0) {
    return `[]\n\nNo results for "${name}". Retry with rarer, more specific terms — project codenames, hostnames, error strings, library names (broad terms rank poorly under BM25). If a project_path filter is set, drop it and retry.`;
  }
  const text = JSON.stringify(result, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  const omitted = text.length - MAX_RESULT_CHARS;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…[TRUNCATED: "${name}" returned ${text.length} chars; showing first ${MAX_RESULT_CHARS} (${omitted} omitted). This result is incomplete — narrow the query or lower 'limit' to get a complete, parseable response.]`;
}
