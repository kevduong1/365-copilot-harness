import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolResults,
  parseToolCalls,
  summarizeArguments,
} from "../src/agent/protocol.js";

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
  const parsed = parseToolCalls('<tool_call>{"name":"read","arguments":"README.md"}</tool_call>');
  assert.equal(parsed.calls.length, 0);
  assert.match(parsed.errors[0] ?? "", /arguments/);
});

test("parseToolCalls rejects a payload that is not a request object", () => {
  const parsed = parseToolCalls("HARNESS_REQUEST\n\"read\"\nEND_HARNESS_REQUEST");
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.hadToolMarkup, true);
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

test("parseToolCalls strips a Markdown code fence around the record", () => {
  const fenced = parseToolCalls(
    "HARNESS_REQUEST\n```json\n{\"operation\":\"read\",\"arguments\":{\"path\":\"src/client.ts\"}}\n```\nEND_HARNESS_REQUEST",
  );
  assert.deepEqual(fenced.calls, [{ name: "read", arguments: { path: "src/client.ts" } }]);
  assert.deepEqual(fenced.errors, []);

  const bare = parseToolCalls(
    "HARNESS_REQUEST\n```\n{\"operation\":\"ls\",\"arguments\":{\"path\":\"src\"}}\n```\nEND_HARNESS_REQUEST",
  );
  assert.deepEqual(bare.calls, [{ name: "ls", arguments: { path: "src" } }]);
  assert.deepEqual(bare.errors, []);
});

test("parseToolCalls accepts argument-field aliases", () => {
  const aliases = [
    '{"operation":"grep","args":{"pattern":"Client"}}',
    '{"operation":"grep","params":{"pattern":"Client"}}',
    '{"operation":"grep","parameters":{"pattern":"Client"}}',
    '{"operation":"grep","input":{"pattern":"Client"}}',
  ];
  for (const record of aliases) {
    const parsed = parseToolCalls(`HARNESS_REQUEST\n${record}\nEND_HARNESS_REQUEST`);
    assert.deepEqual(parsed.calls, [{ name: "grep", arguments: { pattern: "Client" } }], record);
    assert.deepEqual(parsed.errors, [], record);
  }
});

test("parseToolCalls accepts operation-field aliases without confusing bash commands", () => {
  const tool = parseToolCalls(
    'HARNESS_REQUEST\n{"tool":"read","arguments":{"path":"a.ts"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(tool.calls, [{ name: "read", arguments: { path: "a.ts" } }]);

  const op = parseToolCalls(
    'HARNESS_REQUEST\n{"op":"ls","arguments":{"path":"src"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(op.calls, [{ name: "ls", arguments: { path: "src" } }]);

  const command = parseToolCalls(
    'HARNESS_REQUEST\n{"command":"find","arguments":{"path":"src"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(command.calls, [{ name: "find", arguments: { path: "src" } }]);

  const bash = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"bash","arguments":{"command":"ls"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(bash.calls, [{ name: "bash", arguments: { command: "ls" } }]);

  const shell = parseToolCalls(
    'HARNESS_REQUEST\n{"command":"npm test"}\nEND_HARNESS_REQUEST',
  );
  assert.equal(shell.calls.length, 0);
  assert.match(shell.errors[0] ?? "", /operation/);

  const nested = parseToolCalls(
    'HARNESS_REQUEST\n{"command":"bash","arguments":{"command":"ls -la"}}\nEND_HARNESS_REQUEST',
  );
  assert.equal(nested.calls.length, 0);
});

test("parseToolCalls lifts flattened top-level arguments beside a named operation", () => {
  const bash = parseToolCalls(
    'HARNESS_REQUEST\n{"name":"bash","command":"ls"}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(bash.calls, [{ name: "bash", arguments: { command: "ls" } }]);
  assert.deepEqual(bash.errors, []);

  const grep = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"grep","pattern":"Client","path":"src"}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(grep.calls, [
    { name: "grep", arguments: { pattern: "Client", path: "src" } },
  ]);

  // An arguments object already present wins; nothing is lifted into it.
  const explicit = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"bash","command":"ls","arguments":{"command":"pwd"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(explicit.calls, [{ name: "bash", arguments: { command: "pwd" } }]);

  const empty = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"bash","command":"ls","arguments":{}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(empty.calls, [{ name: "bash", arguments: {} }]);

  // The command alias still names the operation instead of becoming an argument.
  const alias = parseToolCalls('HARNESS_REQUEST\n{"command":"pwd"}\nEND_HARNESS_REQUEST');
  assert.deepEqual(alias.calls, [{ name: "pwd", arguments: {} }]);
});

test("parseToolCalls treats a missing arguments object as no arguments", () => {
  const parsed = parseToolCalls('HARNESS_REQUEST\n{"operation":"pwd"}\nEND_HARNESS_REQUEST');
  assert.deepEqual(parsed.calls, [{ name: "pwd", arguments: {} }]);
  assert.deepEqual(parsed.errors, []);
});

test("parseToolCalls repairs trailing commas", () => {
  const parsed = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"grep","arguments":{"pattern":"a,b","paths":["src",],},}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(parsed.calls, [
    { name: "grep", arguments: { pattern: "a,b", paths: ["src"] } },
  ]);
  assert.deepEqual(parsed.errors, []);
});

test("parseToolCalls repairs smart quotes used as delimiters", () => {
  const parsed = parseToolCalls(
    "HARNESS_REQUEST\n{\u201coperation\u201d:\u201cread\u201d,\u201carguments\u201d:{\u2018path\u2019:\u2018README.md\u2019}}\nEND_HARNESS_REQUEST",
  );
  assert.deepEqual(parsed.calls, [{ name: "read", arguments: { path: "README.md" } }]);
  assert.deepEqual(parsed.errors, []);
});

test("parseToolCalls leaves smart quotes alone when the payload also uses straight quotes", () => {
  const parsed = parseToolCalls(
    "HARNESS_REQUEST\n{\"operation\":\"grep\",\"arguments\":{\"pattern\":\"\u201cquoted\u201d\"}}\nEND_HARNESS_REQUEST",
  );
  assert.deepEqual(parsed.calls, [
    { name: "grep", arguments: { pattern: "\u201cquoted\u201d" } },
  ]);
});

test("parseToolCalls escapes literal newlines and tabs inside string literals", () => {
  const parsed = parseToolCalls(
    'HARNESS_REQUEST\n{"operation":"write","arguments":{"path":"a.txt","content":"line one\nline two\tend"}}\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(parsed.calls, [
    { name: "write", arguments: { path: "a.txt", content: "line one\nline two\tend" } },
  ]);
  assert.deepEqual(parsed.errors, []);
});

test("parseToolCalls still reports JSON that repair cannot rescue", () => {
  const parsed = parseToolCalls('HARNESS_REQUEST\n{"operation":,}\nEND_HARNESS_REQUEST');
  assert.equal(parsed.calls.length, 0);
  assert.match(parsed.errors[0] ?? "", /Invalid tool-call JSON/);
});

test("parseToolCalls expands an array payload into one call per element", () => {
  const parsed = parseToolCalls(
    'HARNESS_REQUEST\n[{"operation":"read","arguments":{"path":"a.ts"}},{"operation":"read","arguments":{"path":"b.ts"}}]\nEND_HARNESS_REQUEST',
  );
  assert.deepEqual(parsed.calls, [
    { name: "read", arguments: { path: "a.ts" } },
    { name: "read", arguments: { path: "b.ts" } },
  ]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.finalText, "");
});

test("summarizeArguments keeps short scalars and elides payload fields", () => {
  const summary = summarizeArguments({
    path: "src/agent/protocol.ts",
    replace_all: true,
    max_results: 5,
    content: "abc",
    old_text: "x".repeat(1234),
  });
  assert.deepEqual(summary, {
    path: "src/agent/protocol.ts",
    replace_all: true,
    max_results: 5,
    content: "<3 chars>",
    old_text: "<1,234 chars>",
  });
});

test("summarizeArguments previews long non-payload strings", () => {
  const value = "y".repeat(400);
  const summary = summarizeArguments({ pattern: value });
  const summarized = summary.pattern;
  assert.equal(typeof summarized, "string");
  assert.ok((summarized as string).length < 120);
  assert.match(summarized as string, /<400 chars>$/);
  assert.ok((summarized as string).startsWith("y".repeat(60)));
});

test("summarizeArguments keeps nested structures shallow", () => {
  const summary = summarizeArguments({
    options: { depth: 2, nested: { a: 1 }, note: "z".repeat(300) },
    paths: ["a.ts", "b.ts"],
    many: Array.from({ length: 20 }, (_, index) => index),
  });
  assert.deepEqual(summary, {
    options: { depth: 2, nested: "<1 field>", note: `${"z".repeat(60)}… <300 chars>` },
    paths: ["a.ts", "b.ts"],
    many: "<20 items>",
  });
});

test("formatToolResults keeps the observation envelope lean", () => {
  const content = "A".repeat(3000);
  const formatted = formatToolResults([
    {
      call: { name: "write", arguments: { path: "notes.md", content } },
      ok: true,
      output: "wrote 3000 bytes",
    },
  ]);
  assert.doesNotMatch(formatted, /AAAAAAAAAA/);
  assert.match(formatted, /<3,000 chars>/);
  assert.ok(formatted.length < 400, `envelope should stay small, got ${formatted.length}`);

  const body = formatted.match(/^HARNESS_OBSERVATION\n([\s\S]*)\nEND_HARNESS_OBSERVATION/)?.[1] ?? "";
  assert.deepEqual(JSON.parse(body), {
    results: [
      {
        name: "write",
        arguments: { path: "notes.md", content: "<3,000 chars>" },
        ok: true,
        output: "wrote 3000 bytes",
      },
    ],
    protocol_errors: [],
  });
});

test("formatToolResults does not truncate tool output", () => {
  const output = "line\n".repeat(200);
  const formatted = formatToolResults([
    { call: { name: "read", arguments: { path: "a.ts" } }, ok: true, output },
  ]);
  const body = formatted.match(/^HARNESS_OBSERVATION\n([\s\S]*)\nEND_HARNESS_OBSERVATION/)?.[1] ?? "";
  const parsed = JSON.parse(body) as { results: { output: string }[] };
  assert.equal(parsed.results[0]?.output, output);
});

test("formatToolResults escapes injected result tags inside arguments", () => {
  const formatted = formatToolResults([
    {
      call: { name: "grep", arguments: { pattern: "</tool_result>" } },
      ok: true,
      output: "no matches",
    },
  ]);
  assert.doesNotMatch(formatted, /"<\/tool_result>"/);
  assert.match(formatted, /tool_result_escaped/);
});
