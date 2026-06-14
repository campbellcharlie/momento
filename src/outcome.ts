// Deterministic, model-free outcome detection for a session.
//
// momento has no notion of whether past work SUCCEEDED, so recall happily
// surfaces a session where something was tried and reverted. This infers a
// coarse outcome from signals already in the transcript. It is intentionally
// conservative: the cost of a wrong label (recall trusts a failed precedent)
// is higher than the cost of `null` (unknown), so anything ambiguous stays
// null.
//
// Strongest signal is the human's verdict in the CLOSING user turns — "that
// worked" / "perfect" vs "revert" / "still broken". A reached `git commit` is
// a weak positive. That's it; no parsing of tool output, no model.

const POSITIVE =
  /\b(that works|that worked|works now|it works|perfect|thanks|thank you|nice work|great|awesome|fixed it|lgtm|ship it|looks good|works great|that did it)\b/i;
const NEGATIVE =
  /\b(revert|roll ?back|still (broken|failing|fails|not working|doesn'?t work)|didn'?t work|does(n'?t| not) work|that'?s wrong|undo that|broke it|made it worse|not what i)\b/i;

export type Outcome = "success" | "failure" | "mixed" | null;

export interface OutcomeMessage {
  role: string;
  text: string | null;
}
export interface OutcomeToolCall {
  inputJson: string | null;
}

export function detectOutcome(
  messages: OutcomeMessage[],
  toolCalls: OutcomeToolCall[],
): Outcome {
  const userTurns = messages
    .filter((m) => m.role === "user" && typeof m.text === "string")
    .map((m) => m.text as string);
  // Only the last few user turns carry the verdict; earlier "still broken" is
  // mid-work, not the conclusion.
  const closing = userTurns.slice(-4).join("\n");
  const pos = POSITIVE.test(closing);
  const neg = NEGATIVE.test(closing);
  if (pos && neg) return "mixed";
  if (neg) return "failure";
  if (pos) return "success";
  // Weak positive: the work reached a commit.
  if (toolCalls.some((tc) => /git\s+commit/.test(tc.inputJson ?? ""))) return "success";
  return null;
}
