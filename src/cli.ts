#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CodingAgent } from "./agent/runner.js";
import type { AgentEvent, ToolCall, ToolDefinition } from "./agent/types.js";
import { CopilotClient } from "./client.js";
import { ResponseTimeoutError } from "./errors.js";

interface CliOptions {
  command: "help" | "login" | "interactive" | "print";
  task: string;
  autoApprove: boolean;
  readOnly: boolean;
  rawChat: boolean;
  cwd: string;
  allowedRoots: string[];
}

function parseArgs(args: string[]): CliOptions {
  if (args[0] === "login" || args[0] === "--help" || args[0] === "-h") {
    return {
      command: args[0] === "login" ? "login" : "help",
      task: "",
      autoApprove: false,
      readOnly: false,
      rawChat: false,
      cwd: process.cwd(),
      allowedRoots: [],
    };
  }

  let printMode = false;
  let autoApprove = false;
  let readOnly = false;
  let rawChat = false;
  let cwd = process.cwd();
  const allowedRoots: string[] = [];
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--print" || arg === "-p") printMode = true;
    else if (arg === "--yes" || arg === "-y") autoApprove = true;
    else if (arg === "--read-only") readOnly = true;
    else if (arg === "--chat") rawChat = true;
    else if (arg === "--cwd" || arg === "--add-dir" || arg === "--allow-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} requires a directory`);
      index += 1;
      if (arg === "--cwd") cwd = resolve(value);
      else allowedRoots.push(resolve(value));
    } else if (arg === "--") {
      taskParts.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (printMode) {
      taskParts.push(arg);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    command: printMode ? "print" : "interactive",
    task: taskParts.join(" "),
    autoApprove,
    readOnly,
    rawChat,
    cwd,
    allowedRoots,
  };
}

function printHelp(): void {
  console.log(`Usage:
  pnpm cli login
  pnpm cli [--cwd DIR] [--add-dir DIR ...] [--read-only] [--yes]
  pnpm cli [options] --print "TASK"

Options:
  --cwd DIR       Start the coding agent in DIR; DIR becomes an allowed root
  --add-dir DIR   Grant access to an additional root and its descendants (repeatable)
  --allow-dir DIR Alias for --add-dir
  --read-only     Disable edit, write, and bash
  --yes, -y       Automatically approve mutating tools
  --chat          Use raw browser chat instead of the coding agent
  --print, -p     Run one task non-interactively
  --help, -h      Show this help`);
}

async function login(): Promise<void> {
  const client = await CopilotClient.launch({
    waitForLogin: true,
    onStatus: (message) => console.log(message),
  });
  console.log("Login confirmed. The browser profile and session state have been saved.");
  await client.close();
}

function callSummary(call: ToolCall): string {
  const preferred = ["path", "pattern", "command"].find(
    (name) => typeof call.arguments[name] === "string",
  );
  const value = preferred === undefined ? "" : ` ${JSON.stringify(call.arguments[preferred])}`;
  return `${call.name}${value}`;
}

function displayedOutput(output: string): string {
  const maximum = 4_000;
  return output.length <= maximum ? output : `${output.slice(0, maximum)}\n… tool display truncated`;
}

function displayedError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const partial = error instanceof ResponseTimeoutError ? error.partialResponse.trim() : "";
  return partial
    ? `${error.name}: ${error.message}\nPartial response:\n${displayedOutput(partial)}`
    : `${error.name}: ${error.message}`;
}

function eventPrinter(destination: NodeJS.WritableStream): (event: AgentEvent) => void {
  return (event) => {
    if (event.type === "tool_start") {
      destination.write(`\n[tool] ${callSummary(event.call)}\n`);
    } else if (event.type === "tool_end") {
      destination.write(
        `${event.result.ok ? "[ok]" : "[error]"} ${displayedOutput(event.result.output)}\n`,
      );
    } else if (event.type === "warning") {
      destination.write(`[warning] ${event.message}\n`);
    }
  };
}

function approvalPrompt(
  readline: Interface,
  autoApprove: boolean,
): (call: ToolCall, definition: ToolDefinition) => Promise<boolean> {
  return async (call, definition) => {
    if (autoApprove) return true;
    const answer = await readline.question(
      `\nAllow ${definition.name} (${definition.description})?\n${JSON.stringify(call.arguments, null, 2)}\n[y/N] `,
    );
    return /^y(?:es)?$/i.test(answer.trim());
  };
}

async function interactive(options: CliOptions): Promise<void> {
  const client = await CopilotClient.launch();
  const readline = createInterface({ input: stdin, output: stdout });
  let closing = false;
  let agentMode = !options.rawChat;
  const agent = new CodingAgent(client, {
    cwd: options.cwd,
    allowedRoots: options.allowedRoots,
    readOnly: options.readOnly,
    confirmTool: approvalPrompt(readline, options.autoApprove),
    onEvent: eventPrinter(stdout),
  });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    readline.close();
    await client.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  console.log(
    `M365 Copilot coding harness (${agentMode ? "agent" : "chat"} mode${options.readOnly ? ", read-only" : ""}).`,
  );
  console.log(`Working directory: ${options.cwd}`);
  if (options.allowedRoots.length > 0) {
    console.log(`Additional allowed roots: ${options.allowedRoots.join(", ")}`);
  }
  console.log("Commands: /agent, /chat, /tools, /new, /help, /quit");

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
      if (prompt === "/help") {
        console.log("Agent mode executes structured local tools. Chat mode sends raw prompts without tools.");
        console.log("Mutating tools ask for approval unless the CLI was started with --yes.");
        continue;
      }
      if (prompt === "/agent") {
        agentMode = true;
        console.log("Agent mode enabled. Its first task starts a fresh coding conversation.");
        continue;
      }
      if (prompt === "/chat") {
        agentMode = false;
        console.log("Raw chat mode enabled.");
        continue;
      }
      if (prompt === "/tools") {
        console.log((await agent.toolNames()).join(", "));
        continue;
      }
      if (prompt === "/new") {
        if (agentMode) await agent.reset();
        else await client.newChat();
        console.log("Started a new conversation.");
        continue;
      }

      try {
        if (agentMode) {
          const result = await agent.run(prompt);
          stdout.write(`\n${result}\n`);
        } else {
          stdout.write("\n");
          for await (const delta of client.send(prompt)) stdout.write(delta);
          stdout.write("\n");
        }
      } catch (error) {
        console.error(`\n${displayedError(error)}`);
      }
    }
  } finally {
    await close();
  }
}

async function print(options: CliOptions): Promise<void> {
  let task = options.task;
  if (!task && !stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    task = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!task) throw new Error("Print mode requires a task after --print or on stdin");

  const client = await CopilotClient.launch();
  if (options.rawChat) {
    try {
      stdout.write(`${await client.sendAndWait(task)}\n`);
    } finally {
      await client.close();
    }
    return;
  }
  const agent = new CodingAgent(client, {
    cwd: options.cwd,
    allowedRoots: options.allowedRoots,
    readOnly: options.readOnly,
    confirmTool: async () => options.autoApprove,
    onEvent: eventPrinter(stderr),
  });
  try {
    stdout.write(`${await agent.run(task)}\n`);
  } finally {
    await client.close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.command === "help") printHelp();
  else if (options.command === "login") await login();
  else if (options.command === "print") await print(options);
  else await interactive(options);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(displayedError(error));
    process.exitCode = 1;
  });
}
