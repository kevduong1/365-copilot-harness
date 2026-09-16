import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalPolicy } from "../src/agent/policy.js";
import type { ToolDefinition } from "../src/agent/types.js";
import type { CopilotClient } from "../src/client.js";
import type { TokenUsageEstimate } from "../src/tokens.js";
import { TuiHarness, type TuiHarnessDependencies } from "../src/tui/harness.js";
import { createState, type TuiState } from "../src/tui/types.js";

const usage: TokenUsageEstimate = {
  conversationTokens: 0,
  contextWindowTokens: 32_000,
  remainingTokens: 32_000,
  usagePercent: 0,
  compactionThresholdTokens: 19_200,
  compactionThresholdPercent: 60,
  messageCount: 0,
};

class FakeClient {
  readonly responses: string[];
  closeCount = 0;

  constructor(responses: string[] = []) {
    this.responses = [...responses];
  }

  async newChat(): Promise<void> {}

  async sendAndWait(): Promise<string> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake response");
    return response;
  }

  getTokenUsage(): TokenUsageEstimate {
    return usage;
  }

  needsCompaction(): boolean {
    return false;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  dependencies: TuiHarnessDependencies,
  policy = new ApprovalPolicy(),
): {
  harness: TuiHarness;
  state: () => TuiState;
} {
  let state = createState({
    autoApprove: false,
    readOnly: false,
    rawChat: false,
    cwd: process.cwd(),
    allowedRoots: [],
  });
  const setState = (update: (current: TuiState) => TuiState): void => {
    state = update(state);
  };
  return {
    harness: new TuiHarness(setState, () => state, process.cwd(), [], false, dependencies, policy),
    state: () => state,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("TuiHarness coalesces concurrent launches", async () => {
  const pending = deferred<CopilotClient>();
  const client = new FakeClient();
  let launches = 0;
  const { harness, state } = fixture({
    launchClient: async () => {
      launches += 1;
      return pending.promise;
    },
    createTools: async () => [],
  });

  const first = harness.launch();
  const second = harness.launch(true);
  assert.equal(launches, 1);
  pending.resolve(client as unknown as CopilotClient);
  await Promise.all([first, second]);

  assert.equal(state().ready, true);
  assert.equal(client.closeCount, 0);
  await harness.close();
  assert.equal(client.closeCount, 1);
});

test("TuiHarness upgrades a concurrent login request after a background launch fails", async () => {
  const client = new FakeClient();
  const waitModes: boolean[] = [];
  const { harness, state } = fixture({
    launchClient: async (options) => {
      waitModes.push(options?.waitForLogin === true);
      if (waitModes.length === 1) throw new Error("saved session expired");
      return client as unknown as CopilotClient;
    },
    createTools: async () => [],
  });

  const background = harness.launch(false);
  const interactive = harness.launch(true);
  await Promise.all([background, interactive]);

  assert.deepEqual(waitModes, [false, true]);
  assert.equal(state().ready, true);
  await harness.close();
});

test("TuiHarness closes a late launch after shutdown", async () => {
  const pending = deferred<CopilotClient>();
  const client = new FakeClient();
  const { harness, state } = fixture({
    launchClient: async () => pending.promise,
    createTools: async () => [],
  });

  const launching = harness.launch();
  await harness.close();
  pending.resolve(client as unknown as CopilotClient);
  await launching;

  assert.equal(client.closeCount, 1);
  assert.equal(state().ready, false);
});

test("TuiHarness closes a partially initialized client when tool creation fails", async () => {
  const client = new FakeClient();
  const { harness, state } = fixture({
    launchClient: async () => client as unknown as CopilotClient,
    createTools: async () => {
      throw new Error("tool initialization failed");
    },
  });

  await harness.launch();

  assert.equal(client.closeCount, 1);
  assert.equal(state().ready, false);
  assert.match(state().launchError, /tool initialization failed/);
});

function bashTool(commands: string[]): ToolDefinition {
  return {
    name: "bash",
    description: "run a shell command",
    parameters: "command",
    mutates: true,
    execute: async (args) => {
      commands.push(String(args.command));
      return "ran";
    },
  };
}

function bashRequest(command: string): string {
  return `HARNESS_REQUEST\n${JSON.stringify({ operation: "bash", arguments: { command } })}\nEND_HARNESS_REQUEST`;
}

test("TuiHarness auto-approves safe commands through the policy without a card", async () => {
  const client = new FakeClient([bashRequest("git status --short"), "Nothing to report."]);
  const commands: string[] = [];
  const { harness, state } = fixture({
    launchClient: async () => client as unknown as CopilotClient,
    createTools: async () => [bashTool(commands)],
  });
  await harness.launch();

  await harness.send("check the tree", "agent");

  assert.deepEqual(commands, ["git status --short"]);
  // No permission card was ever raised for a read-only command.
  assert.equal(state().nextApprovalId, 1);
  assert.equal(state().approval, undefined);
  await harness.close();
});

test("TuiHarness asks for an unsafe command when safe auto-approval is off", async () => {
  const client = new FakeClient([bashRequest("ls -la"), "Listed."]);
  const commands: string[] = [];
  const { harness, state } = fixture(
    {
      launchClient: async () => client as unknown as CopilotClient,
      createTools: async () => [bashTool(commands)],
    },
    new ApprovalPolicy({ autoApproveSafeCommands: false }),
  );
  await harness.launch();

  const sending = harness.send("list files", "agent");
  await waitFor(() => state().approval !== undefined);
  const approval = state().approval;
  assert.deepEqual(
    approval?.options.map((option) => option.decision),
    ["allow", "deny", "always"],
  );
  harness.resolveApproval(approval!.id, "allow");
  await sending;

  assert.deepEqual(commands, ["ls -la"]);
  // "Allow once" grants nothing beyond this call.
  assert.deepEqual(harness.policy.rules().commandPrefixes, []);
  await harness.close();
});

test("TuiHarness learns a command prefix from an always-allow answer", async () => {
  const client = new FakeClient([
    bashRequest("git commit -m 'one'"),
    bashRequest("git commit -m 'two'"),
    "Both commits landed.",
  ]);
  const commands: string[] = [];
  const { harness, state } = fixture({
    launchClient: async () => client as unknown as CopilotClient,
    createTools: async () => [bashTool(commands)],
  });
  await harness.launch();

  const sending = harness.send("commit twice", "agent");
  await waitFor(() => state().approval !== undefined);
  const approval = state().approval;
  assert.equal(approval?.options[2]?.label, 'Always allow bash "git commit …"');
  harness.resolveApproval(approval!.id, "always");
  await sending;

  assert.deepEqual(commands, ["git commit -m 'one'", "git commit -m 'two'"]);
  assert.deepEqual(harness.policy.rules().commandPrefixes, [
    { tool: "bash", prefix: "git commit" },
  ]);
  // The second commit reused the rule instead of raising a second card.
  assert.equal(state().nextApprovalId, 2);
  await harness.close();
});

test("TuiHarness queues overlapping approvals so both resolve", async () => {
  // One response asking for a concurrency-safe tool and a sequential one, which
  // the runner starts in parallel: two approval requests, one card slot.
  const client = new FakeClient([
    `${bashRequest("git commit -m 'x'")}\nHARNESS_REQUEST\n${JSON.stringify({ operation: "delegate", arguments: { task: "explore" } })}\nEND_HARNESS_REQUEST`,
    "Both finished.",
  ]);
  const commands: string[] = [];
  const delegated: string[] = [];
  const delegate: ToolDefinition = {
    name: "delegate",
    description: "delegate to a subagent",
    parameters: "task",
    mutates: true,
    concurrencySafe: true,
    execute: async (args) => {
      delegated.push(String(args.task));
      return "delegated";
    },
  };
  const { harness, state } = fixture({
    launchClient: async () => client as unknown as CopilotClient,
    createTools: async () => [bashTool(commands), delegate],
  });
  await harness.launch();

  const sending = harness.send("do both", "agent");
  const seen: string[] = [];
  let lastId = 0;
  for (let answered = 0; answered < 2; answered += 1) {
    // Each card carries a new id, so the second request waited for the first
    // rather than overwriting it.
    await waitFor(() => {
      const pending = state().approval;
      return pending !== undefined && pending.id !== lastId;
    });
    const approval = state().approval;
    assert.ok(approval !== undefined);
    seen.push(approval.call.name);
    lastId = approval.id;
    harness.resolveApproval(approval.id, "allow");
  }
  await sending;

  // Both requests were shown and answered instead of one being overwritten.
  assert.deepEqual(seen.toSorted(), ["bash", "delegate"]);
  assert.deepEqual(commands, ["git commit -m 'x'"]);
  assert.deepEqual(delegated, ["explore"]);
  assert.equal(state().nextApprovalId, 3);
  await harness.close();
});

test("TuiHarness offers no always-allow row when there is no rule to learn", async () => {
  // A blank command has no prefix, and "always allow bash" would grant every
  // command the model can write, so the card must offer only two answers.
  const client = new FakeClient([bashRequest("   "), "Nothing ran."]);
  const commands: string[] = [];
  const { harness, state } = fixture({
    launchClient: async () => client as unknown as CopilotClient,
    createTools: async () => [bashTool(commands)],
  });
  await harness.launch();

  const sending = harness.send("run nothing", "agent");
  await waitFor(() => state().approval !== undefined);
  const approval = state().approval;
  assert.deepEqual(
    approval?.options.map((option) => option.decision),
    ["allow", "deny"],
  );
  // Even a stray "always" cannot learn a tool-wide rule from this card.
  harness.resolveApproval(approval!.id, "always");
  await sending;

  assert.deepEqual(harness.policy.rules().tools, []);
  assert.deepEqual(harness.policy.rules().commandPrefixes, []);
  await harness.close();
});

test("TuiHarness close aborts a tool that is still running", async () => {
  const client = new FakeClient([bashRequest("sleep forever"), "Never reached."]);
  let toolSignal: AbortSignal | undefined;
  let released = false;
  const blocking: ToolDefinition = {
    name: "bash",
    description: "blocks until the run is aborted",
    parameters: "command",
    mutates: true,
    execute: async (_args, context) => {
      toolSignal = context?.signal;
      await new Promise<void>((resolve) => {
        if (context?.signal === undefined) {
          resolve();
          return;
        }
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      released = true;
      return "aborted";
    },
  };
  const { harness, state } = fixture(
    {
      launchClient: async () => client as unknown as CopilotClient,
      createTools: async () => [blocking],
    },
    // Auto-approve the call so the run reaches the tool without a card.
    new ApprovalPolicy({ commandPrefixes: [{ tool: "bash", prefix: "sleep" }] }),
  );
  await harness.launch();

  const sending = harness.send("start the long tool", "agent");
  await waitFor(() => toolSignal !== undefined);
  assert.equal(toolSignal?.aborted, false);

  // Quitting must not leave the child running and the process hanging.
  await harness.close();
  assert.equal(toolSignal?.aborted, true);
  await sending;
  assert.equal(released, true);
  // A cancelled shutdown prints no error entry.
  assert.equal(state().entries.some((entry) => entry.kind === "warning"), false);
});

test("TuiHarness applyPermissions lists, clears, and toggles the session rules", async () => {
  const { harness, state } = fixture({
    launchClient: async () => new FakeClient() as unknown as CopilotClient,
    createTools: async () => [],
  });
  harness.policy.allowCommandPrefix("git commit");
  harness.policy.allowTool("write");

  harness.applyPermissions("show");
  const listed = state().entries.at(-1);
  assert.equal(listed?.kind, "system");
  assert.match(listed?.kind === "system" ? listed.message : "", /Always-allowed tools: write/);
  assert.match(listed?.kind === "system" ? listed.message : "", /"git commit …"/);

  harness.applyPermissions("safe-off");
  assert.equal(harness.policy.rules().autoApproveSafeCommands, false);
  harness.applyPermissions("clear");
  assert.deepEqual(harness.policy.rules().commandPrefixes, []);
  assert.match(
    state().entries.at(-1)?.kind === "system" ? (state().entries.at(-1) as { message: string }).message : "",
    /Cleared the session permission rules/,
  );
});

test("TuiHarness runs a ! command locally and records it as a tool entry", async () => {
  const { harness, state } = fixture({
    launchClient: async () => new FakeClient() as unknown as CopilotClient,
    createTools: async () => [],
  });

  await harness.runShell("echo harness-shell-ok");
  const ok = state().entries.at(-1);
  assert.equal(ok?.kind, "tool");
  if (ok?.kind !== "tool") throw new Error("expected a tool entry");
  assert.equal(ok.call.name, "shell");
  assert.equal(ok.call.arguments.command, "echo harness-shell-ok");
  assert.equal(ok.status, "ok");
  assert.match(ok.output, /harness-shell-ok/);

  await harness.runShell("exit 3");
  const failed = state().entries.at(-1);
  assert.equal(failed?.kind === "tool" ? failed.status : "", "error");
});

test("TuiHarness cancellation declines a pending approval", async () => {
  const client = new FakeClient([
    'HARNESS_REQUEST\n{"operation":"mutate","arguments":{}}\nEND_HARNESS_REQUEST',
    "Task stopped safely.",
  ]);
  let executed = false;
  const mutate: ToolDefinition = {
    name: "mutate",
    description: "mutate test state",
    parameters: "none",
    mutates: true,
    execute: async () => {
      executed = true;
      return "mutated";
    },
  };
  const { harness, state } = fixture({
    launchClient: async () => client as unknown as CopilotClient,
    createTools: async () => [mutate],
  });
  await harness.launch();

  const sending = harness.send("make a change", "agent");
  await waitFor(() => state().approval !== undefined);
  harness.cancel();
  await sending;

  assert.equal(executed, false);
  assert.equal(state().approval, undefined);
  await harness.close();
});
