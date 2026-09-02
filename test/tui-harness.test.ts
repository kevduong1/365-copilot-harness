import assert from "node:assert/strict";
import test from "node:test";
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

function fixture(dependencies: TuiHarnessDependencies): {
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
    harness: new TuiHarness(setState, () => state, process.cwd(), [], false, dependencies),
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
