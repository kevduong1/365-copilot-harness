import type { BrowserContext, Page } from "playwright";
import type { ChatAdapter } from "./adapter.js";
import { closeSession, ensureLoggedIn, openSession, type LoginOptions } from "./browser.js";
import { M365CopilotAdapter } from "./copilot.js";
import { Mutex } from "./queue.js";

export interface LaunchOptions extends LoginOptions {}

export class CopilotClient {
  private readonly mutex = new Mutex();
  private closed = false;

  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly adapter: ChatAdapter,
  ) {}

  static async launch(options: LaunchOptions = {}): Promise<CopilotClient> {
    const { context, page } = await openSession();
    try {
      await ensureLoggedIn(page, options);
      const adapter = new M365CopilotAdapter(page);
      await adapter.ensureReady();
      return new CopilotClient(context, page, adapter);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async *send(prompt: string): AsyncIterable<string> {
    this.assertOpen();
    const release = await this.mutex.acquire();
    try {
      for await (const delta of this.adapter.send(prompt)) yield delta;
    } finally {
      release();
    }
  }

  sendAndWait(prompt: string): Promise<string> {
    this.assertOpen();
    return this.mutex.run(() => this.adapter.sendAndWait(prompt));
  }

  newChat(): Promise<void> {
    this.assertOpen();
    return this.mutex.run(() => this.adapter.newChat());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeSession(this.context);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("CopilotClient is closed");
  }
}
