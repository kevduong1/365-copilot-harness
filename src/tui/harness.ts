import { homedir } from "node:os";
import { CodingAgent } from "../agent/runner.js";
import {
  SubagentManager,
  createOrchestratorTools,
  type SubagentLifecycleEvent,
  type SubagentRecord,
} from "../agent/subagent.js";
import type { AgentEvent, ConfirmTool, ToolCall, ToolDefinition } from "../agent/types.js";
import { CopilotClient } from "../client.js";
import { NotLoggedInError, ResponseTimeoutError } from "../errors.js";
import type { TokenUsageEstimate } from "../tokens.js";
import { applyToast, makeEntry, patchEntry } from "./dispatch.js";
import { callSummary, type TuiState } from "./types.js";
import { TOOL_DISPLAY_LIMIT } from "./theme.js";

export type StateSetter = (update: (state: TuiState) => TuiState) => void;

export class TuiHarness {
  client: CopilotClient | undefined;
  agent: CodingAgent | undefined;
  manager: SubagentManager | undefined;
  private readonly pending = new Map<number, (allow: boolean) => void>();
  private running: Promise<void> | undefined;
  private cancelled = false;

  constructor(
    private readonly setState: StateSetter,
    private readonly getState: () => TuiState,
    private readonly cwd: string,
    private readonly allowedRoots: string[],
    private readonly readOnly: boolean,
  ) {}

  async launch(waitForLogin = false): Promise<void> {
    this.setState((state) => ({
      ...state,
      launching: true,
      launchError: "",
      turn: "starting",
      turnStartedAt: Date.now(),
    }));
    try {
      const client = await CopilotClient.launch(waitForLogin ? { waitForLogin: true } : {});
      this.client = client;
      const confirmTool: ConfirmTool = (call, definition) => this.requestApproval(call, definition);
      this.manager = new SubagentManager({
        openSession: () => client.newTabSession(),
        cwd: this.cwd,
        allowedRoots: this.allowedRoots,
        readOnly: this.readOnly,
        confirmTool,
        onEvent: (record, event) => this.onAgentEvent(event, record.id),
        onLifecycle: (record, event) => this.onLifecycle(record, event),
      });
      this.agent = new CodingAgent(client, {
        cwd: this.cwd,
        allowedRoots: this.allowedRoots,
        readOnly: this.readOnly,
        confirmTool,
        onEvent: (event) => this.onAgentEvent(event),
        tools: await createOrchestratorTools(this.manager, this.cwd, this.allowedRoots),
      });
      this.setState((state) => ({
        ...state,
        ready: true,
        launching: false,
        launchError: "",
        turn: "idle",
        usage: client.getTokenUsage(),
        tools: [],
      }));
      await this.refreshTools();
    } catch (error) {
      const message =
        error instanceof NotLoggedInError
          ? "Not logged in. Run pnpm cli login, or /login here."
          : displayedError(error);
      this.setState((state) => ({
        ...state,
        ready: false,
        launching: false,
        launchError: message,
        turn: "idle",
      }));
    }
  }

  async close(): Promise<void> {
    this.cancelled = true;
    await this.client?.close();
  }

  async send(text: string, sessionKind: "agent" | "chat"): Promise<void> {
    const run = this.running ?? Promise.resolve();
    this.running = run.then(() => this.runTurn(text, sessionKind));
    await this.running;
  }

  cancel(): void {
    this.cancelled = true;
  }

  resolveApproval(id: number, allow: boolean): void {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(allow);
  }

  async newChat(sessionKind: "agent" | "chat"): Promise<void> {
    if (this.client === undefined || this.agent === undefined) return;
    if (sessionKind === "agent") await this.agent.reset();
    else {
      await this.client.newChat();
      this.agent.invalidate();
    }
    this.syncUsage();
  }

  async compact(sessionKind: "agent" | "chat"): Promise<void> {
    if (this.client === undefined || this.agent === undefined) return;
    this.setState((state) => ({ ...state, turn: "compacting", turnStartedAt: Date.now() }));
    try {
      if (sessionKind === "agent") await this.agent.compact();
      else {
        const result = await this.client.compact();
        if (!result.acknowledged) {
          this.setState((state) =>
            makeEntry(state, {
              kind: "warning",
              message: "Copilot did not acknowledge the compacted conversation.",
              collapsed: false,
              raw: false,
            }).state,
          );
        }
      }
    } catch (error) {
      this.setState((state) => applyToast(makeEntry(state, {
        kind: "warning",
        message: displayedError(error),
        collapsed: false,
        raw: false,
      }).state, displayedError(error), 4000));
    } finally {
      this.setState((state) => ({ ...state, turn: "idle" }));
      this.syncUsage();
    }
  }

  async refreshTools(): Promise<void> {
    const names = (await this.agent?.toolNames()) ?? [];
    this.setState((state) => ({ ...state, tools: names }));
  }

  refreshAgents(): SubagentRecord[] {
    const agents = this.manager?.list() ?? [];
    this.setState((state) => ({ ...state, agents }));
    return agents;
  }

  private async runTurn(text: string, sessionKind: "agent" | "chat"): Promise<void> {
    if (this.client === undefined || this.agent === undefined) return;
    this.cancelled = false;
    this.setState((state) => ({ ...state, turn: sessionKind === "chat" ? "responding" : "thinking", cancelled: false }));
    try {
      if (sessionKind === "agent") {
        await this.agent.run(text);
      } else {
        await this.streamChat(text);
      }
    } catch (error) {
      if (!this.cancelled) {
        this.setState((state) =>
          makeEntry(state, {
            kind: "warning",
            message: displayedError(error),
            collapsed: false,
            raw: false,
          }).state,
        );
      }
    } finally {
      this.syncUsage();
      this.setState((state) => ({
        ...state,
        turn: "idle",
        cancelled: false,
      }));
    }
  }

  private async streamChat(text: string): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    if (client.needsCompaction(text)) {
      this.setState((state) => ({ ...state, turn: "compacting" }));
      const compacted = await client.compact();
      if (!compacted.acknowledged) {
        this.setState((state) =>
          makeEntry(state, {
            kind: "warning",
            message: "Copilot did not acknowledge the compacted conversation.",
            collapsed: false,
            raw: false,
          }).state,
        );
      }
      this.setState((state) => ({ ...state, turn: "responding" }));
    }
    let id = 0;
    this.setState((state) => {
      const made = makeEntry(state, { kind: "assistant", text: "", collapsed: false, raw: false, streaming: true });
      id = made.id;
      return made.state;
    });
    let full = "";
    for await (const delta of client.send(text)) {
      if (this.cancelled) break;
      full += delta;
      this.setState((state) => patchEntry(state, id, { text: full }));
    }
    this.setState((state) => patchEntry(state, id, { text: full, streaming: false }));
  }

  private async requestApproval(call: ToolCall, definition: ToolDefinition): Promise<boolean> {
    if (this.getState().permission === "always") return true;
    return await new Promise<boolean>((resolve) => {
      this.setState((state) => {
        const id = state.nextApprovalId;
        this.pending.set(id, resolve);
        return {
          ...state,
          nextApprovalId: id + 1,
          approval: { id, call, definition, selected: 0, expanded: false },
          turn: "waiting",
        };
      });
    });
  }

  private onAgentEvent(event: AgentEvent, agentId?: number): void {
    if (this.cancelled) return;
    this.setState((state) => {
      if (event.type === "tool_start") {
        return makeEntry(
          { ...state, turn: "running" },
          {
          kind: "tool",
          call: event.call,
          status: "running",
          output: "",
          collapsed: false,
          raw: false,
          ...(agentId === undefined ? {} : { agentId }),
        }).state;
      }
      if (event.type === "tool_end") {
        const index = [...state.entries]
          .reverse()
          .find(
            (entry) =>
              entry.kind === "tool" &&
              entry.status === "running" &&
              entry.call.name === event.result.call.name &&
              (agentId === undefined || entry.agentId === agentId),
          );
        if (index !== undefined && index.kind === "tool") {
          return patchEntry(state, index.id, {
            status: event.result.ok ? "ok" : "error",
            output: displayedOutput(event.result.output),
            collapsed: event.result.output.length > 800,
            call: event.result.call,
          });
        }
        return makeEntry(state, {
          kind: "tool",
          call: event.result.call,
          status: event.result.ok ? "ok" : "error",
          output: displayedOutput(event.result.output),
          collapsed: true,
          raw: false,
          ...(agentId === undefined ? {} : { agentId }),
        }).state;
      }
      if (event.type === "assistant") {
        return makeEntry(state, {
          kind: "assistant",
          text: event.text,
          collapsed: false,
          raw: false,
          streaming: false,
        }).state;
      }
      if (event.type === "warning") {
        return makeEntry(state, { kind: "warning", message: event.message, collapsed: false, raw: false }).state;
      }
      if (event.type === "compaction") {
        const tokens =
          event.phase === "start" ? event.before?.conversationTokens : event.after?.conversationTokens;
        return makeEntry(state, {
          kind: "compaction",
          phase: event.phase,
          automatic: event.automatic,
          collapsed: false,
          raw: false,
          ...(tokens === undefined ? {} : { tokens }),
        }).state;
      }
      return state;
    });
  }

  private onLifecycle(record: SubagentRecord, event: SubagentLifecycleEvent): void {
    const detail =
      event === "started"
        ? record.tasks.at(-1) ?? ""
        : event === "failed"
          ? record.lastError ?? "unknown error"
          : `${record.steps} step${record.steps === 1 ? "" : "s"}`;
    this.setState((state) =>
      makeEntry(
        { ...state, agents: this.manager?.list() ?? state.agents },
        {
          kind: "subagent",
          agentId: record.id,
          name: record.name,
          event,
          detail,
          collapsed: false,
          raw: false,
        },
      ).state,
    );
  }

  private syncUsage(): void {
    const usage = this.client?.getTokenUsage();
    if (usage === undefined) return;
    this.setState((state) => ({ ...state, usage }));
  }
}

function displayedOutput(output: string): string {
  return output.length <= TOOL_DISPLAY_LIMIT ? output : `${output.slice(0, TOOL_DISPLAY_LIMIT)}\n… truncated`;
}

export function displayedError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const partial = error instanceof ResponseTimeoutError ? error.partialResponse.trim() : "";
  return partial
    ? `${error.name}: ${error.message}\nPartial response:\n${displayedOutput(partial)}`
    : `${error.name}: ${error.message}`;
}

export function defaultHome(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}
