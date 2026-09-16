import type { ToolCall, ToolResult } from "./types.js";

const xmlToolCallPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const sentinelToolCallPattern =
  /(?:^|\n)TOOL_CALL\s+([\s\S]*?)\s+END_TOOL_CALL(?=\s|$)/gi;
const harnessRequestPattern =
  /(?:^|\n)HARNESS_REQUEST\s+([\s\S]*?)\s+END_HARNESS_REQUEST(?=\s|$)/gi;

/** Keys a request may use for the operation name, in precedence order. */
const operationKeys = ["operation", "name", "tool", "op"] as const;
/** Keys a request may use for the arguments object, in precedence order. */
const argumentKeys = ["arguments", "args", "params", "parameters", "input"] as const;
/** A bare `command` only names an operation when it looks like a single identifier. */
const operationNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Argument fields a request may flatten next to the operation name. */
const liftableArgumentKeys = ["command", "path", "pattern"] as const;
const requestShapeError =
  "Harness requests require a string operation and an object arguments field";

/** A fenced payload the renderer wrapped around the JSON record. */
const fencedPayloadPattern = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/;

export interface ParsedToolCalls {
  calls: ToolCall[];
  errors: string[];
  finalText: string;
  hadToolMarkup: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unescapeMarkdownProtocol(value: string): string {
  return value.replace(/\\([\\`*_{}[\]()#+.!|>-])/g, "$1");
}

/** Rendered Copilot output often wraps the record in a Markdown fence. */
function stripCodeFence(payload: string): string {
  const trimmed = payload.trim();
  const fenced = fencedPayloadPattern.exec(trimmed)?.[1];
  return fenced === undefined ? trimmed : fenced.trim();
}

/**
 * Escape raw newlines and tabs that appear inside JSON string literals, which is
 * the most common way a pasted file excerpt breaks an otherwise valid record.
 */
function escapeControlCharactersInStrings(payload: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of payload) {
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }
    if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else out += char;
  }
  return out;
}

/** Drop `,` that is immediately followed by `}` or `]` outside of string literals. */
function removeTrailingCommas(payload: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index] ?? "";
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < payload.length && /\s/.test(payload[lookahead] ?? "")) lookahead += 1;
      const next = payload[lookahead];
      if (next === "}" || next === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * Conservative repair for the malformed JSON a chat renderer tends to produce.
 * Returns undefined when nothing was changed, so the caller keeps the original
 * parse error instead of reporting a second identical failure.
 */
function repairJson(payload: string): string | undefined {
  let repaired = payload;
  // Smart quotes are only safe to reinterpret as delimiters when the payload
  // contains no straight double quotes at all; otherwise they are content.
  if (!repaired.includes('"') && /[“”‘’]/.test(repaired)) {
    repaired = repaired.replace(/[“”‘’]/g, '"');
  }
  repaired = escapeControlCharactersInStrings(repaired);
  repaired = removeTrailingCommas(repaired);
  return repaired === payload ? undefined : repaired;
}

type JsonOutcome = { ok: true; value: unknown } | { ok: false; error: string };

function parseJsonPayload(payload: string): JsonOutcome {
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch (error) {
    const repaired = repairJson(payload);
    if (repaired !== undefined) {
      try {
        return { ok: true, value: JSON.parse(repaired) };
      } catch {
        // Fall through to the original, more descriptive failure.
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveOperation(record: Record<string, unknown>): string | undefined {
  for (const key of operationKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * `command` names the operation only when no operation key does and the
 * arguments do not already carry one, so {"operation":"bash","arguments":
 * {"command":…}} keeps working.
 */
function resolveCommandOperation(
  record: Record<string, unknown>,
  arguments_: Record<string, unknown>,
): string | undefined {
  const command = record.command;
  if (
    typeof command === "string" &&
    !("command" in arguments_) &&
    operationNamePattern.test(command.trim())
  ) {
    return command.trim();
  }
  return undefined;
}

/**
 * A request that names its operation but flattens the arguments alongside it,
 * such as {"name":"bash","command":"ls"}, would otherwise lose the command.
 * Only consulted when the record carries no arguments object at all.
 */
function liftTopLevelArguments(record: Record<string, unknown>): Record<string, unknown> {
  const lifted: Record<string, unknown> = {};
  for (const key of liftableArgumentKeys) {
    const value = record[key];
    if (typeof value === "string") lifted[key] = value;
  }
  return lifted;
}

function toToolCall(record: unknown): ToolCall | undefined {
  if (!isObject(record)) return undefined;
  let arguments_: Record<string, unknown> | undefined;
  for (const key of argumentKeys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (!isObject(value)) return undefined;
    arguments_ = value;
    break;
  }
  const named = resolveOperation(record);
  if (named !== undefined) {
    return { name: named, arguments: arguments_ ?? liftTopLevelArguments(record) };
  }
  const name = resolveCommandOperation(record, arguments_ ?? {});
  if (name === undefined) return undefined;
  return { name, arguments: arguments_ ?? {} };
}

export function parseToolCalls(response: string): ParsedToolCalls {
  const normalized = response
    .replaceAll("END\\_HARNESS\\_REQUEST", "END_HARNESS_REQUEST")
    .replaceAll("HARNESS\\_REQUEST", "HARNESS_REQUEST")
    .replaceAll("END\\_TOOL\\_CALL", "END_TOOL_CALL")
    .replaceAll("TOOL\\_CALL", "TOOL_CALL");
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  let hadToolMarkup = false;

  const matches = [
    ...Array.from(normalized.matchAll(xmlToolCallPattern), (match) => ({ match, index: match.index })),
    ...Array.from(normalized.matchAll(sentinelToolCallPattern), (match) => ({ match, index: match.index })),
    ...Array.from(normalized.matchAll(harnessRequestPattern), (match) => ({ match, index: match.index })),
  ].sort((left, right) => left.index - right.index);

  for (const { match } of matches) {
    hadToolMarkup = true;
    const payload = stripCodeFence(unescapeMarkdownProtocol(match[1] ?? ""));
    const outcome = parseJsonPayload(payload);
    if (!outcome.ok) {
      errors.push(`Invalid tool-call JSON: ${outcome.error}`);
      continue;
    }
    // A batch may arrive as a JSON array of records; each element is one call.
    const records = Array.isArray(outcome.value) ? outcome.value : [outcome.value];
    if (records.length === 0) {
      errors.push(requestShapeError);
      continue;
    }
    for (const record of records) {
      const call = toToolCall(record);
      if (call === undefined) {
        errors.push(requestShapeError);
        continue;
      }
      calls.push(call);
    }
  }

  if (
    (/<tool_call>/i.test(normalized) ||
      /(?:^|\n)TOOL_CALL\s*$/im.test(normalized) ||
      /(?:^|\n)HARNESS_REQUEST\s*$/im.test(normalized)) &&
    !hadToolMarkup
  ) {
    hadToolMarkup = true;
    errors.push("An opening <tool_call> was not followed by </tool_call>");
  }

  return {
    calls,
    errors,
    hadToolMarkup,
    finalText: normalized
      .replace(xmlToolCallPattern, "")
      .replace(sentinelToolCallPattern, "")
      .replace(harnessRequestPattern, "")
      .replace(/```(?:json|xml)?\s*```/gi, "")
      .trim(),
  };
}

/** Argument fields that are always payloads, never worth echoing back. */
const payloadArgumentKeys = new Set([
  "content",
  "new_text",
  "old_text",
  "newText",
  "oldText",
  "new_string",
  "old_string",
  "diff",
  "stdin",
  "task",
]);
const maxInlineStringLength = 120;
const previewLength = 60;
const maxInlineArrayItems = 8;

function marker(count: number, unit: string): string {
  const grouped = String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `<${grouped} ${unit}${count === 1 ? "" : "s"}>`;
}

function safeResultOutput(output: string): string {
  return output.replaceAll("</tool_result>", "</tool_result_escaped>");
}

function summarizeString(value: string, alwaysElide: boolean): string {
  if (alwaysElide) return marker(value.length, "char");
  if (value.length <= maxInlineStringLength) return safeResultOutput(value);
  return `${safeResultOutput(value.slice(0, previewLength))}… ${marker(value.length, "char")}`;
}

function summarizeValue(value: unknown, alwaysElide: boolean, depth: number): unknown {
  if (typeof value === "string") return summarizeString(value, alwaysElide);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 0 || value.length > maxInlineArrayItems) return marker(value.length, "item");
    return value.map((entry) => summarizeValue(entry, alwaysElide, depth + 1));
  }
  if (isObject(value)) {
    if (depth > 0) return marker(Object.keys(value).length, "field");
    const summary: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      summary[key] = summarizeValue(entry, alwaysElide || payloadArgumentKeys.has(key), depth + 1);
    }
    return summary;
  }
  return null;
}

/**
 * Compact an argument record for echoing back in an observation: short scalars
 * survive intact, long strings and known payload fields collapse to a length
 * marker, and nested structures stay one level deep. The context window is
 * small, so an observation must never repeat the text the request already sent.
 */
export function summarizeArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(arguments_)) {
    summary[key] = summarizeValue(value, payloadArgumentKeys.has(key), 0);
  }
  return summary;
}

export function formatToolResults(results: ToolResult[], protocolErrors: string[] = []): string {
  const payload = {
    results: results.map((result) => ({
      name: result.call.name,
      arguments: summarizeArguments(result.call.arguments),
      ok: result.ok,
      output: safeResultOutput(result.output),
    })),
    protocol_errors: protocolErrors,
  };
  return `HARNESS_OBSERVATION\n${JSON.stringify(payload)}\nEND_HARNESS_OBSERVATION\n\nContinue: print another HARNESS_REQUEST if needed, otherwise answer without protocol markers.`;
}
