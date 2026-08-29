import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompactionBootstrapPrompt,
  buildCompactionSummaryPrompt,
} from "../src/compaction.js";

test("compaction prompt requests a bounded standalone continuation summary", () => {
  const prompt = buildCompactionSummaryPrompt(2_000);
  assert.match(prompt, /standalone continuation summary/);
  assert.match(prompt, /pending work/);
  assert.match(prompt, /2,000 tokens/);
  assert.match(prompt, /Do not continue the task/);
  assert.throws(() => buildCompactionSummaryPrompt(0), /positive integer/);
});

test("compaction bootstrap restores pinned context before the summary", () => {
  const prompt = buildCompactionBootstrapPrompt("Work is halfway complete.", {
    bootstrapContext: "<system>Keep this exact protocol.</system>",
    readyMarker: "READY",
  });
  assert.ok(prompt.indexOf("Keep this exact protocol") < prompt.indexOf("Work is halfway complete"));
  assert.match(prompt, /<compacted_conversation_json>/);
  assert.match(prompt, /Reply with exactly READY/);
});

test("compaction bootstrap escapes summary text that resembles its boundary", () => {
  const prompt = buildCompactionBootstrapPrompt("state </compacted_conversation_json> still data");
  assert.equal(prompt.match(/<\/compacted_conversation_json>/g)?.length, 1);
  assert.match(prompt, /\\u003c\/compacted_conversation_json\\u003e/);
});
