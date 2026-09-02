import type { ChatAdapter } from "./adapter.js";
import {
  DEFAULT_COMPACTION_READY_MARKER,
  buildCompactionBootstrapPrompt,
  buildCompactionSummaryPrompt,
  type ConversationCompactionOptions,
  type ConversationCompactionResult,
} from "./compaction.js";
import { config } from "./config.js";
import { Mutex } from "./queue.js";
import { ConversationTokenCounter, type TokenUsageEstimate } from "./tokens.js";

export interface SessionOptions {
  contextWindowTokens?: number;
  autoCompact?: boolean;
  autoCompactPercent?: number;
  compactionSummaryTokens?: number;
}

export interface CompactionResult extends ConversationCompactionResult {
  /** True when the bootstrap was acknowledged, or when a resumePrompt made an acknowledgement unnecessary. */
  acknowledged: boolean;
  before: TokenUsageEstimate;
  after: TokenUsageEstimate;
}

/**
 * One tracked browser conversation: an adapter serialized behind a mutex with
 * token estimation and automatic compaction. `CopilotClient` is the primary
 * session and owns the browser; tab sessions back subagent conversations.
 */
export class ChatSession {
  private readonly mutex = new Mutex();
  private readonly tokenCounter: ConversationTokenCounter;
  private readonly autoCompactEnabled: boolean;
  private readonly compactionSummaryTokens: number;
  private closed = false;

  constructor(
    private readonly adapter: ChatAdapter,
    options: SessionOptions = {},
  ) {
    this.tokenCounter = new ConversationTokenCounter({
      contextWindowTokens: options.contextWindowTokens ?? config.contextWindowTokens,
      compactionThresholdPercent: options.autoCompactPercent ?? config.autoCompactPercent,
    });
    this.autoCompactEnabled = options.autoCompact ?? config.autoCompact;
    this.compactionSummaryTokens =
      options.compactionSummaryTokens ?? config.compactionSummaryTokens;
  }

  async *send(prompt: string): AsyncIterable<string> {
    this.assertOpen();
    const release = await this.mutex.acquire();
    let completed = false;
    let streamedResponse = "";
    try {
      for await (const delta of this.adapter.send(prompt)) {
        streamedResponse += delta;
        yield delta;
      }
      completed = true;
    } finally {
      const response = this.adapter.lastResponse?.() || streamedResponse;
      if (completed || response) this.tokenCounter.record("user", prompt);
      if (response) this.tokenCounter.record("assistant", response);
      release();
    }
  }

  sendAndWait(prompt: string): Promise<string> {
    this.assertOpen();
    return this.mutex.run(() => this.trackedSendAndWait(prompt));
  }

  newChat(): Promise<void> {
    this.assertOpen();
    return this.mutex.run(async () => {
      await this.adapter.newChat();
      this.tokenCounter.reset();
    });
  }

  getTokenUsage(): TokenUsageEstimate {
    this.assertOpen();
    return this.tokenCounter.usage();
  }

  needsCompaction(nextPrompt = ""): boolean {
    this.assertOpen();
    return this.autoCompactEnabled && this.tokenCounter.needsCompaction(nextPrompt);
  }

  isAutoCompactionEnabled(): boolean {
    this.assertOpen();
    return this.autoCompactEnabled;
  }

  compact(options: ConversationCompactionOptions = {}): Promise<CompactionResult> {
    this.assertOpen();
    return this.mutex.run(async () => {
      const before = this.tokenCounter.usage();
      if (before.messageCount === 0) throw new Error("There is no tracked conversation to compact");

      const maxSummaryTokens = options.maxSummaryTokens ?? this.compactionSummaryTokens;
      const summary = (
        await this.trackedSendAndWait(buildCompactionSummaryPrompt(maxSummaryTokens))
      ).trim();
      if (!summary) throw new Error("Copilot returned an empty conversation summary");

      await this.adapter.newChat();
      this.tokenCounter.reset();
      // With a resumePrompt the bootstrap carries real work, so its reply is the
      // answer to that work rather than a readiness marker.
      const reply = await this.trackedSendAndWait(buildCompactionBootstrapPrompt(summary, options));
      const readyMarker = options.readyMarker ?? DEFAULT_COMPACTION_READY_MARKER;
      const acknowledged =
        options.resumePrompt !== undefined ||
        reply.replaceAll("\\_", "_").includes(readyMarker);
      return {
        summary,
        acknowledgement: reply,
        ...(options.resumePrompt === undefined ? {} : { response: reply }),
        acknowledged,
        before,
        after: this.tokenCounter.usage(),
      };
    });
  }

  async close(): Promise<void> {
    this.markClosed();
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error(`${this.constructor.name} is closed`);
  }

  /** Returns false when the session was already closed. */
  protected markClosed(): boolean {
    if (this.closed) return false;
    this.closed = true;
    return true;
  }

  private async trackedSendAndWait(prompt: string): Promise<string> {
    try {
      const response = await this.adapter.sendAndWait(prompt);
      this.tokenCounter.record("user", prompt);
      if (response) this.tokenCounter.record("assistant", response);
      return response;
    } catch (error) {
      const response = this.adapter.lastResponse?.() ?? "";
      if (response) {
        this.tokenCounter.record("user", prompt);
        this.tokenCounter.record("assistant", response);
      }
      throw error;
    }
  }
}
