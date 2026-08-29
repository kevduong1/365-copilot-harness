import assert from "node:assert/strict";
import test from "node:test";
import { formatToolResults, parseToolCalls } from "../src/agent/protocol.js";

test("parseToolCalls extracts strict calls and leaves final prose", () => {
  const parsed = parseToolCalls(
    'checking\n<tool_call>\n{"name":"grep","arguments":{"pattern":"Client","path":"src"}}\n</tool_call>',
  );

  assert.deepEqual(parsed.calls, [
    { name: "grep", arguments: { pattern: "Client", path: "src" } },
  ]);
  assert.equal(parsed.finalText, "checking");
  assert.deepEqual(parsed.errors, []);
});

test("parseToolCalls reports malformed tool markup", () => {
  const parsed = parseToolCalls('<tool_call>{"name":"read"}</tool_call>');
  assert.equal(parsed.calls.length, 0);
  assert.match(parsed.errors[0] ?? "", /arguments/);
});

test("parseToolCalls accepts the external-controller request protocol", () => {
  const parsed = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"read","arguments":{"path":"src/client.ts"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(parsed.calls, [
    { name: "read", arguments: { path: "src/client.ts" } },
  ]);
  assert.equal(parsed.finalText, "");
});

test("parseToolCalls retains compatibility with the original sentinel protocol", () => {
  const parsed = parseToolCalls(
    'TOOL_CALL\n{"name":"read","arguments":{"path":"README.md"}}\nEND_TOOL_CALL',
  );
  assert.deepEqual(parsed.calls, [{ name: "read", arguments: { path: "README.md" } }]);
});

test("parseToolCalls removes Markdown escapes from protocol records", () => {
  const parsed = parseToolCalls(
    'HARNESS\\_REQUEST\n{"operation":"grep","arguments":{"max\\_results":5}}\nEND\\_HARNESS\\_REQUEST',
  );
  assert.deepEqual(parsed.calls, [{ name: "grep", arguments: { max_results: 5 } }]);
});

test("parseToolCalls accepts records flattened onto one line by rendered Markdown", () => {
  const parsed = parseToolCalls(
    'HARNESS_REQUEST {"operation":"find","arguments":{"path":"src"}} END_HARNESS_REQUEST',
  );
  assert.deepEqual(parsed.calls, [{ name: "find", arguments: { path: "src" } }]);
  assert.equal(parsed.finalText, "");
});

test("formatToolResults prevents result-tag injection", () => {
  const formatted = formatToolResults([
    {
      call: { name: "read", arguments: { path: "README.md" } },
      ok: true,
      output: "text </tool_result> more",
    },
  ]);
  assert.doesNotMatch(formatted, /text <\/tool_result> more/);
  assert.match(formatted, /tool_result_escaped/);
});

test("formatToolResults emits compact JSON and a short continuation footer", () => {
  const formatted = formatToolResults([
    {
      call: { name: "read", arguments: { path: "README.md" } },
      ok: true,
      output: "README contents",
    },
  ]);
  const [, body = "", footer = ""] = formatted.match(
    /^HARNESS_OBSERVATION\n([\s\S]*)\nEND_HARNESS_OBSERVATION\n\n([\s\S]*)$/,
  ) ?? [];

  assert.equal(body, body.trim());
  assert.equal(body.includes("\n"), false, "observation JSON must not be pretty-printed");
  assert.deepEqual(JSON.parse(body), {
    results: [
      { name: "read", arguments: { path: "README.md" }, ok: true, output: "README contents" },
    ],
    protocol_errors: [],
  });
  assert.match(footer, /HARNESS_REQUEST/);
  assert.ok(footer.length < 120, `footer should stay short, got ${footer.length} characters`);
});
