// Deterministic turn classifier — ports the rule set from
// github.com/AgentSeal/codeburn (src/classifier.ts, MIT) with momento-shaped
// inputs. Zero LLM calls; tool presence is primary signal, user-message
// keywords are secondary refinement. Same first-match-wins tiebreak that
// codeburn evolved for the "add error handling" -> debugging vs feature case
// (see countRetries / firstMatchingCategory upstream).
//
// Adaptations from codeburn:
//   - ParsedTurn collapsed to a flat (userMessage, tools, ...) shape — momento
//     doesn't track per-API-call cost layering.
//   - hasPlanMode / hasAgentSpawn derived from tool names instead of from
//     attachment metadata (Claude Code emits ExitPlanMode and Agent/Task tool
//     uses directly).
//   - Skills detection looks for Skill tool calls, matching codeburn.
//
// We don't port the retry counter or the subCategory channel — momento only
// needs the category enum for now.

export type TurnCategory =
  | "coding"
  | "debugging"
  | "feature"
  | "refactoring"
  | "testing"
  | "exploration"
  | "planning"
  | "delegation"
  | "git"
  | "build/deploy"
  | "conversation"
  | "brainstorming"
  | "general";

export const ALL_CATEGORIES: readonly TurnCategory[] = [
  "coding", "debugging", "feature", "refactoring", "testing", "exploration",
  "planning", "delegation", "git", "build/deploy", "conversation",
  "brainstorming", "general",
] as const;

export interface Turn {
  // The full user message text. Used for the keyword refinement pass.
  userMessage: string;
  // Tool names invoked by the assistant during this turn, in order.
  tools: string[];
  // Bash commands extracted from Bash tool calls (concatenated for keyword
  // scanning). Empty for non-Bash turns.
  bashCommands: string[];
  // Timestamp of the assistant response that closed this turn (used for the
  // turn_categories row).
  timestamp: string;
}

const TEST_PATTERNS =
  /\b(test|pytest|vitest|jest|mocha|spec|coverage|npm\s+test|npx\s+vitest|npx\s+jest)\b/i;
const GIT_PATTERNS =
  /\bgit\s+(push|pull|commit|merge|rebase|checkout|branch|stash|log|diff|status|add|reset|cherry-pick|tag)\b/i;
const BUILD_PATTERNS =
  /\b(npm\s+run\s+build|npm\s+publish|pip\s+install|docker|deploy|make\s+build|npm\s+run\s+dev|npm\s+start|pm2|systemctl|brew|cargo\s+build)\b/i;
const INSTALL_PATTERNS =
  /\b(npm\s+install|pip\s+install|brew\s+install|apt\s+install|cargo\s+add)\b/i;

const DEBUG_KEYWORDS =
  /\b(fix|bug|error|broken|failing|crash|issue|debug|traceback|exception|stack\s*trace|not\s+working|wrong|unexpected|status\s+code|404|500|401|403)\b/i;
const FEATURE_KEYWORDS =
  /\b(add|create|implement|new|build|feature|introduce|set\s*up|scaffold|generate|make\s+(?:a|me|the)|write\s+(?:a|me|the))\b/i;
const REFACTOR_KEYWORDS =
  /\b(refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|move|migrate|split)\b/i;
const BRAINSTORM_KEYWORDS =
  /\b(brainstorm|idea|what\s+if|explore|think\s+about|approach|strategy|design|consider|how\s+should|what\s+would|opinion|suggest|recommend)\b/i;
const RESEARCH_KEYWORDS =
  /\b(research|investigate|look\s+into|find\s+out|check|search|analyze|review|understand|explain|how\s+does|what\s+is|show\s+me|list|compare)\b/i;

const FILE_PATTERNS =
  /\.(py|js|ts|tsx|jsx|json|yaml|yml|toml|sql|sh|go|rs|java|rb|php|css|html|md|csv|xml)\b/i;
const SCRIPT_PATTERNS =
  /\b(run\s+\S+\.\w+|execute|scrip?t|curl|api\s+\S+|endpoint|request\s+url|fetch\s+\S+|query|database|db\s+\S+)\b/i;
const URL_PATTERN = /https?:\/\/\S+/i;

const EDIT_TOOLS = new Set([
  "Edit", "Write", "FileEditTool", "FileWriteTool", "NotebookEdit", "cursor:edit",
  "MultiEdit",
]);
const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "FileReadTool", "GrepTool", "GlobTool",
]);
const BASH_TOOLS = new Set(["Bash", "BashTool", "PowerShellTool"]);
const TASK_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
  "TodoWrite",
]);
const SEARCH_TOOLS = new Set(["WebSearch", "WebFetch", "ToolSearch"]);
// Plan-mode marker: Claude Code emits ExitPlanMode when leaving plan mode.
// Treat that as the "this turn was planning" signal.
const PLAN_TOOLS = new Set(["ExitPlanMode", "EnterPlanMode"]);
// Sub-agent spawn marker: Claude Code's Task tool spawns a sub-agent; the
// older "Agent" tool name is also accepted for cross-CLI safety.
const AGENT_TOOLS = new Set(["Agent", "Task"]);

function anyIn(tools: string[], set: Set<string>): boolean {
  for (const t of tools) if (set.has(t)) return true;
  return false;
}

function hasMcpTools(tools: string[]): boolean {
  for (const t of tools) if (t.startsWith("mcp__")) return true;
  return false;
}

// Pick the category whose keyword pattern matches earliest in the text. On
// equal positions the candidate listed first wins, so callers control tie-break
// priority by ordering. Fixes the "add error handling" -> debugging false
// positive that motivated codeburn issue #196 — FEATURE wins because "add"
// appears before "error".
function firstMatchingCategory(
  text: string,
  candidates: ReadonlyArray<{ regex: RegExp; category: TurnCategory }>,
): TurnCategory | null {
  let best: { index: number; order: number; category: TurnCategory } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const m = c.regex.exec(text);
    if (!m) continue;
    if (!best || m.index < best.index || (m.index === best.index && i < best.order)) {
      best = { index: m.index, order: i, category: c.category };
    }
  }
  return best?.category ?? null;
}

function classifyByToolPattern(turn: Turn): TurnCategory | null {
  const tools = turn.tools;
  if (tools.length === 0) return null;

  if (anyIn(tools, PLAN_TOOLS)) return "planning";
  if (anyIn(tools, AGENT_TOOLS)) return "delegation";

  const hasEdits = anyIn(tools, EDIT_TOOLS);
  const hasReads = anyIn(tools, READ_TOOLS);
  const hasBash = anyIn(tools, BASH_TOOLS);
  const hasTasks = anyIn(tools, TASK_TOOLS);
  const hasSearch = anyIn(tools, SEARCH_TOOLS);
  const hasMcp = hasMcpTools(tools);

  // Pure-bash turns: classify by the user message OR the bash command text
  // itself (test/git/build/install). The bash command text catches turns
  // where the user said "do it" but the assistant ran `git push`.
  if (hasBash && !hasEdits) {
    const blob = turn.userMessage + "\n" + turn.bashCommands.join("\n");
    if (TEST_PATTERNS.test(blob)) return "testing";
    if (GIT_PATTERNS.test(blob)) return "git";
    if (BUILD_PATTERNS.test(blob)) return "build/deploy";
    if (INSTALL_PATTERNS.test(blob)) return "build/deploy";
  }

  if (hasEdits) return "coding";

  if (hasBash && hasReads) return "exploration";
  if (hasBash) return "coding";

  if (hasSearch || hasMcp) return "exploration";
  if (hasReads && !hasEdits) return "exploration";
  if (hasTasks && !hasEdits) return "planning";

  return null;
}

function refineByKeywords(category: TurnCategory, userMessage: string): TurnCategory {
  if (category === "coding") {
    // Tie-break order: refactor first (most specific words), then feature,
    // then debug. Matches codeburn upstream.
    return (
      firstMatchingCategory(userMessage, [
        { regex: REFACTOR_KEYWORDS, category: "refactoring" },
        { regex: FEATURE_KEYWORDS, category: "feature" },
        { regex: DEBUG_KEYWORDS, category: "debugging" },
      ]) ?? "coding"
    );
  }
  if (category === "exploration") {
    if (RESEARCH_KEYWORDS.test(userMessage)) return "exploration";
    if (DEBUG_KEYWORDS.test(userMessage)) return "debugging";
    return "exploration";
  }
  return category;
}

function classifyConversation(userMessage: string): TurnCategory {
  if (BRAINSTORM_KEYWORDS.test(userMessage)) return "brainstorming";
  if (RESEARCH_KEYWORDS.test(userMessage)) return "exploration";
  // First-match-wins between feature and debug for chat-only turns, same as
  // refineByKeywords above. Keeps "add a function that handles errors" out of
  // debugging.
  const debugOrFeature = firstMatchingCategory(userMessage, [
    { regex: FEATURE_KEYWORDS, category: "feature" },
    { regex: DEBUG_KEYWORDS, category: "debugging" },
  ]);
  if (debugOrFeature) return debugOrFeature;
  if (FILE_PATTERNS.test(userMessage)) return "coding";
  if (SCRIPT_PATTERNS.test(userMessage)) return "coding";
  if (URL_PATTERN.test(userMessage)) return "exploration";
  return "conversation";
}

export function classifyTurn(turn: Turn): TurnCategory {
  if (turn.tools.length === 0) return classifyConversation(turn.userMessage);
  const toolCategory = classifyByToolPattern(turn);
  if (toolCategory) return refineByKeywords(toolCategory, turn.userMessage);
  return classifyConversation(turn.userMessage);
}

// --- turn pairing -----------------------------------------------------------

interface ParsedMessageLite {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

interface ToolCallLite {
  toolName: string;
  inputJson: string;
  timestamp: string;
}

// Group a flat (messages, toolCalls) pair into turns. A turn opens at each
// user message and absorbs every subsequent assistant message (with its
// timestamp-matched tool calls) until the next user message. The assistant's
// `tool_use` blocks share a timestamp with the assistant message that emitted
// them — that's how parser.ts populates toolCalls — so timestamp matching is
// exact within a turn.
//
// Edge cases:
//   - Trailing assistant messages with no preceding user message (rare; some
//     clients seed system context as assistant) are dropped; we don't have a
//     userMessage to classify against.
//   - Multiple assistant messages in one turn: tools accumulate; turn timestamp
//     is the last assistant timestamp.
//   - Empty turn (user message with no assistant response) is still emitted —
//     classifyTurn falls back to conversation classification.
export function buildTurns(
  messages: readonly ParsedMessageLite[],
  toolCalls: readonly ToolCallLite[],
): Turn[] {
  // Bucket tool calls by their assistant-message timestamp so per-turn lookup
  // is O(1). Same timestamp can appear in multiple assistant messages — we
  // accumulate all of them.
  const toolsByTs = new Map<string, ToolCallLite[]>();
  for (const tc of toolCalls) {
    const bucket = toolsByTs.get(tc.timestamp);
    if (bucket) bucket.push(tc);
    else toolsByTs.set(tc.timestamp, [tc]);
  }

  const turns: Turn[] = [];
  let currentUser: { text: string; timestamp: string } | null = null;
  let currentTools: string[] = [];
  let currentBash: string[] = [];
  let lastAssistantTs = "";

  const flush = (): void => {
    if (!currentUser) return;
    turns.push({
      userMessage: currentUser.text,
      tools: currentTools,
      bashCommands: currentBash,
      timestamp: lastAssistantTs || currentUser.timestamp,
    });
    currentTools = [];
    currentBash = [];
    lastAssistantTs = "";
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      flush();
      currentUser = { text: msg.text, timestamp: msg.timestamp };
    } else if (msg.role === "assistant") {
      if (!currentUser) continue; // assistant before any user — skip
      const bucket = toolsByTs.get(msg.timestamp);
      if (bucket) {
        for (const tc of bucket) {
          currentTools.push(tc.toolName);
          // Best-effort bash extraction: pull `command` out of input JSON.
          if (BASH_NAMES.has(tc.toolName)) {
            const cmd = extractBashCommand(tc.inputJson);
            if (cmd) currentBash.push(cmd);
          }
        }
      }
      lastAssistantTs = msg.timestamp;
    }
  }
  flush();
  return turns;
}

const BASH_NAMES = new Set(["Bash", "BashTool", "PowerShellTool"]);

function extractBashCommand(inputJson: string): string | null {
  if (!inputJson || inputJson === "null") return null;
  try {
    const obj = JSON.parse(inputJson) as { command?: unknown };
    if (typeof obj.command === "string") return obj.command;
    return null;
  } catch {
    return null;
  }
}
