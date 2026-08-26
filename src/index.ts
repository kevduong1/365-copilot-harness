export type { ChatAdapter } from "./adapter.js";
export { CopilotClient, type LaunchOptions } from "./client.js";
export { config, type HarnessConfig } from "./config.js";
export {
  NotLoggedInError,
  PromptTooLargeError,
  ResponseTimeoutError,
} from "./errors.js";
export { extractMarkdown } from "./extract.js";
export { CodingAgent, type AgentRunnerOptions } from "./agent/runner.js";
export { buildAgentSystemPrompt, type SystemPromptOptions } from "./agent/system-prompt.js";
export { createWorkspaceTools, type WorkspaceToolOptions } from "./agent/tools.js";
export type {
  AgentBackend,
  AgentEvent,
  ConfirmTool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./agent/types.js";
