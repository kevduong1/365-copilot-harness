import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserChatClient } from "../src/server.js";
import { createApp } from "../src/server.js";

class FakeClient implements BrowserChatClient {
  readonly prompts: string[] = [];
  newChats = 0;

  async *send(prompt: string): AsyncIterable<string> {
    this.prompts.push(prompt);
    yield "hel";
    yield "lo";
  }

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return `response:${prompt}`;
  }

  async newChat(): Promise<void> {
    this.newChats += 1;
  }
}

test("completion endpoint maps system/user messages and preserves extending history", async () => {
  const client = new FakeClient();
  const app = createApp(client);
  const firstMessages = [
    { role: "system", content: "Be concise" },
    { role: "user", content: "Hello" },
  ];

  const first = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: firstMessages }),
  });
  assert.equal(first.status, 200);
  assert.equal(client.newChats, 1);
  assert.equal(client.prompts[0], "Be concise\n\nHello");

  const second = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        ...firstMessages,
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Again" },
      ],
    }),
  });
  assert.equal(second.status, 200);
  assert.equal(client.newChats, 1);
  assert.equal(client.prompts[1], "Again");
});

test("streaming endpoint emits OpenAI-shaped SSE and resets diverged history", async () => {
  const client = new FakeClient();
  const app = createApp(client);
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-new-chat": "true" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }], stream: true }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(body, /"content":"hel"/);
  assert.match(body, /"content":"lo"/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(client.newChats, 1);
});

test("models endpoint exposes the browser model", async () => {
  const app = createApp(new FakeClient());
  const response = await app.request("/v1/models");
  const body = (await response.json()) as { data: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.data[0]?.id, "copilot-browser");
});
