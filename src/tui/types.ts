import type { TokenUsageEstimate } from "../tokens.js";
import type { ToolCall, ToolDefinition } from "../agent/types.js";
import type { SubagentRecord } from "../agent/subagent.js";
import type { CompletionModel } from "./completion.js";

export type Screen = "welcome" | "agent";
export type Focus = "prompt" | "scrollback";
export type SessionKind = "agent" | "chat";
export type PermissionMode = "ask" | "always";
export type OverlayKind =
  | "none"
  | "palette"
  | "help"
  | "shortcuts"
  | "tasks"
  | "viewer"
  | "approval"
  | "find"
  | "settings"
  | "rewind";

export type TurnPhase =
  | "idle"
  | "starting"
  | "thinking"
  | "responding"
  | "running"
  | "compacting"
  | "waiting"
  | "cancelling";

export type EntryKind = "user" | "assistant" | "tool" | "compaction" | "warning" | "system" | "subagent";

export interface BaseEntry {
  id: number;
  collapsed: boolean;
  raw: boolean;
  createdAt: number;
}

export interface UserEntry extends BaseEntry {
  kind: "user";
  text: string;
}

export interface AssistantEntry extends BaseEntry {
  kind: "assistant";
  text: string;
  streaming: boolean;
}

export interface ToolEntry extends BaseEntry {
  kind: "tool";
  call: ToolCall;
  status: "running" | "ok" | "error";
  output: string;
  agentId?: number;
}

export interface CompactionEntry extends BaseEntry {
  kind: "compaction";
  phase: "start" | "complete";
  automatic: boolean;
  tokens?: number;
}

export interface WarningEntry extends BaseEntry {
  kind: "warning";
  message: string;
}

export interface SystemEntry extends BaseEntry {
  kind: "system";
  message: string;
}

export interface SubagentEntry extends BaseEntry {
  kind: "subagent";
  agentId: number;
  name: string;
  event: string;
  detail: string;
}

export type ScrollbackEntry =
  | UserEntry
  | AssistantEntry
  | ToolEntry
  | CompactionEntry
  | WarningEntry
  | SystemEntry
  | SubagentEntry;

export interface ApprovalRequest {
  id: number;
  call: ToolCall;
  definition: ToolDefinition;
  selected: number;
  expanded: boolean;
}

export interface Toast {
  message: string;
  until: number;
}

export interface TuiOptions {
  autoApprove: boolean;
  readOnly: boolean;
  rawChat: boolean;
  cwd: string;
  allowedRoots: string[];
  home?: string;
  branch?: string;
}

export interface TuiState {
  screen: Screen;
  focus: Focus;
  overlay: OverlayKind;
  overlayQuery: string;
  overlayIndex: number;
  sessionKind: SessionKind;
  permission: PermissionMode;
  vimMode: boolean;
  multiline: boolean;
  compactMode: boolean;
  title: string;
  cwd: string;
  home: string;
  branch: string;
  allowedRoots: string[];
  readOnly: boolean;
  ready: boolean;
  launching: boolean;
  launchError: string;
  prompt: string;
  cursor: number;
  completion?: CompletionModel | undefined;
  history: string[];
  historyIndex: number;
  stash: string;
  queued: string[];
  entries: ScrollbackEntry[];
  selected: number;
  scrollOffset: number;
  usage?: TokenUsageEstimate | undefined;
  turn: TurnPhase;
  turnStartedAt: number;
  cancelled: boolean;
  approval?: ApprovalRequest | undefined;
  nextEntryId: number;
  nextApprovalId: number;
  toast?: Toast | undefined;
  findQuery: string;
  welcomeIndex: number;
  quitArmedUntil: number;
  escArmedUntil: number;
  newArmedUntil: number;
  mouse: { x: number; y: number };
  files: string[];
  tools: string[];
  agents: SubagentRecord[];
  now: number;
}

export type Effect =
  | { type: "quit" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "newChat" }
  | { type: "compact"; note?: string }
  | { type: "copy"; text: string }
  | { type: "login" }
  | { type: "approve"; id: number; allow: boolean }
  | { type: "listTools" }
  | { type: "listSkills" }
  | { type: "refreshAgents" }
  | { type: "toast"; message: string };

export interface HitRegion {
  id:
    | { kind: "prompt" }
    | { kind: "scrollback"; index: number }
    | { kind: "menu"; index: number }
    | { kind: "stop" }
    | { kind: "overlay"; index: number }
    | { kind: "completion"; index: number }
    | { kind: "approve"; option: number }
    | { kind: "expand"; index: number };
  rect: { x: number; y: number; w: number; h: number };
}

export type NewEntry =
  | Omit<UserEntry, "id" | "createdAt">
  | Omit<AssistantEntry, "id" | "createdAt">
  | Omit<ToolEntry, "id" | "createdAt">
  | Omit<CompactionEntry, "id" | "createdAt">
  | Omit<WarningEntry, "id" | "createdAt">
  | Omit<SystemEntry, "id" | "createdAt">
  | Omit<SubagentEntry, "id" | "createdAt">;

export function createState(options: TuiOptions, now = Date.now()): TuiState {
  return {
    screen: "welcome",
    focus: "prompt",
    overlay: "none",
    overlayQuery: "",
    overlayIndex: 0,
    sessionKind: options.rawChat ? "chat" : "agent",
    permission: options.autoApprove ? "always" : "ask",
    vimMode: false,
    multiline: false,
    compactMode: false,
    title: "Copilot",
    cwd: options.cwd,
    home: options.home ?? options.cwd,
    branch: options.branch ?? "",
    allowedRoots: options.allowedRoots,
    readOnly: options.readOnly,
    ready: false,
    launching: true,
    launchError: "",
    prompt: "",
    cursor: 0,
    completion: undefined,
    history: [],
    historyIndex: -1,
    stash: "",
    queued: [],
    entries: [],
    selected: 0,
    scrollOffset: 0,
    turn: "starting",
    turnStartedAt: now,
    cancelled: false,
    nextEntryId: 1,
    nextApprovalId: 1,
    findQuery: "",
    welcomeIndex: 0,
    quitArmedUntil: 0,
    escArmedUntil: 0,
    newArmedUntil: 0,
    mouse: { x: -1, y: -1 },
    files: [],
    tools: [],
    agents: [],
    now,
  };
}

export function callSummary(call: ToolCall): string {
  const preferred = ["path", "pattern", "command"].find((name) => typeof call.arguments[name] === "string");
  const value = preferred === undefined ? "" : ` ${JSON.stringify(call.arguments[preferred])}`;
  return `${call.name}${value}`;
}

export function permissionLabel(state: TuiState): string {
  if (state.sessionKind === "chat") return "chat";
  if (state.permission === "always") return "always";
  return "agent";
}

export function cycleMode(state: TuiState): { sessionKind: SessionKind; permission: PermissionMode } {
  if (state.sessionKind === "agent" && state.permission === "ask" && !state.readOnly) {
    return { sessionKind: "agent", permission: "always" };
  }
  if (state.sessionKind === "agent") return { sessionKind: "chat", permission: "ask" };
  return { sessionKind: "agent", permission: "ask" };
}
