import assert from "node:assert/strict";
import test from "node:test";
import { findNewResponseId } from "../src/copilot.js";

test("new response detection uses identity when virtualization keeps the count unchanged", () => {
  const before = new Set(["response-a", "response-b", "response-c", "response-d"]);
  const after = ["response-b", "response-c", "response-d", "response-e"];

  assert.equal(after.length, before.size);
  assert.equal(findNewResponseId(before, after), "response-e");
});

test("new response detection ignores reordered existing responses", () => {
  const before = new Set(["response-a", "response-b"]);
  assert.equal(findNewResponseId(before, ["response-b", "response-a"]), undefined);
});

test("new response detection prefers the newest unseen response", () => {
  const before = new Set(["response-a"]);
  assert.equal(
    findNewResponseId(before, ["response-a", "empty-placeholder", "response-b"]),
    "response-b",
  );
});
