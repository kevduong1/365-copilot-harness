import type { BrowserContext, Page } from "playwright";
import type { ChatAdapter } from "./adapter.js";
import { closeSession, ensureLoggedIn, openSession, type LoginOptions } from "./browser.js";
import {
  DEFAULT_COMPACTION_READY_MARKER,
  buildCompactionBootstrapPrompt,
  buildCompactionSummaryPrompt,
  type ConversationCompactionOptions,
  type ConversationCompactionResult,
} from "./compaction.js";
import { config } from "./config.js";
import { M365CopilotAdapter } from "./copilot.js";
import { Mutex } from "./queue.js";
import { ConversationTokenCounter, type TokenUsageEstimate } from "./tokens.js";

export interface LaunchOptions extends LoginOptions {
  contextWindowTokens?: number;
  autoCompact?: boolean;
  autoCompactPercent?: number;
  compactionSummaryTokens?: number;
}

export interface CompactionResult extends ConversationCompactionResult {
  acknowledged: boolean;
  before: TokenUsageEstimate;
  after: TokenUsageEstimate;
}

export class CopilotClient {
  private readonly mutex = new Mutex();
  private readonly tokenCounter: ConversationTokenCounter;
  private readonly autoCompact: boolean;
  private readonly compactionSummaryTokens: number;
  private closed = false;

  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly adapter: ChatAdapter,
    options: LaunchOptions,
  ) {
    this.tokenCounter = new ConversationTokenCounter({
      contextWindowTokens: options.contextWindowTokens ?? config.contextWindowTokens,
      compactionThresholdPercent: options.autoCompactPercent ?? config.autoCompactPercent,
    });
    this.autoCompact = options.autoCompact ?? config.autoCompact;
    this.compactionSummaryTokens =
      options.compactionSummaryTokens ?? config.compactionSummaryTokens;
  }

  static async launch(options: LaunchOptions = {}): Promise<CopilotClient> {
    const { context, page } = await openSession();
    try {
      await ensureLoggedIn(page, options);
      const adapter = new M365CopilotAdapter(page);
      await adapter.ensureReady();
      return new CopilotClient(context, page, adapter, options);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
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
    return this.autoCompact && this.tokenCounter.needsCompaction(nextPrompt);
  }

  isAutoCompactionEnabled(): boolean {
    this.assertOpen();
    return this.autoCompact;
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
      const acknowledgement = await this.trackedSendAndWait(
        buildCompactionBootstrapPrompt(summary, options),
      );
      const readyMarker = options.readyMarker ?? DEFAULT_COMPACTION_READY_MARKER;
      const acknowledged = acknowledgement.replaceAll("\\_", "_").includes(readyMarker);
      return {
        summary,
        acknowledgement,
        acknowledged,
        before,
        after: this.tokenCounter.usage(),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeSession(this.context);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("CopilotClient is closed");
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
