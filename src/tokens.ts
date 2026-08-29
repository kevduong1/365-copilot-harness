export type ConversationRole = "user" | "assistant";

export interface TokenCounterOptions {
  contextWindowTokens: number;
  compactionThresholdPercent: number;
}

export interface TokenUsageEstimate {
  /** Estimated tokens in messages sent through this harness since the last new chat. */
  conversationTokens: number;
  contextWindowTokens: number;
  remainingTokens: number;
  usagePercent: number;
  compactionThresholdTokens: number;
  compactionThresholdPercent: number;
  messageCount: number;
}

const MESSAGE_OVERHEAD_TOKENS = 4;

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }
}

/**
 * Estimate tokenizer usage without assuming which model M365 selected for a turn.
 *
 * English prose starts near the familiar four-characters-per-token heuristic.
 * Punctuation-heavy code and non-Latin scripts are weighted more heavily, followed
 * by a small safety margin. This is deliberately conservative and is not billing
 * usage or an exact count from Microsoft.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let units = 0;
  for (const character of text.normalize("NFC")) {
    if (/[A-Za-z0-9]/.test(character)) units += 0.25;
    else if (/\s/u.test(character)) units += 0.1;
    else if (/^[\x00-\x7f]$/u.test(character)) units += 0.5;
    else if (/\p{Mark}/u.test(character)) units += 0.1;
    else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
      units += 1;
    } else if (/\p{Letter}|\p{Number}/u.test(character)) units += 0.5;
    else units += 1;
  }

  return Math.max(1, Math.ceil(units * 1.1));
}

export function estimateMessageTokens(content: string): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(content);
}

export class ConversationTokenCounter {
  private conversationTokens = 0;
  private messageCount = 0;
  readonly contextWindowTokens: number;
  readonly compactionThresholdPercent: number;
  readonly compactionThresholdTokens: number;

  constructor(options: TokenCounterOptions) {
    validatePositiveInteger("contextWindowTokens", options.contextWindowTokens);
    if (
      !Number.isFinite(options.compactionThresholdPercent) ||
      options.compactionThresholdPercent <= 0 ||
      options.compactionThresholdPercent > 100
    ) {
      throw new Error(
        `compactionThresholdPercent must be greater than 0 and at most 100; received ${options.compactionThresholdPercent}`,
      );
    }

    this.contextWindowTokens = options.contextWindowTokens;
    this.compactionThresholdPercent = options.compactionThresholdPercent;
    this.compactionThresholdTokens = Math.floor(
      options.contextWindowTokens * (options.compactionThresholdPercent / 100),
    );
  }

  record(_role: ConversationRole, content: string): number {
    const tokens = estimateMessageTokens(content);
    this.conversationTokens += tokens;
    this.messageCount += 1;
    return tokens;
  }

  reset(): void {
    this.conversationTokens = 0;
    this.messageCount = 0;
  }

  usage(nextMessage?: string): TokenUsageEstimate {
    const projected =
      this.conversationTokens +
      (nextMessage === undefined ? 0 : estimateMessageTokens(nextMessage));
    return {
      conversationTokens: projected,
      contextWindowTokens: this.contextWindowTokens,
      remainingTokens: Math.max(0, this.contextWindowTokens - projected),
      usagePercent: (projected / this.contextWindowTokens) * 100,
      compactionThresholdTokens: this.compactionThresholdTokens,
      compactionThresholdPercent: this.compactionThresholdPercent,
      messageCount: this.messageCount + (nextMessage === undefined ? 0 : 1),
    };
  }

  needsCompaction(nextMessage = ""): boolean {
    if (this.messageCount === 0) return false;
    const projected = this.conversationTokens + (nextMessage ? estimateMessageTokens(nextMessage) : 0);
    return projected >= this.compactionThresholdTokens;
  }
}
