import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationTokenCounter,
  estimateMessageTokens,
  estimateTokens,
} from "../src/tokens.js";

test("token estimator handles prose, code punctuation, and non-Latin text conservatively", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("Hello, world!") >= 3);
  assert.ok(estimateTokens("{}[]() => !== && ||;;") > estimateTokens("abcdefghijklmnopqrst"));
  assert.ok(estimateTokens("这是一个测试") >= 6);
  assert.equal(estimateMessageTokens(""), 4);
});

test("conversation counter projects the next message and triggers at the configured threshold", () => {
  const counter = new ConversationTokenCounter({
    contextWindowTokens: 100,
    compactionThresholdPercent: 60,
  });

  assert.equal(counter.needsCompaction("x".repeat(400)), false, "an empty chat cannot be compacted");
  counter.record("user", "a".repeat(100));
  counter.record("assistant", "b".repeat(80));

  const current = counter.usage();
  const projected = counter.usage("c".repeat(40));
  assert.equal(current.messageCount, 2);
  assert.equal(projected.messageCount, 3);
  assert.ok(projected.conversationTokens > current.conversationTokens);
  assert.equal(counter.needsCompaction("c".repeat(40)), true);

  counter.reset();
  assert.deepEqual(counter.usage().conversationTokens, 0);
  assert.equal(counter.usage().messageCount, 0);
});

test("conversation counter validates its estimated budget", () => {
  assert.throws(
    () =>
      new ConversationTokenCounter({
        contextWindowTokens: 0,
        compactionThresholdPercent: 60,
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      new ConversationTokenCounter({
        contextWindowTokens: 100,
        compactionThresholdPercent: 101,
      }),
    /at most 100/,
  );
});
