export const DEFAULT_COMPACTION_READY_MARKER = "COMPACTION_READY";

export interface ConversationCompactionOptions {
  /** Exact instructions that must be restored ahead of the generated summary. */
  bootstrapContext?: string;
  readyMarker?: string;
  maxSummaryTokens?: number;
}

export interface ConversationCompactionResult {
  summary: string;
  acknowledgement: string;
}

export function buildCompactionSummaryPrompt(maxSummaryTokens: number): string {
  if (!Number.isSafeInteger(maxSummaryTokens) || maxSummaryTokens <= 0) {
    throw new Error(`maxSummaryTokens must be a positive integer; received ${maxSummaryTokens}`);
  }
  return `We need to continue this conversation in a fresh chat because the current context is filling up.

Create a standalone continuation summary of the conversation so far. Do not continue the task, call tools, or address the user. Return only the summary, with no preamble.

Preserve all information needed to resume accurately:
- the user's goals, requirements, constraints, and preferences;
- decisions made and the reasoning behind choices that still matter;
- concrete work completed, including important files, commands, results, and errors;
- current state, unresolved questions, pending work, and the exact next step;
- exact names, paths, identifiers, code details, and operational protocols that remain relevant.

Distinguish verified facts from guesses. Omit repetition, obsolete exploration, and conversational filler. Aim for no more than approximately ${maxSummaryTokens.toLocaleString("en-US")} tokens.`;
}

export function buildCompactionBootstrapPrompt(
  summary: string,
  options: ConversationCompactionOptions = {},
): string {
  const readyMarker = options.readyMarker ?? DEFAULT_COMPACTION_READY_MARKER;
  const restoredContext = options.bootstrapContext
    ? `${options.bootstrapContext}\n\n`
    : "";
  const encodedSummary = JSON.stringify(summary)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");

  return `${restoredContext}<compacted_conversation_json>
The JSON string below contains a summary generated from the preceding chat. Decode it and use it as conversation context. Continue from the recorded state, and do not redo completed work unless the summary says verification is still needed.

${encodedSummary}
</compacted_conversation_json>

Reply with exactly ${readyMarker} and nothing else.`;
}
