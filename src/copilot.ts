import type { Locator, Page } from "playwright";
import type { ChatAdapter } from "./adapter.js";
import { ensureLoggedIn } from "./browser.js";
import { config } from "./config.js";
import { extractMarkdown } from "./extract.js";
import { PromptTooLargeError, ResponseTimeoutError } from "./errors.js";
import { sel } from "./selectors.js";

function normalizeInput(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
}

export function findNewResponseId(
  before: ReadonlySet<string>,
  current: readonly string[],
): string | undefined {
  return current.find((id) => id !== "" && !before.has(id));
}

interface InputReadings {
  value: string;
  innerText: string;
  textContent: string;
}

async function inputReadings(input: Locator): Promise<InputReadings> {
  return input.evaluate((element) => {
    const isInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    return {
      value: isInput ? element.value : "",
      innerText: element instanceof HTMLElement ? element.innerText : "",
      textContent: element.textContent ?? "",
    };
  });
}

async function visible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

async function enabled(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) return false;
  return locator.isEnabled().catch(() => false);
}

export class M365CopilotAdapter implements ChatAdapter {
  private lastAssistant: Locator | undefined;
  private lastContent: Locator | undefined;

  constructor(private readonly page: Page) {}

  async ensureReady(): Promise<void> {
    await ensureLoggedIn(this.page);
    await sel.chatInput(this.page).waitFor({ state: "visible", timeout: 30_000 });
  }

  async newChat(): Promise<void> {
    await this.ensureReady();
    const button = sel.newChatButton(this.page);
    await button.waitFor({ state: "visible", timeout: 15_000 });
    await button.click();

    const deadline = Date.now() + 15_000;
    while ((await sel.assistantMessages(this.page).count()) !== 0) {
      if (Date.now() >= deadline) {
        throw new Error("New chat was clicked, but the previous messages did not clear");
      }
      await this.page.waitForTimeout(config.pollIntervalMs);
    }

    const input = sel.chatInput(this.page);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.focus();
    this.lastAssistant = undefined;
    this.lastContent = undefined;
  }

  async *send(prompt: string): AsyncIterable<string> {
    if (prompt.length === 0) throw new Error("Prompt must not be empty");
    await this.ensureReady();

    const before = new Set(await this.assistantResponseIds());
    await this.sendPromptWithRetry(prompt);

    const deadline = Date.now() + config.responseTimeoutMs;
    this.lastAssistant = await this.waitForResponseStart(before, deadline);
    this.lastContent = sel.assistantContent(this.lastAssistant);

    let previousMarkdown = "";
    let previousHtml = "";
    let lastMutationAt = Date.now();
    let rewritten = false;
    let sawStopButton = false;

    for (;;) {
      const html = await this.lastContent.innerHTML().catch(() => previousHtml);
      if (html !== previousHtml) {
        previousHtml = html;
        lastMutationAt = Date.now();
        const markdown = extractMarkdown(html);

        if (!rewritten && markdown.startsWith(previousMarkdown)) {
          const delta = markdown.slice(previousMarkdown.length);
          if (delta) yield delta;
        } else if (markdown !== previousMarkdown) {
          rewritten = true;
        }
        previousMarkdown = markdown;
      }

      const stopVisible = await visible(sel.stopButton(this.page));
      sawStopButton ||= stopVisible;
      const stopped = sawStopButton && !stopVisible;
      const readyToSend = await enabled(sel.sendButton(this.page));
      const responseComplete = await visible(sel.responseComplete(this.lastAssistant));
      const stable = Date.now() - lastMutationAt >= config.stabilityDebounceMs;
      if (previousMarkdown && (responseComplete || stopped || readyToSend) && stable) break;

      if (Date.now() >= deadline) {
        throw new ResponseTimeoutError(
          `Copilot did not finish within ${config.responseTimeoutMs}ms`,
          previousMarkdown,
        );
      }
      await this.page.waitForTimeout(config.pollIntervalMs);
    }

    const finalHtml = await this.lastContent.innerHTML();
    const finalMarkdown = extractMarkdown(finalHtml);
    if (rewritten) {
      if (finalMarkdown) yield finalMarkdown;
    } else if (finalMarkdown.startsWith(previousMarkdown)) {
      const delta = finalMarkdown.slice(previousMarkdown.length);
      if (delta) yield delta;
    } else if (finalMarkdown !== previousMarkdown) {
      yield finalMarkdown;
    }
  }

  async sendAndWait(prompt: string): Promise<string> {
    for await (const _delta of this.send(prompt)) {
      // Draining the iterator waits for the authoritative final DOM state.
    }
    if (this.lastContent === undefined) return "";
    return extractMarkdown(await this.lastContent.innerHTML());
  }

  private async enterPrompt(prompt: string): Promise<void> {
    const input = sel.chatInput(this.page);
    const maximum = await input.getAttribute("maxlength");
    if (maximum !== null && prompt.length > Number(maximum)) {
      throw new PromptTooLargeError(prompt.length, Number(maximum));
    }

    let firstError: unknown;
    try {
      await input.fill(prompt);
    } catch (error) {
      firstError = error;
      await input.focus();
      await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await this.page.keyboard.press("Backspace");
      try {
        await this.page.evaluate(async (text) => navigator.clipboard.writeText(text), prompt);
        await this.page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      } catch {
        await this.page.keyboard.insertText(prompt);
      }
    }

    const expected = normalizeInput(prompt);
    const readings = Object.values(await inputReadings(input)).map(normalizeInput);
    if (!readings.includes(expected)) {
      const nonempty = readings.filter(Boolean);
      if (nonempty.length === 0 && firstError instanceof Error) throw firstError;
      const visiblyTruncated = nonempty.some(
        (reading) => expected.startsWith(reading) && reading.length < expected.length,
      );
      if (!visiblyTruncated) return;
      throw new PromptTooLargeError(prompt.length);
    }
  }

  private async sendPromptWithRetry(prompt: string): Promise<void> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.enterPrompt(prompt);
        await this.submitPrompt();
        return;
      } catch (error) {
        if (error instanceof PromptTooLargeError) throw error;
        if (attempt === 1) {
          throw new Error("Failed to submit the prompt after one retry", { cause: error });
        }
        firstError = error;
        await this.page.waitForTimeout(config.pollIntervalMs);
        await sel.chatInput(this.page).focus().catch(() => undefined);
      }
    }
    throw firstError;
  }

  private async submitPrompt(): Promise<void> {
    const sendButton = sel.sendButton(this.page);
    if ((await visible(sendButton)) && (await enabled(sendButton))) {
      await sendButton.click();
      return;
    }
    await sel.chatInput(this.page).press("Enter");
  }

  private async assistantResponseIds(): Promise<string[]> {
    return sel.assistantMessages(this.page).evaluateAll((messages) =>
      messages.map((message) => message.id),
    );
  }

  private async waitForResponseStart(
    before: ReadonlySet<string>,
    deadline: number,
  ): Promise<Locator> {
    for (;;) {
      const responseId = findNewResponseId(before, await this.assistantResponseIds());
      if (responseId !== undefined) {
        if (!/^[\w-]+$/.test(responseId)) {
          throw new Error(`Copilot returned an unsafe response element id: ${responseId}`);
        }
        return this.page.locator(
          `[data-testid="copilot-message-div"][id="${responseId}"]`,
        );
      }
      if (Date.now() >= deadline) {
        throw new ResponseTimeoutError(
          `Copilot did not start responding within ${config.responseTimeoutMs}ms`,
          "",
        );
      }
      await this.page.waitForTimeout(config.pollIntervalMs);
    }
  }
}
