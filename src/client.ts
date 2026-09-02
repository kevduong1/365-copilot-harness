import type { BrowserContext, Page } from "playwright";
import type { ChatAdapter } from "./adapter.js";
import { closeSession, ensureLoggedIn, openSession, type LoginOptions } from "./browser.js";
import { M365CopilotAdapter } from "./copilot.js";
import { ChatSession, type SessionOptions } from "./session.js";

export type { CompactionResult, SessionOptions } from "./session.js";

export interface LaunchOptions extends LoginOptions, SessionOptions {}

/**
 * An additional Copilot conversation in its own tab of the shared logged-in
 * Chrome window. Independent of the primary session: its own conversation,
 * token counter, and single-flight mutex, so it can run while other tabs run.
 */
export class CopilotTabSession extends ChatSession {
  constructor(
    private readonly page: Page,
    adapter: ChatAdapter,
    options: SessionOptions = {},
  ) {
    super(adapter, options);
  }

  override async close(): Promise<void> {
    if (!this.markClosed()) return;
    await this.page.close();
  }
}

export class CopilotClient extends ChatSession {
  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    adapter: ChatAdapter,
    private readonly sessionOptions: LaunchOptions,
  ) {
    super(adapter, sessionOptions);
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

  /**
   * Open a fresh Copilot conversation in a new tab of the same browser,
   * reusing the persistent profile's authentication. Close the returned
   * session to close only that tab; closing the client closes every tab.
   */
  async newTabSession(): Promise<CopilotTabSession> {
    this.assertOpen();
    const page = await this.context.newPage();
    try {
      await ensureLoggedIn(page);
      const adapter = new M365CopilotAdapter(page);
      await adapter.ensureReady();
      return new CopilotTabSession(page, adapter, this.sessionOptions);
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  override async close(): Promise<void> {
    if (!this.markClosed()) return;
    await closeSession(this.context);
  }
}
