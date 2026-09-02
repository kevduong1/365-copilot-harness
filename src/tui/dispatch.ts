import { filterCommands, findCommand, paletteItems, welcomeItems } from "./commands.js";
import { fuzzyFilter } from "./fuzzy.js";
import { type InputEvent, type KeyEvent, type MouseEvent } from "./keys.js";
import {
  atQuery,
  deleteBackward,
  deleteForward,
  insertText,
  killLine,
  move,
  slashToken,
} from "./prompt.js";
import { entryText, lastAssistant } from "./render.js";
import { ESC_DOUBLE_MS, QUIT_CONFIRM_MS } from "./theme.js";
import {
  callSummary,
  cycleMode,
  type Effect,
  type HitRegion,
  type NewEntry,
  type OverlayKind,
  type ScrollbackEntry,
  type TuiState,
} from "./types.js";

export interface DispatchResult {
  state: TuiState;
  effects: Effect[];
}

export function dispatch(state: TuiState, event: InputEvent, hits: HitRegion[]): DispatchResult {
  if (event.type === "mouse") return dispatchMouse(state, event, hits);
  return dispatchKey(state, event);
}

function dispatchMouse(state: TuiState, event: MouseEvent, hits: HitRegion[]): DispatchResult {
  const next = { ...state, mouse: { x: event.x, y: event.y } };
  if (event.kind === "scroll") {
    const delta = event.button === "wheelup" ? 3 : -3;
    return { state: { ...next, scrollOffset: Math.max(0, next.scrollOffset + delta), focus: "scrollback" }, effects: [] };
  }
  if (event.kind !== "down") return { state: next, effects: [] };
  const hit = [...hits].reverse().find((region) => containsHit(region, event.x, event.y));
  if (hit === undefined) return { state: next, effects: [] };
  if (hit.id.kind === "prompt") return { state: { ...next, focus: "prompt" }, effects: [] };
  if (hit.id.kind === "scrollback") {
    return { state: { ...next, focus: "scrollback", selected: hit.id.index, screen: "agent" }, effects: [] };
  }
  if (hit.id.kind === "menu") {
    return runWelcomeAction({ ...next, welcomeIndex: hit.id.index }, hit.id.index);
  }
  if (hit.id.kind === "stop") return cancelTurn(next);
  if (hit.id.kind === "approve") {
    return resolveApproval({ ...next, approval: next.approval === undefined ? undefined : { ...next.approval, selected: hit.id.option } }, hit.id.option === 0);
  }
  if (hit.id.kind === "overlay") {
    return { state: { ...next, overlayIndex: hit.id.index }, effects: [] };
  }
  return { state: next, effects: [] };
}

function containsHit(hit: HitRegion, x: number, y: number): boolean {
  const r = hit.rect;
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function dispatchKey(state: TuiState, event: KeyEvent): DispatchResult {
  if (event.ctrl && event.char === "c") return handleCtrlC(state);
  if ((event.ctrl && event.char === "q") || (event.ctrl && event.char === "d")) return armQuit(state);
  if (event.ctrl && event.char === "n") return armNew(state);
  if (event.ctrl && event.char === "p") return openOverlay(state, "palette");
  if (event.ctrl && event.char === "x") return openOverlay(state, "shortcuts");
  if (event.ctrl && event.char === "g") return openOverlay(state, "tasks", [{ type: "refreshAgents" }]);
  if (event.ctrl && event.char === "o") return toggleAlways(state);
  if (event.ctrl && event.char === "s") return stashPrompt(state);
  if (event.ctrl && event.char === "k" && state.focus === "scrollback") {
    return { state: { ...state, scrollOffset: state.scrollOffset + 1 }, effects: [] };
  }
  if (event.ctrl && event.char === "j" && state.focus === "scrollback") {
    return { state: { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) }, effects: [] };
  }
  if (event.ctrl && event.char === "u") {
    return { state: { ...state, scrollOffset: state.scrollOffset + 10, focus: "scrollback" }, effects: [] };
  }
  if (event.ctrl && event.char === "l") {
    if (state.turn !== "idle" && state.turn !== "starting") return sendNow(state);
  }
  if (event.name === "f2") return openOverlay(state, "settings");
  if (event.char === "?" && state.overlay === "none" && (state.focus === "scrollback" || state.prompt.length === 0)) {
    return openOverlay(state, "palette");
  }

  if (state.overlay !== "none") return dispatchOverlay(state, event);
  if (state.approval !== undefined && state.focus !== "scrollback") return dispatchApproval(state, event);
  if (event.name === "escape") return dispatchEscape(state);
  if (event.name === "tab" && event.shift) return cycle(state);
  if (event.name === "tab") {
    return {
      state: { ...state, focus: state.focus === "prompt" ? "scrollback" : "prompt" },
      effects: [],
    };
  }

  if (state.focus === "scrollback") return dispatchScrollback(state, event);
  return dispatchPrompt(state, event);
}

function handleCtrlC(state: TuiState): DispatchResult {
  if (state.overlay !== "none") return { state: { ...state, overlay: "none", overlayQuery: "" }, effects: [] };
  if (state.prompt.length > 0) {
    return { state: { ...state, prompt: "", cursor: 0 }, effects: [] };
  }
  if (state.turn !== "idle" && state.turn !== "starting") return cancelTurn(state);
  return { state, effects: [] };
}

function armQuit(state: TuiState): DispatchResult {
  if (state.now <= state.quitArmedUntil) return { state, effects: [{ type: "quit" }] };
  return {
    state: {
      ...state,
      quitArmedUntil: state.now + QUIT_CONFIRM_MS,
      toast: { message: "Press again to quit", until: state.now + QUIT_CONFIRM_MS },
    },
    effects: [],
  };
}

function armNew(state: TuiState): DispatchResult {
  if (state.now <= state.newArmedUntil) return runSlash(state, "new", "");
  return {
    state: {
      ...state,
      newArmedUntil: state.now + QUIT_CONFIRM_MS,
      toast: { message: "Press again for a new session", until: state.now + QUIT_CONFIRM_MS },
    },
    effects: [],
  };
}

function stashPrompt(state: TuiState): DispatchResult {
  if (state.prompt.length > 0) {
    return { state: { ...state, stash: state.prompt, prompt: "", cursor: 0 }, effects: [] };
  }
  if (state.stash.length === 0) return { state, effects: [] };
  return { state: { ...state, prompt: state.stash, cursor: state.stash.length, stash: "" }, effects: [] };
}

function toggleAlways(state: TuiState): DispatchResult {
  if (state.readOnly) return { state, effects: [{ type: "toast", message: "read-only session" }] };
  const permission = state.permission === "always" ? "ask" : "always";
  return {
    state: { ...state, permission },
    effects: [{ type: "toast", message: permission === "always" ? "always-approve on" : "always-approve off" }],
  };
}

function cycle(state: TuiState): DispatchResult {
  const next = cycleMode(state);
  const effects: Effect[] = [];
  if (next.sessionKind !== state.sessionKind) {
    effects.push({ type: "newChat" });
  }
  return { state: { ...state, ...next, screen: "agent" }, effects };
}

function openOverlay(state: TuiState, overlay: OverlayKind, extra: Effect[] = []): DispatchResult {
  return {
    state: { ...state, overlay, overlayQuery: "", overlayIndex: 0, findQuery: overlay === "find" ? "" : state.findQuery },
    effects: extra,
  };
}

function dispatchEscape(state: TuiState): DispatchResult {
  if (state.turn !== "idle" && state.turn !== "starting" && !state.vimMode) return cancelTurn(state);
  if (state.prompt.length > 0) {
    if (state.now <= state.escArmedUntil) {
      return { state: { ...state, stash: state.prompt, prompt: "", cursor: 0, escArmedUntil: 0 }, effects: [] };
    }
    return {
      state: {
        ...state,
        escArmedUntil: state.now + ESC_DOUBLE_MS,
        toast: { message: "press again to clear", until: state.now + ESC_DOUBLE_MS },
      },
      effects: [],
    };
  }
  if (state.entries.length > 0) {
    if (state.now <= state.escArmedUntil) return openOverlay(state, "rewind");
    return { state: { ...state, escArmedUntil: state.now + ESC_DOUBLE_MS }, effects: [] };
  }
  return { state, effects: [] };
}

function cancelTurn(state: TuiState): DispatchResult {
  if (state.turn === "idle" || state.turn === "starting") return { state, effects: [] };
  return {
    state: { ...state, turn: "cancelling", cancelled: true },
    effects: [{ type: "cancel" }],
  };
}

function dispatchApproval(state: TuiState, event: KeyEvent): DispatchResult {
  const approval = state.approval;
  if (approval === undefined) return { state, effects: [] };
  if (event.name === "up" || (event.char === "k" && state.vimMode)) {
    return { state: { ...state, approval: { ...approval, selected: Math.max(0, approval.selected - 1) } }, effects: [] };
  }
  if (event.name === "down" || (event.char === "j" && state.vimMode)) {
    return { state: { ...state, approval: { ...approval, selected: Math.min(1, approval.selected + 1) } }, effects: [] };
  }
  if (event.name === "tab") {
    return {
      state: { ...state, approval: { ...approval, selected: approval.selected === 0 ? 1 : 0 } },
      effects: [],
    };
  }
  if (event.char === "1") return resolveApproval(state, true);
  if (event.char === "2") return resolveApproval(state, false);
  if (event.ctrl && event.char === "f") {
    return { state: { ...state, approval: { ...approval, expanded: !approval.expanded } }, effects: [] };
  }
  if (event.name === "enter") return resolveApproval(state, approval.selected === 0);
  if (event.name === "escape") return { state: { ...state, focus: "scrollback" }, effects: [] };
  return { state, effects: [] };
}

function resolveApproval(state: TuiState, allow: boolean): DispatchResult {
  const approval = state.approval;
  if (approval === undefined) return { state, effects: [] };
  return {
    state: { ...state, approval: undefined, focus: "prompt" },
    effects: [{ type: "approve", id: approval.id, allow }],
  };
}

function dispatchOverlay(state: TuiState, event: KeyEvent): DispatchResult {
  if (event.name === "escape") return { state: { ...state, overlay: "none", overlayQuery: "" }, effects: [] };
  if (event.name === "up") {
    return { state: { ...state, overlayIndex: Math.max(0, state.overlayIndex - 1) }, effects: [] };
  }
  if (event.name === "down") {
    return { state: { ...state, overlayIndex: state.overlayIndex + 1 }, effects: [] };
  }
  if (event.name === "enter") return confirmOverlay(state);
  if (state.overlay === "find" || state.overlay === "palette") {
    if (event.name === "backspace") {
      const q = (state.overlay === "find" ? state.findQuery : state.overlayQuery).slice(0, -1);
      return {
        state: {
          ...state,
          ...(state.overlay === "find" ? { findQuery: q } : { overlayQuery: q }),
          overlayIndex: 0,
        },
        effects: [],
      };
    }
    if (event.name === "char" || event.name === "space") {
      const ch = event.name === "space" ? " " : event.char;
      const q = (state.overlay === "find" ? state.findQuery : state.overlayQuery) + ch;
      return {
        state: {
          ...state,
          ...(state.overlay === "find" ? { findQuery: q } : { overlayQuery: q }),
          overlayIndex: 0,
        },
        effects: [],
      };
    }
  }
  return { state, effects: [] };
}

function confirmOverlay(state: TuiState): DispatchResult {
  if (state.overlay === "palette") {
    const q = state.overlayQuery.toLowerCase();
    const items = paletteItems().filter(
      (item) => q.length === 0 || item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q),
    );
    const item = items[state.overlayIndex];
    const closed = { ...state, overlay: "none" as const, overlayQuery: "" };
    if (item?.command !== undefined) {
      const [name, ...rest] = item.command.slice(1).split(" ");
      return runSlash(closed, name ?? "", rest.join(" "));
    }
    return { state: closed, effects: [] };
  }
  if (state.overlay === "rewind") {
    const users = state.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === "user");
    const picked = users[state.overlayIndex];
    const closed = { ...state, overlay: "none" as const };
    if (picked === undefined) return { state: closed, effects: [] };
    return {
      state: {
        ...closed,
        entries: state.entries.slice(0, picked.index + 1),
        selected: picked.index,
      },
      effects: [{ type: "newChat" }, { type: "toast", message: "Rewound locally; Copilot chat reset" }],
    };
  }
  if (state.overlay === "find") {
    return { state: { ...state, overlay: "none", focus: "scrollback" }, effects: [] };
  }
  return { state: { ...state, overlay: "none" }, effects: [] };
}

function dispatchScrollback(state: TuiState, event: KeyEvent): DispatchResult {
  const letter = event.name === "char" && event.char.length === 1 && !event.ctrl;
  if (!state.vimMode && letter && /[a-z]/i.test(event.char) && event.char !== "?") {
    const inserted = insertText({ text: state.prompt, cursor: state.cursor }, event.char);
    return { state: { ...state, focus: "prompt", prompt: inserted.text, cursor: inserted.cursor }, effects: [] };
  }
  if (event.name === "space" && !state.vimMode) {
    return { state: { ...state, focus: "prompt" }, effects: [] };
  }
  const prev = () => ({
    state: { ...state, selected: Math.max(0, state.selected - 1), scrollOffset: state.scrollOffset + 1 },
    effects: [] as Effect[],
  });
  const next = () => ({
    state: {
      ...state,
      selected: Math.min(Math.max(0, state.entries.length - 1), state.selected + 1),
      scrollOffset: Math.max(0, state.scrollOffset - 1),
    },
    effects: [] as Effect[],
  });
  if (event.name === "up" || (state.vimMode && event.char === "k")) return prev();
  if (event.name === "down" || (state.vimMode && event.char === "j")) return next();
  if (event.name === "pageup") return { state: { ...state, scrollOffset: state.scrollOffset + 20 }, effects: [] };
  if (event.name === "pagedown") return { state: { ...state, scrollOffset: Math.max(0, state.scrollOffset - 20) }, effects: [] };
  if (state.vimMode && event.char === "g") return { state: { ...state, selected: 0, scrollOffset: 10_000 }, effects: [] };
  if (state.vimMode && event.char === "G") {
    return { state: { ...state, selected: Math.max(0, state.entries.length - 1), scrollOffset: 0 }, effects: [] };
  }
  if (event.name === "left" || (state.vimMode && event.char === "h")) return fold(state, true);
  if (event.name === "right" || (state.vimMode && event.char === "l")) return fold(state, false);
  if (state.vimMode && event.char === "e") return toggleFold(state);
  if (event.shift && event.char === "E") return foldAll(state);
  if (state.vimMode && event.char === "r") return toggleRaw(state);
  if (state.vimMode && event.char === "y") {
    const entry = state.entries[state.selected];
    if (entry === undefined) return { state, effects: [] };
    return { state, effects: [{ type: "copy", text: entryText(entry) }] };
  }
  if (event.name === "enter") return openOverlay(state, "viewer");
  if (event.name === "space" || (state.vimMode && event.char === "i")) {
    return { state: { ...state, focus: "prompt" }, effects: [] };
  }
  return { state, effects: [] };
}

function fold(state: TuiState, collapsed: boolean): DispatchResult {
  return mapSelected(state, (entry) => ({ ...entry, collapsed }));
}

function toggleFold(state: TuiState): DispatchResult {
  return mapSelected(state, (entry) => ({ ...entry, collapsed: !entry.collapsed }));
}

function toggleRaw(state: TuiState): DispatchResult {
  return mapSelected(state, (entry) => ({ ...entry, raw: !entry.raw }));
}

function foldAll(state: TuiState): DispatchResult {
  const allCollapsed = state.entries.every((entry) => entry.collapsed);
  return {
    state: { ...state, entries: state.entries.map((entry) => ({ ...entry, collapsed: !allCollapsed })) },
    effects: [],
  };
}

function mapSelected(state: TuiState, map: (entry: ScrollbackEntry) => ScrollbackEntry): DispatchResult {
  const entries = state.entries.map((entry, index) => (index === state.selected ? map(entry) : entry));
  return { state: { ...state, entries }, effects: [] };
}

function dispatchPrompt(state: TuiState, event: KeyEvent): DispatchResult {
  if (event.name === "pageup") return { state: { ...state, scrollOffset: state.scrollOffset + 20 }, effects: [] };
  if (event.name === "pagedown") return { state: { ...state, scrollOffset: Math.max(0, state.scrollOffset - 20) }, effects: [] };
  if (event.name === "up" && state.prompt.length === 0 && state.history.length > 0) return history(state, 1);
  if (event.name === "down" && state.historyIndex >= 0) return history(state, -1);
  if (event.name === "left") {
    const moved = move({ text: state.prompt, cursor: state.cursor }, -1);
    return { state: { ...state, cursor: moved.cursor }, effects: [] };
  }
  if (event.name === "right") {
    const moved = move({ text: state.prompt, cursor: state.cursor }, 1);
    return { state: { ...state, cursor: moved.cursor }, effects: [] };
  }
  if (event.name === "home") return { state: { ...state, cursor: 0 }, effects: [] };
  if (event.name === "end") return { state: { ...state, cursor: state.prompt.length }, effects: [] };
  if (event.name === "backspace") {
    const next = deleteBackward({ text: state.prompt, cursor: state.cursor });
    return { state: { ...state, prompt: next.text, cursor: next.cursor }, effects: [] };
  }
  if (event.name === "delete") {
    const next = deleteForward({ text: state.prompt, cursor: state.cursor });
    return { state: { ...state, prompt: next.text, cursor: next.cursor }, effects: [] };
  }
  if (event.ctrl && event.char === "u") {
    return { state: { ...state, prompt: "", cursor: 0 }, effects: [] };
  }
  if (event.ctrl && event.char === "k") {
    const next = killLine({ text: state.prompt, cursor: state.cursor });
    return { state: { ...state, prompt: next.text, cursor: next.cursor }, effects: [] };
  }
  if (event.ctrl && event.char === "m") {
    return { state: { ...state, multiline: !state.multiline }, effects: [] };
  }
  if (event.name === "enter") return submitPrompt(state, event);
  if (event.name === "paste") {
    const next = insertText({ text: state.prompt, cursor: state.cursor }, event.char.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
    return { state: { ...state, prompt: next.text, cursor: next.cursor }, effects: [] };
  }
  if (event.name === "space" || event.name === "char") {
    if (event.ctrl) return { state, effects: [] };
    const ch = event.name === "space" ? " " : event.char;
    const next = insertText({ text: state.prompt, cursor: state.cursor }, ch);
    return { state: { ...state, prompt: next.text, cursor: next.cursor, historyIndex: -1 }, effects: [] };
  }
  return { state, effects: [] };
}

function history(state: TuiState, delta: number): DispatchResult {
  const index = state.historyIndex < 0 ? state.history.length - 1 : state.historyIndex - delta;
  if (index < 0) return { state: { ...state, historyIndex: -1, prompt: "", cursor: 0 }, effects: [] };
  const item = state.history[Math.min(state.history.length - 1, index)];
  if (item === undefined) return { state, effects: [] };
  return { state: { ...state, historyIndex: index, prompt: item, cursor: item.length }, effects: [] };
}

function submitPrompt(state: TuiState, event: KeyEvent): DispatchResult {
  if (state.multiline && !event.shift && !event.alt && state.prompt.length > 0) {
    const next = insertText({ text: state.prompt, cursor: state.cursor }, "\n");
    return { state: { ...state, prompt: next.text, cursor: next.cursor }, effects: [] };
  }
  if (event.shift || event.alt) {
    const next = insertText({ text: state.prompt, cursor: state.cursor }, "\n");
    return { state: { ...state, prompt: next.text, cursor: next.cursor }, effects: [] };
  }
  const slash = slashToken(state.prompt);
  if (slash !== undefined && !state.prompt.slice(slash.length).startsWith("\n")) {
    const commands = filterCommands(slash);
    if (!state.prompt.includes(" ") && commands.length > 0 && findCommand(slash) === undefined) {
      const pick = commands[0]!;
      return { state: { ...state, prompt: `/${pick.name} `, cursor: pick.name.length + 2 }, effects: [] };
    }
    const rest = state.prompt.slice(slash.length).trim();
    return runSlash({ ...state, prompt: "", cursor: 0 }, slash.slice(1), rest);
  }
  const at = atQuery(state.prompt, state.cursor);
  if (at !== undefined) {
    const hit = fuzzyFilter(at, state.files)[0];
    if (hit !== undefined) {
      const before = state.prompt.slice(0, state.cursor - at.length) + hit.text + " ";
      const text = before + state.prompt.slice(state.cursor);
      return { state: { ...state, prompt: text, cursor: before.length }, effects: [] };
    }
  }
  const text = state.prompt.trim();
  if (text.length === 0) {
    if (state.screen === "welcome") return runWelcomeAction(state, state.welcomeIndex);
    if (state.queued.length > 0) return sendNow(state);
    return { state, effects: [] };
  }
  return enqueueOrSend(state, text);
}

function sendNow(state: TuiState): DispatchResult {
  const text = state.prompt.trim() || state.queued[0];
  if (text === undefined || text.length === 0) return { state, effects: [] };
  const queued = state.prompt.trim().length > 0 ? state.queued : state.queued.slice(1);
  return enqueueOrSend(
    { ...state, prompt: "", cursor: 0, queued },
    text,
    true,
  );
}

function enqueueOrSend(state: TuiState, text: string, force = false): DispatchResult {
  const base = {
    ...state,
    screen: "agent" as const,
    prompt: "",
    cursor: 0,
    history: [...state.history.filter((item) => item !== text), text],
    historyIndex: -1,
    scrollOffset: 0,
  };
  if (!force && state.turn !== "idle" && state.turn !== "starting") {
    return { state: { ...base, queued: [...state.queued, text] }, effects: [] };
  }
  return sendText(base, text);
}

function sendText(state: TuiState, text: string): DispatchResult {
  if (!state.ready) {
    return {
      state: {
        ...state,
        prompt: text,
        cursor: text.length,
        toast: { message: state.launchError || "Still starting Chrome…", until: state.now + 2000 },
      },
      effects: [],
    };
  }
  const user = makeEntry(state, {
    kind: "user",
    text,
    collapsed: false,
    raw: false,
  });
  return {
    state: {
      ...user.state,
      turn: "thinking",
      turnStartedAt: state.now,
      cancelled: false,
      selected: user.state.entries.length - 1,
    },
    effects: [{ type: "send", text }],
  };
}

function runWelcomeAction(state: TuiState, index: number): DispatchResult {
  const items = welcomeItems(state.ready);
  const item = items[index];
  if (item === undefined) return { state, effects: [] };
  if (item.action === "quit") return armQuit(state);
  if (item.action === "palette") return openOverlay(state, "palette");
  if (item.action === "shortcuts") return openOverlay(state, "shortcuts");
  return { state: { ...state, screen: "agent", focus: "prompt" }, effects: [] };
}

export function runSlash(state: TuiState, name: string, args: string): DispatchResult {
  const command = findCommand(name);
  const resolved = command?.name ?? name.toLowerCase();
  switch (resolved) {
    case "quit":
      return { state, effects: [{ type: "quit" }] };
    case "help":
      return openOverlay(state, "help");
    case "shortcuts":
      return openOverlay(state, "shortcuts");
    case "home":
      return { state: { ...state, screen: "welcome", focus: "prompt" }, effects: [] };
    case "new":
      return {
        state: appendSystem(
          { ...state, screen: "agent", entries: [], selected: 0, scrollOffset: 0 },
          "Started a new conversation.",
        ),
        effects: [{ type: "newChat" }],
      };
    case "compact":
      return {
        state: { ...state, screen: "agent", turn: "compacting", turnStartedAt: state.now },
        effects: [{ type: "compact", ...(args.length > 0 ? { note: args } : {}) }],
      };
    case "context":
    case "session-info":
      return { state: appendUsage(state), effects: [] };
    case "copy": {
      const text = lastAssistant(state);
      if (text === undefined) return { state, effects: [{ type: "toast", message: "Nothing to copy" }] };
      return { state, effects: [{ type: "copy", text }] };
    }
    case "find":
      return openOverlay(state, "find");
    case "agent":
      if (state.sessionKind === "agent") {
        return { state, effects: [{ type: "toast", message: "Agent mode is already enabled." }] };
      }
      return {
        state: appendSystem({ ...state, sessionKind: "agent", screen: "agent" }, "Agent mode enabled."),
        effects: [],
      };
    case "chat":
      if (state.sessionKind === "chat") {
        return { state, effects: [{ type: "toast", message: "Raw chat mode is already enabled." }] };
      }
      return {
        state: appendSystem({ ...state, sessionKind: "chat", screen: "agent" }, "Raw chat mode enabled in a fresh conversation."),
        effects: [{ type: "newChat" }],
      };
    case "tools":
      return { state, effects: [{ type: "listTools" }] };
    case "agents":
      return openOverlay(state, "tasks", [{ type: "refreshAgents" }]);
    case "always-approve":
      return toggleAlways(state);
    case "multiline":
      return { state: { ...state, multiline: !state.multiline }, effects: [] };
    case "vim-mode":
      return { state: { ...state, vimMode: !state.vimMode }, effects: [] };
    case "compact-mode":
      return { state: { ...state, compactMode: !state.compactMode }, effects: [] };
    case "rename":
      if (args.trim().length === 0) return { state, effects: [{ type: "toast", message: "Usage: /rename <title>" }] };
      return { state: { ...state, title: args.trim() }, effects: [] };
    case "rewind":
      return openOverlay(state, "rewind");
    case "login":
      return { state, effects: [{ type: "login" }] };
    default:
      return { state, effects: [{ type: "toast", message: `Unknown command: /${name}` }] };
  }
}

function appendSystem(state: TuiState, message: string): TuiState {
  return makeEntry(state, { kind: "system", message, collapsed: false, raw: false }).state;
}

function appendUsage(state: TuiState): TuiState {
  const usage = state.usage;
  const message =
    usage === undefined
      ? "No token estimate yet."
      : `~${usage.conversationTokens.toLocaleString("en-US")} / ${usage.contextWindowTokens.toLocaleString("en-US")} (${usage.usagePercent.toFixed(1)}% estimated; auto-compact at ${usage.compactionThresholdPercent}%)`;
  return appendSystem(state, message);
}

export function makeEntry(state: TuiState, entry: NewEntry): { state: TuiState; id: number } {
  const id = state.nextEntryId;
  const full = { ...entry, id, createdAt: state.now } as ScrollbackEntry;
  return {
    id,
    state: {
      ...state,
      nextEntryId: id + 1,
      entries: [...state.entries, full],
      selected: state.entries.length,
    },
  };
}

export function patchEntry(state: TuiState, id: number, patch: Partial<ScrollbackEntry>): TuiState {
  return {
    ...state,
    entries: state.entries.map((entry) => (entry.id === id ? ({ ...entry, ...patch } as ScrollbackEntry) : entry)),
  };
}

export function applyToast(state: TuiState, message: string, ttl = 2000): TuiState {
  return { ...state, toast: { message, until: state.now + ttl } };
}

export { callSummary };
