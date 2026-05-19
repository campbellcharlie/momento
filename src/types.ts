import { z } from "zod";

const ContentBlockZ = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    thinking: z.string().optional(),
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
): { name: string; input: unknown }[] {
  if (typeof content === "string") return [];
  const out: { name: string; input: unknown }[] = [];
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      out.push({ name: block.name, input: block.input ?? null });
    }
  }
  return out;
}
