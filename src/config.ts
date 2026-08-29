import { resolve } from "node:path";

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number; received ${JSON.stringify(raw)}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = positiveNumber(name, fallback);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer; received ${JSON.stringify(process.env[name])}`);
  }
  return value;
}

function percentage(name: string, fallback: number): number {
  const value = positiveNumber(name, fallback);
  if (value > 100) throw new Error(`${name} must be at most 100; received ${value}`);
  return value;
}

function booleanFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be 1, 0, true, or false; received ${JSON.stringify(raw)}`);
}

function port(name: string, fallback: number): number {
  const value = positiveInteger(name, fallback);
  if (value > 65_535) throw new Error(`${name} must be at most 65535; received ${value}`);
  return value;
}

export const config = {
  copilotUrl: process.env.COPILOT_URL ?? "https://m365.cloud.microsoft/chat",
  loginUrlPattern: /login\.microsoftonline\.com|login\.live\.com/,
  profileDir: resolve(process.env.PROFILE_DIR ?? ".data/profile"),
  sessionStatePath: resolve(process.env.SESSION_STATE_PATH ?? ".data/storage-state.json"),
  headless: process.env.HEADLESS === "1",
  newChatSettleMs: positiveNumber("NEW_CHAT_SETTLE_MS", 3_000),
  promptSettleMs: positiveNumber("PROMPT_SETTLE_MS", 750),
  responseTimeoutMs: positiveNumber("RESPONSE_TIMEOUT_MS", 300_000),
  stabilityDebounceMs: positiveNumber("STABILITY_DEBOUNCE_MS", 1_500),
  completionFallbackMs: positiveNumber("COMPLETION_FALLBACK_MS", 10_000),
  pollIntervalMs: positiveNumber("POLL_INTERVAL_MS", 250),
  contextWindowTokens: positiveInteger("CONTEXT_WINDOW_TOKENS", 32_000),
  autoCompact: booleanFlag("AUTO_COMPACT", true),
  autoCompactPercent: percentage("AUTO_COMPACT_PERCENT", 60),
  compactionSummaryTokens: positiveInteger("COMPACTION_SUMMARY_TOKENS", 4_000),
  serverPort: port("PORT", 8787),
} as const;

export type HarnessConfig = typeof config;
