import assert from "node:assert/strict";
import test from "node:test";
import { CodingAgent } from "../src/agent/runner.js";
import type { AgentBackend, AgentEvent, ToolDefinition } from "../src/agent/types.js";

class ScriptedBackend implements AgentBackend {
  readonly prompts: string[] = [];
  newChats = 0;

  constructor(private readonly responses: string[]) {}

  async newChat(): Promise<void> {
    this.newChats += 1;
  }

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }
}

test("CodingAgent loops through tools and preserves conversation for follow-up tasks", async () => {
  const backend = new ScriptedBackend([
    "HARNESS_READY",
    'HARNESS_REQUEST\n{"operation":"grep","arguments":{"pattern":"CopilotClient"}}\nEND_HARNESS_REQUEST',
    "The client composes browser transport and locking.",
    "The follow-up remains in the same coding conversation.",
  ]);
  const events: AgentEvent[] = [];
  const tools: ToolDefinition[] = [
    {
      name: "grep",
      description: "test grep",
      parameters: '{"pattern":"text"}',
      mutates: false,
      execute: async () => "src/client.ts: CopilotClient",
    },
  ];
  const agent = new CodingAgent(backend, {
    tools,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(await agent.run("Explain the client"), "The client composes browser transport and locking.");
  assert.match(backend.prompts[0] ?? "", /coding_harness_system/);
  assert.match(backend.prompts[0] ?? "", /external local controller/);
  assert.match(backend.prompts[0] ?? "", /not a claim about your native toolset/);
  assert.match(backend.prompts[2] ?? "", /src\/client\.ts: CopilotClient/);
  assert.equal(events.filter((event) => event.type === "tool_end").length, 1);

  assert.equal(
    await agent.run("What about follow-ups?"),
    "The follow-up remains in the same coding conversation.",
  );
  assert.doesNotMatch(backend.prompts[3] ?? "", /coding_harness_system/);
  assert.equal(backend.newChats, 1);
});

test("CodingAgent asks before executing mutating tools", async () => {
  const backend = new ScriptedBackend([
    "HARNESS_READY",
    '<tool_call>{"name":"write","arguments":{"path":"x","content":"y"}}</tool_call>',
    "I could not write because approval was declined.",
  ]);
  let executed = false;
  const tool: ToolDefinition = {
    name: "write",
    description: "write",
    parameters: "{}",
    mutates: true,
    execute: async () => {
      executed = true;
      return "written";
    },
  };
  const agent = new CodingAgent(backend, {
    tools: [tool],
    confirmTool: async () => false,
  });

  await agent.run("Write x");
  assert.equal(executed, false);
  assert.match(backend.prompts[2] ?? "", /User declined write/);
});

test("CodingAgent corrects a false claim that local tools are unavailable", async () => {
  const backend = new ScriptedBackend([
    "HARNESS_READY",
    "I cannot access the local execution environment.",
    'HARNESS_REQUEST\n{"operation":"read","arguments":{"path":"README.md"}}\nEND_HARNESS_REQUEST',
    "The repository is a browser-backed coding harness.",
  ]);
  const warnings: string[] = [];
  const read: ToolDefinition = {
    name: "read",
    description: "read",
    parameters: "{}",
    mutates: false,
    execute: async () => "README contents",
  };
  const agent = new CodingAgent(backend, {
    tools: [read],
    onEvent: (event) => {
      if (event.type === "warning") warnings.push(event.message);
    },
  });

  assert.equal(await agent.run("Summarize the repository"), "The repository is a browser-backed coding harness.");
  assert.match(backend.prompts[2] ?? "", /HARNESS_PROTOCOL_CORRECTION/);
  assert.match(warnings.join("\n"), /unavailable/);
});

test("CodingAgent reset does not open the new chat twice", async () => {
  const backend = new ScriptedBackend(["HARNESS_READY", "Reset task complete."]);
  const agent = new CodingAgent(backend, { tools: [] });

  await agent.reset();
  assert.equal(await agent.run("Continue in the reset chat"), "Reset task complete.");
  assert.equal(backend.newChats, 1);
});
