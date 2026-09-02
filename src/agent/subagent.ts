import { config } from "../config.js";
import { Mutex, Semaphore } from "../queue.js";
import type { TokenUsageEstimate } from "../tokens.js";
import { CodingAgent } from "./runner.js";
import { createWorkspaceTools } from "./tools.js";
import type { AgentBackend, AgentEvent, ConfirmTool, ToolDefinition } from "./types.js";

/** A backend that can also be closed, typically `CopilotClient.newTabSession`. */
export interface SubagentSession extends AgentBackend {
  close(): Promise<void>;
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed";

export type SubagentLifecycleEvent = "queued" | "started" | "completed" | "failed" | "closed";

export interface SubagentRecord {
  id: number;
  name: string;
  status: SubagentStatus;
  /** Every task the subagent has been given: the spawn brief plus follow-ups. */
  tasks: string[];
  /** Highest step reached during the most recent run. */
  steps: number;
  startedAt: number;
  endedAt?: number;
  lastResult?: string;
  lastError?: string;
  tokenUsage?: TokenUsageEstimate;
  /** While true the conversation is still open and accepts follow-up tasks. */
  sessionOpen: boolean;
}

export interface SubagentManagerOptions {
  /** Opens a fresh browser conversation for one subagent. */
  openSession: () => Promise<SubagentSession>;
  cwd?: string;
  allowedRoots?: string[];
  readOnly?: boolean;
  /** Parent approval callback; invocations are serialized across concurrent subagents. */
  confirmTool?: ConfirmTool;
  /** Subagent conversations allowed to run at the same time. */
  maxConcurrent?: number;
  /** Finished conversations kept open for follow-ups before the stalest is closed. */
  maxIdleSessions?: number;
  maxSteps?: number;
  onEvent?: (agent: SubagentRecord, event: AgentEvent) => Promise<void> | void;
  onLifecycle?: (agent: SubagentRecord, event: SubagentLifecycleEvent) => void;
  /** Replaces the per-subagent workspace tools; used by tests. */
  createTools?: () => Promise<ToolDefinition[]> | ToolDefinition[];
}

export interface SubagentRun {
  record: SubagentRecord;
  response: string;
}

export const SUBAGENT_ROLE_CONTEXT = `<subagent_role>
You are a subagent working for an orchestrating agent, not for the end user directly. Complete only the delegated task. Your final answer is the report the orchestrator reads, so make it self-contained: lead with the direct answer or outcome, name exact files, paths, and line numbers, and include the key evidence. Do not ask questions back; when something is ambiguous, state the assumption you chose. There is no agent operation for you—never try to delegate further.
</subagent_role>`;

interface SubagentEntry {
  record: SubagentRecord;
  agent: CodingAgent | undefined;
  session: SubagentSession | undefined;
  busy: boolean;
  lastActivityAt: number;
}

/**
 * Spawns and tracks subagents. Each subagent is a fresh browser conversation
 * (its own tab) driving its own `CodingAgent` over its own workspace tools, so
 * its exploration never consumes the orchestrating conversation's context.
 * The registry of every spawned subagent survives tab closure for inspection.
 */
export class SubagentManager {
  private readonly entries = new Map<number, SubagentEntry>();
  private nextId = 1;
  private readonly semaphore: Semaphore;
  private readonly approvalMutex = new Mutex();
  private readonly confirmTool: ConfirmTool | undefined;
  private readonly maxIdleSessions: number;
  private readonly maxSteps: number;

  constructor(private readonly options: SubagentManagerOptions) {
    this.semaphore = new Semaphore(options.maxConcurrent ?? config.subagentMaxConcurrent);
    this.maxIdleSessions = options.maxIdleSessions ?? config.subagentMaxIdleTabs;
    this.maxSteps = options.maxSteps ?? config.subagentMaxSteps;
    const confirm = options.confirmTool;
    this.confirmTool =
      confirm === undefined
        ? undefined
        : (call, definition) => this.approvalMutex.run(() => confirm(call, definition));
  }

  list(): SubagentRecord[] {
    return [...this.entries.values()].map((entry) => entry.record);
  }

  get(id: number): SubagentRecord | undefined {
    return this.entries.get(id)?.record;
  }

  async spawn(task: string, name?: string): Promise<SubagentRun> {
    const id = this.nextId;
    this.nextId += 1;
    const record: SubagentRecord = {
      id,
      name: name?.trim() || `agent-${id}`,
      status: "queued",
      tasks: [task],
      steps: 0,
      startedAt: Date.now(),
      sessionOpen: false,
    };
    const entry: SubagentEntry = {
      record,
      agent: undefined,
      session: undefined,
      busy: true,
      lastActivityAt: Date.now(),
    };
    this.entries.set(id, entry);
    this.emitLifecycle(record, "queued");
    return this.execute(entry, task, true);
  }

  async followUp(id: number, task: string): Promise<SubagentRun> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(`Unknown subagent id ${id}; spawn a new agent without agent_id instead`);
    }
    const label = `Subagent #${id} (${entry.record.name})`;
    if (entry.busy) throw new Error(`${label} is still running a task`);
    if (!entry.record.sessionOpen || entry.agent === undefined) {
      throw new Error(
        `${label}'s conversation is closed; spawn a new agent with a complete standalone brief instead`,
      );
    }
    entry.busy = true;
    entry.record.tasks.push(task);
    return this.execute(entry, task, false);
  }

  async close(id: number): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.busy || !entry.record.sessionOpen) return;
    await this.closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.record.sessionOpen && !entry.busy) await this.closeEntry(entry);
    }
  }

  private async execute(entry: SubagentEntry, task: string, fresh: boolean): Promise<SubagentRun> {
    const { record } = entry;
    const release = await this.semaphore.acquire();
    try {
      record.status = "running";
      record.steps = 0;
      delete record.endedAt;
      this.emitLifecycle(record, "started");
      if (fresh) {
        entry.session = await this.options.openSession();
        record.sessionOpen = true;
        entry.agent = await this.createAgent(entry);
      }
      const agent = entry.agent;
      if (agent === undefined) throw new Error(`Subagent #${record.id} has no active conversation`);
      const response = await agent.run(task);
      record.status = "completed";
      record.lastResult = response;
      record.endedAt = Date.now();
      this.captureUsage(entry);
      this.emitLifecycle(record, "completed");
      return { record, response };
    } catch (error) {
      record.status = "failed";
      record.lastError = error instanceof Error ? error.message : String(error);
      record.endedAt = Date.now();
      this.captureUsage(entry);
      this.emitLifecycle(record, "failed");
      if (fresh && entry.agent === undefined) await this.closeEntry(entry);
      throw new Error(`Subagent #${record.id} (${record.name}) failed: ${record.lastError}`, {
        cause: error,
      });
    } finally {
      entry.busy = false;
      entry.lastActivityAt = Date.now();
      release();
      await this.enforceIdleLimit().catch(() => undefined);
    }
  }

  private async createAgent(entry: SubagentEntry): Promise<CodingAgent> {
    const { record } = entry;
    const session = entry.session;
    if (session === undefined) throw new Error(`Subagent #${record.id} has no open session`);
    // Without an override the CodingAgent builds its own workspace tools, so
    // every subagent gets an independent working directory for cd.
    const tools = await this.options.createTools?.();
    return new CodingAgent(session, {
      cwd: this.options.cwd ?? process.cwd(),
      allowedRoots: this.options.allowedRoots ?? [],
      readOnly: this.options.readOnly ?? false,
      maxSteps: this.maxSteps,
      systemPromptExtra: SUBAGENT_ROLE_CONTEXT,
      ...(this.confirmTool === undefined ? {} : { confirmTool: this.confirmTool }),
      ...(tools === undefined ? {} : { tools }),
      onEvent: async (event) => {
        record.steps = Math.max(record.steps, event.step);
        await this.options.onEvent?.(record, event);
      },
    });
  }

  private captureUsage(entry: SubagentEntry): void {
    try {
      const usage = entry.session?.getTokenUsage?.();
      if (usage !== undefined) entry.record.tokenUsage = usage;
    } catch {
      // Usage is diagnostic; it must not change task lifecycle semantics.
    }
  }

  private async enforceIdleLimit(): Promise<void> {
    for (;;) {
      const idle = [...this.entries.values()]
        .filter((entry) => entry.record.sessionOpen && !entry.busy)
        .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
      if (idle.length <= this.maxIdleSessions) return;
      await this.closeEntry(idle[0]!);
    }
  }

  private async closeEntry(entry: SubagentEntry): Promise<void> {
    if (entry.session === undefined && !entry.record.sessionOpen) return;
    const session = entry.session;
    entry.session = undefined;
    entry.agent = undefined;
    entry.record.sessionOpen = false;
    if (session !== undefined) await session.close().catch(() => undefined);
    this.emitLifecycle(entry.record, "closed");
  }

  private emitLifecycle(record: SubagentRecord, event: SubagentLifecycleEvent): void {
    try {
      const pending = this.options.onLifecycle?.(record, event);
      if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Observers must never consume permits, leak tabs, or change task results.
    }
  }
}

function optionalString(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    return value;
  }
  return undefined;
}

function optionalId(args: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    const id = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new Error(`${name} must be a positive integer subagent id`);
    }
    return id;
  }
  return undefined;
}

/**
 * The orchestration operation offered to the main coding agent. Marked
 * concurrency-safe so several agent calls printed in one response fan out in
 * parallel, bounded by the manager's concurrency limit.
 */
export function createSubagentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: "agent",
    description:
      "Delegate a self-contained task to a subagent in a fresh Copilot conversation (its own browser tab) with the same workspace operations. The subagent starts with none of this conversation's context, so the task must carry every needed path, constraint, and goal; only its final report comes back. Pass agent_id to send a follow-up task to an earlier subagent whose conversation is still open.",
    parameters: "task, name?, agent_id?",
    mutates: false,
    concurrencySafe: true,
    execute: async (args) => {
      const task = optionalString(args, ["task", "prompt"]);
      if (task === undefined || task.trim().length === 0) {
        throw new Error("task must be a non-empty string");
      }
      const name = optionalString(args, ["name", "label"]);
      const id = optionalId(args, ["agent_id", "agentId", "id"]);
      const { record, response } =
        id === undefined ? await manager.spawn(task, name) : await manager.followUp(id, task);
      const tokens =
        record.tokenUsage === undefined
          ? ""
          : `, ~${record.tokenUsage.conversationTokens.toLocaleString("en-US")} tokens`;
      const continuation = record.sessionOpen
        ? `still open for follow-ups via agent_id ${record.id}`
        : "now closed";
      return `Subagent #${record.id} (${record.name}) completed in ${record.steps} step${record.steps === 1 ? "" : "s"}${tokens}; its conversation is ${continuation}.\n\nReport:\n${response}`;
    },
  };
}

/** Workspace tools plus the subagent orchestration operation. */
export async function createOrchestratorTools(
  manager: SubagentManager,
  cwd: string,
  allowedRoots: string[] = [],
): Promise<ToolDefinition[]> {
  return [...(await createWorkspaceTools(cwd, { allowedRoots })), createSubagentTool(manager)];
}
