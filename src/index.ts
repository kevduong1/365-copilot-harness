export type { ChatAdapter } from "./adapter.js";
export {
  CopilotClient,
  CopilotTabSession,
  type CompactionResult,
  type LaunchOptions,
} from "./client.js";
export { ChatSession, type SessionOptions } from "./session.js";
export {
  DEFAULT_COMPACTION_READY_MARKER,
  buildCompactionBootstrapPrompt,
  buildCompactionSummaryPrompt,
  type ConversationCompactionOptions,
  type ConversationCompactionResult,
} from "./compaction.js";
export { config, type HarnessConfig } from "./config.js";
export {
  NotLoggedInError,
  PromptTooLargeError,
  ResponseTimeoutError,
} from "./errors.js";
export { extractMarkdown } from "./extract.js";
export {
  ConversationTokenCounter,
  estimateMessageTokens,
  estimateTokens,
  type ConversationRole,
  type TokenCounterOptions,
  type TokenUsageEstimate,
} from "./tokens.js";
export { CodingAgent, type AgentRunnerOptions } from "./agent/runner.js";
export {
  SUBAGENT_ROLE_CONTEXT,
  SubagentManager,
  createOrchestratorTools,
  createSubagentTool,
  type SubagentLifecycleEvent,
  type SubagentManagerOptions,
  type SubagentRecord,
  type SubagentRun,
  type SubagentSession,
  type SubagentStatus,
} from "./agent/subagent.js";
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
export { resolveShell, type ShellFamily, type ShellSpec } from "./platform.js";
