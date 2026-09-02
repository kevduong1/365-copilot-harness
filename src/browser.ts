import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { NotLoggedInError } from "./errors.js";
import { sel } from "./selectors.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export interface LoginOptions {
  waitForLogin?: boolean;
  onStatus?: (message: string) => void;
}

type RestoredCookies = Parameters<BrowserContext["addCookies"]>[0];

export function isCopilotChatUrl(
  currentUrl: string,
  expectedUrl = config.copilotUrl,
): boolean {
  try {
    const current = new URL(currentUrl);
    const expected = new URL(expectedUrl);
    const expectedPath = expected.pathname.replace(/\/$/, "");
    return (
      current.origin === expected.origin &&
      (current.pathname === expectedPath || current.pathname.startsWith(`${expectedPath}/`))
    );
  } catch {
    return false;
  }
}

async function restoreSessionState(context: BrowserContext): Promise<void> {
  try {
    const raw = await readFile(config.sessionStatePath, "utf8");
    const state = JSON.parse(raw) as { cookies?: RestoredCookies };
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export async function openSession(): Promise<BrowserSession> {
  await mkdir(config.profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    channel: "chrome",
    viewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      // Subagent conversations stream in background tabs; Chrome must not
      // throttle their timers or rendering while another tab has focus.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  await restoreSessionState(context);
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

export async function closeSession(context: BrowserContext): Promise<void> {
  try {
    await mkdir(dirname(config.sessionStatePath), { recursive: true });
    await context.storageState({ path: config.sessionStatePath });
  } finally {
    await context.close();
  }
}

export async function ensureLoggedIn(
  page: Page,
  options: LoginOptions = {},
): Promise<void> {
  const input = sel.chatInput(page);
  if (isCopilotChatUrl(page.url()) && (await input.isVisible().catch(() => false))) return;

  await page.goto(config.copilotUrl, { waitUntil: "domcontentloaded" });
  const initialDeadline = Date.now() + Math.min(config.responseTimeoutMs, 30_000);
  let announced = false;

  for (;;) {
    const currentUrl = page.url();
    const atLogin = config.loginUrlPattern.test(currentUrl);
    if (atLogin && !options.waitForLogin) throw new NotLoggedInError();

    if (
      !atLogin &&
      isCopilotChatUrl(currentUrl) &&
      (await input.isVisible().catch(() => false))
    ) {
      return;
    }

    if (options.waitForLogin && !announced) {
      options.onStatus?.(
        "Complete Microsoft SSO/MFA in the browser. This process will continue when the Copilot chat input appears.",
      );
      announced = true;
    }

    if (!options.waitForLogin && Date.now() >= initialDeadline) {
      throw new NotLoggedInError(
        `Copilot's chat input did not appear at ${page.url()}; run: pnpm cli login`,
      );
    }

    await page.waitForTimeout(500);
  }
}
