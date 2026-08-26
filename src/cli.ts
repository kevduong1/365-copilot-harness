#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { CopilotClient } from "./client.js";

async function login(): Promise<void> {
  const client = await CopilotClient.launch({
    waitForLogin: true,
    onStatus: (message) => console.log(message),
  });
  console.log("Login confirmed. The browser profile has been saved.");
  await client.close();
}

async function repl(): Promise<void> {
  const client = await CopilotClient.launch();
  const readline = createInterface({ input: stdin, output: stdout });
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    readline.close();
    await client.close();
  };

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  console.log("M365 Copilot browser REPL. Commands: /new, /quit");
  try {
    while (!closing) {
      let answer: string;
      try {
        answer = await readline.question("\n> ");
      } catch (error) {
        if (closing) break;
        throw error;
      }
      const prompt = answer.trim();
      if (!prompt) continue;
      if (prompt === "/quit" || prompt === "/exit") break;
      if (prompt === "/new") {
        await client.newChat();
        console.log("Started a new chat.");
        continue;
      }

      stdout.write("\n");
      try {
        for await (const delta of client.send(prompt)) stdout.write(delta);
        stdout.write("\n");
      } catch (error) {
        console.error(error instanceof Error ? `\n${error.name}: ${error.message}` : error);
      }
    }
  } finally {
    await close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "login") await login();
  else await repl();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
