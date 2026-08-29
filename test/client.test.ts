import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { ChatAdapter } from "../src/adapter.js";
import { CopilotClient, type LaunchOptions } from "../src/client.js";
import { estimateMessageTokens } from "../src/tokens.js";

class FakeAdapter implements ChatAdapter {
  readonly prompts: string[] = [];
  newChats = 0;
  failNext = false;
  private response = "";

  constructor(private readonly responses: string[]) {}

  async ensureReady(): Promise<void> {}

  async newChat(): Promise<void> {
    this.newChats += 1;
    this.response = "";
  }

  async *send(prompt: string): AsyncIterable<string> {
    this.prompts.push(prompt);
    this.response = "";
    if (this.failNext) {
      this.failNext = false;
      throw new Error("submission failed");
    }
    this.response = this.nextResponse();
    yield this.response.slice(0, 2);
    yield this.response.slice(2);
  }

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.response = "";
    if (this.failNext) {
      this.failNext = false;
      throw new Error("submission failed");
    }
    this.response = this.nextResponse();
    return this.response;
  }

  lastResponse(): string {
    return this.response;
  }

  private nextResponse(): string {
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }
}

type ClientConstructor = new (
  context: BrowserContext,
  page: Page,
  adapter: ChatAdapter,
  options: LaunchOptions,
) => CopilotClient;

function testClient(adapter: ChatAdapter, options: LaunchOptions = {}): CopilotClient {
  const Constructor = CopilotClient as unknown as ClientConstructor;
  return new Constructor({} as BrowserContext, {} as Page, adapter, options);
}

test("CopilotClient tracks authoritative request and response text and resets on new chat", async () => {
  const adapter = new FakeAdapter(["streamed response"]);
  const client = testClient(adapter, {
    contextWindowTokens: 100,
    autoCompactPercent: 20,
  });
  let rendered = "";
  for await (const delta of client.send("hello")) rendered += delta;

  assert.equal(rendered, "streamed response");
  assert.equal(
    client.getTokenUsage().conversationTokens,
    estimateMessageTokens("hello") + estimateMessageTokens("streamed response"),
  );
  assert.equal(client.needsCompaction("a".repeat(100)), true);

  await client.newChat();
  assert.equal(client.getTokenUsage().messageCount, 0);
  assert.equal(adapter.newChats, 1);
});

test("CopilotClient compaction summarizes, opens a new chat, and tracks only restored context", async () => {
  const adapter = new FakeAdapter([
    "Initial answer.",
    "The initial question was answered; continue with the user's next request.",
    "COMPACTION_READY",
  ]);
  const client = testClient(adapter);
  await client.sendAndWait("Initial question");

  const result = await client.compact();
  assert.equal(result.before.messageCount, 2);
  assert.equal(result.acknowledged, true);
  assert.equal(adapter.newChats, 1);
  assert.match(adapter.prompts[1] ?? "", /standalone continuation summary/);
  assert.match(adapter.prompts[2] ?? "", /<compacted_conversation_summary>/);
  assert.match(adapter.prompts[2] ?? "", /initial question was answered/i);
  assert.match(adapter.prompts[2] ?? "", /Reply with exactly COMPACTION_READY/);
  assert.equal(result.response, undefined);
  assert.equal(result.after.messageCount, 2);
  assert.equal(client.getTokenUsage().conversationTokens, result.after.conversationTokens);
});

test("CopilotClient compaction folds a resume prompt into the bootstrap round trip", async () => {
  const adapter = new FakeAdapter([
    "Initial answer.",
    "The user is auditing the client; the audit is still open.",
    "Here is the audit result.",
  ]);
  const client = testClient(adapter);
  await client.sendAndWait("Initial question");

  const result = await client.compact({ resumePrompt: "<user_task>\nFinish the audit\n</user_task>" });
  // One bootstrap message, no separate acknowledgement turn.
  assert.equal(adapter.prompts.length, 3);
  assert.equal(adapter.newChats, 1);
  assert.match(adapter.prompts[2] ?? "", /<compacted_conversation_summary>/);
  assert.match(adapter.prompts[2] ?? "", /Finish the audit/);
  assert.doesNotMatch(adapter.prompts[2] ?? "", /Reply with exactly/);
  assert.equal(result.response, "Here is the audit result.");
  assert.equal(result.acknowledged, true);
  // The combined bootstrap and its reply are both counted.
  assert.equal(result.after.messageCount, 2);
  assert.equal(
    result.after.conversationTokens,
    estimateMessageTokens(adapter.prompts[2] ?? "") + estimateMessageTokens("Here is the audit result."),
  );
});

test("CopilotClient does not count a prompt that failed before producing a response", async () => {
  const adapter = new FakeAdapter([]);
  const client = testClient(adapter);
  adapter.failNext = true;

  await assert.rejects(client.sendAndWait("not submitted"), /submission failed/);
  assert.equal(client.getTokenUsage().messageCount, 0);
});
