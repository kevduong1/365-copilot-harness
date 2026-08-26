import type { Locator, Page } from "playwright";
import type { ChatAdapter } from "./adapter.js";
import { ensureLoggedIn } from "./browser.js";
import { config } from "./config.js";
import { extractMarkdown } from "./extract.js";
import { PromptTooLargeError, ResponseTimeoutError } from "./errors.js";
import { sel } from "./selectors.js";

function normalizeInput(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c]/g, "");
}

export function findNewResponseId(
  before: ReadonlySet<string>,
  current: readonly string[],
): string | undefined {
  return current.findLast((id) => id !== "" && !before.has(id));
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
  private lastMarkdown = "";
  private readonly knownAssistantIds = new Set<string>();

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
    // M365 briefly renders an interactive composer and then replaces it while
    // the new conversation initializes. Filling the old node loses the text.
    await this.page.waitForTimeout(config.newChatSettleMs);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.focus();
    this.lastAssistant = undefined;
    this.lastContent = undefined;
    this.lastMarkdown = "";
    this.knownAssistantIds.clear();
  }

  async *send(prompt: string): AsyncIterable<string> {
    if (prompt.length === 0) throw new Error("Prompt must not be empty");
    await this.ensureReady();
    this.lastMarkdown = "";

    const mountedBefore = await this.assistantResponseIds();
    for (const id of mountedBefore) this.knownAssistantIds.add(id);
    const before = new Set(this.knownAssistantIds);
    await this.sendPromptWithRetry(prompt, before);

    const deadline = Date.now() + config.responseTimeoutMs;
    const response = await this.waitForResponseStart(before, deadline);
    this.lastAssistant = response.assistant;
    this.lastContent = response.content;

    let previousMarkdown = "";
    let previousHtml = "";
    let lastMutationAt = Date.now();
    let rewritten = false;
    let sawStopButton = false;

    for (;;) {
      const html = await this.lastContent
        .innerHTML({ timeout: 1_000 })
        .catch(() => previousHtml);
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
        this.lastMarkdown = markdown;
      }

      const stopVisible = await visible(sel.stopButton(this.page));
      sawStopButton ||= stopVisible;
      const stopped = sawStopButton && !stopVisible;
      const readyToSend = await enabled(sel.sendButton(this.page));
      const responseComplete = await visible(sel.responseComplete(this.lastAssistant));
      const stable = Date.now() - lastMutationAt >= config.stabilityDebounceMs;
      const idleFallback = Date.now() - lastMutationAt >= config.completionFallbackMs;
      if (
        previousMarkdown &&
        ((responseComplete || stopped || readyToSend) && stable || idleFallback)
      ) {
        break;
      }

      if (Date.now() >= deadline) {
        throw new ResponseTimeoutError(
          `Copilot did not finish within ${config.responseTimeoutMs}ms`,
          previousMarkdown,
        );
      }
      await this.page.waitForTimeout(config.pollIntervalMs);
    }

    const finalHtml = await this.lastContent
      .innerHTML({ timeout: 1_000 })
      .catch(() => previousHtml);
    const finalMarkdown = extractMarkdown(finalHtml);
    this.lastMarkdown = finalMarkdown || previousMarkdown;
    for (const id of await this.assistantResponseIds()) this.knownAssistantIds.add(id);
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
    return this.lastMarkdown;
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

  private async sendPromptWithRetry(
    prompt: string,
    before: ReadonlySet<string>,
  ): Promise<void> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.enterPrompt(prompt);
        await this.page.waitForTimeout(config.promptSettleMs);
        await this.submitPrompt(prompt, before);
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

  private async submitPrompt(prompt: string, before: ReadonlySet<string>): Promise<void> {
    const sendButton = sel.sendButton(this.page);
    try {
      await sendButton.waitFor({ state: "visible", timeout: 10_000 });
      await sendButton.click({ timeout: 10_000 });

      const expected = normalizeInput(prompt);
      const deadline = Date.now() + 5_000;
      for (;;) {
        const responseStarted = findNewResponseId(before, await this.assistantResponseIds());
        const generationStarted = await visible(sel.stopButton(this.page));
        const readings = Object.values(await inputReadings(sel.chatInput(this.page))).map(
          normalizeInput,
        );
        const promptStillPresent = readings.includes(expected);
        if (responseStarted !== undefined || generationStarted || !promptStillPresent) return;
        if (Date.now() >= deadline) {
          throw new Error("Copilot's composer retained the prompt after Send was clicked");
        }
        await this.page.waitForTimeout(config.pollIntervalMs);
      }
    } catch (error) {
      throw new Error(
        "Copilot did not accept the rendered prompt after Send was clicked",
        { cause: error },
      );
    }
  }

  private async assistantResponseIds(): Promise<string[]> {
    return sel.assistantMessages(this.page).evaluateAll((messages) =>
      messages.map((message) => message.id),
    );
  }

  private async waitForResponseStart(
    before: ReadonlySet<string>,
    deadline: number,
  ): Promise<{ assistant: Locator; content: Locator }> {
    let diagnosticText = "";
    let fallback: { assistant: Locator; content: Locator; observedAt: number } | undefined;
    for (;;) {
      const responseIds = (await this.assistantResponseIds())
        .filter((id) => id !== "" && !before.has(id))
        .reverse();
      for (const responseId of responseIds) {
        if (!/^[\w-]+$/.test(responseId)) {
          throw new Error(`Copilot returned an unsafe response element id: ${responseId}`);
        }
        const response = this.page.locator(
          `[data-testid="copilot-message-div"][id="${responseId}"]`,
        );
        const content = sel.assistantContent(response);
        const markdownHtml =
          (await content.count()) > 0
            ? await content.innerHTML({ timeout: 1_000 }).catch(() => "")
            : "";
        const responseText = await response.innerText({ timeout: 1_000 }).catch(() => "");
        diagnosticText ||= responseText.trim();
        if (markdownHtml !== "") {
          for (const id of responseIds) this.knownAssistantIds.add(id);
          return { assistant: response, content };
        }
        if (responseText.trim() !== "" && fallback === undefined) {
          fallback = { assistant: response, content: response, observedAt: Date.now() };
        }
      }
      if (
        fallback !== undefined &&
        Date.now() - fallback.observedAt >= config.completionFallbackMs
      ) {
        for (const id of responseIds) this.knownAssistantIds.add(id);
        return { assistant: fallback.assistant, content: fallback.content };
      }
      if (Date.now() >= deadline) {
        throw new ResponseTimeoutError(
          `Copilot did not produce extractable response content within ${config.responseTimeoutMs}ms`,
          diagnosticText,
        );
      }
      await this.page.waitForTimeout(config.pollIntervalMs);
    }
  }
}
