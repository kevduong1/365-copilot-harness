import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodingAgent } from "../src/agent/runner.js";
import {
  SubagentManager,
  createSubagentTool,
  type SubagentSession,
} from "../src/agent/subagent.js";
import type { AgentBackend, ToolDefinition } from "../src/agent/types.js";

interface ConcurrencyTracker {
  active: number;
  peak: number;
}

class ScriptedSession implements SubagentSession {
  readonly prompts: string[] = [];
  newChats = 0;
  closed = false;

  constructor(
    private readonly responses: string[],
    private readonly delayMs = 0,
    private readonly tracker?: ConcurrencyTracker,
  ) {}

  async newChat(): Promise<void> {
    this.newChats += 1;
  }

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.tracker !== undefined) {
      this.tracker.active += 1;
      this.tracker.peak = Math.max(this.tracker.peak, this.tracker.active);
    }
    if (this.delayMs > 0) await delay(this.delayMs);
    if (this.tracker !== undefined) this.tracker.active -= 1;
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted subagent response");
    return response;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ScriptedBackend implements AgentBackend {
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {}

  async newChat(): Promise<void> {}

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }
}

const probe: ToolDefinition = {
  name: "probe",
  description: "test probe",
  parameters: "none",
  mutates: false,
  execute: async () => "probe-result",
};

test("SubagentManager runs a task in a fresh conversation and supports follow-ups", async () => {
  const session = new ScriptedSession([
    'HARNESS_REQUEST\n{"operation":"probe","arguments":{}}\nEND_HARNESS_REQUEST',
    "Report: the answer is 42.",
    "Follow-up: still 42.",
  ]);
  const lifecycle: string[] = [];
  const manager = new SubagentManager({
    openSession: async () => session,
    createTools: () => [probe],
    onLifecycle: (record, event) => {
      lifecycle.push(`${record.id}:${event}`);
    },
  });

  const run = await manager.spawn("Compute the answer", "answers");
  assert.equal(run.response, "Report: the answer is 42.");
  assert.equal(run.record.status, "completed");
  assert.equal(run.record.name, "answers");
  assert.equal(run.record.steps, 2);
  assert.equal(run.record.sessionOpen, true);
  // The subagent gets the full protocol prompt plus its orchestration role.
  assert.match(session.prompts[0] ?? "", /coding_harness_system/);
  assert.match(session.prompts[0] ?? "", /<subagent_role>/);
  assert.match(session.prompts[0] ?? "", /<user_task>\nCompute the answer\n<\/user_task>/);
  assert.match(session.prompts[1] ?? "", /probe-result/);

  const followUp = await manager.followUp(run.record.id, "Confirm it");
  assert.equal(followUp.response, "Follow-up: still 42.");
  // A follow-up continues the existing conversation without re-bootstrapping.
  assert.doesNotMatch(session.prompts[2] ?? "", /coding_harness_system/);
  assert.match(session.prompts[2] ?? "", /Confirm it/);
  assert.deepEqual(lifecycle, ["1:queued", "1:started", "1:completed", "1:started", "1:completed"]);

  await assert.rejects(manager.followUp(99, "task"), /Unknown subagent id 99/);
});

test("SubagentManager closes the stalest idle conversation beyond the limit", async () => {
  const sessions = [new ScriptedSession(["First report."]), new ScriptedSession(["Second report."])];
  let opened = 0;
  const manager = new SubagentManager({
    openSession: async () => sessions[opened++]!,
    createTools: () => [],
    maxIdleSessions: 1,
  });

  const first = await manager.spawn("First task");
  const second = await manager.spawn("Second task");
  assert.equal(sessions[0]!.closed, true);
  assert.equal(sessions[1]!.closed, false);
  assert.equal(first.record.sessionOpen, false);
  assert.equal(second.record.sessionOpen, true);
  assert.equal(manager.list().length, 2);

  await assert.rejects(manager.followUp(first.record.id, "more"), /conversation is closed/);
  await manager.closeAll();
  assert.equal(sessions[1]!.closed, true);
});

test("The agent operation fans subagents out in parallel and reports in call order", async () => {
  const tracker: ConcurrencyTracker = { active: 0, peak: 0 };
  const sessions = [
    new ScriptedSession(["Alpha report."], 25, tracker),
    new ScriptedSession(["Beta report."], 25, tracker),
  ];
  let opened = 0;
  const manager = new SubagentManager({
    openSession: async () => sessions[opened++]!,
    createTools: () => [],
    maxConcurrent: 2,
  });
  const backend = new ScriptedBackend([
    'HARNESS_REQUEST\n{"operation":"agent","arguments":{"task":"Explore alpha","name":"alpha"}}\nEND_HARNESS_REQUEST\nHARNESS_REQUEST\n{"operation":"agent","arguments":{"task":"Explore beta","name":"beta"}}\nEND_HARNESS_REQUEST',
    "Both areas explored.",
  ]);
  const orchestrator = new CodingAgent(backend, { tools: [createSubagentTool(manager)] });

  assert.equal(await orchestrator.run("Explore both areas"), "Both areas explored.");
  assert.equal(tracker.peak, 2);
  // The orchestrator's system prompt encourages delegation when agent exists.
  assert.match(backend.prompts[0] ?? "", /Delegate a self-contained subtask/);
  const observation = backend.prompts[1] ?? "";
  assert.match(
    observation,
    /Subagent #1 \(alpha\)[\s\S]*Alpha report\.[\s\S]*Subagent #2 \(beta\)[\s\S]*Beta report\./,
  );
  assert.match(observation, /still open for follow-ups via agent_id 1/);
});

test("SubagentManager bounds parallelism with maxConcurrent", async () => {
  const tracker: ConcurrencyTracker = { active: 0, peak: 0 };
  const sessions = [
    new ScriptedSession(["Alpha report."], 10, tracker),
    new ScriptedSession(["Beta report."], 10, tracker),
  ];
  let opened = 0;
  const manager = new SubagentManager({
    openSession: async () => sessions[opened++]!,
    createTools: () => [],
    maxConcurrent: 1,
  });

  await Promise.all([manager.spawn("Explore alpha"), manager.spawn("Explore beta")]);
  assert.equal(tracker.peak, 1);
});

test("A failed subagent surfaces as a tool error the orchestrator can react to", async () => {
  const manager = new SubagentManager({
    openSession: async () => {
      throw new Error("no more tabs");
    },
    createTools: () => [],
  });
  const backend = new ScriptedBackend([
    'HARNESS_REQUEST\n{"operation":"agent","arguments":{"task":"Explore"}}\nEND_HARNESS_REQUEST',
    "Understood; delegation is unavailable.",
  ]);
  const orchestrator = new CodingAgent(backend, { tools: [createSubagentTool(manager)] });

  assert.equal(await orchestrator.run("Explore"), "Understood; delegation is unavailable.");
  assert.match(backend.prompts[1] ?? "", /"ok":false/);
  assert.match(backend.prompts[1] ?? "", /Subagent #1 \(agent-1\) failed: no more tabs/);
  assert.equal(manager.get(1)?.status, "failed");
});

test("Subagent approvals are serialized through the parent confirm callback", async () => {
  const tracker: ConcurrencyTracker = { active: 0, peak: 0 };
  const mutate: ToolDefinition = {
    name: "mutate",
    description: "test mutation",
    parameters: "none",
    mutates: true,
    execute: async () => "mutated",
  };
  const sessions = [
    new ScriptedSession([
      'HARNESS_REQUEST\n{"operation":"mutate","arguments":{}}\nEND_HARNESS_REQUEST',
      "Alpha done.",
    ]),
    new ScriptedSession([
      'HARNESS_REQUEST\n{"operation":"mutate","arguments":{}}\nEND_HARNESS_REQUEST',
      "Beta done.",
    ]),
  ];
  let opened = 0;
  const manager = new SubagentManager({
    openSession: async () => sessions[opened++]!,
    createTools: () => [mutate],
    maxConcurrent: 2,
    confirmTool: async () => {
      tracker.active += 1;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      await delay(10);
      tracker.active -= 1;
      return true;
    },
  });

  const [alpha, beta] = await Promise.all([
    manager.spawn("Mutate alpha"),
    manager.spawn("Mutate beta"),
  ]);
  assert.equal(alpha.response, "Alpha done.");
  assert.equal(beta.response, "Beta done.");
  assert.equal(tracker.peak, 1);
});

test("SubagentManager closes a session when agent initialization fails", async () => {
  const session = new ScriptedSession([]);
  const lifecycle: string[] = [];
  const manager = new SubagentManager({
    openSession: async () => session,
    createTools: () => {
      throw new Error("workspace initialization failed");
    },
    onLifecycle: (_record, event) => {
      lifecycle.push(event);
    },
  });

  await assert.rejects(manager.spawn("Inspect workspace"), /workspace initialization failed/);
  assert.equal(session.closed, true);
  assert.equal(manager.get(1)?.sessionOpen, false);
  assert.deepEqual(lifecycle, ["queued", "started", "failed", "closed"]);
});

test("SubagentManager lifecycle observer failures do not leak semaphore permits", async () => {
  const sessions = [new ScriptedSession(["First done."]), new ScriptedSession(["Second done."])];
  let opened = 0;
  const manager = new SubagentManager({
    openSession: async () => sessions[opened++]!,
    createTools: () => [],
    maxConcurrent: 1,
    onLifecycle: () => {
      throw new Error("observer failed");
    },
  });

  const first = await manager.spawn("First");
  const second = await manager.spawn("Second");

  assert.equal(first.response, "First done.");
  assert.equal(second.response, "Second done.");
  assert.equal(opened, 2);
});
