import { ScreenBuffer, type Rect, type Style } from "./buffer.js";
import { welcomeItems, filterCommands, paletteItems } from "./commands.js";
import { drawBox, hline, joinHints } from "./draw.js";
import {
  blendHex,
  contextGradientHex,
  formatContextTokens,
  formatCwd,
  formatDuration,
  formatTurnTokens,
  stringWidth,
  truncate,
} from "./format.js";
import { glyphs, PROMPT_ARROW } from "./glyphs.js";
import { pickLogo, shineLogo } from "./logo.js";
import { renderMarkdown } from "./markdown.js";
import { atQuery, promptLines, slashToken, wrappedCursor } from "./prompt.js";
import { fuzzyFilter } from "./fuzzy.js";
import {
  OUTER_HPAD,
  OUTER_VPAD,
  SPINNER_FRAMES,
  SPINNER_MS,
  MAX_SLASH_VISIBLE,
  theme,
  TOOL_DISPLAY_LIMIT,
} from "./theme.js";
import {
  callSummary,
  permissionLabel,
  type HitRegion,
  type ScrollbackEntry,
  type TuiState,
  type ToolEntry,
} from "./types.js";

export interface Frame {
  buffer: ScreenBuffer;
  hits: HitRegion[];
  cursor: { x: number; y: number; visible: boolean };
}

export function renderFrame(state: TuiState, cols: number, rows: number): Frame {
  const buffer = new ScreenBuffer(cols, rows, theme.bgBase);
  buffer.fill({ x: 0, y: 0, w: cols, h: rows }, { bg: theme.bgBase });
  const hits: HitRegion[] = [];
  let cursor = { x: 0, y: 0, visible: false };

  if (cols < 40 || rows < 12) {
    buffer.text(1, Math.floor(rows / 2), "Terminal too small — enlarge the pane.", { fg: theme.warning });
    return { buffer, hits, cursor };
  }

  if (state.overlay !== "none" && state.overlay !== "approval") {
    const inner = renderAgentOrWelcome(state, buffer, hits, cols, rows);
    cursor = inner;
    renderOverlay(state, buffer, hits, cols, rows);
  } else if (state.screen === "welcome") {
    cursor = renderWelcome(state, buffer, hits, cols, rows);
  } else {
    cursor = renderAgent(state, buffer, hits, cols, rows);
  }
  if (state.approval !== undefined) renderApproval(state, buffer, hits, cols, rows);
  if (state.toast !== undefined && state.now < state.toast.until) {
    const msg = truncate(state.toast.message, cols - 8);
    buffer.text(Math.max(OUTER_HPAD, cols - stringWidth(msg) - OUTER_HPAD - 1), OUTER_VPAD, msg, {
      fg: theme.accentSuccess,
    });
  }
  return { buffer, hits, cursor };
}

function renderAgentOrWelcome(
  state: TuiState,
  buffer: ScreenBuffer,
  hits: HitRegion[],
  cols: number,
  rows: number,
): { x: number; y: number; visible: boolean } {
  if (state.screen === "welcome") return renderWelcome(state, buffer, hits, cols, rows);
  return renderAgent(state, buffer, hits, cols, rows);
}

function renderWelcome(
  state: TuiState,
  buf: ScreenBuffer,
  hits: HitRegion[],
  cols: number,
  rows: number,
): { x: number; y: number; visible: boolean } {
  const promptH = promptHeight(state, cols);
  const statusY = rows - 1 - OUTER_VPAD;
  const promptBox: Rect = {
    x: OUTER_HPAD,
    y: statusY - promptH - 1,
    w: cols - OUTER_HPAD * 2,
    h: promptH,
  };
  const body: Rect = {
    x: OUTER_HPAD,
    y: OUTER_VPAD,
    w: cols - OUTER_HPAD * 2,
    h: Math.max(1, promptBox.y - OUTER_VPAD - 1),
  };

  buf.text(OUTER_HPAD, OUTER_VPAD, "Copilot", { fg: theme.textPrimary, bold: true });
  const cwd = truncate(formatCwd(state.cwd, state.home), Math.max(8, cols - 24));
  buf.text(OUTER_HPAD + 9, OUTER_VPAD, cwd, { fg: theme.gray });

  const items = welcomeItems(state.ready);
  const logo = pickLogo(rows);
  const secs = state.now / 1000;
  let menuY = body.y + Math.max(1, Math.floor(body.h * 0.18));

  if (logo !== undefined) {
    const art = shineLogo(logo, secs);
    const width = art.reduce((max, line) => Math.max(max, line.length), 0);
    const startX = Math.max(body.x, body.x + Math.floor((body.w - width) / 2));
    art.forEach((line, row) => {
      line.forEach((cell, col) => {
        buf.put(startX + col, menuY + row, cell.ch, cell.style);
      });
    });
    menuY += art.length + 1;
    const word = "Copilot";
    buf.text(Math.max(body.x, body.x + Math.floor((body.w - word.length) / 2)), menuY, word, {
      fg: theme.textPrimary,
      bold: true,
    });
    menuY += 2;
  }

  const menuWidth = Math.min(42, body.w);
  const menuX = body.x + Math.max(0, Math.floor((body.w - menuWidth) / 2));
  items.forEach((item, index) => {
    const selected = index === state.welcomeIndex;
    const y = menuY + index;
    const style: Style = selected
      ? { fg: theme.textPrimary, bg: theme.bgVisual, bold: true }
      : { fg: theme.textPrimary, bold: true };
    if (selected) buf.fill({ x: menuX, y, w: menuWidth, h: 1 }, { bg: theme.bgVisual });
    buf.text(menuX, y, truncate(item.label, menuWidth - item.hint.length - 2), style);
    buf.text(menuX + menuWidth - stringWidth(item.hint), y, item.hint, {
      fg: theme.grayBright,
      ...(selected ? { bg: theme.bgVisual } : {}),
    });
    hits.push({ id: { kind: "menu", index }, rect: { x: menuX, y, w: menuWidth, h: 1 } });
  });

  if (state.launchError) {
    buf.text(body.x, menuY + items.length + 2, truncate(state.launchError, body.w), { fg: theme.accentError });
  } else if (state.launching) {
    const spin = SPINNER_FRAMES[Math.floor(state.now / SPINNER_MS) % SPINNER_FRAMES.length]!;
    buf.text(body.x, menuY + items.length + 2, `${spin} Starting session… ${formatDuration(state.now - state.turnStartedAt)}`, {
      fg: theme.grayDim,
    });
  }

  const cursor = drawPrompt(state, buf, hits, promptBox, true);
  drawShortcuts(state, buf, { x: OUTER_HPAD, y: statusY, w: cols - OUTER_HPAD * 2, h: 1 });
  return cursor;
}

function renderAgent(
  state: TuiState,
  buf: ScreenBuffer,
  hits: HitRegion[],
  cols: number,
  rows: number,
): { x: number; y: number; visible: boolean } {
  const promptH = promptHeight(state, cols);
  const statusY = rows - 1 - OUTER_VPAD;
  const promptBox: Rect = {
    x: OUTER_HPAD,
    y: statusY - promptH - 1,
    w: cols - OUTER_HPAD * 2,
    h: promptH,
  };
  const turnY = promptBox.y - (state.turn === "idle" ? 0 : 2);
  const scroll: Rect = {
    x: OUTER_HPAD,
    y: OUTER_VPAD + 1,
    w: cols - OUTER_HPAD * 2,
    h: Math.max(1, (state.turn === "idle" ? promptBox.y : turnY) - OUTER_VPAD - 2),
  };

  drawTopBar(state, buf, { x: OUTER_HPAD, y: OUTER_VPAD, w: cols - OUTER_HPAD * 2, h: 1 });
  drawScrollback(state, buf, hits, scroll);
  if (state.turn !== "idle") drawTurnStatus(state, buf, hits, { x: OUTER_HPAD, y: turnY, w: cols - OUTER_HPAD * 2, h: 1 });
  const cursor = drawPrompt(state, buf, hits, promptBox, state.focus === "prompt" && state.overlay === "none");
  drawShortcuts(state, buf, { x: OUTER_HPAD, y: statusY, w: cols - OUTER_HPAD * 2, h: 1 });
  drawDropdown(state, buf, hits, promptBox);
  return cursor;
}

function drawTopBar(state: TuiState, buf: ScreenBuffer, rect: Rect): void {
  const parts = ["Copilot"];
  parts.push(formatCwd(state.cwd, state.home));
  if (state.branch) parts.push(state.branch);
  if (state.readOnly) parts.push("read-only");
  let x = rect.x;
  parts.forEach((part, index) => {
    if (index > 0) {
      buf.text(x, rect.y, ` ${glyphs.sep} `, { fg: theme.grayDim });
      x += 3;
    }
    buf.text(x, rect.y, truncate(part, Math.max(4, rect.w - (x - rect.x) - 16)), {
      fg: index === 0 ? theme.textPrimary : theme.gray,
      bold: index === 0,
    });
    x += stringWidth(part) + 1;
  });
  if (state.usage !== undefined) {
    const chip = `${formatContextTokens(state.usage.conversationTokens)} / ${formatContextTokens(state.usage.contextWindowTokens)}`;
    const color = contextGradientHex(state.usage.usagePercent);
    buf.text(rect.x + rect.w - stringWidth(chip), rect.y, chip, { fg: color });
  }
}

function drawScrollback(state: TuiState, buf: ScreenBuffer, hits: HitRegion[], rect: Rect): void {
  const blocks = state.entries.map((entry, index) => layoutEntry(state, entry, index, rect.w));
  const total = blocks.reduce((sum, block) => sum + block.lines.length, 0);
  const view = rect.h;
  const maxOff = Math.max(0, total - view);
  const offset = Math.min(state.scrollOffset, maxOff);
  let start = Math.max(0, total - view - offset);
  let y = rect.y;
  let lineNo = 0;
  for (const [index, block] of blocks.entries()) {
    for (const line of block.lines) {
      if (lineNo >= start && y < rect.y + rect.h) {
        let x = rect.x;
        for (const span of line) {
          buf.text(x, y, span.text, span.style, rect.w - (x - rect.x));
          x += stringWidth(span.text);
        }
        hits.push({
          id: { kind: "scrollback", index },
          rect: { x: rect.x, y, w: rect.w, h: 1 },
        });
        y += 1;
      }
      lineNo += 1;
    }
  }
}

function layoutEntry(
  state: TuiState,
  entry: ScrollbackEntry,
  index: number,
  width: number,
): { lines: { text: string; style: Style }[][] } {
  const selected = state.focus === "scrollback" && state.selected === index;
  const pad = state.compactMode ? 0 : 1;
  const contentW = Math.max(8, width - 4);
  const lines: { text: string; style: Style }[][] = [];
  const push = (spans: { text: string; style: Style }[]): void => {
    lines.push(spans);
  };
  const band = (text: string, fg: string, extra: Style = {}): void => {
    const bg = selected ? theme.bgVisual : extra.bg;
    push([{ text: text.padEnd(width), style: { fg, ...extra, ...(bg === undefined ? {} : { bg }) } }]);
  };

  if (entry.kind === "user") {
    if (pad) push([{ text: "", style: {} }]);
    const prefix = `${glyphs.prompt} `;
    const wrapped = promptLines(entry.text, contentW - 2);
    wrapped.forEach((line, row) => {
      push([
        { text: "  ", style: { bg: theme.bgLight } },
        { text: row === 0 ? prefix : "  ", style: { fg: theme.accentUser, bg: theme.bgLight } },
        { text: line, style: { fg: theme.textPrimary, bg: theme.bgLight } },
      ]);
    });
    if (pad) push([{ text: "", style: { bg: theme.bgLight } }]);
    return { lines };
  }

  if (entry.kind === "assistant") {
    const md = renderMarkdown(entry.text, contentW, { raw: entry.raw });
    const show = entry.collapsed ? md.slice(0, 3) : md;
    for (const line of show) {
      push([{ text: "  ", style: {} }, ...line.spans]);
    }
    if (entry.collapsed && md.length > 3) {
      push([{ text: "  …", style: { fg: theme.gray } }]);
    }
    return { lines };
  }

  if (entry.kind === "tool") {
    const tool = entry;
    const running = tool.status === "running";
    const railColor =
      tool.status === "error" ? theme.accentError : running ? theme.accentRunning : theme.accentSuccess;
    const titleColor = entry.collapsed ? theme.gray : theme.grayBright;
    const prefix = `${glyphs.bullet} `;
    const label = callSummary(tool.call);
    const agent = tool.agentId === undefined ? "" : ` agent#${tool.agentId}`;
    push([
      { text: `${glyphs.rail} `, style: { fg: railColor } },
      { text: prefix, style: { fg: titleColor } },
      { text: truncate(label + agent, contentW - 4), style: { fg: titleColor, bold: !entry.collapsed } },
    ]);
    if (!entry.collapsed) {
      const body = displayedOutput(tool.output);
      const bodyLines = body.length === 0 && running ? ["…"] : promptLines(body, contentW - 2);
      for (const line of bodyLines.slice(0, running ? 20 : 40)) {
        push([
          { text: `${glyphs.rail} `, style: { fg: railColor } },
          { text: "  ", style: {} },
          { text: line, style: { fg: theme.grayBright } },
        ]);
      }
    }
    return { lines };
  }

  if (entry.kind === "compaction") {
    const msg =
      entry.phase === "start"
        ? `${entry.automatic ? "Auto-compacting" : "Compacting"}${entry.tokens === undefined ? "" : ` at ~${formatContextTokens(entry.tokens)} tokens`}…`
        : `Continued in a new browser chat${entry.tokens === undefined ? "" : ` (~${formatContextTokens(entry.tokens)} retained)`}.`;
    band(`  ${msg}`, theme.warning);
    return { lines };
  }

  if (entry.kind === "subagent") {
    push([
      { text: "  ", style: {} },
      { text: `${glyphs.group} `, style: { fg: theme.gray } },
      {
        text: truncate(`[agent#${entry.agentId}] ${entry.name} ${entry.event} — ${entry.detail}`, contentW),
        style: { fg: theme.grayBright },
      },
    ]);
    return { lines };
  }

  const fg = entry.kind === "warning" ? theme.warning : theme.gray;
  const text = entry.kind === "warning" ? entry.message : entry.message;
  for (const line of promptLines(text, contentW)) {
    push([{ text: "  ", style: {} }, { text: line, style: { fg } }]);
  }
  return { lines };
}

function displayedOutput(output: string): string {
  return output.length <= TOOL_DISPLAY_LIMIT ? output : `${output.slice(0, TOOL_DISPLAY_LIMIT)}\n… truncated`;
}

function drawTurnStatus(state: TuiState, buf: ScreenBuffer, hits: HitRegion[], rect: Rect): void {
  const spin = SPINNER_FRAMES[Math.floor(state.now / SPINNER_MS) % SPINNER_FRAMES.length]!;
  const waiting = state.approval !== undefined;
  const glyph = waiting ? glyphs.waiting : spin;
  const label = turnLabel(state);
  const color =
    state.turn === "cancelling"
      ? theme.accentError
      : state.turn === "running"
        ? theme.accentSuccess
        : state.turn === "compacting"
          ? theme.warning
          : theme.textSecondary;
  const elapsed = formatDuration(state.now - state.turnStartedAt);
  buf.text(rect.x, rect.y, `${glyph} ${label} ${elapsed}`, { fg: color });
  const right: string[] = [];
  if (state.usage) right.push(`${glyphs.tokenDown}${formatTurnTokens(state.usage.conversationTokens)}`);
  if (state.queued.length > 0) right.push(`· ${state.queued.length} queued`);
  right.push("[stop]");
  const text = right.join("  ");
  buf.text(rect.x + rect.w - stringWidth(text), rect.y, text, { fg: theme.gray });
  hits.push({
    id: { kind: "stop" },
    rect: { x: rect.x + rect.w - 6, y: rect.y, w: 6, h: 1 },
  });
}

function turnLabel(state: TuiState): string {
  if (state.approval !== undefined) return "Waiting…";
  switch (state.turn) {
    case "starting":
      return "Starting session…";
    case "thinking":
      return "Thinking…";
    case "responding":
      return "Responding…";
    case "running":
      return "Running…";
    case "compacting":
      return "Compacting…";
    case "cancelling":
      return "Cancelling…";
    default:
      return "Working…";
  }
}

function promptHeight(state: TuiState, cols: number): number {
  const inner = Math.max(8, cols - OUTER_HPAD * 2 - 6 - PROMPT_ARROW.length);
  const lines = Math.max(1, promptLines(state.prompt, inner).length);
  return Math.min(state.multiline ? 12 : 8, lines + 2);
}

function drawPrompt(
  state: TuiState,
  buf: ScreenBuffer,
  hits: HitRegion[],
  rect: Rect,
  focused: boolean,
): { x: number; y: number; visible: boolean } {
  const border = focused ? theme.promptBorderActive : theme.promptBorder;
  const dim = (hex: string) => (focused ? hex : blendHex(theme.bgBase, hex, 0.66));
  const inner = drawBox(buf, rect, { fg: border }, {
    title: state.title,
    titleStyle: { fg: focused ? theme.captionFocused : theme.captionUnfocused },
    footer: promptFooter(state),
    footerStyle: { fg: focused ? theme.gray : theme.captionUnfocused },
  });
  hits.push({ id: { kind: "prompt" }, rect });
  const prefixColor = focused ? theme.accentUser : theme.grayDim;
  const textColor = dim(theme.textPrimary);
  const innerW = Math.max(1, inner.w - 3);
  const empty = state.prompt.length === 0;
  const placeholder = !focused && empty;
  const lines = placeholder ? ["Build anything"] : promptLines(state.prompt, innerW - 2);
  lines.forEach((line, row) => {
    if (row >= inner.h) return;
    const y = inner.y + row;
    buf.text(inner.x + 1, y, row === 0 ? PROMPT_ARROW : "  ", { fg: prefixColor });
    buf.text(inner.x + 1 + 2, y, line, { fg: placeholder ? theme.gray : textColor });
  });
  const caret = wrappedCursor(state.prompt, state.cursor, innerW - 2);
  return {
    x: inner.x + 1 + 2 + caret.col,
    y: inner.y + caret.row,
    visible: focused && !placeholder,
  };
}

function promptFooter(state: TuiState): string {
  const flags = [permissionLabel(state)];
  if (state.multiline) flags.push("multiline");
  if (state.vimMode) flags.push("vim");
  return `copilot-browser · ${flags.join(" · ")}`;
}

function drawDropdown(state: TuiState, buf: ScreenBuffer, hits: HitRegion[], promptBox: Rect): void {
  const slash = slashToken(state.prompt);
  const at = atQuery(state.prompt, state.cursor);
  let items: { label: string; description: string }[] = [];
  if (slash !== undefined && !state.prompt.includes(" ")) {
    items = filterCommands(slash).map((command) => ({
      label: `/${command.name}`,
      description: command.description,
    }));
  } else if (at !== undefined) {
    items = fuzzyFilter(at, state.files)
      .slice(0, 20)
      .map((hit) => ({ label: hit.text, description: "" }));
  }
  if (items.length === 0) return;
  const visible = items.slice(0, MAX_SLASH_VISIBLE);
  const height = visible.length + 2;
  const rect: Rect = {
    x: promptBox.x,
    y: Math.max(OUTER_VPAD, promptBox.y - height),
    w: promptBox.w,
    h: height,
  };
  buf.fill(rect, { bg: theme.bgLight });
  hline(buf, rect.x, rect.y, rect.w, { fg: theme.bgHighlight });
  hline(buf, rect.x, rect.y + rect.h - 1, rect.w, { fg: theme.bgHighlight });
  const count = `${visible.length}/${items.length}`;
  buf.text(rect.x + rect.w - stringWidth(count) - 1, rect.y, count, { fg: theme.gray });
  visible.forEach((item, index) => {
    const selected = index === 0;
    const y = rect.y + 1 + index;
    if (selected) buf.fill({ x: rect.x, y, w: rect.w, h: 1 }, { bg: theme.bgVisual });
    const gutter = selected ? `${glyphs.prompt} ` : "  ";
    buf.text(rect.x + 1, y, gutter, {
      fg: theme.textPrimary,
      bold: selected,
      bg: selected ? theme.bgVisual : theme.bgLight,
    });
    const labelW = Math.min(40, Math.floor(rect.w * 0.6));
    buf.text(rect.x + 3, y, truncate(item.label, labelW), {
      fg: theme.textPrimary,
      bold: selected,
      bg: selected ? theme.bgVisual : theme.bgLight,
    });
    if (item.description) {
      buf.text(rect.x + 3 + labelW + 2, y, truncate(item.description, rect.w - labelW - 8), {
        fg: theme.gray,
        bg: selected ? theme.bgVisual : theme.bgLight,
      });
    }
    hits.push({ id: { kind: "overlay", index }, rect: { x: rect.x, y, w: rect.w, h: 1 } });
  });
}

function drawShortcuts(state: TuiState, buf: ScreenBuffer, rect: Rect): void {
  const hints: string[] = [];
  if (state.quitArmedUntil > state.now) hints.push("press again to quit");
  else if (state.escArmedUntil > state.now) hints.push("press again to clear");
  else if (state.approval !== undefined) hints.push("↑/↓ select", "enter approve", "esc park");
  else if (state.focus === "scrollback") {
    hints.push("↑/↓ select", "tab prompt", "←/→ fold");
  } else if (state.turn !== "idle" && state.turn !== "starting") {
    hints.push("enter queue", "esc cancel", "? commands");
  } else {
    hints.push("enter send", "tab scrollback", "? commands", "/ for more");
  }
  buf.text(rect.x, rect.y, joinHints(hints, rect.w), { fg: theme.grayDim });
}

function renderOverlay(state: TuiState, buf: ScreenBuffer, hits: HitRegion[], cols: number, rows: number): void {
  const width = Math.min(72, cols - 6);
  const height = Math.min(18, rows - 4);
  const rect: Rect = {
    x: Math.max(2, Math.floor((cols - width) / 2)),
    y: Math.max(1, Math.floor((rows - height) / 2)),
    w: width,
    h: height,
  };
  buf.fill(rect, { bg: theme.bgLight });
  const title =
    state.overlay === "palette"
      ? "Commands"
      : state.overlay === "help"
        ? "Help"
        : state.overlay === "shortcuts"
          ? "Keyboard shortcuts"
          : state.overlay === "tasks"
            ? "Subagents"
            : state.overlay === "find"
              ? "Find"
              : state.overlay === "settings"
                ? "Settings"
                : state.overlay === "rewind"
                  ? "Rewind"
                  : state.overlay === "viewer"
                    ? "Viewer"
                    : "";
  const inner = drawBox(buf, rect, { fg: theme.promptBorderActive, bg: theme.bgLight }, {
    title,
    titleStyle: { fg: theme.captionFocused, bg: theme.bgLight },
  });
  const items = overlayLines(state);
  const start = Math.max(0, state.overlayIndex - (inner.h - 1));
  items.slice(start, start + inner.h).forEach((line, row) => {
    const index = start + row;
    const selected = index === state.overlayIndex && items.length > 0;
    if (selected) buf.fill({ x: inner.x, y: inner.y + row, w: inner.w, h: 1 }, { bg: theme.bgVisual });
    buf.text(inner.x + 1, inner.y + row, truncate(line, inner.w - 2), {
      fg: theme.textPrimary,
      bg: selected ? theme.bgVisual : theme.bgLight,
      bold: selected,
    });
    hits.push({
      id: { kind: "overlay", index },
      rect: { x: inner.x, y: inner.y + row, w: inner.w, h: 1 },
    });
  });
}

function overlayLines(state: TuiState): string[] {
  if (state.overlay === "palette") {
    const q = state.overlayQuery.toLowerCase();
    return paletteItems()
      .filter((item) => q.length === 0 || item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q))
      .map((item) => `${item.label.padEnd(32)}${item.hint}`);
  }
  if (state.overlay === "help") {
    return [
      "Agent mode runs local tools through Copilot.",
      "Chat mode sends raw prompts with no tools.",
      "Mutating tools ask unless always-approve is on.",
      "Token counts are local estimates; /compact starts a new chat.",
      "Subagents run in extra Chrome tabs; /agents lists them.",
      "",
      ...filterCommands("").map((command) => `/${command.name.padEnd(16)} ${command.description}`),
    ];
  }
  if (state.overlay === "shortcuts") {
    return [
      "Enter                 send",
      "Tab                   focus scrollback / prompt",
      "Esc                   cancel running turn",
      "Esc Esc               clear prompt / rewind",
      "Ctrl+P  or  ?         command palette",
      "Ctrl+X                shortcuts",
      "Ctrl+O                always-approve",
      "Shift+Tab             cycle agent / always / chat",
      "Ctrl+G                tasks pane",
      "Ctrl+N                new session",
      "Ctrl+Q / Ctrl+D       quit (press twice)",
      "↑ empty prompt        history",
    ];
  }
  if (state.overlay === "tasks") {
    if (state.agents.length === 0) return ["No subagents yet. The coding agent spawns them with the agent operation."];
    return state.agents.map((agent) => {
      const tab = agent.sessionOpen ? "tab open" : "tab closed";
      const tokens =
        agent.tokenUsage === undefined ? "" : ` ~${formatContextTokens(agent.tokenUsage.conversationTokens)}`;
      return `#${agent.id} ${agent.name} — ${agent.status}, ${agent.steps} steps${tokens}, ${tab}`;
    });
  }
  if (state.overlay === "find") {
    const q = state.findQuery.toLowerCase();
    const hits = state.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entryText(entry).toLowerCase().includes(q) && q.length > 0);
    return [`Find: ${state.findQuery || "…"}`, ...hits.map((hit) => `#${hit.index} ${truncate(entryText(hit.entry), 60)}`)];
  }
  if (state.overlay === "settings") {
    return [
      `vim mode          ${state.vimMode ? "on" : "off"}`,
      `multiline         ${state.multiline ? "on" : "off"}`,
      `compact display   ${state.compactMode ? "on" : "off"}`,
      `always-approve    ${state.permission === "always" ? "on" : "off"}`,
      `mode              ${state.sessionKind}`,
    ];
  }
  if (state.overlay === "rewind") {
    const users = state.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === "user");
    if (users.length === 0) return ["Nothing to rewind."];
    return users.map(({ entry, index }) => `#${index} ${truncate(entry.kind === "user" ? entry.text : "", 50)}`);
  }
  if (state.overlay === "viewer") {
    const entry = state.entries[state.selected];
    if (entry === undefined) return ["No entry selected."];
    return promptLines(entryText(entry), 60);
  }
  return [];
}

function renderApproval(state: TuiState, buf: ScreenBuffer, hits: HitRegion[], cols: number, rows: number): void {
  const approval = state.approval;
  if (approval === undefined) return;
  const width = Math.min(70, cols - 6);
  const args = JSON.stringify(approval.call.arguments, null, 2);
  const argLines = approval.expanded ? promptLines(args, width - 6) : promptLines(args, width - 6).slice(0, 8);
  const height = Math.min(16, argLines.length + 8);
  const rect: Rect = {
    x: Math.max(2, Math.floor((cols - width) / 2)),
    y: Math.max(2, rows - height - 6),
    w: width,
    h: height,
  };
  buf.fill(rect, { bg: theme.bgLight });
  const inner = drawBox(buf, rect, { fg: theme.warning, bg: theme.bgLight }, {
    title: "Permission",
    titleStyle: { fg: theme.warning, bg: theme.bgLight },
  });
  buf.text(inner.x + 1, inner.y, truncate(approval.definition.name, inner.w - 2), {
    fg: theme.textPrimary,
    bold: true,
    bg: theme.bgLight,
  });
  buf.text(inner.x + 1, inner.y + 1, truncate(approval.definition.description, inner.w - 2), {
    fg: theme.gray,
    bg: theme.bgLight,
  });
  argLines.forEach((line, row) => {
    buf.text(inner.x + 1, inner.y + 3 + row, truncate(line, inner.w - 2), { fg: theme.grayBright, bg: theme.bgLight });
  });
  const options = ["Yes, allow", "No, decline"];
  options.forEach((label, index) => {
    const y = inner.y + inner.h - 2 + index;
    const selected = approval.selected === index;
    const text = `${index + 1}. ${label}`;
    buf.text(inner.x + 1, y, text, {
      fg: theme.textPrimary,
      bg: selected ? theme.bgVisual : theme.bgLight,
      bold: selected,
    });
    hits.push({ id: { kind: "approve", option: index }, rect: { x: inner.x, y, w: inner.w, h: 1 } });
  });
}

export function entryText(entry: ScrollbackEntry): string {
  switch (entry.kind) {
    case "user":
    case "assistant":
      return entry.text;
    case "tool":
      return `${callSummary(entry.call)}\n${entry.output}`;
    case "warning":
    case "system":
      return entry.message;
    case "compaction":
      return entry.phase;
    case "subagent":
      return `${entry.name} ${entry.detail}`;
  }
}

export function lastAssistant(state: TuiState): string | undefined {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "assistant") return entry.text;
  }
  return undefined;
}
