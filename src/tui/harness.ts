import { homedir } from "node:os";
import {
  ApprovalPolicy,
  formatRules,
  ruleFor,
  ruleLabel,
  type ApprovalRule,
} from "../agent/policy.js";
import { CodingAgent } from "../agent/runner.js";
import { discoverSkills, formatSkillList } from "../agent/skills.js";
import { closeAllJobs } from "../agent/tools.js";
import {
  SubagentManager,
  createOrchestratorTools,
  type SubagentLifecycleEvent,
  type SubagentRecord,
} from "../agent/subagent.js";
import type { AgentEvent, ConfirmTool, ToolCall, ToolDefinition } from "../agent/types.js";
import { CopilotClient } from "../client.js";
import { NotLoggedInError, ResponseTimeoutError } from "../errors.js";
import { Mutex } from "../queue.js";
import type { TokenUsageEstimate } from "../tokens.js";
import { applyToast, makeEntry, patchEntry } from "./dispatch.js";
import { runShellCommand } from "./shell.js";
import type { ApprovalChoice, ApprovalOption, PermissionAction, TuiState } from "./types.js";
import { TOOL_DISPLAY_LIMIT } from "./theme.js";

export type StateSetter = (update: (state: TuiState) => TuiState) => void;

export interface TuiHarnessDependencies {
  launchClient?: typeof CopilotClient.launch;
  createTools?: typeof createOrchestratorTools;
}

export class TuiHarness {
  client: CopilotClient | undefined;
  agent: CodingAgent | undefined;
  manager: SubagentManager | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (allow: boolean) => void; rule?: ApprovalRule }
  >();
  /**
   * `state.approval` is a single card, so concurrent requests have to queue.
   * The orchestrator runs concurrency-safe tools in parallel with sequential
   * ones, so without this a second request would overwrite the first card and
   * leave its promise unresolved.
   */
  private readonly approvalGate = new Mutex();
  private running: Promise<void> | undefined;
  private launchPromise: Promise<void> | undefined;
  private launchWaitsForLogin = false;
  private cancelled = false;
  private closing = false;
  /** Follows the agent's `cd` so `!` commands run where the agent is working. */
  private workspaceCwd: string;

  constructor(
    private readonly setState: StateSetter,
    private readonly getState: () => TuiState,
    private readonly cwd: string,
    private readonly allowedRoots: string[],
    private readonly readOnly: boolean,
    private readonly dependencies: TuiHarnessDependencies = {},
    readonly policy: ApprovalPolicy = new ApprovalPolicy(),
  ) {
    this.workspaceCwd = cwd;
  }

  launch(waitForLogin = false): Promise<void> {
    if (this.closing || this.client !== undefined) return Promise.resolve();
    if (this.launchPromise !== undefined) {
      if (waitForLogin && !this.launchWaitsForLogin) {
        return this.launchPromise.then(() =>
          this.closing || this.client !== undefined ? undefined : this.launch(true),
        );
      }
      return this.launchPromise;
    }
    this.launchWaitsForLogin = waitForLogin;
    const pending = this.performLaunch(waitForLogin).finally(() => {
      if (this.launchPromise === pending) {
        this.launchPromise = undefined;
        this.launchWaitsForLogin = false;
      }
    });
    this.launchPromise = pending;
    return pending;
  }

  private async performLaunch(waitForLogin: boolean): Promise<void> {
    this.setState((state) => ({
      ...state,
      launching: true,
      launchError: "",
      turn: "starting",
      turnStartedAt: Date.now(),
    }));
    let client: CopilotClient | undefined;
    try {
      const launchClient = this.dependencies.launchClient ?? CopilotClient.launch;
      const createTools = this.dependencies.createTools ?? createOrchestratorTools;
      const launchedClient = await launchClient(waitForLogin ? { waitForLogin: true } : {});
      client = launchedClient;
      if (this.closing) {
        await launchedClient.close();
        client = undefined;
        return;
      }
      const confirmTool: ConfirmTool = (call, definition) => this.requestApproval(call, definition);
      const manager = new SubagentManager({
        openSession: () => launchedClient.newTabSession(),
        cwd: this.cwd,
        allowedRoots: this.allowedRoots,
        readOnly: this.readOnly,
        confirmTool,
        onEvent: (record, event) => this.onAgentEvent(event, record.id),
        onLifecycle: (record, event) => this.onLifecycle(record, event),
      });
      const tools = await createTools(manager, this.cwd, this.allowedRoots, {
        onDirectoryChange: (next) => {
          this.workspaceCwd = next;
          this.setState((state) => ({ ...state, cwd: next }));
        },
      });
      const agent = new CodingAgent(launchedClient, {
        cwd: this.cwd,
        allowedRoots: this.allowedRoots,
        readOnly: this.readOnly,
        confirmTool,
        onEvent: (event) => this.onAgentEvent(event),
        tools,
      });
      const toolNames = await agent.toolNames();
      if (this.closing) {
        await launchedClient.close();
        client = undefined;
        return;
      }
      this.client = launchedClient;
      this.manager = manager;
      this.agent = agent;
      this.cancelled = false;
      this.setState((state) => ({
        ...state,
        ready: true,
        launching: false,
        launchError: "",
        turn: "idle",
        usage: launchedClient.getTokenUsage(),
        tools: toolNames,
      }));
      client = undefined;
    } catch (error) {
      if (client !== undefined && this.client === client) {
        this.client = undefined;
        this.manager = undefined;
        this.agent = undefined;
      }
      await client?.close().catch(() => undefined);
      if (this.closing) return;
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
    if (this.closing) return;
    this.closing = true;
    this.cancelled = true;
    try {
      this.declinePendingApprovals();
    } catch {
      // Browser cleanup still has to run if a UI observer fails during shutdown.
    }
    // Abort before the references go: a tool still running would otherwise hold
    // the event loop open long after the terminal has been restored.
    this.abortActiveRuns("the session is closing");
    const client = this.client;
    this.client = undefined;
    this.agent = undefined;
    this.manager = undefined;
    await closeAllJobs().catch(() => undefined);
    await client?.close();
  }

  async send(text: string, sessionKind: "agent" | "chat"): Promise<void> {
    if (this.closing) return;
    const previous = this.running ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.runTurn(text, sessionKind));
    this.running = current;
    try {
      await current;
    } finally {
      if (this.running === current) this.running = undefined;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.declinePendingApprovals();
    this.abortActiveRuns();
  }

  /** Stop the step loops and every running tool, for both cancel and shutdown. */
  private abortActiveRuns(reason = "cancelled by the user"): void {
    try {
      this.agent?.abort(reason);
      this.manager?.cancelAll(reason);
    } catch {
      // Best effort: the turn is already marked cancelled either way.
    }
  }

  resolveApproval(id: number, decision: ApprovalChoice): void {
    const entry = this.pending.get(id);
    this.pending.delete(id);
    if (entry === undefined) return;
    // A card with no rule to learn offers no "always" row; ignore a stray one.
    if (decision === "always" && entry.rule !== undefined) this.policy.learn(entry.rule);
    entry.resolve(decision !== "deny");
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

  /** Skills visible from the launch directory, formatted for the scrollback. */
  async listSkills(): Promise<string> {
    return formatSkillList(await discoverSkills(this.cwd));
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
    // Auto-decisions are answered outside the queue so they never wait on a card.
    const settled = this.settleWithoutAsking(call, definition);
    if (settled !== undefined) return settled;
    return await this.approvalGate.run(async () => {
      // A card shown while this one waited may have cancelled the turn or
      // learned a rule that now covers this call.
      const now = this.settleWithoutAsking(call, definition);
      if (now !== undefined) return now;
      return await this.showApprovalCard(call, definition);
    });
  }

  /** An allow/deny that needs no card, or undefined when the user must choose. */
  private settleWithoutAsking(call: ToolCall, definition: ToolDefinition): boolean | undefined {
    if (this.closing || this.cancelled) return false;
    if (this.getState().permission === "always") return true;
    if (this.policy.decide(call, definition) === "allow") return true;
    return undefined;
  }

  private async showApprovalCard(call: ToolCall, definition: ToolDefinition): Promise<boolean> {
    const rule = ruleFor(call, definition);
    // Decline stays on `2`, where it has always been: the persistent grant is
    // the one answer that must not be reachable by muscle memory.
    const options: ApprovalOption[] = [
      { label: "Allow once", decision: "allow" },
      { label: "Decline", decision: "deny" },
      ...(rule === undefined
        ? []
        : [{ label: `Always allow ${ruleLabel(rule)}`, decision: "always" as const }]),
    ];
    return await new Promise<boolean>((resolve) => {
      this.setState((state) => {
        const id = state.nextApprovalId;
        this.pending.set(id, { resolve, ...(rule === undefined ? {} : { rule }) });
        return {
          ...state,
          nextApprovalId: id + 1,
          approval: { id, call, definition, options, selected: 0, expanded: false },
          turn: "waiting",
        };
      });
    });
  }

  /** Report the session rules, clear them, or toggle the safe-command classifier. */
  applyPermissions(action: PermissionAction): void {
    if (action === "clear") this.policy.clear();
    if (action === "safe-on") this.policy.setAutoApproveSafeCommands(true);
    if (action === "safe-off") this.policy.setAutoApproveSafeCommands(false);
    const heading =
      action === "clear"
        ? "Cleared the session permission rules.\n"
        : action === "show"
          ? ""
          : `Safe-command auto-approval ${action === "safe-on" ? "enabled" : "disabled"}.\n`;
    const message = `${heading}${formatRules(this.policy.rules())}`;
    this.setState((state) =>
      makeEntry(state, { kind: "system", message, collapsed: false, raw: false }).state,
    );
  }

  /** Run a `!command` line locally and show it in the scrollback as a tool entry. */
  async runShell(command: string): Promise<void> {
    if (this.closing) return;
    let id = 0;
    this.setState((state) => {
      const made = makeEntry(state, {
        kind: "tool",
        call: { name: "shell", arguments: { command } },
        status: "running",
        output: "",
        collapsed: false,
        raw: false,
      });
      id = made.id;
      return made.state;
    });
    let output: string;
    let ok: boolean;
    try {
      const result = await runShellCommand(command, { cwd: this.workspaceCwd });
      ok = result.ok;
      output = result.output;
    } catch (error) {
      ok = false;
      output = displayedError(error);
    }
    this.setState((state) =>
      patchEntry(state, id, {
        status: ok ? "ok" : "error",
        output: displayedOutput(output),
        collapsed: output.length > 800,
      }),
    );
  }

  private declinePendingApprovals(): void {
    if (this.pending.size === 0 && this.getState().approval === undefined) return;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.resolve(false);
    this.setState((state) => ({ ...state, approval: undefined }));
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
    let usage: TokenUsageEstimate | undefined;
    try {
      usage = this.client?.getTokenUsage();
    } catch {
      return;
    }
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
