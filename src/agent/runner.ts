import {
  buildCompactionBootstrapPrompt,
  buildCompactionSummaryPrompt,
  type ConversationCompactionOptions,
  type ConversationCompactionResult,
} from "../compaction.js";
import { config } from "../config.js";
import { discoverSkills } from "./skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { formatToolResults, parseToolCalls } from "./protocol.js";
import { createWorkspaceTools } from "./tools.js";
import type {
  AgentBackend,
  AgentEvent,
  ConfirmTool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.js";

/** Thrown out of `run()` when `abort()` stopped the step loop. */
export class AgentCancelledError extends Error {
  constructor(message = "The agent run was cancelled") {
    super(message);
    this.name = "AgentCancelledError";
  }
}

export interface AgentRunnerOptions {
  cwd?: string;
  allowedRoots?: string[];
  maxSteps?: number;
  readOnly?: boolean;
  confirmTool?: ConfirmTool;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  tools?: ToolDefinition[];
  autoCompact?: boolean;
  /** Additional system-prompt context, e.g. a subagent role preamble. */
  systemPromptExtra?: string;
}

export class CodingAgent {
  private readonly cwd: string;
  private readonly maxSteps: number;
  private readonly allowedRoots: string[];
  private readonly readOnly: boolean;
  private readonly confirmTool: ConfirmTool | undefined;
  private readonly onEvent: ((event: AgentEvent) => Promise<void> | void) | undefined;
  private readonly autoCompact: boolean;
  private readonly systemPromptExtra: string | undefined;
  private tools: ToolDefinition[] | undefined;
  private activeSystemPrompt: string | undefined;
  private initialized = false;
  private newChatPrepared = false;
  /** Created per `run()`; `abort()` fires it to stop the current run only. */
  private controller: AbortController | undefined;
  /** Set when a compaction left usage above the threshold, to avoid thrashing. */
  private skipNextCompaction = false;

  constructor(
    private readonly backend: AgentBackend,
    options: AgentRunnerOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.allowedRoots = options.allowedRoots ?? [];
    this.maxSteps = options.maxSteps ?? 16;
    this.readOnly = options.readOnly ?? false;
    this.confirmTool = options.confirmTool;
    this.onEvent = options.onEvent;
    this.autoCompact = options.autoCompact ?? true;
    this.systemPromptExtra = options.systemPromptExtra;
    this.tools = options.tools;
  }

  async reset(): Promise<void> {
    await this.backend.newChat();
    this.initialized = false;
    this.newChatPrepared = true;
    this.activeSystemPrompt = undefined;
    this.skipNextCompaction = false;
  }

  /** Mark the current browser conversation as unrelated without opening another chat. */
  invalidate(): void {
    this.initialized = false;
    this.newChatPrepared = false;
    this.activeSystemPrompt = undefined;
    this.skipNextCompaction = false;
  }

  /**
   * Summarize the conversation into a fresh chat. A `resumePrompt` rides along
   * with the bootstrap so the pending message costs no extra browser round trip;
   * the reply comes back as `response`.
   */
  async compact(
    automatic = false,
    step = 0,
    resumePrompt?: string,
  ): Promise<ConversationCompactionResult> {
    if (!this.initialized) throw new Error("There is no active coding conversation to compact");
    const tools = await this.availableTools();
    const systemPrompt = this.activeSystemPrompt ?? (await this.buildSystemPrompt(tools));
    const before = this.backend.getTokenUsage?.();
    await this.emit({
      type: "compaction",
      phase: "start",
      automatic,
      ...(before === undefined ? {} : { before }),
      step,
    });

    const options: ConversationCompactionOptions = {
      bootstrapContext: `<coding_harness_system>\n${systemPrompt}\n</coding_harness_system>`,
      readyMarker: "HARNESS_READY",
      maxSummaryTokens: config.compactionSummaryTokens,
      ...(resumePrompt === undefined ? {} : { resumePrompt }),
    };
    let result: ConversationCompactionResult;
    try {
      if (this.backend.compact !== undefined) {
        result = await this.backend.compact(options);
      } else {
        const summary = (
          await this.backend.sendAndWait(
            buildCompactionSummaryPrompt(options.maxSummaryTokens ?? config.compactionSummaryTokens),
          )
        ).trim();
        if (!summary) throw new Error("Copilot returned an empty conversation summary");
        await this.backend.newChat();
        const reply = await this.backend.sendAndWait(
          buildCompactionBootstrapPrompt(summary, options),
        );
        result = {
          summary,
          acknowledgement: reply,
          ...(resumePrompt === undefined ? {} : { response: reply }),
        };
      }
    } catch (error) {
      // The failure may have happened after New chat. Force a full initialization
      // on the next task instead of assuming the old coding protocol is active.
      this.initialized = false;
      this.newChatPrepared = false;
      this.activeSystemPrompt = undefined;
      throw error;
    }

    if (
      resumePrompt === undefined &&
      !result.acknowledgement.replaceAll("\\_", "_").includes("HARNESS_READY")
    ) {
      await this.emit({
        type: "warning",
        message: "Copilot did not acknowledge the compacted coding conversation",
        step,
      });
    }
    this.initialized = true;
    this.newChatPrepared = false;
    this.activeSystemPrompt = systemPrompt;
    const after = this.backend.getTokenUsage?.();
    // A summary that lands above the threshold would compact again on the very
    // next step, spending a browser round trip per step for no relief.
    if (after !== undefined && after.conversationTokens >= after.compactionThresholdTokens) {
      this.skipNextCompaction = true;
      await this.emit({
        type: "warning",
        message: `Compaction left usage at ~${after.conversationTokens.toLocaleString("en-US")} tokens, still at or above the ${after.compactionThresholdPercent}% threshold; skipping compaction on the next step to avoid thrashing`,
        step,
      });
    } else {
      this.skipNextCompaction = false;
    }
    await this.emit({
      type: "compaction",
      phase: "complete",
      automatic,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      step,
    });
    return result;
  }

  /**
   * Stop the run that is currently in flight. Tools receive the signal, the step
   * loop exits before the next browser round trip, and the next `run()` starts
   * from a fresh controller.
   */
  abort(reason = "cancelled by the user"): void {
    this.controller?.abort(new AgentCancelledError(`The agent run was cancelled: ${reason}`));
  }

  async run(task: string): Promise<string> {
    if (task.trim().length === 0) throw new Error("Agent task must not be empty");
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const tools = await this.availableTools();
    let prompt: string;
    let promptCarriesSystemPrompt = false;
    throwIfAborted(signal);

    if (!this.initialized) {
      if (!this.newChatPrepared) await this.backend.newChat();
      this.newChatPrepared = false;
      const systemPrompt = await this.buildSystemPrompt(tools);
      this.activeSystemPrompt = systemPrompt;
      // The system prompt rides along with the first task instead of costing a
      // separate acknowledgement round trip; step 1's refusal correction catches
      // a model that misread the protocol.
      prompt = `<coding_harness_system>\n${systemPrompt}\n</coding_harness_system>\n\n<user_task>\n${task}\n</user_task>`;
      promptCarriesSystemPrompt = true;
      this.initialized = true;
    } else {
      prompt = `<user_task>\n${task}\n</user_task>`;
    }

    for (let step = 1; step <= this.maxSteps; step += 1) {
      // Nothing further goes to the browser once the run has been cancelled.
      throwIfAborted(signal);
      // A prompt that already carries the system prompt opens a fresh chat, so
      // compacting it would only re-send the same bootstrap context. Otherwise a
      // compaction here carries the prompt with it and already holds the reply.
      const resumed = promptCarriesSystemPrompt
        ? undefined
        : await this.compactIfNeeded(prompt, step);
      promptCarriesSystemPrompt = false;
      const response = resumed ?? (await this.backend.sendAndWait(prompt));
      throwIfAborted(signal);
      const parsed = parseToolCalls(response);

      if (parsed.calls.length === 0 && parsed.errors.length === 0) {
        if (step === 1 && this.looksLikeToolRefusal(response)) {
          await this.emit({
            type: "warning",
            message: "Copilot treated local tools as unavailable; sending a protocol correction",
            step,
          });
          prompt = `HARNESS_PROTOCOL_CORRECTION: Correct—you do not have direct filesystem access and these are not Microsoft Copilot tools. Your role is only to print a machine-readable request for the separate local controller. This is text generation, not tool invocation. Do not ask for uploads. Print HARNESS_REQUEST, a strict JSON object with operation and arguments, then END_HARNESS_REQUEST. The controller will perform it and return HARNESS_OBSERVATION.`;
          continue;
        }
        const finalText = parsed.finalText || response.trim();
        await this.emit({ type: "assistant", text: finalText, step });
        return finalText;
      }

      if (parsed.finalText) {
        await this.emit({
          type: "warning",
          message: "Ignored prose accompanying a harness request; waiting for the operation loop to finish",
          step,
        });
      }

      const calls = parsed.calls.slice(0, 8);
      if (parsed.calls.length > calls.length) {
        parsed.errors.push(`Only the first ${calls.length} tool calls in one response are executed`);
      }
      const results = await this.executeToolBatch(calls, tools, step, signal);
      throwIfAborted(signal);

      prompt = formatToolResults(results, parsed.errors);
    }

    throw new Error(`Agent exceeded the ${this.maxSteps}-step tool limit`);
  }

  async toolNames(): Promise<string[]> {
    return (await this.availableTools()).map((tool) => tool.name);
  }

  private async availableTools(): Promise<ToolDefinition[]> {
    this.tools ??= await createWorkspaceTools(this.cwd, { allowedRoots: this.allowedRoots });
    return this.readOnly ? this.tools.filter((tool) => !tool.mutates) : this.tools;
  }

  private async buildSystemPrompt(tools: ToolDefinition[]): Promise<string> {
    const skills = tools.some((tool) => tool.name === "skill") ? await discoverSkills(this.cwd) : [];
    return buildAgentSystemPrompt({
      cwd: this.cwd,
      allowedRoots: this.allowedRoots,
      tools,
      skills,
      ...(this.systemPromptExtra === undefined ? {} : { extra: this.systemPromptExtra }),
    });
  }

  /**
   * Execute one response's calls, preserving result order. Concurrency-safe
   * tools (long-running subagents) run in parallel; everything else runs
   * sequentially in the order it was printed.
   */
  private async executeToolBatch(
    calls: ToolCall[],
    tools: ToolDefinition[],
    step: number,
    signal: AbortSignal,
  ): Promise<ToolResult[]> {
    const results = new Array<ToolResult>(calls.length);
    const background = calls.map((call, index) => {
      const definition = tools.find((tool) => tool.name === call.name);
      if (definition?.concurrencySafe !== true) return undefined;
      return this.executeTool(call, tools, step, signal).then((result) => {
        results[index] = result;
      });
    });
    for (const [index, call] of calls.entries()) {
      if (background[index] === undefined) {
        results[index] = await this.executeTool(call, tools, step, signal);
      }
    }
    await Promise.all(background.filter((pending) => pending !== undefined));
    return results;
  }

  private async executeTool(
    call: ToolCall,
    tools: ToolDefinition[],
    step: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    await this.emit({ type: "tool_start", call, step });
    const definition = tools.find((tool) => tool.name === call.name);
    let result: ToolResult;

    if (definition === undefined) {
      result = { call, ok: false, output: `Unknown or disabled tool: ${call.name}` };
    } else if (
      definition.mutates &&
      this.confirmTool !== undefined &&
      !(await this.confirmTool(call, definition))
    ) {
      result = { call, ok: false, output: `User declined ${call.name}` };
    } else {
      try {
        result = { call, ok: true, output: await definition.execute(call.arguments, { signal }) };
      } catch (error) {
        result = {
          call,
          ok: false,
          output: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
    }

    await this.emit({ type: "tool_end", result, step });
    return result;
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.onEvent?.(event);
  }

  /** Returns the reply to `nextPrompt` when compaction carried it into the new chat. */
  private async compactIfNeeded(nextPrompt: string, step: number): Promise<string | undefined> {
    if (
      !this.autoCompact ||
      !this.initialized ||
      this.backend.needsCompaction?.(nextPrompt) !== true
    ) {
      return undefined;
    }
    if (this.skipNextCompaction) {
      this.skipNextCompaction = false;
      return undefined;
    }
    return (await this.compact(true, step, nextPrompt)).response;
  }

  /** True while a `run()` is in flight and has not been aborted. */
  get aborted(): boolean {
    return this.controller?.signal.aborted ?? false;
  }

  private looksLikeToolRefusal(response: string): boolean {
    return /(?:do not|don't|cannot|can't|unable to|no) (?:have )?(?:access|tools?)|not available|does not exist here|execution environment/i.test(
      response,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const { reason } = signal;
  throw reason instanceof Error ? reason : new AgentCancelledError();
}
