#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CopilotClient } from "./client.js";
import { sel } from "./selectors.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const client = await CopilotClient.launch();
  try {
    const { page } = client;
    const promptIndex = args.indexOf("--send");
    const prompt = promptIndex >= 0 ? args.slice(promptIndex + 1).join(" ") : "";
    const probe = prompt || "Copilot selector probe";
    const input = sel.chatInput(page);

    console.log(`Inserting an unsubmitted probe (${JSON.stringify(probe)}) to reveal composer controls…`);
    await input.fill(probe);
    await page.waitForTimeout(500);

    try {
      const aria = await page.locator("body").ariaSnapshot();
      await writeFile(".data/aria-snapshot.yml", aria, "utf8");

      const controls = await page.locator('button, input, textarea, [role="button"], [role="textbox"], [contenteditable="true"]').evaluateAll(
        (elements) =>
          elements.map((element) => ({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            testId: element.getAttribute("data-testid"),
            disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
            text: (element.textContent ?? "").trim().slice(0, 120),
            value:
              element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                ? element.value
                : undefined,
          })),
      );
      const inputState = await input.evaluate((element) => ({
        outerHTML: element.outerHTML,
        textContent: element.textContent,
        innerText: element instanceof HTMLElement ? element.innerText : undefined,
        value:
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : undefined,
      }));

      console.log(JSON.stringify({ input: inputState, controls }, null, 2));
      console.log(`Assistant message candidates: ${await sel.assistantMessages(page).count()}`);
      await page.screenshot({ path: "spike.png", fullPage: true });
      console.log("Wrote .data/aria-snapshot.yml and spike.png with the composer populated");
    } finally {
      await input.fill("").catch(() => undefined);
    }

    if (prompt) {
      console.log("\nStreaming test response:\n");
      for await (const delta of client.send(prompt)) process.stdout.write(delta);
      process.stdout.write("\n");
    }
  } finally {
    await client.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
