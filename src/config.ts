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

export const config = {
  copilotUrl: process.env.COPILOT_URL ?? "https://m365.cloud.microsoft/chat",
  loginUrlPattern: /login\.microsoftonline\.com|login\.live\.com/,
  profileDir: resolve(process.env.PROFILE_DIR ?? ".data/profile"),
  sessionStatePath: resolve(process.env.SESSION_STATE_PATH ?? ".data/storage-state.json"),
  headless: process.env.HEADLESS === "1",
  responseTimeoutMs: positiveNumber("RESPONSE_TIMEOUT_MS", 300_000),
  stabilityDebounceMs: positiveNumber("STABILITY_DEBOUNCE_MS", 1_500),
  pollIntervalMs: positiveNumber("POLL_INTERVAL_MS", 250),
  serverPort: positiveNumber("PORT", 8787),
} as const;

export type HarnessConfig = typeof config;
