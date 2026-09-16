import assert from "node:assert/strict";
import test from "node:test";
import { CodingAgent } from "../src/agent/runner.js";
import type { AgentBackend, AgentEvent, ToolDefinition } from "../src/agent/types.js";
import type {
  ConversationCompactionOptions,
  ConversationCompactionResult,
} from "../src/compaction.js";
import type { TokenUsageEstimate } from "../src/tokens.js";

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
    'HARNESS_REQUEST\n{"operation":"grep","arguments":{"pattern":"CopilotClient"}}\nEND_HARNESS_REQUEST',
    "The client composes browser transport and locking.",
    "The follow-up remains in the same coding conversation.",
  ]);
  const events: AgentEvent[] = [];
  const tools: ToolDefinition[] = [
    {
      name: "grep",
      description: "test grep",
      parameters: "pattern",
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
  // Initialization rides along with the first task rather than costing its own round trip.
  assert.match(backend.prompts[0] ?? "", /coding_harness_system/);
  assert.match(backend.prompts[0] ?? "", /<user_task>\nExplain the client\n<\/user_task>/);
  assert.match(backend.prompts[0] ?? "", /external local controller/);
  assert.match(backend.prompts[0] ?? "", /not an attempt to invoke a Microsoft Copilot tool/);
  assert.match(backend.prompts[1] ?? "", /src\/client\.ts: CopilotClient/);
  assert.equal(events.filter((event) => event.type === "tool_end").length, 1);

  assert.equal(
    await agent.run("What about follow-ups?"),
    "The follow-up remains in the same coding conversation.",
  );
  assert.doesNotMatch(backend.prompts[2] ?? "", /coding_harness_system/);
  assert.equal(backend.prompts.length, 3);
  assert.equal(backend.newChats, 1);
});

test("CodingAgent asks before executing mutating tools", async () => {
  const backend = new ScriptedBackend([
    '<tool_call>{"name":"write","arguments":{"path":"x","content":"y"}}</tool_call>',
    "I could not write because approval was declined.",
  ]);
  let executed = false;
  const tool: ToolDefinition = {
    name: "write",
    description: "write",
    parameters: "none",
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
  assert.match(backend.prompts[1] ?? "", /User declined write/);
});

test("CodingAgent corrects a false claim that local tools are unavailable", async () => {
  const backend = new ScriptedBackend([
    "I cannot access the local execution environment.",
    'HARNESS_REQUEST\n{"operation":"read","arguments":{"path":"README.md"}}\nEND_HARNESS_REQUEST',
    "The repository is a browser-backed coding harness.",
  ]);
  const warnings: string[] = [];
  const read: ToolDefinition = {
    name: "read",
    description: "read",
    parameters: "none",
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
  assert.match(backend.prompts[1] ?? "", /HARNESS_PROTOCOL_CORRECTION/);
  assert.match(warnings.join("\n"), /unavailable/);
});

test("CodingAgent reset does not open the new chat twice", async () => {
  const backend = new ScriptedBackend(["Reset task complete."]);
  const agent = new CodingAgent(backend, { tools: [] });

  await agent.reset();
  assert.equal(await agent.run("Continue in the reset chat"), "Reset task complete.");
  assert.equal(backend.newChats, 1);
});

test("CodingAgent advertises persistent directory tools and granted roots", async () => {
  const backend = new ScriptedBackend(["Done."]);
  const tools: ToolDefinition[] = [
    {
      name: "cd",
      description: "change directory",
      parameters: "path",
      mutates: false,
      execute: async () => "changed",
    },
  ];
  const agent = new CodingAgent(backend, {
    cwd: "/workspace/one",
    allowedRoots: ["/workspace/two"],
    tools,
  });

  await agent.run("Inspect another project");
  assert.match(backend.prompts[0] ?? "", /Use pwd/);
  assert.match(backend.prompts[0] ?? "", /cd to switch projects persistently/);
  assert.match(backend.prompts[0] ?? "", /\/workspace\/two/);
  // Each operation renders on one line as "- name (kind): description — args: signature".
  assert.match(
    backend.prompts[0] ?? "",
    /^- cd \(read-only\): change directory — args: path$/m,
  );
});

test("CodingAgent compacts into a new chat and restores the exact coding context", async () => {
  const backend = new ScriptedBackend([
    "Initial task complete.",
    "The user asked for an audit. The initial task is complete; wait for a follow-up.",
    "HARNESS_READY",
    "Continued from the compacted state.",
  ]);
  const agent = new CodingAgent(backend, { tools: [] });

  assert.equal(await agent.run("Do the initial task"), "Initial task complete.");
  const compacted = await agent.compact();
  assert.match(compacted.summary, /initial task is complete/i);
  assert.match(backend.prompts[1] ?? "", /standalone continuation summary/);
  assert.match(backend.prompts[2] ?? "", /<coding_harness_system>/);
  assert.match(backend.prompts[2] ?? "", /<compacted_conversation_summary>/);
  assert.match(backend.prompts[2] ?? "", /HARNESS_READY/);
  assert.equal(backend.newChats, 2);

  assert.equal(await agent.run("Continue"), "Continued from the compacted state.");
  assert.doesNotMatch(backend.prompts[3] ?? "", /<coding_harness_system>/);
});

class AutoCompactingBackend implements AgentBackend {
  readonly prompts: string[] = [];
  compactCalls = 0;
  compactOptions: ConversationCompactionOptions | undefined;
  shouldCompact = false;
  private readonly responses = ["First answer.", "Second answer."];

  async newChat(): Promise<void> {}

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }

  needsCompaction(): boolean {
    return this.shouldCompact;
  }

  async compact(options: ConversationCompactionOptions = {}): Promise<ConversationCompactionResult> {
    this.compactCalls += 1;
    this.compactOptions = options;
    this.shouldCompact = false;
    return { summary: "First task is complete.", acknowledgement: "HARNESS_READY" };
  }
}

test("CodingAgent automatically compacts before the next prompt at the backend threshold", async () => {
  const backend = new AutoCompactingBackend();
  const events: AgentEvent[] = [];
  const agent = new CodingAgent(backend, {
    tools: [],
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(await agent.run("First"), "First answer.");
  backend.shouldCompact = true;
  assert.equal(await agent.run("Second"), "Second answer.");

  assert.equal(backend.compactCalls, 1);
  assert.match(backend.compactOptions?.bootstrapContext ?? "", /<coding_harness_system>/);
  assert.deepEqual(
    events.filter((event) => event.type === "compaction").map((event) => event.phase),
    ["start", "complete"],
  );
});

class ResumingBackend implements AgentBackend {
  readonly prompts: string[] = [];
  newChats = 0;
  compactCalls = 0;
  compactOptions: ConversationCompactionOptions | undefined;
  shouldCompact = false;

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

  needsCompaction(): boolean {
    return this.shouldCompact;
  }

  async compact(options: ConversationCompactionOptions = {}): Promise<ConversationCompactionResult> {
    this.compactCalls += 1;
    this.compactOptions = options;
    this.shouldCompact = false;
    const reply = await this.sendAndWait(`BOOTSTRAP\n${options.resumePrompt ?? ""}`);
    return options.resumePrompt === undefined
      ? { summary: "Prior work summarized.", acknowledgement: reply }
      : { summary: "Prior work summarized.", acknowledgement: reply, response: reply };
  }
}

test("CodingAgent resumes the pending prompt from the compaction bootstrap itself", async () => {
  const backend = new ResumingBackend([
    'HARNESS_REQUEST\n{"operation":"read","arguments":{"path":"a.ts"}}\nEND_HARNESS_REQUEST',
    "Answered from the compacted chat.",
  ]);
  const read: ToolDefinition = {
    name: "read",
    description: "read",
    parameters: "path",
    mutates: false,
    execute: async () => "file body",
  };
  const agent = new CodingAgent(backend, { tools: [read] });

  backend.shouldCompact = true;
  assert.equal(await agent.run("Inspect a.ts"), "Answered from the compacted chat.");
  // Two sends: the initial task, then the bootstrap that carries the observation.
  assert.equal(backend.prompts.length, 2);
  assert.equal(backend.compactCalls, 1);
  assert.match(backend.compactOptions?.resumePrompt ?? "", /HARNESS_OBSERVATION/);
  assert.match(backend.compactOptions?.resumePrompt ?? "", /file body/);
  assert.match(backend.prompts[1] ?? "", /BOOTSTRAP/);
});

test("CodingAgent still takes an acknowledgement turn for a manual compaction", async () => {
  const backend = new ResumingBackend(["First answer.", "HARNESS_READY", "Second answer."]);
  const warnings: string[] = [];
  const agent = new CodingAgent(backend, {
    tools: [],
    onEvent: (event) => {
      if (event.type === "warning") warnings.push(event.message);
    },
  });

  assert.equal(await agent.run("First"), "First answer.");
  const result = await agent.compact();
  assert.equal(result.response, undefined);
  assert.equal(result.acknowledgement, "HARNESS_READY");
  assert.equal(backend.compactOptions?.resumePrompt, undefined);
  assert.equal(await agent.run("Second"), "Second answer.");
  assert.deepEqual(warnings, []);
});

class ThrashingCompactionBackend implements AgentBackend {
  readonly prompts: string[] = [];
  compactCalls = 0;
  shouldCompact = false;

  constructor(private readonly responses: string[]) {}

  async newChat(): Promise<void> {}

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }

  needsCompaction(): boolean {
    return this.shouldCompact;
  }

  getTokenUsage(): TokenUsageEstimate {
    // A summary larger than the configured window: compaction cannot help.
    return {
      conversationTokens: 900,
      contextWindowTokens: 1_000,
      remainingTokens: 100,
      usagePercent: 90,
      compactionThresholdTokens: 600,
      compactionThresholdPercent: 60,
      messageCount: 2,
    };
  }

  async compact(): Promise<ConversationCompactionResult> {
    this.compactCalls += 1;
    return {
      summary: "Oversized summary.",
      acknowledgement: "Resumed answer.",
      response: "Resumed answer.",
    };
  }
}

test("CodingAgent warns and pauses when compaction does not get under the threshold", async () => {
  const backend = new ThrashingCompactionBackend(["First answer.", "Third answer."]);
  const warnings: string[] = [];
  const agent = new CodingAgent(backend, {
    tools: [],
    onEvent: (event) => {
      if (event.type === "warning") warnings.push(event.message);
    },
  });

  assert.equal(await agent.run("First"), "First answer.");
  backend.shouldCompact = true;
  assert.equal(await agent.run("Second"), "Resumed answer.");
  assert.match(warnings.join("\n"), /still at or above the 60% threshold/);

  // The threshold is still exceeded, but the next step must not compact again.
  assert.equal(await agent.run("Third"), "Third answer.");
  assert.equal(backend.compactCalls, 1);
});

class FailingCompactionBackend implements AgentBackend {
  readonly prompts: string[] = [];
  newChats = 0;
  private readonly responses = ["First answer.", "Recovered."];

  async newChat(): Promise<void> {
    this.newChats += 1;
  }

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }

  async compact(): Promise<ConversationCompactionResult> {
    throw new Error("bootstrap failed after New chat");
  }
}

test("CodingAgent hands every tool the run's abort signal", async () => {
  const backend = new ScriptedBackend([
    'HARNESS_REQUEST\n{"operation":"probe","arguments":{}}\nEND_HARNESS_REQUEST',
    "Done.",
  ]);
  const signals: (AbortSignal | undefined)[] = [];
  const probe: ToolDefinition = {
    name: "probe",
    description: "probe",
    parameters: "none",
    mutates: false,
    execute: async (_args, context) => {
      signals.push(context?.signal);
      return "probed";
    },
  };
  const agent = new CodingAgent(backend, { tools: [probe] });

  assert.equal(await agent.run("Probe"), "Done.");
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[0]?.aborted, false);
});

test("CodingAgent abort stops the loop without another browser round trip", async () => {
  const backend = new ScriptedBackend([
    'HARNESS_REQUEST\n{"operation":"slow","arguments":{}}\nEND_HARNESS_REQUEST',
    "This response must never be requested.",
  ]);
  let aborted = false;
  const slow: ToolDefinition = {
    name: "slow",
    description: "aborts the run from inside the tool",
    parameters: "none",
    mutates: false,
    execute: async (_args, context) => {
      agent.abort("test");
      aborted = context?.signal?.aborted === true;
      return "partial work";
    },
  };
  const agent = new CodingAgent(backend, { tools: [slow] });

  await assert.rejects(agent.run("Start"), (error: Error) => {
    assert.equal(error.name, "AgentCancelledError");
    assert.match(error.message, /cancelled/i);
    return true;
  });
  // The tool saw the signal, and the observation was never sent back.
  assert.equal(aborted, true);
  assert.equal(backend.prompts.length, 1);
  assert.equal(agent.aborted, true);
});

test("CodingAgent abort before a send stops that run and the next one starts clean", async () => {
  const backend = new ScriptedBackend(["Second answer."]);
  const agent = new CodingAgent(backend, { tools: [] });

  // An abort with no run in flight must not poison the next run.
  agent.abort();
  assert.equal(await agent.run("First"), "Second answer.");
  assert.equal(agent.aborted, false);
  assert.equal(backend.prompts.length, 1);
});

test("CodingAgent fully reinitializes after an ambiguous compaction failure", async () => {
  const backend = new FailingCompactionBackend();
  const agent = new CodingAgent(backend, { tools: [] });

  assert.equal(await agent.run("First"), "First answer.");
  await assert.rejects(agent.compact(), /bootstrap failed/);
  assert.equal(await agent.run("Recover"), "Recovered.");
  assert.match(backend.prompts[1] ?? "", /<coding_harness_system>/);
  assert.equal(backend.newChats, 2);
});
