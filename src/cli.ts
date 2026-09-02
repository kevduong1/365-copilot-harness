#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CodingAgent } from "./agent/runner.js";
import {
  SubagentManager,
  createOrchestratorTools,
  type SubagentLifecycleEvent,
  type SubagentRecord,
} from "./agent/subagent.js";
import type { AgentEvent, ToolCall, ToolDefinition } from "./agent/types.js";
import { CopilotClient } from "./client.js";
import { ResponseTimeoutError } from "./errors.js";
import { runTui } from "./tui/index.js";

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

Interactive sessions use a fullscreen TUI (requires a TTY). Use --print for scripts.

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

function eventPrinter(
  destination: NodeJS.WritableStream,
  label = "",
): (event: AgentEvent) => void {
  const tag = (kind: string): string => (label === "" ? `[${kind}]` : `[${label} ${kind}]`);
  return (event) => {
    if (event.type === "tool_start") {
      destination.write(`\n${tag("tool")} ${callSummary(event.call)}\n`);
    } else if (event.type === "tool_end") {
      destination.write(
        `${event.result.ok ? tag("ok") : tag("error")} ${displayedOutput(event.result.output)}\n`,
      );
    } else if (event.type === "warning") {
      destination.write(`${tag("warning")} ${event.message}\n`);
    } else if (event.type === "compaction" && event.phase === "start") {
      const usage = event.before;
      const amount = usage === undefined ? "" : ` at ~${usage.conversationTokens.toLocaleString("en-US")} tokens`;
      destination.write(
        `${tag("compaction")} ${event.automatic ? "Auto-compacting" : "Compacting"}${amount}; summarizing into a new browser chat...\n`,
      );
    } else if (event.type === "compaction" && event.phase === "complete") {
      const usage = event.after;
      const amount = usage === undefined ? "" : ` (~${usage.conversationTokens.toLocaleString("en-US")} tokens retained)`;
      destination.write(`${tag("compaction")} Continued in a new browser chat${amount}.\n`);
    }
  };
}

function taskSummary(task: string, maximum = 80): string {
  const flattened = task.replaceAll(/\s+/g, " ").trim();
  return flattened.length <= maximum ? flattened : `${flattened.slice(0, maximum)}…`;
}

function subagentTokens(record: SubagentRecord): string {
  return record.tokenUsage === undefined
    ? ""
    : `, ~${record.tokenUsage.conversationTokens.toLocaleString("en-US")} tokens`;
}

function lifecyclePrinter(
  destination: NodeJS.WritableStream,
): (record: SubagentRecord, event: SubagentLifecycleEvent) => void {
  return (record, event) => {
    const label = `[agent#${record.id}]`;
    if (event === "started") {
      destination.write(`\n${label} ${record.name} started: ${taskSummary(record.tasks.at(-1) ?? "")}\n`);
    } else if (event === "completed") {
      destination.write(
        `${label} ${record.name} completed in ${record.steps} step${record.steps === 1 ? "" : "s"}${subagentTokens(record)}\n`,
      );
    } else if (event === "failed") {
      destination.write(`${label} ${record.name} failed: ${record.lastError ?? "unknown error"}\n`);
    }
  };
}

function createSubagentManager(
  client: CopilotClient,
  options: CliOptions,
  confirmTool: (call: ToolCall, definition: ToolDefinition) => Promise<boolean>,
  destination: NodeJS.WritableStream,
): SubagentManager {
  const lifecycle = lifecyclePrinter(destination);
  return new SubagentManager({
    openSession: () => client.newTabSession(),
    cwd: options.cwd,
    allowedRoots: options.allowedRoots,
    readOnly: options.readOnly,
    confirmTool,
    onEvent: (record, event) => eventPrinter(destination, `agent#${record.id}`)(event),
    onLifecycle: lifecycle,
  });
}

function approvalPrompt(autoApprove: boolean): (call: ToolCall, definition: ToolDefinition) => Promise<boolean> {
  return async () => autoApprove;
}

async function interactive(options: CliOptions): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY. Use --print for non-interactive runs.");
  }
  await runTui({
    autoApprove: options.autoApprove,
    readOnly: options.readOnly,
    rawChat: options.rawChat,
    cwd: options.cwd,
    allowedRoots: options.allowedRoots,
  });
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
  try {
    if (options.rawChat) {
      stdout.write(`${await client.sendAndWait(task)}\n`);
      return;
    }
    const confirmTool = approvalPrompt(options.autoApprove);
    const manager = createSubagentManager(client, options, confirmTool, stderr);
    const agent = new CodingAgent(client, {
      cwd: options.cwd,
      allowedRoots: options.allowedRoots,
      readOnly: options.readOnly,
      confirmTool,
      onEvent: eventPrinter(stderr),
      tools: await createOrchestratorTools(manager, options.cwd, options.allowedRoots),
    });
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
