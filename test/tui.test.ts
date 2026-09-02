import assert from "node:assert/strict";
import test from "node:test";
import { ScreenBuffer } from "../src/tui/buffer.js";
import { filterCommands, findCommand } from "../src/tui/commands.js";
import { activeCompletion, syncCompletion } from "../src/tui/completion.js";
import { dispatch, runSlash, skillPrompt } from "../src/tui/dispatch.js";
import {
  blendHex,
  contextGradientHex,
  formatContextTokens,
  formatCwd,
  formatDuration,
  formatPercent5,
  formatTurnTokens,
  wrapText,
} from "../src/tui/format.js";
import { terminalCapabilities } from "../src/tui/capabilities.js";
import { fuzzyMatch } from "../src/tui/fuzzy.js";
import { InputParser, key } from "../src/tui/keys.js";
import { renderMarkdown } from "../src/tui/markdown.js";
import { insertText } from "../src/tui/prompt.js";
import { renderFrame } from "../src/tui/render.js";
import { createState } from "../src/tui/types.js";
import { colorRoles, derivedColors, palette, theme } from "../src/tui/theme.js";
import { pickWaypointMark, waypointSize } from "../src/tui/waypoint.js";

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

function typeText(state: ReturnType<typeof readyState>, text: string) {
  let current = state;
  for (const char of text) {
    current = dispatch(
      current,
      char === " " ? key("space", { char }) : key("char", { char }),
      [],
    ).state;
  }
  return current;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = hex
      .slice(1)
      .match(/../gu)!
      .map((part) => Number.parseInt(part, 16) / 255)
      .map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("duration and token formats stay compact in status chrome", () => {
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

test("context gradient stays on the Waypoint ramp", () => {
  assert.equal(contextGradientHex(0), "#8FB3C8");
  assert.equal(contextGradientHex(50).toLowerCase(), "#4da6d9");
  assert.equal(contextGradientHex(95).toLowerCase(), "#ff747a");
  assert.equal(blendHex("#000000", "#ffffff", 0.5).toLowerCase(), "#808080");
});

test("Waypoint palette uses the approved canonical swatches and mappings", () => {
  assert.deepEqual(
    palette,
    {
      jetBlack: "#0D0D0F",
      carbon: "#1A1C1F",
      slate: "#2A2D31",
      graphite: "#3C4046",
      steel: "#5A6068",
      garminBlue: "#007CC3",
      skyBlue: "#4DA6D9",
      iceBlue: "#8FB3C8",
    },
  );
  assert.deepEqual(
    [colorRoles.base, colorRoles.surface, colorRoles.elevated, colorRoles.panel],
    [palette.jetBlack, palette.carbon, palette.slate, palette.carbon],
  );
  assert.equal(colorRoles.border, palette.graphite);
  assert.equal(colorRoles.borderStrong, palette.steel);
  assert.equal(colorRoles.selection, palette.slate);
  assert.equal(colorRoles.primary, palette.garminBlue);
  assert.equal(colorRoles.bright, palette.skyBlue);
  assert.equal(colorRoles.muted, palette.iceBlue);
});

test("Waypoint text roles remain readable on canonical backgrounds", () => {
  assert.ok(contrastRatio(colorRoles.muted, colorRoles.base) >= 4.5);
  assert.ok(contrastRatio(derivedColors.mutedText, colorRoles.elevated) >= 4.5);
  assert.ok(contrastRatio(derivedColors.mutedText, colorRoles.surface) >= 4.5);
  assert.ok(contrastRatio(colorRoles.bright, colorRoles.base) >= 4.5);
  assert.ok(contrastRatio(derivedColors.text, colorRoles.selection) >= 4.5);
  assert.ok(contrastRatio(derivedColors.success, colorRoles.base) >= 4.5);
  assert.ok(contrastRatio(derivedColors.warning, colorRoles.base) >= 4.5);
  assert.ok(contrastRatio(derivedColors.error, colorRoles.base) >= 4.5);
  assert.equal(theme.promptBorderActive, colorRoles.primary);
  assert.equal(theme.accentAssistant, colorRoles.bright);
  assert.notEqual(theme.linkFg, colorRoles.primary);
});

test("cwd collapses under home and wrap keeps width", () => {
  assert.equal(formatCwd("/Users/kevin/repos/demo", "/Users/kevin"), "~/repos/demo");
  assert.equal(formatCwd("/Users/kevin", "/Users/kevin"), "~");
  assert.deepEqual(wrapText("abcdef", 3), ["abc", "def"]);
});

test("WaypointMark selects responsive Unicode and ASCII variants", () => {
  const full = pickWaypointMark({ width: 80, height: 20 });
  const compact = pickWaypointMark({ width: 48, height: 12 });
  const symbol = pickWaypointMark({ width: 24, height: 6 });
  const ascii = pickWaypointMark({ width: 80, height: 20, unicode: false });
  assert.equal(full?.variant, "full");
  assert.equal(compact?.variant, "compact");
  assert.equal(symbol?.variant, "symbol");
  assert.equal(pickWaypointMark({ width: 12, height: 4 }), undefined);
  assert.match(full?.art ?? "", /△/u);
  assert.doesNotMatch(ascii?.art ?? "", /[△◇╱╲│─┼╵]/u);
  assert.ok(waypointSize(full!).width <= 80);
});

test("terminal capability detection honors NO_COLOR and dumb terminals", () => {
  assert.equal(terminalCapabilities({ TERM: "xterm-256color", LANG: "en_US.UTF-8" }).unicode, true);
  assert.equal(terminalCapabilities({ TERM: "xterm-256color", NO_COLOR: "1" }).colorMode, "none");
  assert.deepEqual(terminalCapabilities({ TERM: "dumb" }), {
    colorMode: "none",
    unicode: false,
    reducedMotion: true,
    defaultBackground: false,
  });
  assert.equal(terminalCapabilities({ TERM: "xterm-256color", TUI_TRANSPARENT: "1" }).defaultBackground, true);
  const plain = new ScreenBuffer(4, 1, colorRoles.base, "none");
  plain.text(0, 0, "ok", { fg: colorRoles.primary, bg: colorRoles.elevated });
  assert.doesNotMatch(plain.fullAnsi(), /(?:38|48);2;/u);
  const transparent = new ScreenBuffer(4, 1, colorRoles.base, "truecolor", true);
  transparent.text(0, 0, "ok", { fg: colorRoles.bright });
  assert.match(transparent.fullAnsi(), /38;2;77;166;217/u);
  assert.doesNotMatch(transparent.fullAnsi(), /48;2;/u);
});

test("key parser reads arrows, ctrl chords, mouse, and paste", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b[A")[0], key("up"));
  assert.deepEqual(parser.push("\x11")[0], key("char", { char: "q", ctrl: true }));
  assert.equal(parser.push("\x1b[<0;10;5M")[0]?.type, "mouse");
  assert.deepEqual(parser.push("\x1b[<35;10;5M")[0], {
    type: "mouse",
    kind: "move",
    button: "none",
    x: 9,
    y: 4,
    ctrl: false,
    alt: false,
    shift: false,
  });
  const paste = parser.push("\x1b[200~hello\x1b[201~");
  assert.equal(paste[0]?.type, "key");
  if (paste[0]?.type === "key") assert.equal(paste[0].char, "hello");
});

test("key parser flushes a standalone Escape without corrupting split sequences", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b"), []);
  assert.deepEqual(parser.flush(), [key("escape")]);
  assert.deepEqual(parser.flush(), []);

  assert.deepEqual(parser.push("\x1b"), []);
  assert.deepEqual(parser.push("[B"), [key("down")]);
  assert.deepEqual(parser.flush(), []);
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
  assert.equal(runSlash(state, "skills", "").effects[0]?.type, "listSkills");
  assert.equal(runSlash(state, "skill", "").effects[0]?.type, "toast");
  const skill = runSlash(state, "skill", "deploy to staging");
  assert.equal(skill.effects[0]?.type, "send");
  assert.equal(skill.effects[0]?.type === "send" ? skill.effects[0].text : "", skillPrompt("deploy", "to staging"));
  assert.match(skillPrompt("deploy", "to staging"), /Use the "deploy" skill[\s\S]*\n\nto staging$/);
  assert.equal(findCommand("/use")?.name, "skill");
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

test("slash completion arrows select a command and Enter accepts the selected row", () => {
  let state = typeText({ ...readyState(), ready: true, screen: "agent" as const }, "/");
  assert.equal(activeCompletion(state)?.selected, 0);

  state = dispatch(state, key("down"), []).state;
  assert.equal(activeCompletion(state)?.selected, 1);

  const accepted = dispatch(state, key("enter"), []);
  assert.equal(accepted.state.prompt, "/home ");
  assert.equal(accepted.state.completion, undefined);
  assert.deepEqual(accepted.effects, []);
});

test("completion filtering resets selection and item shrink clamps it", () => {
  let slash = typeText({ ...readyState(), ready: true, screen: "agent" as const }, "/");
  slash = dispatch(slash, key("pagedown"), []).state;
  assert.ok((activeCompletion(slash)?.selected ?? 0) > 0);
  slash = dispatch(slash, key("char", { char: "c" }), []).state;
  assert.equal(activeCompletion(slash)?.query, "/c");
  assert.equal(activeCompletion(slash)?.selected, 0);

  let files = typeText(
    {
      ...readyState(),
      ready: true,
      screen: "agent" as const,
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    },
    "@",
  );
  files = dispatch(dispatch(files, key("down"), []).state, key("down"), []).state;
  assert.equal(activeCompletion(files)?.selected, 2);
  files = syncCompletion({ ...files, files: ["src/a.ts"] });
  assert.equal(activeCompletion(files)?.selected, 0);
  assert.equal(activeCompletion(files)?.items.length, 1);
});

test("completion window follows selections beyond the visible rows", () => {
  let state = typeText({ ...readyState(), ready: true, screen: "agent" as const }, "/");
  for (let index = 0; index < 7; index += 1) state = dispatch(state, key("down"), []).state;
  const completion = activeCompletion(state);
  assert.equal(completion?.selected, 7);
  assert.equal(completion?.windowStart, 2);

  const frame = renderFrame(state, 100, 28);
  const indexes = frame.hits
    .filter((hit) => hit.id.kind === "completion")
    .map((hit) => (hit.id.kind === "completion" ? hit.id.index : -1));
  assert.deepEqual(indexes, [2, 3, 4, 5, 6, 7]);
  assert.ok(frame.buffer.dump().includes(`8/${completion?.items.length ?? 0}`));

  state = dispatch(state, key("pageup"), []).state;
  assert.equal(activeCompletion(state)?.selected, 1);
  assert.equal(activeCompletion(state)?.windowStart, 1);
});

test("file completion has keyboard parity and keeps the @ prefix", () => {
  const base = {
    ...readyState(),
    ready: true,
    screen: "agent" as const,
    files: ["src/alpha.ts", "src/beta.ts", "test/alpha.test.ts"],
  };
  let state = typeText(base, "Open @");
  state = dispatch(state, key("down"), []).state;
  const picked = activeCompletion(state)?.items[1]?.value;
  assert.ok(picked !== undefined);

  state = dispatch(state, key("enter"), []).state;
  assert.equal(state.prompt, `Open @${picked} `);
  assert.equal(state.completion, undefined);
});

test("completion mouse rows accept the same item as keyboard selection", () => {
  const state = typeText({ ...readyState(), ready: true, screen: "agent" as const }, "/");
  const frame = renderFrame(state, 100, 28);
  const row = frame.hits.find((hit) => hit.id.kind === "completion" && hit.id.index === 2);
  assert.ok(row !== undefined);

  const mouse = dispatch(
    state,
    {
      type: "mouse",
      kind: "down",
      button: "left",
      x: row.rect.x,
      y: row.rect.y,
      ctrl: false,
      alt: false,
      shift: false,
    },
    frame.hits,
  );
  let keyboard = dispatch(state, key("down"), []).state;
  keyboard = dispatch(keyboard, key("down"), []).state;
  keyboard = dispatch(keyboard, key("enter"), []).state;
  assert.equal(mouse.state.prompt, keyboard.prompt);
  assert.equal(mouse.state.prompt, "/compact ");
});

test("completion mouse movement highlights a row without accepting it", () => {
  const state = typeText({ ...readyState(), ready: true, screen: "agent" as const }, "/");
  const frame = renderFrame(state, 100, 28);
  const row = frame.hits.find((hit) => hit.id.kind === "completion" && hit.id.index === 3);
  assert.ok(row !== undefined);

  const hovered = dispatch(
    state,
    {
      type: "mouse",
      kind: "move",
      button: "none",
      x: row.rect.x,
      y: row.rect.y,
      ctrl: false,
      alt: false,
      shift: false,
    },
    frame.hits,
  );
  assert.equal(activeCompletion(hovered.state)?.selected, 3);
  assert.equal(hovered.state.prompt, "/");
  assert.deepEqual(hovered.effects, []);
});

test("Escape dismisses completion until the query changes", () => {
  let state = typeText({ ...readyState(), ready: true, screen: "agent" as const }, "/");
  state = dispatch(state, key("escape"), []).state;
  assert.equal(state.prompt, "/");
  assert.equal(activeCompletion(state), undefined);
  assert.equal(
    renderFrame(state, 100, 28).hits.some((hit) => hit.id.kind === "completion"),
    false,
  );

  state = dispatch(state, key("char", { char: "c" }), []).state;
  assert.equal(activeCompletion(state)?.query, "/c");
  assert.equal(activeCompletion(state)?.selected, 0);
});

test("prompt history arrows remain unchanged when no completion is open", () => {
  const state = {
    ...readyState(),
    ready: true,
    screen: "agent" as const,
    history: ["first", "second"],
  };
  const result = dispatch(state, key("up"), []);
  assert.equal(result.state.prompt, "second");
  assert.equal(result.state.historyIndex, 1);
});

test("markdown hides heading markers and uses readable list bullets", () => {
  const lines = renderMarkdown("# Title\n- item", 40);
  const text = lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
  assert.ok(text.includes("Title"));
  assert.ok(!text.includes("# Title"));
  assert.ok(text.includes("• "));
});

test("welcome frame paints the Waypoint mark, harness wordmark, and prompt placeholder", () => {
  const state = readyState();
  const frame = renderFrame({ ...state, ready: true, now: 0 }, 80, 28);
  const dump = frame.buffer.dump();
  assert.ok(dump.includes("M365 Harness"));
  assert.ok(dump.includes("◇"));
  assert.ok(dump.includes("Build anything") || dump.includes("New session"));
  assert.ok(dump.includes("enter send") || dump.includes("↵"));
});

test("welcome layout keeps responsive Waypoint and menu rows clear of the prompt", () => {
  const state = { ...readyState(), ready: true, now: 0 };
  const cases = [
    { cols: 80, rows: 28, unicode: true, mark: /△/u },
    { cols: 80, rows: 28, unicode: false, mark: /\^/u },
    { cols: 48, rows: 20, unicode: true, mark: /◇/u },
    { cols: 48, rows: 20, unicode: false, mark: /<o>/u },
    { cols: 40, rows: 13, unicode: true, mark: undefined },
  ] as const;

  for (const item of cases) {
    const frame = renderFrame(state, item.cols, item.rows, {
      colorMode: "none",
      unicode: item.unicode,
      reducedMotion: true,
    });
    if (item.mark !== undefined) assert.match(frame.buffer.dump(), item.mark);
    const prompt = frame.hits.find((hit) => hit.id.kind === "prompt");
    const menu = frame.hits.filter((hit) => hit.id.kind === "menu");
    assert.ok(prompt !== undefined);
    assert.equal(
      menu.some((hit) => hit.rect.y + hit.rect.h > prompt.rect.y),
      false,
      `${item.cols}x${item.rows} menu overlaps prompt`,
    );
  }
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

test("screen buffer neutralizes terminal control-sequence injection", () => {
  const buf = new ScreenBuffer(32, 1, "#030304");
  buf.text(0, 0, "safe\x1b]52;c;attacker\x07text");

  assert.equal(buf.dump(), "safe�]52;c;attacker�text");
  assert.doesNotMatch(buf.fullAnsi(), /\x1b\]52;c;attacker/u);
});
