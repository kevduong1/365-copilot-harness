import type {
  ConversationCompactionOptions,
  ConversationCompactionResult,
} from "../compaction.js";
import type { TokenUsageEstimate } from "../tokens.js";

export interface AgentBackend {
  newChat(): Promise<void>;
  sendAndWait(prompt: string): Promise<string>;
  compact?(options?: ConversationCompactionOptions): Promise<ConversationCompactionResult>;
  getTokenUsage?(): TokenUsageEstimate;
  needsCompaction?(nextPrompt?: string): boolean;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  call: ToolCall;
  ok: boolean;
  output: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Argument signature rendered into the system prompt: a comma-separated list
   * where `name` is required, `name?` is optional, and `name?=value` shows a
   * default. Documentation only; `execute` performs the real validation.
   */
  parameters: string;
  mutates: boolean;
  execute(arguments_: Record<string, unknown>): Promise<string>;
}

export type AgentEvent =
  | { type: "assistant"; text: string; step: number }
  | { type: "tool_start"; call: ToolCall; step: number }
  | { type: "tool_end"; result: ToolResult; step: number }
  | {
      type: "compaction";
      phase: "start" | "complete";
      automatic: boolean;
      before?: TokenUsageEstimate;
      after?: TokenUsageEstimate;
      step: number;
    }
  | { type: "warning"; message: string; step: number };

export type ConfirmTool = (call: ToolCall, definition: ToolDefinition) => Promise<boolean>;
