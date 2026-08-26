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

export interface AgentRunnerOptions {
  cwd?: string;
  maxSteps?: number;
  readOnly?: boolean;
  confirmTool?: ConfirmTool;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  tools?: ToolDefinition[];
}

export class CodingAgent {
  private readonly cwd: string;
  private readonly maxSteps: number;
  private readonly readOnly: boolean;
  private readonly confirmTool: ConfirmTool | undefined;
  private readonly onEvent: ((event: AgentEvent) => Promise<void> | void) | undefined;
  private tools: ToolDefinition[] | undefined;
  private initialized = false;
  private newChatPrepared = false;

  constructor(
    private readonly backend: AgentBackend,
    options: AgentRunnerOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.maxSteps = options.maxSteps ?? 16;
    this.readOnly = options.readOnly ?? false;
    this.confirmTool = options.confirmTool;
    this.onEvent = options.onEvent;
    this.tools = options.tools;
  }

  async reset(): Promise<void> {
    await this.backend.newChat();
    this.initialized = false;
    this.newChatPrepared = true;
  }

  async run(task: string): Promise<string> {
    if (task.trim().length === 0) throw new Error("Agent task must not be empty");
    const tools = await this.availableTools();
    let prompt: string;

    if (!this.initialized) {
      if (!this.newChatPrepared) await this.backend.newChat();
      this.newChatPrepared = false;
      const systemPrompt = await buildAgentSystemPrompt({ cwd: this.cwd, tools });
      const acknowledgement = await this.backend.sendAndWait(
        `<coding_harness_system>\n${systemPrompt}\n</coding_harness_system>\n\nThe local coding harness is now active. Reply with exactly HARNESS_READY and nothing else.`,
      );
      if (!acknowledgement.replaceAll("\\_", "_").includes("HARNESS_READY")) {
        await this.emit({
          type: "warning",
          message: "Copilot did not return the expected harness initialization acknowledgement",
          step: 0,
        });
      }
      prompt = `<user_task>\n${task}\n</user_task>`;
      this.initialized = true;
    } else {
      prompt = `<user_task>\n${task}\n</user_task>`;
    }

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const response = await this.backend.sendAndWait(prompt);
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
      const results: ToolResult[] = [];
      for (const call of calls) results.push(await this.executeTool(call, tools, step));

      prompt = formatToolResults(results, parsed.errors);
    }

    throw new Error(`Agent exceeded the ${this.maxSteps}-step tool limit`);
  }

  async toolNames(): Promise<string[]> {
    return (await this.availableTools()).map((tool) => tool.name);
  }

  private async availableTools(): Promise<ToolDefinition[]> {
    this.tools ??= await createWorkspaceTools(this.cwd);
    return this.readOnly ? this.tools.filter((tool) => !tool.mutates) : this.tools;
  }

  private async executeTool(
    call: ToolCall,
    tools: ToolDefinition[],
    step: number,
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
        result = { call, ok: true, output: await definition.execute(call.arguments) };
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

  private looksLikeToolRefusal(response: string): boolean {
    return /(?:do not|don't|cannot|can't|unable to|no) (?:have )?(?:access|tools?)|not available|does not exist here|execution environment/i.test(
      response,
    );
  }
}
