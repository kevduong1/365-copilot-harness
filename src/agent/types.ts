export interface AgentBackend {
  newChat(): Promise<void>;
  sendAndWait(prompt: string): Promise<string>;
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
  parameters: string;
  mutates: boolean;
  execute(arguments_: Record<string, unknown>): Promise<string>;
}

export type AgentEvent =
  | { type: "assistant"; text: string; step: number }
  | { type: "tool_start"; call: ToolCall; step: number }
  | { type: "tool_end"; result: ToolResult; step: number }
  | { type: "warning"; message: string; step: number };

export type ConfirmTool = (call: ToolCall, definition: ToolDefinition) => Promise<boolean>;
