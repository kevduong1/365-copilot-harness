import type { Locator, Page } from "playwright";

function visibleAlternative(...locators: Locator[]): Locator {
  const [first, ...rest] = locators;
  if (first === undefined) throw new Error("At least one locator is required");
  return rest.reduce((combined, locator) => combined.or(locator), first);
}

/**
 * The only Copilot-specific DOM knowledge in the project. Run `pnpm spike`
 * after a Microsoft UI change and update this file with the observed ARIA names.
 */
export const sel = {
  chatInput: (page: Page): Locator =>
    visibleAlternative(
      page.getByRole("textbox", { name: "Message Copilot", exact: true }),
      page.getByRole("textbox", { name: /message|chat|ask|prompt|copilot/i }),
      page.locator('[contenteditable="true"][role="textbox"]'),
      page.getByRole("textbox"),
    ).last(),

  sendButton: (page: Page): Locator =>
    visibleAlternative(
      page.getByRole("button", { name: /send( message)?/i }),
      page.locator('button[data-testid*="send" i]'),
    ).last(),

  stopButton: (page: Page): Locator =>
    visibleAlternative(
      page.getByRole("button", { name: /stop( generating| responding)?/i }),
      page.locator('button[data-testid*="stop" i]'),
    ).last(),

  newChatButton: (page: Page): Locator =>
    visibleAlternative(
      page.getByRole("button", { name: /new chat|start (a )?new chat/i }),
      page.getByRole("link", { name: /new chat|start (a )?new chat/i }),
      page.locator('[data-testid*="new-chat" i]'),
    ).first(),

  assistantMessages: (page: Page): Locator =>
    page.locator('[data-testid="copilot-message-div"]'),

  assistantContent: (assistantMessage: Locator): Locator =>
    assistantMessage.locator('[data-testid="markdown-reply"]').last(),

  responseComplete: (assistantMessage: Locator): Locator =>
    assistantMessage.getByRole("button", { name: "Copy Response", exact: true }),
};
