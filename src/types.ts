import { z } from "zod";

const ContentBlockZ = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    thinking: z.string().optional(),
    // tool_use blocks carry `id`; the matching tool_result (in a later user message)
    // references it via `tool_use_id` and reports pass/fail through `is_error`.
    id: z.string().optional(),
    tool_use_id: z.string().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const UserMessageZ = z
  .object({
    type: z.literal("user"),
    uuid: z.string(),
    timestamp: z.string(),
    sessionId: z.string(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    message: z
      .object({
        role: z.string(),
        content: z.union([z.string(), z.array(ContentBlockZ)]),
      })
      .passthrough(),
  })
  .passthrough();

export const AssistantMessageZ = z
  .object({
    type: z.literal("assistant"),
    uuid: z.string(),
    timestamp: z.string(),
    sessionId: z.string(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.union([z.string(), z.array(ContentBlockZ)]),
      })
      .passthrough(),
  })
  .passthrough();

export const JsonlEntryZ = z.union([
  UserMessageZ,
  AssistantMessageZ,
  z.object({ type: z.string() }).passthrough(),
]);

export type UserMessage = z.infer<typeof UserMessageZ>;
export type AssistantMessage = z.infer<typeof AssistantMessageZ>;
export type ContentBlock = z.infer<typeof ContentBlockZ>;

export interface ParsedMessage {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface ToolCall {
  toolName: string;
  inputJson: string;
  timestamp: string;
  // Pass/fail from the tool_result joined by tool_use id: false = ok, true = error.
  // Left undefined when the source carries no result status (codex/gemini) — stored NULL,
  // NEVER 0, so an unknown outcome can't masquerade as success.
  isError?: boolean;
}

export interface FileTouch {
  filePath: string;
  operation: "read" | "write" | "edit";
  timestamp: string;
  source: "native" | "inferred";
}

export interface ExtractTextOptions {
  // Whether to include assistant `thinking` blocks. These often contain internal
  // deliberation the user never saw and can leak details that don't appear in
  // final output. Default: false.
  includeThinking?: boolean;
}

export function extractText(
  content: string | ContentBlock[],
  opts: ExtractTextOptions = {},
): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (
      opts.includeThinking &&
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      parts.push(block.thinking);
    }
  }
  return parts.join("\n");
}

export function extractToolUses(
  content: string | ContentBlock[],
): { id?: string; name: string; input: unknown }[] {
  if (typeof content === "string") return [];
  const out: { id?: string; name: string; input: unknown }[] = [];
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      out.push({ id: block.id, name: block.name, input: block.input ?? null });
    }
  }
  return out;
}

// tool_result blocks live in USER messages; each references the tool_use it answers
// (tool_use_id) and reports pass/fail via is_error. The parser joins these back to the
// tool_use recorded on the preceding assistant message to stamp per-call reliability.
export function extractToolResults(
  content: string | ContentBlock[],
): { toolUseId: string; isError: boolean }[] {
  if (typeof content === "string") return [];
  const out: { toolUseId: string; isError: boolean }[] = [];
  for (const block of content) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      out.push({ toolUseId: block.tool_use_id, isError: block.is_error === true });
    }
  }
  return out;
}
