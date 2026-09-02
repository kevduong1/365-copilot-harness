import assert from "node:assert/strict";
import test from "node:test";
import { ScreenBuffer } from "../src/tui/buffer.js";
import { filterCommands, findCommand } from "../src/tui/commands.js";
import { dispatch, runSlash } from "../src/tui/dispatch.js";
import {
  blendHex,
  contextGradientHex,
  formatContextTokens,
  formatCwd,
  formatDuration,
  formatPercent5,
  formatTurnTokens,
  shineOpacity,
  wrapText,
} from "../src/tui/format.js";
import { fuzzyMatch } from "../src/tui/fuzzy.js";
import { InputParser, key } from "../src/tui/keys.js";
import { renderMarkdown } from "../src/tui/markdown.js";
import { insertText } from "../src/tui/prompt.js";
import { renderFrame } from "../src/tui/render.js";
import { createState } from "../src/tui/types.js";

function readyState() {
  return createState({
    autoApprove: false,
    readOnly: false,
    rawChat: false,
    cwd: "/Users/kevin/repos/demo",
    allowedRoots: [],
    home: "/Users/kevin",
    branch: "main",
  });
}

test("duration and token formats match grok's pager spec", () => {
  assert.equal(formatDuration(5200), "5.2s");
  assert.equal(formatDuration(32_000), "32s");
  assert.equal(formatDuration(125_000), "2m5s");
  assert.equal(formatDuration(3_720_000), "1h2m");
  assert.equal(formatTurnTokens(842), "842");
  assert.equal(formatTurnTokens(1230), "1.23k");
  assert.equal(formatTurnTokens(10_100), "10.1k");
  assert.equal(formatTurnTokens(123_000), "123k");
  assert.equal(formatContextTokens(1200), "1.2K");
  assert.equal(formatContextTokens(12_000), "12K");
  assert.equal(formatPercent5(5.12), "5.12%");
  assert.equal(formatPercent5(20.2), "20.2%");
  assert.equal(formatPercent5(100), "MAX %");
});

test("context gradient stays on the oscura ramp", () => {
  assert.equal(contextGradientHex(0), "#E4E4E4");
  assert.equal(contextGradientHex(50).toLowerCase(), "#c4a7e7");
  assert.equal(contextGradientHex(95).toLowerCase(), "#dc5a64");
  assert.equal(blendHex("#000000", "#ffffff", 0.5).toLowerCase(), "#808080");
});

test("cwd collapses under home and wrap keeps width", () => {
  assert.equal(formatCwd("/Users/kevin/repos/demo", "/Users/kevin"), "~/repos/demo");
  assert.equal(formatCwd("/Users/kevin", "/Users/kevin"), "~");
  assert.deepEqual(wrapText("abcdef", 3), ["abc", "def"]);
});

test("logo shine opacity stays in unit range and sweeps", () => {
  const brightest = (secs: number): number => {
    let best = 0;
    let at = 0;
    for (let i = 0; i <= 100; i += 1) {
      const diag = i / 100;
      const op = shineOpacity(diag, secs);
      assert.ok(op >= 0 && op <= 1);
      if (op > best) {
        best = op;
        at = diag;
      }
    }
    return at;
  };
  assert.ok(brightest(0.1) < brightest(0.4));
  assert.ok(brightest(0.4) < brightest(0.7));
  assert.ok(shineOpacity(0.5, 6) < 0.2);
});

test("key parser reads arrows, ctrl chords, mouse, and paste", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b[A")[0], key("up"));
  assert.deepEqual(parser.push("\x11")[0], key("char", { char: "q", ctrl: true }));
  assert.equal(parser.push("\x1b[<0;10;5M")[0]?.type, "mouse");
  const paste = parser.push("\x1b[200~hello\x1b[201~");
  assert.equal(paste[0]?.type, "key");
  if (paste[0]?.type === "key") assert.equal(paste[0].char, "hello");
});

test("slash registry resolves aliases used by the previous REPL", () => {
  assert.equal(findCommand("/tokens")?.name, "context");
  assert.equal(findCommand("clear")?.name, "new");
  assert.equal(findCommand("exit")?.name, "quit");
  assert.ok(filterCommands("comp").some((command) => command.name === "compact"));
});

test("dispatch runSlash covers the harness commands without touching the backend", () => {
  const state = { ...readyState(), ready: true, screen: "agent" as const };
  assert.equal(runSlash(state, "quit", "").effects[0]?.type, "quit");
  assert.equal(runSlash(state, "new", "").effects[0]?.type, "newChat");
  assert.equal(runSlash(state, "compact", "").effects[0]?.type, "compact");
  assert.equal(runSlash(state, "chat", "").effects[0]?.type, "newChat");
  assert.equal(runSlash(state, "tools", "").effects[0]?.type, "listTools");
  assert.equal(runSlash(state, "always-approve", "").state.permission, "always");
  const renamed = runSlash(state, "rename", "Auth work");
  assert.equal(renamed.state.title, "Auth work");
});

test("enter on a prompt queues a send effect once the session is ready", () => {
  const state = { ...readyState(), ready: true, prompt: "Explain this repo", cursor: 17, screen: "agent" as const };
  const result = dispatch(state, key("enter"), []);
  assert.equal(result.effects[0]?.type, "send");
  assert.equal(result.state.prompt, "");
  assert.equal(result.state.entries.at(-1)?.kind, "user");
});

test("unready send keeps the draft and does not emit a backend effect", () => {
  const state = { ...readyState(), prompt: "hi", cursor: 2 };
  const result = dispatch(state, key("enter"), []);
  assert.equal(result.effects.length, 0);
  assert.equal(result.state.prompt, "hi");
});

test("markdown hides heading markers and uses grok list bullets", () => {
  const lines = renderMarkdown("# Title\n- item", 40);
  const text = lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
  assert.ok(text.includes("Title"));
  assert.ok(!text.includes("# Title"));
  assert.ok(text.includes("• "));
});

test("welcome frame paints the Copilot wordmark and prompt placeholder", () => {
  const state = readyState();
  const frame = renderFrame({ ...state, ready: true, now: 0 }, 80, 28);
  const dump = frame.buffer.dump();
  assert.ok(dump.includes("Copilot"));
  assert.ok(dump.includes("Build anything") || dump.includes("New session"));
  assert.ok(dump.includes("enter send") || dump.includes("↵"));
});

test("prompt insert and fuzzy @ matching stay local to the frontend", () => {
  const next = insertText({ text: "ab", cursor: 1 }, "X");
  assert.equal(next.text, "aXb");
  const hit = fuzzyMatch("agnt", "src/agent/runner.ts");
  assert.ok(hit !== undefined);
  assert.ok((hit?.score ?? 0) > 0);
});

test("screen buffer dumps rows without leaking empty wide-cell placeholders", () => {
  const buf = new ScreenBuffer(8, 2, "#030304");
  buf.text(0, 0, "Hi", { fg: "#E4E4E4" });
  assert.equal(buf.dump(), "Hi");
});
